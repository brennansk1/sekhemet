import type { LocalInferenceAdapter } from "@sekhemet/models";
import { candidateSettings } from "@sekhemet/models";
import { BenchmarkHarness } from "./benchmark.js";
import type { BenchmarkOptions, EvalBenchmarkResult, EvalHarness, SyntheticTask } from "./types.js";

/**
 * The M0 measurement protocol (E1): Pass@1 under the real loop, over up to
 * 30 tasks, 3 independent runs, at step budgets 50 and 150. Three runs give
 * a spread (small models are noisy run to run); two budgets separate "can't
 * do it" from "ran out of steps". Every run keeps its full settings (E3).
 */
export interface M0Options {
  tasks: SyntheticTask[];
  adapter: LocalInferenceAdapter;
  runs?: number;
  budgets?: number[];
  maxTasks?: number;
  harness?: EvalHarness;
  benchmark?: Omit<BenchmarkOptions, "stepBudget" | "passAtK">;
  onRun?: (budget: number, run: number, result: EvalBenchmarkResult) => void;
}

export interface M0BudgetSummary {
  stepBudget: number;
  runs: number;
  passAt1: number[];
  mean: number;
  min: number;
  max: number;
  stddev: number;
  /** Tasks that passed in every run / in at least one run. */
  alwaysPassed: string[];
  everPassed: string[];
  meanTokens: number;
  meanMinutes: number;
}

export interface M0Report {
  taskCount: number;
  budgets: M0BudgetSummary[];
  results: EvalBenchmarkResult[];
  /** Tasks that pass at 150 but never at 50: step-starved, not incapable. */
  stepStarved: string[];
}

export const M0_DEFAULTS = { runs: 3, budgets: [50, 150], maxTasks: 30 } as const;

function summarize(budget: number, results: EvalBenchmarkResult[]): M0BudgetSummary {
  const rates = results.map((r) => r.passAt1);
  const mean = rates.reduce((a, b) => a + b, 0) / Math.max(1, rates.length);
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rates.length);
  const passedIn = (r: EvalBenchmarkResult) =>
    new Set(r.tasks.filter((t) => t.passedFirstAttempt).map((t) => t.taskId));
  const sets = results.map(passedIn);
  const all = [...new Set(results.flatMap((r) => r.tasks.map((t) => t.taskId)))].sort();
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    stepBudget: budget,
    runs: results.length,
    passAt1: rates.map(round),
    mean: round(mean),
    min: round(Math.min(...rates)),
    max: round(Math.max(...rates)),
    stddev: round(Math.sqrt(variance)),
    alwaysPassed: all.filter((t) => sets.every((s) => s.has(t))),
    everPassed: all.filter((t) => sets.some((s) => s.has(t))),
    meanTokens: Math.round(
      results.reduce((a, r) => a + r.totalTokens, 0) / Math.max(1, results.length),
    ),
    meanMinutes: round(
      results.reduce((a, r) => a + r.totalTimeMs, 0) / Math.max(1, results.length) / 60_000,
    ),
  };
}

export async function runM0Protocol(options: M0Options): Promise<M0Report> {
  const tasks = options.tasks.slice(0, options.maxTasks ?? M0_DEFAULTS.maxTasks);
  const harness = options.harness ?? new BenchmarkHarness();
  const budgets = options.budgets ?? [...M0_DEFAULTS.budgets];
  const runs = options.runs ?? M0_DEFAULTS.runs;
  const settings = candidateSettings(options.adapter);
  const results: EvalBenchmarkResult[] = [];
  const summaries: M0BudgetSummary[] = [];
  for (const budget of budgets) {
    const perBudget: EvalBenchmarkResult[] = [];
    for (let run = 1; run <= runs; run++) {
      const result = await harness.runBenchmark(tasks, options.adapter, {
        quant: settings.quant,
        engine: settings.engine,
        ...(settings.contextTokens ? { contextTokens: settings.contextTokens } : {}),
        toolArm: settings.toolArm,
        ...options.benchmark,
        stepBudget: budget,
        passAtK: 1,
      });
      perBudget.push(result);
      results.push(result);
      options.onRun?.(budget, run, result);
    }
    summaries.push(summarize(budget, perBudget));
  }
  const low = summaries.find((s) => s.stepBudget === Math.min(...budgets));
  const high = summaries.find((s) => s.stepBudget === Math.max(...budgets));
  const stepStarved =
    low && high && low !== high ? high.everPassed.filter((t) => !low.everPassed.includes(t)) : [];
  return { taskCount: tasks.length, budgets: summaries, results, stepStarved };
}

export function formatM0Report(report: M0Report): string {
  const lines = [`M0: ${report.taskCount} tasks`];
  for (const b of report.budgets) {
    lines.push(
      `  budget ${b.stepBudget}: Pass@1 mean ${(b.mean * 100).toFixed(1)}% (min ${(b.min * 100).toFixed(1)}, max ${(b.max * 100).toFixed(1)}, sd ${(b.stddev * 100).toFixed(1)}) over ${b.runs} runs; always ${b.alwaysPassed.length}, ever ${b.everPassed.length}; ~${b.meanTokens} tokens, ${b.meanMinutes} min per run`,
    );
  }
  if (report.stepStarved.length)
    lines.push(`  step-starved at the low budget: ${report.stepStarved.join(", ")}`);
  return lines.join("\n");
}
