import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";

/** Acceptance tests for card_chron_db, run against a real on-disk database. */
describe("chronicle db", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chronicle-db-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("opens the database in WAL mode", () => {
    const db = openDatabase(join(dir, "c.db"));
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();
  });

  it("creates chronicle_events with exactly the specified columns", () => {
    const db = openDatabase(join(dir, "c.db"));
    const cols = (db.prepare("PRAGMA table_info(chronicle_events)").all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    expect(cols).toEqual(
      [
        "hash",
        "id",
        "idempotency_key",
        "payload_json",
        "previous_hash",
        "sequence_number",
        "timestamp",
        "type",
      ].sort(),
    );
    db.close();
  });

  it("indexes the hash column", () => {
    const db = openDatabase(join(dir, "c.db"));
    const idx = db.prepare("PRAGMA index_list(chronicle_events)").all() as { name: string }[];
    expect(idx.map((i) => i.name)).toContain("idx_chronicle_hash");
    db.close();
  });

  it("rejects a duplicate id and a duplicate idempotency key", () => {
    const db = openDatabase(join(dir, "c.db"));
    const insert = db.prepare(
      "INSERT INTO chronicle_events (id, timestamp, type, payload_json, previous_hash, hash, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run("a", 1, "t", "{}", "0", "h1", "k1");
    expect(() => insert.run("a", 2, "t", "{}", "0", "h2", "k2")).toThrow();
    expect(() => insert.run("b", 3, "t", "{}", "0", "h3", "k1")).toThrow();
    db.close();
  });

  it("assigns sequence numbers from one and allows a null idempotency key", () => {
    const db = openDatabase(join(dir, "c.db"));
    const insert = db.prepare(
      "INSERT INTO chronicle_events (id, timestamp, type, payload_json, previous_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run("a", 1, "t", "{}", "0", "h1");
    insert.run("b", 2, "t", "{}", "h1", "h2");
    const rows = db
      .prepare("SELECT sequence_number FROM chronicle_events ORDER BY sequence_number")
      .all() as { sequence_number: number }[];
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2]);
    db.close();
  });

  it("is idempotent to open twice on the same file", () => {
    openDatabase(join(dir, "c.db")).close();
    const db = openDatabase(join(dir, "c.db"));
    expect(db.prepare("SELECT count(*) AS n FROM chronicle_events").get()).toEqual({ n: 0 });
    db.close();
  });
});
