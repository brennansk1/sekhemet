import type { EventLog } from "@sekhemet/kernel";

export interface FlowMetrics {
  throughput: { date: string; done: number }[];
  cycleTime: { cardId: string; hours: number; doneAt?: string }[];
  cfd: {
    date: string;
    backlog: number;
    ready: number;
    in_progress: number;
    verify: number;
    review: number;
    done: number;
  }[];
  wipAge: { cardId: string; hours: number }[];
}

type Bucket = "backlog" | "ready" | "in_progress" | "verify" | "review" | "done";

/** Board columns as flow states. Parked and rejected leave the flow. */
const BUCKET: Record<string, Bucket | undefined> = {
  backlog: "backlog",
  ready: "ready",
  planning: "ready",
  in_progress: "in_progress",
  verify: "verify",
  review: "review",
  done: "done",
};

const day = (iso: string) => iso.slice(0, 10);
const hoursBetween = (a: string, b: string) =>
  Math.max(0, (Date.parse(b) - Date.parse(a)) / 3_600_000);

/**
 * Kanban flow metrics from the ledger's status changes.
 *
 * Cycle time runs from a card's first move into Working to its move into
 * Done: the Kanban Method's definition, and the one that makes the number
 * comparable with Jira's and Linear's.
 */
export async function flowMetrics(
  log: EventLog,
  days: number,
  now = new Date(),
): Promise<FlowMetrics> {
  const events = await log.getEventsByTypes(["card/created", "card/status_changed"]);
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();

  const state = new Map<string, Bucket | undefined>();
  const startedAt = new Map<string, string>();
  const enteredAt = new Map<string, string>();
  const throughput = new Map<string, number>();
  const cycleTime: FlowMetrics["cycleTime"] = [];
  const cfdByDay = new Map<string, Record<Bucket, number>>();

  const snapshot = (): Record<Bucket, number> => {
    const counts: Record<Bucket, number> = {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      verify: 0,
      review: 0,
      done: 0,
    };
    for (const b of state.values()) if (b) counts[b]++;
    return counts;
  };

  for (const e of events) {
    const p = e.payload as { id?: string; status?: string; toStatus?: string };
    const id = p.id ?? e.cardId;
    if (!id) continue;
    const status = e.type === "card/created" ? p.status : p.toStatus;
    const bucket = status ? BUCKET[status] : undefined;
    const at = e.createdAt;

    if (bucket === "in_progress" && !startedAt.has(id)) startedAt.set(id, at);
    if (bucket !== state.get(id)) enteredAt.set(id, at);
    if (bucket === "done" && state.get(id) !== "done") {
      if (at >= since) throughput.set(day(at), (throughput.get(day(at)) ?? 0) + 1);
      const start = startedAt.get(id);
      if (start && at >= since) {
        cycleTime.push({ cardId: id, hours: round(hoursBetween(start, at)), doneAt: at });
      }
    }
    state.set(id, bucket);
    cfdByDay.set(day(at), snapshot());
  }

  // One CFD row per day in range, carrying the last known state forward.
  const cfd: FlowMetrics["cfd"] = [];
  let carry = snapshotBefore(cfdByDay, day(since));
  for (let t = Date.parse(day(since)); t <= now.getTime(); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    carry = cfdByDay.get(d) ?? carry;
    cfd.push({ date: d, ...carry });
  }

  const nowIso = now.toISOString();
  const wipAge: FlowMetrics["wipAge"] = [];
  for (const [id, b] of state) {
    if (b === "in_progress" || b === "verify" || b === "review") {
      wipAge.push({ cardId: id, hours: round(hoursBetween(enteredAt.get(id) ?? nowIso, nowIso)) });
    }
  }
  wipAge.sort((a, b) => b.hours - a.hours);

  return {
    throughput: [...throughput].sort().map(([date, done]) => ({ date, done })),
    cycleTime,
    cfd,
    wipAge,
  };
}

/** A cycle's dates, for its burn-up. */
export interface BurnupCycle {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
}

/**
 * The burn-up series (dashboard DB-P3-14, PM_CONTRACT §3): done points and
 * total scope at the end of each day, replayed from the card events, so scope
 * growth shows apart from progress. A cycle's runs from its start to today
 * (none before it starts), counting its cards; the project's from the first
 * card's day, counting every card. Epics and initiatives hold cards and are
 * not counted; a rejected card leaves the scope; an unestimated card counts
 * as 1 point, as the cycle header counts it. `project` keeps one project's
 * cards; `canSee` keeps the cards of the projects a person may see (Team,
 * PM-N9-8), so no one reads the counts of a project hidden from them.
 * `unit: "issues"` counts every issue as one, for a project whose
 * Preferences → Estimation is off (DEC-31, dashboard DB-N7-2).
 */
