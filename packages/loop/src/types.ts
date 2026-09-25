import type { PlaybookRegistry, SkillsRegistry, ToolInterfaceSpec } from "@sekhemet/context";
import type { GateFailure, GateResult, GateRung, GateRunner } from "@sekhemet/gates";
import type { BudgetDetail, CardRecord, CardStopReason } from "@sekhemet/kernel";
import type {
  FinishReason,
  LocalInferenceAdapter,
  TokenUsage,
  ToolArm,
  ToolCall,
} from "@sekhemet/models";
import type { ProcessSandbox } from "@sekhemet/sandbox";
import type { GitSyncAdapter } from "@sekhemet/sync";
import type { ToolObservation } from "./observation.js";
import type { StepPhase } from "./phase.js";
import type { ApprovalHandler } from "./tools.js";

/**
 * Why a card's execution stopped (L14). The kernel owns the union so the card
 * record can persist it; the loop produces every member except
 * `quota_suspended`, which the relay protocol sets.
 */
export type ExecutionStopReason = CardStopReason;

/**
 * Repair rung 3 (L15): the card needs a new plan, not another patch.
 *
 * Returned as a typed result so the harness can fulfil it (the manager
 * model's `planRepair`) and start the next attempt with the plan, or answered
 * in-loop through `SessionOptions.onReplan`.
 */
export interface ReplanRequest {
  cardId: string;
  /** Verification attempts spent before the request. */
  attempts: number;
  /** The standing failures, highest leverage first (at most 3). */
  failures: GateFailure[];
  filesWritten: string[];
  /** What the Worker learned so far (working-memory lines). */
  lessons: string[];
  /** One paragraph for the planner. */
  summary: string;
}

/**
 * Repair rung 4 (L15): why a card was parked, for the human who picks it up.
 */
export interface ParkDiagnosis {
  cardId: string;
  /** A reason whose row in `STOP_REASONS` parks the card (rule 31). */
  stopReason: CardStopReason;
  attempts: number;
  /** True when a re-plan had already been tried on this card. */
  replanned: boolean;
  failures: { gate: string; excerpt: string; location?: string }[];
  filesWritten: string[];
  lessons: string[];
  /** The smallest action that would unblock the card. */
  suggestion: string;
}

export interface TurnResult {
  turnIndex: number;
  toolCalls: ToolCall[];
  /** One observation per dispatched tool call, in call order. */
  observations: ToolObservation[];
  /** The model's raw reply, kept for the transcript and for diagnosis. */
  rawText?: string | undefined;
  /** Token cost of this turn, as reported by the inference server. */
  usage?: TokenUsage | undefined;
  gateResult?: GateResult | undefined;
  stopReason?: ExecutionStopReason | undefined;
  /** The step's phase, from `phaseOf` (WL-T3-1). */
  phase?: StepPhase | undefined;
  /** With `budget_exhausted`: which budget ran out (rule 31a, WL-T3-12). */
  budget?: BudgetDetail | undefined;
  /** With `oscillation_detected`: the call that was repeated (WL-T3-3). */
  repeatedCall?: string | undefined;
  /** With `human_abort`: who stopped it, the abort's reason (rule 31). */
  abortedBy?: string | undefined;
  /** With `hook_veto`: the hook and its reason (WL-T3-4). */
  hookVeto?: { hook: string; reason: string } | undefined;
  /** Why the reply ended, as the server said (WL-M3-4). */
  finishReason?: FinishReason | undefined;
  /**
   * The reply was cut off by a cap (`finish_reason = "length"`, WL-M3-2):
   * which part and the cap. Never counted as a silent step or a stall.
   */
  truncated?: { cut: "thinking" | "answer"; capTokens: number } | undefined;
  /**
   * Tool-call format errors in the reply (WL-M2-5): an attempted call the
   * parser could not read, or a call to a tool not offered.
   */
  formatErrors?: number | undefined;
  /** 1 when the reply held no tool call and no attempt at one: prose only (WL-M2-5). */
  proseOnly?: number | undefined;
  /** The pass@k sample this step belongs to, from 1 (set by the runner, WL-T3-13). */
  sample?: number | undefined;
  /** The stored context pack this turn's model request carried (K11, K26). */
  contextPackId?: string | undefined;
  /** Set by the runner once the step is recorded (K4, K16, K17). */
  attemptId?: string | undefined;
  stepId?: string | undefined;
  /** Wall time of the turn, ms. */
  durationMs?: number | undefined;
  /** The context-pack record and step metrics of this turn's prompt (C14, C20). */
  contextReport?:
    | {
        pack: import("@sekhemet/context").ContextPackRecord;
        metrics: import("@sekhemet/context").ContextStepMetrics;
      }
    | undefined;
}

