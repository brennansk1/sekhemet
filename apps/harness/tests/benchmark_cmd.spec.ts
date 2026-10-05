import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type Combination,
  type OvernightRunner,
  type OvernightSets,
  type ScreenRunner,
  type ScreeningSets,
  type SettingsCombination,
  cacheKeyString,
  combinationHistory,
  combinationId,
  loadScreeningSets,
  resolveRunProfile,
  settingsText,
} from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, ModelRegistry, withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMALL, writeGguf } from "../../../packages/models/tests/support/gguf_fixture.js";
import {
  type BenchmarkEnv,
  BenchmarkService,
  benchmarkCommand,
  defaultBenchmarkEnv,
  externalResults,
  overnightWindow,
  scannedFit,
} from "../src/benchmark_cmd.js";
import { suiteScreenRunner } from "../src/benchmark_runner.js";
import { applyEdits, changedRanges, loadSeededDefects } from "../src/learning/review_eval.js";
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
  vi.unstubAllEnvs();
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("the CLI's fit is the page's (FINDINGS CFG-15, MS-N5-5)", () => {
  it("judges each scanned model with the page's fit, so the terminal refuses one that does not fit", async () => {
    const r = repo();
    const models = join(r.dir, "models");
    writeGguf(join(models, "huge-Q4_K_M.gguf"), {
      name: "Huge Llama",
      blockCount: 400,
      embeddingLength: 16384,
      headCount: 128,
      headCountKv: 128,
      contextLength: 131072,
      padBytes: 1024,
    });
    writeGguf(join(models, "tiny-Q4_K_M.gguf"), { ...SMALL, name: "Tiny Llama", padBytes: 1024 });
    const user = join(r.dir, "user.toml");
    writeFileSync(user, '[network]\nmode = "offline"\n');
    const fit = await scannedFit({
      repoPath: r.dir,
      log: r.log,
      env: { SEKHEMET_MODELS_DIR: models, SEKHEMET_CONFIG_DIR: join(r.dir, "cfg") },
      userConfigPath: user,
      headroomProbe: null,
    });
    {
      expect(fit.fit("worker", "huge-llama")).toMatchObject({ fits: false });
      expect((fit.fit("worker", "huge-llama").needsGb ?? 0) > 0).toBe(true);
      expect(fit.fit("worker", "tiny-llama").fits).toBe(true);
      const out: string[] = [];
      const code = await benchmarkCommand(
        ["quick", "--worker", "huge-llama", "--planner", "tiny-llama", "--yes"],
        env(r, { fit: fit.fit }),
        (l) => out.push(l),
      );
      expect(out.join("\n")).toMatch(/Coding model huge-llama: needs \d+ GB; not loaded/);
      expect(code).toBe(1);
      expect(out.join("\n")).toMatch(/does not fit this machine/);
    }
  });
});

describe("settings in the combination (NEW-measurement-8, MS-N8-1, -2)", () => {
  it("runs a role's settings for that run only, keys its score with them, gives the combination its own id, and refuses a value that needs its own load", async () => {
    const r = repo();
    const seen: unknown[] = [];
    const runner = screenRunner();
    const inner = runner.runItem;
    runner.runItem = async (input) => {
      seen.push(input.settings);
      return inner(input);
    };
    const svc = new BenchmarkService(
      env(r, {
        screenRunner: () => runner,
        cacheKey: (_role, model, setHash, settings) => ({
          model,
          quantisation: "Q4",
          engine: "llama.cpp",
          settings: settingsText(settings ?? {}) || "s",
          host: "host-a",
          contextVersion: "c",
          setHash,
        }),
      }),
    );
    await (await svc.startQuick(COMBO, "p_owner")).finished;
    const tuned: SettingsCombination = { ...COMBO, settings: { worker: { temperature: 0.2 } } };
    const est = await svc.estimateQuick(tuned);
    expect(est.roles.find((x) => x.role === "worker")?.state).toBe("to_measure");
    const result = await (await svc.startQuick(tuned, "p_owner")).finished;
    expect(seen.at(-1)).toEqual({ temperature: 0.2 });
    expect(seen[0]).toBeUndefined();
    // Without settings the id is the one recorded before settings existed.
    expect(combinationId(COMBO, "host-a")).toBe(
      `cmb_${(await import("node:crypto"))
        .createHash("sha256")
        .update(JSON.stringify(["wa", "p", "", "", "host-a"]))
        .digest("hex")
        .slice(0, 16)}`,
    );
    expect(result.combinationId).not.toBe(combinationId(COMBO, "host-a"));
    const last = (await r.log.getEventsByTypes(["measure/benchmarked"])).at(-1);
    expect((last?.payload as { combination: Record<string, string> }).combination).toEqual({
      worker: "wa",
      planner: "p",
      "worker.settings": "temperature=0.2",
    });
    const rows = (await svc.results()).results;
    expect(rows.map((x) => (x.combination as SettingsCombination).settings ?? null)).toContainEqual(
      {
        worker: { temperature: 0.2 },
      },
    );
    await expect(
      svc.startQuick(
        { ...COMBO, settings: { worker: { contextTokens: 8192 } } } as never,
        "p_owner",
      ),
    ).rejects.toThrow(/Customize/);
  });

  it("keys a role's quick score anew when a person's values for that model and role change (MS-N8-2)", () => {
    const r = repo();
    const path = join(r.dir, "models.json");
    vi.stubEnv("SEKHEMET_MODEL_REGISTRY", path);
    const registry = new ModelRegistry(path);
    registry.upsert("wa", { quant: "Q4_K_M" });
    const e = defaultBenchmarkEnv({ repoPath: r.dir, log: r.log, fit: () => ({ fits: true }) });
    const hash = "a".repeat(64);
    const worker = () => cacheKeyString(e.cacheKey("worker", "wa", hash));
    const reviewer = () => cacheKeyString(e.cacheKey("reviewer", "wa", hash));
    const [w0, r0] = [worker(), reviewer()];
    registry.setRoleSettings("wa", "worker", { temperature: 0.3 }, "p_owner");
    expect(worker()).not.toBe(w0);
    expect(reviewer()).toBe(r0);
    expect(cacheKeyString(e.cacheKey("worker", "wa", hash, { temperature: 0.2 }))).not.toBe(
      worker(),
    );
  });
});

