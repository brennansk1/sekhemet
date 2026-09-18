import type { GateResult } from "@sekhemet/gates";
import type { ToolCall } from "@sekhemet/models";

export type ExecutionStopReason =
  | "gate_passed"
  | "budget_exhausted"
  | "oscillation_detected"
  | "error"
  | "quota_suspended";

export interface TurnResult {
  turnIndex: number;
  toolCalls: ToolCall[];
  gateResult?: GateResult;
  stopReason?: ExecutionStopReason;
}

export interface CardExecutionSession {
  readonly cardId: string;
  executeTurn(): Promise<TurnResult>;
  runVerification(): Promise<GateResult>;
  abort(reason: string): Promise<void>;
}
