import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExemplarStore } from "@sekhemet/context";
import { ManagedLlamaServerAdapter, MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  BudgetPolicyStore,
  LearningGuard,
  boundPolicyChange,
  checkSkillCandidate,
  commandShape,
  defaultSetupCommands,
  distillSkill,
  formatM0Report,
  generateMutants,
  harvestExemplars,
  mineCommitCandidates,
  mineToolProposals,
  playbookDiagnostics,
  qualifyCandidates,
  renderBakeOffMatrix,
  runFrozenRegressionGate,
  runM0Protocol,
  runMutationCampaign,
  siftSlice,
  structurallyComplete,
  synthesizeTasksFromHistory,
  validateToolProposal,
  writeToolCandidate,
} from "../src/index.js";
import type { EvalBenchmarkResult, EvalHarness, SyntheticTask } from "../src/types.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-eval2-"));
  dirs.push(d);
  return d;
};

function gitRepo(): { repo: string; git: (...a: string[]) => string } {
  const repo = tmp();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  return { repo, git };
}

describe("E2/E12: task synthesis from the repository's own history", () => {
  it("turns a fix commit that adds its test into a validated fail-to-pass task", async () => {
    const { repo, git } = gitRepo();
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a - b;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    writeFileSync(join(repo, "notes.js"), "// docs only\n");
    git("add", "-A");
    git("commit", "-q", "-m", "docs");
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a + b;\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(
      join(repo, "tests", "add.test.js"),
      "const add = require('../add');\nif (add(2, 3) !== 5) process.exit(1);\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "fix add in src/add.js: it subtracted");
    // A commit that changes a test and source but whose test already passed before: not a task.
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => b + a;\n");
    writeFileSync(join(repo, "tests", "add.test.js"), "require('../add');\n");
    git("add", "-A");
    git("commit", "-q", "-m", "refactor");

    const candidates = mineCommitCandidates(repo);
    expect(candidates.map((c) => c.subject)).toEqual([
      "refactor",
      "fix add in src/add.js: it subtracted",
    ]);
    const res = await synthesizeTasksFromHistory(repo);
    expect(res.scanned).toBe(2);
    expect(res.tasks).toHaveLength(1);
    const task = res.tasks[0] as SyntheticTask;
    expect(task.failToPassTests).toEqual(["node tests/add.test.js"]);
    expect(task.testPatch?.files).toEqual(["tests/add.test.js"]);
    expect(task.issueDescription).toContain("<path>");
    expect(task.scopeFiles).toEqual(["add.js"]);
    expect(res.rejected[0]?.subject).toBe("refactor");
  }, 30_000);

  it("MS-T8-12: installs the dependencies in each task's own workspace, and discards the task when that fails", async () => {
    const { repo, git } = gitRepo();
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a - b;\n");
    writeFileSync(join(repo, "package.json"), '{ "name": "x", "private": true }\n');
    writeFileSync(join(repo, "package-lock.json"), '{ "lockfileVersion": 3, "packages": {} }\n');
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a + b;\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(
      join(repo, "tests", "add.test.js"),
      "const add = require('../add');\nif (add(2, 3) !== 5) process.exit(1);\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "fix add");
    // The lockfile names the install; the source repository is never touched by it.
    expect(defaultSetupCommands(repo)).toEqual([
      { command: "npm", args: ["ci", "--ignore-scripts"] },
    ]);
    const failing = await synthesizeTasksFromHistory(repo, {
      setupCommands: [{ command: "node", args: ["-e", "process.exit(3)"] }],
    });
    expect(failing.tasks).toEqual([]);
    expect(failing.rejected[0]?.violations.join(" ")).toMatch(
      /dependency install failed .*exited 3/,
    );
    const ok = await synthesizeTasksFromHistory(repo, {
      setupCommands: [
        { command: "node", args: ["-e", "require('fs').writeFileSync('installed', '')"] },
      ],
    });
    expect(ok.tasks).toHaveLength(1);
    expect(existsSync(join(repo, "installed"))).toBe(false);
  }, 30_000);
});

function fakeHarness(passByBudget: Record<number, string[][]>): EvalHarness & { calls: number[] } {
  const counters = new Map<number, number>();
  const calls: number[] = [];
  return {
    calls,
    async runBenchmark(tasks, adapter, options = {}) {
      const budget = options.stepBudget ?? 0;
      calls.push(budget);
      const run = counters.get(budget) ?? 0;
      counters.set(budget, run + 1);
      const passing = new Set(passByBudget[budget]?.[run] ?? []);
      return {
        taskCount: tasks.length,
        passAt1: tasks.filter((t) => passing.has(t.id)).length / tasks.length,
        passAtK: 0,
        totalTokens: 1000,
        totalTimeMs: 60_000,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          passed: passing.has(t.id),
          passedFirstAttempt: passing.has(t.id),
          attempts: [],
          durationMs: 1,
          totalTokens: 1,
        })),
        settings: { modelId: adapter.modelId, stepBudget: budget, quant: options.quant } as never,
      } satisfies EvalBenchmarkResult;
    },
  };
}

