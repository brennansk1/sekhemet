import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { assigneeTarget } from "./assignee.js";
import { RequirementCandidateLedger } from "./candidates.js";
import {
  CARD_CHANGES,
  CARD_SPLITS,
  type CardChange,
  type CardKind,
  type CardSplit,
  deriveCardKind,
  isCardKind,
  spidrSplit,
} from "./card_class.js";
import {
  CARD_COLUMN_TABLE,
  type CardRow,
  cardColumnList,
  cardInsertSql,
  cardInsertValues,
  cardPatchAssignments,
} from "./card_columns.js";
import { DepthProfileLedger } from "./depth_profile.js";
import type { EventLog } from "./log.js";
import { keyBetween } from "./order_key.js";
import { ProjectDocumentLedger } from "./project_documents.js";
import { IssueReconciliationLedger } from "./reconciliation.js";
import { RunLedger } from "./records.js";
import { RequirementLedger } from "./requirements.js";
import { SliceLedger } from "./slices.js";
import { StagedTestLedger } from "./staged_tests.js";
import { DEFAULT_STEP_BUDGET } from "./stop_reasons.js";
import { SuggestionLedger } from "./suggestions.js";
import { TakeoverLedger } from "./takeover.js";
import {
  CARD_STATUSES,
  INITIAL_CARD_STATUSES,
  LEGAL_TRANSITIONS,
  StatusTransitionError,
  isCardStatus,
} from "./transitions.js";
import {
  type AppendEventParams,
  type BuiltBy,
  CARD_ESTIMATES,
  CARD_STOP_REASONS,
  type CardConfigOverrides,
  type CardDelegate,
  type CardDossier,
  type CardGateChecks,
  type CardHold,
  type CardInterfaceSymbol,
  type CardRecord,
  type CardStatus,
  type CardStopReason,
  type CardTier,
  type CheckpointRecord,
  DEPENDENCY_SOURCES,
  DOSSIER_DEFAULT_ACTORS,
  DOSSIER_EVENT_TYPES,
  type DependencyReason,
  type DependencySource,
  type DossierEntry,
  type DossierEntryInput,
  type DossierEntryKind,
  ERASED_MARKER,
  type EventRecord,
  type ExternalRef,
  type ModelRoute,
  PROJECT_STATUSES,
  type ProjectRecord,
  type ProjectStatus,
} from "./types.js";

/**
 * Card nesting under a project (K13): the design's four levels are workspace,
 * project, card and subtask, so a card may have a parent card but a subtask
 * may not have children. Deeper nesting is rejected at creation.
 */
export const MAX_CARD_DEPTH = 2;

/** Projects that may be active at once (B13, design: workspace cap, default 3). */
export const DEFAULT_ACTIVE_PROJECT_CAP = 3;

/** A structural rule the store refuses to break (hierarchy, dependency cycle, project cap). */
export class CardStructureError extends Error {
  constructor(
    public readonly code: "hierarchy_depth" | "dependency_cycle" | "unknown_card" | "project_cap",
    message: string,
    public readonly path?: string[],
  ) {
    super(message);
    this.name = "CardStructureError";
  }
}

/** Longest dossier text kept; longer text is cut with a marker, never silently. */
export const MAX_DOSSIER_TEXT = 8000;

/**
 * A research answer is kept whole (design-stage DS-N5-3): the Planner reads
 * it before a repair. This bound only guards the ledger against a runaway
 * writer; no answer a model writes comes near it.
 */
export const MAX_RESEARCH_DOSSIER_TEXT = 200_000;

const KIND_BY_EVENT_TYPE = new Map<string, DossierEntryKind>(
  (Object.entries(DOSSIER_EVENT_TYPES) as [DossierEntryKind, string][]).map(([k, t]) => [t, k]),
);

interface DossierPayload {
  kind: DossierEntryKind;
  text: string;
  attempt?: number;
  inReplyTo?: string;
  sources?: string[];
  verdict?: string;
  modelId?: string;
}

export interface CreateCardInput {
  id?: string;
  tier: CardTier;
  parentId?: string | null;
  title: string;
  status?: CardStatus;
  scopeFiles?: string[];
  stepBudget?: number;

  /** What the card is supposed to do — the executor's brief (design §305). */
  spec?: string;
  acceptanceCriteria?: string[];
  acceptanceTests?: string[];
  /** Planner-assigned 1..10; the CHECK constraint rejects anything else. */
  difficulty?: number;
  tokenBudget?: number;
  secondsBudget?: number;
  modelRoute?: ModelRoute;
  dependsOn?: string[];
  contextPackId?: string;
  evidenceId?: string;
  externalRef?: ExternalRef;
  /** Team priority, 0 none, 1 urgent .. 4 low. */
  priority?: number;
  estimate?: number;
  labels?: string[];
  epicId?: string;
  cycleId?: string;
  assignee?: string;
  dueDate?: string;
  /** Explicit placement; generated after the last card when omitted. */
  orderKey?: string;
  blockedReason?: string;
  /** The project the card belongs to (K14); the default project when omitted. */
  projectId?: string;
  /** What kind of work it is; derived once, here, when omitted (K-N9-1). */
  kind?: CardKind;
  /** What the change does to behaviour; `feature` when omitted (K-N9-3). */
  change?: CardChange;
  /** The SPIDR split; from the title's SPIDR marker when omitted (K-N9-3). */
  split?: CardSplit | null;
  /** The principal responsible for the card (K-N6-1). */
  owner?: string;
  /** Who builds it: the Worker, a person, or none (K-N6-1). */
  delegate?: CardDelegate | null;
  /** The card's layer of the configuration (SUR-40). */
  configOverrides?: CardConfigOverrides;
  /** Base tests whose behaviour this card changes, as `file > name` (gates rule 25a). */
  supersedes?: string[];
  /** What the card declares to its gates (GT-N4-4, GT-N4-6, GT-TQ-8, GT-TQ-11). */
  gateChecks?: CardGateChecks;
  /** Re-splits of its lineage, 1 for a split's child (PM-P1-13). */
  splitDepth?: number;
  /** The symbols its staged acceptance test imports (PM-P1-15). */
  interface?: CardInterfaceSymbol[];
  /** One stable id per acceptance criterion, in order (PM-P1-17). */
  criterionIds?: string[];
}

/**
 * Mutable card fields.
 *
 * `status` is deliberately absent: a column move must go through
 * `updateCardStatus` (and above it, the board's legal-transition table), or the
 * state machine can be bypassed by writing the column directly.
 */
export interface CardUpdate {
  title?: string;
  scopeFiles?: string[];
  stepBudget?: number;
  stepsUsed?: number;
  spec?: string;
  acceptanceCriteria?: string[];
  acceptanceTests?: string[];
  difficulty?: number;
  tokenBudget?: number;
  secondsBudget?: number;
  tokensUsed?: number;
  secondsUsed?: number;
  modelRoute?: ModelRoute;
  dependsOn?: string[];
  contextPackId?: string;
  evidenceId?: string;
  externalRef?: ExternalRef;
  stopReason?: CardStopReason;
  priority?: number;
  /** `null` clears the field. */
  estimate?: number | null;
  labels?: string[];
  epicId?: string | null;
  cycleId?: string | null;
  assignee?: string | null;
  dueDate?: string | null;
  orderKey?: string;
  /** `null` clears the block. */
  blockedReason?: string | null;
  projectId?: string;
  /**
   * The stored kind and change (K-N9-2): changed only by a named principal,
   * never while the card is In Progress or in Verify.
   */
  kind?: CardKind;
  change?: CardChange;
  /** The card's layer of the configuration (SUR-40); `null` clears it. */
  configOverrides?: CardConfigOverrides | null;
  /** The base tests this card supersedes (gates rule 25a); `null` clears them. */
  supersedes?: string[] | null;
  /** What the card declares to its gates; `null` clears it. */
  gateChecks?: CardGateChecks | null;
  /** `null` clears each of these (PM-P1-13, PM-P1-15, PM-P1-17). */
  splitDepth?: number | null;
  interface?: CardInterfaceSymbol[] | null;
  /** Must stay one per criterion: patched with `acceptanceCriteria` when their count changes. */
  criterionIds?: string[] | null;
}

/** A criterion id: tag-safe, so a test title can carry it (PM-P1-17). */
const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A card's acceptance criteria with their stable ids; none when it has no ids (PM-P1-17). */
export function cardCriteria(
  card: Pick<CardRecord, "acceptanceCriteria" | "criterionIds">,
): { id: string; text: string }[] {
  const ids = card.criterionIds ?? [];
  return ids.map((id, i) => ({ id, text: card.acceptanceCriteria?.[i] ?? "" }));
}

/** What is wrong with a card's criteria and their ids together, or undefined (PM-P1-17). */
function criterionIdsProblem(
  criteria: readonly string[] | undefined,
  ids: readonly string[] | null | undefined,
): string | undefined {
  if (ids === undefined || ids === null) return undefined;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && CRITERION_ID.test(x))) {
    return "must be a list of ids of letters, digits, '.', '_' or '-'";
  }
  if (new Set(ids).size !== ids.length) return "must not repeat an id";
  const n = criteria?.length ?? 0;
  if (ids.length !== n) {
    return `must hold one id per acceptance criterion (${n} criteria, ${ids.length} ids)`;
  }
  return undefined;
}

/** What is wrong with an `interface` value, or undefined (PM-P1-15). */
function interfaceProblem(v: unknown): string | undefined {
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  if (
    !Array.isArray(v) ||
    !v.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        str((e as CardInterfaceSymbol).symbol) &&
        str((e as CardInterfaceSymbol).file) &&
        typeof (e as CardInterfaceSymbol).signature === "string" &&
        Object.keys(e).every((k) => ["symbol", "file", "signature"].includes(k)),
    )
  ) {
    return "must be a list of {symbol, file, signature}";
  }
  return undefined;
}

/**
 * The fields a card write validates before anything is appended (S7, rule
 * 13): a value the projection would refuse must never reach the ledger,
 * where it would make every later replay throw.
 */
const CARD_TIERS: readonly CardTier[] = ["initiative", "epic", "feature", "story", "task"];

