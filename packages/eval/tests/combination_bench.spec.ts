import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { type ModelRole, withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkRefusal,
  type ItemRun,
  type QuickBenchmarkInput,
  type ScreenRunner,
  type Throughput,
  cacheKeyString,
  combinationId,
  combinationResults,
  compareOnItems,
  compareRoleScores,
  estimateScreen,
  quickBenchmark,
  readQuickScores,
  scoreItem,
} from "../src/combination_bench.js";
import type { CacheKey, Combination, ItemScore, RoleScore } from "../src/combination_types.js";
import { resolveRunProfile, runProfileHash } from "../src/run_profile.js";
import type { ScreeningSets } from "../src/screening_sets.js";

// Measurement NEW-measurement-5, the quick tier (rules 30–36; MS-N5-1–8):
// real SQLite, a fake clock, a fake runner with scripted timings. No model.

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledger(): EventLog {
  const d = mkdtempSync(join(tmpdir(), "quick-bench-"));
  dirs.push(d);
  const db = new DatabaseSync(join(d, "events.db"));
  dbs.push(db);
  initSchema(db);
  return new EventLog(db);
}

const items = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));

/** Every role's set built (the real Reviewer's and Researcher's arrive in B4.8 and B4.4). */
function allBuilt(): ScreeningSets {
  const set = (role: ModelRole, n: number, cap: number) => ({
    role,
    version: "1",
    state: "ready" as const,
    capSeconds: cap,
    expectedSize: n,
    items: items(role[0] ?? "x", n),
    hash: (role.charCodeAt(0) % 10).toString().repeat(64),
  });
  return {
    roles: {
      worker: set("worker", 6, 120),
      planner: set("planner", 3, 60),
      reviewer: set("reviewer", 10, 20),
      researcher: set("researcher", 5, 40),
    },
    endToEnd: { version: "1", capSeconds: 180, items: items("e", 2) },
  };
}

/** The sets as B4.1 builds them: the Worker's only (the Planner's waits on labelled briefs). */
function workerOnly(): ScreeningSets {
  const s = allBuilt();
  for (const role of ["planner", "reviewer", "researcher"] as const)
    s.roles[role] = {
      ...s.roles[role],
      state: "not_built",
      reason: `${role} not built`,
      hash: undefined,
    };
  return s;
}

interface Call {
  kind: "load" | "item" | "e2e";
  role?: ModelRole;
  model?: string;
  item?: string;
}

/**
 * A fake runner: each item takes `seconds` on the fake clock and returns the
 * scripted outcome; the Worker's default passes every test.
 */
function fakeRunner(
  clock: { t: number },
  script: (role: ModelRole, model: string, item: string) => Partial<ItemRun> = () => ({}),
): ScreenRunner & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async load(role, model) {
      calls.push({ kind: "load", role, model });
      clock.t += 30_000;
      return { seconds: 30 };
    },
    async runItem({ role, model, item, capSeconds }) {
      calls.push({ kind: "item", role, model, item: item.id });
      const s = script(role, model, item.id);
      const seconds = Math.min(s.seconds ?? 40, capSeconds);
      clock.t += seconds * 1000;
      const outcome =
        s.outcome ??
        (role === "worker"
          ? { kind: "tests" as const, passed: 4, total: 4 }
          : role === "planner"
            ? { kind: "recall" as const, covered: 4, annotated: 5 }
            : role === "reviewer"
              ? { kind: "detection" as const, detectedAtLocation: true }
              : { kind: "grade" as const, grade: 1 as const });
      return { toolCalls: 10, validToolCalls: 9, steps: 5, ...s, seconds, outcome };
    },
    async endToEnd({ card }) {
      calls.push({ kind: "e2e", item: card.id });
      clock.t += 120_000;
      return { passed: card.id === "e1", seconds: 120 };
    },
  };
}

const profile = resolveRunProfile({ env: {}, argv: [] });
const keyFor = (role: ModelRole, model: string, setHash: string): CacheKey => ({
  model,
  quantisation: "Q4_K_M",
  engine: "llama.cpp",
  settings: "s1",
  host: "host-a",
  contextVersion: "ctx-1",
  setHash,
});

