import type { CardRecord, EventRecord } from "@sekhemet/kernel";

/**
 * The seven live signals with thresholds and automatic responses (P20,
 * design "Live monitoring & telemetry signals"). Computed from the board
 * and the event log; a response is automatic only when it changes no field
 * a person owns, and otherwise a proposal or a decision request (§2.12,
 * NEW-planner-pm-2, -5; the harness carries them out in `planner_live.ts`).
 * The bounds are fields of `SIGNAL_BOUNDS`, so the goal view can show them.
 */
export const SIGNAL_BOUNDS = {
  scopeDriftFraction: 0.2,
  cycleP95OverP50: 2.5,
  blockedHours: 12,
  blockedHoursActive: 2,
  hotspotFailures: 3,
  riskAssumptionHours: 24,
} as const;

export type SignalId =
  | "burn_up"
  | "scope_drift"
  | "cycle_time"
  | "blocked_time"
  | "failure_concentration"
  | "review_backlog"
  | "risk_register";

export type SignalAction =
  | "forecast_eta"
  | "halt_aux_cards_and_ask"
  | "adjust_step_budgets"
  | "escalate_blockers"
  | "resplit_hotspot"
  | "backpressure_verify"
  | "dispatch_verification_spike";

/**
 * How a response is carried out (§2.12, NEW-planner-pm-2, -5): `automatic`
 * only when it changes no card field a person owns (a forecast, a
 * back-pressure hold, the order of *Needs you*); otherwise a `proposal` a
 * person applies, or a `decision` request that asks.
 */
export type SignalMode = "automatic" | "proposal" | "decision";

export interface SignalReading {
  id: SignalId;
  value: number;
  threshold?: number;
  triggered: boolean;
  detail: string;
  /** The planned epic a per-epic reading (scope drift) is about. */
  epicId?: string;
  /** What the planner does when triggered; `decision` means it asks. */
  response?: { action: SignalAction; mode: SignalMode; targets: string[] };
}

/** One planned epic, for scope drift: its first plan and every card any plan version made. */
export interface PlannedEpic {
  epicId: string;
  /** The stories of the epic's first plan version (the denominator). */
  originalCardIds: readonly string[];
  /** Stories of every later plan version: planned, so never drift. */
  plannedCardIds: readonly string[];
}