describe("the history and the external benchmarks (MS-N8-3, MS-N8-4)", () => {
  it("lists each combination's runs with their settings, each against the run before on the items both ran", async () => {
    const r = repo();
    const run = (scores: number[], extra: Record<string, string> = {}) =>
      r.log.append({
        actor: "harness",
        type: "measure/benchmarked",
        payload: {
          tier: "quick",
          profileHash: "f".repeat(64),
          host: "host-a",
          combination: { worker: "wa", planner: "p", ...extra },
          partial: false,
          roles: [
            {
              role: "worker",
              model: "wa",
              state: "measured",
              cacheKey: `ck_${scores.join("")}`,
              setHash: "a".repeat(64),
              score: scores.reduce((a, b) => a + b, 0) / scores.length,
              low: Math.min(...scores),
              high: Math.max(...scores),
              items: scores.map((score, i) => ({ id: `w${i}`, score })),
            },
          ],
          comparisons: [],
        },
      });
    await run([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    await run([1, 1, 1, 1, 1, 1]);
    await run([1, 1, 1, 1, 1, 0.5], { "worker.settings": "temperature=0.2" });
    const history = await combinationHistory(r.log);
    expect(history).toHaveLength(2);
    const plain = history.find((h) => !(h.combination as SettingsCombination).settings);
    expect(plain?.runs.map((x) => x.versusPrevious?.outcome ?? null)).toEqual([null, "better"]);
    expect(plain?.runs[1]?.versusPrevious).toMatchObject({ better: 6, worse: 0, ties: 0 });
    const tuned = history.find((h) => (h.combination as SettingsCombination).settings);
    expect(tuned?.runs[0]?.settings).toEqual({ worker: { temperature: 0.2 } });
  });

  it("reads the capstone's and Web-Bench's recorded scores with their protocol and validity, and runs nothing", () => {
    const r = repo();
    const root = join(r.dir, "harness");
    const runs = join(r.dir, "runs");
    const put = (path: string, value: unknown) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
    };
    put(join(root, "docs", "showcase", "capstone", "sekhemet-nail-mtp", "1", "score.json"), {
      arm: "sekhemet-nail-mtp",
      run: 1,
      valid: true,
      invalidBecause: [],
      hiddenSuite: { registered: true },
      releaseOne: { passed: 40, total: 50 },
      afterChange: { passed: 44, total: 55 },
      scoredAt: "2026-10-01T10:00:00Z",
    });
    put(join(runs, "one-shot-nail-mtp", "2", "score.json"), {
      arm: "one-shot-nail-mtp",
      run: 2,
      valid: false,
      invalidBecause: ["the run did not finish"],
      hiddenSuite: { registered: false, notRegistered: "it waits for a person's check (K2)" },
      afterChange: { passed: 10, total: 55 },
    });
    put(join(runs, "webbench-sekhemet-nail-mtp", "1", "score.json"), {
      benchmark: "web-bench",
      project: "react",
      commit: "abc1234",
      arm: "sekhemet-nail-mtp",
      model: "nail-mtp",
      run: 1,
      tasks: 20,
      pass: { "pass@1": 0.25, "pass@2": 0.35 },
      error: { "error@1": 0.1 },
    });
    put(join(runs, "README.txt", "x"), "not a run");
    const x = externalResults({ root, runsRoot: runs });
    expect(x.capstone).toEqual([
      expect.objectContaining({ arm: "one-shot-nail-mtp", run: 2, valid: false, source: "runs" }),
      expect.objectContaining({
        arm: "sekhemet-nail-mtp",
        run: 1,
        valid: true,
        source: "showcase",
      }),
    ]);
    expect(x.capstone[0]?.why).toMatch(/did not finish.*waits for a person's check/);
    expect(x.capstone[1]?.scores).toMatchObject({ "release 1": 0.8, "after the change": 0.8 });
    expect(x.webbench).toEqual([
      expect.objectContaining({
        arm: "sekhemet-nail-mtp",
        model: "nail-mtp",
        scores: { "pass@1": 0.25, "pass@2": 0.35, "error@1": 0.1 },
      }),
    ]);
    expect(x.protocol.capstone).toMatch(/byte-identical.*hidden/);
    expect(x.protocol.webbench).toMatch(/pass@1/);
    expect(
      externalResults({ root: join(r.dir, "none"), runsRoot: join(r.dir, "none") }),
    ).toMatchObject({
      capstone: [],
      webbench: [],
    });
  });
});

describe("the Reviewer's screen and overnight set (FINDINGS CFG-17, MS-N8-5)", () => {
  it("is 10 registered seeded defects, at most two per issue, hashed with the asset", () => {
    const set = loadScreeningSets(ROOT).roles.reviewer;
    expect(set).toMatchObject({ state: "ready", expectedSize: 10 });
    expect(set.items).toHaveLength(10);
    const perCard = new Map<string, number>();
    for (const i of set.items)
      perCard.set(`${i.fixture}/${i.card}`, (perCard.get(`${i.fixture}/${i.card}`) ?? 0) + 1);
    expect(Math.max(...perCard.values())).toBeLessThanOrEqual(2);
    expect(new Set(set.items.map((i) => i.fixture))).toEqual(
      new Set(["onyx", "vanguard", "basalt-canvas"]),
    );
    expect(set.items.every((i) => i.seeded && i.seeded.edits.length > 0)).toBe(true);
    expect(set.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scores an item 1 on RG-P8-13's catch, and a failed review 0 with its reason", async () => {
    const set = loadScreeningSets(ROOT).roles.reviewer;
    const item = set.items[0];
    if (!item?.seeded || !item.fixture || !item.card) throw new Error("no seeded item");
    const ref = readFileSync(
      join(ROOT, "fixtures", "reference_solutions", item.fixture, item.card, item.seeded.file),
      "utf8",
    );
    const [lo] = changedRanges(ref, applyEdits(ref, item.seeded.edits))[0] ?? [1];
    const reply = (text: string): LocalInferenceAdapter => ({
      modelId: "scripted-reviewer",
      supportedArms: ["arm_b_json"],
      contextWindow: { contextTokens: 32_768, maxTokens: 1200 },
      generate: async () => ({
        text,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
    });
    const caught = JSON.stringify({
      criteria: [
        { n: 1, verdict: "unmet", at: `${item.seeded.file}:${lo}`, note: "A case is left out." },
      ],
    });
    const runnerFor = (text: string) =>
      suiteScreenRunner({
        harnessRoot: ROOT,
        workDir: join(repo().dir, "work"),
        adapterFor: () => reply(text),
        runProfile: () => resolveRunProfile({ env: {}, argv: [] }),
      });
    const hit = await runnerFor(caught).runItem({
      role: "reviewer",
      model: "rv",
      item,
      capSeconds: 30,
    });
    expect(hit.outcome).toEqual({ kind: "detection", detectedAtLocation: true, falseFindings: 0 });
    const failed = await runnerFor("I could not finish").runItem({
      role: "reviewer",
      model: "rv",
      item,
      capSeconds: 30,
    });
    expect(failed.outcome).toMatchObject({ kind: "detection", detectedAtLocation: false });
    expect(failed.stopReason).toBe("review_failed");
  });

  it("builds the overnight Reviewer set from every registered defect, reviewed once per run", () => {
    const r = repo();
    const e = defaultBenchmarkEnv({
      repoPath: r.dir,
      log: r.log,
      harnessRoot: ROOT,
      fit: () => ({ fits: true }),
    });
    const reviewer = e.overnightSets().roles.reviewer;
    expect(reviewer.state).toBe("ready");
    expect(reviewer.cards).toHaveLength(loadSeededDefects(ROOT).items.length);
    expect(reviewer.cards.every((c) => c.role === "reviewer")).toBe(true);
  });
});
