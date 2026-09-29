import type { CardChange, CardKind, CardSplit } from "./card_class.js";
import { STOP_REASONS } from "./stop_reasons.js";
import type { TomlTable } from "./toml.js";

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

/** `unavailable`: a gate could not run and gave no verdict (gates rule 9), never `fail`. */
export type GateStatus = "pass" | "fail" | "partial" | "unavailable" | "suspended-quota";

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
  /** A person paused the card to steer it; it resumes when they hand it back (WL-N10-2). */
  | "paused"
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
  /** A characterize, refactor or upgrade card's tests fail on the base, before any step (gates rule 6b). */
  | "base_not_green"
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

/**
 * Link to the card's origin in an external tracker (design §327): a synced
 * GitHub or Forgejo issue, or a Jira or Linear row by its key (INT-27; `url`
 * empty when the export has none).
 */
export interface ExternalRef {
  system: "github" | "forgejo" | "jira" | "linear";
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
  /** The chain formula this row was written under (3 from v3; absent for earlier rows). */
  hashVersion?: number;
  /** The person the event acts for: an opaque `p_…` id (kernel rule 19, NEW-kernel-2). */
  principal?: string;
  /** The person whose work the Worker carried out (NEW-kernel-10). */
  onBehalfOf?: string;
  /** SHA-256(salt ‖ canonical(private)), in the chain (rule 33). */
  commitment?: string;
  /**
   * The private part (rule 33). After an erasure every erased field reads as
   * `ERASED_MARKER` and `erasedBySeq` names the `ledger/erased` event.
   */
  private?: Record<string, unknown>;
  erasedBySeq?: number;
}

export interface AppendEventParams<T = unknown> {
  id?: string;
  actor: string;
  type: string;
  payload: T;
  cardId?: string;
  attemptId?: string;
  stepId?: string;
  /** Required for actor `human` (and `mcp`); resolved to the install's person on a solo install. */
  principal?: string;
  /** Only on an event the Worker writes (NEW-kernel-10). */
  onBehalfOf?: string;
  /** Personal data, free text, secret-bearing fields: stored off the chain, erasable (rule 33). */
  private?: Record<string, unknown>;
}

/** What a read shows in place of an erased private field (rule 34, K-N7-3). */
export const ERASED_MARKER = "[erased]";

/** One event whose private part a recorded erasure removed (K-N7-2). */
export interface ErasedEventReport {
  seq: number;
  erasedBySeq: number;
  /** "erased at seq N by `ledger/erased` seq M". */
  message: string;
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
  /** Points, one of `CARD_ESTIMATES` (1, 2, 3, 5, 8): Jira story points, Linear estimate (PM-N1-1). */
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
  /** What kind of work it is, stored once at creation and never re-derived (NEW-kernel-9). */
  kind?: CardKind;
  /** What the change does to behaviour; `feature` by default (NEW-kernel-9). */
  change?: CardChange;
  /** The SPIDR split that produced it; for display and export only (K-N9-4). */
  split?: CardSplit;
  /** The principal responsible for the card; the board's Assignee filter (rule 21, NEW-kernel-6). */
  owner?: string;
  /** Who builds it: the Worker, a person, or no one yet (rule 21). */
  delegate?: CardDelegate;
  /** The principal who accepted it; empty until then (rule 21, K-N6-3). */
  accepter?: string;
  /** A typed hold that keeps the card in its state (rule 24, NEW-kernel-3). */
  hold?: CardHold;
  /**
   * The card's layer of the configuration (surface item 21, SUR-40): sections
   * of `config.toml`, applied to this card's run between the project layer
   * and the command line.
   */
  configOverrides?: CardConfigOverrides;
  /**
   * Base tests whose behaviour this card changes, as `file > name` (or a
   * whole file): the regression gate accepts their failure once the card's
   * new versions are staged (gates rule 25a, planner-pm PM-N6-3).
   */
  supersedes?: string[];
  /**
   * What the card declares to its gates beyond its tests: DOM assertions and
   * intended overlaps for the visual gate, a refactor's declared surface
   * change, an upgrade's kept tests (gates rules 29, 6b; GT-N4-4, GT-N4-6,
   * GT-TQ-8, GT-TQ-11).
   */
  gateChecks?: CardGateChecks;
  /**
   * Re-splits of one lineage that produced it: 1 for a split's child, 2 for
   * a child of that child's split (planner-pm §2.5, PM-P1-13). Not nesting:
   * split children are siblings.
   */
  splitDepth?: number;
  /** The symbols its staged acceptance test imports, with file and signature (PM-P1-15). */
  interface?: CardInterfaceSymbol[];
  /**
   * The stable id of each of `acceptanceCriteria`, in the same order (PM-P1-17):
   * what a staged test case names and an approval is bound to.
   */
  criterionIds?: string[];
}