export interface SignalInput {
  now: Date;
  cards: readonly CardRecord[];
  events: readonly EventRecord[];
  /** Cards in the goal's original plan (for scope drift over the whole board). */
  originalPlanCardIds?: readonly string[];
  /** Planned epics: one scope-drift reading each, over the epic's own cards (PM-N5-1). */
  plans?: readonly PlannedEpic[];
  /** Review capacity (ReviewWIP). */
  reviewWip: number;
  /** Whether a card is running now (tightens the blocked-time bound). */
  activeWork?: boolean;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] as number;
}

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export function computeSignals(input: SignalInput): SignalReading[] {
  const { cards, events, now } = input;
  const work = cards.filter((c) => c.tier === "story" || c.tier === "task");
  const out: SignalReading[] = [];

  // 1. Burn-up vs scope: two curves, never netted.
  const total = work.filter((c) => c.status !== "rejected").length;
  const done = work.filter((c) => c.status === "done").length;
  const doneTimes = work
    .filter((c) => c.status === "done")
    .map((c) => Date.parse(c.updatedAt))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  let eta = "no velocity yet";
  if (doneTimes.length >= 2) {
    const span = (doneTimes[doneTimes.length - 1] as number) - (doneTimes[0] as number);
    const perCard = span / (doneTimes.length - 1);
    eta = `~${hours(perCard * (total - done))}h at the measured rate`;
  }
  out.push({
    id: "burn_up",
    value: total === 0 ? 0 : done / total,
    triggered: false,
    detail: `${done} of ${total} cards verified; ETA ${eta}`,
    response: { action: "forecast_eta", mode: "automatic", targets: [] },
  });

  // 2. Scope drift: cards created mid-flight over the original plan.
  const original = new Set(input.originalPlanCardIds ?? []);
  if (original.size > 0) {
    const added = work.filter((c) => !original.has(c.id));
    const drift = added.length / original.size;
    out.push({
      id: "scope_drift",
      value: Math.round(drift * 1000) / 1000,
      threshold: SIGNAL_BOUNDS.scopeDriftFraction,
      triggered: drift > SIGNAL_BOUNDS.scopeDriftFraction,
      detail: `${added.length} cards added to a ${original.size}-card plan`,
      response: {
        action: "halt_aux_cards_and_ask",
        mode: "decision",
        targets: added.map((c) => c.id),
      },
    });
  }
  for (const plan of input.plans ?? []) {
    const reading = epicScopeDrift(work, plan);
    if (reading) out.push(reading);
  }

  // 3. Cycle time: Ready -> Review, p95 vs p50.
  const cycle: number[] = [];
  const readyAt = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "card/status_changed" || !e.cardId) continue;
    const p = e.payload as { toStatus?: string };
    const t = Date.parse(e.createdAt);
    if (p.toStatus === "in_progress" && !readyAt.has(e.cardId)) readyAt.set(e.cardId, t);
    if (p.toStatus === "review" && readyAt.has(e.cardId)) {
      cycle.push(t - (readyAt.get(e.cardId) as number));
      readyAt.delete(e.cardId);
    }
  }
  const p50 = percentile(cycle, 0.5);
  const p95 = percentile(cycle, 0.95);
  const ratio = p50 > 0 ? p95 / p50 : 0;
  out.push({
    id: "cycle_time",
    value: Math.round(ratio * 100) / 100,
    threshold: SIGNAL_BOUNDS.cycleP95OverP50,
    triggered: cycle.length >= 4 && ratio > SIGNAL_BOUNDS.cycleP95OverP50,
    detail: `p50 ${hours(p50)}h, p95 ${hours(p95)}h over ${cycle.length} cards`,
    response: { action: "adjust_step_budgets", mode: "proposal", targets: [] },
  });

  // 4. Blocked time: parked (or awaiting a decision) longer than the bound.
  const bound = input.activeWork ? SIGNAL_BOUNDS.blockedHoursActive : SIGNAL_BOUNDS.blockedHours;
  const blocked = work.filter(
    (c) => c.status === "parked" && hours(now.getTime() - Date.parse(c.updatedAt)) > bound,
  );
  const oldest = Math.max(
    0,
    ...work
      .filter((c) => c.status === "parked")
      .map((c) => hours(now.getTime() - Date.parse(c.updatedAt))),
  );
  out.push({
    id: "blocked_time",
    value: oldest,
    threshold: bound,
    triggered: blocked.length > 0,
    detail: `${blocked.length} card(s) blocked over ${bound}h; oldest ${oldest}h`,
    // The top of *Needs you* is automatic; raising priority is a person's
    // field, so it is proposed, never set (PM-N2-1).
    response: { action: "escalate_blockers", mode: "proposal", targets: blocked.map((c) => c.id) },
  });

  // 5. Failure concentration: gate failures per file (Pareto).
  const perFile = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "gate/result") continue;
    // The kernel's record says `passed` and locates each failure in a file
    // (`GateResultRecord`, gates rule 19); `status`, `files` and an excerpt
    // are older writers' shapes.
    const p = e.payload as {
      passed?: boolean;
      status?: string;
      files?: string[];
      file?: string;
      excerpt?: string;
      failures?: { location?: { file?: string } }[];
    };
    if (p.passed === true || p.status === "pass") continue;
    const located = (p.failures ?? [])
      .map((f) => f?.location?.file)
      .filter((f): f is string => typeof f === "string" && f.length > 0);
    const files = [...(p.files ?? (p.file ? [p.file] : [])), ...located];
    const fromText = [...(p.excerpt ?? "").matchAll(/([\w./-]+\.(?:ts|tsx|js|py|rs|go))[:(]/g)].map(
      (m) => m[1] as string,
    );
    for (const f of new Set([...files, ...fromText])) perFile.set(f, (perFile.get(f) ?? 0) + 1);
  }
  const hot = [...perFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [hotFile, hotCount] = hot[0] ?? ["", 0];
  const hotCards = work
    .filter((c) => c.status !== "done" && c.scopeFiles.includes(hotFile))
    .map((c) => c.id);
  out.push({
    id: "failure_concentration",
    value: hotCount,
    threshold: SIGNAL_BOUNDS.hotspotFailures,
    triggered: hotCount >= SIGNAL_BOUNDS.hotspotFailures,
    detail: hotFile ? `${hotCount} gate failures in ${hotFile}` : "no gate failures",
    // A re-split is proposed; the card is never paused (PM-N5-2).
    response: { action: "resplit_hotspot", mode: "proposal", targets: hotCards },
  });

  // 6. Review backlog vs ReviewWIP.
  const inReview = work.filter((c) => c.status === "review");
  out.push({
    id: "review_backlog",
    value: inReview.length,
    threshold: input.reviewWip,
    triggered: inReview.length >= input.reviewWip,
    detail: `${inReview.length} in Review against a ReviewWIP of ${input.reviewWip}`,
    response: {
      action: "backpressure_verify",
      mode: "automatic",
      targets: work.filter((c) => c.status === "in_progress").map((c) => c.id),
    },
  });

  // 7. Risk register: assumptions older than the bound with no outcome.
  const outcomes = new Set(
    events
      .filter((e) => e.type === "assumption/outcome")
      .map((e) => (e.payload as { assumptionId?: string }).assumptionId),
  );
  const stale = events.filter(
    (e) =>
      e.type === "assumption/logged" &&
      !outcomes.has((e.payload as { id?: string }).id) &&
      hours(now.getTime() - Date.parse(e.createdAt)) > SIGNAL_BOUNDS.riskAssumptionHours,
  );
  out.push({
    id: "risk_register",
    value: stale.length,
    threshold: 0,
    triggered: stale.length > 0,
    detail: `${stale.length} assumption(s) unverified for over ${SIGNAL_BOUNDS.riskAssumptionHours}h`,
    response: {
      action: "dispatch_verification_spike",
      mode: "proposal",
      targets: stale.map((e) => (e.payload as { id: string }).id),
    },
  });
  return out;
}