/** What one model request carried, handed to `onPrompt` before it is sent (K11). */
export interface PromptRecord {
  step: number;
  systemPrompt: string;
  prompt: string;
  tools: string[];
  reasoning?: string | undefined;
}

export interface SessionOptions {
  cardId: string;
  stepBudget: number;
  worktreePath: string;
  modelAdapter: LocalInferenceAdapter;
  gateRunner: GateRunner;

  /** Full card record. When absent a minimal one is synthesized from `cardId`. */
  card?: CardRecord | undefined;
  cardTitle?: string | undefined;

  scopeFiles?: string[] | undefined;
  agentRole?: string | undefined;

  toolArm?: ToolArm | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;

  /**
   * Formatter argv run over scope files before each verification (scope paths
   * appended). Only scope files: protected tests are never rewritten.
   */
  autofixCommand?: string[] | undefined;
  /**
   * One argv per stylistic rule; scope files are appended to each. Biome
   * applies unsafe fixes reliably only one `--only` rule per invocation.
   */
  styleFixCommands?: string[][] | undefined;
  /** Branch the card's diff is measured against (integrity gate). */
  baseBranch?: string | undefined;
  /** Scan the card's diff for disabled checks (default on). */
  integrityGate?: boolean | undefined;
  /** One paragraph on the team: who can answer what, and whether now or later. */
  teamNote?: string | undefined;
  /**
   * Route a question the card's contract does not answer to the team. Resolves
   * to an answer when someone can answer now (Seshat resident), or undefined
   * when it was queued for later.
   */
  askTeam?:
    | ((question: string, meta?: { questionEntryId?: string }) => Promise<string | undefined>)
    | undefined;
  /**
   * Record a Worker question in the card's dossier; resolves to its entry id,
   * which is handed to `askTeam` so a later answer can name its question.
   */
  recordQuestion?: ((question: string) => Promise<string | undefined>) | undefined;
  /** Record the team's in-run answer to a question in the card's dossier. */
  recordAnswer?:
    | ((answer: string, questionEntryId: string | undefined) => Promise<void>)
    | undefined;
  /**
   * What the team has recorded about this card (the dossier: send-backs,
   * review findings, answers, research, notes, lessons), one line each.
   */
  dossierLines?: string[] | undefined;
  /** Working-memory lines from earlier attempts at this card (never start blank). */
  priorLessons?: string[] | undefined;
  /** Gate rungs run when the agent calls `finish_card`. Defaults to typecheck + test. */
  gateRungs?: GateRung[] | undefined;
  /** Failed verifications tolerated before the card stops for human review. */
  maxRepairAttempts?: number | undefined;
  /**
   * A repair plan from the manager model, produced after an earlier attempt at
   * this card failed. Rendered ahead of everything else the worker is told.
   */
  managerGuidance?: string | undefined;
  /**
   * Maximum tokens a request may occupy (prompt plus tool schemas). Defaults to
   * the adapter's context window minus its reserved output tokens.
   */
  promptTokenBudget?: number | undefined;
  /** Tool interface rendered into the prompt. Defaults to the full catalog. */
  tools?: ToolInterfaceSpec[] | undefined;
  skillsRegistry?: SkillsRegistry | undefined;
  playbookRegistry?: PlaybookRegistry | undefined;

  /** Invoked for `ask`-tier permission checks. Absent means ask-tier is refused. */
  onApproval?: ApprovalHandler | undefined;
  /** Supplies the repo state hash that makes stall detection trustworthy. */
  syncAdapter?: GitSyncAdapter | undefined;
  allowNetwork?: boolean | undefined;
  commandTimeoutMs?: number | undefined;
  /** Swap limits checked before every inference turn. Absent or false disables the guard. */
  memoryGuard?: import("@sekhemet/models").HeadroomLimits | false | undefined;
  /**
   * Replaces the built-in headroom check before each turn (a memory watchdog
   * the harness runs, or a test). A not-ok verdict stops with `memory_pressure`.
   */
  memoryProbe?: (() => { ok: boolean; reason?: string | undefined }) | undefined;