describe("E1/E3: the M0 protocol", () => {
  it("runs 3 runs at budgets 50 and 150 with full settings and reports spread", async () => {
    const tasks = ["a", "b", "c", "d"].map((id) => ({
      id,
      repoCommit: "HEAD",
      issueDescription: id,
      failToPassTests: ["x"],
      passToPassTests: [],
    }));
    const harness = fakeHarness({
      50: [["a"], ["a", "b"], ["a"]],
      150: [
        ["a", "c"],
        ["a", "c"],
        ["a", "b", "c"],
      ],
    });
    const adapter = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m/W-IQ3_S.gguf",
      contextTokens: 16384,
    });
    const report = await runM0Protocol({ tasks, adapter, harness });
    expect(harness.calls).toEqual([50, 50, 50, 150, 150, 150]);
    const b50 = report.budgets[0];
    expect(b50?.passAt1).toEqual([0.25, 0.5, 0.25]);
    expect(b50?.mean).toBeCloseTo(0.333, 3);
    expect(b50?.alwaysPassed).toEqual(["a"]);
    expect(report.budgets[1]?.alwaysPassed).toEqual(["a", "c"]);
    expect(report.stepStarved).toEqual(["c"]);
    expect((report.results[0]?.settings as { quant?: string }).quant).toBe("IQ3_S");
  });
});

describe("MS-M9-6: M0 stops at a clean point and resumes where it stopped", () => {
  const tasks = ["a", "b"].map((id) => ({
    id,
    repoCommit: "HEAD",
    issueDescription: id,
    failToPassTests: ["x"],
    passToPassTests: [],
  }));
  const adapter = new ManagedLlamaServerAdapter({ modelId: "w", modelPath: "/m/W-IQ3_S.gguf" });

  it("stops between runs when asked, marking the report partial, and a resumed run skips what was done", async () => {
    const harness = fakeHarness({ 50: [["a"], ["a"], ["a"]], 150: [["a", "b"], ["a"], ["b"]] });
    const done: { budget: number; run: number }[] = [];
    let n = 0;
    const partial = await runM0Protocol({
      tasks,
      adapter,
      harness,
      shouldStop: () => n >= 2,
      onRun: (budget, run) => {
        n++;
        done.push({ budget, run });
      },
    });
    expect(partial.partial).toBe(true);
    expect(harness.calls).toEqual([50, 50]);
    expect(done).toEqual([
      { budget: 50, run: 1 },
      { budget: 50, run: 2 },
    ]);
    const resumed = await runM0Protocol({
      tasks,
      adapter,
      harness,
      resume: partial.results.map((result, i) => ({
        ...(done[i] as { budget: number; run: number }),
        result,
      })),
    });
    expect(resumed.partial).toBeUndefined();
    // Only the four runs not done before were run now.
    expect(harness.calls).toEqual([50, 50, 50, 150, 150, 150]);
    expect(resumed.budgets.map((b) => b.runs)).toEqual([3, 3]);
  });
});