export function burnupFromEvents(
  events: readonly { type: string; cardId?: string | null; payload: unknown; createdAt: string }[],
  opts: {
    cycle?: BurnupCycle;
    now: Date;
    project?: string;
    canSee?: (project: string | undefined) => boolean;
    unit?: "points" | "issues";
  },
): {
  scope: "cycle" | "project";
  unit: "points" | "issues";
  cycleId?: string;
  name?: string;
  startsOn?: string;
  endsOn?: string;
  days: { date: string; done: number; scope: number }[];
  unestimated: number;
} {
  interface Row {
    tier: string;
    status: string;
    cycleId: string | null;
    estimate: number | null;
    projectId: string | undefined;
  }
  const cards = new Map<string, Row>();
  const byDay = new Map<string, { done: number; scope: number }>();
  const seen = new Map<string | undefined, boolean>();
  const visible = (project: string | undefined): boolean => {
    if (!opts.canSee) return true;
    let v = seen.get(project);
    if (v === undefined) {
      v = opts.canSee(project);
      seen.set(project, v);
    }
    return v;
  };
  const inScope = (r: Row) =>
    (!opts.project || r.projectId === opts.project) && visible(r.projectId);
  const counted = (r: Row) =>
    r.tier !== "epic" &&
    r.tier !== "initiative" &&
    r.status !== "rejected" &&
    (!opts.cycle || r.cycleId === opts.cycle.id) &&
    inScope(r);
  const unit = opts.unit ?? "points";
  const points = (r: Row) =>
    unit === "points" && typeof r.estimate === "number" && r.estimate > 0 ? r.estimate : 1;
  const totals = () => {
    let done = 0;
    let scope = 0;
    for (const r of cards.values()) {
      if (!counted(r)) continue;
      scope += points(r);
      if (r.status === "done") done += points(r);
    }
    return { done, scope };
  };
  let first: string | undefined;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : (e.cardId ?? undefined);
    if (!id) continue;
    if (e.type === "card/created") {
      cards.set(id, {
        tier: typeof p.tier === "string" ? p.tier : "story",
        status: typeof p.status === "string" ? p.status : "backlog",
        cycleId: typeof p.cycleId === "string" ? p.cycleId : null,
        estimate: typeof p.estimate === "number" ? p.estimate : null,
        projectId: typeof p.projectId === "string" ? p.projectId : undefined,
      });
      if (inScope(cards.get(id) as Row)) first ??= day(e.createdAt);
    } else {
      const row = cards.get(id);
      if (!row) continue;
      if (e.type === "card/status_changed" && typeof p.toStatus === "string") {
        row.status = p.toStatus;
      } else if (e.type === "card/updated") {
        const patch = (p.patch ?? {}) as Record<string, unknown>;
        if ("cycleId" in patch)
          row.cycleId = typeof patch.cycleId === "string" ? patch.cycleId : null;
        if ("estimate" in patch)
          row.estimate = typeof patch.estimate === "number" ? patch.estimate : null;
        if (typeof patch.tier === "string") row.tier = patch.tier;
        if ("projectId" in patch)
          row.projectId = typeof patch.projectId === "string" ? patch.projectId : undefined;
      } else continue;
    }
    byDay.set(day(e.createdAt), totals());
  }
  const today = day(opts.now.toISOString());
  const start = opts.cycle ? opts.cycle.startsOn.slice(0, 10) : first;
  const end = opts.cycle && opts.cycle.endsOn.slice(0, 10) < today ? opts.cycle.endsOn : today;
  const days: { date: string; done: number; scope: number }[] = [];
  if (start) {
    let carry = { done: 0, scope: 0 };
    for (const [d, t] of [...byDay].sort(([a], [b]) => a.localeCompare(b)))
      if (d < start) carry = t;
    for (let t = Date.parse(start); t <= Date.parse(end.slice(0, 10)); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      carry = byDay.get(d) ?? carry;
      days.push({ date: d, ...carry });
    }
  }
  const unestimated = [...cards.values()].filter(
    (r) => counted(r) && !(typeof r.estimate === "number" && r.estimate > 0),
  ).length;
  return {
    scope: opts.cycle ? "cycle" : "project",
    unit,
    ...(opts.cycle
      ? {
          cycleId: opts.cycle.id,
          name: opts.cycle.name,
          startsOn: opts.cycle.startsOn,
          endsOn: opts.cycle.endsOn,
        }
      : {}),
    days,
    unestimated,
  };
}

/** The burn-up series from the ledger now (`GET /api/metrics/burnup`). */
export async function burnupMetrics(
  log: EventLog,
  cycle: BurnupCycle | undefined,
  now = new Date(),
  scope: {
    project?: string;
    canSee?: (project: string | undefined) => boolean;
    unit?: "points" | "issues";
  } = {},
): Promise<ReturnType<typeof burnupFromEvents>> {
  const types = ["card/created", "card/status_changed", "card/updated"];
  // Every card event, page by page: a long ledger is never cut short.
  const events: Awaited<ReturnType<EventLog["getEventsByTypes"]>> = [];
  for (let from = 1; ; ) {
    const page = await log.getEventsByTypes(types, from, 10_000);
    events.push(...page);
    if (page.length < 10_000) break;
    from = (page[page.length - 1]?.seq ?? from) + 1;
  }
  return burnupFromEvents(events, { ...(cycle ? { cycle } : {}), now, ...scope });
}

