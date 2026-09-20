import type { DatabaseSync } from "node:sqlite";
import { keyBetween } from "./order_key.js";
import { EVENT_ACTORS } from "./types.js";

/** The actor CHECK (K5): the design's five plus the documented extensions. */
export const EVENT_ACTOR_CHECK = `actor IN (${EVENT_ACTORS.map((a) => `'${a}'`).join(",")})`;

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
  acceptance_tests JSON NOT NULL DEFAULT '[]',
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
  estimate REAL,
  labels JSON NOT NULL DEFAULT '[]',
  epic_id TEXT,
  cycle_id TEXT,
  assignee TEXT,
  due_date TEXT,
  project_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const CARD_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_parent ON cards(parent_id);
CREATE INDEX IF NOT EXISTS idx_cards_order ON cards(status, order_key);
CREATE INDEX IF NOT EXISTS idx_cards_project ON cards(project_id, status);
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
const RUN_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_attempts_card ON attempts(card_id);
CREATE INDEX IF NOT EXISTS idx_steps_attempt_index ON steps(attempt_id, step_index);
CREATE INDEX IF NOT EXISTS idx_gate_results_attempt ON gate_results(attempt_id);
CREATE INDEX IF NOT EXISTS idx_evidence_card ON evidence_bundles(card_id);
CREATE INDEX IF NOT EXISTS idx_decisions_status ON decision_requests(status);
CREATE INDEX IF NOT EXISTS idx_competence_class ON competence_entries(card_class, model_id);
CREATE INDEX IF NOT EXISTS idx_deps_on ON card_dependencies(depends_on_card_id);
`;

export const KERNEL_INDEX_SQL = `${EVENT_INDEX_SQL}${CARD_INDEX_SQL}${RUN_INDEX_SQL}`;

const EVENTS_TABLE_BODY = `
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL CHECK(${EVENT_ACTOR_CHECK}),
  type TEXT NOT NULL,
  card_id TEXT,
  attempt_id TEXT,
  step_id TEXT,
  payload JSON NOT NULL,
  payload_hash TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
`;

/**
 * Which rung of the repair ladder and which tool vocabulary produced an
 * attempt (K16, design §2677-2679).
 *
 * Both carry a DEFAULT because they are also added to databases that already
 * have attempt rows: `ALTER TABLE ... ADD COLUMN` refuses a NOT NULL column
 * without one. Rung 1 and arm A are the ladder's and the roster's starting
 * points, so an un-annotated legacy row reads as the plain first try it was.
 */
const ATTEMPT_LADDER_COLUMNS = `rung INTEGER NOT NULL DEFAULT 1 CHECK(rung BETWEEN 1 AND 4),
  tool_arm TEXT NOT NULL DEFAULT 'A' CHECK(tool_arm IN ('A','B','C'))`;

/**
 * The review surface the design puts in the bundle's row (K19, design
 * §2720-2731), so Review can be listed and filtered without opening every
 * bundle file on disk.
 */
const EVIDENCE_REVIEW_COLUMNS = `structural_diff TEXT,
  gate_results_summary JSON NOT NULL DEFAULT '{}',
  passed_checks JSON NOT NULL DEFAULT '[]',
  failed_checks JSON NOT NULL DEFAULT '[]',
  abandoned_hypotheses JSON NOT NULL DEFAULT '[]'`;

/**
 * Projections derived from the ledger (K8): every table below is rebuilt
 * from events by `ProjectionEngine.rebuild`, and `verify` checks the rebuild
 * is byte-identical to what is stored.
 */
const RUN_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  git_branch TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  review_minutes_per_day INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_dependencies (
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'declared',
  created_at TEXT NOT NULL,
  PRIMARY KEY (card_id, depends_on_card_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  ${ATTEMPT_LADDER_COLUMNS},
  model_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','passed','failed','halted')),
  stop_reason TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  seconds_used REAL NOT NULL DEFAULT 0,
  evidence_id TEXT,
  forked_from_attempt TEXT,
  forked_from_step INTEGER,
  resumed_from_step INTEGER,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  calls JSON NOT NULL DEFAULT '[]',
  context_pack_id TEXT,
  repo_state_hash TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  git_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id, step_index)
);

CREATE TABLE IF NOT EXISTS gate_results (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,
  step_id TEXT,
  gate TEXT NOT NULL,
  layer TEXT NOT NULL CHECK(layer IN ('static','functional','robustness','security','visual','hygiene')),
  status TEXT NOT NULL CHECK(status IN ('pass','fail')),
  exit_code INTEGER NOT NULL DEFAULT 0,
  failures JSON NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_bundles (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  stop_reason TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  files_touched JSON NOT NULL DEFAULT '[]',
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  trajectory_ref TEXT,
  ${EVIDENCE_REVIEW_COLUMNS},
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_requests (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT NOT NULL,
  options JSON NOT NULL,
  recommendation_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','timed_out')),
  selected_option_index INTEGER,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS competence_entries (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  card_class TEXT NOT NULL,
  files_touched_count INTEGER NOT NULL,
  difficulty TEXT NOT NULL,
  model_id TEXT NOT NULL,
  tool_arm TEXT NOT NULL,
  step_budget INTEGER NOT NULL,
  steps_used INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  tokens_used INTEGER NOT NULL,
  wall_clock_seconds REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
`;

