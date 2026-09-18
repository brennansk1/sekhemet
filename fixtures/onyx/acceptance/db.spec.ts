import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { monotonicNow, openVaultDb } from "../src/db.js";

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .sort();
}

/** Acceptance tests for card_onyx_3_db, run against a real on-disk database. */
describe("onyx vault database", () => {
  let dir: string;
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onyx-db-"));
    db = openVaultDb(join(dir, "vault.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("uses WAL, synchronous NORMAL and enforces foreign keys", () => {
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toEqual({ synchronous: 1 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("creates the three tables with exactly the specified columns", () => {
    expect(columns(db, "projects")).toEqual(["created_at", "id", "name"]);
    expect(columns(db, "secrets")).toEqual([
      "envelope_json",
      "id",
      "key",
      "project_id",
      "updated_at",
    ]);
    expect(columns(db, "audit_events")).toEqual(["action", "at", "id", "key", "project"]);
  });

  it("rejects a duplicate project name", () => {
    const insert = db.prepare("INSERT INTO projects (name, created_at) VALUES (?, ?)");
    insert.run("api", 1);
    expect(() => insert.run("api", 2)).toThrow(/UNIQUE/);
  });

  it("rejects a duplicate key within a project but allows it in another project", () => {
    db.prepare("INSERT INTO projects (name, created_at) VALUES ('a', 1), ('b', 1)").run();
    const insert = db.prepare(
      "INSERT INTO secrets (project_id, key, envelope_json, updated_at) VALUES (?, ?, '{}', 1)",
    );
    insert.run(1, "TOKEN");
    insert.run(2, "TOKEN");
    expect(() => insert.run(1, "TOKEN")).toThrow(/UNIQUE/);
    expect(db.prepare("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 2 });
  });

  it("rejects a secret that references a missing project", () => {
    const insert = db.prepare(
      "INSERT INTO secrets (project_id, key, envelope_json, updated_at) VALUES (42, 'K', '{}', 1)",
    );
    expect(() => insert.run()).toThrow(/FOREIGN KEY/);
  });

  it("cascades deleting a project to its secrets", () => {
    db.prepare("INSERT INTO projects (name, created_at) VALUES ('a', 1)").run();
    db.prepare(
      "INSERT INTO secrets (project_id, key, envelope_json, updated_at) VALUES (1, 'K', '{}', 1)",
    ).run();
    db.prepare("DELETE FROM projects WHERE id = 1").run();
    expect(db.prepare("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 0 });
  });

  it("accepts only the four audit actions and allows a null key", () => {
    const insert = db.prepare(
      "INSERT INTO audit_events (action, project, key, at) VALUES (?, 'p', ?, 1)",
    );
    for (const action of ["set", "get", "list", "delete"]) insert.run(action, null);
    expect(() => insert.run("export", "K")).toThrow(/CHECK/);
    expect(() => insert.run("", "K")).toThrow(/CHECK/);
    expect(db.prepare("SELECT count(*) AS n FROM audit_events").get()).toEqual({ n: 4 });
  });

  it("can be opened twice on the same file without losing data", () => {
    db.prepare("INSERT INTO projects (name, created_at) VALUES ('keep', 1)").run();
    db.close();
    db = openVaultDb(join(dir, "vault.db"));
    expect(db.prepare("SELECT name FROM projects").all()).toEqual([{ name: "keep" }]);
  });
});

describe("onyx monotonicNow", () => {
  it("returns the clock when it is ahead of the previous timestamp", () => {
    expect(monotonicNow(100, 250)).toBe(250);
  });

  it("returns previous + 1 when the clock equals the previous timestamp", () => {
    expect(monotonicNow(250, 250)).toBe(251);
  });

  it("returns previous + 1 when the clock went backwards", () => {
    expect(monotonicNow(1000, 10)).toBe(1001);
  });

  it("defaults the clock to Date.now()", () => {
    const before = Date.now();
    const value = monotonicNow(0);
    expect(value >= before && value <= Date.now()).toBe(true);
  });
});