function snapshotBefore(
  byDay: Map<string, Record<Bucket, number>>,
  first: string,
): Record<Bucket, number> {
  const empty = { backlog: 0, ready: 0, in_progress: 0, verify: 0, review: 0, done: 0 };
  let last = empty;
  for (const [d, counts] of [...byDay].sort(([a], [b]) => a.localeCompare(b))) {
    if (d < first) last = counts;
  }
  return last;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Monte Carlo delivery forecast from throughput history (the Kanban Method's
 * preferred forecast; research report 1). Resamples real days of completed
 * cards until the remaining work is done, many times, and reports the day
 * counts at the 50th and 85th percentiles: a range, not a promise.
 */
export function monteCarloForecast(
  dailyDone: number[],
  remaining: number,
  trials = 2000,
  random: () => number = Math.random,
): { p50Days: number; p85Days: number; samples: number } | undefined {
  if (remaining <= 0) return { p50Days: 0, p85Days: 0, samples: dailyDone.length };
  const days = dailyDone.filter((d) => d >= 0);
  if (days.length < 5 || days.every((d) => d === 0)) return undefined;
  const results: number[] = [];
  for (let t = 0; t < trials; t++) {
    let left = remaining;
    let n = 0;
    while (left > 0 && n < 3650) {
      left -= days[Math.floor(random() * days.length)] ?? 0;
      n++;
    }
    results.push(n);
  }
  results.sort((a, b) => a - b);
  const at = (q: number) =>
    results[Math.min(results.length - 1, Math.floor(q * results.length))] ?? 0;
  return { p50Days: at(0.5), p85Days: at(0.85), samples: days.length };
}

export interface PmQuality {
  proposals: { applied: number; discarded: number; open: number; acceptanceRate?: number };
  /** First-attempt pass rate of cards Seshat's applied proposals created. */
  plannedCards: { cards: number; passedFirstTry: number };
  /** How often the human corrected the profile (edits and dismissals). */
  profileCorrections: number;
  forecast?: { remaining: number; p50Days: number; p85Days: number; samples: number };
  /** Each closed sprint's recorded measures, oldest first (PM-P6-12, `pm/sprint_measured`). */
  sprints: Record<string, unknown>[];
}

/**
 * How good Seshat is, measured, not self-reported (research report 1, PM
 * quality): proposal acceptance, how well the cards it planned go, how often
 * the user corrects what it learned, and a calibrated forecast.
 */
export async function pmQuality(
  log: EventLog,
  remaining: number,
  firstAttemptPassed: (cardId: string) => boolean | undefined,
): Promise<PmQuality> {
  const events = await log.getEventsByTypes([
    "pm/proposal_state",
    "pm/reply",
    "learn/profile",
    "card/status_changed",
  ]);
  const kinds = new Map<string, string>();
  const created = new Set<string>();
  let applied = 0;
  let discarded = 0;
  let total = 0;
  let corrections = 0;
  for (const e of events) {
    if (e.type === "pm/reply") {
      for (const p of (e.payload as { proposals?: { id: string; kind: string }[] }).proposals ??
        []) {
        kinds.set(p.id, p.kind);
        total++;
      }
    } else if (e.type === "pm/proposal_state") {
      const p = e.payload as { proposalId: string; state: string; cardIds?: string[] };
      if (p.state === "applied") {
        applied++;
        const kind = kinds.get(p.proposalId);
        if (kind === "create_card" || kind === "split_card")
          for (const id of p.cardIds ?? []) created.add(id);
      } else if (p.state === "discarded") discarded++;
    } else if (e.type === "learn/profile" && e.actor === "human") {
      corrections++;
    }
  }
  const planned = [...created].map(firstAttemptPassed).filter((x) => x !== undefined);
  const throughput = (await flowMetrics(log, 60)).cfd;
  const daily = throughput.map((d, i) =>
    i === 0 ? 0 : Math.max(0, d.done - (throughput[i - 1]?.done ?? 0)),
  );
  const forecast = monteCarloForecast(daily.slice(1), remaining);
  return {
    proposals: {
      applied,
      discarded,
      open: Math.max(0, total - applied - discarded),
      ...(applied + discarded > 0
        ? { acceptanceRate: Math.round((applied / (applied + discarded)) * 100) / 100 }
        : {}),
    },
    plannedCards: { cards: planned.length, passedFirstTry: planned.filter(Boolean).length },
    profileCorrections: corrections,
    ...(forecast ? { forecast: { remaining, ...forecast } } : {}),
    sprints: (await log.getEventsByTypes(["pm/sprint_measured"])).map(
      (e) => e.payload as Record<string, unknown>,
    ),
  };
}
