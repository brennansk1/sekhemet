import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { assignRole, withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import type { Combination } from "../src/combination_types.js";
import {
  type OvernightInput,
  type OvernightRunner,
  type OvernightSets,
  bakeOffEvidence,
  benchmarkRuns,
  defaultOvernightPicks,
  estimateNight,
  morningReport,
  overnightVerdict,
  planBlocks,
  runOvernightBench,
  scheduleOvernight,
} from "../src/overnight_bench.js";
import { resolveRunProfile } from "../src/run_profile.js";

// Measurement rule 37 and MS-N5-9–12, models rule 20b and MD-N3-4/5: the
// overnight tier's counterbalanced blocks, its estimate, its clean stop and
// resume, the morning report. Real SQLite, a fake clock, a fake runner.

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledger(): EventLog {
  const d = mkdtempSync(join(tmpdir(), "overnight-bench-"));
  dirs.push(d);
  const db = new DatabaseSync(join(d, "events.db"));
  dbs.push(db);
  initSchema(db);
  return new EventLog(db);
}

const A: Combination = { worker: "wa", planner: "p" };
const B: Combination = { worker: "wb", planner: "p" };
const C: Combination = { worker: "wc", planner: "p" };

/** Four suite cards for the Worker; the other roles' full sets are not built yet. */
const SETS: OvernightSets = {
  roles: {
    worker: {
      state: "ready",
      runs: 2,
      cards: ["s1", "s2", "s3", "s4"].map((id) => ({ id, role: "worker" as const })),
    },
    planner: { state: "not_built", runs: 1, cards: [], reason: "golden briefs unlabelled" },
    reviewer: { state: "not_built", runs: 1, cards: [], reason: "B4.8" },
    researcher: { state: "not_built", runs: 1, cards: [], reason: "B4.4" },
  },
};

interface Trace {
  swaps: string[];
  cards: string[];
}

/** A runner whose Worker `wa` passes every card, `wb` all but s4, `wc` only s1. */
function fakeRunner(clock: { t: number }, trace: Trace, cut?: (n: number) => boolean) {
  let n = 0;
  const runner: OvernightRunner = {
    async swapTo(c) {
      trace.swaps.push(c.worker);
      clock.t += 60_000;
    },
    async runCard({ combination, card, run }) {
      n++;
      clock.t += 600_000;
      if (cut?.(n)) return { passed: false, seconds: 300, cutAtWindowEnd: true };
      trace.cards.push(`${combination.worker}:${card.id}:${run}`);
      const passed =
        combination.worker === "wa" ||
        (combination.worker === "wb" && card.id !== "s4") ||
        card.id === "s1";
      return { passed, seconds: 600 };
    },
  };
  return runner;
}

const profile = resolveRunProfile({ env: {}, argv: [] });
const FP = { build: "b1", contextVersion: "c1", qualification: "q1" };

function night(
  log: EventLog,
  runId: string,
  runner: OvernightRunner,
  clock: { t: number },
  over: Partial<OvernightInput> = {},
): OvernightInput & { released: () => number } {
  let released = 0;
  return {
    log,
    runId,
    runner,
    sets: SETS,
    host: "host-a",
    now: () => clock.t,
    window: () => ({ open: true, why: "inside the overnight window" }),
    fingerprint: FP,
    runProfileFor: () => profile,
    measurementRun: (run) =>
      withMeasurementRun(
        {
          releaseAll: async () => {
            released++;
          },
        },
        run,
      ),
    released: () => released,
    ...over,
  };
}

async function schedule(log: EventLog, combos: Combination[], first = false) {
  return scheduleOvernight(log, {
    combinations: combos,
    host: "host-a",
    principal: "p_owner",
    benchmarkFirst: first,
    estimateSeconds: 3600,
  });
}

describe("counterbalanced blocks (MS-N5-10, rule 37)", () => {
  it("orders three combinations A, B, C, then C, B, A on the second run", () => {
    expect(planBlocks(["A", "B", "C"], 2).map((b) => `${b.run}${b.combinationId}`)).toEqual([
      "1A",
      "1B",
      "1C",
      "2C",
      "2B",
      "2A",
    ]);
  });

  it("runs a scripted night of three combinations in that order, one swap per block and none within one, and compares only on cards both ran", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A, B, C]);
    const inp = night(log, runId, fakeRunner(clock, trace), clock);
    const r = await runOvernightBench(inp);
    expect(r).toMatchObject({ state: "done" });
    expect(inp.released()).toBe(1);
    expect(trace.swaps).toEqual(["wa", "wb", "wc", "wc", "wb", "wa"]);
    const blockOrder = trace.cards
      .map((c) => c.split(":")[0])
      .filter((w, i, xs) => i === 0 || xs[i - 1] !== w);
    expect(blockOrder).toEqual(["wa", "wb", "wc", "wb", "wa"]);
    expect(trace.cards).toHaveLength(3 * 4 * 2);

    const events = await log.getEventsByTypes(["measure/benchmarked"]);
    expect(events).toHaveLength(3);
    const byWorker = new Map(
      events.map((e) => [
        (e.payload as { combination: Combination }).combination.worker,
        e.payload as {
          tier: string;
          partial: boolean;
          roles: { role: string; state: string; score?: number; low?: number; high?: number }[];
          resolved?: unknown[];
          indistinguishable?: unknown[];
        },
      ]),
    );
    const a = byWorker.get("wa");
    expect(a?.tier).toBe("overnight");
    expect(a?.partial).toBe(false);
    const worker = a?.roles.find((x) => x.role === "worker");
    expect(worker).toMatchObject({ state: "measured", score: 1 });
    expect(worker?.low).toBeGreaterThan(0.6);
    expect(worker?.high).toBe(1);
    expect(a?.roles.find((x) => x.role === "planner")?.state).toBe("not_measured");
    // Four paired cards: wa beats wc on three, which the exact test cannot resolve.
    expect(a?.indistinguishable).toContainEqual(expect.objectContaining({ role: "worker" }));
  });
});

