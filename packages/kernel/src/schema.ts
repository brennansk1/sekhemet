import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { assigneeTarget } from "./assignee.js";
import { CARD_COLUMN_TABLE, type CardColumn, cardsTableDdl } from "./card_columns.js";
import { EventLog } from "./log.js";
import { keyBetween } from "./order_key.js";
import { copyDatabase, databaseFile } from "./sqlite_file.js";
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
/**
 * The power-loss window, decided by measurement (kernel rule 38, K-N11-1):
 * `synchronous = FULL` syncs the WAL at every commit; on darwin a plain
 * fsync leaves the write in the drive's cache, so `fullfsync` (commits) and
 * `checkpoint_fullfsync` (checkpoints) are on too. Adopted because the p95
 * single append under it (4.0-5.0 ms on the reference SSD) is within the
 * 25 ms bound and adds about 0.5 % to a median Worker step (bound: 1 %).
 */
export const LEDGER_SYNC_DECISION = {
  synchronous: "FULL",
  fullfsync: true,
  checkpointFullfsync: true,
  p95BoundMs: 25,
  evidence: "evidence/append_sync_2026-10-05.json",
} as const;

/**
 * `busy_timeout` comes first: every pragma before it runs with no busy
 * handler, and `journal_mode = WAL` reads the file, so a second process
 * opening the ledger while the first recovers its WAL index
 * (SQLITE_BUSY_RECOVERY) or holds it failed at once with "database is
 * locked" instead of waiting (RUN-2, runtime.md).
 */
export const KERNEL_PRAGMA_SQL = `
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = ${LEDGER_SYNC_DECISION.synchronous};
PRAGMA fullfsync = ${LEDGER_SYNC_DECISION.fullfsync ? "ON" : "OFF"};
PRAGMA checkpoint_fullfsync = ${LEDGER_SYNC_DECISION.checkpointFullfsync ? "ON" : "OFF"};
PRAGMA foreign_keys = ON;
`;

