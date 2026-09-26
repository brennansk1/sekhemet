import {
  type CapStatus,
  type RequestClass,
  type SwapPolicyParams,
  type SwapSideCosts,
  cPair,
  capMs,
  capReport,
  theta,
} from "./swap_policy.js";
import type { WatchdogLevel } from "./watchdog.js";

/**
 * Smart Swap's policy: one pure function, `decide(snapshot, now) → action`
 * (models rule 20e, NEW-models-14, MD-N14-13–26).
 *
 * It is called at every step boundary, by the live residency scheduler and by
 * the replay simulator alike. It reads nothing outside the snapshot and writes
 * nothing: the caller applies the action. It is the only code that chooses
 * which weights to load or evict (`planLoad` is its eviction choice, shared
 * with an explicit acquire); the watchdog may also evict.
 *
 * **Precedence**, highest first — when two rules disagree the higher one
 * decides, and every request a decision delays carries its predicted start
 * (the median):
 * 1. the watchdog, at every level (emergency unloads everything but a
 *    person's hold and a running step — an escalated attempt's hold is a pin
 *    only the policy respects; critical starts no load; elevated ends a
 *    visitor's dwell and idle hold and stops prefetch);
 * 2. holds (a held or pinned model is never evicted);
 * 3. C5, the Worker's floor of (1 − θ_max) of each rolling hour while its
 *    queue is non-empty;
 * 4. interactive requests — served first within a resident visit; a swap for
 *    one that would break C5 gives the person rule 20f's quick path instead;
 * 5. C7, the storm cap, counting non-interactive round trips;
 * 6. C4, the aging caps (and C6's overnight review batch);
 * 7. C3, the visitor's minimum dwell and idle hold (C_pair each);
 * 8. C1, exhaustive service with a threshold and hysteresis.
 *
 * C2's tours are built whenever a swap starts a new absence; C8's drain
 * barrier is the action's `barrier`; C9's overlap is the scheduler's; C10's
 * prefetch is an action. A benchmark block bypasses C1–C10 (rule 20b).
 */

/** One queued request, as the policy sees it. */
export interface SwapRequest {
  id: string;
  cls: RequestClass;
  /** When it was queued (ms). */
  queuedAt: number;
  /** Its predicted service time (the median; its share of W). */
  serviceMs: number;
  /** A review of a finished card (C6). */
  review?: boolean;
}

/** A queue: requests one weights serve. */
export interface SwapQueueState {
  queue: string;
  weights: string;
  requests: SwapRequest[];
}

/** One set of weights: its costs (rule 20d) and its state now. */
export interface SwapWeightsState extends SwapSideCosts {
  /** The weights file's bytes (C10's prefetch). */
  fileBytes?: number;
  /** Resident since (ms); absent when not resident. */
  residentSince?: number;
  /** A load of these weights is in flight. */
  loading?: boolean;
  /** When it last served a request (ms). */
  lastServedAt?: number;
  /** A hold pins it (a card's run, Seshat's answer). */
  held?: boolean;
  /**
   * Every hold on it is a pin only the policy respects (an escalated card's
   * attempt): the watchdog's emergency unloads it between steps (rule 19).
   */
  holdYieldsToWatchdog?: boolean;
  /** A pinned queue shares it. */
  pinned?: boolean;
  /** Already warmed into the page cache (C10). */
  prefetched?: boolean;
  /** Steps running on it now (RUN-35 slots): a swap away waits at the drain barrier (C8). */
  runningSteps?: number;
}

/** One swap in the rolling hour. */
export interface SwapHistoryEntry {
  /** When it started (ms). */
  at: number;
  /** Unload plus load (ms). */
  ms: number;
  to: string;
  from?: string;
  /** For a person waiting: not counted by C7. */
  interactive: boolean;
  /** The swap away that starts a visit (C7 counts it once). */
  roundTrip: boolean;
}

export type SwapMemoryVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Memory as the policy reads it, taken before `decide` from the headroom
 * probe (rule 20g): pure over one reading.
 */
export interface SwapMemory {
  /** Free memory now (C10). */
  freeBytes?: number;
  /** Whether loading `load` after evicting `evict` from `resident` is admitted (MD-N14-31). */
  admit(step: {
    load: string;
    evict: readonly string[];
    resident: readonly string[];
  }): SwapMemoryVerdict;
  /**
   * Cumulative feasibility of a tour's transitions (MD-N14-31a) beyond each
   * step's admission — KV a slot save still holds, say. Absent: each step's
   * admission against what is resident at that moment decides.
   */
  tour?(
    steps: readonly { load: string; evict: readonly string[] }[],
    resident: readonly string[],
  ): SwapMemoryVerdict;
}

export interface SwapPresence {
  /** Inside `reserved_hours`, during a reserve-now, or a dashboard session in the last 10 minutes. */
  present: boolean;
  /** When the next reserved hours start (ms), in the overnight window. */
  reservedStartsAt?: number;
}