function input(
  log: EventLog,
  runner: ScreenRunner,
  clock: { t: number },
  over: Partial<QuickBenchmarkInput> = {},
): QuickBenchmarkInput & { released: () => number } {
  let released = 0;
  const scheduler = {
    releaseAll: async () => {
      released++;
    },
  };
  return {
    log,
    sets: allBuilt(),
    runner,
    cacheKey: keyFor,
    fit: () => ({ fits: true }),
    runProfile: profile,
    host: "host-a",
    now: () => clock.t,
    measurementRun: (run) => withMeasurementRun(scheduler, run),
    released: () => released,
    ...over,
  };
}

const combo: Combination = {
  worker: "cyber-tiel",
  planner: "qwen-planner",
  reviewer: "gemma-reviewer",
  researcher: "spark-researcher",
};

describe("scoring a screening item (MS-N5-3)", () => {
  it("scores a Worker card by the fraction of its acceptance tests passing, a Researcher answer 0, ½ or 1, a brief by recall, a defect 1 if found at its location", () => {
    expect(scoreItem({ kind: "tests", passed: 3, total: 4 })).toBe(0.75);
    expect(scoreItem({ kind: "tests", passed: 0, total: 0 })).toBe(0);
    expect(scoreItem({ kind: "grade", grade: 0.5 })).toBe(0.5);
    expect(() => scoreItem({ kind: "grade", grade: 0.7 as 0.5 })).toThrow(/0, ½ or 1/);
    expect(scoreItem({ kind: "recall", covered: 4, annotated: 5 })).toBe(0.8);
    expect(scoreItem({ kind: "detection", detectedAtLocation: true, falseFindings: 2 })).toBe(1);
    expect(scoreItem({ kind: "detection", detectedAtLocation: false })).toBe(0);
  });
});

describe("paired comparison on the same items (MS-N5-4, DB-N6-12)", () => {
  const scores = (xs: number[]): ItemScore[] => xs.map((score, i) => ({ id: `w${i + 1}`, score }));

  it("orders two Workers when one scores higher on all six cards (p ≈ 0.031), even when their ranges overlap", () => {
    const a = { model: "a", items: scores([0.9, 0.8, 1, 0.7, 0.6, 0.95]) };
    const b = { model: "b", items: scores([0.8, 0.7, 0.9, 0.6, 0.5, 0.9]) };
    const c = compareOnItems("worker", a, b);
    expect(c).toMatchObject({ better: 6, worse: 0, ties: 0, indistinguishable: false });
    expect(c.p).toBeCloseTo(0.03125, 5);
  });

  it("calls two Workers indistinguishable at five higher and one tie (p ≈ 0.063), and five to one (p ≈ 0.22)", () => {
    const tie = compareOnItems(
      "worker",
      { model: "a", items: scores([1, 1, 1, 1, 1, 0.5]) },
      { model: "b", items: scores([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]) },
    );
    expect(tie).toMatchObject({ better: 5, worse: 0, ties: 1, indistinguishable: true });
    expect(tie.p).toBeCloseTo(0.0625, 4);
    const fiveOne = compareOnItems(
      "worker",
      { model: "a", items: scores([1, 1, 1, 1, 1, 0]) },
      { model: "b", items: scores([0, 0, 0, 0, 0, 1]) },
    );
    expect(fiveOne.indistinguishable).toBe(true);
    expect(fiveOne.p).toBeCloseTo(0.21875, 4);
  });

  it("never separates two Researchers on five answers, even at five to none", () => {
    const r = compareOnItems(
      "researcher",
      { model: "a", items: scores([1, 1, 1, 1, 1]) },
      { model: "b", items: scores([0, 0, 0, 0, 0]) },
    );
    expect(r.indistinguishable).toBe(true);
  });

  it("compares only the items both scored", () => {
    const r = compareOnItems(
      "worker",
      { model: "a", items: scores([1, 1, 1]) },
      { model: "b", items: [{ id: "w1", score: 0 }] },
    );
    expect(r.better + r.worse + r.ties).toBe(1);
  });

  it("leaves a role that is not measured out of the comparison and says so (MS-N5-4b)", () => {
    const measured: RoleScore = {
      role: "reviewer",
      model: "a",
      state: "measured",
      items: scores([1, 0]),
    };
    const not: RoleScore = { role: "reviewer", model: "b", state: "not_measured" };
    const r = compareRoleScores(measured, not);
    expect("excluded" in r && r.excluded).toMatch(/not measured/);
  });
});