/**
 * Scope drift of one planned epic (PM-N5-1): the epic's cards that no plan
 * version made and no split produced, over its first plan's size.
 */
function epicScopeDrift(work: readonly CardRecord[], plan: PlannedEpic): SignalReading | undefined {
  const original = new Set(plan.originalCardIds);
  if (original.size === 0) return undefined;
  const planned = new Set([...plan.originalCardIds, ...plan.plannedCardIds]);
  // K-N9-4: whether a card came from a split is `splitDepth > 0` (nothing
  // outside storage, display and export reads the stored `split` axis).
  const added = work.filter(
    (c) => c.parentId === plan.epicId && !planned.has(c.id) && !c.splitDepth,
  );
  const drift = added.length / original.size;
  return {
    id: "scope_drift",
    epicId: plan.epicId,
    value: Math.round(drift * 1000) / 1000,
    threshold: SIGNAL_BOUNDS.scopeDriftFraction,
    triggered: drift > SIGNAL_BOUNDS.scopeDriftFraction,
    detail: `${added.length} cards added to ${plan.epicId}'s ${original.size}-card plan`,
    response: {
      action: "halt_aux_cards_and_ask",
      mode: "decision",
      targets: added.map((c) => c.id),
    },
  };
}

/** 95% Wilson score interval for k successes in n trials. */
function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return { low: r(Math.max(0, centre - half)), high: r(Math.min(1, centre + half)) };
}

/** The recent window and the record it is compared with (PM-N5-3). */
export const DEGRADATION_WINDOW = 10;

export interface WorkerDegradation {
  degraded: boolean;
  /** Pass rate over the last `DEGRADATION_WINDOW` attempts. */
  recentRate: number;
  /** The Worker's 95% Wilson interval over its attempts before that window. */
  low: number;
  high: number;
  /** Attempts the interval is taken over. */
  baseline: number;
  /** The *What's at risk* line, when degraded. */
  text?: string;
}

/**
 * Possible model degradation (§2.12 cycle time, PM-N5-3): the Worker's pass
 * rate over its last 10 attempts against the 95% interval of its record
 * before them. Undefined until there are 10 earlier attempts to compare
 * with (the capability model's rough-range floor, §2.5). `passes` is the
 * Worker's attempts in ledger order, person-built and halted ones excluded.
 */
export function workerDegradation(
  passes: readonly boolean[],
  window = DEGRADATION_WINDOW,
): WorkerDegradation | undefined {
  const earlier = passes.slice(0, Math.max(0, passes.length - window));
  const recent = passes.slice(-window);
  if (recent.length < window || earlier.length < window) return undefined;
  const { low, high } = wilson(earlier.filter(Boolean).length, earlier.length);
  const recentRate = recent.filter(Boolean).length / recent.length;
  const degraded = recentRate < low;
  return {
    degraded,
    recentRate,
    low,
    high,
    baseline: earlier.length,
    ...(degraded
      ? {
          text: `Possible model degradation: the Worker passed ${recent.filter(Boolean).length} of its last ${window} attempts (${Math.round(recentRate * 100)}%), below the ${Math.round(low * 100)}–${Math.round(high * 100)}% range of its ${earlier.length} attempts before them.`,
        }
      : {}),
  };
}

/** The responses a scheduler pass should carry out now. */
export function triggeredResponses(readings: readonly SignalReading[]): SignalReading[] {
  return readings.filter((r) => r.triggered && r.response);
}