/** The `cards` shape, derived from the one card column table (rule 38, K-N4-4). */
const CARDS_TABLE_BODY = `
${cardsTableDdl()}
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

/** Who built an attempt or a checkpoint (K-N6-4), as `{kind, id}` JSON. */
const ATTEMPT_BUILT_BY_COLUMN = "built_by JSON";
const CHECKPOINT_BUILT_BY_COLUMN = "built_by JSON";
/** Where a gate result came from (K-N8-3); every result before it was a local run. */
const GATE_SOURCE_COLUMN =
  "source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local','external'))";
const GATE_EXTERNAL_REF_COLUMN = "external_ref JSON";

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
  completed_at TEXT,
  ${ATTEMPT_BUILT_BY_COLUMN}
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
  created_at TEXT NOT NULL,
  ${GATE_SOURCE_COLUMN},
  ${GATE_EXTERNAL_REF_COLUMN}
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
  ${CHECKPOINT_BUILT_BY_COLUMN},
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

/** Every declared card column, added where an older database lacks it (from the column table). */
const ADDED_CARD_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = CARD_COLUMN_TABLE.map(
  (c) => [c.column, c.ddl] as [string, string],
);

const ADDED_ATTEMPT_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["rung", "rung INTEGER NOT NULL DEFAULT 1 CHECK(rung BETWEEN 1 AND 4)"],
  ["tool_arm", "tool_arm TEXT NOT NULL DEFAULT 'A' CHECK(tool_arm IN ('A','B','C'))"],
];

/** Per-step phase and generation facts (worker-loop WL-T3-1, WL-M3-4, WL-M2-5, WL-T3-13). */
const ADDED_STEP_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["sample", "sample INTEGER"],
  ["phase", "phase TEXT"],
  ["finish_reason", "finish_reason TEXT"],
  ["thinking_tokens", "thinking_tokens INTEGER"],
  ["answer_tokens", "answer_tokens INTEGER"],
  ["format_errors", "format_errors INTEGER"],
  ["prose_only", "prose_only INTEGER"],
  ["cached_prompt_tokens", "cached_prompt_tokens INTEGER"],
  ["evaluated_prompt_tokens", "evaluated_prompt_tokens INTEGER"],
  ["draft_tokens", "draft_tokens INTEGER"],
  ["draft_accepted_tokens", "draft_accepted_tokens INTEGER"],
];

const ADDED_EVIDENCE_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["structural_diff", "structural_diff TEXT"],
  ["gate_results_summary", "gate_results_summary JSON NOT NULL DEFAULT '{}'"],
  ["passed_checks", "passed_checks JSON NOT NULL DEFAULT '[]'"],
  ["failed_checks", "failed_checks JSON NOT NULL DEFAULT '[]'"],
  ["abandoned_hypotheses", "abandoned_hypotheses JSON NOT NULL DEFAULT '[]'"],
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
  /** The numbered migrations applied by this open (K-N4-1). */
  applied: number[];
  /** The backup written before them, when any ran (K-N4-5). */
  backupPath?: string;
}

/** A migration refused rather than lose data or open a ledger it cannot serve. */
export class MigrationRefused extends Error {
  constructor(
    message: string,
    /** Set on the refusal of a database newer than this build (rule 38, REL-18). */
    public readonly newer?: { stored: number; current: number; preMigrationBackup?: string },
  ) {
    super(message);
    this.name = "MigrationRefused";
  }
}

/** What a migration may do beyond plain SQL, safely. */
export interface MigrationTools {
  /**
   * Copy-and-swap `table` to `body`, copying every column the two share.
   * Refused (MigrationRefused) when a column it would drop holds a non-null
   * value (K-N4-3): the transaction rolls back and the database is unchanged.
   */
  rebuildTable(table: string, body: string): void;
  /** The legacy catch-up's findings, for the report. */
  report: Omit<SchemaMigrationReport, "applied" | "backupPath">;
  /**
   * The install's person, as the harness knows them (git's `user.email`, or
   * the OS user): kept in the private part of a local person a migration
   * creates (rule 19, K-N6-6).
   */
  localPerson?: { email?: string; name?: string };
}

/** One numbered, forward-only schema change (kernel rule 38). */
export interface Migration {
  version: number;
  name: string;
  /** Foreign keys off across it (a rebuild of a referenced table); toggled outside the transaction. */
  foreignKeysOff?: boolean;
  up(db: DatabaseSync, tools: MigrationTools): void;
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

function rebuildTable(db: DatabaseSync, table: string, body: string): void {
  const before = columnNames(db, table);
  db.exec(`CREATE TABLE ${table}__migrated (${body})`);
  const after = columnNames(db, `${table}__migrated`);
  for (const dropped of [...before].filter((c) => !after.has(c))) {
    const held = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${dropped} IS NOT NULL`)
      .get() as { n: number };
    if (held.n > 0) {
      throw new MigrationRefused(
        `refusing to remove ${table}.${dropped}: ${held.n} row(s) hold a value (kernel rule 38)`,
      );
    }
  }
  const shared = [...before].filter((c) => after.has(c)).join(", ");
  db.exec(`INSERT INTO ${table}__migrated (${shared}) SELECT ${shared} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}__migrated RENAME TO ${table}`);
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
 * A numbered migration that adds one column to a table on disk; the column
 * is declared where its table is (for `cards`, the column table), so a fresh
 * database has it already and this is a no-op there.
 */
