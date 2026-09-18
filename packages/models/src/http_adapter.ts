import { performance } from "node:perf_hooks";
import { currentMemoryPressure } from "./memory.js";
import { parseToolCallsFromText, stripReasoning } from "./parser.js";
import type {
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ReasoningLevel,
  TokenUsage,
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
  /**
   * Sampling for requests with `purpose: "planning"` (M5). CHRONICLE §2:
   * 0.7 / 0.8 for planning against 0.2 / 0.9 for code. Fields not set here
   * fall back to `sampling`.
   */
  planningSampling?: SamplingOptions;
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

/** llama-server's per-request `timings` block (tools/server, non-streaming). */
export interface LlamaServerTimings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
}

/** Server-reported accounting, before it is merged into `TokenUsage`. */
export type ServerUsage = Omit<TokenUsage, "durationMs" | "promptTokens" | "completionTokens"> & {
  promptTokens?: number;
  completionTokens?: number;
};

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function rate(tokens: number | undefined, ms: number | undefined): number | undefined {
  if (!finite(tokens) || !finite(ms) || ms <= 0 || tokens <= 0) return undefined;
  return Math.round((tokens / (ms / 1000)) * 100) / 100;
}

/**
 * Prefix-cache and throughput accounting from a llama-server response (M18, M3).
 *
 * `timings.cache_n` is the prompt tokens reused from the slot's KV cache and
 * `timings.prompt_n` the tokens actually evaluated, so the prompt was
 * `cache_n + prompt_n` tokens and the hit rate is `cache_n` over that. Builds
 * that omit `timings` but fill `usage.prompt_tokens_details.cached_tokens`
 * (the OpenAI field) are read from there, against `usage.prompt_tokens`.
 */
export function usageFromLlamaServer(
  timings: LlamaServerTimings | undefined,
  usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      }
    | undefined,
): ServerUsage {
  const out: ServerUsage = {};
  if (finite(usage?.prompt_tokens)) out.promptTokens = usage.prompt_tokens;
  if (finite(usage?.completion_tokens)) out.completionTokens = usage.completion_tokens;

  if (finite(timings?.cache_n) && finite(timings?.prompt_n)) {
    const cached = timings.cache_n;
    const evaluated = timings.prompt_n;
    out.cachedPromptTokens = cached;
    out.evaluatedPromptTokens = evaluated;
    const total = cached + evaluated;
    if (total > 0) out.cacheHitRate = cached / total;
    if (out.promptTokens === undefined) out.promptTokens = total;
  } else {
    const cached = usage?.prompt_tokens_details?.cached_tokens;
    const total = usage?.prompt_tokens;
    if (finite(cached) && finite(total) && total > 0) {
      out.cachedPromptTokens = cached;
      out.evaluatedPromptTokens = Math.max(0, total - cached);
      out.cacheHitRate = Math.min(1, cached / total);
    }
  }

  if (finite(timings?.prompt_ms)) out.prefillMs = timings.prompt_ms;
  if (finite(timings?.predicted_ms)) out.decodeMs = timings.predicted_ms;
  const prefill = finite(timings?.prompt_per_second)
    ? timings.prompt_per_second
    : rate(timings?.prompt_n, timings?.prompt_ms);
  const decode = finite(timings?.predicted_per_second)
    ? timings.predicted_per_second
    : rate(timings?.predicted_n, timings?.predicted_ms);
  // A fully cached prompt evaluates 0-1 tokens, and its "speed" is noise.
  if (finite(prefill) && (timings?.prompt_n ?? 0) > 1) out.prefillTokensPerSecond = prefill;
  if (finite(decode) && (timings?.predicted_n ?? 0) > 0) out.decodeTokensPerSecond = decode;
  if (out.completionTokens === undefined && finite(timings?.predicted_n)) {
    out.completionTokens = timings.predicted_n;
  }
  return out;
}

/**
 * Throughput from an Ollama `/api/chat` response (M3). Durations are in
 * nanoseconds. Ollama reports no prefix-cache figures, so the hit rate stays
 * undefined rather than guessed.
 */
