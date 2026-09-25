import { DatabaseSync } from "node:sqlite";
import type { VerificationStatus, WebhookEvent } from "./types.js";

export type NewEvent = Omit<WebhookEvent, "id">;

interface Row {
  id: number;
  source: string;
  method: string;
  path: string;
  headers_json: string;
  body: Uint8Array;
  received_at: number;
  verification: VerificationStatus;
}

function toEvent(row: Row): WebhookEvent {
  return {
    id: row.id,
    source: row.source,
    method: row.method,
    path: row.path,
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    body: Buffer.from(row.body),
    receivedAt: row.received_at,
    verification: row.verification,
  };
}

/** Received webhooks, raw bytes included, in one SQLite file. */
export class EventStore {
  private readonly db: DatabaseSync;
  private open = true;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        body BLOB NOT NULL,
        received_at INTEGER NOT NULL,
        verification TEXT NOT NULL CHECK (verification IN ('verified', 'failed', 'unsigned'))
      )
    `);
  }

  insert(event: NewEvent): WebhookEvent {
    const result = this.db
      .prepare(
        "INSERT INTO webhook_events (source, method, path, headers_json, body, received_at, verification) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        event.source,
        event.method,
        event.path,
        JSON.stringify(event.headers),
        event.body,
        event.receivedAt,
        event.verification,
      );
    return { ...event, id: Number(result.lastInsertRowid) };
  }

  get(id: number): WebhookEvent | undefined {
    const row = this.db.prepare("SELECT * FROM webhook_events WHERE id = ?").get(id) as
      | unknown
      | undefined;
    return row ? toEvent(row as Row) : undefined;
  }

  list(options: { source?: string; limit?: number } = {}): WebhookEvent[] {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be >= 1");
    const rows =
      options.source === undefined
        ? this.db.prepare("SELECT * FROM webhook_events ORDER BY id DESC LIMIT ?").all(limit)
        : this.db
            .prepare("SELECT * FROM webhook_events WHERE source = ? ORDER BY id DESC LIMIT ?")
            .all(options.source, limit);
    return (rows as unknown as Row[]).map(toEvent);
  }

  count(): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM webhook_events").get() as unknown as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.db.close();
  }
}
