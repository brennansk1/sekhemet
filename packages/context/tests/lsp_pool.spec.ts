import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LspPool } from "../src/lsp.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A language server is a memory tenant beside the Worker (worker-loop
 * NEW-worker-loop-7): the pool reports what its servers hold resident, so the
 * memory guard can count it, and gives it back on request. Real processes.
 */
describe("LspPool: resident memory and trimming (WL-N7-2 seam)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lsp-pool-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function greet() {}\ngreet();\n");
    return root;
  };
  const fakePool = () =>
    new LspPool({
      servers: {
        typescript: { command: process.execPath, args: [join(here, "support", "fake_lsp.mjs")] },
      },
      idleMs: 60_000,
    });

  it("holds nothing before the first symbol request, and reports a started server's resident bytes", async () => {
    const root = project();
    const pool = fakePool();
    try {
      expect(pool.residentBytes()).toBe(0);
      const client = pool.clientFor(root, "src/a.ts");
      await client?.definition("src/a.ts", 2, 2);
      const bytes = pool.residentBytes();
      // A node process: more than a megabyte, far less than a gigabyte.
      expect(bytes).toBeGreaterThan(1024 * 1024);
      expect(bytes).toBeLessThan(1024 ** 3);
    } finally {
      await pool.closeAll();
    }
    expect(pool.residentBytes()).toBe(0);
  });

  it("trimCaches stops idle servers and closes their documents; the next request starts one again", async () => {
    const root = project();
    const pool = fakePool();
    try {
      const client = pool.clientFor(root, "src/a.ts");
      await client?.definition("src/a.ts", 2, 2);
      expect(pool.size).toBe(1);
      const trimmed = await pool.trimCaches();
      expect(trimmed).toEqual({ stopped: 1, documentsClosed: 1 });
      expect(pool.size).toBe(0);
      expect(pool.residentBytes()).toBe(0);
      const again = pool.clientFor(root, "src/a.ts");
      expect(again).not.toBe(client);
      const refs = await again?.references("src/a.ts", 1, 18);
      expect(refs?.map((r) => r.line)).toEqual([1, 2]);
    } finally {
      await pool.closeAll();
    }
  });
});
