export type ToolArm = "arm_a_flat" | "arm_b_json" | "arm_c_sketch";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  raw?: string;
}

export interface TextPatch {
  filePath?: string;
  search: string;
  replace: string;
}

/**
 * Per-request reasoning (M6). `off` suppresses the thinking channel (the
 * default for mechanical steps: Qwen-family models otherwise spend the budget
 * thinking and leave `content` empty); the other levels turn it on with that
 * effort. See `reasoningForStep` for the policy the loop should apply.
 */
export type ReasoningLevel = "off" | "low" | "medium" | "high";

/** What a request is for; selects the adapter's sampling profile (M5). */
export type RequestPurpose = "code" | "planning";

/**
 * One turn of a native multi-turn conversation. An assistant turn may carry
 * the tool calls it made; a `tool` turn answers one of them by `toolCallId`.
 */
export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface InferenceRequest {
  systemPrompt?: string;
  /** The user message. Ignored when `messages` is set. */
  prompt: string;
  /**
   * A native multi-turn conversation, sent as-is (after `systemPrompt`, when
   * given) instead of the single `prompt` user message.
   */
  messages?: ChatTurn[];
  tools?: ToolDefinition[];
  toolArm: ToolArm;
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning for this request only. Undefined keeps the adapter's default
   * (`disableReasoning`). When on, `reasoningBudgetTokens` caps the thinking
   * and is added to the output allowance so the answer is not starved.
   */
  reasoning?: ReasoningLevel;
  reasoningBudgetTokens?: number;
  /** `planning` uses the adapter's planning sampling profile when it has one. */
  purpose?: RequestPurpose;
  /**
   * Token streaming (M2). When set, the adapter asks the server to stream
   * and calls this with each visible text delta as it arrives; the returned
   * response is identical to the non-streaming one. Reasoning deltas are not
   * forwarded (traces never leave the adapter).
   */
  onToken?: (delta: string) => void;
  /**
   * The server slot to run on (llama-server `id_slot`). Pin a long
   * conversation to one slot and side calls to another so they do not
   * evict each other's cached prefix. Ignored by Ollama.
   */
  slot?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /**
   * Prompt tokens the server reused from its prefix cache (llama-server
   * `timings.cache_n`, or `usage.prompt_tokens_details.cached_tokens`).
   * Undefined when the server does not report it (Ollama).
   */
  cachedPromptTokens?: number;
  /**
   * cached / (cached + evaluated) prompt tokens, in [0, 1] (M18). The
   * Trifecta target is 0.98 on tool-result steps; see `PrefixCacheMonitor`.
   */
  cacheHitRate?: number;
  /** Prompt tokens the server actually evaluated (not served from cache). */
  evaluatedPromptTokens?: number;
  /** Prefill (prompt evaluation) speed for this request, tokens/s (M3). */
  prefillTokensPerSecond?: number;
  /** Decode (generation) speed for this request, tokens/s (M3). */
  decodeTokensPerSecond?: number;
  /** Server-measured prefill and decode wall time, ms. */
  prefillMs?: number;
  decodeMs?: number;
}

export interface InferenceResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
}

/**
 * An adapter's health (M4). `ok` means a request sent now can be served:
 * the server answers and the model is available (resident or loadable).
 */
export interface AdapterHealth {
  ok: boolean;
  modelId: string;
  /** The server answered at all. */
  reachable: boolean;
  /** The weights are resident now (a request pays no load). */
  loaded: boolean;
  latencyMs: number;
  detail?: string;
}

export interface LocalInferenceAdapter {
  readonly modelId: string;
  readonly supportedArms: ToolArm[];
  /** Context size and reserved output tokens, when known; used to budget prompts. */
  readonly contextWindow?: { contextTokens: number; maxTokens: number } | undefined;
  /**
   * True when the adapter sends `InferenceRequest.tools` as native schemas
   * (the server's chat template renders them). Prompt builders then omit the
   * text tool interface, so the tools are described once (C4).
   */
  readonly nativeTools?: boolean;
  /**
   * The tool arm measured best for this model (M9), from the registry's
   * qualification record. Callers use it instead of a hard-coded arm.
   */
  readonly preferredToolArm?: ToolArm | undefined;
  generate(req: InferenceRequest): Promise<InferenceResponse>;
  /** Health contract (M4); every adapter in this package implements it. */
  healthCheck?(): Promise<AdapterHealth>;
}
