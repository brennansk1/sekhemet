import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkRefactorSurface,
  checkUpgradeTests,
  runChangeKindChecks,
  upgradeTestList,
} from "../src/change_kinds.js";
import { STAND_INS, checkTestStrength } from "../src/test_strength.js";
import type { GateDefinition } from "../src/types.js";

// NEW-gates-6's change kinds (gates rules 6b and 32a; DoD §5.1 item 1):
// a refactor keeps the index's exported surface of its scope (GT-TQ-8), a
// characterize card's tests must kill the stand-ins of the code they cover
// (GT-TQ-10), and an upgrade names the tests it must keep passing (GT-TQ-11).
// Real git repositories and real Vitest runs.

const REPO = join(import.meta.dirname, "..", "..", "..");
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const unit: GateDefinition = {
  id: "unit",
  rung: "test",
  layer: "functional",
  command: process.execPath,
  args: [VITEST, "run"],
  timeoutMs: 120_000,
  parser: "vitest",
  blocking: true,
};
const sandbox = new ProcessSandbox();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const put = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
};
function repo(files: Record<string, string>, staged: Record<string, string> = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "change-kinds-")));
  dirs.push(root);
  put(root, {
    "package.json": '{ "name": "seed", "type": "module", "private": true }\n',
    ".gitignore": "node_modules/\n",
    ...files,
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@t.t");
  git(root, "config", "user.name", "T");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  git(root, "checkout", "-q", "-b", "card");
  put(root, staged);
  return root;
}

describe("a refactor keeps its scope's exported surface (GT-TQ-8)", () => {
  const base = {
    "src/a.ts":
      "export function add(a: number, b: number): number { return a + b; }\nexport const sub = (a: number, b: number) => a - b;\nexport type Pair = [number, number];\n",
    "src/index.ts": 'export * from "./a.js";\nexport { add as plus } from "./a.js";\n',
  };

  it("passes a change that keeps every export, bodies and types aside", () => {
    const root = repo(base);
    put(root, {
      "src/a.ts":
        "export function add(x: number, y: number): number {\n  const s = x + y;\n  return s;\n}\nexport const sub = (a: number, b: number): number => a - b;\nexport interface Pair { 0: number; 1: number }\n",
    });
    const r = checkRefactorSurface({ root, base: "main", scope: ["src/a.ts", "src/index.ts"] });
    expect(r.changes).toEqual([]);
    expect(r.failure).toBeUndefined();
  });

  it("fails a renamed or removed export or re-export, naming each, unless the card declares it", () => {
    const root = repo(base);
    put(root, {
      "src/a.ts":
        "export function add(a: number, b: number): number { return a + b; }\nexport const minus = (a: number, b: number) => a - b;\nexport type Pair = [number, number];\n",
      "src/index.ts": 'export * from "./a.js";\n',
    });
    const r = checkRefactorSurface({ root, base: "main", scope: ["src/a.ts", "src/index.ts"] });
    expect(r.changes).toEqual([
      { file: "src/a.ts", added: ["minus"], removed: ["sub"] },
      { file: "src/index.ts", added: [], removed: ["plus (from ./a.js)"] },
    ]);
    expect(r.failure).toMatchObject({ gate: "refactor-surface", location: { file: "src/a.ts" } });
    expect(r.failure?.errorExcerpt).toContain("src/a.ts: removed sub; added minus");
    expect(r.failure?.errorExcerpt).toContain("src/index.ts: removed plus (from ./a.js)");
    const declared = checkRefactorSurface({
      root,
      base: "main",
      scope: ["src/a.ts", "src/index.ts"],
      declaredSurfaceChange: true,
    });
    expect(declared.failure).toBeUndefined();
    expect(declared.changes).toHaveLength(2);
  });

  it("judges the files the change touches as well as its scope, and is not run with neither", async () => {
    const root = repo(base);
    // The scope names only src/index.ts; the change removes an export from src/a.ts.
    put(root, {
      "src/a.ts":
        "export function add(a: number, b: number): number { return a + b; }\nexport type Pair = [number, number];\n",
      "tests/a.spec.ts":
        'import { it } from "vitest";\nexport const helper = 1;\nit("x", () => {});\n',
    });
    const r = await runChangeKindChecks({
      root,
      base: "main",
      change: "refactor",
      scope: ["src/index.ts"],
      changed: ["src/a.ts", "tests/a.spec.ts"],
    });
    expect(r.failures.map((f) => f.errorExcerpt)).toEqual([
      "a refactor changed the exported surface of its scope: src/a.ts: removed sub",
    ]);
    const blind = await runChangeKindChecks({
      root,
      base: "main",
      change: "refactor",
      scope: [],
    });
    expect(blind.outcomes).toMatchObject([{ gate: "refactor-surface", unavailable: true }]);
    expect(blind.failures[0]?.errorExcerpt).toMatch(/refactor-surface not run: .*no scope/);
  });

  it("counts a scope file new to the base as surface added", () => {
    const root = repo(base);
    put(root, { "src/b.ts": "export const b = 1;\n" });
    const r = checkRefactorSurface({ root, base: "main", scope: ["src/b.ts"] });
    expect(r.changes).toEqual([{ file: "src/b.ts", added: ["b"], removed: [] }]);
    expect(r.failure).toBeDefined();
  });
});

describe("a characterize card's tests kill the stand-ins of the code they cover (GT-TQ-10)", () => {
  const covered = {
    "src/calc.ts":
      "export function double(n: number): number {\n  return n * 2;\n}\nexport const unused = 1;\n",
  };

  it("refuses tests a stand-in passes, naming the stand-in and the tests, and leaves the tree as it was", async () => {
    const root = repo(covered, {
      "tests/c.spec.ts": `import { expect, it } from "vitest";
import { double } from "../src/calc.js";
it("doubles zero", () => { expect(double(0)).toBe(0); });
`,
    });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/c.spec.ts"],
      change: "characterize",
      origin: "card",
    });
    expect(record.stubKill.status).toBe("survived");
    expect(record.stubKill.standIn).toBe("returns 0");
    expect(record.verdict).toMatchObject({ status: "refused", stopReason: "vacuous_tests" });
    expect(record.verdict.detail).toContain("returns 0");
    expect(record.verdict.detail).toContain("doubles zero");
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("?? tests/c.spec.ts");
    expect(readFileSync(join(root, "src/calc.ts"), "utf8")).toBe(covered["src/calc.ts"]);
  }, 180_000);

  it("keeps tests every stand-in fails, one run per stand-in, and does not stop the card", async () => {
    const root = repo(covered, {
      "tests/c.spec.ts": `import { expect, it } from "vitest";
import { double } from "../src/calc.js";
it("doubles", () => { expect(double(3)).toBe(6); expect(double(-2)).toBe(-4); });
`,
    });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/c.spec.ts"],
      change: "characterize",
      origin: "card",
    });
    expect(record.stubKill.status).toBe("killed");
    expect(record.stubKill.runs.map((r) => r.standIn)).toEqual([...STAND_INS]);
    expect(record.verdict.stopReason).toBeUndefined();
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("?? tests/c.spec.ts");
  }, 180_000);

  it("counts only a failure at an assertion as a kill: a stand-in that breaks the test another way is not judged", async () => {
    const root = repo(covered, {
      "tests/c.spec.ts": `import { expect, it } from "vitest";
import { double } from "../src/calc.js";
it("doubles", () => { expect(double(3).toFixed(0)).toBe("6"); });
`,
    });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/c.spec.ts"],
      change: "characterize",
      origin: "card",
    });
    expect(record.stubKill.status).toBe("not_judged");
    expect(record.stubKill.reason).toContain(STAND_INS[0]);
    expect(record.stubKill.reason).toMatch(/not at an assertion/);
    expect(record.stubKill.runs[0]).toMatchObject({ standIn: STAND_INS[0], failed: 0 });
    expect(record.verdict.stopReason).toBeUndefined();
    expect(readFileSync(join(root, "src/calc.ts"), "utf8")).toBe(covered["src/calc.ts"]);
  }, 180_000);

  it("does not run the stand-ins when the tests fail on the base: the gate run refuses them", async () => {
    const root = repo(covered, {
      "tests/c.spec.ts": `import { expect, it } from "vitest";
import { double } from "../src/calc.js";
it("is wrong", () => { expect(double(2)).toBe(5); });
`,
    });
    const record = await checkTestStrength({
      sandbox,
      root,
      testGate: unit,
      tests: ["tests/c.spec.ts"],
      change: "characterize",
      origin: "card",
    });
    expect(record.stubKill.status).toBe("not_applicable");
    expect(record.stubKill.reason).toMatch(/do not pass on the base/);
    expect(record.verdict.stopReason).toBeUndefined();
  }, 180_000);
});

