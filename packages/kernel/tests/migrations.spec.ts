import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CARD_COLUMN_TABLE,
  type CardColumn,
  cardInsertSql,
  cardInsertValues,
  cardsTableDdl,
} from "../src/card_columns.js";
import { EventLog } from "../src/log.js";
import {
  type Migration,
  MigrationRefused,
  SCHEMA_VERSION,
  initSchema,
  runMigrations,
} from "../src/schema.js";

// kernel.md NEW-kernel-4: numbered, forward-only migrations recorded in
// PRAGMA user_version, never dropping a column that holds data, preceded by
// a backup and followed by a chain check; one card column table (rule 38).
// Real SQLite files throughout (DEFINITION_OF_DONE §2A).

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kernel-migrations-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (name = "events.db") => new DatabaseSync(join(dir, name));
const version = (db: DatabaseSync) =>
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
    (c) => c.name,
  );

/** Fixture migrations over a table `t`. */
const addA: Migration = {
  version: 1,
  name: "add t.a",
  up: (db) => db.exec("ALTER TABLE t ADD COLUMN a TEXT"),
};
const addB: Migration = {
  version: 2,
  name: "add t.b",
  up: (db) => db.exec("ALTER TABLE t ADD COLUMN b TEXT"),
};
const broken: Migration = {
  version: 3,
  name: "fails half way",
  up: (db) => {
    db.exec("ALTER TABLE t ADD COLUMN c TEXT");
    throw new Error("disk full");
  },
};

describe("K-N4-1: migrations N+1 to current, each in its own transaction", () => {
  it("applies only the migrations above the stored version and sets user_version", () => {
    const db = open();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.exec("PRAGMA user_version = 1");
    db.exec("ALTER TABLE t ADD COLUMN a TEXT");
    const report = runMigrations(db, [addA, addB], { backupDir: join(dir, "backups") });
    expect(report.applied).toEqual([2]);
    expect(version(db)).toBe(2);
    expect(columns(db, "t")).toEqual(["id", "a", "b"]);
    db.close();
  });

  it("keeps each finished migration when a later one fails, and rolls the failed one back", () => {
    const db = open();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(() =>
      runMigrations(db, [addA, addB, broken], { backupDir: join(dir, "backups") }),
    ).toThrow(/disk full/);
    expect(version(db)).toBe(2);
    expect(columns(db, "t")).toEqual(["id", "a", "b"]);
    db.close();
  });
});

describe("K-N4-1: two connections migrating one file", () => {
  it("re-reads user_version inside each migration's transaction and skips one another connection applied", () => {
    const a = open();
    const b = open();
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    let raced = false;
    // Another connection applies version 2 in the gap between A's first
    // migration and its second (read just before A's BEGIN).
    const racingB: Migration = {
      ...addB,
      get foreignKeysOff() {
        if (!raced) {
          raced = true;
          runMigrations(b, [addA, addB], { backupDir: join(dir, "backups-b") });
        }
        return false;
      },
    };
    const report = runMigrations(a, [addA, racingB], { backupDir: join(dir, "backups") });
    expect(raced).toBe(true);
    expect(report.applied).toEqual([1]);
    expect(version(a)).toBe(2);
    expect(columns(a, "t")).toEqual(["id", "a", "b"]);
    a.close();
    b.close();
  });
});

