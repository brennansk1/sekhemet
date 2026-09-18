import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { canonicalPayloadHash } from "./canonical_json.js";
import type {
  AppendEventParams,
  EventFilter,
  EventRecord,
  HashChainVerificationResult,
} from "./types.js";

const GENESIS_PREV_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

const EVENT_COLUMNS =
  "seq, id, actor, type, card_id, attempt_id, step_id, payload, payload_hash, hash, prev_hash, created_at";

interface RawEventRow {
  seq: number;
  id: string;
  actor: string;
  type: string;
  card_id: string | null;
  attempt_id: string | null;
  step_id: string | null;
  payload: string;
  payload_hash: string;
  hash: string;
  prev_hash: string;
  created_at: string;
}

/** Called for every appended event matching the subscription's filter. */
export type EventSubscriber = (event: EventRecord) => void;

interface Subscription {
  filter: EventFilter;
  callback: EventSubscriber;
}

export class EventLog {
  private insertStmt: StatementSync;
  private lastEventStmt: StatementSync;
  private selectAllStmt: StatementSync;
  private selectBySeqStmt: StatementSync;
  private subscriptions = new Set<Subscription>();

  constructor(private db: DatabaseSync) {
    this.insertStmt = db.prepare(`
      INSERT INTO events (id, actor, type, card_id, attempt_id, step_id, payload, payload_hash, hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.lastEventStmt = db.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM events
      ORDER BY seq DESC
      LIMIT 1
    `);

    this.selectAllStmt = db.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM events
      ORDER BY seq ASC
    `);

    this.selectBySeqStmt = db.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM events
      WHERE seq = ?
    `);
  }

  /**
   * Chain hash over the event's identity, its association columns and the
   * payload *hash* — never the payload text.
   *
   * WHY the payload hash rather than the payload: the payload is the one field
   * that may legitimately be relocated (large blobs move to
   * `.sekhemet/artifacts/`, design §2044). Hashing its digest keeps the chain
   * verifiable after the move. Including `cardId`/`attemptId`/`stepId` makes
   * the new typed columns tamper-evident too — otherwise an attacker could
   * re-point an event at a different card without breaking the chain.
   */
  public static computeHash(input: {
    prevHash: string;
    seq: number;
    actor: string;
    type: string;
    payloadHash: string;
    id: string;
    cardId?: string | null;
    attemptId?: string | null;
    stepId?: string | null;
  }): string {
    const parts = [
      input.prevHash,
      String(input.seq),
      input.actor,
      input.type,
      input.cardId ?? "",
      input.attemptId ?? "",
      input.stepId ?? "",
      input.payloadHash,
      input.id,
    ];
    return createHash("sha256").update(parts.join(":")).digest("hex");
  }

  /**
   * Hash formula used before `payload_hash` existed.
   *
   * Retained so a database written by an earlier build still verifies rather
   * than reporting every one of its rows as corrupt — the empty `payload_hash`
   * left by the migration is what marks a row as belonging to that era.
   */
  private static computeLegacyHash(
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
      payloadHash: row.payload_hash,
      hash: row.hash,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
      ...(row.card_id ? { cardId: row.card_id } : {}),
      ...(row.attempt_id ? { attemptId: row.attempt_id } : {}),
      ...(row.step_id ? { stepId: row.step_id } : {}),
    };
  }

  public async append<T = unknown>(params: AppendEventParams<T>): Promise<EventRecord<T>> {
    const id = params.id ?? randomUUID();
    const payloadStr = JSON.stringify(params.payload);
    const payloadHash = canonicalPayloadHash(params.payload);
    const cardId = params.cardId ?? null;
    const attemptId = params.attemptId ?? null;
    const stepId = params.stepId ?? null;

    this.db.exec("BEGIN IMMEDIATE");
    let inserted: EventRecord<T>;
    try {
      const lastRow = this.lastEventStmt.get() as unknown as RawEventRow | undefined;
      const prevHash = lastRow ? lastRow.hash : GENESIS_PREV_HASH;
      const nextSeq = lastRow ? lastRow.seq + 1 : 1;
      const hash = EventLog.computeHash({
        prevHash,
        seq: nextSeq,
        actor: params.actor,
        type: params.type,
        payloadHash,
        id,
        cardId,
        attemptId,
        stepId,
      });

      const runResult = this.insertStmt.run(
        id,
        params.actor,
        params.type,
        cardId,
        attemptId,
        stepId,
        payloadStr,
        payloadHash,
        hash,
        prevHash,
      );
      const insertedSeq = Number(runResult.lastInsertRowid);

      const insertedRow = this.selectBySeqStmt.get(insertedSeq) as unknown as RawEventRow;

      this.db.exec("COMMIT");
      inserted = this.mapRow<T>(insertedRow);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    // Notified only after COMMIT, so a subscriber can never observe — or act
    // on — an event that a later failure rolled back.
    this.notify(inserted as EventRecord);
    return inserted;
  }

  /**
   * Stream appended events instead of polling the table.
   *
   * WHY: the dashboard's only alternative is re-querying the log on a timer,
   * which is both late and expensive on a board that is idle most of the time.
   * The subscription is in-process — it sees writes from this `EventLog`
   * instance, not from another process holding the same WAL file, which is the
   * correct scope for a local-first single-writer harness.
   *
   * Returns an unsubscribe function. Safe to call during dispatch.
   */
  public subscribe(filter: EventFilter, callback: EventSubscriber): () => void {
    const subscription: Subscription = { filter, callback };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  private notify(event: EventRecord): void {
    // Iterate a snapshot: a subscriber that unsubscribes itself (or another)
    // while being notified must not perturb this dispatch.
    for (const subscription of [...this.subscriptions]) {
      if (!this.subscriptions.has(subscription)) continue;
      const { filter } = subscription;
      if (filter.cardId !== undefined && event.cardId !== filter.cardId) continue;
      if (filter.type !== undefined && event.type !== filter.type) continue;
      if (filter.actor !== undefined && event.actor !== filter.actor) continue;
      try {
        subscription.callback(event);
      } catch {
        // A broken listener must not fail the append that already committed:
        // the log is the source of truth and its durability cannot depend on
        // whatever a UI or plugin does with the notification.
      }
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
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE seq >= ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(fromSeq, limit) as unknown as RawEventRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Every event of the given types, in order, from `fromSeq`.
   *
   * Uses the `type` index: the PM conversation and cycles are a few hundred
   * rows inside a ledger that grows by one `card/step` per Worker turn, and
   * scanning the whole chain to find them would grow with every run.
   */
  public async getEventsByTypes(
    types: string[],
    fromSeq = 1,
    limit = 10_000,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE seq >= ? AND type IN (${types.map(() => "?").join(", ")})
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(fromSeq, ...types, limit) as unknown as RawEventRow[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Every event belonging to one card, in order.
   *
   * This is the query the typed `card_id` column exists for: before it, card
   * association lived inside the payload JSON and the only way to answer it was
   * a full scan plus a JSON parse per row.
   */
  public async getEventsByCard(cardId: string, limit = 1000): Promise<EventRecord[]> {
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE card_id = ?
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(cardId, limit) as unknown as RawEventRow[];

    return rows.map((r) => this.mapRow(r));
  }

  /**
   * One card's events of the given types, in order, without the per-card
   * limit a long card's `card/step` stream would otherwise exhaust.
   */
  public async getEventsByCardAndTypes(
    cardId: string,
    types: string[],
    limit = 10_000,
  ): Promise<EventRecord[]> {
    if (types.length === 0) return [];
    const rows = this.db
      .prepare(`
        SELECT ${EVENT_COLUMNS}
        FROM events
        WHERE card_id = ? AND type IN (${types.map(() => "?").join(", ")})
        ORDER BY seq ASC
        LIMIT ?
      `)
      .all(cardId, ...types, limit) as unknown as RawEventRow[];
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

      // Recomputed from the stored payload rather than trusted from the
      // payload_hash column, so editing the payload breaks the chain even if
      // the column is left alone.
      const isLegacyRow = row.payload_hash === "";
      const recomputedPayloadHash = isLegacyRow
        ? ""
        : canonicalPayloadHash(JSON.parse(row.payload) as unknown);

      const expectedHash = isLegacyRow
        ? EventLog.computeLegacyHash(
            row.prev_hash,
            row.seq,
            row.actor,
            row.type,
            row.payload,
            row.id,
          )
        : EventLog.computeHash({
            prevHash: row.prev_hash,
            seq: row.seq,
            actor: row.actor,
            type: row.type,
            payloadHash: recomputedPayloadHash,
            id: row.id,
            cardId: row.card_id,
            attemptId: row.attempt_id,
            stepId: row.step_id,
          });

      if (row.hash !== expectedHash) {
        return {
          valid: false,
          totalEvents: rows.length,
          corruptedSeq: row.seq,
          reason: `Hash mismatch at seq ${row.seq}: expected ${expectedHash}, got ${row.hash}`,
        };
      }

      // The chain check above cannot see an edit that touched only the
      // payload_hash column, since it recomputes that value; compare it
      // explicitly so the stored digest is covered too.
      if (!isLegacyRow && row.payload_hash !== recomputedPayloadHash) {
        return {
          valid: false,
          totalEvents: rows.length,
          corruptedSeq: row.seq,
          reason: `Stored payload hash mismatch at seq ${row.seq}: expected ${recomputedPayloadHash}, got ${row.payload_hash}`,
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