/** One symbol a card's staged acceptance test imports (planner-pm §2.1.6, PM-P1-15). */
export interface CardInterfaceSymbol {
  symbol: string;
  /** Repository-relative path of the file that exports it. */
  file: string;
  /** Its expected signature, as the test uses it. */
  signature: string;
}

/** The points a card's `estimate` may hold (planner-pm §2.6, PM-N1-1; PM_CONTRACT §2). */
export const CARD_ESTIMATES: readonly number[] = [1, 2, 3, 5, 8];

/**
 * The closest `CARD_ESTIMATES` value to an imported or dictated number
 * (PM_CONTRACT §2): a Jira card of 13 points, or any other estimate scale,
 * still creates a card rather than failing the kernel's check. Ties round
 * up (13 is nearer 8 than a bigger scale would suggest for most trackers,
 * but a genuine tie — e.g. 6.5 between 5 and 8 — takes the larger, so a
 * bigger import is never quietly shrunk past its nearer neighbour).
 */
export function nearestCardEstimate(n: number): number {
  if (!Number.isFinite(n)) return CARD_ESTIMATES[0] as number;
  return CARD_ESTIMATES.reduce((best, v) =>
    Math.abs(v - n) < Math.abs(best - n) || (Math.abs(v - n) === Math.abs(best - n) && v > best)
      ? v
      : best,
  ) as number;
}

/**
 * Why a card waits on another (planner-pm NEW-planner-pm-8, PM-N8-2):
 * `declared` in its `dependsOn`, `named` by its spec, criteria or tests,
 * `imported` by its scope (the source index); `inferred` and `planner` are
 * the reasons recorded before PM-N8-2.
 */
export type DependencySource = "declared" | "named" | "imported" | "inferred" | "planner";

export const DEPENDENCY_SOURCES: readonly DependencySource[] = [
  "declared",
  "named",
  "imported",
  "inferred",
  "planner",
];

/** A card's edge to a card it waits on, with why (PM-N8-2). */
export interface DependencyReason {
  dependsOnId: string;
  source: DependencySource;
}

/** A DOM assertion a card declares for the visual gate (GT-N4-6). */
export interface CardDomAssertion {
  selector: string;
  /** Default true: the element is present. */
  present?: boolean;
  text?: string;
  attribute?: string;
  value?: string;
}

/** A card's declarations to its gates (`CardRecord.gateChecks`). */
export interface CardGateChecks {
  /** DOM assertions the visual gate checks with the project's (GT-N4-6). */
  visualAssertions?: CardDomAssertion[];
  /** Selector pairs whose overlap the card intends (GT-N4-4). */
  allowOverlap?: [string, string][];
  /** A refactor that changes its scope's exported surface on purpose (GT-TQ-8). */
  surfaceChange?: boolean;
  /** The tests an upgrade must keep passing, `file > name` (GT-TQ-11). */
  keptTests?: string[];
}

/** A card's configuration overrides: `config.toml` sections, each a table (SUR-40). */
export type CardConfigOverrides = { [section: string]: TomlTable };

/** Who builds a card (rule 21): the Worker, or a person named by principal. */
export interface CardDelegate {
  kind: "worker" | "person";
  /** The person's principal; absent for the Worker. */
  id?: string;
}

/** Who built an attempt (K-N6-4): a person's attempt never counts toward a model's record. */
export interface BuiltBy {
  kind: "worker" | "person";
  /** The model id for the Worker, the principal for a person. */
  id: string;
}

/**
 * A hold (rule 24): not a state — the card keeps its state and waits.
 * `backpressure` waits for the named state; `awaitingMerge` is a card a person
 * accepted whose pull request is still open.
 */
export type CardHold =
  | { kind: "backpressure"; awaiting: CardStatus; reason: string; since: string }
  | {
      kind: "awaitingMerge";
      pr: number;
      url?: string;
      headSha?: string;
      since: string;
      /**
       * Teams TEAM-24: new commits dismissed the accept; the pull request is
       * still open, `headSha` is its new head, and the issue waits for a new
       * decision — counted in Review's WIP again.
       */
      dismissed?: true;
    };

