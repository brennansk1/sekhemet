import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ItemRun,
  type ScreenRunner,
  type ScreeningSets,
  resolveRunProfile,
} from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry, withMeasurementRun } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import type { BenchmarkEnv } from "../src/benchmark_cmd.js";
import { soloAudience } from "../src/pm/audience.js";
import { settingsTunedLine, standupFacts } from "../src/pm/standup.js";
import { acquireRunnerLease } from "../src/runner_lease.js";
import {
  TuneRefusal,
  TuneService,
  candidatesFor,
  halvingRungs,
  hardSubset,
  settingsVerdict,
  tuneSettingsCommand,
} from "../src/tune_settings.js";

// Find best settings (measurement rule 38, NEW-measurement-7; W18 G3): the
// candidates, successive halving on a hard subset, PROMPT_STANDARD 35.4's
// verdict, DEC-42's preflight, the runner lease, Stop, the record, Apply,
// the standup's words and the terminal. Real SQLite, a real runner lease
// and registry file, a fake clock and a scripted screening runner. No model.

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "tune-settings-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { dir, log, cards: new CardStore(db, log) };
}

const ITEMS = (p: string, n: number, seconds?: number[]) =>
  Array.from({ length: n }, (_, i) => ({
    id: `${p}${i}`,
    ...(seconds ? { referenceSeconds: seconds[i] } : {}),
  }));

function sets(): ScreeningSets {
  const not = (role: "planner" | "researcher") => ({
    role,
    version: "1",
    state: "not_built" as const,
    reason: `the ${role}'s golden set waits on a person's labels`,
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
        items: ITEMS("w", 6, [20, 90, 40, 110, 60, 30]),
        hash: "a".repeat(64),
      },
      planner: not("planner"),
      reviewer: {
        role: "reviewer",
        version: "1",
        state: "ready",
        capSeconds: 30,
        expectedSize: 10,
        items: ITEMS("d", 10),
        hash: "c".repeat(64),
      },
      researcher: not("researcher"),
    },
    endToEnd: { version: "1", capSeconds: 180, items: [] },
  };
}

const INCUMBENT = {
  temperature: 0.7,
  reasoningPolicy: "surgical" as const,
  method: "baseline" as const,
  evidenceGate: "off" as const,
};

type Score = (
  settings: Record<string, unknown>,
  item: string,
) => { score: number; seconds: number };

/** A screening runner whose score is a function of the settings and the item. */
function scripted(score: Score) {
  const calls: { item: string; settings: Record<string, unknown> }[] = [];
  let loads = 0;
  let released = 0;
  const runner: ScreenRunner = {
    load: async () => {
      loads++;
      return { seconds: 1 };
    },
    async runItem({ item, settings }): Promise<ItemRun> {
      const s = (settings ?? {}) as Record<string, unknown>;
      calls.push({ item: item.id, settings: s });
      const r = score(s, item.id);
      return { outcome: { kind: "tests", passed: r.score * 10, total: 10 }, seconds: r.seconds };
    },
    endToEnd: async () => ({ passed: true, seconds: 1 }),
    release: async () => {
      released++;
    },
  };
  return { runner, calls, loads: () => loads, released: () => released };
}

function env(
  r: ReturnType<typeof repo>,
  runner: ScreenRunner,
  over: Partial<BenchmarkEnv> = {},
): BenchmarkEnv & { unloaded: () => number } {
  let unloaded = 0;
  return {
    repoPath: r.dir,
    log: r.log,
    host: "host-a",
    sets,
    overnightSets: () => ({
      roles: {
        worker: { state: "ready", runs: 2, cards: [] },
        planner: { state: "not_built", runs: 1, cards: [] },
        reviewer: { state: "not_built", runs: 1, cards: [] },
        researcher: { state: "not_built", runs: 1, cards: [] },
      },
    }),
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
            unloaded++;
          },
        },
        run,
      ),
    screenRunner: () => runner,
    fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
    now: () => new Date("2026-10-04T23:00:00"),
    hostReading: () => ({ swapUsedBytes: 0, freeRatio: 0.8 }),
    incumbent: () => ({ ...INCUMBENT }),
    unloaded: () => unloaded,
    ...over,
  };
}

