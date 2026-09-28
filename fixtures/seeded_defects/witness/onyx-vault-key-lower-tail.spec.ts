import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Vault } from "../src/vault.js";

it("refuses a key with lower-case letters after the first character", () => {
  const dir = mkdtempSync(join(tmpdir(), "onyx-witness-"));
  const vault = new Vault({ dbPath: join(dir, "vault.db"), passphrase: "p", iterations: 1000 });
  try {
    expect(() => vault.set("api", "API_key", "x")).toThrow("invalid key: API_key");
  } finally {
    vault.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
