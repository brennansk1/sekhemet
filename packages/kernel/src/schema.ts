import type { DatabaseSync } from "node:sqlite";

export const KERNEL_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSON NOT NULL,
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK(tier IN ('initiative','epic','feature','story','task')),
  parent_id TEXT REFERENCES cards(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('backlog','ready','in_progress','verify','review','done','rejected','parked')),
  scope_files JSON NOT NULL DEFAULT '[]',
  step_budget INTEGER NOT NULL DEFAULT 50,
  steps_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards(parent_id);

CREATE TABLE IF NOT EXISTS checkpoints (
  card_id TEXT NOT NULL REFERENCES cards(id),
  step INTEGER NOT NULL,
  git_ref TEXT NOT NULL,
  gate_status TEXT NOT NULL,
  agent_model TEXT NOT NULL,
  agent_harness TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, step)
);
`;

export function initSchema(db: DatabaseSync): void {
  db.exec(KERNEL_SCHEMA_SQL);
}
