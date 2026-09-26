import type { NumberGrade } from "./library_types.js";
import { percentile } from "./swap_cost.js";

/**
 * The model page's measured speed (dashboard DB-NM14-3; DEC-44: llama-bench,
 * MIT, ships with llama.cpp). One warm-up, then five runs at the role's
 * depth; the result is *Measured* only when the runs' spread — (max − min) ÷
 * median — is 3% or less, and otherwise shown as not accepted and not used.
 * This is the wrapper only: running it loads the model, so it is started by
 * a person's action through the residency scheduler, never by a page view.
 */

export const LLAMA_BENCH_RUNS = 5;
export const MAX_BENCH_SPREAD = 0.03;

export type BenchExec = (cmd: string, args: string[]) => Promise<string>;

export interface BenchSpeed {
  /** The median of the five runs, tokens per second. */
  value: number;
  /** `measured` only when accepted. */
  grade: NumberGrade;
  spread: number;
  runs: number[];
}

export interface LlamaBenchResult {
  accepted: boolean;
  reason?: string;
  depth: number;
  decode: BenchSpeed;
  prefill: BenchSpeed;
  warmup: { decode?: number; prefill?: number };
}

interface BenchRecord {
  n_prompt?: number;
  n_gen?: number;
  avg_ts?: number;
}

function parseRun(stdout: string): { decode?: number; prefill?: number } {
  let records: BenchRecord[];
  try {
    const j = JSON.parse(stdout) as BenchRecord[] | BenchRecord;
    records = Array.isArray(j) ? j : [j];
  } catch {
    throw new Error("llama-bench did not print JSON");
  }
  const decode = records.find((r) => (r.n_gen ?? 0) > 0)?.avg_ts;
  const prefill = records.find((r) => (r.n_prompt ?? 0) > 0 && (r.n_gen ?? 0) === 0)?.avg_ts;
  return {
    ...(decode !== undefined ? { decode } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
  };
}

function speed(runs: number[]): Omit<BenchSpeed, "grade"> {
  const median = runs.length ? percentile(runs, 0.5) : 0;
  const spread = median > 0 ? (Math.max(...runs) - Math.min(...runs)) / median : 1;
  return { value: median, spread, runs };
}

export async function runLlamaBench(options: {
  modelPath: string;
  /** The role's depth: tokens already in context (`-d`). */
  depth: number;
  promptTokens?: number;
  genTokens?: number;
  bin?: string;
  exec: BenchExec;
  extraArgs?: string[];
}): Promise<LlamaBenchResult> {
  const args = [
    "-m",
    options.modelPath,
    "-p",
    String(options.promptTokens ?? 512),
    "-n",
    String(options.genTokens ?? 128),
    "-d",
    String(options.depth),
    "-r",
    "1",
    "-o",
    "json",
    ...(options.extraArgs ?? []),
  ];
  const bin = options.bin ?? "llama-bench";
  const warmup = parseRun(await options.exec(bin, args));
  const decodes: number[] = [];
  const prefills: number[] = [];
  for (let i = 0; i < LLAMA_BENCH_RUNS; i++) {
    const r = parseRun(await options.exec(bin, args));
    if (r.decode !== undefined) decodes.push(r.decode);
    if (r.prefill !== undefined) prefills.push(r.prefill);
  }
  const d = speed(decodes);
  const p = speed(prefills);
  const accepted =
    decodes.length === LLAMA_BENCH_RUNS &&
    d.spread <= MAX_BENCH_SPREAD &&
    (prefills.length === 0 || p.spread <= MAX_BENCH_SPREAD);
  const worst = Math.max(d.spread, prefills.length ? p.spread : 0);
  return {
    accepted,
    ...(accepted
      ? {}
      : {
          reason: `not accepted: the five runs' spread was ${(worst * 100).toFixed(1)}%, over the 3% limit`,
        }),
    depth: options.depth,
    decode: { ...d, grade: accepted ? "measured" : "estimated" },
    prefill: { ...p, grade: accepted ? "measured" : "estimated" },
    warmup,
  };
}