export function usageFromOllama(data: {
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}): ServerUsage {
  const out: ServerUsage = {};
  if (finite(data.prompt_eval_count)) out.promptTokens = data.prompt_eval_count;
  if (finite(data.eval_count)) out.completionTokens = data.eval_count;
  if (finite(data.prompt_eval_duration)) out.prefillMs = data.prompt_eval_duration / 1e6;
  if (finite(data.eval_duration)) out.decodeMs = data.eval_duration / 1e6;
  const prefill = rate(data.prompt_eval_count, out.prefillMs);
  const decode = rate(data.eval_count, out.decodeMs);
  if (prefill !== undefined && (data.prompt_eval_count ?? 0) > 1) {
    out.prefillTokensPerSecond = prefill;
  }
  if (decode !== undefined) out.decodeTokensPerSecond = decode;
  return out;
}

/** Default thinking allowance per level when the request names none. */
export const REASONING_BUDGET_TOKENS: Record<Exclude<ReasoningLevel, "off">, number> = {
  low: 512,
  medium: 1024,
  high: 2048,
};

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

  /** The window this adapter was configured with, so callers can budget prompts. */
  public get contextWindow(): { contextTokens: number; maxTokens: number } | undefined {
    const contextTokens = this.options.contextTokens;
    if (contextTokens === undefined) return undefined;
    return { contextTokens, maxTokens: this.options.maxTokens ?? 2048 };
  }
  /** Whether tool schemas travel natively (see `LocalInferenceAdapter.nativeTools`). */
  public get nativeTools(): boolean {
    return this.options.nativeTools !== false;
  }
  private baseUrl: string;
  private apiFormat: "ollama" | "openai";
  private sampling: SamplingOptions;
  private options: HttpAdapterOptions;

  /** The sampling profile a request resolves to: planning overlays code. */
  public samplingFor(req: Pick<InferenceRequest, "purpose">): SamplingOptions {
    if (req.purpose === "planning" && this.options.planningSampling) {
      return { ...this.sampling, ...this.options.planningSampling };
    }
    return this.sampling;
  }

  /** The reasoning level a request resolves to, after the adapter's default. */
  public reasoningFor(req: Pick<InferenceRequest, "reasoning">): ReasoningLevel {
    if (req.reasoning !== undefined) return req.reasoning;
    return this.options.disableReasoning === false ? "medium" : "off";
  }

  /** Thinking tokens allowed for a request whose reasoning is on. */
  private thinkingBudget(req: InferenceRequest, level: ReasoningLevel): number {
    if (level === "off") return 0;
    return req.reasoningBudgetTokens ?? REASONING_BUDGET_TOKENS[level];
  }

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

  /**
   * Resident size on an Ollama server: the model's reported size plus room
   * for its KV cache and the runner. Undefined when it cannot be measured.
   */
  public async footprintBytes(): Promise<number | undefined> {
    if (this.apiFormat !== "ollama") return undefined;
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const body = (await res.json()) as {
        models?: { name?: string; model?: string; size?: number }[];
      };
      const m = (body.models ?? []).find(
        (x) => x.name === this.modelId || x.model === this.modelId,
      );
      if (!m?.size) return undefined;
      const kv = (this.options.contextTokens ?? 8192) * 160 * 1024; // dense f16 KV, conservative
      return Math.round(m.size + kv + 1.5 * 1024 ** 3);
    } catch {
      return undefined;
    }
  }

  /**
   * Wait until the server really has released the model, up to `timeoutMs`.
   * `keep_alive: 0` is a request, not a guarantee: Ollama can still be
   * finishing a generation or tearing down its runner when it returns.
   */
  public async confirmUnloaded(timeoutMs = 20_000): Promise<boolean> {
    if (this.apiFormat !== "ollama") return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
          const listed = (body.models ?? []).some(
            (m) => m.name === this.modelId || m.model === this.modelId,
          );
          if (!listed) return true;
        }
      } catch {
        // Server unreachable: nothing of ours can be resident on it.
        return true;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
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
    const level = this.reasoningFor(req);
    // Thinking tokens come out of the same allowance as the answer; without
    // the extra room a reasoning turn ends mid-thought with no tool call.
    const maxTokens =
      (req.maxTokens ?? this.options.maxTokens ?? 2048) + this.thinkingBudget(req, level);

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

    const { promptTokens, completionTokens, ...measured } = data.usage;
    return {
      text: visible,
      toolCalls,
      usage: {
        promptTokens:
          promptTokens ?? Math.round((req.prompt.length + (req.systemPrompt?.length ?? 0)) / 4),
        completionTokens: completionTokens ?? Math.round(visible.length / 4),
        durationMs: Math.round(performance.now() - start),
        ...measured,
      },
    };
  }

  private async generateOllama(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<{ text: string; nativeCalls: ToolCall[]; usage: ServerUsage }> {
    const sampling = this.samplingFor(req);
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages,
      stream: false,
      keep_alive: this.resolveKeepAlive(),
      options: {
        temperature: req.temperature ?? sampling.temperature ?? 0.2,
        num_predict: maxTokens,
        ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
        ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
        ...(sampling.minP !== undefined ? { min_p: sampling.minP } : {}),
        ...(sampling.presencePenalty !== undefined
          ? { presence_penalty: sampling.presencePenalty }
          : {}),
        ...(sampling.repeatPenalty !== undefined ? { repeat_penalty: sampling.repeatPenalty } : {}),
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
    if (this.reasoningFor(req) === "off") {
      // Ollama otherwise routes the answer into `reasoning` and returns empty content.
      payload.think = false;
      payload.reasoning_effort = "none";
    } else {
      // The thinking lands in `message.thinking`, which is dropped: reasoning
      // traces never carry over into the next step's prompt.
      payload.think = true;
    }

    const data = (await this.post("/api/chat", payload)) as {
      message?: { content?: string; thinking?: string; tool_calls?: NativeToolCall[] };
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
    };

    return {
      text: data.message?.content ?? "",
      nativeCalls: nativeToToolCalls(data.message?.tool_calls),
      usage: usageFromOllama(data),
    };
  }

  private async generateOpenAi(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<{ text: string; nativeCalls: ToolCall[]; usage: ServerUsage }> {
    const sampling = this.samplingFor(req);
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages,
      temperature: req.temperature ?? sampling.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
    };

    if (sampling.topP !== undefined) payload.top_p = sampling.topP;
    if (sampling.topK !== undefined) payload.top_k = sampling.topK;
    if (sampling.minP !== undefined) payload.min_p = sampling.minP;
    if (sampling.presencePenalty !== undefined) {
      payload.presence_penalty = sampling.presencePenalty;
    }
    if (sampling.repeatPenalty !== undefined) {
      payload.repeat_penalty = sampling.repeatPenalty;
    }
    if (this.options.nativeTools !== false && req.tools && req.tools.length > 0) {
      payload.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    // llama.cpp honours this to reuse the KV cache for an unchanged prefix.
    if (this.options.promptCache !== false) payload.cache_prompt = true;
    const level = this.reasoningFor(req);
    if (level === "off") {
      payload.reasoning_effort = "none";
      // Qwen-family jinja templates read this kwarg; reasoning_effort alone is
      // ignored by some templates, leaving thinking on.
      payload.chat_template_kwargs = { enable_thinking: false };
    } else {
      // Qwen3.8 (Dirk) templates read the effort from the kwargs; llama-server
      // caps the thinking with `thinking_budget_tokens` and returns it in
      // `reasoning_content`, which is dropped so traces never reach the next step.
      payload.reasoning_effort = level;
      payload.chat_template_kwargs = { enable_thinking: true, reasoning_effort: level };
      payload.thinking_budget_tokens = this.thinkingBudget(req, level);
    }

    const data = (await this.post("/v1/chat/completions", payload)) as {
      choices?: {
        message?: { content?: string; reasoning_content?: string; tool_calls?: NativeToolCall[] };
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      timings?: LlamaServerTimings;
    };

    const message = data.choices?.[0]?.message;
    return {
      text: message?.content ?? "",
      nativeCalls: nativeToToolCalls(message?.tool_calls),
      usage: usageFromLlamaServer(data.timings, data.usage),
    };
  }
}

/**
 * Dense Qwen3.8-27B on an already-running llama-server (CHRONICLE §2, port
 * 8099). Code requests sample at 0.2 / 0.9; `purpose: "planning"` requests
 * at 0.7 / 0.8 (M5). Use `createQwen38Managed` to have the harness start
 * and stop the server itself.
 *
 * Measured at 6.6-8.65 tok/s on the M4 reference box: strong, but slow for
 * many-turn cards, so it suits planning, repair plans and escalated retries.
 */
export function createQwen38_27BAdapter(baseUrl = "http://127.0.0.1:8099"): HttpInferenceAdapter {
  return new HttpInferenceAdapter({
    modelId: "qwen3.8-27b",
    baseUrl,
    apiFormat: "openai",
    // §2 runs -c 49152 across -np 2 slots: 24,576 tokens per request.
    contextTokens: 24576,
    maxTokens: 2048,
    disableReasoning: true,
    sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0.0, presencePenalty: 1.5 },
    planningSampling: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0.0, presencePenalty: 1.5 },
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