const T = (s: Record<string, unknown>) => (s.temperature as number | undefined) ?? 0.7;

describe("the candidates and the hard subset (rule 38)", () => {
  it("varies one run-level value at a time from the incumbent, and drops a candidate equal to it", () => {
    const worker = candidatesFor("worker", INCUMBENT);
    expect(worker[0]).toMatchObject({ id: "current", incumbent: true, override: {} });
    expect(worker.slice(1).map((c) => c.override)).toEqual([
      { temperature: 0.2 },
      { temperature: 0.6 },
      { temperature: 1 },
      { reasoningPolicy: "off" },
      { method: "strict" },
      { evidenceGate: "on" },
    ]);
    const at06 = candidatesFor("worker", { ...INCUMBENT, temperature: 0.6, method: "strict" });
    expect(at06.map((c) => c.override)).not.toContainEqual({ temperature: 0.6 });
    expect(at06.map((c) => c.override)).not.toContainEqual({ method: "strict" });
    const reviewer = candidatesFor("reviewer", {
      reasoningLevel: "medium",
      reasoningCapTokens: 4096,
    });
    expect(reviewer.slice(1).map((c) => c.override)).toEqual([
      { reasoningLevel: "low", reasoningCapTokens: 2048 },
      { reasoningLevel: "medium", reasoningCapTokens: 8192 },
      { reasoningLevel: "high", reasoningCapTokens: 8192 },
    ]);
  });

  it("takes the items this model scored lowest first, else the longest reference time first", () => {
    const set = sets().roles.worker;
    expect(hardSubset("worker", set).map((i) => i.id)).toEqual(["w3", "w1", "w4", "w2"]);
    const recorded = [
      { id: "w0", score: 0.2 },
      { id: "w1", score: 1 },
      { id: "w5", score: 0.5 },
    ];
    expect(hardSubset("worker", set, recorded).map((i) => i.id)).toEqual(["w0", "w5", "w3", "w4"]);
    expect(hardSubset("reviewer", sets().roles.reviewer)).toHaveLength(5);
  });

  it("halves the candidates as the items double (MS-N7-3: 7, then 4, then 2)", () => {
    expect(halvingRungs(7, 4)).toEqual([
      { items: 1, candidates: 7 },
      { items: 2, candidates: 4 },
      { items: 4, candidates: 2 },
    ]);
    expect(halvingRungs(5, 5)).toEqual([
      { items: 1, candidates: 5 },
      { items: 2, candidates: 3 },
      { items: 4, candidates: 2 },
    ]);
    expect(halvingRungs(1, 4)).toEqual([]);
  });
});

