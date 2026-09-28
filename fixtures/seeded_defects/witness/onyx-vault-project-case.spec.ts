import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Vault } from "../src/vault.js";

it("refuses an upper-case project name", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-witness-"));
  const vault = new Vault({ dbPath: join(dir, "vault.db"), passphrase: "p", iterations: 1000 });
  try {
    expect(() => vault.set("API", "TOKEN", "x")).toThrow("invalid project: API");
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
