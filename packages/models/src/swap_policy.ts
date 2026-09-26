/**
 * Smart Swap's policy parameters and cost model (models rules 20d and 20e,
 * NEW-models-14, DEC-45).
 *
 * Every threshold the policy uses derives from measured cost, so moving the
 * weights to faster storage re-tunes it without a code change:
 *
 * - **C_pair(r)** (`cPair`, MD-N14-7): the round trip serving role r costs the
 *   resident role — both unloads and both loads, the first-token excess after
 *   each load, each live session's min(restore, re-prefill), and the idle
 *   slot-seconds the drain barrier leaves × N.
 * - **W(r)** (`serviceMs`, `workOf`, MD-N14-11): r's queued work, prefill and
 *   decode at the measured speeds of its engine, else decode estimated as the
 *   engine's efficiency × bandwidth ÷ active bytes per token.
 * - **θ** (`theta`, MD-N14-12): swap time ÷ wall time over the rolling hour.
 * - **The aging caps** (`capMs`, `capReport`, MD-N14-19–20): one mechanism for
 *   every class, stretched by θ ÷ θ_max past θ_max (never the interactive
 *   cap), and flagged infeasible below C_pair.
 *
 * `SwapPolicyParams` is the one recorded object: its version and every D
 * value travel in each evidence bundle and `RunProfile` (MD-N14-40). Pure:
 * no clock, no disk.
 */

import { MODEL_ROLES, type ModelRole } from "./types.js";

export const SWAP_POLICY_VERSION = "smart-swap/1" as const;

/**
 * A request's class, which sets its aging cap (rule 20e, C4): a person
 * waiting (`interactive`), or the model role whose work it is.
 */
export type RequestClass = "interactive" | ModelRole;

export const REQUEST_CLASSES: readonly RequestClass[] = ["interactive", ...MODEL_ROLES];

/** Every parameter of the policy; **D** values change only by measurement rule 16a's replay admission. */
export interface SwapPolicyParams {
  version: typeof SWAP_POLICY_VERSION;
  /** The swap-overhead ratio the policy holds to (D, 0.2). */
  thetaMax: number;
  /** The rolling window θ, C5 and C7 are measured over (one hour). */
  windowMs: number;
  /** The aging cap per class (C4; D, except the Worker's, which is runtime's `max_wait_s`). */
  capsMs: Record<RequestClass, number>;
  /** A tour serves every queue past this share of its cap (C2; D, 0.5). */
  tourFraction: number;
  /** The horizon optimiser's visits (C2; D, 4, at most 4! orders). */
  horizon: number;
  /** A dashboard session this recent makes a person present (C6; D, 10 minutes). */
  presenceWindowMs: number;
  /** Prefetch only from free memory minus this (C10; D, 2 GB). */
  prefetchMarginBytes: number;
  /** Step boundaries W(r) must stay over the threshold (C1 hysteresis). */
  hysteresisBoundaries: number;
  /** Decode efficiency per engine until calibrated on the host (rule 20d). */
  engineEfficiency: Record<string, number>;
}

const MIN = 60_000;

export const DEFAULT_SWAP_POLICY: Readonly<SwapPolicyParams> = Object.freeze({
  version: SWAP_POLICY_VERSION,
  thetaMax: 0.2,
  windowMs: 60 * MIN,
  capsMs: Object.freeze({
    interactive: 2 * MIN,
    planner: 30 * MIN,
    reviewer: 45 * MIN,
    researcher: 60 * MIN,
    // runtime.md `[scheduler] max_wait_s`, default 600.
    worker: 600_000,
  }),
  tourFraction: 0.5,
  horizon: 4,
  presenceWindowMs: 10 * MIN,
  prefetchMarginBytes: 2 * 1024 ** 3,
  hysteresisBoundaries: 2,
  engineEfficiency: Object.freeze({ "llama.cpp": 0.6, mlx: 0.85 }),
}) as Readonly<SwapPolicyParams>;

/**
 * The policy's parameters: the defaults, with the Worker's cap from runtime's
 * `max_wait_s` (one aging mechanism, RUN-34) and any admitted overrides.
 */
