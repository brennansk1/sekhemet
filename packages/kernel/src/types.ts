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
  | "memory_pressure"
  | "quota_suspended"
  /** The agent declared the work done, but the gates could not run to confirm it. */
  | "done_pending_gates"
  /** The agent kept trying to write outside its declared scope. */
  | "scope_violation"
  /** The repair ladder ran out after a re-plan: beyond this model on this card. */
  | "capability_ceiling"
  /** A person stopped the card. */
  | "human_abort"
  /** The card's token budget (`tokenBudget`) was spent. */
  | "token_budget_exhausted"
  /** The card's wall-clock budget (`secondsBudget`) was spent. */
  | "time_budget_exhausted"
  /** Repair rung 3: the card needs a new plan before another attempt. */
  | "replan_requested"
  /** The staged acceptance tests already pass against the untouched code. */
  | "vacuous_tests";

/** Every stop reason, for validation and exhaustive UI tables. */
export const CARD_STOP_REASONS: readonly CardStopReason[] = [
  "gate_passed",
  "budget_exhausted",
  "oscillation_detected",
  "no_progress",
  "repair_exhausted",
  "error",
  "memory_pressure",
  "quota_suspended",
  "done_pending_gates",
  "scope_violation",
  "capability_ceiling",
  "human_abort",
  "token_budget_exhausted",
  "time_budget_exhausted",
  "replan_requested",
  "vacuous_tests",
];

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

/**
 * The kinds of fact a card's dossier holds (integration review §3 item 6).
 *
 * Each role writes what it learned about a card as one of these, on the
 * hash-chained ledger, and every later attempt reads them back. Before this,
 * lessons and answers lived in in-memory maps, notes went nowhere and a
 * send-back note never reached the retry it was written for.
 */
export type DossierEntryKind =
  | "lesson"
  | "note"
  | "question"
  | "answer"
  | "research"
  | "review"
  | "send_back";

/** Ledger event type per dossier kind. */
export const DOSSIER_EVENT_TYPES: Readonly<Record<DossierEntryKind, string>> = {
  lesson: "card/lesson",
  note: "card/note",
  question: "card/question",
  answer: "card/answer",
  research: "card/research",
  review: "card/review",
  send_back: "card/send_back",
};

/** Who writes each kind unless the caller says otherwise. */
export const DOSSIER_DEFAULT_ACTORS: Readonly<Record<DossierEntryKind, string>> = {
  lesson: "worker",
  note: "worker",
  question: "worker",
  answer: "manager",
  research: "researcher",
  review: "reviewer",
  send_back: "human",
};

export interface DossierEntryInput {
  cardId: string;
  kind: DossierEntryKind;
  /** The fact itself, in plain text. Required and non-empty. */
  text: string;
  /** Overrides the kind's default actor (for example "human" answering a question). */
  actor?: string;
  /** Attempt number the entry belongs to, when known. */
  attempt?: number;
  /** For an answer: the `entryId` of the question it answers. */
  inReplyTo?: string;
  /** Research sources (URLs or file paths). */
  sources?: string[];
  /** Review verdict, for example "likely_send_back". */
  verdict?: string;
}

export interface DossierEntry {
  /** Stable id (the ledger event id), so an answer can name its question. */
  entryId: string;
  seq: number;
  cardId: string;
  kind: DossierEntryKind;
  actor: string;
  text: string;
  createdAt: string;
  attempt?: number;
  inReplyTo?: string;
  sources?: string[];
  verdict?: string;
}

/** A question with the answers addressed to it (by `inReplyTo`). */
export interface DossierThread {
  question: DossierEntry;
  answers: DossierEntry[];
}

/** Everything the team knows about one card, oldest first. */
export interface CardDossier {
  cardId: string;
  entries: DossierEntry[];
  lessons: DossierEntry[];
  notes: DossierEntry[];
  questions: DossierThread[];
  /** Answers with no matching question in this card's dossier. */
  unthreadedAnswers: DossierEntry[];
  research: DossierEntry[];
  reviews: DossierEntry[];
  sendBacks: DossierEntry[];
}
