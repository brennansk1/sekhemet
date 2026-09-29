import {
  type CardRecord,
  type CardStore,
  ERASED_MARKER,
  type EventLog,
  firstModelAttempts,
} from "@sekhemet/kernel";
import { type SignalReading, computeSignals } from "@sekhemet/planner";
import type { StatusFacts } from "@sekhemet/ui";
import { type Audience, nameFor, soloAudience } from "./pm/audience.js";
import { flowMetrics, monteCarloForecast } from "./pm/metrics.js";
import { UPDATE_POSTED } from "./pm/weekly.js";
import { startRequests } from "./team/ai_teammates.js";
import { UPDATE_CLOCK_EVENTS, healthOf, releaseTargets, updateClockStart } from "./team/health.js";
import { levelRank } from "./team/settings.js";

/**
 * What only the server knows for Status, the project page for the
 * stakeholder and the team (dashboard §2.8, DB-N9-1..4, -8; DEC-37), served
 * as `GET /api/status?project=` (PM_CONTRACT §3). The page reads the board,
 * the story map, the standup, the signals and the burn-up from their own
 * routes and builds every word with `statusModel` (`@sekhemet/ui`).
 *
 * Scoped to one project and to what the person can see (PM-N9-8): a project
 * they cannot see reads as no project. Health is the lead's call and a
 * release's target date a person's (teams TEAM-28, DB-N9-2, -3; `team/health.ts`).
 */

const DAY = 86_400_000;
/** Days of throughput the forecast resamples, at most (planner-pm §2.6 item 3). */
const HISTORY_DAYS = 60;
/** The window of the flow strip (Insights' default). */
const FLOW_DAYS = 30;
/** Below this many days of history the forecast is *Not enough history yet*. */
const FORECAST_MINIMUM = 5;
const UPDATE_DUE_DAYS = 7;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) / DAY);
const isIssue = (c: CardRecord) => c.tier !== "epic" && c.tier !== "initiative";

