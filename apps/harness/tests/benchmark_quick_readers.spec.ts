import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import { dailyStandup } from "../src/pm/service.js";
import { PmStore } from "../src/pm/store.js";

// Measurement MS-N5-8: WHEN DEC-28 admission, qualification, or a change to
// the recorded baseline or a shipped default is computed THE SYSTEM SHALL
// NOT read quick-tier results — "a search test finds no such reader". And
// MS-N5-11: the overnight morning report reaches Seshat's standup.

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** The modules that admit a harness change, qualify a model or change the baseline or a default. */
const DECIDERS = [
  "packages/eval/src/admission.ts",
  "packages/eval/src/guardrails.ts",
  "packages/eval/src/swap_admission.ts",
  "packages/eval/src/null_baselines.ts",
  "packages/models/src/qualification.ts",
  "packages/models/src/qualification_copy.ts",
  "packages/models/src/qualification_key.ts",
  "packages/models/src/assignments.ts",
  "packages/models/src/bakeoff.ts",
  "packages/models/src/registry.ts",
  "apps/harness/src/qualify.ts",
  "apps/harness/src/regression_gate.ts",
  "apps/harness/src/suite_path.ts",
  "apps/harness/src/bakeoff_tasks.ts",
];

/** Code that reads benchmark results: the event read, or the quick tier's readers. */
const READER =
  /getEventsByTypes\(\s*\[[^\]]*(?:"measure\/benchmarked"|MEASURE_BENCHMARKED)|\breadQuickScores\s*\(|\bquickEvents\s*\(|\bcombinationResults\s*\(|\bbenchmarkedResult\b/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...sources(p));
    else if (name.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("no reader treats a quick-tier result as bake-off evidence (MS-N5-8)", () => {
  it("finds no benchmark reader in any module that admits, qualifies or changes a baseline or default", () => {
    const offenders = DECIDERS.filter((f) => READER.test(readFileSync(join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("finds every ledger read of measure/benchmarked outside the benchmark itself checking for the overnight tier", () => {
    const files = [
      ...readdirSync(join(ROOT, "packages")).flatMap((p) => {
        try {
          return sources(join(ROOT, "packages", p, "src"));
        } catch {
          return [];
        }
      }),
      ...sources(join(ROOT, "apps", "harness", "src")),
    ];
    const benchmarkOwn = new Set([
      "packages/eval/src/combination_bench.ts",
      "packages/eval/src/overnight_bench.ts",
      "apps/harness/src/benchmark_cmd.ts",
      "apps/harness/src/benchmark_api.ts",
    ]);
    const readers = files
      .map((f) => ({ f: relative(ROOT, f), text: readFileSync(f, "utf8") }))
      .filter(({ f, text }) => !benchmarkOwn.has(f) && /["']measure\/benchmarked["']/.test(text))
      .filter(({ text }) => /getEventsByTypes/.test(text));
    for (const { f, text } of readers)
      expect(text, `${f} reads measure/benchmarked without telling the tiers apart`).toMatch(
        /"overnight"/,
      );
  });
});

describe("the morning report in Seshat's standup (MS-N5-11)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("adds the latest overnight report, and nothing when there is none", async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-standup-"));
    dirs.push(root);
    const db = new DatabaseSync(join(root, "events.db"));
    try {
      initSchema(db);
      const log = new EventLog(db);
      const cardStore = new CardStore(db, log);
      const before = await dailyStandup({ repoPath: root, cardStore, pmStore: new PmStore(log) });
      expect(before).not.toMatch(/Overnight benchmark/);
      const { scheduleOvernight, runOvernightBench, resolveRunProfile } = await import(
        "@sekhemet/eval"
      );
      const { runId } = await scheduleOvernight(log, {
        combinations: [{ worker: "wa", planner: "p" }],
        host: "h",
      });
      await runOvernightBench({
        log,
        runId,
        runner: {
          swapTo: async () => undefined,
          runCard: async () => ({ passed: true, seconds: 1 }),
        },
        sets: {
          roles: {
            worker: { state: "ready", runs: 2, cards: [{ id: "s1", role: "worker" }] },
            planner: { state: "not_built", runs: 1, cards: [] },
            reviewer: { state: "not_built", runs: 1, cards: [] },
            researcher: { state: "not_built", runs: 1, cards: [] },
          },
        },
        host: "h",
        now: () => Date.now(),
        window: () => ({ open: true, why: "open" }),
        fingerprint: { build: "b", contextVersion: "c", qualification: "q" },
        runProfileFor: () => resolveRunProfile({ env: {}, argv: [] }),
        measurementRun: (run) => run(),
      });
      const after = await dailyStandup({ repoPath: root, cardStore, pmStore: new PmStore(log) });
      expect(after).toMatch(/Overnight benchmark/);
      expect(after).toMatch(/assigned nothing/);
    } finally {
      db.close();
    }
  });
});