/** Everything `decide` reads (rule 20e). */
export interface SwapSnapshot {
  params: SwapPolicyParams;
  /** The Worker's weights: the home every absence returns to (C5). */
  home?: string;
  /** The Worker has work (queued steps, a card in progress); default: its queues are non-empty. */
  homeBacklog?: boolean;
  weights: Record<string, SwapWeightsState>;
  queues: SwapQueueState[];
  watchdog: WatchdogLevel;
  presence: SwapPresence;
  /** Weights in the order of their next use in the plan (C2, Belady). */
  plan?: string[];
  /** Swaps in the rolling hour (θ, C7). */
  swaps: SwapHistoryEntry[];
  /** When the Worker was away while it had work (C5); an open interval is the current absence. */
  homeAbsences: { from: number; to?: number }[];
  /** The weights over C1's threshold at the previous boundary (the memo). */
  overThreshold?: string[];
  /** The rest of the tour under way (C2). */
  tour?: string[];
  /** The Worker's N parallel slots and the idle each swap leaves per slot (C8). */
  slots?: { n: number; idleMsPerSlot: number };
  memory: SwapMemory;
  /** An overnight benchmark block: one swap at its start, C1–C10 bypassed (rule 20b). */
  benchmark?: { weights: string };
}

export type SwapRule =
  | "watchdog"
  | "loading"
  | "benchmark"
  | "hold"
  | "memory"
  | "C5"
  | "interactive"
  | "C7"
  | "C6"
  | "C4"
  | "C3"
  | "C2"
  | "C1"
  | "C10"
  | "idle";

interface SwapActionBase {
  rule: SwapRule;
  reason: string;
  /** The predicted start (the median) of every queued request, by id. */
  starts: Record<string, number>;
  /** Interactive requests whose full answer would break C5: answer by rule 20f. */
  quickPath: string[];
  /** Loads refused for memory, each with why; their work stays queued. */
  refused: { weights: string; reason: string }[];
  /** Carried to the next boundary's snapshot. */
  memo: { overThreshold: string[] };
}

export type SwapAction = SwapActionBase &
  (
    | {
        kind: "keep";
        /** The queue to serve next, if any. */
        serve?: string;
        /** Look again at this time even if nothing happens (a hold's end). */
        until?: number;
        /** Warm these weights meanwhile (C10). */
        prefetch?: string;
      }
    | {
        kind: "swap";
        load: string;
        evict: string[];
        /** The visits of this absence in order, `load` first (C2). */
        tour: string[];
        /** A new visit, counted once by C7 (unless interactive). */
        roundTrip: boolean;
        interactive: boolean;
        /** Steps run on evicted weights: admit no new step, swap once they end (C8). */
        barrier: boolean;
      }
    | { kind: "unload"; weights: string[] }
    | { kind: "prefetch"; weights: string }
    | { kind: "wait"; until?: number }
  );

const LEVEL: Readonly<Record<WatchdogLevel, number>> = {
  normal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
  emergency: 4,
};

const CLASS_RANK: Readonly<Record<RequestClass, number>> = {
  interactive: 0,
  planner: 1,
  reviewer: 2,
  researcher: 3,
  worker: 4,
};

// --- The context: what every rule reads, derived once ------------------------

interface Ctx {
  s: SwapSnapshot;
  now: number;
  P: SwapPolicyParams;
  th: number;
  names: string[];
  resident: string[];
  loading: string[];
  /** Requests by weights, oldest first. */
  work: Map<string, SwapRequest[]>;
  queueOf: Map<string, string>;
  home: string | undefined;
  homeBacklog: boolean;
}