export interface CheckpointRecord {
  cardId: string;
  step: number;
  gitRef: string;
  gateStatus: GateStatus;
  agentModel: string;
  agentHarness: string;
  agentRole: AgentRole;
  createdAt: string;
  /** Who built the step (K-N6-4); the Worker running `agentModel` when omitted. */
  builtBy?: BuiltBy;
}

export interface HashChainVerificationResult {
  valid: boolean;
  totalEvents: number;
  corruptedSeq?: number;
  reason?: string;
  /** How many rows this pass re-hashed (incremental verification, K-N1-3). */
  hashedEvents?: number;
  /** Events whose private part a recorded erasure removed, never reported as corrupt (K-N7-2). */
  erased?: ErasedEventReport[];
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
  /** The model that wrote a review entry (review-git RG-P8-12); only a review entry names one. */
  modelId?: string;
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
  modelId?: string;
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
  /** Who built it (K-N6-4): the Worker unless a person did. */
  builtBy?: BuiltBy;
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
  /** Who builds it (K-N6-4); the Worker running `modelId` when omitted. */
  builtBy?: BuiltBy;
}

/** The model role an attempt ran under (worker-loop rule 39); the Worker unless escalated. */
export type AttemptRole = "worker" | "escalation";

export const ATTEMPT_ROLES: readonly AttemptRole[] = ["worker", "escalation"];

/**
 * The close of an attempt (worker-loop rule 39, WL-N5-1). Everything past
 * `evidenceId` is optional for the caller: the `attempt/finished` event is
 * written self-contained, with the started record's values (attempt number,
 * model, arm, `builtBy`) and explicit defaults filled in, so a reader never
 * needs another store.
 */
export interface FinishAttemptInput {
  attemptId: string;
  status: Exclude<AttemptStatus, "running">;
  stopReason: CardStopReason;
  tokensUsed: number;
  secondsUsed: number;
  evidenceId?: string;
  /** The highest rung the attempt reached; the started rung when omitted. */
  rung?: RepairRung;
  /** The arm the steps were sent in; the started arm when omitted. */
  toolArm?: ToolArm;
  /** Defaults to `worker`. */
  role?: AttemptRole;
  /** Playbook rules that reached the attempt's prompt. */
  ruleIds?: string[];
  /** Rules whose scope matched but were withheld by rotation (context CX-N4-6). */
  withheldRuleIds?: string[];
  /** Exemplars in the prompt, by their source card id. */
  exemplarIds?: string[];
  /** Who built it; the started record's when omitted. */
  builtBy?: BuiltBy;
  /** Steps taken. */
  steps?: number;
  /** The card class, `kind:ext` (models rule 31). */
  cardClass?: string;
  /** The project the card belongs to, for grouping comparable cards. */
  projectId?: string;
  /** The change's size, from the evidence (capability report's size curve). */
  linesAdded?: number;
  /** The `card/repair_plan` dossier entry the attempt ran under (WL-N5-7). */
  repairPlanId?: string;
}

/**
 * One attempt's outcome, read from its `attempt/finished` record alone
 * (WL-N5-2): the capability report, the PM's Worker record, `tune`, rule
 * credit and competence all read this and nothing else.
 */
export interface AttemptOutcome {
  seq: number;
  attemptId: string;
  cardId: string;
  attemptNumber: number;
  rung: RepairRung;
  toolArm: ToolArm;
  role: AttemptRole;
  modelId: string;
  status: Exclude<AttemptStatus, "running">;
  passed: boolean;
  stopReason: CardStopReason;
  steps?: number;
  tokensUsed: number;
  secondsUsed: number;
  ruleIds: string[];
  withheldRuleIds: string[];
  exemplarIds: string[];
  builtBy: BuiltBy;
  cardClass?: string;
  projectId?: string;
  linesAdded?: number;
  repairPlanId?: string;
  evidenceId?: string;
  completedAt: string;
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
  /** Where the result came from (K-N8-3): a local run, or an external CI system. */
  source: "local" | "external";
  /** An external result's origin (K-N8-3). */
  externalRef?: GateResultExternalRef;
  createdAt: string;
}

/** Where an external gate result came from (K-N8-3). */
export interface GateResultExternalRef {
  system: string;
  checkName: string;
  runUrl: string;
  headSha: string;
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
  /** When the answer reached the card that asked (planner-pm PM-P2-7), from `decision/delivered`. */
  deliveredAt?: string;
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

/** The stored statuses a person sets; `idle` and `done` are derived (rule 30). */
export const PROJECT_STATUSES: readonly ProjectStatus[] = ["active", "paused", "archived"];

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