describe("MS-M9-6: the M0 protocol's valid-tool-call rate and the pivot condition", () => {
  const attemptWith = (id: string, steps: number, valid: number) => ({
    taskId: id,
    attempt: 1,
    passed: false,
    temperature: 0,
    durationMs: 1,
    turnsUsed: steps,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    inferenceCalls: 0,
    stopReason: "gates_failed" as never,
    workspacePath: "",
    flippedToPassing: [],
    stillFailing: [],
    regressed: [],
    toolCallSteps: { steps, valid },
  });
  const harnessWith = (valid: number): EvalHarness => ({
    async runBenchmark(tasks, adapter, options = {}) {
      return {
        taskCount: tasks.length,
        passAt1: 0,
        passAtK: 0,
        totalTokens: 0,
        totalTimeMs: 0,
        tasks: tasks.map((t) => ({
          taskId: t.id,
          passed: false,
          passedFirstAttempt: false,
          attempts: [attemptWith(t.id, 10, valid)],
          durationMs: 1,
          totalTokens: 0,
        })),
        settings: { modelId: adapter.modelId, stepBudget: options.stepBudget } as never,
      } satisfies EvalBenchmarkResult;
    },
  });
  const tasks = ["a", "b"].map((id) => ({
    id,
    repoCommit: "HEAD",
    issueDescription: id,
    failToPassTests: ["x"],
    passToPassTests: [],
  }));
  const adapter = new ManagedLlamaServerAdapter({ modelId: "w", modelPath: "/m/W-IQ3_S.gguf" });

  it("reports valid tool calls over every step with an exact interval, and the pivot below 70%", async () => {
    const low = await runM0Protocol({
      tasks,
      adapter,
      harness: harnessWith(6),
      runs: 1,
      budgets: [50],
    });
    expect(low.validToolCalls).toMatchObject({ valid: 12, steps: 20, rate: 0.6, pivot: true });
    expect(low.validToolCalls?.interval.low).toBeCloseTo(0.361, 2);
    expect(low.validToolCalls?.interval.high).toBeCloseTo(0.809, 2);
    expect(formatM0Report(low)).toMatch(
      /valid tool calls 12\/20 = 60% \(95% CI 36%-81%\): below 70%, the M0 pivot condition/,
    );
    const high = await runM0Protocol({
      tasks,
      adapter,
      harness: harnessWith(9),
      runs: 1,
      budgets: [50],
    });
    expect(high.validToolCalls).toMatchObject({ rate: 0.9, pivot: false });
  });

  it("says the rate was not measured when no attempt recorded its steps", async () => {
    const report = await runM0Protocol({
      tasks,
      adapter,
      harness: fakeHarness({ 50: [["a"]] }),
      runs: 1,
      budgets: [50],
    });
    expect(report.validToolCalls).toBeUndefined();
    expect(formatM0Report(report)).toMatch(/valid tool calls: not measured/);
  });
});

describe("E4: MODEL_MATRIX.md from bake-off records", () => {
  it("renders one table per fixture with full settings and lists inadmissible records apart", () => {
    const rec = (modelId: string, passAt1: number, incomplete?: string[]) => ({
      candidate: {
        modelId,
        quant: "Q4_K_M",
        engine: "llama.cpp",
        toolArm: "arm_a_flat" as const,
        contextTokens: 16384,
        kvType: "q8_0",
        mtp: false,
      },
      fixture: "chronicle",
      stepBudget: 50,
      harnessCommit: "abcdef123456",
      date: "2026-09-19T00:00:00Z",
      passed: Math.round(passAt1 * 6),
      total: 6,
      passAt1,
      minutes: 17,
      tokens: 90000,
      ...(incomplete ? { incomplete } : {}),
    });
    const md = renderBakeOffMatrix([
      rec("nail", 0.667),
      rec("dirk", 0.833),
      rec("x", 0.5, ["quant"]),
    ]);
    expect(md).toContain("## chronicle");
    expect(md.indexOf("**dirk**")).toBeLessThan(md.indexOf("| nail"));
    expect(md).toContain(
      "| Q4_K_M | llama.cpp | arm_a_flat | 16384 | q8_0 | off | 50 | 83.3% | 5/6 |",
    );
    expect(md).toContain("- x on chronicle: missing quant");
  });
});