describe("K-N4-2: a database newer than the binary is refused", () => {
  it("names both versions", () => {
    const db = open();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 3}`);
    expect(() => initSchema(db)).toThrow(
      new RegExp(`version ${SCHEMA_VERSION + 3}.*${SCHEMA_VERSION}`),
    );
    db.close();
  });
});

describe("K-N4-3: a migration never removes a column that holds data", () => {
  const dropsNote: Migration = {
    version: 1,
    name: "rebuild t without note",
    up: (db, tools) => tools.rebuildTable("t", "id INTEGER PRIMARY KEY, a TEXT"),
  };

  it("aborts and leaves the database unchanged when the column holds a value", () => {
    const db = open();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, note TEXT)");
    db.exec("INSERT INTO t (id, a, note) VALUES (1, 'x', 'keep me')");
    expect(() => runMigrations(db, [dropsNote], { backupDir: join(dir, "backups") })).toThrow(
      MigrationRefused,
    );
    expect(columns(db, "t")).toEqual(["id", "a", "note"]);
    expect(db.prepare("SELECT note FROM t").get()).toEqual({ note: "keep me" });
    expect(version(db)).toBe(0);
    db.close();
  });

  it("allows it when the column holds only nulls", () => {
    const db = open();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, note TEXT)");
    db.exec("INSERT INTO t (id, a) VALUES (1, 'x')");
    runMigrations(db, [dropsNote], { backupDir: join(dir, "backups") });
    expect(columns(db, "t")).toEqual(["id", "a"]);
    expect(db.prepare("SELECT a FROM t").get()).toEqual({ a: "x" });
    db.close();
  });

  it("keeps every card column holding data when an old cards table is rebuilt", () => {
    // The legacy rebuild used to copy ten columns and drop the rest.
    const db = open();
    db.exec(
      "CREATE TABLE cards (id TEXT PRIMARY KEY, tier TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('backlog','ready','in_progress','review','done')), scope_files JSON NOT NULL DEFAULT '[]', step_budget INTEGER NOT NULL DEFAULT 40, steps_used INTEGER NOT NULL DEFAULT 0, spec TEXT, labels JSON NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    db.exec(
      `INSERT INTO cards (id, tier, title, status, spec, labels, created_at, updated_at) VALUES ('c1', 'task', 'T', 'ready', 'the brief', '["x"]', 'now', 'now')`,
    );
    initSchema(db);
    expect(db.prepare("SELECT spec, labels FROM cards WHERE id = 'c1'").get()).toEqual({
      spec: "the brief",
      labels: '["x"]',
    });
    db.close();
  });
});

describe("K-N4-5: a backup before, a chain check after", () => {
  it("writes a backup of the database before migrating and names its path", async () => {
    const db = open();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const report = runMigrations(db, [addA], { backupDir: join(dir, "backups") });
    expect(report.backupPath).toBeDefined();
    expect(existsSync(report.backupPath as string)).toBe(true);
    const copy = new DatabaseSync(report.backupPath as string, { readOnly: true });
    expect(columns(copy, "t")).toEqual(["id"]);
    expect(version(copy)).toBe(0);
    copy.close();
    db.close();
  });

  it("writes no backup when nothing is pending", () => {
    const db = open();
    initSchema(db);
    const again = initSchema(db);
    expect(again.backupPath).toBeUndefined();
    expect(again.applied).toEqual([]);
    db.close();
  });

  it("refuses to serve a ledger whose chain is invalid once the migrations have run", async () => {
    const db = open();
    initSchema(db);
    const log = new EventLog(db);
    await log.append({ actor: "human", type: "a", payload: { n: 1 } });
    await log.append({ actor: "human", type: "b", payload: { n: 2 } });
    db.exec("DROP TRIGGER events_no_update");
    db.exec(`UPDATE events SET payload = '{"n":99}' WHERE seq = 1`);
    // An older build's database: a migration is pending.
    db.exec("PRAGMA user_version = 0");
    expect(() => initSchema(db)).toThrow(/hash chain/i);
    db.close();
  });

  it("a fresh database starts at the current version with no backup", () => {
    const db = open();
    const report = initSchema(db);
    expect(version(db)).toBe(SCHEMA_VERSION);
    expect(report.backupPath).toBeUndefined();
    db.close();
  });
});

describe("K-N4-4: one card column table", () => {
  const extra: CardColumn = {
    column: "fixture_note",
    ddl: "fixture_note TEXT",
    fromPayload: (p) => (p.fixtureNote as string | undefined) ?? null,
  };
  const table = [...CARD_COLUMN_TABLE, extra];
  const payload = {
    id: "c1",
    tier: "task",
    title: "T",
    status: "ready",
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    fixtureNote: "carried",
  };

  it("puts a column added to the table into the DDL, the insert and the replay projection", () => {
    expect(cardsTableDdl(table)).toContain("fixture_note TEXT");
    expect(cardInsertSql(table)).toMatch(/\bfixture_note\b/);
    const db = open();
    db.exec(`CREATE TABLE cards (${cardsTableDdl(table)})`);
    db.prepare(cardInsertSql(table)).run(
      ...cardInsertValues(table, payload, { orderKey: () => "a0" }),
    );
    expect(db.prepare("SELECT fixture_note, title, order_key FROM cards").get()).toEqual({
      fixture_note: "carried",
      title: "T",
      order_key: "a0",
    });
    db.close();
  });

  it("is where the kernel's cards DDL comes from", () => {
    const db = open();
    initSchema(db);
    expect(columns(db, "cards")).toEqual(CARD_COLUMN_TABLE.map((c) => c.column));
    db.close();
  });
});
