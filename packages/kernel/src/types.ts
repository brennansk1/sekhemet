export type CardTier = "initiative" | "epic" | "feature" | "story" | "task";

/**
 * Board columns (design §2139).
 *
 * `planning` sits between Ready and InProgress: a card that has been pulled but
 * whose spec, scope and budget have not yet been settled is not "in progress",
 * and conflating the two hides the most expensive failure mode on the board —
 * an executor burning steps on an under-specified card. It is also the
 * destination for a regression found in Verify (`verify -> planning`), because
 * a card that failed its gates needs re-planning, not a blind retry.
 */
export type CardStatus =
  | "backlog"
  | "ready"
  | "planning"
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

/**
 * Why a card's execution stopped (design §333).
 *
 * Mirrors `ExecutionStopReason` in `@sekhemet/loop`. It is redeclared here
 * rather than imported because the kernel is the root of the package graph and
 * must not depend on the loop; the loop is free to narrow to this union.
 */
export type CardStopReason =
  | "gate_passed"
  | "budget_exhausted"
  | "oscillation_detected"
  | "no_progress"
  | "repair_exhausted"
  | "error"
  | "quota_suspended";

/** Which model handles each phase of a card (design §320). */
export interface ModelRoute {
  planner?: string;
  executor?: string;
}

/** Link to the card's origin in an external tracker (design §327). */
export interface ExternalRef {
  system: "github" | "forgejo";
  id: string;
  url: string;
}

export interface EventRecord<T = unknown> {
  seq: number;
  id: string;
  actor: string;
  type: string;
  payload: T;
  /** SHA-256 over the canonical (key-sorted) JSON of `payload`. */
  payloadHash: string;
  hash: string;
  prevHash: string;
  createdAt: string;
  /** Typed association columns — queryable without scanning the payload JSON. */
  cardId?: string;
  attemptId?: string;
  stepId?: string;
}

export interface AppendEventParams<T = unknown> {
  id?: string;
  actor: string;
  type: string;
  payload: T;
  cardId?: string;
  attemptId?: string;
  stepId?: string;
}

/** Narrowing filter for `EventLog.subscribe` / range queries. */
export interface EventFilter {
  cardId?: string;
  type?: string;
  actor?: string;
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

  // --- What the card is supposed to do (design §300-335) ---
  /** The full statement of intent handed to the executor. */
  spec?: string;
  /** Checkable outcomes; a card is not done until every one holds. */
  acceptanceCriteria?: string[];
  /**
   * Acceptance test files this card is gated by.
   *
   * Staged into the worktree before the first turn so a card's gate measures
   * that card. A project whose every suite is present from the start fails its
   * early cards on work that belongs to later ones.
   */
  acceptanceTests?: string[];
  /** Planner-assigned 1..10, the input to model routing and budgeting. */
  difficulty?: number;

  // --- Budgets and their actuals, the competence-model feedback loop ---
  tokenBudget?: number;
  secondsBudget?: number;
  tokensUsed?: number;
  secondsUsed?: number;

  // --- Routing, dependencies and provenance ---
  modelRoute?: ModelRoute;
  /** Card IDs this card waits on; eligible only when all of them are `done`. */
  dependsOn?: string[];
  contextPackId?: string;
  evidenceId?: string;
  externalRef?: ExternalRef;
  stopReason?: CardStopReason;

  // --- Board placement ---
  /** Team priority on Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority?: number;
  /** Points (1, 2, 3, 5, 8): Jira story points, Linear estimate. */
  estimate?: number;
  labels?: string[];
  /** The epic card this card belongs to. */
  epicId?: string;
  /** The cycle (sprint) the card is planned into. */
  cycleId?: string;
  /** "worker", "human", or a person's name. */
  assignee?: string;
  /** ISO date. */
  dueDate?: string;
  /** Lexicographic fractional index for manual ordering (see `order_key.ts`). */
  orderKey?: string;
  /** Why the card cannot proceed, shown on the board instead of silence. */
  blockedReason?: string;
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