export function swapPolicyParams(
  overrides: { maxWaitS?: number } & Partial<Omit<SwapPolicyParams, "version">> = {},
): SwapPolicyParams {
  const { maxWaitS, ...rest } = overrides;
  const base = DEFAULT_SWAP_POLICY;
  return {
    ...base,
    ...rest,
    version: SWAP_POLICY_VERSION,
    capsMs: {
      ...base.capsMs,
      ...rest.capsMs,
      ...(maxWaitS !== undefined ? { worker: maxWaitS * 1000 } : {}),
    },
    engineEfficiency: { ...base.engineEfficiency, ...rest.engineEfficiency },
  };
}

// --- C_pair (MD-N14-7) -------------------------------------------------------

/** A load's or an unload's predicted time: the median for waits, the p90 for decisions (MD-N14-8). */
export interface LoadCost {
  median: number;
  p90: number;
}

/** One live session (Seshat's thread, a card mid-attempt, a slot): its K and R. */
export interface SessionCost {
  /** K: restoring its saved slot. */
  restoreMs: number;
  /** R: re-prefilling its prompt at the measured prefill speed. */
  reprefillMs: number;
}

/** What one side of a swap costs. */
export interface SwapSideCosts {
  load?: LoadCost;
  unload?: LoadCost;
  /** The median first token after a load less the median warm first token. */
  firstTokenExcessMs?: number;
  sessions?: readonly SessionCost[];
}

const sessionsMs = (s: SwapSideCosts | undefined): number =>
  (s?.sessions ?? []).reduce((n, x) => n + Math.min(x.restoreMs, x.reprefillMs), 0);

/**
 * C_pair(r): the round trip serving r costs the resident, in both directions
 * (rule 20d). Each load and unload at its p90 (the median with `basis:
 * "median"`, for a predicted wait), the first-token excess after each of the
 * two loads, min(K, R) for every live session on either side, and the idle
 * slot-seconds the drain barrier leaves × N. Undefined when a load's cost is
 * unknown; with nothing resident it is r's visit alone.
 */
export function cPair(
  resident: SwapSideCosts | undefined,
  r: SwapSideCosts,
  opts: { slots?: number; idleSlotMs?: number; basis?: "p90" | "median" } = {},
): number | undefined {
  const pick = (c: LoadCost | undefined) =>
    c === undefined ? 0 : opts.basis === "median" ? c.median : c.p90;
  if (!r.load || (resident && !resident.load)) return undefined;
  const visit = pick(r.load) + pick(r.unload) + (r.firstTokenExcessMs ?? 0) + sessionsMs(r);
  const home = resident
    ? pick(resident.unload) +
      pick(resident.load) +
      (resident.firstTokenExcessMs ?? 0) +
      sessionsMs(resident)
    : 0;
  const idle = (opts.idleSlotMs ?? 0) * (opts.slots ?? 1);
  return visit + home + idle;
}

// --- W (MD-N14-11) -----------------------------------------------------------

/** What an engine serving some weights is measured (or estimated) to do. */
export interface EngineSpeed {
  /** `llama.cpp` or `mlx`; picks the efficiency until calibrated. */
  engine: string;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  /** The host's memory bandwidth. */
  bandwidthBytesPerSecond?: number;
  /** Bytes read per decoded token: the active bytes, for a mixture of experts. */
  activeBytesPerToken?: number;
}

/**
 * Decode speed: measured, else efficiency × bandwidth ÷ bytes read per token
 * (llama.cpp 0.6, MLX 0.85 until calibrated; this replaces MD-N13-3's 0.8).
 */
export function decodeTokensPerSecond(
  speed: EngineSpeed,
  params: Pick<SwapPolicyParams, "engineEfficiency"> = DEFAULT_SWAP_POLICY,
): number | undefined {
  if (speed.decodeTokensPerSecond !== undefined) return speed.decodeTokensPerSecond;
  const efficiency = params.engineEfficiency[speed.engine];
  if (
    efficiency === undefined ||
    speed.bandwidthBytesPerSecond === undefined ||
    !speed.activeBytesPerToken
  )
    return undefined;
  return (efficiency * speed.bandwidthBytesPerSecond) / speed.activeBytesPerToken;
}

/**
 * One request's predicted service time: its prefill tokens at the prefill
 * speed plus its decode tokens at the decode speed. A speed that is unknown
 * adds nothing, so W errs low and the policy toward fewer swaps.
 */