function context(s: SwapSnapshot, now: number): Ctx {
  const names = [...new Set([...Object.keys(s.weights), ...s.queues.map((q) => q.weights)])];
  const work = new Map<string, SwapRequest[]>();
  const queueOf = new Map<string, string>();
  for (const q of s.queues) {
    const list = work.get(q.weights) ?? [];
    for (const r of q.requests) {
      list.push(r);
      queueOf.set(r.id, q.queue);
    }
    work.set(q.weights, list);
  }
  for (const [k, list] of work) {
    work.set(
      k,
      [...list].sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  }
  const st = (w: string) => s.weights[w] ?? {};
  const resident = names.filter((w) => st(w).residentSince !== undefined && !st(w).loading);
  const loading = names.filter((w) => st(w).loading === true);
  const home = s.home;
  const homeBacklog =
    home === undefined
      ? false
      : (s.homeBacklog ?? ((work.get(home)?.length ?? 0) > 0 || (st(home).runningSteps ?? 0) > 0));
  return {
    s,
    now,
    P: s.params,
    th: theta(s.swaps, now, s.params.windowMs),
    names,
    resident,
    loading,
    work,
    queueOf,
    home,
    homeBacklog,
  };
}

const st = (c: Ctx, w: string): SwapWeightsState => c.s.weights[w] ?? {};
const reqs = (c: Ctx, w: string): SwapRequest[] => c.work.get(w) ?? [];
const hasWork = (c: Ctx, w: string) => reqs(c, w).length > 0;
const isResident = (c: Ctx, w: string) => c.resident.includes(w);
const isHeld = (c: Ctx, w: string) => st(c, w).held === true || st(c, w).pinned === true;
const W = (c: Ctx, w: string) => reqs(c, w).reduce((n, r) => n + r.serviceMs, 0);
const planIndex = (c: Ctx, w: string) => {
  const i = c.s.plan?.indexOf(w) ?? -1;
  return i === -1 ? Number.POSITIVE_INFINITY : i;
};

/** C_pair of a visit to `target`, against the home (or the resident it would evict). */
function pairFor(c: Ctx, target: string, basis: "p90" | "median" = "p90"): number | undefined {
  const other =
    target === c.home
      ? c.resident.find((r) => r !== c.home)
      : (c.home ?? c.resident.find((r) => r !== target));
  const involvesHome = c.home !== undefined && (other === c.home || target === c.home);
  const slots = involvesHome && c.s.slots ? c.s.slots : undefined;
  return cPair(other !== undefined ? st(c, other) : undefined, st(c, target), {
    basis,
    ...(slots ? { slots: slots.n, idleSlotMs: slots.idleMsPerSlot } : {}),
  });
}

const capOf = (c: Ctx, r: SwapRequest) => capMs(r.cls, c.P, c.th);
const night = (c: Ctx) => !c.s.presence.present && c.s.presence.reservedStartsAt !== undefined;

/** At its cap (C4). An overnight review is batched instead (C6). */
function isAged(c: Ctx, r: SwapRequest): boolean {
  if (r.review && night(c)) return false;
  return c.now - r.queuedAt >= capOf(c, r);
}

/** A request at a cap it can meet: a cap below C_pair is infeasible (MD-N14-20). */
function agedFeasible(c: Ctx, w: string): boolean {
  const pair = pairFor(c, w);
  return reqs(c, w).some((r) => isAged(c, r) && (pair === undefined || capOf(c, r) >= pair));
}

/** Past C2's share of its cap: joins the next tour. */
const pastTour = (c: Ctx, w: string) =>
  reqs(c, w).some((r) => c.now - r.queuedAt >= c.P.tourFraction * capOf(c, r));

/**
 * Overnight reviews are due (C6) once the latest start whose median end
 * comes before the reserved hours is within one C_pair.
 */
function reviewDue(c: Ctx, w: string): boolean {
  if (!night(c) || !reqs(c, w).some((r) => r.review)) return false;
  const median = pairFor(c, w, "median") ?? 0;
  const p90 = pairFor(c, w) ?? 0;
  const latest = (c.s.presence.reservedStartsAt as number) - (median + W(c, w));
  return c.now >= latest - p90;
}

/** Preference among weights to visit: C6's reviews while present, the plan, then the oldest request. */
function targetKey(c: Ctx, w: string): number[] {
  const review = c.s.presence.present && reqs(c, w).some((r) => r.review) ? 0 : 1;
  return [review, planIndex(c, w), reqs(c, w)[0]?.queuedAt ?? Number.POSITIVE_INFINITY];
}

/** C2's class order: the shared weights, the Reviewer, the Researcher; reviews first while present. */
function classKey(c: Ctx, w: string): number {
  const list = reqs(c, w);
  if (list.some((r) => r.cls === "interactive")) return 0;
  if (c.s.presence.present && list.some((r) => r.review)) return 0.5;
  return Math.min(9, ...list.map((r) => CLASS_RANK[r.cls]));
}

const compareKeys = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  return 0;
};

const byKey = <T>(list: readonly T[], key: (x: T) => number[]) =>
  [...list].sort((a, b) => compareKeys(key(a), key(b)));

/** The order a resident weights serves its requests: interactive, aged, reviews while present, oldest. */
function serveOrder(c: Ctx, w: string): SwapRequest[] {
  return byKey(reqs(c, w), (r) => [
    r.cls === "interactive" ? 0 : 1,
    isAged(c, r) ? 0 : 1,
    c.s.presence.present && r.review ? 0 : 1,
    r.queuedAt,
  ]);
}

// --- Memory and eviction (C2's Belady, MD-N14-17, -31) ----------------------

type LoadPlan = { ok: true; evict: string[] } | { ok: false; hold: boolean; reason: string };

/**
 * Evictions in Belady order: the weights whose next use in the plan is
 * farthest first (weights with queued work are used next), the least
 * recently used only among ties and when there is no plan.
 */