describe("stopping at the window's end and resuming (MS-N5-12, MD-N3-5)", () => {
  it("stops at the window's end, keeps every completed card, and resumes the next night from that card in the same block order", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A, B]);
    let open = true;
    const runner = fakeRunner(clock, trace);
    const first = await runOvernightBench(
      night(log, runId, runner, clock, {
        window: () => {
          if (trace.cards.length >= 6) open = false;
          return open
            ? { open: true, why: "open" }
            : { open: false, why: "the overnight window ended", reason: "window_end" };
        },
      }),
    );
    expect(first).toMatchObject({ state: "stopped", reason: "window_end" });
    expect(trace.cards).toEqual(["wa:s1:1", "wa:s2:1", "wa:s3:1", "wa:s4:1", "wb:s1:1", "wb:s2:1"]);
    const stops = await log.getEventsByTypes(["measure/benchmark_stopped"]);
    expect(stops.at(-1)?.payload).toMatchObject({
      reason: "window_end",
      partial: true,
      completed: 6,
      total: 16,
      cursor: { block: 1, item: 2 },
    });
    // Every combination's partial result is recorded at the stop (MS-N5-11).
    expect(await log.getEventsByTypes(["measure/benchmarked"])).toHaveLength(2);
    expect((await benchmarkRuns(log)).find((r) => r.runId === runId)).toMatchObject({
      state: "queued",
      partial: true,
    });

    trace.cards.length = 0;
    trace.swaps.length = 0;
    const second = await runOvernightBench(night(log, runId, runner, clock));
    expect(second).toMatchObject({ state: "done" });
    expect(trace.swaps).toEqual(["wb", "wb", "wa"]);
    expect(trace.cards.slice(0, 2)).toEqual(["wb:s3:1", "wb:s4:1"]);
    expect(trace.cards).toHaveLength(10);
  });

  it("does not keep a card the window cut off; it runs again next night", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A]);
    const r = await runOvernightBench(
      night(
        log,
        runId,
        fakeRunner(clock, trace, (n) => n === 3),
        clock,
      ),
    );
    expect(r).toMatchObject({ state: "stopped", reason: "window_end" });
    expect(trace.cards).toEqual(["wa:s1:1", "wa:s2:1"]);
    trace.cards.length = 0;
    await runOvernightBench(night(log, runId, fakeRunner(clock, trace), clock));
    expect(trace.cards[0]).toBe("wa:s3:1");
  });

  it("discards the interrupted run and restarts it, saying why, when the harness build changed in between", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A, B]);
    let count = 0;
    await runOvernightBench(
      night(log, runId, fakeRunner(clock, trace), clock, {
        window: () =>
          ++count > 3
            ? { open: false, why: "ended", reason: "window_end" }
            : { open: true, why: "open" },
      }),
    );
    expect(trace.cards).toHaveLength(3);
    trace.cards.length = 0;
    const says: string[] = [];
    await runOvernightBench(
      night(log, runId, fakeRunner(clock, trace), clock, {
        fingerprint: { ...FP, build: "b2" },
        say: (l) => says.push(l),
      }),
    );
    expect(trace.cards[0]).toBe("wa:s1:1");
    expect(trace.cards).toHaveLength(16);
    expect(says.join("\n")).toMatch(/harness build changed/);
    const restarts = (await log.getEventsByTypes(["measure/benchmark_started"])).filter(
      (e) => (e.payload as { restartRun?: number }).restartRun !== undefined,
    );
    expect(restarts[0]?.payload).toMatchObject({ restartRun: 1, reason: "build_changed" });
  });

  it("never starts while the machine is reserved or a card holds the runner (MD-N3-4)", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A]);
    const r = await runOvernightBench(
      night(log, runId, fakeRunner(clock, trace), clock, {
        window: () => ({ open: false, why: "the machine is reserved", reason: "reserved" }),
      }),
    );
    expect(r).toMatchObject({ state: "queued", reason: "reserved" });
    expect(trace.swaps).toEqual([]);
    expect(await log.getEventsByTypes(["measure/benchmark_stopped"])).toHaveLength(0);
  });

  it("stops for good when a person presses Stop, keeping what was measured, marked partial", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const trace: Trace = { swaps: [], cards: [] };
    const { runId } = await schedule(log, [A]);
    const r = await runOvernightBench(
      night(log, runId, fakeRunner(clock, trace), clock, {
        shouldStop: () => trace.cards.length >= 2,
      }),
    );
    expect(r).toMatchObject({ state: "stopped", reason: "person" });
    expect((await benchmarkRuns(log)).find((x) => x.runId === runId)).toMatchObject({
      state: "stopped",
      partial: true,
    });
    trace.cards.length = 0;
    const again = await runOvernightBench(night(log, runId, fakeRunner(clock, trace), clock));
    expect(again.state).toBe("stopped");
    expect(trace.cards).toEqual([]);
  });
});