describe("the estimate before anything loads (MS-N5-1, rule 32)", () => {
  const recorded: Throughput = {
    secondsPerItem: (role) =>
      role === "worker"
        ? { seconds: 100, source: "recorded" }
        : { seconds: 50, source: "registry" },
    loadSeconds: () => ({ seconds: 300, source: "recorded" }),
  };

  it("shows minutes per role and model including load, from recorded throughput (else the registry's), and runs nothing", () => {
    const e = estimateScreen(combo, {
      sets: allBuilt(),
      throughput: recorded,
      cached: () => false,
      endToEndCached: false,
      fit: () => ({ fits: true }),
    });
    const worker = e.roles.find((r) => r.role === "worker");
    // 6 cards × 100 s + 300 s load = 900 s = 15 minutes.
    expect(worker).toMatchObject({ state: "to_measure", minutes: 15, overTarget: false });
    expect(worker?.source).toBe("recorded");
    const planner = e.roles.find((r) => r.role === "planner");
    // 3 briefs × min(50, 60) s + 300 s = 450 s = 7.5 minutes: over the 5-minute target.
    expect(planner).toMatchObject({ minutes: 7.5, overTarget: true, targetMinutes: 5 });
    expect(planner?.source).toBe("registry");
    expect(e.toMeasure.map((r) => r.role)).toEqual(["worker", "planner", "reviewer", "researcher"]);
    expect(e.endToEnd).toMatchObject({ minutes: 6, overTarget: false, cached: false });
    expect(e.estimateSeconds).toBe(Math.round(e.totalMinutes * 60));
  });

  it("marks a Worker screen over 17 minutes, an end-to-end check over 10 and a total over 45", () => {
    const slow: Throughput = {
      secondsPerItem: () => ({ seconds: 500, source: "recorded" }),
      loadSeconds: () => ({ seconds: 400, source: "recorded" }),
    };
    const e = estimateScreen(combo, {
      sets: allBuilt(),
      throughput: slow,
      cached: () => false,
      endToEndCached: false,
      fit: () => ({ fits: true, swapSecondsPerSwitch: 120 }),
    });
    // Capped at 2 minutes a card: 6 × 120 + 400 = 1120 s ≈ 18.7 min, over 17.
    expect(e.roles.find((r) => r.role === "worker")).toMatchObject({ overTarget: true });
    // 2 × 180 s + 4 switches × 120 s = 840 s = 14 min, over 10.
    expect(e.endToEnd).toMatchObject({ minutes: 14, overTarget: true });
    expect(e.totalMinutes).toBeGreaterThan(45);
    expect(e.overTarget).toBe(true);
  });

  it("counts only the roles not cached, lists a model that does not fit as needing N GB, and skips roles not built", () => {
    const e = estimateScreen(combo, {
      sets: workerOnly(),
      throughput: recorded,
      cached: (role) => role === "worker",
      endToEndCached: true,
      fit: (role) => (role === "planner" ? { fits: false, needsGb: 21 } : { fits: true }),
    });
    expect(e.roles.find((r) => r.role === "worker")).toMatchObject({ state: "cached", minutes: 0 });
    expect(e.roles.find((r) => r.role === "planner")).toMatchObject({
      state: "does_not_fit",
      needsGb: 21,
    });
    expect(e.roles.find((r) => r.role === "reviewer")).toMatchObject({ state: "not_measured" });
    expect(e.estimateSeconds).toBe(0);
  });
});

