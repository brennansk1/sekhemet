import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { assertKvType } from "./kv_policy.js";
import { currentMemoryPressure } from "./memory.js";
import { parseToolCallsFromText, stripReasoning } from "./parser.js";
import { type ModelRegistry, type TemplatePinResult, fetchChatTemplate } from "./registry.js";
import {
  type CacheStepKind,
  type CacheStepRecord,
  type ModelTelemetry,
  modelTelemetry,
} from "./telemetry.js";
import type {
  AdapterHealth,
  ChatTurn,
  ImageInput,
  InferenceRequest,
  InferenceResponse,
  LocalInferenceAdapter,
  ReasoningLevel,
  TokenUsage,
  ToolArm,
  ToolCall,
  ToolDefinition,
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
  /**
   * Arm A with grammar-constrained decoding (M8), OpenAI-compatible path
   * only: tool calls are forced through a `response_format` JSON schema
   * built from the request's tools (llama-server compiles it to a GBNF
   * grammar), so the model cannot emit a malformed call or an unknown tool.
   * A server that rejects the schema falls back to native tools, and the
   * tolerant text parser remains the last resort.
   */
  constrainedToolCalls?: boolean;
  /**
   * The KV cache type the Ollama server runs with (`OLLAMA_KV_CACHE_TYPE`).
   * Defaults to this process's environment. 4-bit is refused for tool
   * requests (M16).
   */
  ollamaKvCacheType?: string;
  /** The tool arm the registry measured best for this model (M9). */
  preferredToolArm?: ToolArm;
  /**
   * Where responses are recorded (M3, M18). Defaults to the process-wide
   * `modelTelemetry`; `false` records nothing.
   */
  telemetry?: ModelTelemetry | false;
  /**
   * Called when a tool-result step's prefix-cache hit rate is under 85%
   * (M18). Defaults to one line on stderr.
   */
  onCacheAlert?: (record: CacheStepRecord & { modelId: string }) => void;
  /**
   * The model registry (M11). With one, the adapter pins the server's chat
   * template by checksum on its first request (a change invalidates the
   * model's qualification, M12) and takes its tool arm from the registry's
   * measurement when `preferredToolArm` is not set (M9).
   */
  registry?: ModelRegistry;
  /** Called when the template check changes the registry (pinned or changed). */
  onTemplatePin?: (modelId: string, result: TemplatePinResult) => void;
  /** The role this adapter serves, named when a prompt is refused (CX-N3-3). */
  role?: string;
}

/**
 * Characters per token for counting a prompt before it is sent (CX-N3-3):
 * the ratio of the context package's one estimator (`FALLBACK_CHARS_PER_TOKEN`,
 * `packages/context/src/tokens.ts`), which the models package cannot import.
 * A harness test holds the two equal.
 */
export const PROMPT_CHARS_PER_TOKEN = 3.2;

/** A prompt's tokens by that estimate: every message's text and every tool schema sent. */
export function countPromptTokens(
  messages: readonly { content: string }[],
  tools?: readonly ToolDefinition[],
): number {
  const chars =
    messages.reduce((n, m) => n + m.content.length, 0) +
    (tools?.length ? JSON.stringify(tools).length : 0);
  return chars <= 0 ? 0 : Math.ceil(chars / PROMPT_CHARS_PER_TOKEN);
}

/**
 * A request refused before it was sent because its prompt is larger than the
 * context the adapter set for the model (CX-N3-3): an engine that silently
 * drops the start of an over-long prompt would lose the instructions.
 */
export class ContextOverflowError extends Error {
  constructor(
    public readonly role: string,
    public readonly modelId: string,
    public readonly promptTokens: number,
    public readonly contextTokens: number,
  ) {
    super(
      `Refusing to send the ${role} prompt: ${promptTokens} tokens counted against the ${contextTokens}-token context set for ${modelId}; the engine would drop its start.`,
    );
    this.name = "ContextOverflowError";
  }
}

/** A non-2xx inference response, with its status for callers that branch on it. */
export class InferenceHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "InferenceHttpError";
  }
}

