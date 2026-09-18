import type { DatabaseSync } from "node:sqlite";
import { keyBetween } from "./order_key.js";

/**
 * Connection pragmas (design §2098-2101).
 *
 * `busy_timeout` matters more than it looks: the harness runs the dashboard,
 * the CLI and the card loop against the same WAL file, and without a timeout a
 * writer that meets a concurrent write fails instantly with SQLITE_BUSY instead
 * of waiting the few milliseconds the other transaction needs.
 */
export const KERNEL_PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

const CARD_STATUS_CHECK =
  "status IN ('backlog','ready','planning','in_progress','verify','review','done','rejected','parked')";

/** Full `cards` shape, shared by first-time creation and legacy-table rebuild. */
const CARDS_TABLE_BODY = `
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK(tier IN ('initiative','epic','feature','story','task')),
  parent_id TEXT REFERENCES cards(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(${CARD_STATUS_CHECK}),
  scope_files JSON NOT NULL DEFAULT '[]',
  step_budget INTEGER NOT NULL DEFAULT 50,
  steps_used INTEGER NOT NULL DEFAULT 0,
  spec TEXT,
  acceptance_criteria JSON NOT NULL DEFAULT '[]',
  difficulty INTEGER CHECK(difficulty IS NULL OR (difficulty >= 1 AND difficulty <= 10)),
  token_budget INTEGER,
  seconds_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  seconds_used INTEGER NOT NULL DEFAULT 0,
  model_route_planner TEXT,
  model_route_executor TEXT,
  depends_on JSON NOT NULL DEFAULT '[]',
  context_pack_id TEXT,
  evidence_id TEXT,
  external_ref JSON,
  stop_reason TEXT,
  priority REAL NOT NULL DEFAULT 0.0,
  order_key TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const CARD_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards(parent_id);
CREATE INDEX IF NOT EXISTS idx_cards_order ON cards(status, order_key);
`;

const EVENT_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_card_id ON events(card_id);
CREATE INDEX IF NOT EXISTS idx_events_attempt_id ON events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_events_step_id ON events(step_id);
`;

/**
 * Indexes are created by `migrateSchema`, never inline with the tables.
 *
 * WHY: on a database written by an older build, `CREATE TABLE IF NOT EXISTS` is
 * a no-op, so an index over a column this release added would be built against
 * a table that does not have it yet and the whole `initSchema` would fail. The
 * columns must land first.
 */
export const KERNEL_INDEX_SQL = `${EVENT_INDEX_SQL}${CARD_INDEX_SQL}`;

export const KERNEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  card_id TEXT,
  attempt_id TEXT,
  step_id TEXT,
  payload JSON NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cards (${CARDS_TABLE_BODY});

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

/** Columns added after the first release, applied to databases already on disk. */
const ADDED_EVENT_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["card_id", "card_id TEXT"],
  ["attempt_id", "attempt_id TEXT"],
  ["step_id", "step_id TEXT"],
  ["payload_hash", "payload_hash TEXT NOT NULL DEFAULT ''"],
];

const ADDED_CARD_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["spec", "spec TEXT"],
  ["acceptance_criteria", "acceptance_criteria JSON NOT NULL DEFAULT '[]'"],
  [
    "difficulty",
    "difficulty INTEGER CHECK(difficulty IS NULL OR (difficulty >= 1 AND difficulty <= 10))",
  ],
  ["token_budget", "token_budget INTEGER"],
  ["seconds_budget", "seconds_budget INTEGER"],
  ["tokens_used", "tokens_used INTEGER NOT NULL DEFAULT 0"],
  ["seconds_used", "seconds_used INTEGER NOT NULL DEFAULT 0"],
  ["model_route_planner", "model_route_planner TEXT"],
  ["model_route_executor", "model_route_executor TEXT"],
  ["depends_on", "depends_on JSON NOT NULL DEFAULT '[]'"],
  ["context_pack_id", "context_pack_id TEXT"],
  ["evidence_id", "evidence_id TEXT"],
  ["external_ref", "external_ref JSON"],
  ["stop_reason", "stop_reason TEXT"],
  ["priority", "priority REAL NOT NULL DEFAULT 0.0"],
  ["order_key", "order_key TEXT NOT NULL DEFAULT ''"],
  ["blocked_reason", "blocked_reason TEXT"],
];

/** Columns copied when the `cards` table is rebuilt to widen its CHECK. */
const LEGACY_CARD_COLUMNS = [
  "id",
  "tier",
  "parent_id",
  "title",
  "status",
  "scope_files",
  "step_budget",
  "steps_used",
  "created_at",
  "updated_at",
];

export interface SchemaMigrationReport {
  /** Columns added to existing tables, as `table.column`. */
  addedColumns: string[];
  /** True when the `cards` table was rebuilt to widen the status CHECK. */
  rebuiltCardsTable: boolean;
  /** Rows given a generated `order_key` because they predate the column. */
  backfilledOrderKeys: number;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Add any missing column, guarded by `PRAGMA table_info`.
 *
 * `ALTER TABLE ... ADD COLUMN` is the only schema change SQLite performs in
 * place, so every widening of these tables must be expressible as one. That is
 * why every added column is nullable or carries a DEFAULT: a `NOT NULL` column
 * without one cannot be added to a table that already has rows.
 */
function addMissingColumns(
  db: DatabaseSync,
  table: string,
  columns: ReadonlyArray<[string, string]>,
): string[] {
  if (!tableExists(db, table)) return [];
  const existing = columnNames(db, table);
  const added: string[] = [];
  for (const [name, ddl] of columns) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    added.push(`${table}.${name}`);
  }
  return added;
}

/**
 * Rebuild `cards` when its stored CHECK predates the `planning` column.
 *
 * A CHECK constraint is baked into the table's DDL, so unlike a column it
 * cannot be widened in place — the only options are copy-and-swap or leaving
 * existing databases unable to store a status the state machine now produces.
 * Guarded on the recorded DDL text so this runs at most once per database.
 */
function rebuildCardsTableIfStale(db: DatabaseSync): boolean {
  if (!tableExists(db, "cards")) return false;

  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cards'")
    .get() as { sql?: string } | undefined;
  const ddl = row?.sql ?? "";
  if (ddl.includes("'planning'")) return false;

  const preserved = LEGACY_CARD_COLUMNS.filter((c) => columnNames(db, "cards").has(c));
  const columnList = preserved.join(", ");

  // Foreign keys must be off across the swap: `checkpoints` references
  // `cards(id)`, and the drop would otherwise be refused. The pragma is a no-op
  // inside a transaction, so it is toggled outside one.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE cards_migrated (${CARDS_TABLE_BODY})`);
    db.exec(`INSERT INTO cards_migrated (${columnList}) SELECT ${columnList} FROM cards`);
    db.exec("DROP TABLE cards");
    db.exec("ALTER TABLE cards_migrated RENAME TO cards");
    db.exec(CARD_INDEX_SQL);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");
  return true;
}

