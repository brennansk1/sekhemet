import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GateProjectConfig, runBuiltinGates } from "../src/index.js";
import { equivalentMutant, readMutationQueue, runNightlyMutation } from "../src/mutation.js";

// Gates rule 32 (GT-TQ-3, GT-TQ-4, GT-TQ-5) and GT-N5-2, GT-N5-5: two
// mutation scores over non-equivalent mutants, stillborn and equivalent
// mutants excluded and counted, survivors a test gap for a person, per-language
// tools when installed, and mutants past the cap run in the nightly run.

const project: GateProjectConfig = {
  protected: [],
  maxFiles: 5,
  maxDiffLines: 200,
  mutation: true,
};

let root: string;
let state: string;
const git = (...a: string[]) =>
  execFileSync("git", a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const diff = () => {
  git("add", "-A");
  return git("diff", "--cached", "--unified=0", "main");
};
const none = () => false;
const src = () => readFileSync(join(root, "a.ts"), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mutation-scores-"));
  state = mkdtempSync(join(tmpdir(), "mutation-state-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  git("checkout", "-q", "-b", "card");
});
afterEach(() => {
  for (const d of [root, state]) rmSync(d, { recursive: true, force: true });
});

const measureOf = (r: Awaited<ReturnType<typeof runBuiltinGates>>) =>
  r.outcomes.find((o) => o.gate === "mutation")?.mutation;

describe("two scores, and survivors go to a person (GT-TQ-3, GT-TQ-5)", () => {
  it("reports the suite score and the acceptance-test score separately", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\nexport const small = (n: number) => n < 3;\n",
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationBlocking: true },
      which: none,
      stateDir: state,
      // The whole suite pins both functions; the card's acceptance tests pin only `big`.
      runTests: async () => src().includes("n > 10") && src().includes("n < 3"),
      runAcceptanceTests: async () => src().includes("n > 10"),
    });
    const m = measureOf(r);
    expect(m).toMatchObject({ score: 1, killed: 2, total: 2 });
    expect(m?.acceptance).toMatchObject({ score: 0.5, killed: 1, total: 2 });
    // The survivor is a test gap for a person, never the Worker's failure,
    // even when the project makes mutation blocking.
    expect(r.failures.filter((f) => f.gate === "mutation")).toEqual([]);
    expect(r.testGaps).toEqual([
      expect.stringContaining('a.ts:3 "<" -> "<=" passes the card\'s acceptance tests'),
    ]);
    expect(m?.strengthUnmet).toBe(true);
    expect(r.outcomes.find((o) => o.gate === "mutation")?.passed).toBe(true);
    for (const a of r.advisories) expect(a).not.toMatch(/add a test/i);
  });

  it("says why there is no acceptance score when no acceptance runner is given", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      stateDir: state,
      runTests: async () => src().includes("n > 10"),
    });
    expect(measureOf(r)?.acceptance).toMatchObject({
      score: null,
      reason: "no acceptance-test run given",
    });
    expect(r.testGaps).toEqual([]);
  });
});

describe("stillborn and equivalent mutants are excluded and counted (GT-TQ-4)", () => {
  it("knows a mutant whose transpiled output is the original's", () => {
    expect(
      equivalentMutant(
        "a.ts",
        "type F = true;\nexport const x = 1;\n",
        "type F = false;\nexport const x = 1;\n",
      ),
    ).toBe(true);
    expect(equivalentMutant("a.ts", "export const x = 1 + 2;\n", "export const x = 1 - 2;\n")).toBe(
      false,
    );
  });

  it("excludes both from both scores", async () => {
    writeFileSync(
      join(root, "a.ts"),
      [
        "export const a = 1;",
        "type Flag = true;",
        "export const join2 = (a: string, b: string): string => a + b;",
        "export const big = (n: number) => n > 10;",
        "export const flag: Flag = true;",
        "",
      ].join("\n"),
    );
    let typechecks = 0;
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      stateDir: state,
      // The project's typecheck fails the string subtraction and the `false` flag.
      runTypecheck: async () => {
        typechecks++;
        return !src().includes("a - b") && !src().includes("flag: Flag = false");
      },
      runTests: async () => src().includes("n > 10"),
      runAcceptanceTests: async () => src().includes("n > 10"),
    });
    const m = measureOf(r);
    expect(m).toMatchObject({ equivalent: 1, stillborn: 2, total: 1, killed: 1, score: 1 });
    expect(m?.acceptance).toMatchObject({ total: 1, killed: 1 });
    // The unmutated tree once, then the three non-equivalent mutants; the equivalent one never.
    expect(typechecks).toBe(4);
  });

  it("judges no mutant stillborn when the typecheck fails on the unmutated tree, and says why", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      stateDir: state,
      // A pre-existing type error the gate cannot tell apart from a mutant's.
      runTypecheck: async () => false,
      runTests: async () => src().includes("n > 10"),
    });
    const m = measureOf(r);
    expect(m).toMatchObject({ stillborn: 0, total: 1, killed: 1, score: 1 });
    expect(m?.stillbornNotJudged).toMatch(/typecheck fails on the unmutated tree/);
  });

  it("calls a change whose every mutant is stillborn not measured, never a score", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const big = (n: number) => n > 10;\n",
    );
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      stateDir: state,
      runTypecheck: async () => src().includes("n > 10"),
      runTests: async () => true,
    });
    const m = measureOf(r);
    expect(m).toMatchObject({ stillborn: 1, total: 0, score: null });
    expect(m?.refused).toMatch(/no live mutant/);
    expect(m?.acceptance?.score ?? null).toBeNull();
  });
});