export async function statusFacts(deps: {
  cardStore: CardStore;
  log: EventLog;
  /** The person asking. */
  me: string;
  /** The project the page is scoped to; the only one the person can see when omitted. */
  project?: string | undefined;
  audience?: Audience;
  now?: Date;
  /** Injectable for tests: the forecast's resampling. */
  random?: () => number;
}): Promise<StatusFacts> {
  const a = deps.audience ?? soloAudience();
  const team = a.setup === "team";
  const now = (deps.now ?? new Date()).getTime();
  const me = deps.me;
  const visible = deps.cardStore.listProjects().filter((p) => a.canSee(me, p.id));
  const project =
    (deps.project ? visible.find((p) => p.id === deps.project) : undefined) ??
    (!deps.project && visible.length === 1 ? visible[0] : undefined);
  const cards = (await deps.cardStore.listCards()).filter(
    (c) =>
      isIssue(c) &&
      (project ? c.projectId === project.id : !deps.project && a.canSee(me, c.projectId)),
  );
  const ids = new Set(cards.map((c) => c.id));
  const title = new Map(cards.map((c) => [c.id, c.title]));

  // Who leads, and so who posts the update and sets health (teams items 6, 28, 29).
  const lead = project ? a.leadOf(project.id) : undefined;
  const isLead = !team || (lead !== undefined && lead === me);
  const canPostUpdate =
    Boolean(project) && (!team || isLead || a.levelOf(me, project?.id) === "admin");
  // Unpark is the `review` permission, a Member's (team/access.ts): never offered below it.
  const level = a.levelOf(me, project?.id);
  const canUnpark = !team || (level !== undefined && levelRank(level) >= levelRank("member"));

  // The latest posted update, its text private to the ledger (PM_CONTRACT §3).
  let update: StatusFacts["update"] = null;
  if (project) {
    const posted = (await deps.log.getEventsByTypes([UPDATE_POSTED])).filter(
      (e) => (e.payload as { project?: string }).project === project.id,
    );
    const last = posted.at(-1);
    const text = (last?.private as { text?: unknown } | undefined)?.text;
    if (last && typeof text === "string" && text !== ERASED_MARKER) {
      update = { text, by: nameFor(a, last.principal ?? undefined, me), at: last.createdAt };
    }
  }
  // TEAM-29: 7 days since the last update, or since the current release started
  // (the previous release's acceptance, or the first's creation) when none was
  // posted, else since the project began; told to the lead, in the Team setup only
  // (TEAM-45: in Solo the update is optional and never missing).
  const clock = project
    ? (updateClockStart(await deps.log.getEventsByTypes([...UPDATE_CLOCK_EVENTS]), project.id) ??
      Date.parse(project.createdAt))
    : now;
  const updateMissing = team && isLead && Boolean(project) && now - clock >= UPDATE_DUE_DAYS * DAY;

  // TEAM-28: health as a person last set it, with their name and the date.
  const set = project ? await healthOf(deps.log, project.id) : null;
  const health: StatusFacts["health"] = set
    ? { value: set.value, by: nameFor(a, set.principal, me), at: set.at }
    : null;
  // DB-N9-3: the current release (the first no person has accepted) and its target date.
  const slices = project
    ? (await deps.cardStore.slices.list(project.id)).map((sl, i) => ({ sl, i }))
    : [];
  const current = slices.find(({ sl }) => !sl.accepted);
  const release = current
    ? {
        id: current.sl.id,
        name: current.sl.title?.trim() ? current.sl.title.trim() : `Release ${current.i + 1}`,
      }
    : null;
  const targetSet =
    project && release ? (await releaseTargets(deps.log, project.id)).get(release.id) : undefined;
  const target: StatusFacts["target"] =
    release && targetSet
      ? {
          release: release.id,
          date: targetSet.date,
          by: nameFor(a, targetSet.principal, me),
          at: targetSet.at,
        }
      : null;
  const canSetTarget =
    Boolean(release) && (!team || (lead !== undefined && lead === me) || level === "admin");

  // Finished issues by day, from the project's first issue (at most 60 days back).
  const moves = (await deps.log.getEventsByTypes(["card/status_changed"])).filter((e) =>
    ids.has(String((e.payload as { id?: string }).id ?? e.cardId ?? "")),
  );
  // Each issue finished once: an issue reverted and accepted again counts at its last
  // move to Done (Projects' *Shipped this month* counts issues, not moves).
  const lastDone = new Map<string, string>();
  for (const e of moves) {
    const p = e.payload as { id?: string; toStatus?: string };
    if (p.toStatus === "done") lastDone.set(String(p.id ?? e.cardId ?? ""), e.createdAt);
  }
  const doneAt = [...lastDone.values()];
  const firstDay = cards.length
    ? Math.max(
        dayNo(isoDay(now)) - HISTORY_DAYS + 1,
        Math.min(...cards.map((c) => dayNo(c.createdAt))),
      )
    : dayNo(isoDay(now));
  const daily = Array.from({ length: Math.max(0, dayNo(isoDay(now)) - firstDay + 1) }, () => 0);
  for (const at of doneAt) {
    const i = dayNo(at) - firstDay;
    if (i >= 0 && i < daily.length) daily[i] = (daily[i] ?? 0) + 1;
  }
  const remaining = cards.filter((c) => !["done", "rejected", "parked"].includes(c.status)).length;
  const fc =
    daily.length >= FORECAST_MINIMUM
      ? monteCarloForecast(daily, remaining, 2000, deps.random)
      : undefined;
  const forecast: StatusFacts["forecast"] = {
    remaining,
    ...(fc ? { p50Days: fc.p50Days, p85Days: fc.p85Days } : {}),
    historyDays: daily.length,
    finished: daily.reduce((x, y) => x + y, 0),
    minimum: FORECAST_MINIMUM,
  };

  // Done this week, with who accepted each issue (never a count per person).
  const accepted = (await deps.log.getEventsByTypes(["card/accepted"]))
    .filter((e) => now - Date.parse(e.createdAt) <= UPDATE_DUE_DAYS * DAY)
    .map((e) => ({ e, p: e.payload as { id?: string; principal?: string; auto?: boolean } }))
    .filter(({ p }) => p.id !== undefined && ids.has(p.id))
    .map(({ e, p }) => ({
      title: title.get(p.id as string) ?? "",
      by: p.auto
        ? "the project's Accept rule"
        : nameFor(a, p.principal ?? e.principal ?? undefined, me),
      at: e.createdAt,
    }));

  // The flow strip (DB-N9-8): cycle times, throughput, sent back, first-time passes.
  const flowSince = now - FLOW_DAYS * DAY;
  const cycleHours = (await flowMetrics(deps.log, FLOW_DAYS, new Date(now))).cycleTime
    .filter((c) => ids.has(c.cardId))
    .map((c) => c.hours);
  const recent = moves.filter((e) => Date.parse(e.createdAt) >= flowSince);
  const finished = doneAt.filter((at) => Date.parse(at) >= flowSince).length;
  const sentBack = recent.filter((e) =>
    /^returned\b/.test(String((e.payload as { reason?: string }).reason ?? "")),
  ).length;
  const first = firstModelAttempts(deps.cardStore.runs.readAttemptOutcomes()).filter(
    (o) => ids.has(o.cardId) && Date.parse(o.completedAt) >= flowSince,
  );

  // TEAM-39: requests to start the Agent on this page's issues that wait on the viewer.
  const agentRequests = team
    ? (await startRequests({ cardStore: deps.cardStore, log: deps.log, audience: a }, { for: me }))
        .filter((r) => ids.has(r.cardId))
        .map((r) => ({
          id: r.id,
          cardId: r.cardId,
          title: r.title,
          requestedBy: r.requestedByName,
          ask: r.ask,
        }))
    : [];

  return {
    setup: team ? "team" : "solo",
    project: project ? { id: project.id, name: project.name } : null,
    ...(agentRequests.length ? { agentRequests } : {}),
    isLead,
    // The project lead (item 28; `project.health`). A release names no lead of its own yet.
    canSetHealth: Boolean(project) && isLead,
    healthWritable: true,
    health,
    release,
    target,
    canSetTarget,
    update,
    updateMissing,
    canPostUpdate,
    canUnpark,
    forecast,
    acceptedThisWeek: accepted,
    flow: {
      days: FLOW_DAYS,
      cycleHours,
      finished,
      sentBack,
      firstTime: { passed: first.filter((o) => o.passed).length, total: first.length },
    },
  };
}

