import { percentile } from "./swap_cost.js";
import {
  type SwapHistoryEntry,
  type SwapMemory,
  type SwapQueueState,
  type SwapRequest,
  type SwapSnapshot,
  type SwapWeightsState,
  decide,
} from "./swap_decide.js";
import type { RequestClass, SwapPolicyParams } from "./swap_policy.js";

/**
 * The closed-loop replay simulator (models rule 20j, NEW-models-14,
 * MD-N14-38–39).
 *
 * It runs the real `decide()` under a virtual clock: loads and unloads take
 * times sampled with a seed from the recorded distributions, memory is a
 * fake that admits a fixed number of models (or footprints within usable
 * bytes), and nothing is loaded. It is **closed-loop**: a card's steps are
 * queued one after another as each finishes; a passing attempt queues its
 * review, and a failing one its escalation (as recorded) and then the next
 * attempt; each Seshat turn arrives its think-time after the previous
 * answer, not at a wall-clock stamp; presence and reserved hours replay from
 * the day. Benchmark blocks (rule 20b) replay as the policy's own.
 *
 * It reports θ; the wait p50, p90 and maximum per class; accepted cards per
 * hour; the maximum age; swaps per hour; and the Worker's residency in each
 * hour. A parameter or policy change is adopted only by measurement rule
 * 16a's scheduling row (`admitSchedulingChange` in the eval package).
 */

/** Recorded times for one set of weights. */
export interface SimWeights {
  loadMs: number[];
  unloadMs: number[];
  fileBytes?: number;
  footprintBytes?: number;
}

export interface SimAttempt {
  /** Each Worker step's service time, in order. */
  steps: number[];
  passed: boolean;
  /** A failed attempt's escalated retry on the Planner's weights, as recorded. */
  escalationMs?: number;
}

export interface SimCard {
  id: string;
  arrivesAt: number;
  attempts: SimAttempt[];
  reviewMs: number;
}

export interface SimSession {
  /** When the person first writes. */
  startAt: number;
  /** Each turn arrives `thinkMs` after the previous answer (the first after `startAt`). */
  turns: { thinkMs: number; serviceMs: number }[];
}

/** One recorded day of demand. */
export interface SimDay {
  /** The calendar day (YYYY-MM-DD): admission pairs by distinct days. */
  day: string;
  start: number;
  end: number;
  cards: SimCard[];
  seshat: SimSession[];
  /**
   * Research requests as recorded (live-test F15): each queued at its time
   * on the `researcher` queue, served for its recorded time.
   */
  research?: { at: number; serviceMs: number }[];
  /** When a person was present (a dashboard session, a reserve-now). */
  presence: { from: number; to: number }[];
  /** The reserved hours. */
  reserved: { from: number; to: number }[];
  /** Overnight benchmark blocks: their weights swapped in, C1–C10 bypassed. */
  blocks?: { weights: string; from: number; to: number }[];
}

export interface SimConfig {
  params: SwapPolicyParams;
  seed: number;
  /**
   * Queue → weights: `worker`, `chat` (Seshat), `planner` (escalations),
   * `reviewer`, and `researcher` when the day has research requests.
   */
  queues: Record<string, string>;
  /** The Worker's weights. */
  home?: string;
  weights: Record<string, SimWeights>;
  /** The fake memory: at most `models` resident, or footprints within `usableBytes`. */
  memory: { models: number } | { usableBytes: number };
}

export interface SimTraceEvent {
  kind: "queued" | "served" | "quick" | "swap" | "unload" | "accepted";
  at: number;
  ms?: number;
  queue?: string;
  request?: string;
  card?: string;
  attempt?: number;
  to?: string;
  from?: string[];
}

export interface WaitStats {
  p50: number;
  p90: number;
  max: number;
  n: number;
}

export interface SimMetrics {
  /** Swap time ÷ the day's wall time. */
  theta: number;
  waits: Partial<Record<RequestClass, WaitStats>>;
  accepted: number;
  acceptedPerHour: number;
  /** The oldest any request got, served or still waiting at the day's end. */
  maxAgeMs: number;
  swaps: number;
  swapsPerHour: number;
  /** Interactive requests given rule 20f's quick path. */
  quickAnswers: number;
  /** The share of each full hour, from the Worker's first load, that it was resident. */
  homeResidencyByHour: number[];
}

interface SimReq extends SwapRequest {
  queue: string;
  card?: string;
  attempt?: number;
  onDone: (end: number) => void;
  onQuick?: (at: number) => void;
}

/** A small seeded generator (mulberry32): the same seed gives the same samples. */
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

const HOUR = 3_600_000;