export function addColumnMigration(
  version: number,
  table: string,
  column: string,
  ddl: string,
): Migration {
  return {
    version,
    name: `add ${table}.${column}`,
    up: (db, tools) => {
      tools.report.addedColumns.push(...addMissingColumns(db, table, [[column, ddl]]));
    },
  };
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
 * Migration 1: bring a database written before numbered migrations to this
 * schema without losing a row. Its tables are created if missing; a `cards`
 * table whose CHECK predates `planning` is rebuilt keeping every column (it
 * used to keep ten and drop the rest); missing columns are added; old rows
 * get order keys; an `events` table without the actor CHECK (K5) is rebuilt,
 * its rows (and so the chain, which never covered the DDL) copied verbatim —
 * unless a row carries an actor outside the enum: the ledger is never
 * rewritten to fit.
 */
function legacyCatchUp(db: DatabaseSync, tools: MigrationTools): void {
  const cardsDdl = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'cards'").get() as
      | { sql?: string }
      | undefined
  )?.sql;
  const eventsDdl = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'").get() as
      | { sql?: string }
      | undefined
  )?.sql;
  db.exec(KERNEL_SCHEMA_SQL);
  if (cardsDdl !== undefined && !cardsDdl.includes("'planning'")) {
    tools.rebuildTable("cards", CARDS_TABLE_BODY);
    tools.report.rebuiltCardsTable = true;
  }
  tools.report.addedColumns.push(
    ...addMissingColumns(db, "events", ADDED_EVENT_COLUMNS),
    ...addMissingColumns(db, "cards", ADDED_CARD_COLUMNS),
    ...addMissingColumns(db, "attempts", ADDED_ATTEMPT_COLUMNS),
    ...addMissingColumns(db, "steps", ADDED_STEP_COLUMNS),
    ...addMissingColumns(db, "evidence_bundles", ADDED_EVIDENCE_COLUMNS),
  );
  tools.report.backfilledOrderKeys = backfillOrderKeys(db);
  if (eventsDdl !== undefined && !eventsDdl.includes("CHECK(actor IN")) {
    const bad = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE NOT (${EVENT_ACTOR_CHECK})`)
      .get() as { n: number };
    if (bad.n === 0) {
      tools.rebuildTable("events", EVENTS_TABLE_BODY);
      tools.report.rebuiltEventsTable = true;
    }
  }
}

/**
 * Hash chain v3 (NEW-kernel-1, NEW-kernel-2): the formula version per row,
 * the principal, `on_behalf_of` and the commitment to the private part. All
 * nullable: a row written before v3 has none and verifies by its own formula
 * (rule 11).
 */
const LEDGER_V3_EVENT_COLUMNS: ReadonlyArray<[column: string, ddl: string]> = [
  ["hash_version", "hash_version INTEGER"],
  ["principal", "principal TEXT"],
  ["on_behalf_of", "on_behalf_of TEXT"],
  ["commitment", "commitment TEXT"],
];

/**
 * The private part of an event (rule 33) and the append-only guard (rule 8,
 * K-N1-2). A private row may be deleted — only by a recorded erasure (rule
 * 34) — but never altered. The triggers are created here, never in
 * `KERNEL_SCHEMA_SQL`, because migration 1 may rebuild `events`, and a
 * rebuild drops the old table's triggers.
 */
const LEDGER_V3_SQL = `
CREATE TABLE IF NOT EXISTS event_private (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  salt TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_principal ON events(principal);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only (kernel rule 8)'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only (kernel rule 8)'); END;
CREATE TRIGGER IF NOT EXISTS event_private_no_update BEFORE UPDATE ON event_private
BEGIN SELECT RAISE(ABORT, 'a private part is never altered, only removed by a recorded erasure (kernel rule 34)'); END;
`;

function ledgerV3(db: DatabaseSync, tools?: MigrationTools): void {
  const added = addMissingColumns(db, "events", LEDGER_V3_EVENT_COLUMNS);
  tools?.report.addedColumns.push(...added);
  db.exec(LEDGER_V3_SQL);
}

/** Every table and column of the current schema, on an empty database. */
function createCurrentSchema(db: DatabaseSync): void {
  db.exec(KERNEL_SCHEMA_SQL);
  addMissingColumns(db, "events", ADDED_EVENT_COLUMNS);
  addMissingColumns(db, "attempts", ADDED_ATTEMPT_COLUMNS);
  addMissingColumns(db, "steps", ADDED_STEP_COLUMNS);
  addMissingColumns(db, "evidence_bundles", ADDED_EVIDENCE_COLUMNS);
  ledgerV3(db);
}

/** A numbered migration adding one `cards` column, its DDL read from the column table. */
function cardColumnMigration(version: number, column: string): Migration {
  const entry = (CARD_COLUMN_TABLE as readonly CardColumn[]).find((c) => c.column === column);
  if (!entry) throw new Error(`No card column ${column} in the column table`);
  return addColumnMigration(version, "cards", column, entry.ddl);
}

/**
 * K-N9-5: every card that predates the stored kind is given, once, the kind,
 * change and split its own `card/created` payload yields — the same values
 * the replay projection gives that event (the column table's `fromPayload`),
 * so the migrated rows and a rebuild agree, and nothing re-derives it later.
 */
function backfillCardKinds(db: DatabaseSync): void {
  if (!tableExists(db, "cards")) return;
  const columns = new Map(
    (CARD_COLUMN_TABLE as readonly CardColumn[]).map((c) => [c.column, c] as const),
  );
  const created = db.prepare(
    "SELECT payload FROM events WHERE type = 'card/created' AND card_id = ? ORDER BY seq LIMIT 1",
  );
  const update = db.prepare("UPDATE cards SET kind = ?, change = ?, split = ? WHERE id = ?");
  const rows = db.prepare("SELECT id, title, labels, scope_files FROM cards").all() as {
    id: string;
    title: string;
    labels: string | null;
    scope_files: string | null;
  }[];
  const parse = (raw: string | null): unknown[] => {
    try {
      return raw ? (JSON.parse(raw) as unknown[]) : [];
    } catch {
      return [];
    }
  };
  for (const row of rows) {
    const recorded = created.get(row.id) as { payload: string } | undefined;
    const payload: Record<string, unknown> = recorded
      ? (JSON.parse(recorded.payload) as Record<string, unknown>)
      : { title: row.title, labels: parse(row.labels), scopeFiles: parse(row.scope_files) };
    const value = (column: string) =>
      columns.get(column)?.fromPayload(payload, { orderKey: () => "" }) ?? null;
    update.run(value("kind"), value("change"), value("split"), row.id);
  }
}

/**
 * K-N6-6: every card holding the legacy `assignee` string gets the owner or
 * delegate it names, recorded as `card/delegated` or `card/owner_changed`
 * (and `person/created` for a name no person carries yet), so replay agrees.
 * The column keeps its history; nothing writes it any more.
 */
function mapLegacyAssignee(db: DatabaseSync, tools: MigrationTools): void {
  if (!tableExists(db, "cards")) return;
  const rows = db
    .prepare(
      "SELECT id, assignee, owner, delegate FROM cards WHERE assignee IS NOT NULL AND TRIM(assignee) <> '' ORDER BY rowid",
    )
    .all() as { id: string; assignee: string; owner: string | null; delegate: string | null }[];
  if (rows.length === 0) return;
  const log = new EventLog(db);
  const append = (params: Parameters<EventLog["appendWithinTransaction"]>[0]) => {
    log.appendWithinTransaction(params);
  };
  for (const row of rows) {
    const target = assigneeTarget(db, row.assignee, append, tools.localPerson);
    if (!target) continue;
    if ("delegate" in target) {
      if (row.delegate !== null) continue;
      append({
        actor: "system",
        type: "card/delegated",
        cardId: row.id,
        payload: { id: row.id, from: null, to: target.delegate },
      });
      db.prepare("UPDATE cards SET delegate = ? WHERE id = ?").run(
        JSON.stringify(target.delegate),
        row.id,
      );
    } else {
      if (row.owner !== null) continue;
      append({
        actor: "system",
        type: "card/owner_changed",
        cardId: row.id,
        payload: { id: row.id, from: null, to: target.owner },
      });
      db.prepare("UPDATE cards SET owner = ? WHERE id = ?").run(target.owner, row.id);
    }
  }
}

/**
 * The numbered, forward-only migrations (kernel rule 38, K-N4-1), each run
 * in its own transaction and recorded in `PRAGMA user_version`. Append only:
 * a released migration is never edited. A column is added by declaring it
 * (for `cards`, in the column table) and appending `addColumnMigration(...)`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "catch up a database written before numbered migrations",
    foreignKeysOff: true,
    up: legacyCatchUp,
  },
  {
    version: 2,
    name: "hash chain v3: principal, on_behalf_of, commitment, event_private, append-only triggers",
    up: ledgerV3,
  },
  // NEW-kernel-9: the card's kind, change and split, stored.
  cardColumnMigration(3, "kind"),
  cardColumnMigration(4, "change"),
  cardColumnMigration(5, "split"),
  { version: 6, name: "store each card's kind, change and split once", up: backfillCardKinds },
  // NEW-kernel-6: who is on a card.
  cardColumnMigration(7, "owner"),
  cardColumnMigration(8, "delegate"),
  cardColumnMigration(9, "accepter"),
  // NEW-kernel-3: the typed hold.
  cardColumnMigration(10, "hold"),
  // NEW-kernel-6: who built each attempt and checkpoint.
  addColumnMigration(11, "attempts", "built_by", ATTEMPT_BUILT_BY_COLUMN),
  addColumnMigration(12, "checkpoints", "built_by", CHECKPOINT_BUILT_BY_COLUMN),
  // NEW-kernel-8: where each gate result came from.
  addColumnMigration(13, "gate_results", "source", GATE_SOURCE_COLUMN),
  addColumnMigration(14, "gate_results", "external_ref", GATE_EXTERNAL_REF_COLUMN),
  // NEW-kernel-6, K-N6-6: the legacy assignee string, mapped.
  { version: 15, name: "map the legacy assignee to owner and delegate", up: mapLegacyAssignee },
  // NEW-surface-3 (SUR-40): a card's configuration overrides.
  cardColumnMigration(16, "config_overrides"),
  // gates rule 25a (NEW-gates-7): the base tests a card supersedes.
  cardColumnMigration(17, "supersedes"),
  // gates rules 29 and 6b: what a card declares to its gates.
  cardColumnMigration(18, "gate_checks"),
  // planner-pm B4.3: split depth, interface and criterion ids.
  cardColumnMigration(19, "split_depth"),
  cardColumnMigration(20, "interface"),
  cardColumnMigration(21, "criterion_ids"),
];

/** The schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 0);

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** The backup before a migration (K-N4-5); undefined for an in-memory database. */
function backupBeforeMigrating(
  db: DatabaseSync,
  from: number,
  to: number,
  backupDir: string | undefined,
): string | undefined {
  const location = databaseFile(db);
  if (!location) return undefined;
  const dir = backupDir ?? join(dirname(location), "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `pre-migration-v${from}-to-v${to}-${stamp}.db`);
  copyDatabase(db, path);
  return path;
}

/**
 * The refusal of a database newer than this build (rule 38, K-N4-2), after a
 * rollback (runtime item 38, FINDINGS_C1 REL-18): it names the backup taken
 * before the database was migrated past this build — the newest
 * `pre-migration-v<from>-to-v<to>` whose `from` this build opens — with the
 * command that restores it, and where the backup sets are listed.
 */
function newerDatabaseRefusal(
  db: DatabaseSync,
  stored: number,
  current: number,
  backupDir: string | undefined,
): MigrationRefused {
  const head = `this database is at schema version ${stored}, newer than this build's version ${current}: upgrade Sekhemet to open it`;
  const location = databaseFile(db);
  const dir = backupDir ?? (location ? join(dirname(location), "backups") : undefined);
  let names: string[] = [];
  try {
    names = dir ? readdirSync(dir) : [];
  } catch {
    names = [];
  }
  const newest = names
    .map((name) => ({ name, m: /^pre-migration-v(\d+)-to-v(\d+)-(.+)\.db$/.exec(name) }))
    .filter((c) => c.m && Number(c.m[1]) <= current && Number(c.m[2]) > current)
    .sort((a, b) => (a.m?.[3] ?? "").localeCompare(b.m?.[3] ?? ""))
    .at(-1);
  if (!newest || !dir) {
    return new MigrationRefused(
      `${head}, or go back to a backup: \`sekhemet backup --list\` lists them by schema version.`,
      { stored, current },
    );
  }
  const path = join(dir, newest.name);
  return new MigrationRefused(
    `${head}, or go back with \`sekhemet restore ${path}\` (taken before the migration; events recorded since then are not in it). \`sekhemet backup --list\` lists the other backups.`,
    { stored, current, preMigrationBackup: path },
  );
}