describe("the quick benchmark (MS-N5-2, -3, -5, -6, -7, -8; DEC-45)", () => {
  it("screens each role, runs the end-to-end check beside, records one measure/benchmarked event and unloads its models", async () => {
    const log = ledger();
    const clock = { t: Date.parse("2026-09-26T10:00:00Z") };
    const runner = fakeRunner(clock);
    const inp = input(log, runner, clock, { sets: workerOnly() });
    const r = await quickBenchmark(combo, inp);
    expect(inp.released()).toBe(1);
    expect(r.partial).toBe(false);
    const worker = r.roles.find((x) => x.role === "worker");
    expect(worker).toMatchObject({ state: "measured", capped: 0 });
    expect(worker?.score).toMatchObject({ value: 1, n: 6, kind: "graded", low: 1, high: 1 });
    expect(worker?.secondary).toMatchObject({
      secondsPerItem: 40,
      validToolCallRate: 0.9,
      fits: true,
    });
    for (const role of ["planner", "reviewer", "researcher"])
      expect(r.roles.find((x) => x.role === role)?.state).toBe("not_measured");
    // Beside, never folded in (MS-N5-7).
    expect(r.endToEnd).toMatchObject({ passed: 1, total: 2 });
    expect(r.endToEnd?.cards).toHaveLength(2);
    expect(runner.calls.filter((c) => c.kind === "e2e")).toHaveLength(2);

    const events = await log.getEventsByTypes(["measure/benchmarked"]);
    expect(events).toHaveLength(1);
    const p = events[0]?.payload as Record<string, unknown> & {
      roles: Record<string, unknown>[];
    };
    expect(p.tier).toBe("quick");
    expect(p.profileHash).toBe(runProfileHash(profile));
    expect(p.host).toBe("host-a");
    const w = p.roles.find((x) => x.role === "worker");
    expect(w?.cacheKey).toBe(
      cacheKeyString(keyFor("worker", "cyber-tiel", allBuilt().roles.worker.hash ?? "")),
    );
    expect(w?.setHash).toBe(allBuilt().roles.worker.hash);
    expect(w?.items).toHaveLength(6);
    expect(events[0]?.private).toMatchObject({ runProfile: { schema: 1 } });
  });

  it("scores a capped Worker card on the tests passing at its cap, stops it with time_budget_exhausted and counts it", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const runner = fakeRunner(clock, (role, _m, item) =>
      role === "worker" && item === "w2"
        ? { seconds: 500, capped: true, outcome: { kind: "tests", passed: 3, total: 4 } }
        : {},
    );
    const r = await quickBenchmark(combo, input(log, runner, clock, { sets: workerOnly() }));
    const w = r.roles.find((x) => x.role === "worker");
    expect(w?.capped).toBe(1);
    expect(w?.items?.find((i) => i.id === "w2")?.score).toBe(0.75);
    expect(r.itemRuns.find((i) => i.id === "w2")?.stopReason).toBe("time_budget_exhausted");
    expect(w?.score?.value).toBeCloseTo((5 + 0.75) / 6, 6);
  });

  it("re-runs only the role whose model changed, plus the end-to-end check, reusing every other cached score (MS-N5-2)", async () => {
    const log = ledger();
    const clock = { t: 0 };
    await quickBenchmark(combo, input(log, fakeRunner(clock), clock));
    const runner = fakeRunner(clock);
    const r = await quickBenchmark(
      { ...combo, reviewer: "other-reviewer" },
      input(log, runner, clock),
    );
    const screened = new Set(runner.calls.filter((c) => c.kind === "item").map((c) => c.role));
    expect([...screened]).toEqual(["reviewer"]);
    expect(runner.calls.filter((c) => c.kind === "load").map((c) => c.role)).toEqual(["reviewer"]);
    expect(runner.calls.filter((c) => c.kind === "e2e")).toHaveLength(2);
    expect(r.cachedRoles.sort()).toEqual(["planner", "researcher", "worker"]);
    // The new Reviewer is compared with the old on the same defects.
    expect(r.comparisons).toContainEqual(
      expect.objectContaining({ role: "reviewer", a: "other-reviewer", b: "gemma-reviewer" }),
    );
  });

  it("reuses the end-to-end check too when nothing changed", async () => {
    const log = ledger();
    const clock = { t: 0 };
    await quickBenchmark(combo, input(log, fakeRunner(clock), clock));
    const runner = fakeRunner(clock);
    const r = await quickBenchmark(combo, input(log, runner, clock));
    expect(runner.calls).toEqual([]);
    expect(r.endToEnd).toMatchObject({ passed: 1, total: 2 });
  });

  it("stops at the current card's end, keeps and caches every completed role and records the screen as partial (MS-N5-6)", async () => {
    const log = ledger();
    const clock = { t: 0 };
    let stop = false;
    const runner = fakeRunner(clock, (role, _m, item) => {
      if (role === "planner" && item === "p2") stop = true;
      return {};
    });
    const r = await quickBenchmark(combo, input(log, runner, clock, { shouldStop: () => stop }));
    expect(r.partial).toBe(true);
    expect(r.roles.find((x) => x.role === "worker")?.state).toBe("measured");
    const planner = r.roles.find((x) => x.role === "planner");
    expect(planner?.state).toBe("partial");
    expect(planner?.score).toBeUndefined();
    expect(planner?.items).toHaveLength(2);
    expect(runner.calls.some((c) => c.role === "reviewer")).toBe(false);
    expect(runner.calls.some((c) => c.kind === "e2e")).toBe(false);
    const events = await log.getEventsByTypes(["measure/benchmarked"]);
    expect((events[0]?.payload as { partial: boolean }).partial).toBe(true);
    // The Worker's score is cached; the partial Planner's is not.
    const cached = await readQuickScores(log);
    expect(cached.map((c) => c.role)).toEqual(["worker"]);
  });

  it("refuses a combination with a model that does not fit, naming the GB it needs, before loading anything (MS-N5-5)", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const runner = fakeRunner(clock);
    const err = await quickBenchmark(
      combo,
      input(log, runner, clock, {
        fit: (role) => (role === "worker" ? { fits: false, needsGb: 21 } : { fits: true }),
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BenchmarkRefusal);
    expect((err as BenchmarkRefusal).needsGb).toBe(21);
    expect((err as Error).message).toMatch(/needs 21 GB/);
    expect(runner.calls).toEqual([]);
    expect(await log.getEventsByTypes(["measure/benchmarked"])).toHaveLength(0);
  });

  it("derives a combination's id from its four models and the host", () => {
    expect(combinationId(combo, "host-a")).toBe(combinationId({ ...combo }, "host-a"));
    expect(combinationId(combo, "host-a")).not.toBe(combinationId(combo, "host-b"));
    expect(combinationId(combo, "host-a")).toMatch(/^cmb_[0-9a-f]{16}$/);
  });
});

