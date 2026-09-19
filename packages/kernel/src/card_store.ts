import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import { keyBetween } from "./order_key.js";
import { RunLedger } from "./records.js";
import {
  CARD_STOP_REASONS,
  type CardDossier,
  type CardRecord,
  type CardStatus,
  type CardStopReason,
  type CardTier,
  type CheckpointRecord,
  DOSSIER_DEFAULT_ACTORS,
  DOSSIER_EVENT_TYPES,
  type DossierEntry,
  type DossierEntryInput,
  type DossierEntryKind,
  type EventRecord,
  type ExternalRef,
  type ModelRoute,
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
}

/** Where a dragged card lands, expressed as its new neighbours. */
export interface CardPosition {
  /** Card it should follow; `null`/omitted means "top of the column". */
  afterCardId?: string | null;
  /** Card it should precede; `null`/omitted means "bottom of the column". */
  beforeCardId?: string | null;
}

type SqlParam = string | number | null;

const CARD_COLUMNS = `
  id, tier, parent_id, title, status, scope_files, step_budget, steps_used,
  spec, acceptance_criteria, acceptance_tests, difficulty, token_budget, seconds_budget,
  tokens_used, seconds_used, model_route_planner, model_route_executor,
  depends_on, context_pack_id, evidence_id, external_ref, stop_reason,
  priority, order_key, blocked_reason, estimate, labels, epic_id, cycle_id,
  assignee, due_date, project_id, created_at, updated_at
`;

