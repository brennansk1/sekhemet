import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspPool } from "../src/lsp.js";

/** SEC-17: a language server executes project code, so it runs confined to the worktree. */
describe.runIf(platform() === "darwin")("SEC-17: language servers run confined", () => {
  let root: string;
  let outside: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "lsp-root-"));
    outside = mkdtempSync(join(tmpdir(), "lsp-out-"));
    writeFileSync(join(root, "a.py"), "def f():\n  return 1\n");
  });
  afterEach(() => {
    for (const d of [root, outside]) rmSync(d, { recursive: true, force: true });
  });

  it("a server that writes outside the worktree leaves no marker", async () => {
    const marker = join(outside, "marker");
    const inside = join(root, "ran");
    const script = `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(inside)}, "x"); try { fs.writeFileSync(${JSON.stringify(marker)}, "escaped") } catch {}`;
    const pool = new LspPool({
      servers: { python: { command: process.execPath, args: ["-e", script] } },
      requestTimeoutMs: 5_000,
    });
    try {
      const client = pool.clientFor(root, "a.py");
      await expect(client?.initialize()).rejects.toThrow();
      // It ran, inside the worktree, and nowhere else.
      expect(existsSync(inside)).toBe(true);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await pool.closeAll();
    }
  });
});
