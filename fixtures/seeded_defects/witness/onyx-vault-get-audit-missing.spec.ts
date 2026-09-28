import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { Vault } from "../src/vault.js";

it("audits a get of a missing key", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-witness-"));
  const dbPath = join(dir, "vault.db");
  const vault = new Vault({ dbPath, passphrase: "p", iterations: 1000 });
  try {
    vault.get("api", "MISSING");
    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT action FROM audit_events ORDER BY id").all() as {
      action: string;
    }[];
    db.close();
    expect(rows.map((r) => r.action)).toEqual(["get"]);
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