/**
 * Apply every migration above the database's `user_version`, each in its own
 * transaction (K-N4-1), after writing a backup (K-N4-5). A database newer
 * than these migrations is refused, naming both versions (K-N4-2).
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly Migration[] = MIGRATIONS,
  options: { backupDir?: string; localPerson?: { email?: string; name?: string } } = {},
): SchemaMigrationReport {
  const current = migrations.reduce((n, m) => Math.max(n, m.version), 0);
  const stored = userVersion(db);
  const report: SchemaMigrationReport = {
    addedColumns: [],
    rebuiltCardsTable: false,
    backfilledOrderKeys: 0,
    rebuiltEventsTable: false,
    applied: [],
  };
  if (stored > current) {
    throw newerDatabaseRefusal(db, stored, current, options.backupDir);
  }
  const pending = [...migrations]
    .filter((m) => m.version > stored)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return report;
  const backupPath = backupBeforeMigrating(db, stored, current, options.backupDir);
  if (backupPath) report.backupPath = backupPath;
  const tools: MigrationTools = {
    rebuildTable: (table, body) => rebuildTable(db, table, body),
    report,
    ...(options.localPerson ? { localPerson: options.localPerson } : {}),
  };
  for (const m of pending) {
    // The pragma is a no-op inside a transaction, so it is toggled outside one.
    if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    let applied = false;
    try {
      // Re-read under the write lock: another connection may have applied
      // this migration since the version was first read (K-N4-1).
      if (userVersion(db) < m.version) {
        m.up(db, tools);
        db.exec(`PRAGMA user_version = ${m.version}`);
        applied = true;
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    }
    if (applied) report.applied.push(m.version);
  }
  return report;
}

/**
 * Open the kernel's schema. A fresh database is created at the current
 * version; an older one is migrated (after a backup) and its hash chain is
 * verified before anything is served — a ledger whose chain fails is refused
 * (rule 38, K-N4-5); a newer one is refused.
 */
