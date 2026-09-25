import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SEC-18 (security item 5): only the modules on the written allowlist start
 * processes. Worktree code goes through runConfined(); a new importer of
 * node:child_process fails here until it is routed or listed with a reason.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..");

const allowlist = JSON.parse(
  readFileSync(join(ROOT, "packages", "sandbox", "child_process.allowlist.json"), "utf8"),
) as { modules: Record<string, string>; runTrusted: Record<string, string> };

/** A value import of child_process; a type-only import starts nothing. */
const IMPORTS = [
  /^import\s+(?!type\s)[^;]*?from\s+["'](node:)?child_process["']/m,
  /^export\s+[^;]*?from\s+["'](node:)?child_process["']/m,
  /\bimport\(\s*["'](node:)?child_process["']\s*\)(?!\s*\.\s*[A-Z])/,
  /\brequire\(\s*["'](node:)?child_process["']\s*\)/,
];

function sources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === "node_modules" || e.name === "dist") return [];
      const p = join(dir, e.name);
      return e.isDirectory() ? walk(p) : /\.(c|m)?tsx?$|\.(c|m)?js$/.test(e.name) ? [p] : [];
    });
  return ["packages", "apps"].flatMap((top) =>
    readdirSync(join(ROOT, top), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => {
        try {
          return walk(join(ROOT, top, d.name, "src"));
        } catch {
          return [];
        }
      }),
  );
}

describe("SEC-18: the child_process allowlist", () => {
  it("the modules importing node:child_process are exactly the written allowlist", () => {
    const found = sources()
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return IMPORTS.some((re) => re.test(text));
      })
      .map((f) => relative(ROOT, f).split("\\").join("/"))
      .sort();
    expect(found).toEqual(Object.keys(allowlist.modules).sort());
  });

  it("the modules calling runTrusted() are exactly the written allowlist", () => {
    const own = new Set(["packages/sandbox/src/trusted.ts", "packages/sandbox/src/index.ts"]);
    const found = sources()
      .map((f) => relative(ROOT, f).split("\\").join("/"))
      .filter((f) => !own.has(f))
      .filter((f) => /\brunTrusted\b/.test(readFileSync(join(ROOT, f), "utf8")))
      .sort();
    expect(found).toEqual(Object.keys(allowlist.runTrusted).sort());
  });

  it("every entry carries a one-line reason", () => {
    for (const [module, reason] of Object.entries({
      ...allowlist.modules,
      ...allowlist.runTrusted,
    })) {
      expect(reason.trim().length, module).toBeGreaterThan(10);
      expect(reason, module).not.toContain("\n");
    }
  });

  it("the modules that run worktree code are not on it", () => {
    for (const routed of [
      "packages/gates/src/visual.ts",
      "packages/context/src/lsp.ts",
      "packages/sandbox/src/browser.ts",
      "packages/sandbox/src/confined.ts",
    ]) {
      expect(Object.keys(allowlist.modules)).not.toContain(routed);
    }
  });

  it("the scanner sees every import form, and ignores type-only ones", () => {
    const hit = (s: string) => IMPORTS.some((re) => re.test(s));
    expect(hit('import { spawn } from "node:child_process";')).toBe(true);
    expect(hit('import * as cp from "child_process";')).toBe(true);
    expect(hit('const { spawn } = await import("node:child_process");')).toBe(true);
    expect(hit('const cp = require("child_process");')).toBe(true);
    expect(hit('import type { ChildProcess } from "node:child_process";')).toBe(false);
    expect(hit('let c: import("node:child_process").ChildProcess;')).toBe(false);
  });
});
