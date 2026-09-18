import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import { keyBetween } from "./order_key.js";
import type {
  CardRecord,
  CardStatus,
  CardStopReason,
  CardTier,
  CheckpointRecord,
  ExternalRef,
  ModelRoute,
} from "./types.js";

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
  assignee, due_date, created_at, updated_at
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
  constructor(
    private db: DatabaseSync,
    private eventLog: EventLog,
  ) {}

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

    const now = new Date().toISOString();
    const payload = { id, patch, updatedAt: now };

    await this.eventLog.append({
      actor,
      type: "card/updated",
      cardId: id,
      payload,
    });

    this.projectCardUpdated(id, patch, now);

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
  }): Promise<void> {
    await this.eventLog.append({
      actor: params.actor,
      type: params.type,
      cardId: params.cardId,
      payload: params.payload,
    });
  }

  public async recordCheckpoint(cp: CheckpointRecord): Promise<void> {
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  public async rebuildProjections(): Promise<{ cardsCount: number; checkpointsCount: number }> {
    const events = await this.eventLog.getEvents(1, 1000000);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM checkpoints; DELETE FROM cards;");

      for (const event of events) {
        if (event.type === "card/created") {
          this.projectCardCreated(event.payload as Record<string, unknown>);
        } else if (event.type === "card/status_changed") {
          const p = event.payload as { id: string; toStatus: CardStatus; updatedAt: string };
          this.db
            .prepare("UPDATE cards SET status = ?, updated_at = ? WHERE id = ?")
            .run(p.toStatus, p.updatedAt, p.id);
        } else if (event.type === "card/updated") {
          const p = event.payload as { id: string; patch: CardUpdate; updatedAt: string };
          this.projectCardUpdated(p.id, p.patch, p.updatedAt);
        } else if (event.type === "checkpoint/recorded") {
          this.projectCheckpoint(event.payload as CheckpointRecord);
        }
      }

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    const cardsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM cards").get() as { count: number }
    ).count;
    const checkpointsCount = (
      this.db.prepare("SELECT COUNT(*) as count FROM checkpoints").get() as { count: number }
    ).count;

    return { cardsCount, checkpointsCount };
  }
}