/**
 * The live signals of one project, and only of what the person can see
 * (PM-N9-8): Status turns the fired ones into its risks (DB-N9-6), so a
 * project's page never carries another project's review queue, blocked
 * issues, failures or assumptions. A project the person cannot see reads as
 * no project; with none named, every project they can see. Served as
 * `GET /api/signals?project=` (PM_CONTRACT §3).
 */
export async function projectSignals(deps: {
  cardStore: CardStore;
  log: EventLog;
  /** Whether the person asking can see a project. */
  canSee: (project: string | undefined) => boolean;
  project?: string | undefined;
  /** The In review limit the board holds for this project (review-git §2.2, S6). */
  reviewWip: number;
  now?: Date;
}): Promise<SignalReading[]> {
  const project = deps.project;
  const cards = (await deps.cardStore.listCards()).filter((c) =>
    project ? c.projectId === project && deps.canSee(project) : deps.canSee(c.projectId),
  );
  const ids = new Set(cards.map((c) => c.id));
  // Each event of an issue on the page; an assumption's outcome only matches its own assumption.
  const events = (
    await deps.log.getEventsByTypes([
      "card/status_changed",
      "gate/result",
      "assumption/logged",
      "assumption/outcome",
    ])
  ).filter((e) => {
    if (e.type === "assumption/outcome") return true;
    const p = e.payload as { id?: unknown; cardId?: unknown };
    const card =
      e.cardId ??
      (typeof p.cardId === "string" ? p.cardId : undefined) ??
      (e.type === "card/status_changed" && typeof p.id === "string" ? p.id : undefined);
    return card !== undefined && ids.has(card);
  });
  return computeSignals({
    now: deps.now ?? new Date(),
    cards,
    events,
    reviewWip: deps.reviewWip,
  });
}
