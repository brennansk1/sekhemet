import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.js";
import { GENESIS_HASH, hashEvent } from "./hasher.js";
import type { AuditReport, ChronicleEvent } from "./types.js";
import { verifyChain } from "./verifier.js";

interface Row {
  sequence_number: number;
  id: string;
  timestamp: number;
  type: string;
  payload_json: string;
  previous_hash: string;
  hash: string;
  idempotency_key: string | null;
}

function toEvent(row: Row): ChronicleEvent {
  const event: ChronicleEvent = {
    id: row.id,
    sequenceNumber: row.sequence_number,
    timestamp: row.timestamp,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    previousHash: row.previous_hash,
    hash: row.hash,
  };
  if (row.idempotency_key !== null) event.idempotencyKey = row.idempotency_key;
  return event;
}

/** An append-only, hash-chained event ledger on one SQLite file. */
export class Ledger {
  private readonly db: DatabaseSync;
  private open = true;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  append(input: { type: string; payload: unknown; idempotencyKey?: string }): ChronicleEvent {
    if (input.idempotencyKey !== undefined) {
      const existing = this.db
        .prepare("SELECT * FROM chronicle_events WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as unknown as Row | undefined;
      if (existing) return toEvent(existing);
    }
    const last = this.db
      .prepare(
        "SELECT sequence_number, hash FROM chronicle_events ORDER BY sequence_number DESC LIMIT 1",
      )
      .get() as unknown as { sequence_number: number; hash: string } | undefined;
    const partial: Omit<ChronicleEvent, "hash"> = {
      id: randomUUID(),
      sequenceNumber: (last?.sequence_number ?? 0) + 1,
      timestamp: Date.now(),
      type: input.type,
      payload: input.payload,
      previousHash: last?.hash ?? GENESIS_HASH,
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    };
    const event: ChronicleEvent = { ...partial, hash: hashEvent(partial) };
    this.db
      .prepare(
        "INSERT INTO chronicle_events (sequence_number, id, timestamp, type, payload_json, previous_hash, hash, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.sequenceNumber,
        event.id,
        event.timestamp,
        event.type,
        JSON.stringify(event.payload),
        event.previousHash,
        event.hash,
        event.idempotencyKey ?? null,
      );
    return event;
  }

  get(id: string): ChronicleEvent | undefined {
    const row = this.db.prepare("SELECT * FROM chronicle_events WHERE id = ?").get(id) as unknown as
      | Row
      | undefined;
    return row ? toEvent(row) : undefined;
  }

  list(): ChronicleEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM chronicle_events ORDER BY sequence_number")
        .all() as unknown as Row[]
    ).map(toEvent);
  }

  audit(): AuditReport {
    return verifyChain(this.list());
  }

  /** Safe to call more than once. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}
