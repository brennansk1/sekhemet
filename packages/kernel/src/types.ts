import { STOP_REASONS } from "./stop_reasons.js";

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
  | "vacuous_tests"
  /** Rebasing onto the integration branch before Verify conflicted (Y6). */
  | "rebase_conflict"
  /** The gates passed, then failed on the card rebased onto the integration branch (Y6). */
  | "integration_failed"
  /** SEC-2: the worktree preflight found git metadata the harness did not write. */
  | "git_metadata_tampered"
  /** The Worker holds that a gate, not its work, is wrong (gates M6). */
  | "gate_suspected"
  /** A staged test fails before any step, but not at an assertion (gates NEW-gates-6). */
  | "tests_not_red_for_reason"
  /** A pre-step project hook vetoed the step (worker-loop rule 32, WL-T3-4). */
  | "hook_veto"
  /** The process died mid-attempt; found on the next start (runtime RUN-9). */
  | "crashed";

/**
 * Every stop reason, for validation and exhaustive UI tables: the keys of the
 * one stop-reason table (worker-loop rule 31, WL-T3-10), so a reason cannot
 * exist without its class, parking, resumption and next action.
 */
export const CARD_STOP_REASONS: readonly CardStopReason[] = Object.keys(
  STOP_REASONS,
) as CardStopReason[];

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
  /** The project the card belongs to (K14). */
  projectId?: string;
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

// ---------------------------------------------------------------------------
// Actors (K5)
// ---------------------------------------------------------------------------

/**
 * Who may write to the ledger (K5). The design's five (`human`, `planner`,
 * `executor`, `gate`, `system`) plus the documented extensions production
 * writes: the harness process itself, the sync and GitHub adapters, the MCP
 * server, and the team roles whose dossier entries carry their own name.
 * Enforced by a CHECK on the `events` table and by `EventLog.append`.
 */
export const EVENT_ACTORS = [
  "human",
  "planner",
  "executor",
  "gate",
  "system",
  "harness",
  "sync",
  "github",
  "mcp",
  "worker",
  "manager",
  "researcher",
  "reviewer",
] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

// ---------------------------------------------------------------------------
// Run records (K16-K20): attempts, steps, gate results, evidence, decisions
// ---------------------------------------------------------------------------

export type AttemptStatus = "running" | "passed" | "failed" | "halted";

/** The repair ladder's rung an attempt ran at (design §1522-1529). */
export type RepairRung = 1 | 2 | 3 | 4;

/**
 * The tool vocabulary an attempt was given (design §1283).
 *
 * Recorded per attempt because the competence model measures the arm rather
 * than assuming it: an arm that helps a frontier model can cost a small one
 * the card, and only rows tagged with the arm that produced them can say so.
 */
export type ToolArm = "A" | "B" | "C";

export interface AttemptRecord {
  id: string;
  cardId: string;
  attemptNumber: number;
  /** Which repair rung produced this attempt; 1 is the first, unrepaired try. */
  rung: RepairRung;
  modelId: string;
  toolArm: ToolArm;
  status: AttemptStatus;
  stopReason?: CardStopReason;
  tokensUsed: number;
  secondsUsed: number;
  evidenceId?: string;
  /** The attempt this one was forked from (H18), and at which step. */
  forkedFrom?: { attemptId: string; step: number };
  /** The step a resumed attempt restarted at (H17). */
  resumedFromStep?: number;
  startedAt: string;
  completedAt?: string;
}

export interface StartAttemptInput {
  cardId: string;
  attemptNumber: number;
  modelId: string;
  /** Defaults to 1: a caller that does not run a ladder is always on its first rung. */
  rung?: RepairRung;
  /** Defaults to "A", the roster's baseline vocabulary. */
  toolArm?: ToolArm;
  forkedFrom?: { attemptId: string; step: number };
  resumedFromStep?: number;
}

export interface FinishAttemptInput {
  attemptId: string;
  status: Exclude<AttemptStatus, "running">;
  stopReason: CardStopReason;
  tokensUsed: number;
  secondsUsed: number;
  evidenceId?: string;
}

export interface StepToolCall {
  name: string;
  /** Canonical-JSON SHA-256 of the arguments. */
  argumentHash: string;
  /** What it acted on (a path, a command), clipped. */
  target?: string;
  ok?: boolean;
  summary?: string;
}

