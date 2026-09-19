import type { CardRecord, EventRecord } from "@sekhemet/kernel";

/**
 * The seven live signals with thresholds and automatic responses (P20,
 * design "Live monitoring & telemetry signals"). Computed from the board
 * and the event log; each response is either automatic within preset
 * bounds or a decision request. The bounds are fields of `SIGNAL_BOUNDS`,
 * so the goal view can show them.
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

export interface SignalReading {
  id: SignalId;
  value: number;
  threshold?: number;
  triggered: boolean;
  detail: string;
  /** What the planner does when triggered; `decision` means it asks. */
  response?: { action: SignalAction; mode: "automatic" | "decision"; targets: string[] };
}

export interface SignalInput {
  now: Date;
  cards: readonly CardRecord[];
  events: readonly EventRecord[];
  /** Cards in the goal's original plan (for scope drift). */
  originalPlanCardIds?: readonly string[];
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
    response: { action: "adjust_step_budgets", mode: "automatic", targets: [] },
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
    response: { action: "escalate_blockers", mode: "automatic", targets: blocked.map((c) => c.id) },
  });

  // 5. Failure concentration: gate failures per file (Pareto).
  const perFile = new Map<string, number>();
  for (const e of events) {
    if (e.type !== "gate/result") continue;
    const p = e.payload as { status?: string; files?: string[]; file?: string; excerpt?: string };
    if (p.status === "pass") continue;
    const files = p.files ?? (p.file ? [p.file] : []);
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
    response: { action: "resplit_hotspot", mode: "automatic", targets: hotCards },
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
      mode: "automatic",
      targets: stale.map((e) => (e.payload as { id: string }).id),
    },
  });
  return out;
}

/** The responses a scheduler pass should carry out now. */
export function triggeredResponses(readings: readonly SignalReading[]): SignalReading[] {
  return readings.filter((r) => r.triggered && r.response);
}
