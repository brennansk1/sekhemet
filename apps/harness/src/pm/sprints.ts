import { randomUUID } from "node:crypto";
import type { AppendEventParams, CardStore, EventLog, EventRecord } from "@sekhemet/kernel";
import { nextPlanned, nextSprintDefaults, sameProject, sprintStateLabel } from "@sekhemet/ui";
import { recordSprintClose } from "./judgement.js";
import { allEvents, estimationUnit } from "./standup.js";
import type { PmStore } from "./store.js";
import { type Cycle, PM_EVENTS } from "./types.js";

/**
 * The sprint lifecycle (planner-pm §2.7 item 7a, NEW-planner-pm-13; the
 * dashboard's controls are NEW-dashboard-11). A person starts a planned
 * sprint and completes the active one; each is one recorded group, written
 * all or nothing (K-S7-3). A project has at most one active sprint (DEC-51).
 * The report is computed from the ledger, never stored, never by a model.
 * Seshat only proposes a close (`close_cycle`, DEC-36): a completion's actor
 * is always a person.
 */

/**
 * DEC-57: the project a new sprint plans when none is named — the workspace's
 * only project (archived ones aside); undefined in a workspace of many,
 * where a sprint must name its project.
 */
export function onlyProjectOf(
  cardStore: Pick<CardStore, "listProjects"> | undefined,
): string | undefined {
  const projects = (cardStore?.listProjects() ?? []).filter((p) => p.status !== "archived");
  return projects.length === 1 ? projects[0]?.id : undefined;
}

export type CarryTo = "next" | "new" | "backlog";
export const CARRY_TO: readonly CarryTo[] = ["next", "new", "backlog"];

export interface SprintDeps {
  log: EventLog;
  cardStore: CardStore;
  pmStore: PmStore;
}

/** A refused start or completion: nothing was recorded. */
export class SprintRefusal extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}

/** The actors that are a person (kernel rule 19's): never Seshat or the Agent. */
const PERSON_ACTORS = new Set(["human", "mcp"]);

function personOnly(actor: string): void {
  if (!PERSON_ACTORS.has(actor)) {
    throw new SprintRefusal("Seshat proposes closing a sprint; a person completes it.", 403);
  }
}

/** One sprint operation at a time per ledger, so two starts cannot both pass the check. */
const queues = new WeakMap<EventLog, Promise<unknown>>();
function serially<T>(log: EventLog, step: () => Promise<T>): Promise<T> {
  const run = (queues.get(log) ?? Promise.resolve()).then(step, step);
  queues.set(
    log,
    run.catch(() => undefined),
  );
  return run;
}

async function sprintOf(
  deps: SprintDeps,
  cycleId: string,
): Promise<{ cycle: Cycle; all: Cycle[] }> {
  const all = await deps.pmStore.cycles();
  const cycle = all.find((c) => c.id === cycleId);
  if (!cycle) throw new SprintRefusal("No such sprint.", 404);
  return { cycle, all };
}

const word = (c: Cycle) => sprintStateLabel(c.state).toLowerCase();

/**
 * Start a planned sprint (PM-N13-1, DB-N11-1): `cycle/started` with the
 * issues assigned to it now, and their points with estimation on, and the
 * sprint active, in one group. Refused, naming the active sprint, while
 * another sprint of the project is active.
 */
