import {
  type AttemptOutcome,
  type CardKind,
  type CardRecord,
  firstModelAttempts,
} from "@sekhemet/kernel";
import { type PlannerLedger, appendPlannerEvent } from "./ledger.js";
import type { SpidrSliceKind } from "./types.js";

/**
 * Split to the measured horizon (planner-pm NEW-planner-pm-3, PM-N3-1…4).
 *
 * The Worker's record is read from the ledger's attempt records (the
 * kernel's `readAttemptOutcomes`): each card's first attempt that measures
 * the model — never a person's (PM-N3-4), never a halt. A kind with at least
 * `CAPABILITY_MIN_ATTEMPTS` sized first attempts gets a logistic fit of pass
 * probability against difficulty and changed lines, and its 80% size horizon
 * (at the kind's median difficulty) with a bootstrap interval (PM-N3-1). A
 * planned card predicted to pass under `SPLIT_BELOW_PASS`, or estimated over
 * the horizon, is split before it is scheduled (PM-N3-2). Under the minimum
 * only the static bounds (3 files, 200 lines, Zone 3) apply and the rate is
 * a rough range (PM-N3-3).
 */

export const CAPABILITY_MIN_ATTEMPTS = 10;
/** Below this predicted pass probability a planned card is split (PM-N3-2). */
export const SPLIT_BELOW_PASS = 0.6;
/** The size horizon's pass probability. */
export const HORIZON_PASS = 0.8;
/** Lines per difficulty point assumed before a kind has a sized record. */
export const PRIOR_LINES_PER_DIFFICULTY = 25;
const BOOTSTRAP_SAMPLES = 200;

/** The stored `kind` of a card of each slice (DEC-26). */
export const KIND_OF_SLICE: Record<SpidrSliceKind, CardKind> = {
  spike: "spike",
  interface: "interface",
  data: "data",
  path: "implement",
  rule: "rule",
};

export interface CapabilityFitCoefficients {
  intercept: number;
  difficulty: number;
  lines: number;
  /** Sized first attempts the fit was made from. */
  samples: number;
}

export interface KindCapability {
  kind: string;
  /** First attempts that measure the Worker, sized or not. */
  attempts: number;
  passes: number;
  rate: number;
  /** 95% Wilson interval of the rate. */
  low: number;
  high: number;
  /** Under the minimum: only the static bounds apply (PM-N3-3). */
  rough: boolean;
  fit?: CapabilityFitCoefficients;
  /** Changed lines at which the fit predicts an 80% pass, at `atDifficulty`. */
  horizon80Lines?: number;
  /** Its 95% bootstrap interval; `null` above means no measured limit. */
  horizonInterval?: [number, number | null];
  atDifficulty?: number;
}

export interface CapabilityModel {
  kinds: Record<string, KindCapability>;
  /** Per sized first attempt: its kind, difficulty and changed lines (size estimates). */
  sizes: { kind: string; difficulty: number; lines: number }[];
}