export function initSchema(
  db: DatabaseSync,
  options: { backupDir?: string; localPerson?: { email?: string; name?: string } } = {},
): SchemaMigrationReport {
  db.exec(KERNEL_PRAGMA_SQL);
  const fresh =
    userVersion(db) === 0 &&
    !(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as {
        n: number;
      }
    ).n;
  if (fresh) {
    db.exec("BEGIN IMMEDIATE");
    try {
      createCurrentSchema(db);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    db.exec(KERNEL_INDEX_SQL);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    return {
      addedColumns: [],
      rebuiltCardsTable: false,
      backfilledOrderKeys: 0,
      rebuiltEventsTable: false,
      applied: [],
    };
  }
  const report = runMigrations(db, MIGRATIONS, options);
  // Indexes over freshly added columns can only be created once they exist.
  db.exec(KERNEL_INDEX_SQL);
  if (report.applied.length > 0) {
    const chain = new EventLog(db).verifyHashChainSync();
    if (!chain.valid) {
      throw new MigrationRefused(
        `refusing to serve this ledger: its hash chain is invalid after migrating (${chain.reason ?? `at seq ${chain.corruptedSeq}`}); the backup before the migration is ${report.backupPath ?? "not written (in-memory database)"}`,
      );
    }
  }
  return report;
}

/** Bring an existing database up to the current schema (the migrations of `initSchema`). */
export function migrateSchema(db: DatabaseSync): SchemaMigrationReport {
  return runMigrations(db);
}