describe("combinations ranked only where the paired test resolves (rule 35, DB-N6-12)", () => {
  it("orders a combination whose Worker is higher on every card, and leaves one higher on five of six indistinguishable", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const scripted = (scores: Record<string, number[]>) =>
      fakeRunner(clock, (role, model, item) => {
        const i = Number(item.slice(1)) - 1;
        const xs = scores[model];
        return role === "worker" && xs
          ? { outcome: { kind: "tests", passed: (xs[i] ?? 0) * 4, total: 4 } }
          : {};
      });
    const runner = scripted({
      best: [1, 1, 1, 1, 1, 1],
      low: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      mixed: [0.75, 0.75, 0.75, 0.75, 0.75, 1],
    });
    const sets = workerOnly();
    for (const worker of ["best", "low", "mixed"])
      await quickBenchmark({ worker, planner: "p" }, input(log, runner, clock, { sets }));
    const results = await combinationResults(log);
    const id = (w: string) => combinationId({ worker: w, planner: "p" }, "host-a");
    const best = results.find((r) => r.combinationId === id("best"));
    const low = results.find((r) => r.combinationId === id("low"));
    expect(best?.tier).toBe("quick");
    expect(best?.indistinguishableFrom).not.toContain(id("low"));
    // best vs mixed: higher on five cards, one tie: p ≈ 0.063, not separated.
    expect(best?.indistinguishableFrom).toContain(id("mixed"));
    expect(low?.indistinguishableFrom).not.toContain(id("best"));
    expect(best?.versusBaseline).toBe("not established");
    expect(best?.score?.value).toBe(1);
  });
});
