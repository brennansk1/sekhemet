import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { summarizeCondensing } from "../src/condenser.js";
import { buildRankedRepoMap, specIdentifiers } from "../src/ranked_repo_map.js";

/** NEW-context-5: the map's weighting and cache, and condensing savings (CX-N5-1..3). */
describe("NEW-context-5", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });
  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "ctx5-"));
    roots.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  };

  it("CX-N5-1: a file defining an identifier the spec names ranks above an otherwise equal file", () => {
    const root = repo({
      "src/alpha.ts": "export function alphaThing(): number {\n  return 1;\n}\n",
      "src/beta.ts": "export function betaThing(): number {\n  return 2;\n}\n",
    });
    const order = (spec?: string) =>
      buildRankedRepoMap(root, { ...(spec ? { specText: spec } : {}) }).files.map((f) => f.path);
    // Equal files tie by path: alpha first.
    expect(order()).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(order("Make `betaThing` return the configured value.")).toEqual([
      "src/beta.ts",
      "src/alpha.ts",
    ]);
    // Scope files stay first whatever the spec names.
    expect(
      buildRankedRepoMap(root, {
        scopeFiles: ["src/alpha.ts"],
        specText: "Use betaThing.",
      }).files.map((f) => f.path),
    ).toEqual(["src/alpha.ts", "src/beta.ts"]);
    expect(specIdentifiers("Call `betaThing` from the parser; the word and is not one.")).toEqual(
      expect.arrayContaining(["betaThing", "parser"]),
    );
  });

  it("CX-N5-2: a file whose content changed with the same size and mtime is rebuilt, not served from the cache", () => {
    const root = repo({ "src/a.ts": "export function one(): number {\n  return 1;\n}\n" });
    const path = join(root, "src/a.ts");
    // A whole-second mtime, so setting it again reproduces it exactly.
    const t = new Date("2026-09-01T00:00:00Z");
    utimesSync(path, t, t);
    const first = buildRankedRepoMap(root);
    expect(first.text).toContain("function one()");
    const before = statSync(path);
    // Same length, same mtime, different content.
    writeFileSync(path, "export function two(): number {\n  return 1;\n}\n");
    utimesSync(path, t, t);
    const after = statSync(path);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    const second = buildRankedRepoMap(root);
    expect(second.fromCache).toBe(false);
    expect(second.text).toContain("function two()");
    expect(buildRankedRepoMap(root).fromCache).toBe(true);
  });

  it("CX-N5-3: a run's condensing savings, in total and per tool, beside the raw tool-output tokens", () => {
    const s = summarizeCondensing([
      { tool: "run_cmd", rawTokens: 1000, savedTokens: 700 },
      { tool: "run_cmd", rawTokens: 200, savedTokens: 0 },
      { tool: "check", rawTokens: 500, savedTokens: 100 },
    ]);
    expect(s).toEqual({
      rawTokens: 1700,
      savedTokens: 800,
      byTool: [
        { tool: "run_cmd", calls: 2, rawTokens: 1200, savedTokens: 700 },
        { tool: "check", calls: 1, rawTokens: 500, savedTokens: 100 },
      ],
    });
    expect(summarizeCondensing([])).toEqual({ rawTokens: 0, savedTokens: 0, byTool: [] });
  });
});
