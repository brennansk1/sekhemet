import {
  type SimConfig,
  type SimDay,
  type SimMetricName,
  type SwapPolicyParams,
  simMetric,
  simulateDay,
} from "@sekhemet/models";
import { binomialTailAtLeast } from "./stats.js";

/**
 * Measurement rule 16a's scheduling row (rule 16d, MS-NM14-1–2; models rule
 * 20j, DEC-45): a Smart Swap parameter or policy change — `SwapPolicyParams`
 * and its D values, the policy, a load mode — is adopted only from a
 * **paired closed-loop replay** of the change against the current
 * parameters across **k ≥ 5 distinct recorded days**, on one metric and
 * direction registered before the replay, paired by day and seed: a
 * one-sided exact sign test on the per-day differences at 0.05, a tied day
 * counted as not improved (with five days, every day must improve) — plus
 * **proof that the cards' outputs are unchanged**. A change to what a
 * request sends is a harness change, admitted by rule 16c, never here.
 */

export const MIN_REPLAY_DAYS = 5;
export const SCHEDULING_ALPHA = 0.05;

/** Written into the A/B's record before the replay (rule 16d). */
export interface SchedulingRegistration {
  metric: SimMetricName;
  direction: "lower" | "higher";
  /** The recorded calendar days (YYYY-MM-DD) the replay will use. */
  days: string[];
  registeredAt: number;
}

/** One replayed day: the registered metric under the current parameters and under the change. */
export interface PairedDayResult {
  day: string;
  seed: number;
  baseline: number;
  candidate: number;
}

/** The proof the change alters only when requests are served (MS-M9-1's check). */
export interface OutputProof {
  /** The same card from the same `RunProfile` sends a byte-identical first request with and without it. */
  firstRequestIdentical: boolean;
  /** What the change touches that could change an output. */
  changes: { sampling: boolean; context: boolean; prompt: boolean; combination: boolean };
}

export interface SchedulingChange {
  registration?: SchedulingRegistration;
  replayStartedAt: number;
  results: PairedDayResult[];
  outputs?: OutputProof;
  /** It restores a card's live KV slot mid-attempt (models rule 20i). */
  restoresLiveSlot?: boolean;
  /** The slot-restore equivalence check passed on a calibration night. */
  equivalenceCheckPassed?: boolean;
  /** It changes what a request sends: a harness change (MS-NM14-2). */
  altersRequestContent?: boolean;
}

export interface SchedulingVerdict {
  admitted: boolean;
  improvedDays: number;
  distinctDays: number;
  pValue: number;
  refusals: string[];
}

/** Admit or refuse a scheduling change, naming everything missing (MS-NM14-1, -2). */
export function admitSchedulingChange(c: SchedulingChange): SchedulingVerdict {
  if (c.altersRequestContent)
    return {
      admitted: false,
      improvedDays: 0,
      distinctDays: 0,
      pValue: 1,
      refusals: [
        "The change alters what a request sends, so it is a harness change: its route is rule 16c (the frozen suite), not the scheduling row.",
      ],
    };
  const refusals: string[] = [];
  const reg = c.registration;
  if (!reg) refusals.push("No metric, direction and days were registered before the replay.");
  else if (reg.registeredAt >= c.replayStartedAt)
    refusals.push(
      "The metric, direction and days were registered after the replay started; they must be registered before the replay.",
    );
  // Per distinct day, the mean difference over its seeds: a day replayed with k seeds counts once.
  const byDay = new Map<string, { baseline: number; candidate: number; n: number }>();
  for (const r of c.results) {
    const d = byDay.get(r.day) ?? { baseline: 0, candidate: 0, n: 0 };
    d.baseline += r.baseline;
    d.candidate += r.candidate;
    d.n++;
    byDay.set(r.day, d);
  }
  const distinctDays = byDay.size;
  if (reg) {
    const registered = new Set(reg.days);
    const replayed = [...byDay.keys()];
    if (replayed.some((d) => !registered.has(d)) || reg.days.some((d) => !byDay.has(d)))
      refusals.push("The replayed days are not the registered days.");
  }
  if (distinctDays < MIN_REPLAY_DAYS)
    refusals.push(
      `Only ${distinctDays} distinct recorded day${distinctDays === 1 ? "" : "s"}; the scheduling row needs at least ${MIN_REPLAY_DAYS} (one day replayed with several seeds counts once).`,
    );
  const direction = reg?.direction ?? "lower";
  let improvedDays = 0;
  for (const d of byDay.values()) {
    const base = d.baseline / d.n;
    const cand = d.candidate / d.n;
    // A tie is not an improvement.
    if (direction === "lower" ? cand < base : cand > base) improvedDays++;
  }
  const pValue = distinctDays === 0 ? 1 : binomialTailAtLeast(improvedDays, distinctDays);
  if (pValue > SCHEDULING_ALPHA)
    refusals.push(
      `The one-sided sign test does not reject "no gain": ${improvedDays} of ${distinctDays} days improved (p = ${pValue.toFixed(3)} > ${SCHEDULING_ALPHA}); a tied day counts as not improved.`,
    );
  if (!c.outputs) refusals.push("There is no proof that the cards' outputs are unchanged.");
  else {
    if (!c.outputs.firstRequestIdentical)
      refusals.push(
        "A card's first request differs with the change: its outputs are not shown unchanged.",
      );
    const touched = Object.entries(c.outputs.changes)
      .filter(([, on]) => on)
      .map(([k]) => k);
    if (touched.length)
      refusals.push(`The change touches ${touched.join(", ")}, which can change a card's output.`);
  }
  if (c.restoresLiveSlot && !c.equivalenceCheckPassed)
    refusals.push(
      "It restores a card's live KV slot mid-attempt, and no equivalence check has passed on a calibration night.",
    );
  return { admitted: refusals.length === 0, improvedDays, distinctDays, pValue, refusals };
}

/**
 * The paired replay (models rule 20j): each recorded day under the current
 * parameters and under the change, with the same seed, read on the
 * registered metric.
 */
export function replayPairedDays(input: {
  days: readonly SimDay[];
  seed: number;
  config: Omit<SimConfig, "params" | "seed">;
  baseline: SwapPolicyParams;
  candidate: SwapPolicyParams;
  metric: SimMetricName;
}): PairedDayResult[] {
  return input.days.map((day) => {
    const run = (params: SwapPolicyParams) =>
      simMetric(
        simulateDay(day, { ...input.config, params, seed: input.seed }).metrics,
        input.metric,
      );
    return {
      day: day.day,
      seed: input.seed,
      baseline: run(input.baseline),
      candidate: run(input.candidate),
    };
  });
}
