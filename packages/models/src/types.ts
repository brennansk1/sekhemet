import type { Engine, LoadOptions } from "./load_mechanics.js";

export type ToolArm = "arm_a_flat" | "arm_b_json" | "arm_c_sketch";

/**
 * The harness consults a model in four roles (models rule 21, MD-N4-1): the
 * Worker executes cards; the Planner plans, answers about the board and
 * speaks as Seshat; the Reviewer reads a passing diff; the Researcher answers
 * with sources. `vision` is a capability a model may hold, not a role. This
 * is the only role enumeration: queues (chat, escalated retries, questions)
 * are work a role's weights serve, not roles.
 */
export const MODEL_ROLES = ["worker", "planner", "reviewer", "researcher"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

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
/**
 * An image for a vision-capable model (X3), base64 without the data-URL
 * prefix. Text models never receive one: they get the vision model's
 * structured description instead.
 */
export interface ImageInput {
  mime: string;
  data: string;
  name?: string;
}

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Images on a user turn (vision models only). */
  images?: ImageInput[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface InferenceRequest {
  systemPrompt?: string;
  /** The user message. Ignored when `messages` is set. */
  prompt: string;
  /** Images for the `prompt` user message (vision models only, X3). */
  images?: ImageInput[];
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
  /**
   * The live session this request continues on its slot (models rule 20i):
   * Seshat's thread by thread id, or a card's attempt. Its slot is saved when
   * the weights leave and restored on return; `sources` are the ledger event
   * and blob ids the prompt was built from, so an erasure deletes the slot.
   */
  session?: { owner: string; kind: "thread" | "live_card"; sources?: string[] };
  /** Whose prompt this is (worker, planner, seshat, reviewer, researcher): named in a refusal (CX-N3-3). */
  role?: string;
  /**
   * What the request is for, in a lower-case code name (`answer`,
   * `read_document`, `summarize`, `replan`): the `purpose` of its usage
   * record on the ledger (`model/usage`, measurement rule 4a). Undefined: the
   * role's own work (`code`, `plan`, `answer`, `review`, `research`).
   */
  task?: string;
  /**
   * The caller records this request's usage on the ledger itself, as a
   * card's step (`card/step`): the one path to a model does not record it a
   * second time as `model/usage` (measurement rule 4a).
   */
  recordedAsCardStep?: boolean;
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
  /** Tokens the speculative draft proposed this call (llama-server `draft_n`, MD-M4-4). */
  draftTokens?: number;
  /** Of those, the tokens the model accepted (`draft_n_accepted`). */
  draftAcceptedTokens?: number;
  /** Prefill (prompt evaluation) speed for this request, tokens/s (M3). */
  prefillTokensPerSecond?: number;
  /** Decode (generation) speed for this request, tokens/s (M3). */
  decodeTokensPerSecond?: number;
  /** Server-measured prefill and decode wall time, ms. */
  prefillMs?: number;
  decodeMs?: number;
  /**
   * Of `completionTokens`, those spent thinking and those spent on the answer
   * (worker-loop WL-M3-4). The server's count when it reports one, else
   * estimated from the thinking text at four characters a token.
   */
  thinkingTokens?: number;
  answerTokens?: number;
  /**
   * Time the server spent loading the model for this request, when it says
   * (Ollama's `load_duration`); the measurement reports it apart from the
   * card's own time (measurement MS-T7-1).
   */
  loadMs?: number;
  /**
   * For a server the harness started: from spawning it to its first healthy
   * `/health`, reported once, on the first reply after the start (MS-T7-1).
   * It includes the health polling's granularity (one second).
   */
  spawnToHealthyMs?: number;
}

/**
 * Why generation ended, as the server reports it (`finish_reason`, Ollama's
 * `done_reason`): `length` means a cap cut the reply off (worker-loop rule 23).
 */
export type FinishReason = "stop" | "length" | "tool_calls" | (string & {});

export interface InferenceResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** Why generation ended, when the server says (WL-M3-2, WL-M3-4). */
  finishReason?: FinishReason;
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
  /**
   * True when the adapter's server is not on this machine (a base URL that
   * is not a loopback address): text that must stay local — a card's spec,
   * a gate's output — is never sent to it.
   */
  readonly remote?: boolean;
  generate(req: InferenceRequest): Promise<InferenceResponse>;
  /**
   * The thinking tokens this adapter would add to the request's answer cap
   * (worker-loop rule 22): 0 for a model it would not let think. A caller
   * that budgets a prompt reserves this, not a fixed cap (live-test F25).
   */
  thinkingAllowance?(req: Pick<InferenceRequest, "reasoning" | "reasoningBudgetTokens">): number;
  /** Health contract (M4); every adapter in this package implements it. */
  healthCheck?(): Promise<AdapterHealth>;
}

/**
 * What a serving engine tells the residency scheduler (models rules 20g,
 * 20h): a Metal command-buffer timeout (the host's GPU ceiling), or a model
 * Ollama serves requantised.
 */
export type ModelSignal =
  | { kind: "metal_timeout"; detail: string }
  | {
      kind: "requantised";
      servedQuant?: string;
      fileQuant?: string;
      hashDiffers: boolean;
      reason: string;
    };

/** An adapter that can release its weights. HttpInferenceAdapter implements this. */
export interface UnloadableAdapter extends LocalInferenceAdapter {
  unload?(): Promise<void>;
  /** Resolves true once the weights are really gone (see HttpInferenceAdapter). */
  confirmUnloaded?(timeoutMs?: number): Promise<boolean>;
  /** Bytes the model occupies when resident (weights, KV cache, runtime). */
  footprintBytes?(): Promise<number | undefined>;
  /**
   * Load the weights now rather than on the first request (models rule 20c,
   * MD-N14-1), so the residency scheduler times the load it ordered.
   * `adopted`: a running server already served them, and nothing loaded.
   * `signal` aborts a load in flight (the scheduler's `releaseAll`, the
   * watchdog's unload): the server process is stopped or the request
   * cancelled, and the promise rejects.
   */
  load?(signal?: AbortSignal, options?: LoadOptions): Promise<"loaded" | "adopted">;
  /** Listen for the engine's signals (a Metal timeout, a requantised model). */
  onSignal?(listener: (signal: ModelSignal) => void): void;
  /** The engine serving the weights (rule 20h), recorded on `model/loaded`. */
  readonly engine?: Engine | undefined;
  /** The weights file (or store) and its bytes, for Smart Swap's record; undefined when unknown. */
  weightsSource?(): Promise<{ path: string; bytes: number } | undefined>;
  /**
   * The ledger's erasure index, swept over the adapter's saved slots before
   * every restore (rule 20i, MD-N14-37: a slot an erasure covers is deleted).
   */
  setErasureSource?(
    source:
      | (() => { byEvent: ReadonlyMap<string, unknown>; byBlob: ReadonlyMap<string, unknown> })
      | undefined,
  ): void;
}