export const KERNEL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (${EVENTS_TABLE_BODY});

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
${RUN_TABLES_SQL}`;

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
  ["acceptance_tests", "acceptance_tests JSON NOT NULL DEFAULT '[]'"],
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
  // Team practice fields (PM_CONTRACT §2): Linear/Jira/GitHub vocabulary.
  ["estimate", "estimate REAL"],
  ["labels", "labels JSON NOT NULL DEFAULT '[]'"],
  ["epic_id", "epic_id TEXT"],
  ["cycle_id", "cycle_id TEXT"],
  ["assignee", "assignee TEXT"],
  ["due_date", "due_date TEXT"],
  ["project_id", "project_id TEXT"],
];

const ADDED_ATTEMPT_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["rung", "rung INTEGER NOT NULL DEFAULT 1 CHECK(rung BETWEEN 1 AND 4)"],
  ["tool_arm", "tool_arm TEXT NOT NULL DEFAULT 'A' CHECK(tool_arm IN ('A','B','C'))"],
];

const ADDED_EVIDENCE_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["structural_diff", "structural_diff TEXT"],
  ["gate_results_summary", "gate_results_summary JSON NOT NULL DEFAULT '{}'"],
  ["passed_checks", "passed_checks JSON NOT NULL DEFAULT '[]'"],
  ["failed_checks", "failed_checks JSON NOT NULL DEFAULT '[]'"],
  ["abandoned_hypotheses", "abandoned_hypotheses JSON NOT NULL DEFAULT '[]'"],
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
  /** True when `events` was rebuilt to add the actor CHECK (K5). */
  rebuiltEventsTable: boolean;
}

/**
 * Add the actor CHECK (K5) to an `events` table created before it. A CHECK
 * is part of the DDL, so this is copy-and-swap; the rows (and so the hash
 * chain, which never covered the DDL) are copied verbatim. Skipped, leaving
 * the table as it is, when an existing row carries an actor outside the
 * enum: the ledger is append-only and is never rewritten to fit.
 */
function rebuildEventsTableIfUnchecked(db: DatabaseSync): boolean {
  if (!tableExists(db, "events")) return false;
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'")
    .get() as { sql?: string } | undefined;
  if ((row?.sql ?? "").includes("CHECK(actor IN")) return false;
  const bad = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE NOT (${EVENT_ACTOR_CHECK})`)
    .get() as {
    n: number;
  };
  if (bad.n > 0) return false;
  const cols = [...columnNames(db, "events")].join(", ");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE events_checked (${EVENTS_TABLE_BODY})`);
    db.exec(`INSERT INTO events_checked (${cols}) SELECT ${cols} FROM events`);
    db.exec("DROP TABLE events");
    db.exec("ALTER TABLE events_checked RENAME TO events");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return true;
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
    ...addMissingColumns(db, "attempts", ADDED_ATTEMPT_COLUMNS),
    ...addMissingColumns(db, "evidence_bundles", ADDED_EVIDENCE_COLUMNS),
  ];
  // Indexes over freshly added columns can only be created once they exist.
  db.exec(KERNEL_INDEX_SQL);
  const backfilledOrderKeys = backfillOrderKeys(db);
  const rebuiltEventsTable = rebuildEventsTableIfUnchecked(db);
  if (rebuiltEventsTable) db.exec(EVENT_INDEX_SQL);

  return { addedColumns, rebuiltCardsTable, backfilledOrderKeys, rebuiltEventsTable };
}

export function initSchema(db: DatabaseSync): SchemaMigrationReport {
  db.exec(KERNEL_PRAGMA_SQL);
  db.exec(KERNEL_SCHEMA_SQL);
  return migrateSchema(db);
}
