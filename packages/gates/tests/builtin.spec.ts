import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GateProjectConfig,
  levenshtein,
  loadGatesConfig,
  mutantsOnLines,
  runBuiltinGates,
  typosquatOf,
} from "../src/index.js";

const project: GateProjectConfig = { protected: [], maxFiles: 3, maxDiffLines: 200 };
const FAKE_KEY = `AKIA${"ABCDEFGHIJKLMNOP"}`;

describe("built-in gate layers (G3, G13, G14, G15, G16, G22, S10, S11)", () => {
  let root: string;
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const diff = () => {
    git("add", "-A");
    return git("diff", "--cached", "--unified=0", "main");
  };
  const none = () => false;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "builtin-gates-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { lodash: "^4" } }));
    writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "card");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("fails a diff that adds a credential (G14)", async () => {
    writeFileSync(join(root, "a.ts"), `export const a = 1;\nexport const k = "${FAKE_KEY}";\n`);
    const r = await runBuiltinGates({ root, base: "main", diff: diff(), project, which: none });
    expect(r.failures[0]).toMatchObject({ gate: "secrets", layer: "security", location: { file: "a.ts", line: 2 } });
    expect(r.failures[0]?.errorExcerpt).not.toContain(FAKE_KEY);
    expect(r.outcomes.find((o) => o.gate === "osv")?.skipped).toBe(true);
  });

  it("refuses a typosquat, a nonexistent package and a days-old one (G15, S10)", async () => {
    expect(levenshtein("lodahs", "lodash")).toBe(2);
    expect(typosquatOf("lodahs", ["lodash"])).toBe("lodash");
    expect(typosquatOf("react-dom", ["react-dom", "react"])).toBeUndefined();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { lodash: "^4", expresss: "1", "left-padder": "1", "brand-new-pkg": "1", zod: "3" } }),
    );
    const registry = async (name: string) =>
      name === "left-padder"
        ? { exists: false }
        : name === "brand-new-pkg"
          ? { exists: true, created: "2026-09-10T00:00:00Z" }
          : { exists: true, created: "2019-01-01T00:00:00Z" };
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      registry,
      now: () => Date.parse("2026-09-19T00:00:00Z"),
    });
    const excerpts = r.failures.filter((f) => f.gate === "dependencies").map((f) => f.errorExcerpt);
    expect(excerpts.some((e) => e.includes('"expresss", one edit away from "express"'))).toBe(true);
    expect(excerpts.some((e) => e.includes('"left-padder", which does not exist'))).toBe(true);
    expect(excerpts.some((e) => e.includes('"brand-new-pkg", first published 9 day(s) ago'))).toBe(true);
    expect(excerpts.some((e) => e.includes("zod"))).toBe(false);
  });

  it("finds debug output, a missing changelog entry and hand-made commits (G22)", async () => {
    // The project keeps a changelog (on main); the card's first commit is attributed.
    git("checkout", "-q", "main");
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
    git("add", "-A");
    git("commit", "-q", "-m", "changelog");
    git("checkout", "-q", "-B", "card");
    writeFileSync(join(root, "b.ts"), "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "checkpoint\n\nAgent-Model: m\nAgent-Harness: sekhemet");
    writeFileSync(join(root, "a.ts"), "export const a = 1;\ndebugger;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "by hand");
    const r = await runBuiltinGates({ root, base: "main", diff: diff(), project, which: none });
    const hygiene = r.failures.filter((f) => f.gate === "hygiene").map((f) => f.errorExcerpt);
    expect(hygiene.some((e) => e.includes("a.ts:2 leaves debug output"))).toBe(true);
    expect(hygiene.some((e) => e.includes("CHANGELOG.md has no entry"))).toBe(true);
    expect(hygiene.filter((e) => e.includes("lacks the Agent-Model"))).toHaveLength(1);
  });

  it("runs semgrep and osv-scanner only when installed, and reports them skipped otherwise (G16, S11)", async () => {
    const r = await runBuiltinGates({ root, base: "main", diff: diff(), project, which: none });
    expect(r.outcomes.filter((o) => o.skipped).map((o) => o.gate).sort()).toEqual(["osv", "semgrep"]);
  });

  it("mutates changed lines only and reports surviving mutants as advisories (G13)", async () => {
    expect(
      mutantsOnLines("x.ts", "if (a === b) return 1;\nif (c < d) return 2;\n", new Set([2]), 5).map(
        (m) => m.replacement,
      ),
    ).toEqual(["<="]);
    writeFileSync(join(root, "a.ts"), "export const a = 1;\nexport const big = (n: number) => n > 10;\n");
    let runs = 0;
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutation: true },
      which: none,
      // A test suite that never looks at `big`: every mutant survives.
      runTests: async () => {
        runs++;
        return true;
      },
    });
    expect(runs).toBe(1);
    expect(r.advisories.some((a) => a.includes('a.ts:2 ">" -> ">="'))).toBe(true);
    expect(r.failures.some((f) => f.gate === "mutation")).toBe(false);
    const blocking = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutation: true, mutationBlocking: true },
      which: none,
      runTests: async () => true,
    });
    expect(blocking.failures.some((f) => f.gate === "mutation")).toBe(true);
  });

  it("reads the built-in gate settings from gates.toml", () => {
    writeFileSync(join(root, "gates.toml"), "");
    execFileSync("mkdir", ["-p", join(root, ".sekhemet")]);
    writeFileSync(
      join(root, ".sekhemet", "gates.toml"),
      '[project]\nbuiltin = ["secrets", "hygiene", "bogus"]\nmutation = true\nmutation_max = 4\nchangelog = false\ndebug_patterns = ["console.log("]\n',
    );
    const c = loadGatesConfig(root).project;
    expect(c.builtin).toEqual(["secrets", "hygiene"]);
    expect(c).toMatchObject({ mutation: true, mutationMax: 4, changelog: false, debugPatterns: ["console.log("] });
  });
});
