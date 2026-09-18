import type { PlaybookRegistry, SkillsRegistry, ToolInterfaceSpec } from "@sekhemet/context";
import type { GateResult, GateRung, GateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, TokenUsage, ToolArm, ToolCall } from "@sekhemet/models";
import type { GitSyncAdapter } from "@sekhemet/sync";
import type { ToolObservation } from "./observation.js";
import type { ApprovalHandler } from "./tools.js";

export type ExecutionStopReason =
  | "gate_passed"
  | "budget_exhausted"
  | "oscillation_detected"
  | "no_progress"
  | "repair_exhausted"
  | "error"
  | "memory_pressure"
  | "quota_suspended";

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
  /** Working-memory lines from earlier attempts at this card (never start blank). */
  priorLessons?: string[] | undefined;
  /** Gate rungs run when the agent calls `finish_card`. Defaults to typecheck + test. */
  gateRungs?: GateRung[] | undefined;
  /** Failed verifications tolerated before the card stops for human review. */
  maxRepairAttempts?: number | undefined;
  /** Identical turns tolerated before the oscillation breaker trips. */
  oscillationThreshold?: number | undefined;

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
}

export interface CardExecutionSession {
  readonly cardId: string;
  executeTurn(): Promise<TurnResult>;
  run(): Promise<TurnResult[]>;
  runVerification(): Promise<GateResult>;
  abort(reason: string): Promise<void>;
  getStepsUsed(): number;
}
