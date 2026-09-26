import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Combination,
  type OvernightSets,
  type ScreeningSets,
  loadScreeningSets,
  resolveRunProfile,
  scheduleOvernight,
} from "@sekhemet/eval";
import { EventLog, initSchema } from "@sekhemet/kernel";
import {
  type InferenceResponse,
  MockInferenceAdapter,
  type ModelRole,
  withMeasurementRun,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type BenchmarkEnv, BenchmarkService } from "../src/benchmark_cmd.js";
import { suiteOvernightRunner, suiteScreenRunner, vitestCount } from "../src/benchmark_runner.js";

// B4.1 part (c): the runner that drives a real frozen-suite card for a
// combination — a real fixture repository prepared as the frozen suite
// prepares it (independent mode, earlier cards' reference solutions on
// main), the card run by `executeCard` with the combination's Worker, its
// acceptance tests counted — for the quick screen and the overnight blocks.
// The models are scripted (`MockInferenceAdapter`); no model is loaded.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HASHER = readFileSync(
  join(
    ROOT,
    "fixtures",
    "reference_solutions",
    "chronicle",
    "card_chron_hasher",
    "src",
    "hasher.ts",
  ),
  "utf8",
);

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  name,
  arguments: args,
});

/** A scripted Worker that can take a seed, as a measured run fixes one (rule 10). */
class SeededMock extends MockInferenceAdapter {
  public seeds: (number | undefined)[] = [];
  setSeed(n: number | undefined): void {
    this.seeds.push(n);
  }
}

/** Writes the card's file and finishes: the reference solution, or a stub. */
function worker(id: string, content: string): SeededMock {
  const reply: InferenceResponse = {
    text: "",
    toolCalls: [
      call("1", "write_file", { path: "src/hasher.ts", content }),
      call("2", "finish_card", {}),
    ],
    usage,
  };
  // Every card it is given, the same reply: one model serves many cards.
  return new SeededMock(id, [], { rules: [{ match: () => true, response: reply }] });
}

/** The Worker's set cut to the hasher card, the end-to-end check to the same card. */
function hasherSets(): ScreeningSets {
  const real = loadScreeningSets(ROOT);
  const item = real.roles.worker.items.find((i) => i.id === "chronicle/card_chron_hasher");
  if (!item) throw new Error("no hasher card in the Worker's screening set");
  return {
    roles: { ...real.roles, worker: { ...real.roles.worker, items: [item], expectedSize: 1 } },
    endToEnd: { ...real.endToEnd, items: [item] },
  };
}

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), "bench-runner-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(dir, ".sekhemet", "events.db"));
  dbs.push(db);
  initSchema(db);
  return { dir, log: new EventLog(db) };
}

function adapters(models: Record<string, MockInferenceAdapter>) {
  const asked: string[] = [];
  return {
    asked,
    adapterFor: (role: ModelRole, model: string) => {
      asked.push(`${role}:${model}`);
      const a = models[model];
      if (!a) throw new Error(`no scripted model ${model}`);
      return a;
    },
  };
}

const profile = resolveRunProfile({ env: {}, argv: [] });