/** What is wrong with a `gateChecks` value, or undefined when it has the declared shape. */
function gateChecksProblem(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "must be a table";
  const g = v as Record<string, unknown>;
  const known = ["visualAssertions", "allowOverlap", "surfaceChange", "keptTests"];
  const extra = Object.keys(g).filter((k) => !known.includes(k));
  if (extra.length > 0) return `has unknown field(s) ${extra.join(", ")}`;
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  if (
    g.visualAssertions !== undefined &&
    !(
      Array.isArray(g.visualAssertions) &&
      g.visualAssertions.every(
        (a) =>
          typeof a === "object" &&
          a !== null &&
          str((a as { selector?: unknown }).selector) &&
          ["present", "text", "attribute", "value"].every((k) => {
            const x = (a as Record<string, unknown>)[k];
            return (
              x === undefined || (k === "present" ? typeof x === "boolean" : typeof x === "string")
            );
          }),
      )
    )
  ) {
    return "visualAssertions must be a list of {selector, present?, text?, attribute?, value?}";
  }
  if (
    g.allowOverlap !== undefined &&
    !(
      Array.isArray(g.allowOverlap) &&
      g.allowOverlap.every((p) => Array.isArray(p) && p.length === 2 && p.every(str))
    )
  ) {
    return "allowOverlap must be a list of selector pairs";
  }
  if (g.surfaceChange !== undefined && typeof g.surfaceChange !== "boolean") {
    return "surfaceChange must be true or false";
  }
  if (g.keptTests !== undefined && !(Array.isArray(g.keptTests) && g.keptTests.every(str))) {
    return "keptTests must be a list of test names";
  }
  return undefined;
}

function validateCardFields(
  id: string,
  fields: {
    difficulty?: number | null | undefined;
    status?: unknown;
    tier?: unknown;
    kind?: unknown;
    change?: unknown;
    split?: unknown;
    delegate?: unknown;
    configOverrides?: unknown;
    gateChecks?: unknown;
    estimate?: number | null | undefined;
    splitDepth?: number | null | undefined;
    interface?: unknown;
  },
): void {
  const e = fields.estimate;
  if (e !== undefined && e !== null && !CARD_ESTIMATES.includes(e)) {
    throw new Error(
      `Card ${id}: estimate must be one of ${CARD_ESTIMATES.join(", ")} points, got ${e}`,
    );
  }
  const depth = fields.splitDepth;
  if (depth !== undefined && depth !== null && !(Number.isInteger(depth) && depth >= 1)) {
    throw new Error(`Card ${id}: splitDepth must be a whole number from 1, got ${depth}`);
  }
  if (fields.interface !== undefined && fields.interface !== null) {
    const why = interfaceProblem(fields.interface);
    if (why) throw new Error(`Card ${id}: interface ${why}`);
  }
  if (fields.gateChecks !== undefined && fields.gateChecks !== null) {
    const why = gateChecksProblem(fields.gateChecks);
    if (why) throw new Error(`Card ${id}: gateChecks ${why}`);
  }
  const o = fields.configOverrides;
  if (o !== undefined && o !== null) {
    const table = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
    if (!table(o) || !Object.values(o as object).every(table)) {
      throw new Error(
        `Card ${id}: configOverrides is a table of config.toml sections, each a table, got ${JSON.stringify(o)}`,
      );
    }
  }
  const d = fields.difficulty;
  if (d !== undefined && d !== null && !(Number.isInteger(d) && d >= 1 && d <= 10)) {
    throw new Error(`Card ${id}: difficulty must be an integer from 1 to 10, got ${d}`);
  }
  if (fields.status !== undefined && !isCardStatus(fields.status)) {
    throw new Error(
      `Card ${id}: '${String(fields.status)}' is not one of the nine card states (${CARD_STATUSES.join(", ")})`,
    );
  }
  if (fields.kind !== undefined && !isCardKind(fields.kind)) {
    throw new Error(
      `Card ${id}: kind must be one of the seven card kinds, got ${String(fields.kind)}`,
    );
  }
  if (
    fields.change !== undefined &&
    !(CARD_CHANGES as readonly unknown[]).includes(fields.change)
  ) {
    throw new Error(
      `Card ${id}: change must be one of ${CARD_CHANGES.join(", ")}, got ${String(fields.change)}`,
    );
  }
  if (
    fields.split !== undefined &&
    fields.split !== null &&
    !(CARD_SPLITS as readonly unknown[]).includes(fields.split)
  ) {
    throw new Error(
      `Card ${id}: split must be one of ${CARD_SPLITS.join(", ")} or none, got ${String(fields.split)}`,
    );
  }
  if (fields.delegate !== undefined && fields.delegate !== null) {
    const d = fields.delegate as { kind?: unknown; id?: unknown };
    if (typeof d !== "object" || (d.kind !== "worker" && d.kind !== "person")) {
      throw new Error(
        `Card ${id}: a delegate is {kind: "worker" | "person"} or none, got ${JSON.stringify(fields.delegate)}`,
      );
    }
    if (d.kind === "person" && (typeof d.id !== "string" || !d.id)) {
      throw new Error(`Card ${id}: a person delegate names the person's principal`);
    }
  }
  if (fields.tier !== undefined && !(CARD_TIERS as readonly unknown[]).includes(fields.tier)) {
    throw new Error(
      `Card ${id}: tier must be one of ${CARD_TIERS.join(", ")}, got ${String(fields.tier)}`,
    );
  }
}

/** Where a dragged card lands, expressed as its new neighbours. */
export interface CardPosition {
  /** Card it should follow; `null`/omitted means "top of the column". */
  afterCardId?: string | null;
  /** Card it should precede; `null`/omitted means "bottom of the column". */
  beforeCardId?: string | null;
}

type SqlParam = string | number | null;

/** The column list, row type, insert and update all come from the one table (K-N4-4). */
const CARD_COLUMNS = cardColumnList();

type RawCardRow = CardRow;

interface RawCheckpointRow {
  card_id: string;
  step: number;
  git_ref: string;
  gate_status: string;
  agent_model: string;
  agent_harness: string;
  agent_role: string;
  created_at: string;
  built_by: string | null;
}