export function serviceMs(
  req: { prefillTokens: number; decodeTokens: number },
  speed: EngineSpeed,
  params: Pick<SwapPolicyParams, "engineEfficiency"> = DEFAULT_SWAP_POLICY,
): number {
  const decode = decodeTokensPerSecond(speed, params);
  const prefill = speed.prefillTokensPerSecond;
  return Math.round(
    (prefill ? (req.prefillTokens / prefill) * 1000 : 0) +
      (decode ? (req.decodeTokens / decode) * 1000 : 0),
  );
}

/**
 * W: the predicted service of every request queued on some weights, whatever
 * queue it is in — so an escalated retry, which runs on the Planner's
 * weights, counts in the Planner's W.
 */
export function workOf(
  queues: readonly { weights: string; requests: readonly { serviceMs: number }[] }[],
  weights: string,
): number {
  return queues
    .filter((q) => q.weights === weights)
    .reduce((n, q) => n + q.requests.reduce((m, r) => m + r.serviceMs, 0), 0);
}

// --- θ (MD-N14-12) -----------------------------------------------------------

/** The θ record (MD-N14-12, -40a): θ over the rolling hour, with the policy's parameters. */
export const SWAP_OVERHEAD_EVENT = "model/swap_overhead";

export interface SwapOverheadPayload {
  theta: number;
  windowMs: number;
  /** Milliseconds of swapping inside the window. */
  swapMs: number;
  /** Swaps inside the window. */
  swaps: number;
  /** θ is past θ_max: the placement notice is raised (rule 20k). */
  placementNotice: boolean;
  policyVersion: string;
  /** Every parameter, flattened (`flattenSwapPolicy`). */
  params: Record<string, number>;
}

/**
 * The policy's parameters as one flat record of numbers, the form the ledger
 * keeps them in (`model/swap_overhead`, `measure/calibration`):
 * `capsMs.reviewer`, `engineEfficiency.mlx`, ...
 */
export function flattenSwapPolicy(p: SwapPolicyParams): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === "number") out[k] = v;
    else if (v && typeof v === "object")
      for (const [k2, v2] of Object.entries(v as Record<string, number>)) out[`${k}.${k2}`] = v2;
  }
  return out;
}

/** θ: the time spent swapping inside the rolling window ÷ the window. */
export function theta(
  swaps: readonly { at: number; ms: number }[],
  now: number,
  windowMs: number = DEFAULT_SWAP_POLICY.windowMs,
): number {
  const from = now - windowMs;
  let busy = 0;
  for (const s of swaps) {
    const a = Math.max(from, s.at);
    const b = Math.min(now, s.at + s.ms);
    if (b > a) busy += b - a;
  }
  return busy / windowMs;
}

// --- C4: the aging caps (MD-N14-19, -20) --------------------------------------

/**
 * A class's aging cap now: its base cap, stretched by θ ÷ θ_max while θ is
 * past θ_max — never the interactive cap, which a person waits on.
 */
export function capMs(cls: RequestClass, params: SwapPolicyParams, thetaNow: number): number {
  const base = params.capsMs[cls];
  if (cls === "interactive" || thetaNow <= params.thetaMax) return base;
  return Math.round(base * (thetaNow / params.thetaMax));
}

export interface CapStatus {
  cls: RequestClass;
  capMs: number;
  /** A cap below C_pair cannot be met (MD-N14-20). */
  feasible: boolean;
  /** What a person is shown instead of an infeasible cap: the round trip. */
  predictedWaitMs?: number;
}

/**
 * The caps as the model page shows them: each class's cap now, flagged
 * infeasible when it is below the C_pair its requests would cost, with the
 * predicted wait instead; and the placement notice (rule 20k) while θ is
 * past θ_max.
 */
export function capReport(
  params: SwapPolicyParams,
  thetaNow: number,
  cPairByClass: Partial<Record<RequestClass, number>>,
): { caps: CapStatus[]; theta: number; placementNotice: boolean } {
  const caps = REQUEST_CLASSES.map((cls): CapStatus => {
    const cap = capMs(cls, params, thetaNow);
    const pair = cPairByClass[cls];
    const feasible = pair === undefined || cap >= pair;
    return { cls, capMs: cap, feasible, ...(feasible ? {} : { predictedWaitMs: pair }) };
  });
  return { caps, theta: thetaNow, placementNotice: thetaNow > params.thetaMax };
}
