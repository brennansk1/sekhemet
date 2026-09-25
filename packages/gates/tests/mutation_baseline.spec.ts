import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GateProjectConfig, runBuiltinGates } from "../src/index.js";

// Measurement MS-M10-4: the built-in mutation gate applies the improve
// campaign's baseline rule. The unmutated tests must pass before any mutant
// counts (otherwise every mutant "dies" and the score reads 1.0); a change
// with no mutable lines is not measured, never a pass; and changed code in a
// language the gate cannot mutate is named with the reason.

const project: GateProjectConfig = {
  protected: [],
  maxFiles: 5,
  maxDiffLines: 200,
  mutation: true,
};

let root: string;
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const diff = () => {
  git("add", "-A");
  return git("diff", "--cached", "--unified=0", "main");
};
const none = () => false;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mutation-baseline-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const mutationOutcome = (r: Awaited<ReturnType<typeof runBuiltinGates>>) =>
  r.outcomes.find((o) => o.gate === "mutation");

describe("MS-M10-4: the mutation gate's baseline", () => {
  it("runs the tests once on the unmutated change before any mutant, and scores killed over total", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    const calls: string[] = [];
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      runTests: async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(join(root, "a.ts"), "utf8");
        calls.push(src.includes("n > 10") ? "unmutated" : "mutant");
        // The unmutated tests pass; every mutant is killed.
        return src.includes("n > 10");
      },
    });
    expect(calls).toEqual(["unmutated", "mutant"]);
    const o = mutationOutcome(r);
    expect(o?.passed).toBe(true);
    expect(o?.mutation).toMatchObject({ score: 1, killed: 1, total: 1, notMeasured: [] });
    expect(o?.mutation?.refused).toBeUndefined();
  });

  it("refuses to score when the unmutated tests fail, instead of counting every mutant killed", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    let runs = 0;
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      runTests: async () => {
        runs++;
        return false;
      },
    });
    expect(runs).toBe(1);
    const o = mutationOutcome(r);
    expect(o?.passed).toBe(true);
    expect(o?.skipped).toBe(true);
    expect(o?.reason).toMatch(/tests fail on the unmutated change/);
    expect(o?.mutation).toMatchObject({ score: null, killed: 0, total: 0 });
    expect(o?.mutation?.refused).toMatch(/tests fail on the unmutated change/);
    expect(r.failures.some((f) => f.gate === "mutation")).toBe(false);
  });

  it("reports a blocking gate that could not score as not run, never as a pass or the Worker's failure", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationBlocking: true },
      which: none,
      runTests: async () => false,
    });
    const o = mutationOutcome(r);
    expect(o?.passed).toBe(false);
    expect(o?.mutation?.score).toBeNull();
    const f = r.failures.find((x) => x.gate === "mutation");
    expect(f?.notRun).toBe(true);
  });

  it("does not measure a change with no mutable lines, and does not call it a pass", async () => {
    writeFileSync(join(root, "a.ts"), 'export const a = 1;\nexport const name = "ledger";\n');
    let runs = 0;
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationBlocking: true },
      which: none,
      runTests: async () => {
        runs++;
        return true;
      },
    });
    expect(runs).toBe(0);
    const o = mutationOutcome(r);
    expect(o?.skipped).toBe(true);
    expect(o?.reason).toMatch(/no mutable lines/);
    expect(o?.mutation).toMatchObject({ score: null, total: 0 });
    expect(r.failures.some((f) => f.gate === "mutation")).toBe(false);
  });

  it("names changed code it cannot mutate, with the reason", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    writeFileSync(join(root, "tool.py"), "def big(n):\n    return n > 10\n");
    writeFileSync(join(root, "README.md"), "# notes\n");
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      runTests: async () => true,
    });
    const o = mutationOutcome(r);
    expect(o?.mutation?.notMeasured).toEqual([
      { file: "tool.py", reason: "no mutation operators for .py files" },
    ]);
    expect(o?.mutation).toMatchObject({ score: 0, killed: 0, total: 1 });
  });
});