/**
 * Give pre-existing rows an `order_key`.
 *
 * Rows added before the column default to the empty string, which sorts before
 * every real key and would pile the whole backlog at the top of every column.
 * Seeding them in creation order preserves the ordering the board showed
 * before the migration.
 */
function backfillOrderKeys(db: DatabaseSync): number {
  if (!tableExists(db, "cards")) return 0;
  if (!columnNames(db, "cards").has("order_key")) return 0;

  const rows = db
    .prepare("SELECT id FROM cards WHERE order_key = '' ORDER BY created_at ASC, id ASC")
    .all() as unknown as { id: string }[];
  if (rows.length === 0) return 0;

  const maxRow = db.prepare("SELECT MAX(order_key) AS maxKey FROM cards").get() as {
    maxKey?: string | null;
  };
  let previous = maxRow?.maxKey ? maxRow.maxKey : null;

  const update = db.prepare("UPDATE cards SET order_key = ? WHERE id = ?");
  for (const { id } of rows) {
    previous = keyBetween(previous, null);
    update.run(previous, id);
  }
  return rows.length;
}

/**
 * Bring an existing database up to the current schema without losing rows.
 *
 * Idempotent: safe to run on a fresh database, on one written by an older
 * build, and twice in a row.
 */
export function migrateSchema(db: DatabaseSync): SchemaMigrationReport {
  const rebuiltCardsTable = rebuildCardsTableIfStale(db);
  const addedColumns = [
    ...addMissingColumns(db, "events", ADDED_EVENT_COLUMNS),
    ...addMissingColumns(db, "cards", ADDED_CARD_COLUMNS),
  ];
  // Indexes over freshly added columns can only be created once they exist.
  db.exec(KERNEL_INDEX_SQL);
  const backfilledOrderKeys = backfillOrderKeys(db);

  return { addedColumns, rebuiltCardsTable, backfilledOrderKeys };
}

export function initSchema(db: DatabaseSync): SchemaMigrationReport {
  db.exec(KERNEL_PRAGMA_SQL);
  db.exec(KERNEL_SCHEMA_SQL);
  return migrateSchema(db);
}
