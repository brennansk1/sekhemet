import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Combination,
  type OvernightRunner,
  type OvernightSets,
  type ScreenRunner,
  type ScreeningSets,
  resolveRunProfile,
} from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BenchmarkEnv,
  BenchmarkService,
  benchmarkCommand,
  overnightWindow,
} from "../src/benchmark_cmd.js";
import { runOvernight } from "../src/overnight.js";
import { reserveMachine } from "../src/reservation.js";
import { acquireRunnerLease } from "../src/runner_lease.js";

// B4.1 part (c), the harness side of NEW-measurement-5: the overnight window
// (models rule 20b, MD-N3-4/5, no idle exception), the benchmark service the
// CLI and the API share, and the hook in `overnight` before the queue.
// Real SQLite, a real runner lease, a fake clock, fake runners. No model.

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "bench-cmd-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { dir, log, cards: new CardStore(db, log) };
}

const at = (local: string) => new Date(local);

describe("the overnight window (models rule 20b, MD-N3-4)", () => {
  const reserved = "08:00-18:00 Mon-Fri";

  it("is the complement of the reserved hours, with no idle exception", () => {
    const night = overnightWindow({ now: at("2026-09-21T23:00:00"), reservedHours: reserved });
    expect(night.open).toBe(true);
    expect(new Date(night.endsAt ?? 0).getHours()).toBe(8);
    const day = overnightWindow({ now: at("2026-09-21T10:00:00"), reservedHours: reserved });
    expect(day).toMatchObject({ open: false, reason: "window_end" });
    expect(day.why).toMatch(/reserved hours/);
    expect(new Date(day.nextStart ?? 0).getHours()).toBe(18);
  });

  it("is narrowed by [machine] overnight_hours when set", () => {
    const o = { reservedHours: reserved, overnightHours: "01:00-06:00" };
    expect(overnightWindow({ ...o, now: at("2026-09-21T23:00:00") })).toMatchObject({
      open: false,
    });
    const inside = overnightWindow({ ...o, now: at("2026-09-22T02:00:00") });
    expect(inside.open).toBe(true);
    expect(new Date(inside.endsAt ?? 0).getHours()).toBe(6);
  });

  it("is closed while a person has reserved the machine or a card holds the runner", () => {
    const now = at("2026-09-21T23:00:00");
    expect(overnightWindow({ now, reservedHours: reserved, reservedNow: true })).toMatchObject({
      open: false,
      reason: "reserved",
    });
    expect(overnightWindow({ now, reservedHours: reserved, cardRunning: true })).toMatchObject({
      open: false,
      reason: "reserved",
    });
  });

  it("labels tonight's window and its hours (DB-N6-11)", () => {
    const w = overnightWindow({ now: at("2026-09-21T12:00:00"), reservedHours: "03:00-22:00" });
    expect(w.label).toBe("22:00–03:00");
    expect(w.hours).toBe(5);
  });
});

const COMBO: Combination = { worker: "wa", planner: "p" };