const round = (v: number, places = 3): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** 95% Wilson score interval for k successes in n trials. */
function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)) };
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Solve a small dense system by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) {
      if (
        Math.abs((m[r] as number[])[col] as number) >
        Math.abs((m[pivot] as number[])[col] as number)
      )
        pivot = r;
    }
    if (Math.abs((m[pivot] as number[])[col] as number) < 1e-12) return undefined;
    [m[col], m[pivot]] = [m[pivot] as number[], m[col] as number[]];
    const p = m[col] as number[];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const row = m[r] as number[];
      const f = (row[col] as number) / (p[col] as number);
      for (let c = col; c <= n; c += 1) row[c] = (row[c] as number) - f * (p[c] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/**
 * Logistic regression by Newton's method on standardised features, with a
 * small ridge on the slopes so a record that separates perfectly (every
 * small change passed, every large one failed) still gives finite
 * coefficients. Returns `[intercept, ...slopes]` on the original scale.
 */
export function fitLogistic(xs: readonly number[][], ys: readonly number[], ridge = 0.5): number[] {
  const n = xs.length;
  const k = (xs[0] ?? []).length;
  const mean = Array.from(
    { length: k },
    (_, j) => xs.reduce((s, x) => s + (x[j] as number), 0) / n,
  );
  const sd = Array.from({ length: k }, (_, j) => {
    const v = xs.reduce((s, x) => s + ((x[j] as number) - (mean[j] as number)) ** 2, 0) / n;
    return Math.sqrt(v) || 1;
  });
  const z = xs.map((x) => [1, ...x.map((v, j) => (v - (mean[j] as number)) / (sd[j] as number))]);
  let beta = new Array(k + 1).fill(0) as number[];
  for (let iter = 0; iter < 50; iter += 1) {
    const grad = new Array(k + 1).fill(0) as number[];
    const hess = Array.from({ length: k + 1 }, () => new Array(k + 1).fill(0) as number[]);
    for (let i = 0; i < n; i += 1) {
      const row = z[i] as number[];
      const p = sigmoid(row.reduce((s, v, j) => s + v * (beta[j] as number), 0));
      const w = p * (1 - p);
      for (let a = 0; a <= k; a += 1) {
        grad[a] = (grad[a] as number) + ((ys[i] as number) - p) * (row[a] as number);
        for (let b = 0; b <= k; b += 1) {
          (hess[a] as number[])[b] =
            ((hess[a] as number[])[b] as number) + w * (row[a] as number) * (row[b] as number);
        }
      }
    }
    for (let a = 1; a <= k; a += 1) {
      grad[a] = (grad[a] as number) - ridge * (beta[a] as number);
      (hess[a] as number[])[a] = ((hess[a] as number[])[a] as number) + ridge;
    }
    const step = solve(hess, grad);
    if (!step) break;
    beta = beta.map((b, j) => b + (step[j] as number));
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  // Back to the original scale.
  const slopes = beta.slice(1).map((b, j) => b / (sd[j] as number));
  const intercept =
    (beta[0] as number) - slopes.reduce((s, b, j) => s + b * (mean[j] as number), 0);
  return [intercept, ...slopes];
}

/** The pass probability the fit predicts, or undefined without a fit. */
export function predictPass(
  k: Pick<KindCapability, "fit">,
  difficulty: number,
  lines: number,
): number | undefined {
  if (!k.fit) return undefined;
  return sigmoid(k.fit.intercept + k.fit.difficulty * difficulty + k.fit.lines * lines);
}

/** Lines at which the fit predicts `HORIZON_PASS`; undefined when size does not lower it. */
function horizonOf(beta: readonly number[], difficulty: number): number | undefined {
  const [b0, bd, bl] = beta as [number, number, number];
  if (!(bl < 0)) return undefined;
  const target = Math.log(HORIZON_PASS / (1 - HORIZON_PASS));
  const atZeroLines = b0 + bd * difficulty;
  // The fit already predicts under the 80% target at 0 lines: the size
  // horizon is meaningless here (this difficulty is the problem, not the
  // size), so it falls back to the static bounds rather than reporting a
  // horizon of 0 lines, which would wrongly say every change is over it.
  if (atZeroLines < target) return undefined;
  return (target - atZeroLines) / bl;
}

/** A seeded generator (mulberry32): the interval is a function of the record. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function percentile(sorted: readonly number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx] as number;
}

/**
 * The capability model from attempt outcomes and the cards they ran
 * (PM-N3-1, -3, -4): first attempts that measure the Worker, grouped by the
 * card's stored `kind`.
 */
export function capabilityModel(
  outcomes: readonly AttemptOutcome[],
  cards: readonly Pick<CardRecord, "id" | "kind" | "difficulty">[],
): CapabilityModel {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const groups = new Map<string, { passed: boolean; difficulty?: number; lines?: number }[]>();
  // PM-N3-4: `firstModelAttempts` leaves out a person's attempt (and halts).
  for (const o of firstModelAttempts(outcomes)) {
    const card = byId.get(o.cardId);
    if (!card?.kind) continue;
    const list = groups.get(card.kind) ?? [];
    list.push({
      passed: o.passed,
      ...(card.difficulty !== undefined ? { difficulty: card.difficulty } : {}),
      ...(o.linesAdded !== undefined ? { lines: o.linesAdded } : {}),
    });
    groups.set(card.kind, list);
  }
  const kinds: Record<string, KindCapability> = {};
  const sizes: CapabilityModel["sizes"] = [];
  for (const [kind, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const passes = list.filter((a) => a.passed).length;
    const sized = list.filter(
      (a): a is { passed: boolean; difficulty: number; lines: number } =>
        a.difficulty !== undefined && a.lines !== undefined,
    );
    for (const s of sized) sizes.push({ kind, difficulty: s.difficulty, lines: s.lines });
    const entry: KindCapability = {
      kind,
      attempts: list.length,
      passes,
      rate: round(passes / list.length),
      ...wilson(passes, list.length),
      rough: list.length < CAPABILITY_MIN_ATTEMPTS,
    };
    if (!entry.rough && sized.length >= CAPABILITY_MIN_ATTEMPTS) {
      const xs = sized.map((s) => [s.difficulty, s.lines]);
      const ys = sized.map((s) => (s.passed ? 1 : 0));
      const beta = fitLogistic(xs, ys);
      const at = median(sized.map((s) => s.difficulty));
      entry.fit = {
        intercept: round(beta[0] as number, 6),
        difficulty: round(beta[1] as number, 6),
        lines: round(beta[2] as number, 6),
        samples: sized.length,
      };
      entry.atDifficulty = at;
      const h = horizonOf([entry.fit.intercept, entry.fit.difficulty, entry.fit.lines], at);
      if (h !== undefined) entry.horizon80Lines = Math.round(h);
      // The interval: refit on resamples of the record, seeded by the kind.
      const rand = seeded(seedOf(`${kind}:${sized.length}:${passes}`));
      const hs: number[] = [];
      for (let b = 0; b < BOOTSTRAP_SAMPLES; b += 1) {
        const idx = sized.map(() => Math.floor(rand() * sized.length));
        const ys2 = idx.map((i) => ys[i] as number);
        if (ys2.every((y) => y === ys2[0])) {
          hs.push(ys2[0] === 1 ? Number.POSITIVE_INFINITY : 0);
          continue;
        }
        const hb = horizonOf(
          fitLogistic(
            idx.map((i) => xs[i] as number[]),
            ys2,
          ),
          at,
        );
        hs.push(hb ?? Number.POSITIVE_INFINITY);
      }
      hs.sort((a, b) => a - b);
      const lo = percentile(hs, 0.025);
      const hi = percentile(hs, 0.975);
      entry.horizonInterval = [
        Number.isFinite(lo) ? Math.round(lo) : 0,
        Number.isFinite(hi) ? Math.round(hi) : null,
      ];
    }
    kinds[kind] = entry;
  }
  return { kinds, sizes };
}

/** The capability model from a ledger: its attempt records and its cards. */
export async function capabilityModelOf(ledger: PlannerLedger): Promise<CapabilityModel> {
  const outcomes = ledger.store.runs.readAttemptOutcomes();
  const cards = await ledger.store.listCards();
  return capabilityModel(outcomes, cards);
}

/**
 * A planned card's changed lines, estimated from its kind's record: its
 * difficulty times the median lines per difficulty point of the kind's
 * sized first attempts; before any, `PRIOR_LINES_PER_DIFFICULTY`.
 */
export function estimateChangedLines(
  model: CapabilityModel,
  kind: string,
  difficulty: number,
): { lines: number; basis: "history" | "prior" } {
  const ratios = model.sizes
    .filter((s) => s.kind === kind && s.difficulty > 0)
    .map((s) => s.lines / s.difficulty);
  if (ratios.length >= 3)
    return { lines: Math.round(difficulty * median(ratios)), basis: "history" };
  return { lines: difficulty * PRIOR_LINES_PER_DIFFICULTY, basis: "prior" };
}

export interface CapabilityVerdict {
  /**
   * Split before scheduling (PM-N3-2). Named `shouldSplit`, not `split`: the
   * stored SPIDR split axis (K-N9-4, `CardSplit`) is a different field, and
   * nothing outside storage, display and export may read it to decide
   * anything — the two must never share a name a reader could confuse.
   */
  shouldSplit: boolean;
  reason?: string;
  predicted?: number;
  lines: number;
  /**
   * The kind's 80% size horizon at this card's difficulty, in changed lines,
   * when its fit is limited by size (Seshat's split-not-retry, PM-P6-9).
   */
  horizon?: number;
  /** What the card's notes say about the Worker's record of its kind. */
  note: string;
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * Whether a planned card of this kind and difficulty is split before it is
 * scheduled (PM-N3-2): only for a kind with a fit (PM-N3-3), when its
 * predicted pass is under 0.6 or its estimated size is over the horizon.
 */
export function capabilityVerdict(
  model: CapabilityModel,
  card: { kind: string; difficulty: number },
): CapabilityVerdict {
  const k = model.kinds[card.kind];
  const { lines } = estimateChangedLines(model, card.kind, card.difficulty);
  if (!k) {
    return {
      shouldSplit: false,
      lines,
      note: `No measured record for ${card.kind} cards yet: only the static bounds apply.`,
    };
  }
  if (k.rough || !k.fit) {
    return {
      shouldSplit: false,
      lines,
      note: `The Worker passed ${k.passes} of ${k.attempts} ${card.kind} cards first time — a rough range of ${pct(k.low)}–${pct(k.high)} (under ${CAPABILITY_MIN_ATTEMPTS} sized attempts: only the static bounds apply).`,
    };
  }
  const predicted = predictPass(k, card.difficulty, lines) as number;
  // The horizon at this card's own difficulty; the recorded one is at the
  // kind's median difficulty, with its interval.
  const fit = k.fit;
  const h = horizonOf([fit.intercept, fit.difficulty, fit.lines], card.difficulty);
  const horizon = h === undefined ? undefined : Math.round(h);
  const interval = k.horizonInterval
    ? ` (at difficulty ${k.atDifficulty}: ${k.horizon80Lines ?? "no limit"} lines, 95% interval ${k.horizonInterval[0]}–${k.horizonInterval[1] ?? "no limit"})`
    : "";
  const note = `The Worker's record on ${k.attempts} ${card.kind} cards predicts ${pct(predicted)} first-time pass at difficulty ${card.difficulty} and about ${lines} changed lines; its 80% horizon there is ${horizon === undefined ? "not limited by size" : `${horizon} lines`}${interval}.`;
  const reasons: string[] = [];
  if (predicted < SPLIT_BELOW_PASS) {
    reasons.push(`predicted pass ${pct(predicted)} is under ${pct(SPLIT_BELOW_PASS)}`);
  }
  if (horizon !== undefined && lines > horizon) {
    reasons.push(`about ${lines} changed lines is over the 80% horizon of ${horizon} lines`);
  }
  return {
    shouldSplit: reasons.length > 0,
    ...(reasons.length > 0
      ? { reason: `Capability: ${reasons.join("; ")} for ${card.kind} cards; split it.` }
      : {}),
    predicted: round(predicted),
    lines,
    ...(horizon !== undefined ? { horizon } : {}),
    note,
  };
}

/**
 * Record each fitted kind's horizon (PM-N3-1) as `capability/fitted`, once
 * per change in its record: a plan that finds the same fit writes nothing.
 */
export async function recordCapabilityFit(
  ledger: PlannerLedger,
  model: CapabilityModel,
): Promise<number> {
  const last = new Map<string, string>();
  for (const e of await ledger.log.getEventsByTypes(["capability/fitted"])) {
    const p = e.payload as { kind?: string; key?: string };
    if (p.kind && p.key) last.set(p.kind, p.key);
  }
  let written = 0;
  for (const k of Object.values(model.kinds)) {
    if (!k.fit) continue;
    const key = `${k.attempts}:${k.passes}:${k.fit.samples}`;
    if (last.get(k.kind) === key) continue;
    await appendPlannerEvent(ledger, "capability/fitted", {
      kind: k.kind,
      key,
      attempts: k.attempts,
      passes: k.passes,
      fit: k.fit,
      atDifficulty: k.atDifficulty,
      ...(k.horizon80Lines !== undefined ? { horizon80Lines: k.horizon80Lines } : {}),
      ...(k.horizonInterval ? { horizonInterval: k.horizonInterval } : {}),
    });
    written += 1;
  }
  return written;
}