describe("the suite runner for the benchmark", () => {
  it("screens a real card for a combination: the Worker's work is run, its acceptance tests counted, and the score recorded (startQuick)", async () => {
    const { dir, log } = ledger();
    const planner = new MockInferenceAdapter("mock-planner", [
      { text: "1. Implement the hasher in src/hasher.ts.", toolCalls: [], usage },
    ]);
    const reviewer = new MockInferenceAdapter("mock-reviewer", [
      { text: '{"findings":[]}', toolCalls: [], usage },
    ]);
    const models = adapters({
      "mock-good": worker("mock-good", HASHER),
      "mock-planner": planner,
      "mock-reviewer": reviewer,
    });
    const runner = suiteScreenRunner({
      harnessRoot: ROOT,
      workDir: join(dir, "work"),
      adapterFor: models.adapterFor,
      runProfile: () => profile,
      headroomCheck: false,
    });
    let released = 0;
    const env: BenchmarkEnv = {
      repoPath: dir,
      log,
      host: "host-a",
      sets: hasherSets,
      overnightSets: () => ({ roles: {} }) as unknown as OvernightSets,
      machine: () => ({ reservedHours: "none" }),
      fit: () => ({ fits: true }),
      cacheKey: (_r, model, setHash) => ({
        model,
        quantisation: "Q4",
        engine: "mock",
        settings: "s",
        host: "host-a",
        contextVersion: "c",
        setHash,
      }),
      throughput: async () => ({ secondsPerItem: () => undefined, loadSeconds: () => undefined }),
      runProfile: () => profile,
      measurementRun: (run) =>
        withMeasurementRun(
          {
            releaseAll: async () => {
              released++;
            },
          },
          run,
        ),
      screenRunner: () => runner,
      fingerprint: () => ({ build: "b", contextVersion: "c", qualification: "q" }),
    };
    const combo: Combination = {
      worker: "mock-good",
      planner: "mock-planner",
      reviewer: "mock-reviewer",
    };
    const started = await new BenchmarkService(env).startQuick(combo, undefined);
    const result = await started.finished;
    expect(released).toBe(1);
    const w = result.roles.find((r) => r.role === "worker");
    expect(w).toMatchObject({ state: "measured", capped: 0 });
    expect(w?.items).toEqual([{ id: "chronicle/card_chron_hasher", score: 1 }]);
    expect(w?.secondary?.validToolCallRate).toBe(1);
    // The Planner stays not measured: the golden briefs are unlabelled.
    expect(result.roles.find((r) => r.role === "planner")?.state).toBe("not_measured");
    // The end-to-end check went through the Planner, the Worker and the Reviewer.
    expect(result.endToEnd).toMatchObject({ passed: 1, total: 1 });
    expect(planner.callHistory.length).toBeGreaterThan(0);
    expect(reviewer.callHistory.length).toBeGreaterThan(0);
    const [event] = await log.getEventsByTypes(["measure/benchmarked"]);
    const roles = (event?.payload as { roles: { role: string; score?: number }[] }).roles;
    expect(roles.find((r) => r.role === "worker")?.score).toBe(1);
  }, 240_000);

  it("never reads a report the Worker could have planted: a fresh name, deleted after", async () => {
    const { dir } = ledger();
    // A planted report at the old fixed name, and a stale one of the same shape.
    writeFileSync(
      join(dir, ".sekhemet-bench-tests.json"),
      JSON.stringify({ numPassedTests: 99, numTotalTests: 99 }),
    );
    const outs: string[] = [];
    // The test run wrote nothing (it crashed before its reporter ran).
    const none = await vitestCount(ROOT, dir, ["tests/a.test.ts"], async (_cmd, args) => {
      outs.push(String(args.find((a) => a.startsWith("--outputFile="))).slice(13));
    });
    expect(none).toEqual({ passed: 0, total: 0 });
    // Its reporter wrote the report: that one is read, then removed.
    const counted = await vitestCount(ROOT, dir, ["tests/a.test.ts"], async (_cmd, args) => {
      const out = String(args.find((a) => a.startsWith("--outputFile="))).slice(13);
      outs.push(out);
      writeFileSync(out, JSON.stringify({ numPassedTests: 3, numTotalTests: 5 }));
    });
    expect(counted).toEqual({ passed: 3, total: 5 });
    expect(new Set(outs).size).toBe(2);
    for (const out of outs) {
      expect(out).not.toBe(join(dir, ".sekhemet-bench-tests.json"));
      expect(existsSync(out)).toBe(false);
    }
    expect(readdirSync(dir).filter((n) => n.startsWith(".sekhemet-bench-report"))).toEqual([]);
  });

  it("keeps the acceptance-origin switch the run's own, never the process's", async () => {
    const { dir } = ledger();
    let seen: string | undefined = "unread";
    const runner = suiteScreenRunner({
      harnessRoot: ROOT,
      workDir: join(dir, "work"),
      adapterFor: adapters({ "mock-stub": worker("mock-stub", "export const nothing = 1;\n") })
        .adapterFor,
      runProfile: () => profile,
      headroomCheck: false,
      countTests: async () => {
        seen = process.env.SEKHEMET_ACCEPTANCE_ORIGIN;
        return { passed: 0, total: 5 };
      },
    });
    const item = hasherSets().roles.worker.items[0];
    if (!item) throw new Error("no item");
    await runner.load("worker", "mock-stub");
    await runner.runItem({ role: "worker", model: "mock-stub", item, capSeconds: 120 });
    await runner.release?.();
    expect(seen).toBeUndefined();
  }, 240_000);

  it("scores a Worker's stub by the tests passing at its end: none of five", async () => {
    const { dir } = ledger();
    const runner = suiteScreenRunner({
      harnessRoot: ROOT,
      workDir: join(dir, "work"),
      adapterFor: adapters({ "mock-stub": worker("mock-stub", "export const nothing = 1;\n") })
        .adapterFor,
      runProfile: () => profile,
      headroomCheck: false,
    });
    const item = hasherSets().roles.worker.items[0];
    if (!item) throw new Error("no item");
    await runner.load("worker", "mock-stub");
    const r = await runner.runItem({ role: "worker", model: "mock-stub", item, capSeconds: 120 });
    expect(r.outcome).toEqual({ kind: "tests", passed: 0, total: 5 });
    await runner.release?.();
  }, 240_000);

  it("runs an overnight block on the real card with its fixed seed, stops at a simulated window's end and resumes the next night", async () => {
    const { dir, log } = ledger();
    const good = worker("mock-good", HASHER);
    const models = adapters({ "mock-good": good });
    const runner = suiteOvernightRunner({
      harnessRoot: ROOT,
      workDir: join(dir, "work"),
      adapterFor: models.adapterFor,
      runProfile: () => profile,
      headroomCheck: false,
    });
    const sets: OvernightSets = {
      roles: {
        worker: {
          state: "ready",
          runs: 2,
          cards: [{ id: "chronicle/card_chron_hasher", role: "worker" }],
        },
        planner: { state: "not_built", runs: 1, cards: [] },
        reviewer: { state: "not_built", runs: 1, cards: [] },
        researcher: { state: "not_built", runs: 1, cards: [] },
      },
    };
    const { runId } = await scheduleOvernight(log, {
      combinations: [{ worker: "mock-good", planner: "p" }],
      host: "host-a",
    });
    const { runOvernightBench } = await import("@sekhemet/eval");
    const night = (window: () => { open: boolean; why: string; reason?: "window_end" }) =>
      runOvernightBench({
        log,
        runId,
        runner,
        sets,
        host: "host-a",
        now: () => Date.now(),
        window,
        fingerprint: { build: "b", contextVersion: "c", qualification: "q" },
        runProfileFor: () => profile,
        measurementRun: (run) => run(),
      });
    let checks = 0;
    const first = await night(() =>
      ++checks > 1
        ? { open: false, why: "the window ended", reason: "window_end" }
        : { open: true, why: "open" },
    );
    expect(first).toMatchObject({ state: "stopped", reason: "window_end", completed: 1 });
    const second = await night(() => ({ open: true, why: "open" }));
    expect(second).toMatchObject({ state: "done", completed: 2, total: 2 });
    // Each run's fixed seed reached the Worker (measurement rule 10).
    expect(good.seeds).toEqual([1, 2]);
    const items = await log.getEventsByTypes(["measure/benchmark_item"]);
    expect(items.map((i) => (i.payload as { score: number; run: number }).run)).toEqual([1, 2]);
    expect(items.every((i) => (i.payload as { score: number }).score === 1)).toBe(true);
  }, 300_000);
});