function beladyOrder(c: Ctx, list: readonly string[]): string[] {
  const next = (w: string) => (hasWork(c, w) ? -1 : planIndex(c, w));
  const used = (w: string) => st(c, w).lastServedAt ?? st(c, w).residentSince ?? 0;
  return [...list].sort((a, b) => {
    const na = next(a);
    const nb = next(b);
    if (na !== nb) return na > nb ? -1 : 1;
    const d = used(a) - used(b);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * How `target` would be loaded beside `resident`: the fewest evictions, in
 * Belady order, that memory admits. Never a held, pinned or loading model;
 * a load that would fit only by evicting one is blocked by the hold.
 */
export function planLoad(
  s: SwapSnapshot,
  target: string,
  now: number,
  resident?: readonly string[],
): LoadPlan {
  return planIn(context(s, now), target, resident);
}

function planIn(c: Ctx, target: string, resident?: readonly string[]): LoadPlan {
  const all = [...(resident ?? [...c.resident, ...c.loading])];
  const loading = (w: string) => c.loading.includes(w);
  const candidates = beladyOrder(
    c,
    all.filter((w) => w !== target && !isHeld(c, w) && !loading(w)),
  );
  let reason = "";
  for (let k = 0; k <= candidates.length; k++) {
    const evict = candidates.slice(0, k);
    const v = c.s.memory.admit({ load: target, evict, resident: all });
    if (v.ok) return { ok: true, evict };
    reason = v.reason;
  }
  // Would it fit once the holds end? Then the hold, not memory, stops it.
  const pinned = all.filter((w) => w !== target && isHeld(c, w) && !loading(w));
  const hold =
    pinned.length > 0 &&
    c.s.memory.admit({ load: target, evict: [...candidates, ...pinned], resident: all }).ok;
  return { ok: false, hold, reason };
}

// --- Layout: visits in order, with each request's start ---------------------

interface Layout {
  starts: Map<string, number>;
  end: number;
  resident: string[];
  memoryOk: boolean;
  steps: { load: string; evict: string[] }[];
}

/**
 * Lay out visits from the resident set at `at`: each transition (its
 * evictions' unloads, the load, the first-token excess) then each request in
 * serve order. Waits use the median; decisions the p90 (MD-N14-8).
 */
function layout(
  c: Ctx,
  visits: readonly string[],
  basis: "p90" | "median",
  opts: {
    at?: number;
    resident?: readonly string[];
    blocked?: ReadonlyMap<string, number>;
    ignoreHolds?: boolean;
  } = {},
): Layout {
  const pick = (x: { median: number; p90: number } | undefined) =>
    x === undefined ? 0 : basis === "median" ? x.median : x.p90;
  let t = opts.at ?? c.now;
  let cur = [...(opts.resident ?? c.resident)];
  const starts = new Map<string, number>();
  const steps: { load: string; evict: string[] }[] = [];
  let memoryOk = true;
  for (const w of visits) {
    if (!cur.includes(w)) {
      const plan = planIn(c, w, cur);
      let evict: string[];
      if (plan.ok) evict = plan.evict;
      else {
        memoryOk = false;
        evict = cur.filter((x) => x !== w && (opts.ignoreHolds || !isHeld(c, x)));
      }
      t = Math.max(t, opts.blocked?.get(w) ?? t);
      t +=
        evict.reduce((n, e) => n + pick(st(c, e).unload), 0) +
        pick(st(c, w).load) +
        (st(c, w).firstTokenExcessMs ?? 0);
      steps.push({ load: w, evict });
      cur = [...cur.filter((x) => !evict.includes(x)), w];
    }
    for (const r of serveOrder(c, w)) {
      if (!starts.has(r.id)) starts.set(r.id, t);
      t += r.serviceMs;
    }
  }
  return { starts, end: t, resident: cur, memoryOk, steps };
}

/** The time to go home from `resident` (p90), 0 with no home or already home. */
function returnMs(c: Ctx, resident: readonly string[], basis: "p90" | "median" = "p90"): number {
  if (c.home === undefined || resident.includes(c.home)) return 0;
  const l = layout(c, [c.home], basis, { resident, at: 0 });
  // The home's own requests are not part of the return.
  return l.end - W(c, c.home);
}

/** How long a tour keeps the Worker away: its visits, then the return. */
function absenceOf(c: Ctx, tour: readonly string[]): number {
  const l = layout(c, tour, "p90");
  return l.end - c.now + returnMs(c, l.resident);
}

// --- C5: the Worker's floor --------------------------------------------------

const budget = (c: Ctx) => c.P.thetaMax * c.P.windowMs;

function absentOverlap(c: Ctx, from: number, to: number): number {
  let n = 0;
  for (const a of c.s.homeAbsences) {
    const x = Math.max(from, a.from);
    const y = Math.min(to, a.to ?? c.now);
    if (y > x) n += y - x;
  }
  return n;
}

const c5Applies = (c: Ctx) => c.home !== undefined && c.homeBacklog;

/** Whether keeping the Worker away `extra` more keeps every rolling hour within θ_max. */
function c5Allows(c: Ctx, extra: number): boolean {
  if (!c5Applies(c)) return true;
  return absentOverlap(c, c.now + extra - c.P.windowMs, c.now) + extra <= budget(c);
}

/** The earliest time an absence of `extra` fits C5, the Worker resident until then. */
function c5PermitAt(c: Ctx, extra: number): number {
  if (c5Allows(c, extra)) return c.now;
  if (extra > budget(c)) return c.now + c.P.windowMs;
  let lo = c.now;
  let hi = c.now + c.P.windowMs;
  const fits = (t: number) =>
    absentOverlap(c, t + extra - c.P.windowMs, c.now) + extra <= budget(c);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

// --- C7: the storm cap -------------------------------------------------------

function countedRoundTrips(c: Ctx): number[] {
  return c.s.swaps
    .filter((x) => x.roundTrip && !x.interactive && x.at > c.now - c.P.windowMs)
    .map((x) => x.at)
    .sort((a, b) => a - b);
}

/**
 * At most ⌊θ_max × window ÷ C_pair⌋ round trips in the rolling hour (C7), and
 * never fewer than one: where one round trip alone exceeds the budget (C_pair
 * over 12 minutes), one an hour still goes, so no queue starves.
 */
function stormCap(c: Ctx, target: string): number {
  const pair = pairFor(c, target);
  return pair && pair > 0
    ? Math.max(1, Math.floor((c.P.thetaMax * c.P.windowMs) / pair))
    : Number.POSITIVE_INFINITY;
}

/** When a round trip to `target` next fits the cap. */
function stormFreeAt(c: Ctx, target: string): number | undefined {
  const ats = countedRoundTrips(c);
  const cap = stormCap(c, target);
  if (ats.length < cap) return undefined;
  for (let j = 0; j < ats.length; j++) {
    if (ats.length - (j + 1) < cap) return (ats[j] as number) + c.P.windowMs;
  }
  return c.now + c.P.windowMs;
}

// --- C2: tours ---------------------------------------------------------------

function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i] as T, ...p];
  }
}

