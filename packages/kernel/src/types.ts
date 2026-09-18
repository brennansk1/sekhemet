export type CardTier = "initiative" | "epic" | "feature" | "story" | "task";

export type CardStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "verify"
  | "review"
  | "done"
  | "rejected"
  | "parked";

export type GateStatus = "pass" | "fail" | "partial" | "suspended-quota";

export type AgentRole =
  | "lead-driver"
  | "delegator"
  | "implementer"
  | "architect"
  | "test-author"
  | "relay-finisher";

export interface EventRecord<T = unknown> {
  seq: number;
  id: string;
  actor: string;
  type: string;
  payload: T;
  hash: string;
  prevHash: string;
  createdAt: string;
}

export interface AppendEventParams<T = unknown> {
  id?: string;
  actor: string;
  type: string;
  payload: T;
}

export interface CardRecord {
  id: string;
  tier: CardTier;
  parentId?: string | null;
  title: string;
  status: CardStatus;
  scopeFiles: string[];
  stepBudget: number;
  stepsUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface CheckpointRecord {
  cardId: string;
  step: number;
  gitRef: string;
  gateStatus: GateStatus;
  agentModel: string;
  agentHarness: string;
  agentRole: AgentRole;
  createdAt: string;
}

export interface HashChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  corruptedSeq?: number;
  reason?: string;
}