export function startSprint(
  deps: SprintDeps,
  cycleId: string,
  opts: { principal?: string; actor?: string } = {},
): Promise<Cycle> {
  return serially(deps.log, async () => {
    const actor = opts.actor ?? "human";
    personOnly(actor);
    const { cycle, all } = await sprintOf(deps, cycleId);
    if (cycle.state !== "planned") {
      throw new SprintRefusal(`${cycle.name} is ${word(cycle)}; only a planned sprint starts.`);
    }
    const active = all.find(
      (c) => c.id !== cycle.id && c.state === "active" && sameProject(c, cycle),
    );
    if (active) {
      throw new SprintRefusal(
        `${active.name} is active. Complete it before you start ${cycle.name}.`,
      );
    }
    const issues = (await deps.cardStore.listCards())
      .filter((c) => c.cycleId === cycle.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const unit = await estimationUnit(
      deps.log,
      cycle.projectId ? [cycle.projectId] : issues.map((c) => c.projectId),
    );
    const points: Record<string, number> = {};
    for (const c of issues) if (typeof c.estimate === "number") points[c.id] = c.estimate;
    const who = opts.principal ? { principal: opts.principal } : {};
    deps.log.appendAllNow([
      {
        params: {
          actor,
          type: PM_EVENTS.cycleStarted,
          payload: {
            id: cycle.id,
            issues: issues.map((c) => c.id),
            ...(unit === "points" ? { points } : {}),
          },
          ...who,
        },
      },
      {
        params: {
          actor,
          type: PM_EVENTS.cycleUpdated,
          payload: { id: cycle.id, state: "active" },
          ...who,
        },
      },
    ]);
    return { ...cycle, state: "active" };
  });
}

export interface CompletedSprint {
  cycle: Cycle;
  /** Where the not-done issues went: the next planned sprint or the new one. */
  next?: Cycle;
  done: string[];
  carried: { issue: string; to: string }[];
}

/**
 * Complete the active sprint (PM-N13-2, DB-N11-2): each not-done issue moved
 * to `next` (the next planned sprint of the project, by `startsOn`), `new` (a
 * sprint created in the same group) or `backlog`, then `cycle/completed` and
 * the sprint closed — one group, all or nothing. A Won't do issue is
 * resolved, so it stays with the sprint, as Jira's resolved issues do.
 */
export function completeSprint(
  deps: SprintDeps,
  cycleId: string,
  carryTo: CarryTo,
  opts: {
    principal?: string;
    actor?: string;
    newSprint?: { name?: string; startsOn?: string; endsOn?: string; goal?: string };
  } = {},
): Promise<CompletedSprint> {
  return serially(deps.log, async () => {
    const actor = opts.actor ?? "human";
    personOnly(actor);
    if (!CARRY_TO.includes(carryTo)) {
      throw new SprintRefusal("Choose where the not-done issues go: next, new or backlog.", 400);
    }
    const { cycle, all } = await sprintOf(deps, cycleId);
    if (cycle.state !== "active") {
      throw new SprintRefusal(`${cycle.name} is ${word(cycle)}; only the active sprint completes.`);
    }
    const mine = (await deps.cardStore.listCards())
      .filter((c) => c.cycleId === cycle.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    const done = mine.filter((c) => c.status === "done").map((c) => c.id);
    const open = mine.filter((c) => c.status !== "done" && c.status !== "rejected");
    const who = opts.principal ? { principal: opts.principal } : {};
    const entries: { params: AppendEventParams<unknown>; project?: (e: EventRecord) => void }[] =
      [];
    let next: Cycle | undefined;
    if (carryTo === "next") {
      next = nextPlanned(cycle, all) as Cycle | undefined;
      if (!next) {
        throw new SprintRefusal(
          "There is no planned sprint to move the not-done issues to. Choose a new sprint or Backlog.",
        );
      }
    } else if (carryTo === "new") {
      const d = nextSprintDefaults(cycle, all);
      next = {
        id: `cycle_${randomUUID().slice(0, 8)}`,
        name: opts.newSprint?.name?.trim() || d.name,
        startsOn: opts.newSprint?.startsOn ?? d.startsOn,
        endsOn: opts.newSprint?.endsOn ?? d.endsOn,
        state: "planned",
        ...(opts.newSprint?.goal?.trim() ? { goal: opts.newSprint.goal.trim() } : {}),
        ...(cycle.projectId ? { projectId: cycle.projectId } : {}),
      };
      entries.push({ params: { actor, type: PM_EVENTS.cycleCreated, payload: next, ...who } });
    }
    const to = next?.id ?? null;
    const now = new Date().toISOString();
    for (const c of open) {
      entries.push({
        params: {
          actor,
          type: "card/updated",
          cardId: c.id,
          payload: { id: c.id, patch: { cycleId: to }, updatedAt: now },
          ...who,
        },
        project: (e) => {
          deps.cardStore.applyEvent(e);
        },
      });
    }
    const carried = open.map((c) => ({ issue: c.id, to: to ?? "backlog" }));
    entries.push({
      params: {
        actor,
        type: PM_EVENTS.cycleCompleted,
        payload: { id: cycle.id, done, carried },
        ...who,
      },
    });
    entries.push({
      params: {
        actor,
        type: PM_EVENTS.cycleUpdated,
        payload: { id: cycle.id, state: "closed" },
        ...who,
      },
    });
    deps.log.appendAllNow(entries);
    const closed: Cycle = { ...cycle, state: "closed" };
    // PM-P6-12: a sprint that closes has Seshat's measures recorded, once.
    await recordSprintClose({ cardStore: deps.cardStore, log: deps.log }, closed);
    // PM-N11-1: Seshat says the retrospective is drafted; Status holds it.
    const { retrospectiveReadyText } = await import("./retrospective.js");
    await deps.pmStore.appendReply({ replyTo: [], text: retrospectiveReadyText(cycle.name) });
    return { cycle: closed, ...(next ? { next } : {}), done, carried };
  });
}

/** The event types a sprint report replays. */
export const SPRINT_REPORT_TYPES = [
  "card/created",
  "card/updated",
  "card/status_changed",
  PM_EVENTS.cycleCreated,
  PM_EVENTS.cycleStarted,
  PM_EVENTS.cycleCompleted,
  "project/settings_changed",
];

export interface SprintBucket {
  issues: string[];
  points: number;
}

export interface SprintReport {
  cycleId: string;
  /** Points when every project of the sprint has estimation on (DB-N7-2), else issues. */
  unit: "issues" | "points";
  committed: SprintBucket;
  added: SprintBucket;
  removed: SprintBucket;
  completed: SprintBucket;
  carriedOver: SprintBucket & { to: Record<string, string> };
}

type ReportEvent = Pick<EventRecord, "seq" | "type" | "payload"> & { cardId?: string | null };

/**
 * A sprint's report (PM-N13-3, DB-N11-3), from the ledger alone: committed
 * (the issues in `cycle/started`), added (assigned after the start), removed
 * (taken out after the start, not by the completion's moves), completed
 * (Done when `cycle/completed` was recorded; Done now while it is active) and
 * carried over, as issues and points. Points are an issue's estimate at the
 * start for the committed issues and at the completion (or now) for the rest.
 * Undefined before the sprint starts. The same events give the same report.
 */
export function sprintReport(
  events: readonly ReportEvent[],
  cycleId: string,
): SprintReport | undefined {
  const cycleOf = new Map<string, string | null>();
  const estimate = new Map<string, number>();
  const status = new Map<string, string>();
  const project = new Map<string, string | undefined>();
  const estimation = new Map<string, string>();
  let sprintProject: string | undefined;
  let started: { issues: string[]; points: Record<string, number> } | undefined;
  let completed: { done: string[]; carried: { issue: string; to: string }[] } | undefined;
  const added = new Set<string>();
  const removals = new Map<string, number>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    switch (e.type) {
      case "card/created": {
        const id = String(p.id);
        cycleOf.set(id, typeof p.cycleId === "string" ? p.cycleId : null);
        if (typeof p.estimate === "number") estimate.set(id, p.estimate);
        if (typeof p.status === "string") status.set(id, p.status);
        project.set(id, typeof p.projectId === "string" ? p.projectId : undefined);
        break;
      }
      case "card/updated": {
        const id = String(p.id);
        const patch = (p.patch ?? {}) as Record<string, unknown>;
        if ("estimate" in patch) {
          if (typeof patch.estimate === "number") estimate.set(id, patch.estimate);
          else estimate.delete(id);
        }
        if (typeof patch.projectId === "string") project.set(id, patch.projectId);
        if ("cycleId" in patch) {
          const was = cycleOf.get(id) ?? null;
          const now = typeof patch.cycleId === "string" ? patch.cycleId : null;
          cycleOf.set(id, now);
          if (started && !completed && was !== now) {
            if (now === cycleId && !started.issues.includes(id)) added.add(id);
            if (was === cycleId) removals.set(id, (removals.get(id) ?? 0) + 1);
          }
        }
        break;
      }
      case "card/status_changed":
        if (typeof p.toStatus === "string") status.set(String(p.id), p.toStatus);
        break;
      case "cycle/created":
        if (p.id === cycleId && typeof p.projectId === "string") sprintProject = p.projectId;
        break;
      case "cycle/started":
        if (p.id === cycleId && !started) {
          const issues = Array.isArray(p.issues) ? p.issues.map(String) : [];
          const points: Record<string, number> = {};
          for (const id of issues) {
            const given = (p.points as Record<string, unknown> | undefined)?.[id];
            points[id] = typeof given === "number" ? given : (estimate.get(id) ?? 0);
          }
          started = { issues, points };
        }
        break;
      case "cycle/completed":
        if (p.id === cycleId && started && !completed) {
          completed = {
            done: Array.isArray(p.done) ? p.done.map(String) : [],
            carried: Array.isArray(p.carried)
              ? (p.carried as { issue: unknown; to: unknown }[]).map((c) => ({
                  issue: String(c.issue),
                  to: String(c.to),
                }))
              : [],
          };
          // A carried issue's last move out was the completion's own.
          for (const c of completed.carried) {
            const n = (removals.get(c.issue) ?? 0) - 1;
            if (n > 0) removals.set(c.issue, n);
            else removals.delete(c.issue);
          }
        }
        break;
      case "project/settings_changed":
        if (typeof p.project === "string" && typeof p.estimation === "string")
          estimation.set(p.project, p.estimation);
        break;
    }
  }
  if (!started) return undefined;
  const s = started;
  const pts = (id: string) => estimate.get(id) ?? 0;
  const bucket = (ids: Iterable<string>, at = pts): SprintBucket => {
    const issues = [...new Set(ids)].sort();
    return { issues, points: issues.reduce((n, id) => n + at(id), 0) };
  };
  const done = completed
    ? completed.done
    : [...cycleOf.entries()]
        .filter(([id, c]) => c === cycleId && status.get(id) === "done")
        .map(([id]) => id);
  const carried = completed?.carried ?? [];
  const projects = sprintProject
    ? [sprintProject]
    : [...new Set([...s.issues, ...added].map((id) => project.get(id)))].filter(
        (x): x is string => !!x,
      );
  const unit =
    projects.length > 0 && projects.every((id) => estimation.get(id) === "points")
      ? "points"
      : "issues";
  return {
    cycleId,
    unit,
    committed: bucket(s.issues, (id) => s.points[id] ?? 0),
    added: bucket(added),
    removed: bucket(removals.keys()),
    completed: bucket(done),
    carriedOver: {
      ...bucket(carried.map((c) => c.issue)),
      to: Object.fromEntries(carried.map((c) => [c.issue, c.to])),
    },
  };
}

/** A sprint's report read from `log` (PM-N13-3). */
export async function sprintReportOf(
  log: EventLog,
  cycleId: string,
): Promise<SprintReport | undefined> {
  return sprintReport(await allEvents(log, [...SPRINT_REPORT_TYPES]), cycleId);
}