function stats(list: readonly number[]): WaitStats {
  return {
    p50: percentile(list, 0.5),
    p90: percentile(list, 0.9),
    max: Math.max(...list),
    n: list.length,
  };
}

/** Replay one day under `config` (MD-N14-38): deterministic for a seed. */
export function simulateDay(
  day: SimDay,
  config: SimConfig,
): { metrics: SimMetrics; trace: SimTraceEvent[] } {
  const rand = seeded(config.seed);
  const sample = (list: readonly number[]) =>
    list.length === 0 ? 0 : (list[Math.floor(rand() * list.length)] as number);
  const trace: SimTraceEvent[] = [];
  const events: { at: number; seq: number; fire: (at: number) => void }[] = [];
  let eventSeq = 0;
  const later = (at: number, fire: (at: number) => void) => {
    events.push({ at, seq: eventSeq++, fire });
    events.sort((a, b) => a.at - b.at || a.seq - b.seq);
  };
  const queues = new Map<string, SimReq[]>();
  const resident = new Map<string, { since: number; lastServed?: number }>();
  const prefetched = new Set<string>();
  const swaps: SwapHistoryEntry[] = [];
  const absences: { from: number; to?: number }[] = [];
  const homeIntervals: { from: number; to?: number }[] = [];
  const quickDone = new Set<string>();
  const waits = new Map<RequestClass, number[]>();
  let overThreshold: string[] = [];
  let tour: string[] = [];
  let seq = 0;
  let accepted = 0;
  let swapMs = 0;
  let maxAge = 0;
  const home = config.home;

  const enqueue = (
    at: number,
    queue: string,
    cls: RequestClass,
    serviceMs: number,
    extra: Partial<SimReq>,
    onDone: (end: number) => void,
  ): SimReq => {
    const req: SimReq = {
      id: `${queue}#${++seq}`,
      cls,
      queuedAt: at,
      serviceMs,
      queue,
      onDone,
      ...extra,
    };
    const list = queues.get(queue) ?? [];
    list.push(req);
    queues.set(queue, list);
    trace.push({
      kind: "queued",
      at,
      queue,
      request: req.id,
      ...(req.card !== undefined ? { card: req.card } : {}),
      ...(req.attempt !== undefined ? { attempt: req.attempt } : {}),
    });
    return req;
  };

  // --- Closed-loop demand ---
  const startAttempt = (card: SimCard, a: number, at: number) => {
    if (a >= card.attempts.length) return;
    step(card, a, 0, at);
  };
  const step = (card: SimCard, a: number, i: number, at: number) => {
    const attempt = card.attempts[a] as SimAttempt;
    enqueue(
      at,
      "worker",
      "worker",
      attempt.steps[i] ?? 0,
      { card: card.id, attempt: a + 1 },
      (end) => {
        if (i + 1 < attempt.steps.length) step(card, a, i + 1, end);
        else finish(card, a, end);
      },
    );
  };
  const finish = (card: SimCard, a: number, at: number) => {
    const attempt = card.attempts[a] as SimAttempt;
    if (attempt.passed) {
      enqueue(at, "reviewer", "reviewer", card.reviewMs, { card: card.id, review: true }, (end) => {
        accepted++;
        trace.push({ kind: "accepted", at: end, card: card.id });
      });
    } else if (attempt.escalationMs !== undefined) {
      enqueue(at, "planner", "planner", attempt.escalationMs, { card: card.id }, (end) =>
        startAttempt(card, a + 1, end),
      );
    } else startAttempt(card, a + 1, at);
  };
  for (const card of day.cards) later(card.arrivesAt, (at) => startAttempt(card, 0, at));

  const ask = (s: SimSession, k: number, at: number) => {
    const turn = s.turns[k];
    if (!turn) return;
    let answered = false;
    const next = (when: number) => {
      if (answered) return;
      answered = true;
      const following = s.turns[k + 1];
      if (following) later(when + following.thinkMs, (t2) => ask(s, k + 1, t2));
    };
    enqueue(at, "chat", "interactive", turn.serviceMs, { onQuick: next }, next);
  };
  for (const s of day.seshat) {
    const first = s.turns[0];
    if (first) later(s.startAt + first.thinkMs, (at) => ask(s, 0, at));
  }
  // Research requests (live-test F15): refused, never dropped, without weights to serve them.
  const research = day.research ?? [];
  if (research.length > 0 && config.queues.researcher === undefined)
    throw new Error("the day has research requests and the replay names no researcher weights");
  for (const r of research)
    later(r.at, (at) => enqueue(at, "researcher", "researcher", r.serviceMs, {}, () => undefined));
  // Wake at every block and presence boundary.
  for (const b of day.blocks ?? []) {
    later(b.from, () => undefined);
    later(b.to, () => undefined);
  }

  // --- The fake memory ---
  const memory = (): SwapMemory => ({
    admit: ({ load, evict, resident: now }) => {
      const left = now.filter((r) => r !== load && !evict.includes(r));
      if ("models" in config.memory)
        return left.length + 1 <= config.memory.models
          ? { ok: true }
          : { ok: false, reason: `only ${config.memory.models} model(s) fit` };
      const bytes = (w: string) => config.weights[w]?.footprintBytes ?? 0;
      const used = left.reduce((n, w) => n + bytes(w), 0) + bytes(load);
      return used <= config.memory.usableBytes
        ? { ok: true }
        : { ok: false, reason: "the footprints do not fit" };
    },
  });

  const homeBacklog = () => home !== undefined && (queues.get("worker")?.length ?? 0) > 0;
  const trackAbsence = (t: number) => {
    const open = absences.at(-1);
    const away = home !== undefined && !resident.has(home) && homeBacklog();
    if (away && !(open && open.to === undefined)) absences.push({ from: t });
    if (!away && open && open.to === undefined) open.to = t;
  };

  const snapshot = (t: number): SwapSnapshot => {
    const weights: Record<string, SwapWeightsState> = {};
    for (const [w, spec] of Object.entries(config.weights)) {
      const state: SwapWeightsState = {};
      if (spec.loadMs.length)
        state.load = { median: percentile(spec.loadMs, 0.5), p90: percentile(spec.loadMs, 0.9) };
      if (spec.unloadMs.length)
        state.unload = {
          median: percentile(spec.unloadMs, 0.5),
          p90: percentile(spec.unloadMs, 0.9),
        };
      if (spec.fileBytes !== undefined) state.fileBytes = spec.fileBytes;
      const r = resident.get(w);
      if (r) {
        state.residentSince = r.since;
        if (r.lastServed !== undefined) state.lastServedAt = r.lastServed;
      }
      if (prefetched.has(w)) state.prefetched = true;
      weights[w] = state;
    }
    const qs: SwapQueueState[] = [...queues.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([queue, list]) => ({
        queue,
        weights: config.queues[queue] as string,
        requests: list.map(({ id, cls, queuedAt, serviceMs, review }) => ({
          id,
          cls,
          queuedAt,
          serviceMs,
          ...(review ? { review } : {}),
        })),
      }));
    const inside = (xs: readonly { from: number; to: number }[]) =>
      xs.some((x) => t >= x.from && t < x.to);
    const present = inside(day.presence) || inside(day.reserved);
    const nextReserved = day.reserved
      .map((r) => r.from)
      .filter((f) => f > t)
      .sort((a, b) => a - b)[0];
    const block = (day.blocks ?? []).find((b) => t >= b.from && t < b.to);
    const cutoff = t - config.params.windowMs;
    return {
      params: config.params,
      ...(home !== undefined ? { home, homeBacklog: homeBacklog() } : {}),
      weights,
      queues: qs,
      watchdog: "normal",
      presence: {
        present,
        ...(!present && nextReserved !== undefined ? { reservedStartsAt: nextReserved } : {}),
      },
      swaps: swaps.filter((x) => x.at + x.ms > cutoff),
      homeAbsences: absences.filter((a) => a.to === undefined || a.to > cutoff),
      overThreshold,
      tour,
      memory: memory(),
      ...(block ? { benchmark: { weights: block.weights } } : {}),
    };
  };

  const setResident = (w: string, t: number) => {
    resident.set(w, { since: t });
    prefetched.delete(w);
    if (w === home) homeIntervals.push({ from: t });
  };
  const setGone = (w: string, t: number) => {
    resident.delete(w);
    if (w === home) {
      const open = homeIntervals.at(-1);
      if (open && open.to === undefined) open.to = t;
    }
  };

  let t = day.start;
  const fireDue = () => {
    while (events.length > 0 && (events[0] as { at: number }).at <= t) {
      const e = events.shift() as { at: number; fire: (at: number) => void };
      e.fire(e.at);
    }
  };

  for (let guard = 0; guard < 500_000; guard++) {
    fireDue();
    if (t >= day.end) break;
    trackAbsence(t);
    const action = decide(snapshot(t), t);
    overThreshold = action.memo.overThreshold;
    for (const id of action.quickPath) {
      if (quickDone.has(id)) continue;
      quickDone.add(id);
      const req = [...queues.values()].flat().find((r) => r.id === id);
      if (!req) continue;
      trace.push({ kind: "quick", at: t, queue: req.queue, request: id });
      req.onQuick?.(t);
    }
    if (action.kind === "keep" && action.serve !== undefined) {
      const list = queues.get(action.serve) ?? [];
      const req = list.shift();
      if (!req) continue;
      const wait = t - req.queuedAt;
      const bucket = waits.get(req.cls) ?? [];
      bucket.push(wait);
      waits.set(req.cls, bucket);
      maxAge = Math.max(maxAge, wait);
      trace.push({
        kind: "served",
        at: t,
        ms: req.serviceMs,
        queue: req.queue,
        request: req.id,
        ...(req.card !== undefined ? { card: req.card } : {}),
      });
      t += req.serviceMs;
      const w = config.queues[req.queue] as string;
      const r = resident.get(w);
      if (r) r.lastServed = t;
      req.onDone(t);
      continue;
    }
    if (action.kind === "swap") {
      const began = t;
      let ms = 0;
      for (const e of action.evict) {
        ms += sample(config.weights[e]?.unloadMs ?? []);
        setGone(e, began);
      }
      ms += sample(config.weights[action.load]?.loadMs ?? []);
      trackAbsence(began);
      t += ms;
      setResident(action.load, t);
      if (action.evict.length > 0) {
        swaps.push({
          at: began,
          ms,
          to: action.load,
          ...(action.evict[0] !== undefined ? { from: action.evict[0] } : {}),
          interactive: action.interactive,
          roundTrip: action.roundTrip,
        });
        swapMs += ms;
      }
      tour = action.load === home ? [] : action.tour.slice(action.tour.indexOf(action.load) + 1);
      trace.push({ kind: "swap", at: began, ms, to: action.load, from: action.evict });
      continue;
    }
    if (action.kind === "unload") {
      const began = t;
      let ms = 0;
      for (const w of action.weights) {
        ms += sample(config.weights[w]?.unloadMs ?? []);
        setGone(w, began);
      }
      t += ms;
      trace.push({ kind: "unload", at: began, ms, from: action.weights });
      continue;
    }
    if (action.kind === "prefetch") {
      prefetched.add(action.weights);
      continue;
    }
    // keep (idle) or wait: until the next arrival, or the time the action names.
    const nextEvent = events[0]?.at ?? Number.POSITIVE_INFINITY;
    const until =
      "until" in action && action.until !== undefined ? action.until : Number.POSITIVE_INFINITY;
    const next = Math.min(nextEvent, until, day.end);
    t = next > t ? next : t + 1000;
  }
  trackAbsence(Math.min(t, day.end));
  const end = day.end;
  for (const list of queues.values())
    for (const r of list) maxAge = Math.max(maxAge, end - r.queuedAt);
  for (const iv of homeIntervals) if (iv.to === undefined) iv.to = Math.max(end, iv.from);

  const hours = (end - day.start) / HOUR;
  const first = homeIntervals[0]?.from;
  const homeResidencyByHour: number[] = [];
  if (first !== undefined) {
    for (let k = 0; first + (k + 1) * HOUR <= end; k++) {
      const a = first + k * HOUR;
      const b = a + HOUR;
      let inside = 0;
      for (const iv of homeIntervals) {
        const x = Math.max(a, iv.from);
        const y = Math.min(b, iv.to as number);
        if (y > x) inside += y - x;
      }
      homeResidencyByHour.push(inside / HOUR);
    }
  }
  const waitStats: Partial<Record<RequestClass, WaitStats>> = {};
  for (const [cls, list] of waits) waitStats[cls] = stats(list);
  const swapCount = swaps.length;
  return {
    metrics: {
      theta: swapMs / (end - day.start),
      waits: waitStats,
      accepted,
      acceptedPerHour: accepted / hours,
      maxAgeMs: maxAge,
      swaps: swapCount,
      swapsPerHour: swapCount / hours,
      quickAnswers: quickDone.size,
      homeResidencyByHour,
    },
    trace,
  };
}

/** A metric a scheduling change is judged on, and which way is better (measurement rule 16a). */
export type SimMetricName =
  | "theta"
  | "acceptedPerHour"
  | "maxAgeMs"
  | "swapsPerHour"
  | `waitP50:${RequestClass}`
  | `waitP90:${RequestClass}`
  | `waitMax:${RequestClass}`;

/** A day's value of a metric; a class with no requests reads 0. */
export function simMetric(m: SimMetrics, name: SimMetricName): number {
  if (name === "theta") return m.theta;
  if (name === "acceptedPerHour") return m.acceptedPerHour;
  if (name === "maxAgeMs") return m.maxAgeMs;
  if (name === "swapsPerHour") return m.swapsPerHour;
  const [stat, cls] = name.split(":") as [string, RequestClass];
  const w = m.waits[cls];
  if (!w) return 0;
  return stat === "waitP50" ? w.p50 : stat === "waitP90" ? w.p90 : w.max;
}