/** The weights a new absence visits: the target and every queue past half its cap. */
function tourMembers(c: Ctx, target: string, targets: readonly string[]): string[] {
  return [target, ...targets.filter((w) => w !== target && w !== c.home && pastTour(c, w))];
}

/**
 * C2's horizon optimiser: among the orders of the next H visits, the one with
 * the least predicted total time (p90) that meets every cap and whose every
 * transition memory admits (MD-N14-31a); ties go to the preferred order (the
 * trigger first, then the class order). With no order meeting every cap,
 * the preferred order stands and the waits are stated.
 */
function buildTour(c: Ctx, members: readonly string[], first?: string): string[] {
  const rest = byKey(
    members.filter((w) => w !== first),
    (w) => [classKey(c, w), ...targetKey(c, w)],
  );
  const preferred = (first !== undefined ? [first, ...rest] : rest).slice(0, c.P.horizon);
  let best: { order: string[]; total: number } | undefined;
  let fallback: string[] | undefined;
  for (const order of permutations(preferred)) {
    const l = layout(c, order, "p90");
    if (!l.memoryOk) continue;
    const back = returnMs(c, l.resident);
    if (c.s.memory.tour) {
      const steps = [...l.steps];
      if (c.home !== undefined && !l.resident.includes(c.home)) {
        const h = planIn(c, c.home, l.resident);
        steps.push({
          load: c.home,
          evict: h.ok ? h.evict : l.resident.filter((w) => w !== c.home),
        });
      }
      if (!c.s.memory.tour(steps, c.resident).ok) continue;
    }
    fallback ??= order;
    const meets = order.every((w) =>
      reqs(c, w).every((r) => {
        if (r.review && night(c)) return true;
        return (l.starts.get(r.id) ?? c.now) <= r.queuedAt + capOf(c, r);
      }),
    );
    if (!meets) continue;
    const total = l.end + back;
    if (!best || total < best.total) best = { order, total };
  }
  return best?.order ?? fallback ?? preferred.slice(0, 1);
}

// --- The action --------------------------------------------------------------

interface Notes {
  quickPath: string[];
  refused: { weights: string; reason: string }[];
  blocked: Map<string, number>;
  /** The highest-precedence rule that stopped a swap, for a wait's rule. */
  stoppedBy: SwapRule | undefined;
  stoppedWhy: string | undefined;
}

const RANK: SwapRule[] = ["watchdog", "hold", "C5", "C7", "memory", "C3"];

function stop(n: Notes, rule: SwapRule, why: string): void {
  const at = (r: SwapRule | undefined) => (r === undefined ? 99 : RANK.indexOf(r));
  if (at(rule) < at(n.stoppedBy)) {
    n.stoppedBy = rule;
    n.stoppedWhy = why;
  }
}

function blockUntil(n: Notes, w: string, t: number): void {
  n.blocked.set(w, Math.max(n.blocked.get(w) ?? t, t));
}

type Body = SwapAction extends infer A
  ? A extends SwapActionBase
    ? Omit<A, keyof SwapActionBase>
    : never
  : never;

/** Predicted starts (the median) of every queued request, under the action. */
function forecast(
  c: Ctx,
  n: Notes,
  body: Body,
  targets: readonly string[],
): Record<string, number> {
  const visits: string[] = [];
  const add = (w: string) => {
    if (!visits.includes(w)) visits.push(w);
  };
  if (body.kind === "keep" && body.serve !== undefined) {
    const first = c.s.queues.find((q) => q.queue === body.serve)?.weights;
    if (first !== undefined) add(first);
  }
  for (const w of byKey(
    c.resident.filter((x) => hasWork(c, x)),
    (x) => [classKey(c, x)],
  ))
    if (body.kind !== "swap" || !body.evict.includes(w)) add(w);
  if (body.kind === "swap") for (const w of body.tour) add(w);
  else for (const w of c.s.tour ?? []) if (hasWork(c, w)) add(w);
  if (c.home !== undefined && hasWork(c, c.home)) add(c.home);
  for (const w of byKey(targets, (x) => targetKey(c, x))) add(w);
  for (const w of c.names) if (hasWork(c, w)) add(w);
  const l = layout(c, visits, "median", { blocked: n.blocked, ignoreHolds: true });
  return Object.fromEntries(l.starts);
}

function overThreshold(c: Ctx, targets: readonly string[]): string[] {
  return targets.filter((t) => {
    const pair = pairFor(c, t);
    return pair !== undefined && pair > 0 && W(c, t) >= pair / c.P.thetaMax;
  });
}