function sets(): ScreeningSets {
  const items = (p: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}` }));
  const not = (role: "planner" | "reviewer" | "researcher") => ({
    role,
    version: "1",
    state: "not_built" as const,
    reason: `${role} not built`,
    capSeconds: 60,
    expectedSize: 3,
    items: [],
  });
  return {
    roles: {
      worker: {
        role: "worker",
        version: "1",
        state: "ready",
        capSeconds: 120,
        expectedSize: 6,
        items: items("w", 6),
        hash: "a".repeat(64),
      },
      planner: not("planner"),
      reviewer: not("reviewer"),
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: items("e", 2) },
  };
}

const OSETS: OvernightSets = {
  roles: {
    worker: { state: "ready", runs: 2, cards: [{ id: "s1", role: "worker" }] },
    planner: { state: "not_built", runs: 1, cards: [] },
    reviewer: { state: "not_built", runs: 1, cards: [] },
    researcher: { state: "not_built", runs: 1, cards: [] },
  },
};

function screenRunner(gate?: { wait: Promise<void> }): ScreenRunner & { items: string[] } {
  const items: string[] = [];
  return {
    items,
    load: async () => ({ seconds: 1 }),
    async runItem({ item }) {
      items.push(item.id);
      if (gate && items.length === 2) await gate.wait;
      return { outcome: { kind: "tests", passed: 1, total: 1 }, seconds: 10 };
    },
    endToEnd: async () => ({ passed: true, seconds: 20 }),
  };
}

function env(
  r: ReturnType<typeof repo>,
  over: Partial<BenchmarkEnv> = {},
): BenchmarkEnv & { released: () => number } {
  let released = 0;
  let clock = at("2026-09-21T23:00:00").getTime();
  const orunner: OvernightRunner = {
    swapTo: async () => undefined,
    async runCard() {
      clock += 60_000;
      return { passed: true, seconds: 60 };
    },
  };
  return {
    repoPath: r.dir,
    log: r.log,
    host: "host-a",
    sets,
    overnightSets: () => OSETS,
    machine: () => ({ reservedHours: "08:00-18:00 Mon-Fri" }),
    fit: () => ({ fits: true }),
    cacheKey: (_role, model, setHash) => ({
      model,
      quantisation: "Q4",
      engine: "llama.cpp",
      settings: "s",
      host: "host-a",
      contextVersion: "c",
      setHash,
    }),
    throughput: async () => ({
      secondsPerItem: () => ({ seconds: 60, source: "recorded" }),
      loadSeconds: () => ({ seconds: 120, source: "recorded" }),
    }),
    runProfile: () => resolveRunProfile({ env: {}, argv: [] }),
    measurementRun: (run) =>
      withMeasurementRun(
        {
          releaseAll: async () => {
            released++;
          },
        },
        run,
      ),
    screenRunner: () => screenRunner(),
    overnightRunner: () => orunner,
    fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
    now: () => new Date(clock),
    released: () => released,
    ...over,
  };
}

describe("the benchmark service (MS-N5-1, -6, -8, -9; PM_CONTRACT §3 Configuration)", () => {
  it("estimates before running anything, then runs a quick screen under the runner lease and records its start and stop", async () => {
    const r = repo();
    let runs = 0;
    const e = env(r, {
      screenRunner: () => {
        runs++;
        return screenRunner();
      },
    });
    const svc = new BenchmarkService(e);
    const est = await svc.estimateQuick(COMBO);
    // 6 × 60 s + 120 s load = 8 minutes; the end-to-end check 2 × 3 = 6.
    expect(est.roles.find((x) => x.role === "worker")).toMatchObject({ minutes: 8 });
    expect(est.estimateSeconds).toBe(14 * 60);
    expect(runs).toBe(0);

    const started = await svc.startQuick(COMBO, "p_owner");
    expect(started.run).toMatchObject({ tier: "quick", state: "running" });
    expect(started.estimateSeconds).toBe(14 * 60);
    const result = await started.finished;
    expect(result.partial).toBe(false);
    expect(e.released()).toBe(1);
    const types = (
      await r.log.getEventsByTypes([
        "measure/benchmark_started",
        "measure/benchmarked",
        "measure/benchmark_stopped",
      ])
    ).map((x) => x.type);
    expect(types).toEqual([
      "measure/benchmark_started",
      "measure/benchmarked",
      "measure/benchmark_stopped",
    ]);
    const start = (await r.log.getEventsByTypes(["measure/benchmark_started"]))[0];
    expect(start?.principal).toBe("p_owner");
    expect((await svc.runs()).find((x) => x.runId === started.run.runId)?.state).toBe("done");
    // The lease is released: another runner may start.
    const lease = acquireRunnerLease(r.dir, { kind: "queue" });
    expect("release" in lease).toBe(true);
    if ("release" in lease) lease.release();
  });

  it("refuses a quick run while another runner holds the lease, naming it", async () => {
    const r = repo();
    const held = acquireRunnerLease(r.dir, { kind: "queue" });
    try {
      await expect(new BenchmarkService(env(r)).startQuick(COMBO, "p_owner")).rejects.toThrow(
        /Another runner holds the lease.*queue/,
      );
    } finally {
      if ("release" in held) held.release();
    }
  });

  it("refuses a model that does not fit with the GB it needs, and says when no screening runner is wired", async () => {
    const r = repo();
    const svc = new BenchmarkService(env(r, { fit: () => ({ fits: false, needsGb: 21 }) }));
    await expect(svc.startQuick(COMBO, "p_owner")).rejects.toMatchObject({ needsGb: 21 });
    const unwired = new BenchmarkService(env(r, { screenRunner: undefined }));
    await expect(unwired.startQuick(COMBO, "p_owner")).rejects.toThrow(/not wired/);
    expect(await r.log.getEventsByTypes(["measure/benchmark_started"])).toHaveLength(0);
  });

  it("stops a quick run at the current item's end, keeping what was measured, marked partial (MS-N5-6, DB-N6-10)", async () => {
    const r = repo();
    let open!: () => void;
    const gate = {
      wait: new Promise<void>((res) => {
        open = res;
      }),
    };
    const svc = new BenchmarkService(env(r, { screenRunner: () => screenRunner(gate) }));
    const started = await svc.startQuick(COMBO, "p_owner");
    await new Promise((res) => setTimeout(res, 10));
    const stopped = await svc.stop(started.run.runId, "p_owner");
    expect(stopped.run.state).toBe("running");
    open();
    const result = await started.finished;
    expect(result.partial).toBe(true);
    const run = (await svc.runs()).find((x) => x.runId === started.run.runId);
    expect(run).toMatchObject({ state: "stopped", partial: true });
    const stop = (await r.log.getEventsByTypes(["measure/benchmark_stopped"]))[0];
    expect(stop?.payload).toMatchObject({ reason: "person", partial: true });
  });

  it("queues an overnight comparison with tonight's fit, runs it only inside the window, and never while reserved (MS-N5-9, MS-N5-12)", async () => {
    const r = repo();
    let now = at("2026-09-21T12:00:00");
    const svc = new BenchmarkService(env(r, { now: () => now }));
    const q = await svc.scheduleOvernight([COMBO, { worker: "wb", planner: "p" }], "p_owner", {});
    expect(q.run).toMatchObject({ tier: "overnight", state: "queued" });
    expect(q.run.schedule?.window).toEqual({ start: "18:00", end: "08:00" });
    expect(q.estimate.line).toMatch(/Tonight 18:00–08:00 \(14 h\): 2 of 2 combinations fit/);

    // Daytime: queued, nothing runs, even if the person is idle.
    expect(await svc.runNight("after")).toEqual([
      expect.stringMatching(/queued: the reserved hours/),
    ]);
    // Night, but reserved now: still queued (MD-N3-4).
    now = at("2026-09-21T23:00:00");
    await reserveMachine(r.log, { principal: "p_owner" }, now);
    await svc.runNight("after");
    expect(await r.log.getEventsByTypes(["measure/benchmark_item"])).toHaveLength(0);
  });

  it("runs a queued overnight comparison in the window and puts the benchmark first only when the person asked", async () => {
    const r = repo();
    const svc = new BenchmarkService(env(r));
    await svc.scheduleOvernight([COMBO], "p_owner", {});
    expect(await svc.runNight("first")).toEqual([]);
    const lines = await svc.runNight("after");
    expect(lines.join("\n")).toMatch(/finished/);
    expect(await r.log.getEventsByTypes(["measure/benchmark_item"])).toHaveLength(2);
    const first = new BenchmarkService(env(repo()));
    await first.scheduleOvernight([COMBO], "p_owner", { benchmarkFirst: true });
    expect((await first.runNight("first")).join("\n")).toMatch(/finished/);
  });

  it("stops a queued overnight run for good when a person presses Stop", async () => {
    const r = repo();
    const svc = new BenchmarkService(env(r));
    const q = await svc.scheduleOvernight([COMBO], "p_owner", {});
    const s = await svc.stop(q.run.runId, "p_owner");
    expect(s.run.state).toBe("stopped");
    expect(await svc.runNight("after")).toEqual([]);
  });

  it("answers `sekhemet benchmark quick` with the estimate and runs nothing without --yes (MS-N5-1)", async () => {
    const r = repo();
    const out: string[] = [];
    let runs = 0;
    const code = await benchmarkCommand(
      ["quick", "--worker", "wa", "--planner", "p"],
      env(r, {
        screenRunner: () => {
          runs++;
          return screenRunner();
        },
      }),
      (l) => out.push(l),
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Coding model wa: 8 min/);
    expect(out.join("\n")).toMatch(/--yes/);
    expect(runs).toBe(0);
    const ran = await benchmarkCommand(
      ["quick", "--worker", "wa", "--planner", "p", "--yes"],
      env(r),
      (l) => out.push(l),
    );
    expect(ran).toBe(0);
    expect(out.join("\n")).toMatch(/Coding model wa: 1 \(6 items/);
  });
});

describe("the hook in `overnight` before the queue (MD-N3-4, models rule 20b)", () => {
  it("runs the benchmark put first before the queue, and the rest after the night's backlog", async () => {
    const r = repo();
    const calls: string[] = [];
    await runOvernight({
      repoPath: r.dir,
      log: r.log,
      cardStore: r.cards,
      hours: "none",
      limits: { kwhPerDay: 0, maxConsecutiveFailures: 3 },
      queueArgs: [],
      skipMutation: true,
      vulnScan: async () => ({ passed: true }),
      runM0: async () => "no tasks",
      say: () => undefined,
      benchmark: async (phase) => {
        calls.push(phase);
        return [];
      },
    });
    expect(calls).toEqual(["first", "after"]);
  });
});
