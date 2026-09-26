import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ts } from "./index/typescript.js";
import type { MutationMeasure } from "./types.js";

/**
 * The mutation gate's scoring (gates rule 32): two scores over
 * non-equivalent mutants (GT-TQ-3), stillborn and equivalent mutants
 * excluded and counted (GT-TQ-4), a survivor of the card's acceptance tests
 * a test gap for a person (GT-TQ-5), and the mutants past `mutation_max`
 * queued for the nightly run (GT-N5-5).
 */

/** One single-token mutant of a changed line. */
export interface LineMutant {
  file: string;
  line: number;
  /** Offset of the mutated token in the file. */
  start: number;
  original: string;
  replacement: string;
  /** The whole file with the mutant applied. */
  source: string;
}

/** The runs a mutant is judged by, each on the worktree as it stands. */
export interface MutationRunners {
  /** The whole suite; true when it passes. */
  runTests: () => Promise<boolean>;
  /** The card's acceptance tests alone; true when they pass. */
  runAcceptanceTests?: () => Promise<boolean>;
  /** The project's typecheck; false marks a mutant stillborn. */
  runTypecheck?: () => Promise<boolean>;
}

const TRANSPILE: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.Preserve,
  removeComments: true,
};

/**
 * A mutant whose transpiled JavaScript is identical to the original's
 * (GT-TQ-4, the cheap analogue of trivial compiler equivalence): a change in
 * a type position no test can observe.
 */
export function equivalentMutant(file: string, original: string, mutated: string): boolean {
  const out = (source: string) =>
    ts.transpileModule(source, {
      compilerOptions: TRANSPILE,
      fileName: file,
      reportDiagnostics: false,
    }).outputText;
  return out(original) === out(mutated);
}

export type MutantVerdict = "killed_by_acceptance" | "killed_by_suite" | "survived" | "stillborn";

/**
 * Judge each mutant in place, restoring the file after each: stillborn when
 * the typecheck fails; killed by the acceptance tests when they fail (the
 * suite, which holds them, then fails too); killed by the suite when only
 * the whole suite fails; otherwise survived.
 */
export async function judgeMutants(
  root: string,
  mutants: readonly LineMutant[],
  runners: MutationRunners,
): Promise<MutantVerdict[]> {
  const out: MutantVerdict[] = [];
  for (const m of mutants) {
    const abs = join(root, m.file);
    const original = readFileSync(abs, "utf8");
    try {
      writeFileSync(abs, m.source);
      if (runners.runTypecheck && !(await runners.runTypecheck())) out.push("stillborn");
      else if (runners.runAcceptanceTests && !(await runners.runAcceptanceTests())) {
        out.push("killed_by_acceptance");
      } else out.push((await runners.runTests()) ? "survived" : "killed_by_suite");
    } finally {
      writeFileSync(abs, original);
    }
  }
  return out;
}

/**
 * The typecheck fails on the unmutated tree: a mutant it rejects is not
 * thereby stillborn (GT-TQ-4).
 */
export const TYPECHECK_FAILS_UNMUTATED =
  "the typecheck fails on the unmutated tree (the onboarding baseline applied), so no mutant is judged stillborn: each ran through the tests";

/** Every judged mutant was stillborn: nothing was measured (GT-TQ-4). */
export const NO_LIVE_MUTANTS =
  "no live mutant: every mutant judged was stillborn, so nothing was measured";

/**
 * The typecheck a stillborn verdict may rest on (GT-TQ-4): only one that
 * passes on the unmutated tree, with the onboarding baseline applied by the
 * caller's runner. Otherwise no typecheck, and why.
 */
export async function stillbornTypecheck(
  runTypecheck: (() => Promise<boolean>) | undefined,
): Promise<{ runTypecheck?: () => Promise<boolean>; stillbornNotJudged?: string }> {
  if (!runTypecheck) return {};
  if (await runTypecheck()) return { runTypecheck };
  return { stillbornNotJudged: TYPECHECK_FAILS_UNMUTATED };
}

/** Killed over total, rounded as the mutation step rounds it; null when there is nothing to score. */
export function mutationScore(killed: number, total: number): number | null {
  return total > 0 ? Math.round((killed / total) * 1000) / 1000 : null;
}

/** Counts of judged mutants: the suite's and, when run, the acceptance tests'. */
export interface MutantCounts {
  killed: number;
  total: number;
  stillborn: number;
  /** Null when the acceptance tests were not run alone. */
  acceptance: { killed: number; total: number } | null;
}

export function countVerdicts(
  verdicts: readonly MutantVerdict[],
  acceptance: boolean,
): MutantCounts {
  const live = verdicts.filter((v) => v !== "stillborn");
  const byAcceptance = live.filter((v) => v === "killed_by_acceptance").length;
  return {
    killed: byAcceptance + live.filter((v) => v === "killed_by_suite").length,
    total: live.length,
    stillborn: verdicts.length - live.length,
    acceptance: acceptance ? { killed: byAcceptance, total: live.length } : null,
  };
}

/** A survivor of the tests that judge proof: of the acceptance tests when they ran alone. */
export function isTestGap(v: MutantVerdict, acceptance: boolean): boolean {
  return v === "survived" || (acceptance && v === "killed_by_suite");
}

// --- the nightly queue (GT-N5-5) ---------------------------------------------------------

/** A mutant deferred to the nightly run, pinned to the file content it was made from. */
export interface QueuedMutant {
  file: string;
  line: number;
  start: number;
  original: string;
  replacement: string;
  fileSha256: string;
}