/** Array/object fields are JSON-encoded; a malformed cell must not crash a read. */
function parseJsonColumn<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class CardStore {
  /** Attempts, steps, gate results, evidence, decisions, competence (K16-K21). */
  public readonly runs: RunLedger;
  /** Versioned requirements and their suspect links (NEW-kernel-8). */
  public readonly requirements: RequirementLedger;
  /** Release slices, appetite, cuts and proposed releases (planner-pm P13). */
  public readonly slices: SliceLedger;
  /** Staged tests with their criterion ids, and approvals bound to content (PM-P1-17, PM-N7-3). */
  public readonly stagedTests: StagedTestLedger;
  /** Seshat's suggestions on an issue (TEAM-18, TEAM-19, PM-N9-1). */
  public readonly suggestions: SuggestionLedger;
  /** The project's depth profile, chosen by a person (design-stage DS-P14-1, -2, -3). */
  public readonly depthProfiles: DepthProfileLedger;
  /** Candidate requirements and the story map's walkthroughs (DS-P14-5, -6, -7). */
  public readonly candidates: RequirementCandidateLedger;
  /** A take-over's brief as found, questions, backlog and approval (DS-TO-9, -11, -12, -14). */
  public readonly takeover: TakeoverLedger;
  /** Inherited issues reconciled against the code (integrations INT-42, -43, -44). */
  public readonly reconciliation: IssueReconciliationLedger;
  /** Project documents' exports and import proposals (design-stage NEW-design-stage-3). */
  public readonly documents: ProjectDocumentLedger;
  /** Active projects allowed at once (B13). */
  public activeProjectCap = DEFAULT_ACTIVE_PROJECT_CAP;

  constructor(
    private db: DatabaseSync,
    private eventLog: EventLog,
  ) {
    this.runs = new RunLedger(db, eventLog);
    this.requirements = new RequirementLedger(db, eventLog);
    this.slices = new SliceLedger(db, eventLog, this.requirements);
    this.stagedTests = new StagedTestLedger(db, eventLog);
    this.suggestions = new SuggestionLedger(db, eventLog);
    this.depthProfiles = new DepthProfileLedger(db, eventLog, this.requirements);
    this.candidates = new RequirementCandidateLedger(db, eventLog, this.requirements);
    this.takeover = new TakeoverLedger(db, eventLog, this.runs, this.requirements, this.candidates);
    this.reconciliation = new IssueReconciliationLedger(db, eventLog);
    this.documents = new ProjectDocumentLedger(db, eventLog);
  }

  /** The oldest active project, which cards created without one belong to. */
  private defaultProjectId(): string | null {
    const row = this.db
      .prepare(
        "SELECT id FROM projects WHERE status = 'active' ORDER BY created_at ASC, rowid ASC LIMIT 1",
      )
      .get() as { id?: string } | undefined;
    return row?.id ?? null;
  }

  /** Nesting depth of a card: 1 for a top-level card, 2 for a subtask. */
  private depthOf(id: string): number {
    let depth = 0;
    let current: string | null = id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      depth++;
      const row = this.db.prepare("SELECT parent_id FROM cards WHERE id = ?").get(current) as
        | { parent_id: string | null }
        | undefined;
      current = row?.parent_id ?? null;
    }
    return depth;
  }

  private mapCardRow(r: RawCardRow): CardRecord {
    // SQLite returns each column as its stored value; the table types them all
    // as `CardSqlValue`, and this is where each is read as the field it is.
    const row = r as unknown as {
      [K in keyof RawCardRow]: K extends
        | "step_budget"
        | "steps_used"
        | "tokens_used"
        | "seconds_used"
        | "priority"
        ? number
        : K extends "difficulty" | "token_budget" | "seconds_budget" | "estimate" | "split_depth"
          ? number | null
          : K extends
                | "id"
                | "title"
                | "scope_files"
                | "acceptance_criteria"
                | "acceptance_tests"
                | "depends_on"
                | "order_key"
                | "created_at"
                | "updated_at"
            ? string
            : string | null;
    };
    const modelRoute: ModelRoute = {
      ...(row.model_route_planner ? { planner: row.model_route_planner } : {}),
      ...(row.model_route_executor ? { executor: row.model_route_executor } : {}),
    };
    const externalRef = row.external_ref
      ? parseJsonColumn<ExternalRef | null>(row.external_ref, null)
      : null;

    return {
      id: row.id,
      tier: row.tier as CardTier,
      parentId: row.parent_id,
      title: row.title,
      status: row.status as CardStatus,
      scopeFiles: parseJsonColumn<string[]>(row.scope_files, []),
      stepBudget: row.step_budget,
      stepsUsed: row.steps_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acceptanceCriteria: parseJsonColumn<string[]>(row.acceptance_criteria, []),
      acceptanceTests: parseJsonColumn<string[]>(row.acceptance_tests, []),
      dependsOn: parseJsonColumn<string[]>(row.depends_on, []),
      tokensUsed: row.tokens_used,
      secondsUsed: row.seconds_used,
      priority: row.priority,
      orderKey: row.order_key,
      // `exactOptionalPropertyTypes` is on: an absent column must leave the
      // property absent, never set it to undefined.
      ...(row.spec !== null ? { spec: row.spec } : {}),
      ...(row.difficulty !== null ? { difficulty: row.difficulty } : {}),
      ...(row.token_budget !== null ? { tokenBudget: row.token_budget } : {}),
      ...(row.seconds_budget !== null ? { secondsBudget: row.seconds_budget } : {}),
      ...(Object.keys(modelRoute).length > 0 ? { modelRoute } : {}),
      ...(row.context_pack_id !== null ? { contextPackId: row.context_pack_id } : {}),
      ...(row.evidence_id !== null ? { evidenceId: row.evidence_id } : {}),
      ...(externalRef ? { externalRef } : {}),
      ...(row.stop_reason !== null ? { stopReason: row.stop_reason as CardStopReason } : {}),
      ...(row.blocked_reason !== null ? { blockedReason: row.blocked_reason } : {}),
      labels: parseJsonColumn<string[]>(row.labels, []),
      ...(row.estimate !== null ? { estimate: row.estimate } : {}),
      ...(row.epic_id !== null ? { epicId: row.epic_id } : {}),
      ...(row.cycle_id !== null ? { cycleId: row.cycle_id } : {}),
      ...(this.assigneeOf(row) ? { assignee: this.assigneeOf(row) as string } : {}),
      ...(row.due_date !== null ? { dueDate: row.due_date } : {}),
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
      kind: row.kind as CardKind,
      change: row.change as CardChange,
      ...(row.split !== null ? { split: row.split as CardSplit } : {}),
      ...(row.owner !== null ? { owner: row.owner } : {}),
      ...(row.delegate !== null
        ? { delegate: parseJsonColumn<CardDelegate>(row.delegate, { kind: "worker" }) }
        : {}),
      ...(row.accepter !== null ? { accepter: row.accepter } : {}),
      ...(row.hold !== null ? { hold: parseJsonColumn<CardHold>(row.hold, null as never) } : {}),
      ...(row.config_overrides !== null
        ? {
            configOverrides: parseJsonColumn<CardConfigOverrides>(
              row.config_overrides,
              null as never,
            ),
          }
        : {}),
      ...(row.supersedes !== null && row.supersedes !== undefined
        ? { supersedes: parseJsonColumn<string[]>(row.supersedes, []) }
        : {}),
      ...(row.gate_checks !== null && row.gate_checks !== undefined
        ? { gateChecks: parseJsonColumn<CardGateChecks>(row.gate_checks, {}) }
        : {}),
      ...(row.split_depth !== null && row.split_depth !== undefined
        ? { splitDepth: row.split_depth }
        : {}),
      ...(row.interface !== null && row.interface !== undefined
        ? { interface: parseJsonColumn<CardInterfaceSymbol[]>(row.interface, []) }
        : {}),
      ...(row.criterion_ids !== null && row.criterion_ids !== undefined
        ? { criterionIds: parseJsonColumn<string[]>(row.criterion_ids, []) }
        : {}),
    };
  }

  private mapCheckpointRow(row: RawCheckpointRow): CheckpointRecord {
    return {
      cardId: row.card_id,
      step: row.step,
      gitRef: row.git_ref,
      gateStatus: row.gate_status as CheckpointRecord["gateStatus"],
      agentModel: row.agent_model,
      agentHarness: row.agent_harness,
      agentRole: row.agent_role as CheckpointRecord["agentRole"],
      createdAt: row.created_at,
      builtBy: parseJsonColumn<BuiltBy>(row.built_by, { kind: "worker", id: row.agent_model }),
    };
  }

  /**
   * Fractional index placing a new card after every existing one.
   *
   * Appending never renumbers a sibling, so creating a card is one row write no
   * matter how large the board is.
   */
  private nextOrderKey(): string {
    const row = this.db.prepare("SELECT MAX(order_key) AS maxKey FROM cards").get() as {
      maxKey?: string | null;
    };
    const max = row?.maxKey ? row.maxKey : null;
    return keyBetween(max, null);
  }

  /** `actor` defaults to the planner; a human applying a PM proposal passes "human". */
  public async createCard(input: CreateCardInput, actor = "planner"): Promise<CardRecord> {
    const id = input.id ?? `card_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const status: CardStatus = input.status ?? "ready";
    // S7: every field the projection checks is checked here, before the append.
    validateCardFields(id, {
      difficulty: input.difficulty,
      status,
      tier: input.tier,
      kind: input.kind,
      change: input.change,
      split: input.split,
      delegate: input.delegate,
      configOverrides: input.configOverrides,
      gateChecks: input.gateChecks,
      estimate: input.estimate,
      splitDepth: input.splitDepth,
      interface: input.interface,
    });
    const idsProblem = criterionIdsProblem(input.acceptanceCriteria, input.criterionIds);
    if (idsProblem) throw new Error(`Card ${id}: criterionIds ${idsProblem}`);
    // K-S4-9: a card starts where no entry condition has been skipped —
    // parked only with its recorded reason (rule 27).
    const parkedWithReason = status === "parked" && !!input.blockedReason?.trim();
    if (!INITIAL_CARD_STATUSES.includes(status) && !parkedWithReason) {
      throw new StatusTransitionError(
        "illegal_transition",
        id,
        status,
        status === "parked"
          ? `Card ${id} cannot be created in 'parked' without a recorded reason (blockedReason)`
          : `Card ${id} cannot be created in '${status}': a card is created in ${INITIAL_CARD_STATUSES.join(", ")} (or parked with a reason) and reaches '${status}' only by a move under the transition law`,
      );
    }

    // K13: refused before anything reaches the append-only ledger.
    if (input.parentId) {
      if (!(await this.getCard(input.parentId))) {
        throw new CardStructureError(
          "unknown_card",
          `Cannot create ${id}: parent ${input.parentId} not found`,
        );
      }
      const depth = this.depthOf(input.parentId) + 1;
      if (depth > MAX_CARD_DEPTH) {
        throw new CardStructureError(
          "hierarchy_depth",
          `Cannot create ${id} under ${input.parentId}: that would nest cards ${depth} deep, and the hierarchy stops at card and subtask (workspace, project, card, subtask).`,
        );
      }
    }

    // K-N6-6: `assignee` is never written; it names the delegate or owner.
    // A person it creates is appended in the card's own transaction (K-S7-3).
    const persons: AppendEventParams<Record<string, unknown>>[] = [];
    const assigned: { owner?: string; delegate?: CardDelegate } =
      (input.assignee
        ? assigneeTarget(this.db, input.assignee, (p) => {
            persons.push(p);
          })
        : undefined) ?? {};
    // The payload is the record of truth: `rebuildProjections()` replays it, so
    // every generated value (id, order key, timestamps) must be resolved here
    // rather than at projection time, or a replay would not be byte-identical.
    const payload = {
      id,
      tier: input.tier,
      parentId: input.parentId ?? null,
      title: input.title,
      status,
      scopeFiles: input.scopeFiles ?? [],
      stepBudget: input.stepBudget ?? DEFAULT_STEP_BUDGET,
      // WL-T3-11: whether the budget was defaulted is recorded, not inferred
      // from the value — a card may set the default's value explicitly.
      ...(input.stepBudget === undefined ? { stepBudgetDefaulted: true } : {}),
      stepsUsed: 0,
      spec: input.spec ?? null,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      acceptanceTests: input.acceptanceTests ?? [],
      difficulty: input.difficulty ?? null,
      tokenBudget: input.tokenBudget ?? null,
      secondsBudget: input.secondsBudget ?? null,
      tokensUsed: 0,
      secondsUsed: 0,
      modelRoute: input.modelRoute ?? null,
      dependsOn: input.dependsOn ?? [],
      contextPackId: input.contextPackId ?? null,
      evidenceId: input.evidenceId ?? null,
      externalRef: input.externalRef ?? null,
      stopReason: null,
      priority: input.priority ?? 0,
      orderKey: input.orderKey ?? this.nextOrderKey(),
      blockedReason: input.blockedReason ?? null,
      estimate: input.estimate ?? null,
      labels: input.labels ?? [],
      epicId: input.epicId ?? null,
      cycleId: input.cycleId ?? null,
      dueDate: input.dueDate ?? null,
      projectId: input.projectId ?? this.defaultProjectId(),
      // K-N9-1, K-N9-3: resolved here, once; replay reads them as recorded.
      kind: input.kind ?? deriveCardKind(input),
      change: input.change ?? "feature",
      split: input.split === undefined ? (spidrSplit(input.title) ?? null) : input.split,
      // K-N6-1: who is on the card; a legacy `assignee` names one (K-N6-6).
      owner: input.owner ?? ("owner" in assigned ? assigned.owner : null),
      delegate: input.delegate ?? ("delegate" in assigned ? assigned.delegate : null),
      configOverrides: input.configOverrides ?? null,
      supersedes: input.supersedes ?? null,
      gateChecks: input.gateChecks ?? null,
      splitDepth: input.splitDepth ?? null,
      interface: input.interface ?? null,
      criterionIds: input.criterionIds ?? null,
      createdAt: now,
      updatedAt: now,
    };

    // Append to the hash chain and project, in one transaction (K-S7-3),
    // with any person the assignee named.
    this.eventLog.appendAllNow([
      ...persons.map((params) => ({ params })),
      {
        params: { actor, type: "card/created", cardId: id, payload },
        project: () => this.projectCardCreated(payload),
      },
    ]);

    // Declared dependencies on cards that exist become checked edges (K15).
    // A new card has no dependents yet, so these can never close a cycle.
    for (const dep of input.dependsOn ?? []) {
      if (dep !== id && (await this.getCard(dep))) {
        await this.addDependency(id, dep, "declared", actor);
      }
    }

    const card = await this.getCard(id);
    if (!card) {
      throw new Error(`Failed to create and project card ${id}`);
    }
    return card;
  }

  public async getCard(id: string): Promise<CardRecord | null> {
    const stmt = this.db.prepare(`
      SELECT ${CARD_COLUMNS}
      FROM cards
      WHERE id = ?
    `);
    const row = stmt.get(id) as unknown as RawCardRow | undefined;
    if (!row) {
      return null;
    }
    return this.mapCardRow(row);
  }

  public async listCards(filter?: {
    status?: CardStatus;
    tier?: CardTier;
    parentId?: string | null;
  }): Promise<CardRecord[]> {
    let sql = `
      SELECT ${CARD_COLUMNS}
      FROM cards
      WHERE 1=1
    `;
    const params: SqlParam[] = [];

    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.tier) {
      sql += " AND tier = ?";
      params.push(filter.tier);
    }
    if (filter?.parentId !== undefined) {
      if (filter.parentId === null) {
        sql += " AND parent_id IS NULL";
      } else {
        sql += " AND parent_id = ?";
        params.push(filter.parentId);
      }
    }

    // Manual order first, creation order as the tiebreaker for rows that
    // somehow share a key. Both are BINARY-collated text, matching
    // `compareOrderKeys` exactly.
    sql += " ORDER BY order_key ASC, created_at ASC";
    const rows = this.db.prepare(sql).all(...params) as unknown as RawCardRow[];
    return rows.map((r) => this.mapCardRow(r));
  }

  /**
   * The one method that writes a card's status: a compare-and-set under the
   * transition law (rule 26, S4). The edge is checked against the **stored**
   * status; `expectedFrom`, when given, must equal it (`stale_from`); a move
   * to the state the card is already in appends nothing. Only the board
   * passes `override`, after it recorded a person's `card/override` or the
   * harness's `card/measurement_setup` in a measured run's repository.
   *
   * `actor` names who moved the card. It defaults to the executor for the
   * runner's own transitions; a human triaging from the dashboard passes
   * "human", so the ledger does not credit the Worker with a person's verdict.
   */
  public async updateCardStatus(
    id: string,
    status: CardStatus,
    reason?: string,
    actor = "executor",
    options: {
      expectedFrom?: CardStatus;
      override?: boolean;
      principal?: string;
      /**
       * Card events committed in the same transaction as the move (kernel
       * S7; review-git §2.5.3: the move to Done and `card/accepted` together).
       */
      with?: readonly {
        type: string;
        actor: string;
        payload: unknown;
        principal?: string;
        private?: Record<string, unknown>;
      }[];
    } = {},
  ): Promise<CardRecord> {
    if (!isCardStatus(status)) {
      throw new StatusTransitionError(
        "invalid_status",
        id,
        String(status),
        `Card ${id}: '${String(status)}' is not one of the nine card states (${CARD_STATUSES.join(", ")})`,
      );
    }
    const existing = await this.getCard(id);
    if (!existing) {
      throw new StatusTransitionError("card_not_found", id, status, `Card not found: ${id}`);
    }
    if (options.expectedFrom !== undefined && options.expectedFrom !== existing.status) {
      throw new StatusTransitionError(
        "stale_from",
        id,
        status,
        `Card ${id}: the stored status is '${existing.status}', not '${options.expectedFrom}'; nothing was changed`,
      );
    }
    if (status === existing.status) return existing;
    if (!LEGAL_TRANSITIONS[existing.status].includes(status) && options.override !== true) {
      throw new StatusTransitionError(
        "illegal_transition",
        id,
        status,
        `Illegal transition '${existing.status}' -> '${status}' for card ${id}. Legal destinations: ${LEGAL_TRANSITIONS[existing.status].join(", ")}`,
      );
    }

    const now = new Date().toISOString();
    const payload = {
      id,
      fromStatus: existing.status,
      toStatus: status,
      reason,
      updatedAt: now,
    };

    // Append, then project the recorded event exactly as a replay would —
    // but live, only while the stored status is still the one checked above:
    // the compare-and-set happens under the write lock (rule 26, K-S4-8).
    const move = {
      actor,
      type: "card/status_changed",
      cardId: id,
      payload,
      ...(options.principal ? { principal: options.principal } : {}),
    };
    const project = (event: EventRecord) =>
      this.applyEvent(event, { expectedFrom: existing.status });
    if (options.with?.length) {
      this.eventLog.appendAllNow([
        { params: move, project },
        ...options.with.map((e) => ({
          params: {
            actor: e.actor,
            type: e.type,
            cardId: id,
            payload: e.payload,
            ...(e.principal ? { principal: e.principal } : {}),
            ...(e.private ? { private: e.private } : {}),
          },
          project: (event: EventRecord) => {
            this.applyEvent(event);
          },
        })),
      ]);
    } else {
      await this.eventLog.append(move, { project: (event) => project(event as EventRecord) });
    }

    const updated = await this.getCard(id);
    if (!updated) {
      throw new Error(`Card vanished after update: ${id}`);
    }
    return updated;
  }

  /**
   * Apply a partial update, recording the patch in the log first.
   *
   * The event carries only the changed fields, so a replay reconstructs the
   * same sequence of states rather than a series of full snapshots — that is
   * what makes "why does this card have a 90k token budget" answerable.
   */
  public async updateCard(
    id: string,
    given: CardUpdate,
    actor = "planner",
    options: { principal?: string } = {},
  ): Promise<CardRecord> {
    const existing = await this.getCard(id);
    if (!existing) {
      throw new Error(`Card not found: ${id}`);
    }
    // K-N6-6: `assignee` is no longer written; it names the delegate or owner.
    const { assignee, ...patch } = given;

    validateCardFields(id, {
      difficulty: patch.difficulty,
      kind: patch.kind,
      change: patch.change,
      configOverrides: patch.configOverrides,
      gateChecks: patch.gateChecks,
      estimate: patch.estimate,
      splitDepth: patch.splitDepth,
      interface: patch.interface,
    });
    // PM-P1-17: the ids stay one per criterion, whichever of the two is patched.
    if (patch.acceptanceCriteria !== undefined || patch.criterionIds !== undefined) {
      const ids = patch.criterionIds === undefined ? existing.criterionIds : patch.criterionIds;
      // PM-N7-5: a planned card's criterion ids are never cleared, so no card
      // the planner wrote can leave Planning without a person's approval.
      if ((existing.criterionIds?.length ?? 0) > 0 && (ids ?? []).length === 0) {
        throw new Error(
          `Card ${id}: its criterion ids cannot be cleared; a planned card keeps one id per criterion (PM-N7-5)`,
        );
      }
      const why = criterionIdsProblem(patch.acceptanceCriteria ?? existing.acceptanceCriteria, ids);
      if (why) throw new Error(`Card ${id}: criterionIds ${why}`);
    }
    // K-N9-2: the stored kind and change are a person's decision, named, and
    // never changed under a running attempt or its verification.
    if (patch.kind !== undefined || patch.change !== undefined) {
      if (!options.principal) {
        throw new Error(`Card ${id}: a change of kind or change names the principal who made it`);
      }
      if (existing.status === "in_progress" || existing.status === "verify") {
        throw new Error(
          `Card ${id}: its kind and change cannot change while it is ${existing.status}`,
        );
      }
    }
    if (patch.stopReason !== undefined && !CARD_STOP_REASONS.includes(patch.stopReason)) {
      throw new Error(`Unknown stop reason: ${String(patch.stopReason)}`);
    }
    for (const field of ["tokensUsed", "secondsUsed", "stepsUsed"] as const) {
      const value = patch[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        throw new Error(`${field} must be a non-negative number, got ${value}`);
      }
    }

    // A replaced dependency list is checked for cycles before it is recorded (K15).
    if (patch.dependsOn !== undefined) {
      for (const dep of patch.dependsOn) {
        const cycle = this.cyclePath(id, dep);
        if (cycle) {
          throw new CardStructureError(
            "dependency_cycle",
            `${id} cannot depend on ${dep}: ${cycle.join(" -> ")} would be a cycle`,
            cycle,
          );
        }
      }
    }

    const now = new Date().toISOString();
    const payload = { id, patch, updatedAt: now };

    if (assignee === undefined || Object.keys(patch).length > 0) {
      await this.eventLog.append(
        {
          actor,
          type: "card/updated",
          cardId: id,
          payload,
          ...(options.principal ? { principal: options.principal } : {}),
        },
        { project: () => this.projectCardUpdated(id, patch, now) },
      );
    }
    if (assignee !== undefined) await this.applyAssignee(existing, assignee, actor, options);

    // A replaced dependency list replaces the checked edges too (K15).
    if (patch.dependsOn !== undefined) {
      const wanted = new Set(patch.dependsOn.filter((d) => d !== id && this.cardExists(d)));
      for (const dep of this.getDependencies(id)) {
        if (!wanted.has(dep)) await this.removeDependency(id, dep, actor);
      }
      for (const dep of wanted) await this.addDependency(id, dep, "declared", actor);
    }

    const updated = await this.getCard(id);
    if (!updated) {
      throw new Error(`Card vanished after update: ${id}`);
    }
    return updated;
  }

  /**
   * Move a card between two neighbours without touching any other row.
   *
   * This is the whole point of the fractional index: a drag is one UPDATE and
   * one event, so two concurrent reorders cannot interleave into a renumber
   * that loses one of the moves.
   */
  /** Move a card between two neighbours; a person's move names them (rule 19). */
  public async reorderCard(
    id: string,
    position: CardPosition,
    actor = "planner",
    options: { principal?: string } = {},
  ): Promise<CardRecord> {
    const after = position.afterCardId ? await this.getCard(position.afterCardId) : null;
    const before = position.beforeCardId ? await this.getCard(position.beforeCardId) : null;

    if (position.afterCardId && !after) {
      throw new Error(`Cannot reorder ${id}: predecessor ${position.afterCardId} not found`);
    }
    if (position.beforeCardId && !before) {
      throw new Error(`Cannot reorder ${id}: successor ${position.beforeCardId} not found`);
    }

    const lower = after?.orderKey ?? null;
    const upper = before?.orderKey ?? null;
    return this.updateCard(id, { orderKey: keyBetween(lower, upper) }, actor, options);
  }

  /**
   * Append an event this store projects, and project the recorded event
   * with `applyEvent` — the replay's own code — so the live projection and a
   * rebuild cannot differ.
   */
  private async appendAndApply<T>(params: {
    actor: string;
    type: string;
    cardId: string;
    payload: T;
    principal?: string | undefined;
    /** Personal data or free text, off the chain and erasable (rule 33). */
    private?: Record<string, unknown> | undefined;
  }): Promise<EventRecord<T>> {
    const record = await this.eventLog.append(
      {
        actor: params.actor,
        type: params.type,
        cardId: params.cardId,
        payload: params.payload,
        ...(params.principal ? { principal: params.principal } : {}),
        ...(params.private ? { private: params.private } : {}),
      },
      // K-S7-3: projected before COMMIT, so a failure rolls the append back.
      { project: (event) => this.applyEvent(event as EventRecord) },
    );
    return record;
  }

  /** The install's own person on a solo setup (rule 19), for a person's decision. */
  public localPrincipal(): string {
    return this.eventLog.localPrincipal();
  }

  /** Whether `principal` holds the Accept permission (K-N7-1, review-git §2.4.1). */
  public mayAccept(principal: string): boolean {
    return this.eventLog.mayAccept(principal);
  }

  /** Every Accept-holder now: one is a solo project, two or more a team (review-git §2.4.1). */
  public acceptHolders(): string[] {
    return this.eventLog.acceptHolders();
  }

  /**
   * The principal who recorded the latest `card/delegated` of the card to the
   * Worker — never its current owner (review-git §2.4.1, RG-N5-8).
   */
  public delegatorOf(cardId: string): string | undefined {
    return this.eventLog.delegatorOf(cardId);
  }

  /**
   * The people who built the card (review-git §2.4.1): a person it is
   * delegated to, every person named as `builtBy` on a checkpoint or an
   * attempt, and every person who took it over (`card/taken_over`, WL-N10-3).
   */
  public async buildersOf(cardId: string): Promise<string[]> {
    const card = await this.getCard(cardId);
    const out = new Set<string>();
    if (card?.delegate?.kind === "person" && card.delegate.id) out.add(card.delegate.id);
    for (const cp of await this.getCheckpoints(cardId)) {
      if (cp.builtBy?.kind === "person") out.add(cp.builtBy.id);
    }
    for (const attempt of this.runs.listAttempts(cardId)) {
      if (attempt.builtBy?.kind === "person" && attempt.builtBy.id) out.add(attempt.builtBy.id);
    }
    for (const e of await this.cardEvents(cardId, ["card/taken_over"])) {
      const who = (e.payload as { principal?: string }).principal ?? e.principal;
      if (who) out.add(who);
    }
    return [...out];
  }

  /** Ledger events of the given types, oldest first — project-wide, not one card's. */
  public async eventsOfType(types: string[], fromSeq = 1): Promise<EventRecord[]> {
    return this.eventLog.getEventsByTypes(types, fromSeq);
  }

  /** A project-wide fact on the ledger, with no card (e.g. `review/auto_accept_enabled`). */
  public async recordLedgerEvent<T>(params: {
    type: string;
    actor: string;
    payload: T;
    principal?: string | undefined;
    private?: Record<string, unknown> | undefined;
  }): Promise<EventRecord<T>> {
    return this.eventLog.append({
      actor: params.actor,
      type: params.type,
      payload: params.payload,
      ...(params.principal ? { principal: params.principal } : {}),
      ...(params.private ? { private: params.private } : {}),
    });
  }

  /** The chain verifies (review-git §2.5.1: Accept checks the ledger before anything moves). */
  public verifyLedger(): { valid: boolean; reason?: string } {
    const r = this.eventLog.verifyHashChainSync();
    return { valid: r.valid, ...(r.reason ? { reason: r.reason } : {}) };
  }

  /** `<seq>:<hash>` of the ledger's last event, for the squash's `Ledger-Head` trailer. */
  public ledgerHead(): string | undefined {
    const row = this.db.prepare("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    return row ? `${row.seq}:${row.hash}` : undefined;
  }

  private async requireCard(id: string): Promise<CardRecord> {
    const card = await this.getCard(id);
    if (!card) throw new Error(`Card not found: ${id}`);
    return card;
  }

  /**
   * Hold a card in its state, waiting for `awaiting` (rule 24, K-N3-1): the
   * typed back-pressure hold, recorded as `card/held`.
   */
  public async holdCard(
    id: string,
    hold: { awaiting: CardStatus; reason: string },
    actor = "executor",
  ): Promise<CardRecord> {
    const card = await this.requireCard(id);
    if (!isCardStatus(hold.awaiting)) {
      throw new Error(
        `Card ${id}: a hold awaits one of the nine states, got ${String(hold.awaiting)}`,
      );
    }
    const reason = hold.reason.trim();
    if (!reason) throw new Error("A held card needs a reason");
    if (card.hold?.kind === "awaitingMerge") {
      throw new Error(`Card ${id} is accepted and awaits its pull request's merge`);
    }
    await this.appendAndApply({
      actor,
      type: "card/held",
      cardId: id,
      payload: { id, awaiting: hold.awaiting, reason, since: new Date().toISOString() },
    });
    return this.requireCard(id);
  }

  /** Clear a back-pressure hold once its awaited move succeeded (K-N3-2): `card/released`. */
  public async releaseHold(id: string, actor = "executor"): Promise<CardRecord> {
    const card = await this.requireCard(id);
    if (card.hold?.kind !== "backpressure") return card;
    await this.appendAndApply({
      actor,
      type: "card/released",
      cardId: id,
      payload: { id, awaited: card.hold.awaiting },
    });
    return this.requireCard(id);
  }

  /**
   * A person accepted the card and its pull request opened (rule 24, K-N3-3):
   * `card/pr_opened` sets the `awaitingMerge` hold and records the accepter;
   * the card stays in Review, outside Review's WIP count.
   */
  public async recordPullRequestOpened(
    id: string,
    pr: { pr: number; url: string; headSha: string; accepter?: string },
    actor = "harness",
    /**
     * Card events committed in the same transaction (kernel S7): Accept's
     * `card/accepted` with the pull request it opened (review-git §2.5.7).
     */
    withEvents: readonly {
      type: string;
      actor: string;
      payload: unknown;
      principal?: string;
    }[] = [],
  ): Promise<CardRecord> {
    const card = await this.requireCard(id);
    if (card.status !== "review") {
      throw new Error(`Card ${id} is in '${card.status}'; only a card in Review awaits a merge`);
    }
    if (!Number.isInteger(pr.pr) || pr.pr < 1)
      throw new Error(`A pull request number, got ${pr.pr}`);
    const project = (event: EventRecord) => {
      this.applyEvent(event);
    };
    this.eventLog.appendAllNow([
      {
        params: {
          actor,
          type: "card/pr_opened",
          cardId: id,
          payload: {
            id,
            pr: pr.pr,
            url: pr.url,
            headSha: pr.headSha,
            ...(pr.accepter ? { accepter: pr.accepter } : {}),
          },
        },
        project,
      },
      ...withEvents.map((e) => ({
        params: {
          actor: e.actor,
          type: e.type,
          cardId: id,
          payload: e.payload,
          ...(e.principal ? { principal: e.principal } : {}),
        },
        project,
      })),
    ]);
    return this.requireCard(id);
  }

  /**
   * The pull request closed (rule 24, K-N3-4): the hold clears; when it was
   * not merged, the acceptance did not complete and the accepter clears too.
   * The move to Done on a merge is the board's (`BoardServiceImpl.closePullRequest`).
   */
  public async recordPullRequestClosed(
    id: string,
    pr: {
      pr: number;
      merged: boolean;
      /** The merge commit (integrations INT-13). */
      mergeCommit?: string;
      /** Who closed it, when their login maps to a principal (INT-14). */
      closedBy?: string;
      /** Their login, kept private (rule 33) — the only name when unmapped. */
      closedByHandle?: string;
    },
    actor = "harness",
  ): Promise<CardRecord> {
    const card = await this.requireCard(id);
    if (card.hold?.kind !== "awaitingMerge" || card.hold.pr !== pr.pr) {
      throw new Error(`Card ${id} does not await pull request #${pr.pr}`);
    }
    await this.appendAndApply({
      actor,
      type: "card/pr_closed",
      cardId: id,
      payload: {
        id,
        pr: pr.pr,
        merged: pr.merged,
        ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}),
        ...(pr.closedBy ? { closedBy: pr.closedBy } : {}),
      },
      ...(pr.closedByHandle ? { private: { closedByHandle: pr.closedByHandle } } : {}),
    });
    return this.requireCard(id);
  }

  /**
   * Link a person's login on a tracker to their principal (integrations item
   * 6, NEW-integrations-2): `person/identity_linked {principal, system}`, the
   * login in the private part, erasable (rule 33). The latest link of a login
   * wins, so relinking moves it.
   */
  public async linkIdentity(
    principal: string,
    system: "github" | "forgejo",
    handle: string,
    by: string,
    actor = "human",
  ): Promise<void> {
    await this.eventLog.append({
      actor,
      type: "person/identity_linked",
      payload: { principal, system },
      principal: by,
      private: { handle: handle.trim() },
    });
  }

  /** The principal a tracker login is linked to, if any (case-insensitive, like GitHub). */
  public principalForHandle(system: string, handle: string): string | undefined {
    return this.identityLinks(system).get(handle.trim().toLowerCase())?.principal;
  }

  /** The login a principal is linked to on a tracker, if any. */
  public handleOf(principal: string, system: string): string | undefined {
    for (const link of this.identityLinks(system).values()) {
      if (link.principal === principal) return link.handle;
    }
    return undefined;
  }

  /** Each login's latest link, oldest first; an erased login links nothing. */
  private identityLinks(system: string): Map<string, { principal: string; handle: string }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(e.payload, '$.principal') AS principal,
                json_extract(p.body, '$.handle') AS handle
           FROM events e JOIN event_private p ON p.event_id = e.id
          WHERE e.type = 'person/identity_linked'
            AND json_extract(e.payload, '$.system') = ?
          ORDER BY e.seq`,
      )
      .all(system) as { principal: string; handle: string | null }[];
    const byHandle = new Map<string, { principal: string; handle: string }>();
    for (const r of rows) {
      if (typeof r.handle !== "string" || !r.handle || r.handle === ERASED_MARKER) continue;
      const key = r.handle.toLowerCase();
      // A later link of the principal elsewhere unlinks its earlier login.
      for (const [k, v] of byHandle) if (v.principal === r.principal) byHandle.delete(k);
      byHandle.set(key, { principal: r.principal, handle: r.handle });
    }
    return byHandle;
  }

  /**
   * The `assignee` a reader sees (K-N6-6): derived from the delegate and
   * owner — `worker`, `human` for the install's person, else the owner's
   * principal — and the legacy column only for a card that has neither.
   */
  private assigneeOf(row: {
    assignee: string | null;
    owner: string | null;
    delegate: string | null;
  }): string | undefined {
    const delegate = row.delegate ? parseJsonColumn<CardDelegate | null>(row.delegate, null) : null;
    if (delegate?.kind === "worker") return "worker";
    if (delegate?.kind === "person" && delegate.id) return delegate.id;
    if (row.owner) return row.owner === this.localPrincipal() ? "human" : row.owner;
    return row.assignee ?? undefined;
  }

  /** A legacy `assignee` value, recorded as the delegate or owner it names (K-N6-6). */
  private async applyAssignee(
    card: CardRecord,
    assignee: string | null,
    actor: string,
    options: { principal?: string },
  ): Promise<void> {
    const principal = options.principal ?? this.localPrincipal();
    const target = assignee
      ? assigneeTarget(this.db, assignee, (p) => {
          this.eventLog.appendNow(p);
        })
      : undefined;
    if (!target) {
      if (card.delegate) await this.delegateCard(card.id, null, principal, actor);
      return;
    }
    if ("delegate" in target) {
      if (card.delegate?.kind !== target.delegate.kind)
        await this.delegateCard(card.id, target.delegate, principal, actor);
    } else if (card.owner !== target.owner) {
      await this.changeOwner(card.id, target.owner, principal, actor);
    }
  }

  /** Change who builds the card (K-N6-2): `card/delegated {from, to}`, naming the principal. */
  public async delegateCard(
    id: string,
    to: CardDelegate | null,
    principal: string,
    actor = "human",
  ): Promise<CardRecord> {
    const card = await this.requireCard(id);
    validateCardFields(id, { delegate: to });
    await this.appendAndApply({
      actor,
      type: "card/delegated",
      cardId: id,
      payload: { id, from: card.delegate ?? null, to },
      principal,
    });
    return this.requireCard(id);
  }

  /** Change who is responsible for the card (K-N6-2): `card/owner_changed {from, to}`. */
  public async changeOwner(
    id: string,
    to: string | null,
    /** The person who changed it; none for a tracker's change (integrations INT-40). */
    principal: string | undefined,
    actor = "human",
  ): Promise<CardRecord> {
    const card = await this.requireCard(id);
    await this.appendAndApply({
      actor,
      type: "card/owner_changed",
      cardId: id,
      payload: { id, from: card.owner ?? null, to },
      principal,
    });
    return this.requireCard(id);
  }

  /**
   * Append a card-scoped fact to the ledger without changing the projection:
   * a step the Worker took, the sha an accept merged as, the Planner's repair
   * plan. The dashboard reads these back; the hash chain covers them.
   */
  public async recordEvent<T>(params: {
    type: string;
    cardId: string;
    actor: string;
    payload: T;
    /** The attempt and step the fact belongs to, as typed columns (K4). */
    attemptId?: string | undefined;
    stepId?: string | undefined;
    /** The person the event acts for (rule 19); a person's override names them (rule 28). */
    principal?: string | undefined;
    /** Free text and personal data, off the chain and erasable (rule 33, K-S7-9). */
    private?: Record<string, unknown> | undefined;
    /** Only on the Worker's own events (NEW-kernel-10). */
    onBehalfOf?: string | undefined;
  }): Promise<void> {
    await this.eventLog.append({
      actor: params.actor,
      type: params.type,
      cardId: params.cardId,
      payload: params.payload,
      ...(params.attemptId ? { attemptId: params.attemptId } : {}),
      ...(params.stepId ? { stepId: params.stepId } : {}),
      ...(params.principal ? { principal: params.principal } : {}),
      ...(params.private ? { private: params.private } : {}),
      ...(params.onBehalfOf ? { onBehalfOf: params.onBehalfOf } : {}),
    });
  }

  /** One card's ledger events of the given types, oldest first. */
  public async cardEvents(cardId: string, types: string[]): Promise<EventRecord[]> {
    return this.eventLog.getEventsByCardAndTypes(cardId, types);
  }

  /**
   * Append one fact to a card's dossier (integration review §3 item 6).
   *
   * Validated before it reaches the ledger, because the chain is append-only:
   * an empty or mistyped entry written today is there forever.
   */
  public async recordDossierEntry(input: DossierEntryInput): Promise<DossierEntry> {
    const type = DOSSIER_EVENT_TYPES[input.kind];
    if (!type) throw new Error(`Unknown dossier kind: ${String(input.kind)}`);
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new Error(`A ${input.kind} entry needs non-empty text`);
    if (input.attempt !== undefined && (!Number.isInteger(input.attempt) || input.attempt < 1)) {
      throw new Error(`Dossier attempt must be a positive integer, got ${input.attempt}`);
    }
    if (input.inReplyTo !== undefined && input.kind !== "answer") {
      throw new Error("Only an answer may name the question it replies to");
    }
    if (input.modelId !== undefined && input.kind !== "review") {
      throw new Error("Only a review entry names its model");
    }
    if (!(await this.getCard(input.cardId))) {
      throw new Error(`Card not found: ${input.cardId}`);
    }

    const max = input.kind === "research" ? MAX_RESEARCH_DOSSIER_TEXT : MAX_DOSSIER_TEXT;
    const stored =
      text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} chars cut]` : text;
    const payload: DossierPayload = {
      kind: input.kind,
      text: stored,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.sources?.length ? { sources: [...input.sources] } : {}),
      ...(input.verdict ? { verdict: input.verdict } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    };
    const event = await this.eventLog.append({
      actor: input.actor ?? DOSSIER_DEFAULT_ACTORS[input.kind],
      type,
      cardId: input.cardId,
      payload,
    });
    return this.toDossierEntry(
      event.id,
      event.seq,
      input.cardId,
      event.actor,
      event.createdAt,
      payload,
    );
  }

  private toDossierEntry(
    entryId: string,
    seq: number,
    cardId: string,
    actor: string,
    createdAt: string,
    p: DossierPayload,
  ): DossierEntry {
    return {
      entryId,
      seq,
      cardId,
      kind: p.kind,
      actor,
      text: p.text,
      createdAt,
      ...(p.attempt !== undefined ? { attempt: p.attempt } : {}),
      ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
      ...(p.sources?.length ? { sources: p.sources } : {}),
      ...(p.verdict ? { verdict: p.verdict } : {}),
      ...(p.modelId ? { modelId: p.modelId } : {}),
    };
  }

  /**
   * Everything the team has recorded about one card, oldest first
   * (`dossierFor(cardId)` in the integration review's target architecture).
   *
   * Answers are threaded under the question they name, so a reply Seshat wrote
   * for another card can never be attached to this one.
   */
  public async getDossier(cardId: string): Promise<CardDossier> {
    const events = await this.eventLog.getEventsByCardAndTypes(
      cardId,
      Object.values(DOSSIER_EVENT_TYPES),
    );
    const entries: DossierEntry[] = [];
    for (const e of events) {
      const kind = KIND_BY_EVENT_TYPE.get(e.type);
      const p = e.payload as Partial<DossierPayload> | null;
      // A malformed row (hand-edited or from an older writer) is skipped, not fatal.
      if (!kind || !p || typeof p.text !== "string") continue;
      entries.push(
        this.toDossierEntry(e.id, e.seq, cardId, e.actor, e.createdAt, {
          ...p,
          kind,
        } as DossierPayload),
      );
    }

    const byKind = (k: DossierEntryKind) => entries.filter((e) => e.kind === k);
    const questions = byKind("question").map((question) => ({
      question,
      answers: [] as DossierEntry[],
    }));
    const threadOf = new Map(questions.map((t) => [t.question.entryId, t]));
    const unthreadedAnswers: DossierEntry[] = [];
    for (const answer of byKind("answer")) {
      const thread = answer.inReplyTo ? threadOf.get(answer.inReplyTo) : undefined;
      if (thread) thread.answers.push(answer);
      else unthreadedAnswers.push(answer);
    }

    return {
      cardId,
      entries,
      lessons: byKind("lesson"),
      notes: byKind("note"),
      questions,
      unthreadedAnswers,
      research: byKind("research"),
      reviews: byKind("review"),
      sendBacks: byKind("send_back"),
    };
  }

  // --- Dependencies (K15, B5) -----------------------------------------------

  /**
   * The path that adding `cardId -> dependsOnId` would close into a cycle,
   * or undefined. Follows existing edges from `dependsOnId`; reaching
   * `cardId` means the new edge completes a loop.
   */
  public cyclePath(cardId: string, dependsOnId: string): string[] | undefined {
    if (cardId === dependsOnId) return [cardId, cardId];
    const edges = this.db.prepare(
      "SELECT depends_on_card_id AS d FROM card_dependencies WHERE card_id = ?",
    );
    const stack: string[][] = [[dependsOnId]];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const path = stack.pop() as string[];
      const at = path[path.length - 1] as string;
      if (at === cardId) return [cardId, ...path];
      if (seen.has(at)) continue;
      seen.add(at);
      for (const row of edges.all(at) as unknown as { d: string }[]) stack.push([...path, row.d]);
    }
    return undefined;
  }

  /** Record that `cardId` waits on `dependsOnId`, refusing any edge that closes a cycle. */
  public async addDependency(
    cardId: string,
    dependsOnId: string,
    source: DependencySource = "declared",
    actor = "planner",
  ): Promise<void> {
    if (!DEPENDENCY_SOURCES.includes(source)) {
      throw new Error(
        `A dependency's source is one of ${DEPENDENCY_SOURCES.join(", ")}, got ${String(source)} (PM-N8-2)`,
      );
    }
    for (const id of [cardId, dependsOnId]) {
      if (!(await this.getCard(id))) {
        throw new CardStructureError("unknown_card", `Card not found: ${id}`);
      }
    }
    const existing = this.db
      .prepare("SELECT 1 AS x FROM card_dependencies WHERE card_id = ? AND depends_on_card_id = ?")
      .get(cardId, dependsOnId);
    if (existing) return;
    const cycle = this.cyclePath(cardId, dependsOnId);
    if (cycle) {
      throw new CardStructureError(
        "dependency_cycle",
        `${cardId} cannot depend on ${dependsOnId}: ${cycle.join(" -> ")} would be a cycle`,
        cycle,
      );
    }
    const payload = { cardId, dependsOnId, source, createdAt: new Date().toISOString() };
    await this.eventLog.append(
      { actor, type: "card/dependency_added", cardId, payload },
      { project: () => this.projectDependencyAdded(payload) },
    );
  }

  public async removeDependency(
    cardId: string,
    dependsOnId: string,
    actor = "human",
  ): Promise<void> {
    const payload = { cardId, dependsOnId, removedAt: new Date().toISOString() };
    await this.eventLog.append(
      { actor, type: "card/dependency_removed", cardId, payload },
      { project: () => this.projectDependencyRemoved(payload) },
    );
  }

  /** Cards `cardId` waits on. */
  public getDependencies(cardId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT depends_on_card_id AS d FROM card_dependencies WHERE card_id = ? ORDER BY d",
        )
        .all(cardId) as unknown as { d: string }[]
    ).map((r) => r.d);
  }

  /** Cards `cardId` waits on, each with why (PM-N8-2): declared, named, imported. */
  public getDependencyReasons(cardId: string): DependencyReason[] {
    return (
      this.db
        .prepare(
          "SELECT depends_on_card_id AS d, source FROM card_dependencies WHERE card_id = ? ORDER BY d",
        )
        .all(cardId) as unknown as { d: string; source: DependencySource }[]
    ).map((r) => ({ dependsOnId: r.d, source: r.source }));
  }

  /** Cards waiting on `cardId`. */
  public getDependents(cardId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT card_id AS c FROM card_dependencies WHERE depends_on_card_id = ? ORDER BY c",
        )
        .all(cardId) as unknown as { c: string }[]
    ).map((r) => r.c);
  }

  /** The prerequisites of `cardId` that are not done yet (B5 eligibility). */
  public waitingOn(cardId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT d.depends_on_card_id AS d FROM card_dependencies d
           JOIN cards c ON c.id = d.depends_on_card_id
           WHERE d.card_id = ? AND c.status != 'done' ORDER BY d.depends_on_card_id`,
        )
        .all(cardId) as unknown as { d: string }[]
    ).map((r) => r.d);
  }

  private projectDependencyAdded(p: {
    cardId: string;
    dependsOnId: string;
    source: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO card_dependencies (card_id, depends_on_card_id, source, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(p.cardId, p.dependsOnId, p.source, p.createdAt);
    this.syncDependsOnColumn(p.cardId);
  }

  private projectDependencyRemoved(p: { cardId: string; dependsOnId: string }): void {
    this.db
      .prepare("DELETE FROM card_dependencies WHERE card_id = ? AND depends_on_card_id = ?")
      .run(p.cardId, p.dependsOnId);
    this.syncDependsOnColumn(p.cardId);
  }

  /** Keep `cards.depends_on` (what `CardRecord.dependsOn` reads) equal to the edges. */
  private syncDependsOnColumn(cardId: string): void {
    const row = this.db.prepare("SELECT depends_on FROM cards WHERE id = ?").get(cardId) as
      | { depends_on: string }
      | undefined;
    if (!row) return;
    const declared = parseJsonColumn<string[]>(row.depends_on, []);
    const edges = this.getDependencies(cardId);
    const merged = [...new Set([...declared.filter((d) => !this.cardExists(d)), ...edges])];
    this.db
      .prepare("UPDATE cards SET depends_on = ? WHERE id = ?")
      .run(JSON.stringify(merged), cardId);
  }

  private cardExists(id: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").get(id) !== undefined;
  }

  // --- Projects (K14, B8, B13) ----------------------------------------------

  private mapProjectRow(r: Record<string, unknown>): ProjectRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      rootPath: String(r.root_path),
      gitBranch: String(r.git_branch),
      status: r.status as ProjectStatus,
      reviewMinutesPerDay: Number(r.review_minutes_per_day),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  public listProjects(): ProjectRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM projects ORDER BY created_at ASC, rowid ASC")
        .all() as unknown as Record<string, unknown>[]
    ).map((r) => this.mapProjectRow(r));
  }

  public getProject(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapProjectRow(row) : undefined;
  }

  /**
   * The project rooted at `rootPath`, created when there is none. A new
   * project starts active only while fewer than `activeProjectCap` are.
   */
  public async ensureProject(input: {
    rootPath: string;
    name: string;
    gitBranch?: string;
    reviewMinutesPerDay?: number;
  }): Promise<ProjectRecord> {
    // One project per folder: /tmp and /private/tmp are the same place on
    // macOS, and the dashboard once listed a project twice because of it.
    let rootPath = input.rootPath;
    try {
      rootPath = realpathSync(input.rootPath);
    } catch {
      // A path that does not exist (tests, a moved repo) is kept as given.
    }
    const existing = this.db
      .prepare("SELECT * FROM projects WHERE root_path IN (?, ?)")
      .get(rootPath, input.rootPath) as Record<string, unknown> | undefined;
    if (existing) return this.mapProjectRow(existing);
    const now = new Date().toISOString();
    const active = this.listProjects().filter((p) => p.status === "active").length;
    const payload = {
      id: `proj_${randomUUID().slice(0, 8)}`,
      name: input.name,
      rootPath,
      gitBranch: input.gitBranch ?? "main",
      status: (active < this.activeProjectCap ? "active" : "paused") as ProjectStatus,
      reviewMinutesPerDay: input.reviewMinutesPerDay ?? 60,
      createdAt: now,
      updatedAt: now,
    };
    await this.eventLog.append(
      { actor: "system", type: "project/created", payload },
      { project: () => this.projectProjectCreated(payload) },
    );
    return this.getProject(payload.id) as ProjectRecord;
  }

  /**
   * Pause, resume or archive a project (B12 "pause project"). Activating one
   * past the active-project cap is refused (B13).
   */
  public async setProjectStatus(
    id: string,
    status: ProjectStatus,
    actor = "human",
  ): Promise<ProjectRecord> {
    const project = this.getProject(id);
    if (!project) throw new CardStructureError("unknown_card", `Project not found: ${id}`);
    // K-N5-5: a project is done only by a person's acceptance of the slice
    // that completes it (`recordSliceAccepted`), never by a status write.
    if (!(PROJECT_STATUSES as readonly string[]).includes(status)) {
      throw new Error(
        `A project's stored status is ${PROJECT_STATUSES.join(", ")}; '${String(status)}' is derived — done only from a person's slice/accepted (kernel rule 30)`,
      );
    }
    if (status === "active" && project.status !== "active") {
      const active = this.listProjects().filter((p) => p.status === "active").length;
      if (active >= this.activeProjectCap) {
        throw new CardStructureError(
          "project_cap",
          `${active} projects are already active (the cap is ${this.activeProjectCap}); pause one first.`,
        );
      }
    }
    const payload = { id, status, updatedAt: new Date().toISOString() };
    await this.eventLog.append(
      { actor, type: "project/updated", payload },
      { project: () => this.projectProjectUpdated(payload) },
    );
    return this.getProject(id) as ProjectRecord;
  }

  /**
   * A person accepted a slice (rule 30, K-N5-5): `slice/accepted`, naming
   * the principal. When `completesProject` — the slice planner-pm computed
   * as completing the project — the rollup reports the project `done`.
   */
  public async recordSliceAccepted(
    input: { projectId: string; sliceId: string; completesProject: boolean },
    actor: string,
    options: { principal?: string } = {},
  ): Promise<void> {
    if (actor !== "human") {
      throw new Error(
        `Only a person accepts a slice (the actor was ${actor}); nothing was recorded`,
      );
    }
    if (!options.principal) {
      throw new Error("A slice is accepted by a person; no principal was given");
    }
    if (!this.getProject(input.projectId)) {
      throw new CardStructureError("unknown_card", `Project not found: ${input.projectId}`);
    }
    await this.eventLog.append({
      actor,
      type: "slice/accepted",
      payload: {
        projectId: input.projectId,
        sliceId: input.sliceId,
        completesProject: input.completesProject,
      },
      ...(options.principal ? { principal: options.principal } : {}),
    });
  }

  /**
   * The project's status as the rollup derives it (rule 30, K-N5-3, K-N5-5):
   * a person's `paused` or `archived` first; `active` while a top-level card
   * is open (neither done nor rejected); `done` only when a person's
   * `slice/accepted` completing the project is newer than every top-level
   * card's opening; `idle` otherwise — never done from the cards alone.
   */
  public async projectRollup(
    projectId: string,
  ): Promise<"active" | "idle" | "done" | "paused" | "archived"> {
    const project = this.getProject(projectId);
    if (!project) throw new CardStructureError("unknown_card", `Project not found: ${projectId}`);
    if (project.status === "paused" || project.status === "archived") return project.status;
    const top = (await this.listCards({ parentId: null })).filter((c) => c.projectId === projectId);
    if (top.some((c) => c.status !== "done" && c.status !== "rejected")) return "active";
    const completing = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM events WHERE type = 'slice/accepted' AND actor = 'human'
           AND json_extract(payload, '$.projectId') = ? AND json_extract(payload, '$.completesProject') = 1`,
      )
      .get(projectId) as { seq: number | null };
    if (completing.seq === null) return "idle";
    const ids = top.map((c) => c.id);
    if (ids.length === 0) return "done";
    // The latest opening of a top-level card: its creation or a move out of done/rejected.
    const opened = this.db
      .prepare(
        `SELECT MAX(seq) AS seq FROM events WHERE card_id IN (${ids.map(() => "?").join(",")})
           AND (type = 'card/created' OR (type = 'card/status_changed'
             AND json_extract(payload, '$.fromStatus') IN ('done', 'rejected')))`,
      )
      .get(...ids) as { seq: number | null };
    return (opened.seq ?? 0) < completing.seq ? "done" : "idle";
  }

  /** The review time a person has per day (B12 "set hours"; ReviewWIP, B3). */
  public async setProjectReviewMinutes(
    id: string,
    reviewMinutesPerDay: number,
    actor = "human",
    /** The person who changed it (dashboard DB-N4-2), recorded on the event. */
    principal?: string,
  ): Promise<ProjectRecord> {
    if (!this.getProject(id))
      throw new CardStructureError("unknown_card", `Project not found: ${id}`);
    if (!Number.isFinite(reviewMinutesPerDay) || reviewMinutesPerDay <= 0) {
      throw new Error(
        `review_minutes_per_day must be greater than 0 (got ${reviewMinutesPerDay}); ReviewWIP is derived from it`,
      );
    }
    const payload = {
      id,
      reviewMinutesPerDay: Math.round(reviewMinutesPerDay),
      updatedAt: new Date().toISOString(),
    };
    await this.eventLog.append(
      { actor, type: "project/review_hours", payload, ...(principal ? { principal } : {}) },
      { project: () => this.projectReviewMinutes(payload) },
    );
    return this.getProject(id) as ProjectRecord;
  }

  private projectReviewMinutes(p: {
    id: string;
    reviewMinutesPerDay: number;
    updatedAt: string;
  }): void {
    this.db
      .prepare("UPDATE projects SET review_minutes_per_day = ?, updated_at = ? WHERE id = ?")
      .run(p.reviewMinutesPerDay, p.updatedAt, p.id);
  }

  private projectProjectCreated(p: ProjectRecord): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO projects (id, name, root_path, git_branch, status, review_minutes_per_day, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        p.id,
        p.name,
        p.rootPath,
        p.gitBranch,
        p.status,
        p.reviewMinutesPerDay,
        p.createdAt,
        p.updatedAt,
      );
  }

  private projectProjectUpdated(p: { id: string; status: ProjectStatus; updatedAt: string }): void {
    this.db
      .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
      .run(p.status, p.updatedAt, p.id);
  }

  public async recordCheckpoint(cp: CheckpointRecord): Promise<void> {
    // The relay protocol resumes from these rows; a bad one sends a resume to
    // the wrong commit, so it is refused before it reaches the ledger.
    if (!Number.isInteger(cp.step) || cp.step < 0) {
      throw new Error(`Checkpoint step must be a non-negative integer, got ${cp.step}`);
    }
    if (!cp.gitRef?.trim()) throw new Error("Checkpoint needs a git ref");
    if (!["pass", "fail", "partial", "unavailable", "suspended-quota"].includes(cp.gateStatus)) {
      throw new Error(`Unknown checkpoint gate status: ${String(cp.gateStatus)}`);
    }
    // Checked before the append: the projection's foreign key would refuse
    // the row, but only after the ledger had already recorded it.
    if (!(await this.getCard(cp.cardId))) throw new Error(`Card not found: ${cp.cardId}`);
    // K-N6-4: who built the step, the Worker running the model unless a person did.
    const recorded: CheckpointRecord = {
      ...cp,
      builtBy: cp.builtBy ?? { kind: "worker", id: cp.agentModel },
    };
    if (recorded.builtBy?.kind !== "worker" && recorded.builtBy?.kind !== "person") {
      throw new Error(
        `builtBy is {kind: "worker" | "person", id}, got ${JSON.stringify(cp.builtBy)}`,
      );
    }
    await this.eventLog.append(
      {
        actor: "sync",
        type: "checkpoint/recorded",
        cardId: cp.cardId,
        payload: recorded,
      },
      { project: () => this.projectCheckpoint(recorded) },
    );
  }

  public async getCheckpoints(cardId: string): Promise<CheckpointRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT card_id, step, git_ref, gate_status, agent_model, agent_harness, agent_role, created_at,
          built_by
        FROM checkpoints
        WHERE card_id = ?
        ORDER BY step ASC
      `)
      .all(cardId) as unknown as RawCheckpointRow[];

    return rows.map((r) => this.mapCheckpointRow(r));
  }

  private projectCardCreated(payload: Record<string, unknown>): void {
    this.db
      .prepare(cardInsertSql())
      .run(
        ...cardInsertValues(CARD_COLUMN_TABLE, payload, { orderKey: () => this.nextOrderKey() }),
      );
  }

  /** Translate a patch into a single UPDATE over exactly the touched columns. */
  private projectCardUpdated(id: string, patch: CardUpdate, updatedAt: string): void {
    const assignments = cardPatchAssignments(patch as Record<string, unknown>);
    if (assignments.length === 0) return;
    const sets = [...assignments.map(([column]) => `${column} = ?`), "updated_at = ?"];
    const params: SqlParam[] = [...assignments.map(([, value]) => value), updatedAt, id];
    this.db.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  private projectCheckpoint(cp: CheckpointRecord): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO checkpoints (card_id, step, git_ref, gate_status, agent_model, agent_harness, agent_role, created_at, built_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cp.cardId,
        cp.step,
        cp.gitRef,
        cp.gateStatus,
        cp.agentModel,
        cp.agentHarness,
        cp.agentRole,
        cp.createdAt,
        cp.builtBy ? JSON.stringify(cp.builtBy) : null,
      );
  }

  /** Tables derived from the ledger, cleared children first. */
  public static readonly PROJECTION_TABLES = [
    "competence_entries",
    "decision_requests",
    "evidence_bundles",
    "gate_results",
    "steps",
    "attempts",
    "card_dependencies",
    "checkpoints",
    "cards",
    "projects",
  ] as const;

  /**
   * Apply one ledger event to the projections this store owns. True when it did.
   * `live.expectedFrom` is the live status write's compare-and-set: its
   * projection applies only while the stored status still equals it, and
   * throws `stale_from` otherwise, rolling the append back (rule 26, K-S4-8).
   * Replay passes nothing and applies unconditionally.
   */
  public applyEvent(event: EventRecord, live?: { expectedFrom: CardStatus }): boolean {
    switch (event.type) {
      case "card/created":
        this.projectCardCreated(event.payload as Record<string, unknown>);
        return true;
      case "card/status_changed": {
        if (!this.projectStatusChanged(event, live?.expectedFrom)) {
          const p = event.payload as { id: string; toStatus: string };
          throw new StatusTransitionError(
            "stale_from",
            p.id,
            p.toStatus,
            `Card ${p.id}: another writer moved it from '${live?.expectedFrom}' first; nothing was changed`,
          );
        }
        return true;
      }
      case "card/held": {
        const p = event.payload as {
          id: string;
          awaiting: CardStatus;
          reason: string;
          since: string;
        };
        const hold: CardHold = {
          kind: "backpressure",
          awaiting: p.awaiting,
          reason: p.reason,
          since: p.since,
        };
        this.db.prepare("UPDATE cards SET hold = ? WHERE id = ?").run(JSON.stringify(hold), p.id);
        return true;
      }
      case "card/released": {
        const p = event.payload as { id: string };
        this.db.prepare("UPDATE cards SET hold = NULL WHERE id = ?").run(p.id);
        return true;
      }
      case "card/pr_opened": {
        const p = event.payload as {
          id: string;
          pr: number;
          url: string;
          headSha: string;
          accepter?: string;
        };
        const hold: CardHold = {
          kind: "awaitingMerge",
          pr: p.pr,
          url: p.url,
          headSha: p.headSha,
          since: event.createdAt,
        };
        this.db.prepare("UPDATE cards SET hold = ? WHERE id = ?").run(JSON.stringify(hold), p.id);
        if (p.accepter) {
          this.db.prepare("UPDATE cards SET accepter = ? WHERE id = ?").run(p.accepter, p.id);
        }
        return true;
      }
      case "card/pr_closed": {
        const p = event.payload as { id: string; merged: boolean };
        this.db
          .prepare(
            p.merged
              ? "UPDATE cards SET hold = NULL WHERE id = ?"
              : "UPDATE cards SET hold = NULL, accepter = NULL WHERE id = ?",
          )
          .run(p.id);
        return true;
      }
      case "card/delegated": {
        const p = event.payload as { id: string; to: CardDelegate | null };
        this.db
          .prepare("UPDATE cards SET delegate = ? WHERE id = ?")
          .run(p.to ? JSON.stringify(p.to) : null, p.id);
        return true;
      }
      case "card/owner_changed": {
        const p = event.payload as { id: string; to: string | null };
        this.db.prepare("UPDATE cards SET owner = ? WHERE id = ?").run(p.to, p.id);
        return true;
      }
      case "card/updated": {
        const p = event.payload as { id: string; patch: CardUpdate; updatedAt: string };
        this.projectCardUpdated(p.id, p.patch, p.updatedAt);
        return true;
      }
      case "checkpoint/recorded":
        this.projectCheckpoint(event.payload as CheckpointRecord);
        return true;
      case "card/dependency_added":
        this.projectDependencyAdded(
          event.payload as {
            cardId: string;
            dependsOnId: string;
            source: string;
            createdAt: string;
          },
        );
        return true;
      case "card/dependency_removed":
        this.projectDependencyRemoved(event.payload as { cardId: string; dependsOnId: string });
        return true;
      case "project/created":
        this.projectProjectCreated(event.payload as ProjectRecord);
        return true;
      case "project/review_hours":
        this.projectReviewMinutes(
          event.payload as { id: string; reviewMinutesPerDay: number; updatedAt: string },
        );
        return true;
      case "project/updated":
        this.projectProjectUpdated(
          event.payload as { id: string; status: ProjectStatus; updatedAt: string },
        );
        return true;
      default:
        return this.runs.applyEvent(event);
    }
  }

  /**
   * Project a `card/status_changed`. Replay writes it unconditionally; the
   * live write passes `expectedFrom` and projects only while the stored
   * status still equals it, returning false otherwise (rule 26, K-S4-8).
   */
  private projectStatusChanged(event: EventRecord, expectedFrom?: CardStatus): boolean {
    const p = event.payload as {
      id: string;
      fromStatus?: CardStatus;
      toStatus: CardStatus;
      updatedAt: string;
    };
    const changed =
      expectedFrom === undefined
        ? this.db
            .prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?")
            .run(p.toStatus, p.updatedAt, p.id)
        : this.db
            .prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
            .run(p.toStatus, p.updatedAt, p.id, expectedFrom);
    if (expectedFrom !== undefined && Number(changed.changes) === 0) return false;
    if (p.toStatus === "done" && event.principal) {
      // K-N6-3: the person whose move accepted the card is its accepter.
      this.db.prepare("UPDATE cards SET accepter = ? WHERE id = ?").run(event.principal, p.id);
    } else if (p.fromStatus === "done" && p.toStatus !== "done") {
      // A card leaving Done is no longer accepted: the next Done needs a new
      // accepting decision (spine: the human is the rate limiter).
      this.db.prepare("UPDATE cards SET accepter = NULL WHERE id = ?").run(p.id);
    } else if (p.fromStatus === "review" && p.toStatus !== "done") {
      // K-N3-6: a card leaving Review (the merge's own move to Done aside)
      // leaves its acceptance behind: an `awaitingMerge` hold and its
      // accepter clear, so the old pull request's merge cannot take it to Done.
      this.db
        .prepare(
          "UPDATE cards SET accepter = NULL, hold = CASE WHEN json_extract(hold, '$.kind') = 'awaitingMerge' THEN NULL ELSE hold END WHERE id = ?",
        )
        .run(p.id);
    }
    return true;
  }

  /** Clear every projection and replay the whole ledger into it (no transaction). */
  private async replayAll(): Promise<number> {
    const events = await this.eventLog.getEvents(1, Number.MAX_SAFE_INTEGER);
    for (const table of CardStore.PROJECTION_TABLES) this.db.exec(`DELETE FROM ${table}`);
    let applied = 0;
    for (const event of events) if (this.applyEvent(event)) applied++;
    return applied;
  }

  /** Canonical content hash per projection table, for byte-identical comparison. */
  public projectionDigest(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const table of CardStore.PROJECTION_TABLES) {
      const cols = (
        this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
      ).map((c) => c.name);
      const rows = this.db
        .prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY ${cols.join(", ")}`)
        .all();
      out[table] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    }
    return out;
  }

  public async rebuildProjections(): Promise<{ cardsCount: number; checkpointsCount: number }> {
    // Foreign keys are checked at the end of the swap, not row by row: a
    // replay inserts children after their parents, but DELETE order and
    // legacy rows are not guaranteed to agree.
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      await this.replayAll();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      this.db.exec("PRAGMA foreign_keys = ON");
      throw err;
    }
    this.db.exec("PRAGMA foreign_keys = ON");

    const cardsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number }
    ).count;
    const checkpointsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM checkpoints").get() as { count: number }
    ).count;

    return { cardsCount, checkpointsCount };
  }

  /**
   * Replay the ledger into the projections inside a transaction that is then
   * rolled back, and compare (K8). `identical` is true when every projection
   * table the ledger derives is byte-identical to what is stored, which is
   * the property "state derives from the log" promises. Non-destructive.
   */
  public async verifyProjections(): Promise<{
    identical: boolean;
    mismatched: string[];
    eventsApplied: number;
  }> {
    const before = this.projectionDigest();
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN IMMEDIATE");
    let after: Record<string, string>;
    let eventsApplied = 0;
    try {
      eventsApplied = await this.replayAll();
      after = this.projectionDigest();
    } finally {
      this.db.exec("ROLLBACK");
      this.db.exec("PRAGMA foreign_keys = ON");
    }
    const mismatched = Object.keys(before).filter((t) => before[t] !== after[t]);
    return { identical: mismatched.length === 0, mismatched, eventsApplied };
  }
}
