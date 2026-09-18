import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { AppendEventParams, EventRecord, HashChainVerificationResult } from "./types.js";

const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

interface RawEventRow {
  seq: number;
  id: string;
  actor: string;
  type: string;
  payload: string;
  hash: string;
  prev_hash: string;
  created_at: string;
}

export class EventLog {
  private insertStmt: StatementSync;
  private lastEventStmt: StatementSync;
  private selectAllStmt: StatementSync;

  constructor(private db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO events (id, actor, type, payload, hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.lastEventStmt = db.prepare(`
      SELECT seq, id, actor, type, payload, hash, prev_hash, created_at
      FROM events
      ORDER BY seq DESC
      LIMIT 1
    `);

    this.selectAllStmt = db.prepare(`
      SELECT seq, id, actor, type, payload, hash, prev_hash, created_at
      FROM events
      ORDER BY seq ASC
    `);
  }

  public static computeHash(
    prevHash: string,
    seq: number,
    actor: string,
    type: string,
    payloadString: string,
    id: string,
  ): string {
    return createHash("sha256")
      .update(`${prevHash}:${seq}:${actor}:${type}:${payloadString}:${id}`)
      .digest("hex");
  }

  private mapRow<T>(row: RawEventRow): EventRecord<T> {
    return {
      seq: row.seq,
      id: row.id,
      actor: row.actor,
      type: row.type,
      payload: JSON.parse(row.payload) as T,
      hash: row.hash,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
    };
  }

  public async append<T = unknown>(params: AppendEventParams<T>): Promise<EventRecord<T>> {
    const id = params.id ?? randomUUID();
    const payloadStr = JSON.stringify(params.payload);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lastRow = this.lastEventStmt.get() as unknown as RawEventRow | undefined;
      const prevHash = lastRow ? lastRow.hash : GENESIS_PREV_HASH;
      const nextSeq = lastRow ? lastRow.seq + 1 : 1;
      const hash = EventLog.computeHash(
        prevHash,
        nextSeq,
        params.actor,
        params.type,
        payloadStr,
        id,
      );

      const runResult = this.insertStmt.run(
        id,
        params.actor,
        params.type,
        payloadStr,
        hash,
        prevHash,
      );
      const insertedSeq = Number(runResult.lastInsertRowid);

      const insertedRow = this.db
        .prepare(`
          SELECT seq, id, actor, type, payload, hash, prev_hash, created_at
          FROM events
          WHERE seq = ?
        `)
        .get(insertedSeq) as unknown as RawEventRow;

      this.db.exec("COMMIT");
      return this.mapRow<T>(insertedRow);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  public async getLastEvent(): Promise<EventRecord | null> {
    const row = this.lastEventStmt.get() as unknown as RawEventRow | undefined;
    if (!row) return null;
    return this.mapRow(row);
  }

  public async getEvents(fromSeq = 1, limit = 1000): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT seq, id, actor, type, payload, hash, prev_hash, created_at
        FROM events
        WHERE seq >= ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(fromSeq, limit) as unknown as RawEventRow[];

    return rows.map((r) => this.mapRow(r));
  }

  public async verifyHashChain(): Promise<HashChainVerificationResult> {
    const rows = this.selectAllStmt.all() as unknown as RawEventRow[];
    let prevHash = GENESIS_PREV_HASH;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) {
        continue;
      }
      const expectedSeq = i + 1;

      if (row.seq !== expectedSeq) {
        return {
          valid: false,
          totalEvents: rows.length,
          corruptedSeq: row.seq,
          reason: `Non-monotonic sequence: expected ${expectedSeq}, got ${row.seq}`,
        };
      }

      if (row.prev_hash !== prevHash) {
        return {
          valid: false,
          totalEvents: rows.length,
          corruptedSeq: row.seq,
          reason: `Invalid prevHash at seq ${row.seq}: expected ${prevHash}, got ${row.prev_hash}`,
        };
      }

      const expectedHash = EventLog.computeHash(
        row.prev_hash,
        row.seq,
        row.actor,
        row.type,
        row.payload,
        row.id,
      );

      if (row.hash !== expectedHash) {
        return {
          valid: false,
          totalEvents: rows.length,
          corruptedSeq: row.seq,
          reason: `Hash mismatch at seq ${row.seq}: expected ${expectedHash}, got ${row.hash}`,
        };
      }

      prevHash = row.hash;
    }

    return {
      valid: true,
      totalEvents: rows.length,
    };
  }
}