export interface StepRecord {
  id: string;
  attemptId: string;
  cardId: string;
  stepIndex: number;
  calls: StepToolCall[];
  /** The context pack (prompt) the model saw at this step (K11, K26). */
  contextPackId?: string;
  repoStateHash?: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  stopReason?: CardStopReason;
  /** The pass@k sample the step belongs to, from 1 (worker-loop WL-T3-13). */
  sample?: number;
  /** The step's phase: find, edit, verify or repair (worker-loop WL-T3-1). */
  phase?: string;
  /** Why the reply ended, as the server said (worker-loop WL-M3-4). */
  finishReason?: string;
  /** Of `completionTokens`, thinking and answer (worker-loop WL-M3-4). */
  thinkingTokens?: number;
  answerTokens?: number;
  /** Tool-call format errors in the reply (worker-loop WL-M2-5). */
  formatErrors?: number;
  /** 1 when the reply held no tool call and no attempt at one (worker-loop WL-M2-5). */
  proseOnly?: number;
  /** Prompt tokens the server served from its cache, and evaluated (models MD-M4-4). */
  cachedPromptTokens?: number;
  evaluatedPromptTokens?: number;
  /** With speculative decoding: tokens drafted and accepted (MD-M4-4). */
  draftTokens?: number;
  draftAcceptedTokens?: number;
  /** The checkpoint commit taken at this step, if one was (H18/H19). */
  gitRef?: string;
  createdAt: string;
}

export interface RecordStepInput extends Omit<StepRecord, "id" | "createdAt" | "gitRef"> {}

export interface GateResultRecord {
  id: string;
  attemptId: string;
  cardId: string;
  stepId?: string;
  gate: string;
  layer: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** Typed failures (GateFailure[]), as JSON. */
  failures: unknown[];
  createdAt: string;
}

export interface RecordGateResultInput extends Omit<GateResultRecord, "id" | "createdAt"> {}

/**
 * What the attempt established, what it did not, and what it gave up on
 * (design §1152-1156).
 *
 * The abandoned hypotheses are the half a diff cannot show: a reviewer who
 * cannot see what the Worker tried and discarded re-proposes it, and the
 * next attempt spends its budget re-discovering the same dead end.
 */
export interface EvidenceChecks {
  passedChecks: string[];
  failedChecks: string[];
  abandonedHypotheses: string[];
}

export interface EvidenceBundleRecord {
  id: string;
  cardId: string;
  attemptId: string;
  passed: boolean;
  stopReason: string;
  /** Where the full bundle lives (`.sekhemet/evidence/<id>.json`). */
  path: string;
  /** SHA-256 of the bundle file as written. */
  sha256: string;
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  /** Difftastic's view of the same change (Y8), when difftastic was available. */
  structuralDiff?: string;
  /** Each gate's verdict, keyed by gate id, so Review can be filtered by gate. */
  gateResultsSummary?: Record<string, "pass" | "fail">;
  summary?: EvidenceChecks;
  /**
   * SHA-256 over this attempt's slice of the event log (design §1157).
   *
   * A hash, not a path: a path says where a file was when the bundle was
   * written, which is no longer true once retention moves it, and it cannot
   * be checked against the ledger the bundle claims to summarise.
   */
  trajectoryRef?: string;
  createdAt: string;
}

export type DecisionStatus = "pending" | "answered" | "timed_out";

export interface DecisionRequestRecord {
  id: string;
  cardId?: string;
  /** What kind of decision: `permission` (ask tier), `escalation`, ... */
  kind: string;
  question: string;
  context: string;
  options: string[];
  recommendationIndex: number;
  status: DecisionStatus;
  selectedOptionIndex?: number;
  answeredBy?: string;
  createdAt: string;
  answeredAt?: string;
}

export interface CreateDecisionInput {
  cardId?: string;
  kind: string;
  question: string;
  context: string;
  options: string[];
  recommendationIndex?: number;
}

/** One card outcome for the competence model (K21). */
export interface CompetenceEntry {
  id: string;
  repoId: string;
  cardClass: string;
  filesTouchedCount: number;
  difficulty: string;
  modelId: string;
  toolArm: string;
  stepBudget: number;
  stepsUsed: number;
  stopReason: string;
  passed: boolean;
  tokensUsed: number;
  wallClockSeconds: number;
  recordedAt: string;
}

export interface RecordCompetenceInput extends Omit<CompetenceEntry, "id" | "recordedAt"> {}

/** Measured pass rates for a card class on this repo, for budgets and routing (K21, L21). */
export interface CompetenceSummary {
  cardClass: string;
  modelId?: string;
  attempts: number;
  passed: number;
  passRate: number;
  /** Steps a passing attempt used, 80th percentile; undefined without passes. */
  stepsP80?: number;
  /** Median tokens of passing attempts. */
  tokensMedian?: number;
}

// ---------------------------------------------------------------------------
// Projects (K14, B8, B13)
// ---------------------------------------------------------------------------

export type ProjectStatus = "active" | "paused" | "archived";

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  gitBranch: string;
  status: ProjectStatus;
  reviewMinutesPerDay: number;
  createdAt: string;
  updatedAt: string;
}