describe("E5: frozen regression suite gates learning changes", () => {
  it("rejects a change that loses a card on any suite, accepts a neutral or better one", async () => {
    const scores: Record<string, [number, number]> = { chronicle: [5, 5], trifecta: [20, 19] };
    const run = async (suite: string, v: "baseline" | "candidate") => ({
      suite,
      passed: (scores[suite] as [number, number])[v === "baseline" ? 0 : 1],
      total: 24,
    });
    const bad = await runFrozenRegressionGate({ suites: ["chronicle", "trifecta"], runSuite: run });
    expect(bad).toMatchObject({ accepted: false });
    expect(bad.reason).toMatch(/trifecta lost 1/);
    scores.trifecta = [20, 21];
    expect(
      (await runFrozenRegressionGate({ suites: ["chronicle", "trifecta"], runSuite: run }))
        .accepted,
    ).toBe(true);
  });
});

describe("E17: the 10-card window is an advisory signal (measurement rule 18, MS-T8-3)", () => {
  it("keeps one change at a time and flags a drop, but never rolls back", () => {
    const path = join(tmp(), "guard.json");
    const guard = new LearningGuard(path);
    for (let i = 0; i < 10; i++) guard.observe(`b${i}`, i < 8);
    const change = guard.activate({ id: "rule_x", kind: "rule", description: "new rule" });
    expect(change.baselinePassRate).toBe(0.8);
    expect(() => guard.activate({ id: "rule_y", kind: "rule", description: "y" })).toThrow(
      /one change at a time/,
    );
    let decision: ReturnType<LearningGuard["observe"]> = {};
    for (let i = 0; i < 10; i++) decision = guard.observe(`c${i}`, i < 5);
    expect(decision).not.toHaveProperty("rollback");
    expect(decision.flagged?.id).toBe("rule_x");
    expect(decision.flagged?.reason).toMatch(/advisory.*paired suite run/);
    const reloaded = new LearningGuard(path);
    expect(reloaded.changes()[0]?.status).toBe("flagged");
    expect(reloaded.watching()).toBeUndefined();
  });

  it("assumes no baseline without history: it reports insufficient data", () => {
    const guard = new LearningGuard(join(tmp(), "guard.json"));
    const change = guard.activate({ id: "rule_x", kind: "rule", description: "new rule" });
    expect(change.baselinePassRate).toBeUndefined();
    let decision: ReturnType<LearningGuard["observe"]> = {};
    for (let i = 0; i < 10; i++) decision = guard.observe(`c${i}`, false);
    expect(decision.flagged).toBeUndefined();
    expect(decision.insufficient?.reason).toMatch(/insufficient data/);
  });
});

describe("E8: tuned budgets applied within 15%, reversibly", () => {
  it("clamps the move, records it with the guard and rolls back", () => {
    expect(
      boundPolicyChange(
        { stepBudget: 50, maxFailedChecks: 3 },
        { stepBudget: 20, maxFailedChecks: 1 },
      ),
    ).toEqual({
      stepBudget: 43,
      maxFailedChecks: 2,
      clamped: true,
    });
    const dir = tmp();
    const guard = new LearningGuard(join(dir, "guard.json"));
    const store = new BudgetPolicyStore(join(dir, "budget.json"));
    const applied = store.apply(
      { stepBudget: 30, maxFailedChecks: 3 },
      "tune: most passes finish by step 28",
      guard,
    );
    // WL-T3-11: the store starts at the one default of 40; 15% of it lands on 34.
    expect(applied.policy.stepBudget).toBe(34);
    expect(applied.reason).toMatch(/clamped/);
    expect(guard.watching()?.kind).toBe("budget");
    expect(new BudgetPolicyStore(join(dir, "budget.json")).current().stepBudget).toBe(34);
    expect(store.rollback(applied.id)).toEqual({ stepBudget: 40, maxFailedChecks: 3 });
  });
});

