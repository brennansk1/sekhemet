import { DatabaseSync } from "node:sqlite";

/** Open the vault database: WAL, synchronous NORMAL, foreign keys on, schema created. */
export function openVaultDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (project_id, key)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL CHECK (action IN ('set', 'get', 'list', 'delete')),
      project TEXT NOT NULL,
      key TEXT,
      at INTEGER NOT NULL
    );
  `);
  return db;
}

/** A timestamp strictly after `previous`. */
export function monotonicNow(previous: number, now: number = Date.now()): number {
  return now > previous ? now : previous + 1;
}
