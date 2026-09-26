import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LSP_HEAP_MB,
  DEFAULT_LSP_SERVERS,
  LspPool,
  PYTHON_BOUNDS,
  typescriptServer,
} from "../src/lsp.js";

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

describe("NEW-worker-loop-7: language servers as bounded tenants", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "lsp-wl7-"));
    roots.push(root);
    writeFileSync(join(root, "a.py"), "def greet():\n  return 1\n");
    return root;
  };
  const fake = { command: process.execPath, args: [join(here, "support", "fake_lsp.mjs")] };

  it("WL-N7-2: caps the server's heap, and excludes environment and dependency directories", async () => {
    const root = project();
    const pool = new LspPool({ servers: { python: { ...fake, ...PYTHON_BOUNDS, heapMb: 256 } } });
    try {
      const client = pool.clientFor(root, "a.py");
      await client?.initialize();
      // Give the server's configuration request its round trip.
      await new Promise((r) => setTimeout(r, 200));
      const echo = (await client?.request("sekhemet/echo", {})) as {
        nodeOptions: string | null;
        initOptions: unknown;
        config: unknown[] | null;
      };
      expect(echo.nodeOptions).toContain("--max-old-space-size=256");
      expect(JSON.stringify(echo.initOptions)).toContain(".venv");
      expect(echo.config?.[0]).toMatchObject({ exclude: expect.arrayContaining(["**/.venv"]) });
      expect(echo.config?.[1]).toBeNull();
    } finally {
      await pool.closeAll();
    }
  });

  it("WL-N7-2: the guard's check trims the pool when its servers hold more than the cap", async () => {
    const root = project();
    const pool = new LspPool({ servers: { python: fake } });
    try {
      await pool.clientFor(root, "a.py")?.initialize();
      expect(await pool.enforceResidentCap(1024 ** 4)).toMatchObject({ trimmed: false });
      const over = await pool.enforceResidentCap(1);
      expect(over.trimmed).toBe(true);
      expect(over.residentBytes).toBeGreaterThan(1);
      expect(pool.size).toBe(0);
    } finally {
      await pool.closeAll();
    }
  });

  it("WL-N7-1: the TypeScript server is chosen by configuration: typescript-language-server or tsc --lsp", () => {
    expect(typescriptServer(undefined)).toMatchObject({
      command: "typescript-language-server",
      args: ["--stdio"],
    });
    expect(typescriptServer("tsc")).toMatchObject({ command: "tsc", args: ["--lsp", "--stdio"] });
    expect(DEFAULT_LSP_SERVERS.typescript?.heapMb).toBe(DEFAULT_LSP_HEAP_MB);
    expect(JSON.stringify(DEFAULT_LSP_SERVERS.rust?.initializationOptions)).toContain("target");
  });
});