describe("the verdict (MS-N7-4, PROMPT_STANDARD 35.4)", () => {
  const items = (scores: number[]) => scores.map((score, i) => ({ id: `w${i}`, score }));
  it("is best only when the survivor is higher on every one of 6 cards", () => {
    const v = settingsVerdict(
      { items: items([1, 1, 1, 1, 1, 1]), seconds: [9, 9, 9, 9, 9, 9] },
      { items: items([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), seconds: [9, 9, 9, 9, 9, 9] },
    );
    expect(v).toMatchObject({ verdict: "best", comparison: { better: 6, worse: 0, ties: 0 } });
    expect(v.comparison.p).toBeCloseTo(0.031, 3);
  });

  it("is no clear difference on 5 of 6 with a tie, and cheaper when it is also faster on all six", () => {
    const five = items([1, 1, 1, 1, 1, 0.5]);
    const base = items([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    expect(
      settingsVerdict(
        { items: five, seconds: [9, 9, 9, 9, 9, 9] },
        { items: base, seconds: [9, 9, 9, 9, 9, 9] },
      ).verdict,
    ).toBe("no_clear_difference");
    const faster = settingsVerdict(
      { items: five, seconds: [5, 5, 5, 5, 5, 5] },
      { items: base, seconds: [9, 9, 9, 9, 9, 9] },
    );
    expect(faster.verdict).toBe("cheaper");
    expect(faster.wilcoxonP).toBeCloseTo(1 / 64, 5);
  });

  it("is worse when the screen resolves the survivor lower, so the incumbent stays", () => {
    expect(
      settingsVerdict(
        { items: items([0, 0, 0, 0, 0, 0]), seconds: [1, 1, 1, 1, 1, 1] },
        { items: items([1, 1, 1, 1, 1, 1]), seconds: [9, 9, 9, 9, 9, 9] },
      ).verdict,
    ).toBe("worse");
  });
});

describe("a Find best settings run (MS-N7-1..7)", () => {
  it("screens 7 candidates by halving with one seed per item, then compares the survivor on the whole set, records it, and loads once", async () => {
    const r = repo();
    // Temperature 0.2 passes everything; the incumbent passes half.
    const s = scripted((st) => ({ score: T(st) === 0.2 ? 1 : 0.5, seconds: 30 }));
    const e = env(r, s.runner);
    const svc = new TuneService(e);
    const started = await svc.start("worker", "wa", "p_owner");
    const result = await started.finished;
    // Rung 1: 7 candidates on 1 item; rung 2: 4 on 2 items (1 new each); rung 3: 2 on 4 (2 new each).
    expect(result.rungs).toEqual([
      { items: 1, candidates: expect.arrayContaining(["current"]) },
      { items: 2, candidates: expect.any(Array) },
      { items: 4, candidates: expect.any(Array) },
    ]);
    expect(result.rungs.map((g) => g.candidates.length)).toEqual([7, 4, 2]);
    expect(result.survivor).toBe("temperature-0.2");
    expect(result.verdict).toBe("best");
    expect(result.adopted).toEqual({ temperature: 0.2 });
    // Every item ran with one seed whatever the candidate.
    const seeds = new Map<string, Set<unknown>>();
    for (const c of s.calls)
      seeds.set(c.item, new Set([...(seeds.get(c.item) ?? []), c.settings.seed]));
    for (const set of seeds.values()) expect(set.size).toBe(1);
    // No item ran twice for one candidate: scores are reused.
    const pairs = s.calls.map((c) => `${c.item}\0${JSON.stringify({ ...c.settings, seed: 0 })}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(s.loads()).toBe(1);
    expect(e.unloaded()).toBe(1);
    expect(s.released()).toBe(1);
    const [event] = await r.log.getEventsByTypes(["measure/settings_tuned"]);
    expect(event?.payload).toMatchObject({
      kind: "find_best",
      role: "worker",
      model: "wa",
      host: "host-a",
      verdict: "best",
      survivor: "temperature-0.2",
      incumbent: "current",
      adopted: { temperature: 0.2 },
      partial: false,
      comparison: { better: 6, worse: 0 },
    });
    expect(event?.principal).toBe("p_owner");
    expect((await svc.runs())[0]).toMatchObject({ state: "done", verdict: "best" });
  });

  it("refuses a role whose screen is not built, before anything loads (MS-N7-1)", async () => {
    const r = repo();
    const s = scripted(() => ({ score: 1, seconds: 1 }));
    const svc = new TuneService(env(r, s.runner));
    await expect(svc.start("planner", "pp", "p_owner")).rejects.toThrow(/golden set waits/);
    expect(s.loads()).toBe(0);
  });

  it("refuses over DEC-42's host limits naming the reading, and while another runner holds the lease (MS-N7-2)", async () => {
    const r = repo();
    const s = scripted(() => ({ score: 1, seconds: 1 }));
    const swap = new TuneService(
      env(r, s.runner, { hostReading: () => ({ swapUsedBytes: 5 * 1024 ** 3, freeRatio: 0.9 }) }),
    );
    await expect(swap.start("worker", "wa", "p_owner")).rejects.toThrow(/swap is 5\.0 GB/);
    const free = new TuneService(
      env(r, s.runner, { hostReading: () => ({ swapUsedBytes: 0, freeRatio: 0.4 }) }),
    );
    await expect(free.start("worker", "wa", "p_owner")).rejects.toBeInstanceOf(TuneRefusal);
    const held = acquireRunnerLease(r.dir, { kind: "queue" });
    try {
      await expect(
        new TuneService(env(r, s.runner)).start("worker", "wa", "p_owner"),
      ).rejects.toThrow(/Another runner holds the lease.*queue/);
    } finally {
      if ("release" in held) held.release();
    }
    expect(s.loads()).toBe(0);
  });

  it("stops at the current item's end, keeps what was scored, and records it partial with no verdict (MS-N7-5)", async () => {
    const r = repo();
    let runId = "";
    const s = scripted(() => ({ score: 0.5, seconds: 10 }));
    const svc = new TuneService(env(r, s.runner));
    const inner = s.runner.runItem;
    s.runner.runItem = async (input) => {
      const out = await inner(input);
      if (s.calls.length === 3) {
        runId = (await svc.runs()).find((x) => x.state === "running")?.runId ?? "";
        await svc.stop(runId);
      }
      return out;
    };
    const started = await svc.start("worker", "wa", "p_owner");
    const result = await started.finished;
    expect(result).toMatchObject({ verdict: "partial", partial: true });
    expect(s.calls).toHaveLength(3);
    const [event] = await r.log.getEventsByTypes(["measure/settings_tuned"]);
    expect(event?.payload).toMatchObject({ verdict: "partial", partial: true });
    expect(
      (event?.payload as { candidates: { items: unknown[] }[] }).candidates.flatMap((c) => c.items),
    ).toHaveLength(3);
    await expect(svc.apply(runId, "p_owner")).rejects.toThrow(/stopped before a verdict/);
  });

  it("applies a best run's values as the person's, only on their press, and refuses no clear difference (MS-N7-7)", async () => {
    const r = repo();
    const path = join(r.dir, "models.json");
    const registry = new ModelRegistry(path);
    registry.upsert("wa", { family: "qwen" });
    const applied: unknown[] = [];
    const store: BenchmarkEnv["applySettings"] = (model, role, values, principal) => {
      applied.push({ model, role, values, principal });
      registry.setRoleSettings(model, role, values, principal);
      return { needsVerifying: true };
    };
    const best = scripted((st) => ({ score: T(st) === 0.2 ? 1 : 0.5, seconds: 30 }));
    const svc = new TuneService(env(r, best.runner, { applySettings: store }));
    const run = await svc.start("worker", "wa", "p_owner");
    await run.finished;
    // Nothing is applied by the run itself.
    expect(applied).toEqual([]);
    expect(new ModelRegistry(path).roleSettings("wa", "worker")).toBeUndefined();
    const out = await svc.apply(run.run.runId, "p_owner");
    expect(out).toMatchObject({ applied: { temperature: 0.2 }, needsVerifying: true });
    expect(new ModelRegistry(path).roleSettings("wa", "worker")?.values).toEqual({
      temperature: 0.2,
    });
    const [changed] = await r.log.getEventsByTypes(["models/settings_changed"]);
    expect(changed?.payload).toMatchObject({
      model: "wa",
      role: "worker",
      action: "set",
      keys: ["temperature"],
      needsVerifying: true,
      principal: "p_owner",
    });
    expect((await svc.runs()).find((x) => x.runId === run.run.runId)?.applied).toBe(true);

    const flat = scripted(() => ({ score: 0.5, seconds: 30 }));
    const r2 = repo();
    const svc2 = new TuneService(env(r2, flat.runner, { applySettings: store }));
    const none = await svc2.start("worker", "wa", "p_owner");
    expect((await none.finished).verdict).toBe("no_clear_difference");
    await expect(svc2.apply(none.run.runId, "p_owner")).rejects.toThrow(/nothing to apply/);
  });

  it("unloads the model even when the runner fails, and records the run partial", async () => {
    const r = repo();
    const s = scripted(() => {
      throw new Error("the model server went away");
    });
    const e = env(r, s.runner);
    const started = await new TuneService(e).start("worker", "wa", "p_owner");
    await expect(started.finished).rejects.toThrow(/went away/);
    expect(e.unloaded()).toBe(1);
    const [event] = await r.log.getEventsByTypes(["measure/settings_tuned"]);
    expect(event?.payload).toMatchObject({ verdict: "partial", partial: true });
  });
});

describe("the standup's words after a run (MS-N7-6, PM-P6-14)", () => {
  it("says best combination, or no clear difference, in plain words", async () => {
    expect(
      settingsTunedLine({
        role: "worker",
        model: "wa",
        verdict: "best",
        adopted: { temperature: 0.2 },
        comparison: { better: 6, worse: 0, ties: 0, p: 0.031 },
      }),
    ).toMatch(
      /Find best settings for the Coding model: the best combination is temperature 0\.2.*Apply/,
    );
    expect(
      settingsTunedLine({ role: "reviewer", model: "rv", verdict: "no_clear_difference" }),
    ).toMatch(/Review model: no clear difference.*current settings stay/);
    const r = repo();
    const s = scripted((st) => ({ score: T(st) === 0.2 ? 1 : 0.5, seconds: 30 }));
    await (await new TuneService(env(r, s.runner)).start("worker", "wa", "p_owner")).finished;
    const facts = await standupFacts({
      repoPath: r.dir,
      cardStore: r.cards,
      log: r.log,
      cards: [],
      cycles: [],
      audience: soloAudience(),
      person: "p_owner",
      whole: true,
      now: new Date(),
    });
    expect(facts.settings?.join("\n")).toMatch(/best combination is temperature 0\.2/);
  });
});

describe("`sekhemet tune settings` (rule 38)", () => {
  it("shows the candidates and the estimate and runs nothing without --yes, then runs and applies on --apply", async () => {
    const r = repo();
    const s = scripted((st) => ({ score: T(st) === 0.2 ? 1 : 0.5, seconds: 30 }));
    const applied: unknown[] = [];
    const e = env(r, s.runner, {
      applySettings: (model, role, values) => {
        applied.push({ model, role, values });
        return { needsVerifying: false };
      },
    });
    const out: string[] = [];
    expect(
      await tuneSettingsCommand(
        ["settings", "--role", "worker", "--model", "wa"],
        e,
        (l) => out.push(l),
        "p_owner",
      ),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/7 settings to try/);
    expect(out.join("\n")).toMatch(/temperature 0\.2/);
    expect(out.join("\n")).toMatch(/about \d+ min/);
    expect(out.join("\n")).toMatch(/--yes/);
    expect(s.calls).toHaveLength(0);
    out.length = 0;
    expect(
      await tuneSettingsCommand(
        ["settings", "--role", "worker", "--model", "wa", "--yes"],
        e,
        (l) => out.push(l),
        "p_owner",
      ),
    ).toBe(0);
    expect(out.join("\n")).toMatch(/best combination is temperature 0\.2/);
    const runId = /run (tune_[0-9a-f]+)/.exec(out.join("\n"))?.[1] ?? "";
    expect(runId).not.toBe("");
    expect(
      await tuneSettingsCommand(["settings", "--apply", runId], e, (l) => out.push(l), "p_owner"),
    ).toBe(0);
    expect(applied).toEqual([{ model: "wa", role: "worker", values: { temperature: 0.2 } }]);
    expect(
      await tuneSettingsCommand(
        ["settings", "--role", "researcher"],
        e,
        (l) => out.push(l),
        "p_owner",
      ),
    ).toBe(1);
  });
});