interface RawCardRow {
  id: string;
  tier: CardTier;
  parent_id: string | null;
  title: string;
  status: CardStatus;
  scope_files: string;
  step_budget: number;
  steps_used: number;
  spec: string | null;
  acceptance_criteria: string;
  acceptance_tests: string;
  difficulty: number | null;
  token_budget: number | null;
  seconds_budget: number | null;
  tokens_used: number;
  seconds_used: number;
  model_route_planner: string | null;
  model_route_executor: string | null;
  depends_on: string;
  context_pack_id: string | null;
  evidence_id: string | null;
  external_ref: string | null;
  stop_reason: string | null;
  priority: number;
  order_key: string;
  blocked_reason: string | null;
  estimate: number | null;
  labels: string | null;
  epic_id: string | null;
  cycle_id: string | null;
  assignee: string | null;
  due_date: string | null;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RawCheckpointRow {
  card_id: string;
  step: number;
  git_ref: string;
  gate_status: string;
  agent_model: string;
  agent_harness: string;
  agent_role: string;
  created_at: string;
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
  /** Active projects allowed at once (B13). */
  public activeProjectCap = DEFAULT_ACTIVE_PROJECT_CAP;

  constructor(
    private db: DatabaseSync,
    private eventLog: EventLog,
  ) {
    this.runs = new RunLedger(db, eventLog);
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

  private mapCardRow(row: RawCardRow): CardRecord {
    const modelRoute: ModelRoute = {
      ...(row.model_route_planner ? { planner: row.model_route_planner } : {}),
      ...(row.model_route_executor ? { executor: row.model_route_executor } : {}),
    };
    const externalRef = row.external_ref
      ? parseJsonColumn<ExternalRef | null>(row.external_ref, null)
      : null;

    return {
      id: row.id,
      tier: row.tier,
      parentId: row.parent_id,
      title: row.title,
      status: row.status,
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
      ...(row.assignee !== null ? { assignee: row.assignee } : {}),
      ...(row.due_date !== null ? { dueDate: row.due_date } : {}),
      ...(row.project_id !== null ? { projectId: row.project_id } : {}),
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
      stepBudget: input.stepBudget ?? 50,
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
      assignee: input.assignee ?? null,
      dueDate: input.dueDate ?? null,
      projectId: input.projectId ?? this.defaultProjectId(),
      createdAt: now,
      updatedAt: now,
    };

    // 1. Append immutable event to hash chain
    await this.eventLog.append({
      actor,
      type: "card/created",
      cardId: id,
      payload,
    });

    // 2. Project into SQLite WAL cards table
    this.projectCardCreated(payload);

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
   * `actor` names who moved the card. It defaults to the executor for the
   * runner's own transitions; a human triaging from the dashboard passes
   * "human", so the ledger does not credit the Worker with a person's verdict.
   */
  public async updateCardStatus(
    id: string,
    status: CardStatus,
    reason?: string,
    actor = "executor",
  ): Promise<CardRecord> {
    const existing = await this.getCard(id);
    if (!existing) {
      throw new Error(`Card not found: ${id}`);
    }

    const now = new Date().toISOString();
    const payload = {
      id,
      fromStatus: existing.status,
      toStatus: status,
      reason,
      updatedAt: now,
    };

    // Append event
    await this.eventLog.append({
      actor,
      type: "card/status_changed",
      cardId: id,
      payload,
    });

    // Project update
    this.db
      .prepare(`
        UPDATE cards
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, now, id);

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
  public async updateCard(id: string, patch: CardUpdate, actor = "planner"): Promise<CardRecord> {
    const existing = await this.getCard(id);
    if (!existing) {
      throw new Error(`Card not found: ${id}`);
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

    await this.eventLog.append({
      actor,
      type: "card/updated",
      cardId: id,
      payload,
    });

    this.projectCardUpdated(id, patch, now);

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
  public async reorderCard(id: string, position: CardPosition): Promise<CardRecord> {
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
    return this.updateCard(id, { orderKey: keyBetween(lower, upper) });
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
  }): Promise<void> {
    await this.eventLog.append({
      actor: params.actor,
      type: params.type,
      cardId: params.cardId,
      payload: params.payload,
      ...(params.attemptId ? { attemptId: params.attemptId } : {}),
      ...(params.stepId ? { stepId: params.stepId } : {}),
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
    if (!(await this.getCard(input.cardId))) {
      throw new Error(`Card not found: ${input.cardId}`);
    }

    const stored =
      text.length > MAX_DOSSIER_TEXT
        ? `${text.slice(0, MAX_DOSSIER_TEXT)}\n… [${text.length - MAX_DOSSIER_TEXT} chars cut]`
        : text;
    const payload: DossierPayload = {
      kind: input.kind,
      text: stored,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.sources?.length ? { sources: [...input.sources] } : {}),
      ...(input.verdict ? { verdict: input.verdict } : {}),
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
    source: "declared" | "inferred" | "planner" = "declared",
    actor = "planner",
  ): Promise<void> {
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
    await this.eventLog.append({ actor, type: "card/dependency_added", cardId, payload });
    this.projectDependencyAdded(payload);
  }

  public async removeDependency(
    cardId: string,
    dependsOnId: string,
    actor = "human",
  ): Promise<void> {
    const payload = { cardId, dependsOnId, removedAt: new Date().toISOString() };
    await this.eventLog.append({ actor, type: "card/dependency_removed", cardId, payload });
    this.projectDependencyRemoved(payload);
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
    const existing = this.db
      .prepare("SELECT * FROM projects WHERE root_path = ?")
      .get(input.rootPath) as Record<string, unknown> | undefined;
    if (existing) return this.mapProjectRow(existing);
    const now = new Date().toISOString();
    const active = this.listProjects().filter((p) => p.status === "active").length;
    const payload = {
      id: `proj_${randomUUID().slice(0, 8)}`,
      name: input.name,
      rootPath: input.rootPath,
      gitBranch: input.gitBranch ?? "main",
      status: (active < this.activeProjectCap ? "active" : "paused") as ProjectStatus,
      reviewMinutesPerDay: input.reviewMinutesPerDay ?? 60,
      createdAt: now,
      updatedAt: now,
    };
    await this.eventLog.append({ actor: "system", type: "project/created", payload });
    this.projectProjectCreated(payload);
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
    await this.eventLog.append({ actor, type: "project/updated", payload });
    this.projectProjectUpdated(payload);
    return this.getProject(id) as ProjectRecord;
  }

  /** The review time a person has per day (B12 "set hours"; ReviewWIP, B3). */
  public async setProjectReviewMinutes(
    id: string,
    reviewMinutesPerDay: number,
    actor = "human",
  ): Promise<ProjectRecord> {
    if (!this.getProject(id))
      throw new CardStructureError("unknown_card", `Project not found: ${id}`);
    if (!Number.isFinite(reviewMinutesPerDay) || reviewMinutesPerDay <= 0) {
      throw new Error("Review minutes per day must be a positive number");
    }
    const payload = {
      id,
      reviewMinutesPerDay: Math.round(reviewMinutesPerDay),
      updatedAt: new Date().toISOString(),
    };
    await this.eventLog.append({ actor, type: "project/review_hours", payload });
    this.projectReviewMinutes(payload);
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
    if (!["pass", "fail", "partial", "suspended-quota"].includes(cp.gateStatus)) {
      throw new Error(`Unknown checkpoint gate status: ${String(cp.gateStatus)}`);
    }
    // Checked before the append: the projection's foreign key would refuse
    // the row, but only after the ledger had already recorded it.
    if (!(await this.getCard(cp.cardId))) throw new Error(`Card not found: ${cp.cardId}`);
    await this.eventLog.append({
      actor: "sync",
      type: "checkpoint/recorded",
      cardId: cp.cardId,
      payload: cp,
    });

    this.projectCheckpoint(cp);
  }

  public async getCheckpoints(cardId: string): Promise<CheckpointRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT card_id, step, git_ref, gate_status, agent_model, agent_harness, agent_role, created_at
        FROM checkpoints
        WHERE card_id = ?
        ORDER BY step ASC
      `)
      .all(cardId) as unknown as RawCheckpointRow[];

    return rows.map((r) => this.mapCheckpointRow(r));
  }

  private projectCardCreated(payload: Record<string, unknown>): void {
    const route = (payload.modelRoute ?? null) as ModelRoute | null;
    const externalRef = (payload.externalRef ?? null) as ExternalRef | null;

    this.db
      .prepare(`
        INSERT OR REPLACE INTO cards (${CARD_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        payload.id as string,
        payload.tier as string,
        (payload.parentId as string) ?? null,
        payload.title as string,
        payload.status as string,
        JSON.stringify(payload.scopeFiles ?? []),
        (payload.stepBudget as number) ?? 50,
        (payload.stepsUsed as number) ?? 0,
        (payload.spec as string) ?? null,
        JSON.stringify(payload.acceptanceCriteria ?? []),
        JSON.stringify(payload.acceptanceTests ?? []),
        (payload.difficulty as number) ?? null,
        (payload.tokenBudget as number) ?? null,
        (payload.secondsBudget as number) ?? null,
        (payload.tokensUsed as number) ?? 0,
        (payload.secondsUsed as number) ?? 0,
        route?.planner ?? null,
        route?.executor ?? null,
        JSON.stringify(payload.dependsOn ?? []),
        (payload.contextPackId as string) ?? null,
        (payload.evidenceId as string) ?? null,
        externalRef ? JSON.stringify(externalRef) : null,
        (payload.stopReason as string) ?? null,
        (payload.priority as number) ?? 0,
        // Events written before `order_key` existed carry no key; give those a
        // generated one so replaying an old log still yields an ordered board.
        (payload.orderKey as string) ?? this.nextOrderKey(),
        (payload.blockedReason as string) ?? null,
        // Events written before these fields existed simply lack them.
        (payload.estimate as number) ?? null,
        JSON.stringify(payload.labels ?? []),
        (payload.epicId as string) ?? null,
        (payload.cycleId as string) ?? null,
        (payload.assignee as string) ?? null,
        (payload.dueDate as string) ?? null,
        (payload.projectId as string) ?? null,
        payload.createdAt as string,
        payload.updatedAt as string,
      );
  }

  /** Translate a patch into a single UPDATE over exactly the touched columns. */
  private projectCardUpdated(id: string, patch: CardUpdate, updatedAt: string): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];

    const set = (column: string, value: SqlParam): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.title !== undefined) set("title", patch.title);
    if (patch.scopeFiles !== undefined) set("scope_files", JSON.stringify(patch.scopeFiles));
    if (patch.stepBudget !== undefined) set("step_budget", patch.stepBudget);
    if (patch.stepsUsed !== undefined) set("steps_used", patch.stepsUsed);
    if (patch.spec !== undefined) set("spec", patch.spec);
    if (patch.acceptanceTests !== undefined) {
      set("acceptance_tests", JSON.stringify(patch.acceptanceTests));
    }
    if (patch.acceptanceCriteria !== undefined) {
      set("acceptance_criteria", JSON.stringify(patch.acceptanceCriteria));
    }
    if (patch.difficulty !== undefined) set("difficulty", patch.difficulty);
    if (patch.tokenBudget !== undefined) set("token_budget", patch.tokenBudget);
    if (patch.secondsBudget !== undefined) set("seconds_budget", patch.secondsBudget);
    if (patch.tokensUsed !== undefined) set("tokens_used", patch.tokensUsed);
    if (patch.secondsUsed !== undefined) set("seconds_used", patch.secondsUsed);
    if (patch.modelRoute !== undefined) {
      set("model_route_planner", patch.modelRoute.planner ?? null);
      set("model_route_executor", patch.modelRoute.executor ?? null);
    }
    if (patch.dependsOn !== undefined) set("depends_on", JSON.stringify(patch.dependsOn));
    if (patch.contextPackId !== undefined) set("context_pack_id", patch.contextPackId);
    if (patch.evidenceId !== undefined) set("evidence_id", patch.evidenceId);
    if (patch.externalRef !== undefined) set("external_ref", JSON.stringify(patch.externalRef));
    if (patch.stopReason !== undefined) set("stop_reason", patch.stopReason);
    if (patch.priority !== undefined) set("priority", patch.priority);
    if (patch.orderKey !== undefined) set("order_key", patch.orderKey);
    if (patch.blockedReason !== undefined) set("blocked_reason", patch.blockedReason);
    if (patch.estimate !== undefined) set("estimate", patch.estimate);
    if (patch.labels !== undefined) set("labels", JSON.stringify(patch.labels));
    if (patch.epicId !== undefined) set("epic_id", patch.epicId);
    if (patch.cycleId !== undefined) set("cycle_id", patch.cycleId);
    if (patch.assignee !== undefined) set("assignee", patch.assignee);
    if (patch.dueDate !== undefined) set("due_date", patch.dueDate);
    if (patch.projectId !== undefined) set("project_id", patch.projectId);

    if (sets.length === 0) return;

    set("updated_at", updatedAt);
    params.push(id);
    this.db.prepare(`UPDATE cards SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }

  private projectCheckpoint(cp: CheckpointRecord): void {
    this.db
      .prepare(`
        INSERT OR REPLACE INTO checkpoints (card_id, step, git_ref, gate_status, agent_model, agent_harness, agent_role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

  /** Apply one ledger event to the projections this store owns. True when it did. */
  public applyEvent(event: EventRecord): boolean {
    switch (event.type) {
      case "card/created":
        this.projectCardCreated(event.payload as Record<string, unknown>);
        return true;
      case "card/status_changed": {
        const p = event.payload as { id: string; toStatus: CardStatus; updatedAt: string };
        this.db
          .prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?")
          .run(p.toStatus, p.updatedAt, p.id);
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
