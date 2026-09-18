import { performance } from "node:perf_hooks";
import { currentMemoryPressure } from "./memory.js";
import { parseToolCallsFromText, stripReasoning } from "./parser.js";
import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ToolArm,
  ToolCall,
} from "./types.js";

export interface SamplingOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  presencePenalty?: number;
  repeatPenalty?: number;
}

export interface HttpAdapterOptions {
  modelId: string;
  baseUrl?: string;
  apiFormat?: "ollama" | "openai";
  sampling?: SamplingOptions;
  /** Context window, used to size num_ctx on Ollama. */
  contextTokens?: number;
  maxTokens?: number;
  /** Per-request wall clock ceiling. Local MoE decode is slow; default is generous. */
  requestTimeoutMs?: number;
  /** Retries for transient transport failures (not for 4xx). */
  maxRetries?: number;
  /**
   * Timeout for a request that must first load the weights.
   *
   * Nail cold-loads in 211-258s on the M4 reference box. A normal turn timeout
   * would expire mid-load and retry, re-queueing behind the load it abandoned:
   * a healthy machine reported as a dead model (Helga measured the same trap).
   */
  coldLoadTimeoutMs?: number;
  /**
   * Disable the model's chain-of-thought channel.
   *
   * Qwen3.x routes output into `<think>` and leaves `content` empty unless this
   * is set, which yields zero parsed tool calls and a silently dead agent.
   */
  disableReasoning?: boolean;
  /** Ask the server to reuse the cached prompt prefix across turns. */
  promptCache?: boolean;
  /**
   * Send tool schemas for server-side (native) tool-call parsing.
   *
   * Nail advertises the `tools` capability, but the adapter never sent a
   * schema, so every call was free text the harness had to interpret — and
   * some turns produced nothing parseable at all. Native parsing is tried
   * first; the text parser remains the fallback when it returns no calls.
   */
  nativeTools?: boolean;
  /** How long the server should keep the model resident between turns. */
  keepAlive?: string;
  /**
   * Shorten keep-alive automatically as host memory pressure rises.
   *
   * On by default: a pinned 14GB checkpoint is the difference between a
   * responsive box and a swapping one.
   */
  memoryAware?: boolean;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Native tool-call payloads, when the server supports them. */
interface NativeToolCall {
  id?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
  name?: string;
  arguments?: string | Record<string, unknown>;
}

function nativeToToolCalls(raw: NativeToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];

  for (const entry of raw) {
    const name = entry.function?.name ?? entry.name;
    if (typeof name !== "string" || name.length === 0) continue;

    const rawArgs = entry.function?.arguments ?? entry.arguments ?? {};
    let args: Record<string, unknown> = {};
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }

    calls.push({
      id: entry.id ?? `call_${calls.length}`,
      name,
      arguments: args,
      raw: JSON.stringify(entry),
    });
  }

  return calls;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Talks to a local inference server: Ollama, llama.cpp, or any OpenAI-compatible endpoint.
 *
 * Two behaviours here are load-bearing on local hardware. First, reasoning
 * suppression: without it Qwen3.x-family models return an empty `content` and
 * the agent does nothing. Second, prompt-prefix caching: measured on this M4,
 * prefill is roughly 80% of turn latency and caching the static prefix cut
 * time-to-first-token from 27.66s to 0.88s. Both are requests to the server —
 * the harness earns them by keeping its system prompt byte-stable across turns.
 */
export class HttpInferenceAdapter implements LocalInferenceAdapter {
  public readonly modelId: string;
  public readonly supportedArms: ToolArm[] = ["arm_a_flat", "arm_b_json", "arm_c_sketch"];
  private baseUrl: string;
  private apiFormat: "ollama" | "openai";
  private sampling: SamplingOptions;
  private options: HttpAdapterOptions;

  constructor(options: HttpAdapterOptions) {
    this.options = options;
    this.modelId = options.modelId;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.apiFormat = options.apiFormat ?? "ollama";
    this.sampling = options.sampling ?? {};
  }

  /** Keep-alive, tightened when the host is under memory pressure. */
  private resolveKeepAlive(): string {
    const configured = this.options.keepAlive ?? "5m";
    if (this.options.memoryAware === false) return configured;

    const pressure = currentMemoryPressure();
    return pressure.level === "normal" ? configured : pressure.recommendedKeepAlive;
  }