describe("the estimate before it is queued (MS-N5-9, DB-N6-11)", () => {
  it("fits one combination in a 5-hour window and two in a 10-hour one, at about 5 hours each", () => {
    expect(
      estimateNight({ combinations: 1, hoursPerCombination: 5, windowHours: 5 }),
    ).toMatchObject({
      hoursNeeded: 5,
      fitsTonight: 1,
      nights: 1,
    });
    expect(
      estimateNight({ combinations: 2, hoursPerCombination: 5, windowHours: 10 }),
    ).toMatchObject({ fitsTonight: 2, nights: 1 });
    const three = estimateNight({ combinations: 3, hoursPerCombination: 5, windowHours: 5 });
    expect(three).toMatchObject({ hoursNeeded: 15, fitsTonight: 1, nights: 3 });
    expect(three.line).toMatch(/1 of 3 combinations fits/);
  });

  it("counts the night's backlog first unless the person put the benchmark first", () => {
    expect(
      estimateNight({ combinations: 2, hoursPerCombination: 5, windowHours: 10, backlogHours: 5 }),
    ).toMatchObject({ fitsTonight: 1 });
    expect(
      estimateNight({
        combinations: 2,
        hoursPerCombination: 5,
        windowHours: 10,
        backlogHours: 5,
        benchmarkFirst: true,
      }),
    ).toMatchObject({ fitsTonight: 2 });
  });

  it("defaults to the top combinations the quick tier could not separate, at most three", () => {
    const picks = defaultOvernightPicks([
      { combinationId: "c1", value: 0.9, indistinguishableFrom: ["c2", "c3", "c4"] },
      { combinationId: "c2", value: 0.85, indistinguishableFrom: ["c1"] },
      { combinationId: "c3", value: 0.8, indistinguishableFrom: ["c1"] },
      { combinationId: "c4", value: 0.7, indistinguishableFrom: ["c1"] },
      { combinationId: "c5", value: 0.2, indistinguishableFrom: [] },
    ]);
    expect(picks).toEqual(["c1", "c2", "c3"]);
    expect(
      defaultOvernightPicks([{ combinationId: "c1", value: 0.9, indistinguishableFrom: [] }]),
    ).toEqual([]);
  });
});