describe("E14: SIFT slice", () => {
  it("picks uncertain tasks across classes", () => {
    const slice = siftSlice(
      [
        { taskId: "always", cardClass: "a", passes: 10, runs: 10 },
        { taskId: "coin", cardClass: "a", passes: 5, runs: 10 },
        { taskId: "never", cardClass: "b", passes: 0, runs: 10 },
        { taskId: "b-coin", cardClass: "b", passes: 4, runs: 9 },
      ],
      2,
    );
    expect(slice.map((s) => s.taskId)).toEqual(["coin", "b-coin"]);
  });
});

describe("E10: skill distillation to a candidate needing approval", () => {
  it("derives triggers and the shared procedure from passing trajectories", async () => {
    const t = (id: string, title: string, passed = true) => ({
      cardId: id,
      title,
      cardClass: "task:ts:feature",
      passed,
      steps: [
        { action: "read_file src/db.ts", result: "ok" },
        { action: "edit src/db.ts", result: "ok" },
        { action: "check typecheck", result: "pass" },
      ],
    });
    const out = tmp();
    const skill = await distillSkill(
      [
        t("c1", "Add ledger migration"),
        t("c2", "Ledger migration for accounts"),
        t("c3", "Migration: ledger index"),
        t("c4", "x", false),
      ],
      { outDir: out },
    );
    expect(skill?.triggers.slice(0, 2).sort()).toEqual(["ledger", "migration"]);
    expect(skill?.body).toContain("1. read_file\n2. edit\n3. check");
    expect(skill?.provenance).toEqual(["c1", "c2", "c3"]);
    expect(readFileSync(skill?.path as string, "utf8")).toMatch(/^---\ndescription:/);
    expect(await distillSkill([t("c1", "a")])).toBeUndefined();
  });
});

describe("MS-T8-5: a skill candidate is checked by its own checks, confined, before anything else", () => {
  const candidate = (checks?: unknown) => {
    const dir = join(tmp(), "cand");
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\ndescription: x\n---\n1. read\n");
    if (checks !== undefined)
      writeFileSync(join(dir, "evals", "checks.json"), JSON.stringify(checks));
    return dir;
  };

  it("runs each check confined in the candidate's directory and keeps it when all pass", async () => {
    const dir = candidate([{ command: "node", args: ["check.js"] }]);
    const ran: { command: string; root: string }[] = [];
    const r = await checkSkillCandidate(dir, {
      run: async (command, _args, root) => {
        ran.push({ command, root });
        return { exitCode: 0, output: "ok" };
      },
    });
    expect(r).toMatchObject({ status: "checked", passed: 1 });
    expect(ran).toEqual([{ command: "node", root: dir }]);
    expect(existsSync(dir)).toBe(true);
  });

  it("discards a candidate whose check fails, and says which", async () => {
    const dir = candidate([
      { command: "node", args: ["ok.js"] },
      { command: "node", args: ["bad.js"] },
    ]);
    const r = await checkSkillCandidate(dir, {
      run: async (_c, args) => ({ exitCode: args[0] === "bad.js" ? 1 : 0, output: "boom" }),
    });
    expect(r).toMatchObject({ status: "discarded" });
    expect(r.reason).toMatch(/node bad\.js exited 1/);
    expect(existsSync(dir)).toBe(false);
  });

  it("marks a candidate with no checks unchecked: nothing grounds it, so it cannot be approved", async () => {
    const r = await checkSkillCandidate(candidate(), {
      run: async () => ({ exitCode: 0, output: "" }),
    });
    expect(r).toMatchObject({ status: "unchecked" });
    expect(r.reason).toMatch(/no checks/);
  });
});