describe("mutants past the cap run in the nightly run (GT-N5-5)", () => {
  it("scores the first mutation_max, marks the score partial, and completes it nightly", async () => {
    writeFileSync(
      join(root, "a.ts"),
      [
        "export const a = 1;",
        "export const p = (n: number) => n > 1;",
        "export const q = (n: number) => n > 2;",
        "export const r = (n: number) => n > 3;",
        "export const s = (n: number) => n > 4;",
        "",
      ].join("\n"),
    );
    // Every mutant but `s`'s is killed.
    const tests = async () => ["n > 1", "n > 2", "n > 3"].every((t) => src().includes(t));
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationMax: 2 },
      which: none,
      stateDir: state,
      cardId: "card-7",
      runTests: tests,
      runAcceptanceTests: tests,
    });
    const m = measureOf(r);
    expect(m).toMatchObject({ score: 1, killed: 2, total: 2 });
    expect(m?.partial).toMatchObject({ scored: 2, deferred: 2 });
    const queue = m?.partial?.queue as string;
    expect(existsSync(queue)).toBe(true);
    expect(readMutationQueue(queue)?.mutants.map((x) => x.line)).toEqual([4, 5]);

    const full = await runNightlyMutation({
      queue,
      root,
      runTests: tests,
      runAcceptanceTests: tests,
    });
    expect(full).toMatchObject({ score: 0.75, killed: 3, total: 4 });
    expect(full.acceptance).toMatchObject({ score: 0.75, killed: 3, total: 4 });
    expect(full.partial).toBeUndefined();
    expect(readMutationQueue(queue)?.completed).toMatchObject({ score: 0.75, total: 4 });
    // The tree is back as it was.
    expect(src()).toContain("n > 4");
  });

  it("does not run a deferred mutant whose file changed since, and names it", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const p = (n: number) => n > 1;\nexport const q = (n: number) => n > 2;\n",
    );
    const tests = async () => true;
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationMax: 1 },
      which: none,
      stateDir: state,
      cardId: "card-8",
      runTests: tests,
    });
    const queue = measureOf(r)?.partial?.queue as string;
    writeFileSync(join(root, "a.ts"), `${src()}// edited\n`);
    const full = await runNightlyMutation({ queue, root, runTests: tests });
    expect(full.total).toBe(1);
    expect(full.stale).toEqual(["a.ts:3"]);
  });

  it("at night too: no stillborn verdict from a typecheck that fails unmutated, the score on the ledger before the queue completes, and no live mutant is not measured", async () => {
    writeFileSync(
      join(root, "a.ts"),
      "export const a = 1;\nexport const p = (n: number) => n > 1;\nexport const q = (n: number) => n > 2;\n",
    );
    const tests = async () => src().includes("n > 1") && src().includes("n > 2");
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationMax: 1 },
      which: none,
      stateDir: state,
      cardId: "card-9",
      runTests: tests,
    });
    const queue = measureOf(r)?.partial?.queue as string;
    const seen: (object | undefined)[] = [];
    const full = await runNightlyMutation({
      queue,
      root,
      runTests: tests,
      runTypecheck: async () => false,
      beforeComplete: async () => {
        seen.push(readMutationQueue(queue)?.completed);
      },
    });
    expect(full).toMatchObject({ stillborn: 0, total: 2, killed: 2 });
    expect(full.stillbornNotJudged).toMatch(/typecheck fails on the unmutated tree/);
    // The record came first: the queue was not yet complete when it was made.
    expect(seen).toEqual([undefined]);
    expect(readMutationQueue(queue)?.completed).toMatchObject({ total: 2 });

    // A queue whose every mutant is stillborn, with nothing scored before: not measured.
    const r2 = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project: { ...project, mutationMax: 1 },
      which: none,
      stateDir: state,
      cardId: "card-10",
      runTests: tests,
      runTypecheck: async () => !src().includes("n >= 1"),
    });
    expect(measureOf(r2)).toMatchObject({ total: 0, stillborn: 1, score: null });
    const q2 = measureOf(r2)?.partial?.queue as string;
    const night = await runNightlyMutation({
      queue: q2,
      root,
      runTests: tests,
      runTypecheck: async () => !src().includes("n >= 2"),
    });
    expect(night).toMatchObject({ total: 0, stillborn: 2 });
    expect(night.refused).toMatch(/no live mutant/);
    expect(night.score).toBeNull();
  });
});

