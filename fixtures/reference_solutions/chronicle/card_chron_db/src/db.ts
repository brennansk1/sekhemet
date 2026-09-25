import { DatabaseSync } from "node:sqlite";

/** Open (or create) the ledger database in WAL mode with its schema. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS chronicle_events (
      sequence_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL,
      idempotency_key TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_chronicle_hash ON chronicle_events (hash);
  `);
  return db;
}
