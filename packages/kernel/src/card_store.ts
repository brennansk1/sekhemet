import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import type { CardRecord, CardStatus, CardTier, CheckpointRecord, EventRecord } from "./types.js";

export interface CreateCardInput {
  id?: string;
  tier: CardTier;
  parentId?: string | null;
  title: string;
  status?: CardStatus;
  scopeFiles?: string[];
  stepBudget?: number;
}

interface RawCardRow {
  id: string;
  tier: CardTier;
  parent_id: string | null;
  title: string;
  status: CardStatus;
  scope_files: string;
  step_budget: number;
  steps_used: number;
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

export class CardStore {
  constructor(
    private db: DatabaseSync,
    private eventLog: EventLog,
  ) {}

  private mapCardRow(row: RawCardRow): CardRecord {
    return {
      id: row.id,
      tier: row.tier,
      parentId: row.parent_id,
      title: row.title,
      status: row.status,
      scopeFiles: JSON.parse(row.scope_files) as string[],
      stepBudget: row.step_budget,
      stepsUsed: row.steps_used,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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

  public async createCard(input: CreateCardInput): Promise<CardRecord> {
    const id = input.id ?? `card_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const status: CardStatus = input.status ?? "ready";
    const scopeFiles = input.scopeFiles ?? [];
    const stepBudget = input.stepBudget ?? 50;

    const payload = {
      id,
      tier: input.tier,
      parentId: input.parentId ?? null,
      title: input.title,
      status,
      scopeFiles,
      stepBudget,
      stepsUsed: 0,
      createdAt: now,
      updatedAt: now,
    };

    // 1. Append immutable event to hash chain
    await this.eventLog.append({
      actor: "planner",
      type: "card/created",
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
      SELECT id, tier, parent_id, title, status, scope_files, step_budget, steps_used, created_at, updated_at
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
      SELECT id, tier, parent_id, title, status, scope_files, step_budget, steps_used, created_at, updated_at
      FROM cards
      WHERE 1=1
    `;
    const params: (string | number | null)[] = [];

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

    sql += " ORDER BY created_at ASC";
    const rows = this.db.prepare(sql).all(...params) as unknown as RawCardRow[];
    return rows.map((r) => this.mapCardRow(r));
  }

  public async updateCardStatus(
    id: string,
    status: CardStatus,
    reason?: string,
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
      actor: "executor",
      type: "card/status_changed",
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

  public async recordCheckpoint(cp: CheckpointRecord): Promise<void> {
    await this.eventLog.append({
      actor: "sync",
      type: "checkpoint/recorded",
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
    this.db
      .prepare(`
        INSERT OR REPLACE INTO cards (id, tier, parent_id, title, status, scope_files, step_budget, steps_used, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        payload.createdAt as string,
        payload.updatedAt as string,
      );
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