export interface MutationQueue {
  version: 1;
  cardId?: string;
  createdAt: string;
  /** What the card's verification scored: the first `mutation_max`. */
  scored: MutantCounts & { equivalent: number };
  /** Why the acceptance score is missing, when it is. */
  acceptanceReason?: string;
  mutants: QueuedMutant[];
  /** The full score, once the nightly run finished. */
  completed?: MutationMeasure;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Write the deferred mutants where the nightly run reads them; returns the queue's path. */
export function writeMutationQueue(
  stateDir: string,
  key: string,
  queue: Omit<MutationQueue, "version" | "createdAt">,
): string {
  const path = join(stateDir, "nightly", "mutation", `${key.replace(/[^\w.-]/g, "_")}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const record: MutationQueue = { version: 1, createdAt: new Date().toISOString(), ...queue };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

export function readMutationQueue(path: string): MutationQueue | undefined {
  try {
    const q = JSON.parse(readFileSync(path, "utf8")) as MutationQueue;
    return q.version === 1 && Array.isArray(q.mutants) ? q : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The full measure from the verification's counts and the nightly run's. A
 * refused measure, or one with no live mutant, is not measured: its score is
 * null, never a number (GT-TQ-4, MS-M10-2).
 */
export function measureOf(
  counts: MutantCounts & { equivalent: number },
  extra: Partial<MutationMeasure> & { acceptanceReason?: string } = {},
): MutationMeasure {
  const { acceptanceReason, ...rest } = extra;
  const refused =
    rest.refused ?? (counts.total === 0 && counts.stillborn > 0 ? NO_LIVE_MUTANTS : undefined);
  const scored = refused === undefined;
  return {
    score: scored ? mutationScore(counts.killed, counts.total) : null,
    killed: counts.killed,
    total: counts.total,
    notMeasured: [],
    stillborn: counts.stillborn,
    equivalent: counts.equivalent,
    acceptance: counts.acceptance
      ? {
          score: scored ? mutationScore(counts.acceptance.killed, counts.acceptance.total) : null,
          killed: counts.acceptance.killed,
          total: counts.acceptance.total,
        }
      : { score: null, killed: 0, total: 0, reason: acceptanceReason ?? "not run" },
    ...rest,
    ...(refused !== undefined ? { refused } : {}),
  };
}

/**
 * The nightly run of a card's deferred mutants (GT-N5-5, runtime.md): the
 * unmutated suite must pass first, and the typecheck too before any mutant
 * is judged stillborn; a mutant whose file changed since it was queued is not
 * run and is named in `stale`. `beforeComplete` records the full score (the
 * card's ledger) before the queue is marked `completed`, so a run that stops
 * between the two leaves the queue to run again, never a score only the
 * queue holds. The measure is returned.
 */
export async function runNightlyMutation(
  opts: {
    queue: string;
    root: string;
    beforeComplete?: (measure: MutationMeasure) => Promise<void>;
  } & MutationRunners,
): Promise<MutationMeasure> {
  const q = readMutationQueue(opts.queue);
  if (!q) throw new Error(`no mutation queue at ${opts.queue}`);
  const acceptance = q.scored.acceptance !== null && opts.runAcceptanceTests !== undefined;
  const stale: string[] = [];
  const runnable: LineMutant[] = [];
  for (const m of q.mutants) {
    const abs = join(opts.root, m.file);
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    if (text === undefined || sha256(text) !== m.fileSha256) {
      stale.push(`${m.file}:${m.line}`);
      continue;
    }
    runnable.push({
      ...m,
      source: `${text.slice(0, m.start)}${m.replacement}${text.slice(m.start + m.original.length)}`,
    });
  }
  let verdicts: MutantVerdict[] = [];
  let refused: string | undefined;
  let stillbornNotJudged: string | undefined;
  if (runnable.length > 0) {
    if (!(await opts.runTests())) {
      refused = "the tests fail on the unmutated tree, so a killed mutant would prove nothing";
    } else {
      const typecheck = await stillbornTypecheck(opts.runTypecheck);
      stillbornNotJudged = typecheck.stillbornNotJudged;
      verdicts = await judgeMutants(opts.root, runnable, {
        runTests: opts.runTests,
        ...(acceptance && opts.runAcceptanceTests
          ? { runAcceptanceTests: opts.runAcceptanceTests }
          : {}),
        ...(typecheck.runTypecheck ? { runTypecheck: typecheck.runTypecheck } : {}),
      });
    }
  }
  const night = countVerdicts(verdicts, acceptance);
  const counts = {
    killed: q.scored.killed + night.killed,
    total: q.scored.total + night.total,
    stillborn: q.scored.stillborn + night.stillborn,
    equivalent: q.scored.equivalent,
    acceptance:
      q.scored.acceptance && night.acceptance
        ? {
            killed: q.scored.acceptance.killed + night.acceptance.killed,
            total: q.scored.acceptance.total + night.acceptance.total,
          }
        : null,
  };
  const measure = measureOf(counts, {
    ...(stale.length > 0 ? { stale } : {}),
    ...(refused ? { refused } : {}),
    ...(stillbornNotJudged ? { stillbornNotJudged } : {}),
    acceptanceReason: q.acceptanceReason ?? "the acceptance tests were not run alone at night",
  });
  await opts.beforeComplete?.(measure);
  writeFileSync(opts.queue, `${JSON.stringify({ ...q, completed: measure }, null, 2)}\n`);
  return measure;
}