/**
 * Smart Swap's one decision (rule 20e). Pure: the same snapshot and time
 * give the same action; it reads no clock, file, probe or randomness.
 */
export function decide(s: SwapSnapshot, now: number): SwapAction {
  const c = context(s, now);
  const n: Notes = {
    quickPath: [],
    refused: [],
    blocked: new Map(),
    stoppedBy: undefined,
    stoppedWhy: undefined,
  };
  const targets = c.names.filter(
    (w) => hasWork(c, w) && !isResident(c, w) && !c.loading.includes(w),
  );
  const over = overThreshold(c, targets);
  const finish = (body: Body, rule: SwapRule, reason: string): SwapAction =>
    ({
      ...body,
      rule,
      reason,
      starts: forecast(c, n, body, targets),
      quickPath: n.quickPath,
      refused: n.refused,
      memo: { overThreshold: over },
    }) as SwapAction;

  const level = LEVEL[s.watchdog];
  // 1. The watchdog, at every level.
  if (level >= LEVEL.emergency) {
    // Never a person's hold nor a step mid-step; an escalated attempt's hold
    // (a pin only the policy respects) yields between its steps.
    const victims = c.resident.filter(
      (w) =>
        !isHeld(c, w) ||
        (st(c, w).holdYieldsToWatchdog === true &&
          st(c, w).pinned !== true &&
          (st(c, w).runningSteps ?? 0) === 0),
    );
    if (victims.length > 0)
      return finish(
        { kind: "unload", weights: victims },
        "watchdog",
        "the watchdog is at emergency",
      );
  }
  if (c.loading.length > 0)
    return finish({ kind: "wait" }, "loading", `${c.loading.join(", ")} is loading`);
  if (s.benchmark) return benchmarkBlock(c, n, s.benchmark.weights, finish);
  const noLoads = level >= LEVEL.critical;

  /** A swap to `t` now, if memory and the holds allow it. */
  const swapTo = (
    t: string,
    rule: SwapRule,
    opts: { interactive?: boolean; continuing?: boolean; tour?: string[] } = {},
  ): SwapAction | undefined => {
    const plan = planIn(c, t);
    if (!plan.ok) {
      // Refused for memory now, whether a hold or the room stops it; the work stays queued.
      if (!n.refused.some((r) => r.weights === t))
        n.refused.push({ weights: t, reason: plan.reason });
      stop(n, plan.hold ? "hold" : "memory", plan.reason);
      return undefined;
    }
    const roundTrip = t !== c.home && opts.continuing !== true && plan.evict.length > 0;
    const tour = opts.tour ?? [t];
    return finish(
      {
        kind: "swap",
        load: t,
        evict: plan.evict,
        tour,
        roundTrip,
        interactive: opts.interactive === true,
        barrier: plan.evict.some((e) => (st(c, e).runningSteps ?? 0) > 0),
      },
      rule,
      `${rule}: load ${t}${plan.evict.length ? `, evicting ${plan.evict.join(", ")}` : ""}`,
    );
  };

  /** A non-interactive swap to `t`: C7, then the tour, then C5. */
  const visit = (t: string, rule: SwapRule, first?: string): SwapAction | undefined => {
    if (t === c.home) return swapTo(t, rule);
    const plan = planIn(c, t);
    const starts = plan.ok && plan.evict.length > 0;
    if (starts) {
      const free = stormFreeAt(c, t);
      if (free !== undefined) {
        blockUntil(n, t, free);
        stop(n, "C7", `the storm cap: ${countedRoundTrips(c).length} round trips this hour`);
        return undefined;
      }
    }
    let tour = starts ? buildTour(c, tourMembers(c, t, targets), first) : [t];
    if (c5Applies(c) && !c5Allows(c, absenceOf(c, tour))) {
      tour = [t];
      const extra = absenceOf(c, tour);
      if (!c5Allows(c, extra)) {
        blockUntil(n, t, c5PermitAt(c, extra));
        stop(n, "C5", "the Worker's floor for this hour");
        return undefined;
      }
    }
    const lead = tour[0] as string;
    return swapTo(lead, rule, { tour });
  };

  // 3. C5: the Worker away too long this hour comes home.
  if (c5Applies(c) && c.home !== undefined && !isResident(c, c.home) && !noLoads) {
    if (!c5Allows(c, returnMs(c, c.resident))) {
      for (const w of targets)
        if (w !== c.home)
          for (const r of reqs(c, w)) if (r.cls === "interactive") n.quickPath.push(r.id);
      const a = swapTo(c.home, "C5");
      if (a) return a;
    }
  }

  // 4. Interactive requests: first within a resident visit, then a swap that keeps C5.
  const residentInteractive = c.resident.filter((w) =>
    reqs(c, w).some((r) => r.cls === "interactive"),
  );
  if (residentInteractive.length > 0) {
    const w = byKey(residentInteractive, (x) => [reqs(c, x)[0]?.queuedAt ?? 0])[0] as string;
    return finish(
      { kind: "keep", serve: c.queueOf.get(serveOrder(c, w)[0]?.id ?? "") as string },
      "interactive",
      "a person is waiting on a resident model",
    );
  }
  const interactiveTargets = byKey(
    targets.filter((w) => reqs(c, w).some((r) => r.cls === "interactive")),
    (w) => [reqs(c, w).find((r) => r.cls === "interactive")?.queuedAt ?? 0],
  );
  for (const t of interactiveTargets) {
    if (noLoads) break;
    const plan = planIn(c, t);
    const starts = plan.ok && plan.evict.length > 0;
    const tour = starts ? buildTour(c, tourMembers(c, t, targets), t) : [t];
    let extra = absenceOf(c, tour);
    let chosen = tour;
    if (t !== c.home && c5Applies(c) && !c5Allows(c, extra)) {
      chosen = [t];
      extra = absenceOf(c, chosen);
      if (!c5Allows(c, extra)) {
        for (const r of reqs(c, t)) if (r.cls === "interactive") n.quickPath.push(r.id);
        blockUntil(n, t, c5PermitAt(c, extra));
        continue;
      }
    }
    const a = swapTo(chosen[0] as string, "interactive", { interactive: true, tour: chosen });
    if (a) return a;
  }

  // 6. C4 (and C6's overnight batch): a request at its cap.
  if (!noLoads) {
    const due = targets.filter(
      (t) =>
        agedFeasible(c, t) ||
        reviewDue(c, t) ||
        (t === c.home && reqs(c, t).some((r) => isAged(c, r))),
    );
    for (const t of byKey(due, (w) => [
      Math.min(...reqs(c, w).map((r) => r.queuedAt + capOf(c, r))),
    ])) {
      const rule: SwapRule = agedFeasible(c, t) || t === c.home ? "C4" : "C6";
      const a = visit(t, rule, t);
      if (a) return a;
    }
  }

  // 8. C1: exhaustive service while a resident queue has work, with a threshold.
  const residentWork = c.resident.filter((w) => hasWork(c, w));
  // The Worker at home with cards in progress: its queue has work (C1), though
  // its steps are not queued requests here — another role waits for (b) or (c).
  const homeBusy =
    c.home !== undefined && isResident(c, c.home) && c.homeBacklog && !hasWork(c, c.home);
  if (residentWork.length > 0 || homeBusy) {
    if (!noLoads) {
      for (const t of byKey(over, (w) => targetKey(c, w))) {
        if (!(s.overThreshold ?? []).includes(t)) continue;
        // 7. C3: a visitor within its minimum dwell is not left for the threshold.
        const plan = planIn(c, t);
        // The watchdog (rule 19) overrides the dwell from `elevated` on.
        const dwelling =
          level < LEVEL.elevated &&
          plan.ok &&
          plan.evict.some(
            (v) => v !== c.home && c.now < (st(c, v).residentSince ?? c.now) + (pairFor(c, v) ?? 0),
          );
        if (dwelling) {
          stop(n, "C3", "a visitor's minimum dwell");
          continue;
        }
        const a = visit(t, "C1");
        if (a) return a;
      }
    }
    if (residentWork.length === 0) {
      // Look again when a waiting request reaches its cap (C4), if no step boundary comes first.
      const caps = targets.flatMap((t) =>
        reqs(c, t)
          .map((r) => r.queuedAt + capOf(c, r))
          .filter((at) => at > now),
      );
      const pf = prefetchCandidate(c);
      return finish(
        {
          kind: "keep",
          ...(caps.length > 0 ? { until: Math.min(...caps) } : {}),
          ...(pf !== undefined ? { prefetch: pf } : {}),
        },
        "C1",
        "the Worker's cards run; other queues wait for the threshold or their caps",
      );
    }
    const w = byKey(residentWork, (x) => {
      const top = serveOrder(c, x)[0] as SwapRequest;
      return [
        top.cls === "interactive" ? 0 : 1,
        isAged(c, top) ? 0 : 1,
        c.s.presence.present && top.review ? 0 : 1,
        planIndex(c, x),
        top.queuedAt,
      ];
    })[0] as string;
    const top = serveOrder(c, w)[0] as SwapRequest;
    const pf = prefetchCandidate(c);
    return finish(
      {
        kind: "keep",
        serve: c.queueOf.get(top.id) as string,
        ...(pf !== undefined ? { prefetch: pf } : {}),
      },
      "C1",
      `serving ${w}'s queue`,
    );
  }

  if (targets.length === 0 || noLoads) return idle(c, n, finish, noLoads);

  // The tour under way continues (C2), while C5 allows it.
  const tourNext = (s.tour ?? []).find((w) => targets.includes(w));
  if (tourNext !== undefined) {
    const rest = (s.tour ?? []).slice((s.tour ?? []).indexOf(tourNext));
    if (!c5Applies(c) || c5Allows(c, absenceOf(c, [tourNext]))) {
      const a = swapTo(tourNext, "C2", { continuing: true, tour: rest });
      if (a) return a;
    }
  }
  // The Worker's own work brings it home.
  if (c.home !== undefined && targets.includes(c.home)) {
    const a = swapTo(c.home, "C1");
    if (a) return a;
  }
  // C3's idle hold ends: another queue has work.
  for (const t of byKey(targets, (w) => targetKey(c, w))) {
    const a = visit(t, "C1");
    if (a) return a;
  }
  const rule = n.stoppedBy ?? "idle";
  // Look again when the first blocked visit may go (C7's free slot, C5's permit).
  const later = [...n.blocked.values()].filter((t) => t > c.now);
  return finish(
    later.length > 0 ? { kind: "wait", until: Math.min(...later) } : { kind: "wait" },
    rule,
    n.stoppedWhy ?? "nothing may load now",
  );
}

