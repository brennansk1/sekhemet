import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vault } from "../src/vault.js";

const FAST = 1000;

/** Vault acceptance tests (card_onyx_4_vault) against a real on-disk database. */
describe("onyx vault", () => {
  let dir: string;
  let dbPath: string;
  let vault: Vault;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onyx-vault-"));
    dbPath = join(dir, "vault.db");
    vault = new Vault({ dbPath, passphrase: "hunter2", iterations: FAST });
  });

  afterEach(() => {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rawRows(): { key: string; envelope_json: string }[] {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT key, envelope_json FROM secrets ORDER BY key").all() as {
      key: string;
      envelope_json: string;
    }[];
    db.close();
    return rows;
  }

  function auditActions(): string[] {
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT action FROM audit_events ORDER BY id").all() as {
      action: string;
    }[];
    db.close();
    return rows.map((r) => r.action);
  }

  it("stores a secret and reads it back", () => {
    const record = vault.set("api", "STRIPE_KEY", "sk_test_42");
    expect(record.project).toBe("api");
    expect(record.key).toBe("STRIPE_KEY");
    expect(record.value).toBe("sk_test_42");
    expect(vault.get("api", "STRIPE_KEY")).toBe("sk_test_42");
  });

  it("returns undefined for a missing key or a missing project", () => {
    vault.set("api", "A", "1");
    expect(vault.get("api", "B")).toBeUndefined();
    expect(vault.get("web", "A")).toBeUndefined();
  });

  it("never writes the plaintext value into the database", () => {
    vault.set("api", "DB_PASSWORD", "plaintext-canary-123");
    const rows = rawRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.envelope_json.includes("plaintext-canary-123")).toBe(false);
    expect(Object.keys(JSON.parse(rows[0]?.envelope_json ?? "{}")).sort()).toEqual([
      "ciphertext",
      "iv",
      "salt",
      "tag",
    ]);
  });

  it("overwrites an existing key instead of duplicating it", () => {
    const first = vault.set("api", "TOKEN", "old");
    const second = vault.set("api", "TOKEN", "new");
    expect(vault.get("api", "TOKEN")).toBe("new");
    expect(vault.list("api")).toEqual(["TOKEN"]);
    expect(second.updatedAt > first.updatedAt).toBe(true);
  });

  it("lists keys sorted and isolated per project", () => {
    vault.set("api", "ZETA", "z");
    vault.set("api", "ALPHA", "a");
    vault.set("web", "OTHER", "o");
    expect(vault.list("api")).toEqual(["ALPHA", "ZETA"]);
    expect(vault.list("web")).toEqual(["OTHER"]);
    expect(vault.list("empty")).toEqual([]);
  });

  it("deletes a key once and reports whether anything was deleted", () => {
    vault.set("api", "TOKEN", "x");
    expect(vault.delete("api", "TOKEN")).toBe(true);
    expect(vault.delete("api", "TOKEN")).toBe(false);
    expect(vault.delete("nope", "TOKEN")).toBe(false);
    expect(vault.get("api", "TOKEN")).toBeUndefined();
  });

  it("exposes a project's decrypted secrets as an env map", () => {
    vault.set("api", "A", "1");
    vault.set("api", "B", "two");
    vault.set("web", "C", "3");
    expect(vault.env("api")).toEqual({ A: "1", B: "two" });
    expect(vault.env("missing")).toEqual({});
  });

  it("rejects invalid keys and projects without writing anything", () => {
    expect(() => vault.set("api", "lower_case", "x")).toThrow("invalid key: lower_case");
    expect(() => vault.set("api", "1LEADING_DIGIT", "x")).toThrow("invalid key: 1LEADING_DIGIT");
    expect(() => vault.set("Bad Project", "OK", "x")).toThrow("invalid project: Bad Project");
    expect(rawRows()).toEqual([]);
    expect(auditActions()).toEqual([]);
  });

  it("records one audit event per operation in order", () => {
    vault.set("api", "A", "1");
    vault.set("api", "B", "2");
    vault.get("api", "A");
    vault.list("api");
    vault.delete("api", "B");
    expect(auditActions()).toEqual(["set", "set", "get", "list", "delete"]);
  });

  it("persists across reopening and refuses the wrong passphrase", () => {
    vault.set("api", "TOKEN", "persisted");
    vault.close();

    vault = new Vault({ dbPath, passphrase: "hunter2", iterations: FAST });
    expect(vault.get("api", "TOKEN")).toBe("persisted");
    vault.close();

    vault = new Vault({ dbPath, passphrase: "wrong", iterations: FAST });
    expect(() => vault.get("api", "TOKEN")).toThrow("decryption failed");
  });
});