describe("E11: exemplar harvesting, from five complete cards per class (rule 20)", () => {
  const passing = (id: string) => ({
    id,
    tier: "task",
    title: `Fix rounding ${id}`,
    scopeFiles: ["src/a.ts"],
    passed: true,
    tokens: 900,
    turns: [{ turn: 1, action: "edit src/a.ts", result: "ok" }],
  });

  it("offers nothing until a class has five structurally complete passing cards, then all of them", () => {
    const dir = tmp();
    const store = new ExemplarStore(join(dir, "ex"));
    const pool = join(dir, "exemplar_pool.json");
    for (const id of ["c1", "c2", "c3", "c4"]) {
      expect(harvestExemplars(store, [passing(id)], { poolPath: pool })).toEqual([]);
    }
    // A failing card never counts.
    expect(
      harvestExemplars(store, [{ ...passing("x"), passed: false }], { poolPath: pool }),
    ).toEqual([]);
    expect(store.topFor("implement:ts")).toEqual([]);
    const fifth = harvestExemplars(store, [passing("c5")], { poolPath: pool });
    expect(fifth.map((e) => e.cardId)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
    expect(store.topFor("implement:ts").length).toBeGreaterThan(0);
    // Once the class is open, a new card goes straight in.
    expect(
      harvestExemplars(store, [passing("c6")], { poolPath: pool }).map((e) => e.cardId),
    ).toEqual(["c6"]);
  });
});

describe("MS-T8-6: only structurally complete trajectories become exemplars or skill sources", () => {
  const card = (
    id: string,
    turns: {
      turn: number;
      action: string;
      result: string;
      calls?: number;
      observations?: number;
    }[],
  ) => ({
    id,
    tier: "task",
    title: `Fix ${id}`,
    scopeFiles: ["src/a.ts"],
    passed: true,
    tokens: 100,
    turns,
  });

  it("refuses an exemplar with an unclosed tool call or turns out of order", () => {
    expect(structurallyComplete([{ turn: 1, calls: 2, observations: 2 }, { turn: 2 }])).toBe(true);
    expect(structurallyComplete([{ turn: 1, calls: 2, observations: 1 }])).toBe(false);
    expect(structurallyComplete([{ turn: 2 }, { turn: 1 }])).toBe(false);
    const store = new ExemplarStore(join(tmp(), "ex"));
    const got = harvestExemplars(
      store,
      [
        card("ok", [{ turn: 1, action: "edit src/a.ts", result: "ok", calls: 1, observations: 1 }]),
        card("open", [{ turn: 1, action: "edit src/a.ts", result: "", calls: 1, observations: 0 }]),
        card("jumbled", [
          { turn: 2, action: "check", result: "pass" },
          { turn: 1, action: "edit", result: "ok" },
        ]),
      ],
      // The volume threshold is tested above; this one isolates the structural filter.
      { minPerClass: 1 },
    );
    expect(got.map((e) => e.cardId)).toEqual(["ok"]);
  });

  it("leaves an incomplete trajectory out of a skill's sources", async () => {
    const t = (id: string, closed = true) => ({
      cardId: id,
      title: "Add ledger migration",
      cardClass: "task:ts:feature",
      passed: true,
      steps: [
        { action: "read_file src/db.ts", result: "ok" },
        { action: "edit src/db.ts", result: "ok", closed },
      ],
    });
    // Two complete wins are below the three a skill needs.
    expect(await distillSkill([t("c1"), t("c2"), t("c3", false)])).toBeUndefined();
    expect((await distillSkill([t("c1"), t("c2"), t("c3")]))?.provenance).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
  });
});

describe("E15: tool synthesis", () => {
  it("proposes a tool from a command shape used on 3+ cards and validates it for real", async () => {
    expect(commandShape("node scripts/check.js 3").shape).toBe("node {path} {n}");
    const props = mineToolProposals([
      { cardId: "a", command: "node scripts/check.js src/a.ts" },
      { cardId: "b", command: "node scripts/check.js src/b.ts" },
      { cardId: "c", command: "node scripts/check.js src/c.ts" },
      { cardId: "c", command: "ls" },
    ]);
    expect(props).toHaveLength(1);
    expect(props[0]).toMatchObject({
      name: "node",
      template: "node {path0} {path1}",
      params: ["path0", "path1"],
    });
    const root = tmp();
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts", "check.js"), "process.exit(process.argv[2] ? 0 : 1);\n");
    const validated = await validateToolProposal(props[0] as never, async (cmd) => {
      try {
        const [bin, ...args] = cmd.split(" ");
        execFileSync(bin as string, args, { cwd: root });
        return { exitCode: 0, output: "" };
      } catch (e) {
        return { exitCode: (e as { status?: number }).status ?? 1, output: "" };
      }
    });
    expect(validated.status).toBe("validated");
    expect(existsSync(writeToolCandidate(join(root, "tool-candidates"), validated))).toBe(true);
  });
});

describe("E16: mutants to tests", () => {
  it("mutates tokens (not strings), runs the real tests and proposes tests for survivors", async () => {
    const src =
      'export function clamp(n, lo, hi) {\n  if (n < lo) return lo;\n  if (n > hi) return hi;\n  return n; // "a < b" in a comment\n}\n';
    const mutants = generateMutants(src, { fileName: "clamp.js" });
    expect(mutants.map((m) => `${m.line}:${m.original}->${m.replacement}`)).toEqual(
      ["2:<->=<", "3:>->>="].map((s) => s.replace("=<", "<=")),
    );
    const root = tmp();
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(root, "test.js"),
      "import { clamp } from './clamp.js';\nif (clamp(5, 0, 3) !== 3 || clamp(-1, 0, 3) !== 0) process.exit(1);\n",
    );
    const report = await runMutationCampaign("clamp.js", mutants, async (mutated) => {
      writeFileSync(join(root, "clamp.js"), mutated);
      try {
        execFileSync(process.execPath, ["test.js"], { cwd: root, stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    });
    // Boundary mutants survive: no test checks clamp at exactly lo or hi.
    expect(report.total).toBe(2);
    expect(report.survived.length).toBe(2);
    expect(report.proposals[0]).toMatch(/clamp.js:2 used `<=` instead of `<`/);
  });
});

describe("E19/E6: doctor diagnostics and qualification scoring", () => {
  it("reports net gain, bloat, untriggered skills and pruning", () => {
    const root = tmp();
    mkdirSync(join(root, ".sekhemet"));
    writeFileSync(
      join(root, ".sekhemet", "playbook.toml"),
      `[[rule]]\nid = "good"\npattern = "src/"\ninstruction = "Cast rows through unknown."\n\n[[rule]]\nid = "bloat"\npattern = "src/"\ninstruction = "${"Consider everything carefully. ".repeat(60)}"\n`,
    );
    const d = playbookDiagnostics({
      repoPath: root,
      outcomes: [
        {
          ruleId: "good",
          withRule: { cards: 10, passed: 8 },
          withoutRule: { cards: 10, passed: 5 },
        },
        {
          ruleId: "bloat",
          withRule: { cards: 10, passed: 5 },
          withoutRule: { cards: 10, passed: 5 },
        },
      ],
      skills: [{ name: "css", description: "", triggers: ["style"], content: "No shadows." }],
      recentCards: [{ title: "Ledger", scopeFiles: ["src/ledger.ts"] }],
    });
    expect(d.netGain.find((g) => g.ruleId === "good")?.gain).toBe(0.3);
    expect(d.neverTriggered).toEqual(["css"]);
    expect(d.recommendations.find((r) => r.ruleId === "bloat")?.action).toBe("retire");
    expect(d.bloat.ruleTokens).toBeGreaterThan(300);
    expect(d.lines.join("\n")).toMatch(/RETIRE bloat/);
  });

  it("ranks candidates by the deterministic qualification suite", async () => {
    const silent = new MockInferenceAdapter("silent", [], { exhaustion: "default" });
    const r = await qualifyCandidates([silent]);
    expect(r[0]?.modelId).toBe("silent");
    expect(r[0]?.qualified).toBe(false);
  });
});