describe("the morning report and the bake-off (MS-N5-11, MD-N10-1)", () => {
  it("ranks with intervals, names what was resolved and what is still indistinguishable, with the smallest detectable difference, and assigns nothing", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const { runId } = await schedule(log, [A, B, C]);
    await runOvernightBench(night(log, runId, fakeRunner(clock, { swaps: [], cards: [] }), clock));
    const text = await morningReport(log);
    expect(text).toMatch(/Overnight benchmark/);
    expect(text).toMatch(/1\. .*wa.*8\/8.*95%/);
    expect(text).toMatch(/still indistinguishable/i);
    expect(text).toMatch(/80% power/);
    expect(text).toMatch(/assigned nothing/i);
    expect(await log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });

  it("is the bake-off evidence for a baseline change; a quick score never is (MD-N10-1)", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const { runId } = await schedule(log, [A]);
    await runOvernightBench(night(log, runId, fakeRunner(clock, { swaps: [], cards: [] }), clock));
    const [event] = await log.getEventsByTypes(["measure/benchmarked"]);
    if (!event) throw new Error("no event");
    const evidence = bakeOffEvidence(event, "worker");
    expect(evidence).toMatchObject({
      tier: "overnight",
      role: "worker",
      model: "wa",
      host: "host-a",
      evaluationSet: "frozen-suite",
    });
    expect(bakeOffEvidence(event, "planner")).toBeUndefined();
    const quick = { ...event, payload: { ...(event.payload as object), tier: "quick" } };
    expect(bakeOffEvidence(quick, "worker")).toBeUndefined();
    expect(() =>
      assignRole(
        { roleAssignments: () => [] } as never,
        {
          role: "worker",
          model: "wa",
          scope: "baseline",
          by: "person",
          host: "host-a",
          qualification: "qualified",
          bakeOff: { ...(evidence as NonNullable<typeof evidence>), tier: "quick" },
        } as never,
      ),
    ).toThrow(/quick-benchmark score does not satisfy it/);
  });
});

describe("the overnight verdict a standup states (planner-pm PM-P6-14)", () => {
  /** Twelve Worker cards: enough paired cards for the exact test to resolve a sweep. */
  const TWELVE: OvernightSets = {
    roles: {
      ...SETS.roles,
      worker: {
        state: "ready",
        runs: 2,
        cards: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, role: "worker" as const })),
      },
    },
  };

  it("names the best combination when the night resolved it better than every other", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const { runId } = await schedule(log, [A, C]);
    const runner: OvernightRunner = {
      async swapTo() {
        clock.t += 60_000;
      },
      async runCard({ combination }) {
        clock.t += 600_000;
        return { passed: combination.worker === "wa", seconds: 600 };
      },
    };
    await runOvernightBench(night(log, runId, runner, clock, { sets: TWELVE }));
    const v = await overnightVerdict(log);
    expect(v).toMatchObject({ runId, outcome: "best", reason: "done" });
    expect(v?.leading).toEqual([{ worker: "wa", planner: "p" }]);
    expect(await log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });

  it("says there is no clear difference when the leaders could not be told apart", async () => {
    const log = ledger();
    const clock = { t: 0 };
    const { runId } = await schedule(log, [A, B, C]);
    await runOvernightBench(night(log, runId, fakeRunner(clock, { swaps: [], cards: [] }), clock));
    const v = await overnightVerdict(log);
    expect(v?.outcome).toBe("no_clear_difference");
    expect(v?.leading[0]).toEqual({ worker: "wa", planner: "p" });
    expect(v?.leading.length).toBeGreaterThan(1);
  });

  it("is undefined when no night finished since the given time, and one combination has nothing to compare", async () => {
    const log = ledger();
    const clock = { t: 0 };
    expect(await overnightVerdict(log)).toBeUndefined();
    const { runId } = await schedule(log, [A]);
    await runOvernightBench(night(log, runId, fakeRunner(clock, { swaps: [], cards: [] }), clock));
    expect((await overnightVerdict(log))?.outcome).toBe("only_one");
    expect(await overnightVerdict(log, { since: Date.now() + 60_000 })).toBeUndefined();
  });
});