/** C10: the successor in the plan, warmed from free memory only, never above `normal`. */
function prefetchCandidate(c: Ctx): string | undefined {
  if (c.s.watchdog !== "normal") return undefined;
  const next = (c.s.plan ?? []).find((w) => !isResident(c, w) && !c.loading.includes(w));
  if (next === undefined) return undefined;
  const w = st(c, next);
  const free = c.s.memory.freeBytes;
  if (w.prefetched || w.fileBytes === undefined || free === undefined) return undefined;
  return free - c.P.prefetchMarginBytes > w.fileBytes ? next : undefined;
}

function idle(
  c: Ctx,
  n: Notes,
  finish: (b: Body, r: SwapRule, why: string) => SwapAction,
  noLoads: boolean,
): SwapAction {
  const visitors = c.resident.filter((w) => w !== c.home);
  // The watchdog's shortened keep-alive overrides the dwell and the idle hold.
  if (LEVEL[c.s.watchdog] >= LEVEL.elevated) {
    const victims = visitors.filter((w) => !isHeld(c, w) && (st(c, w).runningSteps ?? 0) === 0);
    if (victims.length > 0)
      return finish(
        { kind: "unload", weights: victims },
        "watchdog",
        `the watchdog is ${c.s.watchdog}: idle visitors leave`,
      );
  }
  // C3: an idle visitor stays C_pair after its load and after its last request.
  const holdEnds = visitors.map((v) => {
    const pair = pairFor(c, v) ?? 0;
    const since = st(c, v).residentSince ?? c.now;
    return Math.max(since + pair, (st(c, v).lastServedAt ?? since) + pair);
  });
  const holding = holdEnds.filter((t) => t > c.now);
  if (holding.length > 0)
    return finish({ kind: "keep", until: Math.min(...holding) }, "C3", "a visitor's idle hold");
  // With the hold over, the Worker comes back only when the plan uses it next;
  // otherwise the visitor stays, evictable without a dwell.
  const planNext = (c.s.plan ?? []).find((w) => !isResident(c, w));
  if (
    !noLoads &&
    c.home !== undefined &&
    planNext === c.home &&
    !isResident(c, c.home) &&
    visitors.length > 0
  ) {
    const plan = planIn(c, c.home);
    if (plan.ok)
      return finish(
        {
          kind: "swap",
          load: c.home,
          evict: plan.evict,
          tour: [],
          roundTrip: false,
          interactive: false,
          barrier: plan.evict.some((e) => (st(c, e).runningSteps ?? 0) > 0),
        },
        "C3",
        "the idle hold ended and the plan uses the Worker next",
      );
  }
  const pf = prefetchCandidate(c);
  if (pf !== undefined) return finish({ kind: "prefetch", weights: pf }, "C10", `warm ${pf}`);
  void n;
  return finish({ kind: "keep" }, noLoads ? "watchdog" : "idle", "nothing is waiting");
}