  /**
   * Evict the model from the server, releasing its memory immediately.
   *
   * Worth calling before a long non-inference phase (a full build, a gate run):
   * holding the weights resident while the toolchain needs the same RAM is how
   * a tight box starts swapping.
   */
  public async unload(): Promise<void> {
    if (this.apiFormat !== "ollama") return;
    try {
      await this.post("/api/generate", { model: this.modelId, keep_alive: 0 });
    } catch {
      // Best effort: the server may already have evicted it.
    }
  }

  private messages(req: InferenceRequest): ChatMessage[] {
    const messages: ChatMessage[] = [];
    // The system message must stay byte-identical across turns for the server's
    // prefix cache to hit; per-turn state belongs in the user message.
    if (req.systemPrompt) messages.push({ role: "system", content: req.systemPrompt });
    messages.push({ role: "user", content: req.prompt });
    return messages;
  }

  /**
   * Whether the model is already resident on an Ollama server.
   *
   * Unknown (unreachable, or not Ollama) returns true, so a genuinely dead host
   * keeps the short timeout and fails fast rather than waiting out a cold load.
   */
  public async isResident(): Promise<boolean> {
    if (this.apiFormat !== "ollama") return true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/api/ps`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return true;
      const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
      return (body.models ?? []).some((m) => m.name === this.modelId || m.model === this.modelId);
    } catch {
      return true;
    }
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const resident = path === "/api/chat" ? await this.isResident() : true;
    const timeoutMs = resident
      ? (this.options.requestTimeoutMs ?? 300_000)
      : (this.options.coldLoadTimeoutMs ?? 480_000);
    const maxRetries = this.options.maxRetries ?? 2;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const error = new Error(
            `Inference HTTP ${res.status} ${res.statusText} from ${this.baseUrl}${path}: ${detail.slice(0, 400)}`,
          );
          // Client errors are deterministic; retrying just burns wall clock.
          if (!RETRYABLE_STATUS.has(res.status)) throw error;
          lastError = error;
        } else {
          return await res.json();
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error.name === "AbortError") {
          lastError = new Error(`Inference request timed out after ${timeoutMs}ms`);
        } else if (lastError === undefined) {
          lastError = error;
        }
        if (attempt === maxRetries) break;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }

    throw lastError ?? new Error("Inference request failed");
  }

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    const start = performance.now();
    const messages = this.messages(req);
    const maxTokens = req.maxTokens ?? this.options.maxTokens ?? 2048;

    const data =
      this.apiFormat === "ollama"
        ? await this.generateOllama(messages, req, maxTokens)
        : await this.generateOpenAi(messages, req, maxTokens);

    // Reasoning text is never tool-bearing; strip before parsing so a worked
    // example inside the model's own deliberation is not executed.
    const visible = stripReasoning(data.text);
    // Telling the parser which tools exist removes the ambiguity that forces it
    // to guess whether `name(...)` in the output is a call or ordinary code.
    const knownTools = req.tools?.map((t) => t.name);
    const toolCalls =
      data.nativeCalls.length > 0
        ? data.nativeCalls
        : parseToolCallsFromText(visible, req.toolArm, knownTools);

    return {
      text: visible,
      toolCalls,
      usage: {
        promptTokens:
          data.promptTokens ??
          Math.round((req.prompt.length + (req.systemPrompt?.length ?? 0)) / 4),
        completionTokens: data.completionTokens ?? Math.round(visible.length / 4),
        durationMs: Math.round(performance.now() - start),
      },
    };
  }

  private async generateOllama(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<{
    text: string;
    nativeCalls: ToolCall[];
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages,
      stream: false,
      keep_alive: this.resolveKeepAlive(),
      options: {
        temperature: req.temperature ?? this.sampling.temperature ?? 0.2,
        num_predict: maxTokens,
        ...(this.sampling.topP !== undefined ? { top_p: this.sampling.topP } : {}),
        ...(this.sampling.topK !== undefined ? { top_k: this.sampling.topK } : {}),
        ...(this.sampling.minP !== undefined ? { min_p: this.sampling.minP } : {}),
        ...(this.sampling.repeatPenalty !== undefined
          ? { repeat_penalty: this.sampling.repeatPenalty }
          : {}),
        ...(this.options.contextTokens !== undefined
          ? { num_ctx: this.options.contextTokens }
          : {}),
      },
    };

    if (this.options.nativeTools !== false && req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (this.options.disableReasoning !== false) {
      // Ollama otherwise routes the answer into `reasoning` and returns empty content.
      payload.think = false;
      payload.reasoning_effort = "none";
    }

    const data = (await this.post("/api/chat", payload)) as {
      message?: { content?: string; thinking?: string; tool_calls?: NativeToolCall[] };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      text: data.message?.content ?? "",
      nativeCalls: nativeToToolCalls(data.message?.tool_calls),
      ...(data.prompt_eval_count !== undefined ? { promptTokens: data.prompt_eval_count } : {}),
      ...(data.eval_count !== undefined ? { completionTokens: data.eval_count } : {}),
    };
  }

  private async generateOpenAi(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<{
    text: string;
    nativeCalls: ToolCall[];
    promptTokens?: number;
    completionTokens?: number;
  }> {
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages,
      temperature: req.temperature ?? this.sampling.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
    };

    if (this.sampling.topP !== undefined) payload.top_p = this.sampling.topP;
    if (this.sampling.topK !== undefined) payload.top_k = this.sampling.topK;
    if (this.sampling.minP !== undefined) payload.min_p = this.sampling.minP;
    if (this.sampling.presencePenalty !== undefined) {
      payload.presence_penalty = this.sampling.presencePenalty;
    }
    if (this.sampling.repeatPenalty !== undefined) {
      payload.repeat_penalty = this.sampling.repeatPenalty;
    }
    if (this.options.nativeTools !== false && req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    // llama.cpp honours this to reuse the KV cache for an unchanged prefix.
    if (this.options.promptCache !== false) payload.cache_prompt = true;
    if (this.options.disableReasoning !== false) payload.reasoning_effort = "none";

    const data = (await this.post("/v1/chat/completions", payload)) as {
      choices?: {
        message?: { content?: string; reasoning_content?: string; tool_calls?: NativeToolCall[] };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = data.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      nativeCalls: nativeToToolCalls(message?.tool_calls),
      ...(data.usage?.prompt_tokens !== undefined
        ? { promptTokens: data.usage.prompt_tokens }
        : {}),
      ...(data.usage?.completion_tokens !== undefined
        ? { completionTokens: data.usage.completion_tokens }
        : {}),
    };
  }
}

/**
 * Dense Qwen3.8-27B on llama-server.
 *
 * Measured at 6.6–8.65 tok/s on the M4 reference box. Retained for
 * quality comparison, but too slow to drive multi-turn cards interactively.
 */
export function createQwen38_27BAdapter(baseUrl = "http://127.0.0.1:8099"): HttpInferenceAdapter {
  return new HttpInferenceAdapter({
    modelId: "qwen3.8-27b",
    baseUrl,
    apiFormat: "openai",
    contextTokens: 32768,
    sampling: {
      temperature: 0.2,
      topP: 0.9,
      topK: 20,
      minP: 0.0,
      presencePenalty: 1.5,
    },
  });
}

/**
 * Nail-Qwen3.6-35B-A3B — the default driver for card execution.
 *
 * A 34.7B MoE with ~3B active parameters, measured at 29.0–30.1 tok/s on the
 * same box: roughly 4.4x the dense 27B. For an agentic loop, where a card costs
 * many turns, that ratio is the difference between usable and unusable.
 */
/**
 * Settings for the fast MoE worker.
 *
 * 8k context, not the model's 262k ceiling: the weights are ~13GB on a 24GB
 * box, so the KV cache decides whether the machine swaps. A 32k window drove
 * the host to 9.4GB of swap and stalled a run; card prompts measure ~1.1-3k.
 */
export const NAIL_WORKER_PROFILE: HttpAdapterOptions & { modelId: string } = {
  modelId: "nail-35b-a3b-ctx:latest",
  baseUrl: "http://127.0.0.1:11434",
  apiFormat: "ollama",
  contextTokens: 8192,
  maxTokens: 2048,
  keepAlive: "5m",
  disableReasoning: true,
  sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0.0, repeatPenalty: 1.05 },
};

/**
 * Nail-Qwen3.6-35B-A3B — the default worker.
 *
 * A 34.7B MoE with ~3B active parameters, measured at 29.0-30.1 tok/s on the
 * reference M4 against 6.6-8.65 for the dense 27B. For an agentic loop, where
 * a card costs many turns, that ratio decides whether the loop is usable.
 */
export function createNail35BAdapter(baseUrl = "http://127.0.0.1:11434"): HttpInferenceAdapter {
  return new HttpInferenceAdapter({ ...NAIL_WORKER_PROFILE, baseUrl });
}