describe("per-language mutation tools (GT-N5-2)", () => {
  it("records changed Python as not measured when mutmut is not installed", async () => {
    writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
    const r = await runBuiltinGates({
      root,
      base: "main",
      diff: diff(),
      project,
      which: none,
      stateDir: state,
      runTests: async () => true,
    });
    expect(measureOf(r)?.notMeasured).toEqual([
      { file: "calc.py", reason: "mutation not measured: mutmut not installed" },
    ]);
  });

  it.runIf(platform() === "darwin")(
    "runs an installed tool confined, scoped to the diff, and counts its mutants",
    async () => {
      writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
      const bin = mkdtempSync(join(tmpdir(), "mutation-bin-"));
      try {
        const report = join(bin, "report.xml");
        writeFileSync(
          report,
          `<?xml version="1.0" ?><testsuites><testsuite name="mutmut" tests="2">
<testcase name="Mutant #1" file="calc.py" line="2"></testcase>
<testcase name="Mutant #2" file="calc.py" line="2"><failure type="failure" message="bad_survived">x</failure></testcase>
</testsuite></testsuites>`,
        );
        const mutmut = join(bin, "mutmut");
        writeFileSync(
          mutmut,
          `#!/bin/sh\nif [ "$1" = run ]; then exit 2; fi\nif [ "$1" = junitxml ]; then cat '${report}'; exit 0; fi\nexit 9\n`,
        );
        chmodSync(mutmut, 0o755);
        const r = await runBuiltinGates({
          root,
          base: "main",
          diff: diff(),
          project,
          stateDir: state,
          programs: { mutmut: [mutmut] },
          runTests: async () => true,
        });
        const m = measureOf(r);
        expect(m?.notMeasured).toEqual([]);
        expect(m).toMatchObject({ killed: 1, total: 2, score: 0.5 });
        expect(m?.tools).toEqual([{ tool: "mutmut", files: ["calc.py"] }]);
        expect(r.testGaps).toEqual([expect.stringContaining("calc.py:2")]);
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    60_000,
  );
  it.runIf(platform() === "darwin")(
    "with mutation_blocking, a tool that gives no verdict fails as not run, never passes as skipped",
    async () => {
      writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
      const bin = mkdtempSync(join(tmpdir(), "mutation-bin-"));
      try {
        const mutmut = join(bin, "mutmut");
        writeFileSync(mutmut, "#!/bin/sh\nexit 9\n");
        chmodSync(mutmut, 0o755);
        const run = (mutationBlocking: boolean) =>
          runBuiltinGates({
            root,
            base: "main",
            diff: diff(),
            project: { ...project, mutationBlocking },
            stateDir: state,
            programs: { mutmut: [mutmut] },
            runTests: async () => true,
          });
        const advisory = await run(false);
        expect(measureOf(advisory)?.refused).toBe("no mutation tool gave a verdict");
        expect(advisory.failures.filter((f) => f.gate === "mutation")).toEqual([]);
        const blocking = await run(true);
        const failed = blocking.failures.filter((f) => f.gate === "mutation");
        expect(failed).toHaveLength(1);
        expect(failed[0]).toMatchObject({ notRun: true });
        expect(failed[0]?.errorExcerpt).toContain(
          "mutation not run: no mutation tool gave a verdict",
        );
        const o = blocking.outcomes.find((x) => x.gate === "mutation");
        expect(o?.passed).toBe(false);
        expect(o?.skipped).toBeFalsy();
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