/**
 * The JSON schema for grammar-constrained tool calls (M8, Arm A). The reply
 * is an object with an optional `message` and a `tool_calls` array whose
 * items are exactly one of the known tools with its own parameter schema.
 */
export function constrainedToolSchema(tools: readonly ToolDefinition[]): Record<string, unknown> {
  const call = (t: ToolDefinition) => ({
    type: "object",
    properties: {
      name: { type: "string", const: t.name },
      arguments:
        t.parameters && Object.keys(t.parameters).length > 0
          ? t.parameters
          : { type: "object", properties: {} },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  });
  return {
    type: "object",
    properties: {
      message: { type: "string" },
      tool_calls: { type: "array", items: { anyOf: tools.map(call) } },
    },
    required: ["tool_calls"],
    additionalProperties: false,
  };
}

/** Parse a constrained reply; undefined when it is not the expected JSON. */
function parseConstrainedReply(
  content: string,
  known: Set<string>,
): { message: string; calls: ToolCall[] } | undefined {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!data || typeof data !== "object") return undefined;
  const obj = data as { message?: unknown; tool_calls?: unknown };
  if (!Array.isArray(obj.tool_calls)) return undefined;
  const calls: ToolCall[] = [];
  for (const entry of obj.tool_calls) {
    const e = entry as { name?: unknown; arguments?: unknown };
    if (typeof e.name !== "string" || !known.has(e.name)) continue;
    calls.push({
      id: `call_${calls.length}`,
      name: e.name,
      arguments:
        e.arguments && typeof e.arguments === "object"
          ? (e.arguments as Record<string, unknown>)
          : {},
      raw: JSON.stringify(entry),
    });
  }
  return { message: typeof obj.message === "string" ? obj.message : "", calls };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images (X3); turned into the wire format just before sending. */
  images?: ImageInput[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  tool_name?: string;
}

/**
 * Images on the wire (X3). OpenAI-compatible servers (llama-server with a
 * projector) take content parts with data URLs; Ollama takes base64 strings
 * in `images` beside the text.
 */
export function imagesToWire(messages: ChatMessage[], format: "openai" | "ollama"): unknown[] {
  return messages.map(({ images, ...m }) => {
    if (!images?.length) return m;
    if (format === "ollama") return { ...m, images: images.map((i) => i.data) };
    return {
      ...m,
      content: [
        { type: "text", text: m.content },
        ...images.map((i) => ({
          type: "image_url",
          image_url: { url: `data:${i.mime};base64,${i.data}` },
        })),
      ],
    };
  });
}

/**
 * Wire form of a multi-turn conversation. OpenAI (llama-server): assistant
 * `tool_calls` with JSON-string arguments, tool turns with `tool_call_id`.
 * Ollama: arguments as objects, tool turns with `tool_name` (Ollama matches
 * results by name, not id).
 */
export function chatTurnsToWire(turns: ChatTurn[], format: "openai" | "ollama"): ChatMessage[] {
  const names = new Map<string, string>();
  return turns.map((turn) => {
    const message: ChatMessage = { role: turn.role, content: turn.content };
    if (turn.images?.length) message.images = turn.images;
    if (turn.role === "assistant" && turn.toolCalls?.length) {
      for (const call of turn.toolCalls) names.set(call.id, call.name);
      message.tool_calls = turn.toolCalls.map((call) =>
        format === "openai"
          ? {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            }
          : { function: { name: call.name, arguments: call.arguments } },
      );
    }
    if (turn.role === "tool") {
      if (format === "openai") {
        if (turn.toolCallId !== undefined) message.tool_call_id = turn.toolCallId;
      } else {
        const name = turn.toolCallId !== undefined ? names.get(turn.toolCallId) : undefined;
        if (name) message.tool_name = name;
      }
    }
    return message;
  });
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
  /** Present only while speculative decoding runs. */
  draft_n?: number;
  draft_n_accepted?: number;
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
  if (finite(timings?.draft_n)) out.draftTokens = timings.draft_n;
  if (finite(timings?.draft_n_accepted)) out.draftAcceptedTokens = timings.draft_n_accepted;
  return out;
}

/**
 * Throughput from an Ollama `/api/chat` response (M3). Durations are in
 * nanoseconds. Ollama reports no prefix-cache figures, so the hit rate stays
 * undefined rather than guessed.
 */
/** Ollama's `load_duration` below this (1 s) is a warm request, not a load. */
export const OLLAMA_LOAD_THRESHOLD_NS = 1_000_000_000;

export function usageFromOllama(data: {
  load_duration?: number;
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
  // MS-T7-1: the load the server did for this request, reported apart. A
  // warm request still reports a few milliseconds; only a second or more is
  // a load of the weights (confirmation check, M3).
  if (finite(data.load_duration) && data.load_duration >= OLLAMA_LOAD_THRESHOLD_NS)
    out.loadMs = Math.round(data.load_duration / 1e6);
  const prefill = rate(data.prompt_eval_count, out.prefillMs);
  const decode = rate(data.eval_count, out.decodeMs);
  if (prefill !== undefined && (data.prompt_eval_count ?? 0) > 1) {
    out.prefillTokensPerSecond = prefill;
  }
  if (decode !== undefined) out.decodeTokensPerSecond = decode;
  return out;
}

/** One server reply before parsing: the text, native calls, usage and why it ended. */
interface GenerationResult {
  text: string;
  nativeCalls: ToolCall[];
  usage: ServerUsage;
  finishReason?: string;
  /** Thinking the server returned apart from the answer (dropped after counting). */
  thinking?: string;
  /** The server's own count of thinking tokens, when it gives one. */
  thinkingTokens?: number;
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
    // MD-N4-2: a window set in the model's registry entry overrides the factory's.
    const contextTokens = this.registryEntry()?.contextWindow ?? this.options.contextTokens;
    if (contextTokens === undefined) return undefined;
    return { contextTokens, maxTokens: this.options.maxTokens ?? 2048 };
  }
  /** The measured tool arm (M9), when the registry supplied one. */
  public get preferredToolArm(): ToolArm | undefined {
    return this.options.preferredToolArm ?? this.options.registry?.armFor(this.modelId);
  }

  private templateChecked = false;

  /** The wire format this adapter speaks. */
  public get api(): "ollama" | "openai" {
    return this.apiFormat;
  }

  /** Attach the registry after construction (the roster does this, M11). */
  public attachRegistry(registry: ModelRegistry): void {
    this.options.registry = registry;
    this.templateChecked = false;
  }

  public get registry(): ModelRegistry | undefined {
    return this.options.registry;
  }

  /**
   * Pin the server's chat template in the registry (M12). Runs once per
   * adapter (on the first request); a server that does not expose its
   * template is skipped. Returns the pin result, or undefined.
   */
  public async verifyTemplate(): Promise<TemplatePinResult | undefined> {
    const registry = this.options.registry;
    if (!registry) return undefined;
    this.templateChecked = true;
    const template = await fetchChatTemplate(this.baseUrl, this.apiFormat, this.modelId);
    if (template === undefined) return undefined;
    const result = registry.pinTemplate(this.modelId, template);
    if (result.pinned || result.changed) {
      if (this.options.onTemplatePin) this.options.onTemplatePin(this.modelId, result);
      else if (result.changed) {
        process.stderr.write(
          `[registry] ${this.modelId}: chat template changed; qualification invalidated\n`,
        );
      }
    }
    return result;
  }
  /** Whether tool schemas travel natively (see `LocalInferenceAdapter.nativeTools`). */
  public get nativeTools(): boolean {
    return this.options.nativeTools !== false;
  }
  private baseUrl: string;
  private apiFormat: "ollama" | "openai";
  private sampling: SamplingOptions;
  private options: HttpAdapterOptions;
  private fixedSeed: number | undefined;

  /**
   * Fix the sampling seed of every later request (measurement rule 10): a
   * measured run's RunProfile names it; undefined returns to the server's own.
   */
  public setSeed(seed: number | undefined): void {
    this.fixedSeed = seed;
  }

  /** The fixed sampling seed, when one is set. */
  public get seed(): number | undefined {
    return this.fixedSeed;
  }

  /** The model's registry entry, when the adapter has a registry (MD-N4-2). */
  private registryEntry(): ReturnType<ModelRegistry["get"]> {
    return this.options.registry?.get(this.modelId);
  }

  /**
   * The sampling profile a request resolves to: planning overlays code, and
   * sampling set in the model's registry entry overrides both (MD-N4-2).
   */
  public samplingFor(req: Pick<InferenceRequest, "purpose">): SamplingOptions {
    const base =
      req.purpose === "planning" && this.options.planningSampling
        ? { ...this.sampling, ...this.options.planningSampling }
        : this.sampling;
    const r = this.registryEntry()?.sampling;
    if (!r) return base;
    return {
      ...base,
      ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
      ...(r.topP !== undefined ? { topP: r.topP } : {}),
      ...(r.topK !== undefined ? { topK: r.topK } : {}),
      ...(r.minP !== undefined ? { minP: r.minP } : {}),
    };
  }

  /**
   * The reasoning level a request resolves to, after the adapter's default.
   * A registry entry that says the model has no reasoning turns it off (MD-N4-2).
   */
  public reasoningFor(req: Pick<InferenceRequest, "reasoning">): ReasoningLevel {
    if (this.registryEntry()?.reasoning?.supported === false) return "off";
    if (req.reasoning !== undefined) return req.reasoning;
    return this.options.disableReasoning === false ? "medium" : "off";
  }

  /** Thinking tokens allowed for a request whose reasoning is on. */
  private thinkingBudget(req: InferenceRequest, level: ReasoningLevel): number {
    if (level === "off") return 0;
    const registered = this.registryEntry()?.reasoning?.defaultBudget;
    return (
      req.reasoningBudgetTokens ??
      (registered !== undefined && registered > 0 ? registered : REASONING_BUDGET_TOKENS[level])
    );
  }

  constructor(options: HttpAdapterOptions) {
    this.options = options;
    this.modelId = options.modelId;
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.apiFormat = options.apiFormat ?? "ollama";
    this.sampling = options.sampling ?? {};
  }

  private keepAliveOverride: string | undefined;

  /**
   * The memory watchdog's shortened keep-alive (MD-N2-4), in force until it
   * is cleared with `undefined`.
   */
  public setKeepAliveOverride(value: string | undefined): void {
    this.keepAliveOverride = value;
  }

  /** Keep-alive, tightened when the host is under memory pressure. */
  private resolveKeepAlive(): string {
    if (this.keepAliveOverride !== undefined) return this.keepAliveOverride;
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
    const size = await this.tagSize();
    if (!size) return undefined;
    const kv = (this.contextWindow?.contextTokens ?? 8192) * 160 * 1024; // dense f16 KV, conservative
    return Math.round(size + kv + 1.5 * 1024 ** 3);
  }

  /** The model's size on an Ollama server (`/api/tags`); undefined when unknown. */
  private async tagSize(): Promise<number | undefined> {
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
      return m?.size || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Load the model now (models rule 20c, MD-N14-1): on Ollama, a request
   * with no prompt loads it at this adapter's window, so the first real
   * request does not reload it for another `num_ctx`. A model already
   * resident, or a server this adapter does not manage (OpenAI-compatible),
   * is adopted. The load is a cold load: it runs under `coldLoadTimeoutMs`
   * and is never retried, since a retry would queue behind the load it
   * abandoned. `signal` aborts it (the residency scheduler's `releaseAll`).
   */
  public async load(signal?: AbortSignal): Promise<"loaded" | "adopted"> {
    if (this.apiFormat !== "ollama") return "adopted";
    if (await this.isResident()) return "adopted";
    const { res, release } = await this.request(
      "/api/generate",
      {
        model: this.modelId,
        keep_alive: this.resolveKeepAlive(),
        ...(this.contextWindow !== undefined
          ? { options: { num_ctx: this.contextWindow.contextTokens } }
          : {}),
      },
      { cold: true, maxRetries: 0, ...(signal ? { signal } : {}) },
    );
    try {
      await res.json();
    } finally {
      release();
    }
    return "loaded";
  }

  /**
   * Where a local Ollama keeps its weights (`OLLAMA_MODELS`, else
   * `~/.ollama/models`) and the model's size, for Smart Swap's record.
   * Undefined for a remote server or an unknown size.
   */
  public async weightsSource(): Promise<{ path: string; bytes: number } | undefined> {
    const host = new URL(this.baseUrl).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return undefined;
    const bytes = await this.tagSize();
    if (!bytes) return undefined;
    return { path: process.env.OLLAMA_MODELS ?? join(homedir(), ".ollama", "models"), bytes };
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
    if (req.messages) {
      messages.push(...chatTurnsToWire(req.messages, this.apiFormat));
      return messages;
    }
    messages.push({
      role: "user",
      content: req.prompt,
      ...(req.images?.length ? { images: req.images } : {}),
    });
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

  /**
   * POST with the timeout and retry policy; resolves to an ok Response whose
   * timeout keeps running until `release` is called (a streamed body is
   * still covered by the request's wall-clock ceiling).
   */
  private async request(
    path: string,
    payload: unknown,
    policy: { cold?: boolean; maxRetries?: number; signal?: AbortSignal } = {},
  ): Promise<{ res: Response; release: () => void }> {
    const resident = policy.cold ? false : path === "/api/chat" ? await this.isResident() : true;
    const timeoutMs = resident
      ? (this.options.requestTimeoutMs ?? 300_000)
      : (this.options.coldLoadTimeoutMs ?? 480_000);
    const maxRetries = policy.maxRetries ?? this.options.maxRetries ?? 2;
    const outer = policy.signal;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (outer?.aborted) throw new Error(`Inference request to ${path} aborted`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      outer?.addEventListener("abort", onAbort, { once: true });
      let handedOff = false;

      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          const error = new InferenceHttpError(
            `Inference HTTP ${res.status} ${res.statusText} from ${this.baseUrl}${path}: ${detail.slice(0, 400)}`,
            res.status,
          );
          // Client errors are deterministic; retrying just burns wall clock.
          if (!RETRYABLE_STATUS.has(res.status)) throw error;
          lastError = error;
        } else {
          handedOff = true;
          // The abort keeps covering the body until it is read.
          return {
            res,
            release: () => {
              clearTimeout(timer);
              outer?.removeEventListener("abort", onAbort);
            },
          };
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error instanceof InferenceHttpError && !RETRYABLE_STATUS.has(error.status)) {
          throw error;
        }
        if (outer?.aborted) throw new Error(`Inference request to ${path} aborted`);
        if (error.name === "AbortError") {
          lastError = new Error(`Inference request timed out after ${timeoutMs}ms`);
        } else if (lastError === undefined) {
          lastError = error;
        }
        if (attempt === maxRetries) break;
      } finally {
        if (!handedOff) {
          clearTimeout(timer);
          outer?.removeEventListener("abort", onAbort);
        }
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }

    throw lastError ?? new Error("Inference request failed");
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const { res, release } = await this.request(path, payload);
    try {
      return await res.json();
    } finally {
      release();
    }
  }

  /**
   * POST and read the body as lines (SSE `data:` lines or NDJSON), calling
   * `onLine` for each non-empty line. Used for token streaming (M2).
   */
  private async postStream(
    path: string,
    payload: unknown,
    onLine: (line: string) => void,
  ): Promise<void> {
    const { res, release } = await this.request(path, payload);
    try {
      const body = res.body;
      if (!body) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line.trim()) onLine(line);
          nl = buffer.indexOf("\n");
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) onLine(buffer.trim());
    } finally {
      release();
    }
  }

  /**
   * Health contract (M4). Ollama: the server answers `/api/tags` and lists
   * the model (available), and `/api/ps` says whether it is resident.
   * OpenAI-compatible (llama-server): `/health` answers ok, else
   * `/v1/models` does. Never throws.
   */
  public async healthCheck(): Promise<AdapterHealth> {
    const start = performance.now();
    const done = (h: Omit<AdapterHealth, "latencyMs" | "modelId">): AdapterHealth => ({
      modelId: this.modelId,
      latencyMs: Math.round(performance.now() - start),
      ...h,
    });
    const getJson = async (path: string): Promise<{ ok: boolean; body: unknown }> => {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => undefined);
      return { ok: res.ok, body };
    };
    try {
      if (this.apiFormat === "ollama") {
        const tags = await getJson("/api/tags");
        if (!tags.ok) {
          return done({ ok: false, reachable: true, loaded: false, detail: "/api/tags failed" });
        }
        const names = (tags.body as { models?: { name?: string; model?: string }[] }).models ?? [];
        const same = (n: string | undefined) =>
          n !== undefined && normalizeTag(n) === normalizeTag(this.modelId);
        if (!names.some((m) => same(m.name) || same(m.model))) {
          return done({
            ok: false,
            reachable: true,
            loaded: false,
            detail: `model ${this.modelId} is not available on the server`,
          });
        }
        const ps = await getJson("/api/ps").catch(() => ({ ok: false, body: undefined }));
        const running =
          (ps.body as { models?: { name?: string; model?: string }[] } | undefined)?.models ?? [];
        return done({
          ok: true,
          reachable: true,
          loaded: running.some((m) => same(m.name) || same(m.model)),
        });
      }
      const health = await getJson("/health").catch(() => undefined);
      if (health?.ok) return done({ ok: true, reachable: true, loaded: true });
      const models = await getJson("/v1/models");
      return models.ok
        ? done({ ok: true, reachable: true, loaded: true })
        : done({ ok: false, reachable: true, loaded: false, detail: "server not ready" });
    } catch (err) {
      return done({
        ok: false,
        reachable: false,
        loaded: false,
        detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** What kind of step a request is, for the cache monitor. */
  private stepKind(req: InferenceRequest): CacheStepKind {
    const last = req.messages?.[req.messages.length - 1];
    if (last?.role === "tool") return "tool_result";
    return this.requests === 0 ? "first" : "other";
  }

  private requests = 0;
  private constrainedUnsupported = false;

  public async generate(req: InferenceRequest): Promise<InferenceResponse> {
    const start = performance.now();
    if (this.apiFormat === "ollama" && req.tools && req.tools.length > 0) {
      const kv = this.options.ollamaKvCacheType ?? process.env.OLLAMA_KV_CACHE_TYPE;
      if (kv) assertKvType(kv); // throws KvPolicyError for 4-bit (M16)
    }
    if (this.options.registry && !this.templateChecked) await this.verifyTemplate();
    const kind = this.stepKind(req);
    const messages = this.messages(req);
    // CX-N3-3: never send a prompt larger than the context set for the model.
    const window = this.contextWindow?.contextTokens;
    if (window !== undefined) {
      const counted = countPromptTokens(messages, req.tools);
      if (counted > window) {
        throw new ContextOverflowError(
          req.role ?? this.options.role ?? "model",
          this.modelId,
          counted,
          window,
        );
      }
    }
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
    // WL-M3-4: thinking and answer tokens, from the server's count when it
    // gives one, else from the thinking text (apart, or inline before strip).
    const thinkingChars = (data.thinking?.length ?? 0) + (data.text.length - visible.length);
    const completion = completionTokens ?? Math.round(visible.length / 4);
    const thinkingTokens = Math.min(
      completion,
      data.thinkingTokens ?? Math.round(Math.max(0, thinkingChars) / 4),
    );
    const usage: TokenUsage = {
      promptTokens:
        promptTokens ?? Math.round(messages.reduce((a, m) => a + m.content.length, 0) / 4),
      completionTokens: completion,
      durationMs: Math.round(performance.now() - start),
      ...measured,
      thinkingTokens,
      answerTokens: Math.max(0, completion - thinkingTokens),
    };
    this.requests++;
    const telemetry = this.options.telemetry ?? modelTelemetry;
    if (telemetry) {
      telemetry.record(this.modelId, kind, usage, (rec) => {
        const alert = { ...rec, modelId: this.modelId };
        if (this.options.onCacheAlert) this.options.onCacheAlert(alert);
        else {
          process.stderr.write(
            `[cache] ${this.modelId} step ${rec.step}: tool-result prefix-cache hit rate ${(rec.cacheHitRate * 100).toFixed(1)}% is under 85%\n`,
          );
        }
      });
    }
    return {
      text: visible,
      toolCalls,
      usage,
      ...(data.finishReason ? { finishReason: data.finishReason } : {}),
    };
  }

  private async generateOllama(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<GenerationResult> {
    const sampling = this.samplingFor(req);
    const stream = req.onToken !== undefined;
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages: imagesToWire(messages, "ollama"),
      stream,
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
        ...(this.contextWindow !== undefined ? { num_ctx: this.contextWindow.contextTokens } : {}),
        // Rule 10: a fixed sampling seed, only when a measured run set one.
        ...(this.fixedSeed !== undefined ? { seed: this.fixedSeed } : {}),
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

    type OllamaChunk = {
      message?: { content?: string; thinking?: string; tool_calls?: NativeToolCall[] };
      done?: boolean;
      load_duration?: number;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      eval_count?: number;
      eval_duration?: number;
      done_reason?: string;
    };

    if (stream) {
      let text = "";
      let thinking = "";
      const calls: NativeToolCall[] = [];
      let final: OllamaChunk = {};
      await this.postStream("/api/chat", payload, (line) => {
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line) as OllamaChunk;
        } catch {
          return;
        }
        const delta = chunk.message?.content ?? "";
        if (delta) {
          text += delta;
          req.onToken?.(delta);
        }
        if (chunk.message?.thinking) thinking += chunk.message.thinking;
        if (Array.isArray(chunk.message?.tool_calls)) calls.push(...chunk.message.tool_calls);
        if (chunk.done) final = chunk;
      });
      return {
        text,
        nativeCalls: nativeToToolCalls(calls),
        usage: usageFromOllama(final),
        ...(final.done_reason ? { finishReason: final.done_reason } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }

    const data = (await this.post("/api/chat", payload)) as OllamaChunk;

    return {
      text: data.message?.content ?? "",
      nativeCalls: nativeToToolCalls(data.message?.tool_calls),
      usage: usageFromOllama(data),
      ...(data.done_reason ? { finishReason: data.done_reason } : {}),
      ...(data.message?.thinking ? { thinking: data.message.thinking } : {}),
    };
  }

  private async generateOpenAi(
    messages: ChatMessage[],
    req: InferenceRequest,
    maxTokens: number,
  ): Promise<GenerationResult> {
    const sampling = this.samplingFor(req);
    const stream = req.onToken !== undefined;
    const payload: Record<string, unknown> = {
      model: this.modelId,
      messages: imagesToWire(messages, "openai"),
      temperature: req.temperature ?? sampling.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    if (req.slot !== undefined) payload.id_slot = req.slot;
    // Rule 10: a fixed sampling seed, only when a measured run set one.
    if (this.fixedSeed !== undefined) payload.seed = this.fixedSeed;

    if (sampling.topP !== undefined) payload.top_p = sampling.topP;
    if (sampling.topK !== undefined) payload.top_k = sampling.topK;
    if (sampling.minP !== undefined) payload.min_p = sampling.minP;
    if (sampling.presencePenalty !== undefined) {
      payload.presence_penalty = sampling.presencePenalty;
    }
    if (sampling.repeatPenalty !== undefined) {
      payload.repeat_penalty = sampling.repeatPenalty;
    }
    const hasTools = req.tools !== undefined && req.tools.length > 0;
    const constrained =
      hasTools &&
      this.options.constrainedToolCalls === true &&
      !this.constrainedUnsupported &&
      req.toolArm !== "arm_c_sketch";
    if (constrained && req.tools) {
      // Arm A, grammar-constrained (M8): the schema replaces native tools.
      payload.response_format = {
        type: "json_schema",
        json_schema: { name: "tool_calls", strict: true, schema: constrainedToolSchema(req.tools) },
      };
    } else if (this.options.nativeTools !== false && hasTools && req.tools) {
      payload.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      // Several independent calls in one step (the Researcher's parallel searches).
      payload.parallel_tool_calls = true;
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

    type Completion = {
      choices?: {
        message?: { content?: string; reasoning_content?: string; tool_calls?: NativeToolCall[] };
        finish_reason?: string | null;
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      };
      timings?: LlamaServerTimings;
    };

    let data: Completion;
    try {
      data = stream
        ? await this.streamOpenAi(payload, req)
        : ((await this.post("/v1/chat/completions", payload)) as Completion);
    } catch (err) {
      if (
        constrained &&
        err instanceof InferenceHttpError &&
        err.status >= 400 &&
        err.status < 500
      ) {
        // The server cannot compile the schema: remember, then use native tools.
        this.constrainedUnsupported = true;
        return this.generateOpenAi(messages, req, maxTokens);
      }
      throw err;
    }

    const message = data.choices?.[0]?.message;
    const usage = usageFromLlamaServer(data.timings, data.usage);
    const finish = data.choices?.[0]?.finish_reason;
    const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
    const extra = {
      ...(finish ? { finishReason: finish } : {}),
      ...(message?.reasoning_content ? { thinking: message.reasoning_content } : {}),
      ...(reasoningTokens !== undefined ? { thinkingTokens: reasoningTokens } : {}),
    };
    if (constrained && req.tools) {
      const parsed = parseConstrainedReply(
        message?.content ?? "",
        new Set(req.tools.map((t) => t.name)),
      );
      if (parsed) return { text: parsed.message, nativeCalls: parsed.calls, usage, ...extra };
    }
    return {
      text: message?.content ?? "",
      nativeCalls: nativeToToolCalls(message?.tool_calls),
      usage,
      ...extra,
    };
  }

  /**
   * Stream an OpenAI-compatible completion (M2): forward content deltas,
   * accumulate tool-call fragments by index, keep the last usage/timings.
   */
  private async streamOpenAi(
    payload: Record<string, unknown>,
    req: InferenceRequest,
  ): Promise<{
    choices: {
      message: { content: string; reasoning_content?: string; tool_calls: NativeToolCall[] };
      finish_reason?: string;
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    timings?: LlamaServerTimings;
  }> {
    let content = "";
    let reasoning = "";
    let finishReason: string | undefined;
    const calls: { id?: string; name: string; args: string }[] = [];
    let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
    let timings: LlamaServerTimings | undefined;
    await this.postStream("/v1/chat/completions", payload, (line) => {
      if (!line.startsWith("data:")) return;
      const body = line.slice(5).trim();
      if (body === "[DONE]") return;
      let chunk: {
        choices?: {
          finish_reason?: string | null;
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: {
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }[];
          };
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        timings?: LlamaServerTimings;
      };
      try {
        chunk = JSON.parse(body);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) finishReason = finish;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.content) {
        content += delta.content;
        // Constrained replies are JSON, not prose: nothing to show token by token.
        if (!payload.response_format) req.onToken?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        const slot = calls[i] ?? { name: "", args: "" };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls[i] = slot;
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.timings) timings = chunk.timings;
    });
    return {
      choices: [
        {
          ...(finishReason ? { finish_reason: finishReason } : {}),
          message: {
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            tool_calls: calls
              .filter((c) => c?.name)
              .map((c) => ({
                ...(c.id ? { id: c.id } : {}),
                function: { name: c.name, arguments: c.args || "{}" },
              })),
          },
        },
      ],
      ...(usage ? { usage } : {}),
      ...(timings ? { timings } : {}),
    };
  }
}

/** Ollama tags match with or without the implicit `:latest`. */
function normalizeTag(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
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