  /**
   * "Model-visible means logged" (K11): called with every request before it
   * is sent; returns the id the prompt was stored under. If it throws, the
   * request is not sent: a prompt that cannot be logged never reaches a model.
   */
  onPrompt?: ((record: PromptRecord) => string) | undefined;
  /** One per runner: asserts the system prompt stays byte-stable within a card (C4). */
  prefixGuard?: import("@sekhemet/context").PrefixStabilityGuard | undefined;
  /** Passing runs of the card's class, shown as worked examples (C13). */
  exemplarStore?: import("@sekhemet/context").ExemplarStore | undefined;
  /** Load tools on demand through tool_search instead of sending every contract (C19). */
  progressiveTools?: boolean | undefined;
  /** The registry marks the Worker model script-capable: only then is `run_script` offered (WL-M2-4). */
  scriptCapable?: boolean | undefined;
  /**
   * Where the Worker thinks. "off" (the default) is the original policy:
   * thinking only on escalated repair rungs. "surgical" adds it where
   * judgement matters — the first turn of an attempt and the turn after a
   * failed check or gate. "all" thinks on every turn. Chosen by the frozen
   * suite, not by argument.
   */
  thinking?: "off" | "surgical" | "all" | undefined;
  /**
   * The Worker's working method (design: "The Worker's working method").
   * "strict" refuses re-running a command when nothing has changed since it
   * last ran, and refuses finish_card while the last check failed and nothing
   * changed. Default "baseline" until the frozen suite admits it.
   */
  workerMethod?: "baseline" | "strict" | undefined;
  /** The model a `subtask` child context runs on (C16); default the Worker's own. */
  subtaskAdapter?: LocalInferenceAdapter | undefined;
  /** Decoded tokens as they stream, for the dashboard's live step view (M2). */
  onToken?: ((delta: string) => void) | undefined;
  /** Project lifecycle hooks (K12): the ten events are emitted at their points. */
  hooks?: import("@sekhemet/kernel").LifecycleHookEngine | undefined;
  /** Official web docs for the `docs` tool when the installed copy has nothing (L10). */
  webDocs?: ((library: string, query: string) => Promise<string>) | undefined;
  /** Language servers for the symbol tools on non-TypeScript files (C2). */
  lspPool?: import("@sekhemet/context").LspPool | undefined;
  /** Called with every note the Worker writes, as it writes it (L11). */
  onNote?: ((text: string) => Promise<void>) | undefined;
  /** Domains network commands may reach, through the egress proxy (S5, S8). */
  allowedDomains?: string[] | undefined;
  egressProxyPort?: number | undefined;
  /** Restricted mode: the agent's own commands refuse to run unconfined (defect 3). */
  requireConfinement?: boolean | undefined;
  /**
   * Restricted mode (`--restricted`, S12): a read-only audit. `run_cmd` and
   * every writing tool are stripped from the catalog and refused by the
   * executor; verification runs only the static gates, with no formatter.
   */
  restricted?: boolean | undefined;
  /** The one network policy (security item 28); absent means offline. */
  networkPolicy?: import("@sekhemet/sandbox").EffectiveNetworkPolicy | undefined;
  /** Sandbox for the agent's tools; defaults to a new ProcessSandbox. */
  sandbox?: ProcessSandbox | undefined;
  /** The project's protected globs (`gates.toml [project] protected`, defect 5). */
  protectedGlobs?: string[] | undefined;
  /** Refuse edits to files not read this card (L17). Default on. */
  requireReadBeforeEdit?: boolean | undefined;
  /**
   * Card size limits enforced at every verification (G10). The runner passes
   * the `gates.toml` values; `false` or absent disables the bounds gate.
   */
  bounds?: { maxFiles: number; maxLines: number } | false | undefined;
  /**
   * The project settings the built-in gates read (G3: secrets, dependencies,
   * osv, semgrep, hygiene, mutation). The runner passes `gates.toml
   * [project]`; absent or false runs none.
   */
  builtinGates?: import("@sekhemet/gates").GateProjectConfig | false | undefined;
  /** The project's .sekhemet directory (visual baselines). */
  stateDir?: string | undefined;
  /** Registry lookup for the dependency gate (G15/S10); default the local cache. */
  registry?: import("@sekhemet/gates").RegistryLookup | undefined;
  /** Out-of-scope write denials tolerated before the card stops (`scope_violation`). */
  maxScopeDenials?: number | undefined;
  /** Resume at this step count (H17): the step counter continues from it. */
  startStep?: number | undefined;
  /** Earlier steps replayed from the log, shown as history before the resume note (H17). */
  priorHistory?: import("@sekhemet/context").TurnHistoryItem[] | undefined;
  /**
   * Fulfil a repair-rung-3 re-plan in-loop. Resolves to the new plan, or
   * undefined to stop the card with `replan_requested`.
   */
  onReplan?: ((request: ReplanRequest) => Promise<string | undefined>) | undefined;
  /**
   * The card already had a re-plan (for example this attempt runs on one).
   * Defaults to true when `managerGuidance` is set. A card that exhausts the
   * ladder after a re-plan stops with `capability_ceiling`.
   */
  replanned?: boolean | undefined;
}

export interface CardExecutionSession {
  readonly cardId: string;
  executeTurn(): Promise<TurnResult>;
  run(): Promise<TurnResult[]>;
  runVerification(): Promise<GateResult>;
  abort(reason: string): Promise<void>;
  getStepsUsed(): number;
}
