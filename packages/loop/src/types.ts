import type { GateResult, GateRunner } from "@sekhemet/gates";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";

export type ExecutionStopReason =
  | "gate_passed"
  | "budget_exhausted"
  | "oscillation_detected"
  | "error"
  | "quota_suspended";

export interface TurnResult {
  turnIndex: number;
  toolCalls: ToolCall[];
  gateResult?: GateResult | undefined;
  stopReason?: ExecutionStopReason | undefined;
}

export interface SessionOptions {
  cardId: string;
  stepBudget: number;
  worktreePath: string;
  modelAdapter: LocalInferenceAdapter;
  gateRunner: GateRunner;
  initialPrompt?: string;
}

export interface CardExecutionSession {
  readonly cardId: string;
  executeTurn(): Promise<TurnResult>;
  runVerification(): Promise<GateResult>;
  abort(reason: string): Promise<void>;
  getStepsUsed(): number;
}