describe("an upgrade names the tests it must keep passing (GT-TQ-11)", () => {
  it("defaults to the tests that pass on the base and refuses an empty list", () => {
    expect(upgradeTestList({ passingOnBase: ["t > b", "t > a", "t > a"] })).toEqual({
      tests: ["t > a", "t > b"],
    });
    expect(upgradeTestList({ named: ["t > a"], passingOnBase: ["t > a", "t > b"] })).toEqual({
      tests: ["t > a"],
    });
    expect(upgradeTestList({ named: [], passingOnBase: [] }).refused).toMatch(
      /no test to keep passing/,
    );
    expect(upgradeTestList({ passingOnBase: [] }).refused).toBeDefined();
  });

  it("fails verification naming every kept test that fails or did not run", () => {
    expect(
      checkUpgradeTests(
        ["t > a", "t > b"],
        [
          { test: "t > a", passed: true },
          { test: "t > b", passed: true },
        ],
      ),
    ).toEqual([]);
    const f = checkUpgradeTests(
      ["t > a", "t > b", "t > c"],
      [
        { test: "t > a", passed: true },
        { test: "t > b", passed: false },
      ],
    );
    expect(f.map((x) => x.errorExcerpt)).toEqual([
      "t > b: kept by the upgrade, fails after it",
      "t > c: kept by the upgrade, did not run after it",
    ]);
    for (const x of f) expect(x).toMatchObject({ gate: "upgrade-tests", rung: "test" });
  });
});