function benchmarkBlock(
  c: Ctx,
  n: Notes,
  b: string,
  finish: (body: Body, r: SwapRule, why: string) => SwapAction,
): SwapAction {
  if (!isResident(c, b)) {
    const plan = planIn(c, b);
    if (!plan.ok) {
      n.refused.push({ weights: b, reason: plan.reason });
      return finish({ kind: "wait" }, plan.hold ? "hold" : "memory", plan.reason);
    }
    return finish(
      {
        kind: "swap",
        load: b,
        evict: plan.evict,
        tour: [b],
        roundTrip: false,
        interactive: false,
        barrier: plan.evict.some((e) => (st(c, e).runningSteps ?? 0) > 0),
      },
      "benchmark",
      "a benchmark block starts: one swap, C1–C10 bypassed",
    );
  }
  const top = serveOrder(c, b)[0];
  return finish(
    top ? { kind: "keep", serve: c.queueOf.get(top.id) as string } : { kind: "keep" },
    "benchmark",
    "inside a benchmark block",
  );
}

/**
 * What the model page and Seshat show (rule 20e, MD-N14-20): θ, the caps now
 * with their feasibility, the placement notice, the round trips counted
 * against the storm cap, and the Worker's absence against its floor.
 */
export function swapStatus(
  s: SwapSnapshot,
  now: number,
): {
  theta: number;
  caps: CapStatus[];
  placementNotice: boolean;
  roundTrips: number;
  homeAbsentMs: number;
  homeBudgetMs: number;
} {
  const c = context(s, now);
  const byClass: Partial<Record<RequestClass, number>> = {};
  for (const q of s.queues)
    for (const r of q.requests) {
      if (byClass[r.cls] !== undefined) continue;
      const pair = pairFor(c, q.weights);
      if (pair !== undefined) byClass[r.cls] = pair;
    }
  const report = capReport(c.P, c.th, byClass);
  return {
    ...report,
    roundTrips: countedRoundTrips(c).length,
    homeAbsentMs: absentOverlap(c, now - c.P.windowMs, now),
    homeBudgetMs: budget(c),
  };
}
