/**
 * The sprint lifecycle's page rules (dashboard §2.4 item 20, NEW-dashboard-11,
 * DB-N11-1..5; planner-pm §2.7 item 7a). A sprint is the internal *cycle*
 * (DEC-31): *planned*, *active* or *completed* (stored `closed`, DEC-52). One
 * sprint of a project is active at a time. These are pure: the browser loads
 * the compiled module as `/app/lib/sprints.js`, and the server takes the next
 * sprint's defaults from here, so the sheet shows what *a new sprint* creates.
 */
import { type CycleLike, type PmCardLike, activeCycle, formatShortDate, slug } from "./pm.js";

export interface SprintLike extends CycleLike {
  /** The project the sprint is in; none on a sprint from before many projects (DEC-57). */
  projectId?: string;
}

export type SprintAction = "start" | "complete" | "report";
export type CarryTo = "next" | "new" | "backlog";

export const SPRINT_COPY = {
  start: "Start sprint",
  complete: "Complete sprint",
  report: "Sprint report",
  newSprint: "New sprint",
  plan: "Plan a sprint with Seshat",
  noSprints: "No sprints yet",
  done: "Done",
  open: "Not done",
  wontDo: "Won't do, stays with this sprint",
  carryHeading: "Move the not-done issues to",
  nextLabel: "The next planned sprint",
  nextDetail: "The next planned sprint",
  noNext: "No planned sprint yet",
  newLabel: "A new sprint",
  backlog: "Backlog",
  backlogDetail: "No sprint",
  completed: "Sprint completed",
  started: "Sprint started",
  noStartRecorded: "It was active before Sekhemet recorded sprint starts, so it has no report.",
} as const;

const STATE_LABELS: Record<CycleLike["state"], string> = {
  planned: "Planned",
  active: "Active",
  closed: "Completed",
};

/** The on-screen word for a sprint's state: *completed*, never the stored `closed`. */
export function sprintStateLabel(state: CycleLike["state"]): string {
  return STATE_LABELS[state] ?? "Planned";
}

/** Two sprints are in one project; a sprint with no project spans the workspace. */
export function sameProject(
  a: Pick<SprintLike, "projectId">,
  b: Pick<SprintLike, "projectId">,
): boolean {
  return !a.projectId || !b.projectId || a.projectId === b.projectId;
}

const DAY_MS = 86_400_000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const at = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

/**
 * The sprint *a new sprint* creates after `cycle`: its number one more than
 * the project's highest (`Sprint 3` after `Sprint 2`; `Polish 2` after
 * `Polish`), starting the day after the later of `cycle` and the project's
 * planned sprints, as long as `cycle`.
 */
export function nextSprintDefaults(
  cycle: SprintLike,
  cycles: readonly SprintLike[],
): { name: string; startsOn: string; endsOn: string } {
  const project = cycles.filter((c) => c.id !== cycle.id && sameProject(c, cycle));
  const base = /^(.*?)\s*(\d+)$/.exec(cycle.name.trim());
  const stem = (base ? base[1] : cycle.name.trim()) || "Sprint";
  let n = base ? Number(base[2]) : 1;
  for (const c of project) {
    const m = /^(.*?)\s*(\d+)$/.exec(c.name.trim());
    if (m && (m[1] || "Sprint") === stem) n = Math.max(n, Number(m[2]));
  }
  const names = new Set([cycle, ...project].map((c) => c.name.trim()));
  let name = `${stem} ${n + 1}`;
  while (names.has(name)) name = `${stem} ${++n + 1}`;
  const length = Math.max(1, Math.round((at(cycle.endsOn) - at(cycle.startsOn)) / DAY_MS));
  const last = [cycle, ...project.filter((c) => c.state === "planned")]
    .map((c) => at(c.endsOn))
    .reduce((a, b) => Math.max(a, b), 0);
  const start = last + DAY_MS;
  return { name, startsOn: day(start), endsOn: day(start + length * DAY_MS) };
}

/** The next planned sprint of `cycle`'s project, by `startsOn`. */
export function nextPlanned(
  cycle: SprintLike,
  cycles: readonly SprintLike[],
): SprintLike | undefined {
  return cycles
    .filter((c) => c.id !== cycle.id && c.state === "planned" && sameProject(c, cycle))
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.id.localeCompare(b.id))[0];
}

export interface CarryOption {
  value: CarryTo;
  label: string;
  detail: string;
  disabled?: boolean;
}

export interface SprintLifecycleView<C extends PmCardLike> {
  stateLabel: string;
  /** What the sprint offers: Start (planned), Complete (active), and its report once started. */
  actions: SprintAction[];
  /** The project's active sprint that refuses a start (DB-N11-1). */
  blockedBy?: string;
  done: C[];
  open: C[];
  /** Won't do: resolved, so not carried; it stays with the sprint. */
  wontDo: C[];
  next?: SprintLike;
  carryOptions: CarryOption[];
  newSprint: { name: string; startsOn: string; endsOn: string };
}

/** The actions a sprint offers and the Complete sheet's model (DB-N11-1, -2, -3). */
export function sprintLifecycle<C extends PmCardLike>(
  cycle: SprintLike,
  cycles: readonly SprintLike[],
  cards: readonly C[],
): SprintLifecycleView<C> {
  const mine = cards.filter((c) => c.cycleId === cycle.id);
  const done = mine.filter((c) => c.status === "done");
  const wontDo = mine.filter((c) => c.status === "rejected");
  const open = mine.filter((c) => c.status !== "done" && c.status !== "rejected");
  const actions: SprintAction[] =
    cycle.state === "planned"
      ? ["start"]
      : cycle.state === "active"
        ? ["complete", "report"]
        : ["report"];
  const active = cycles.find(
    (c) => c.id !== cycle.id && c.state === "active" && sameProject(c, cycle),
  );
  const next = nextPlanned(cycle, cycles);
  const newSprint = nextSprintDefaults(cycle, cycles);
  const carryOptions: CarryOption[] = [
    next
      ? { value: "next", label: next.name, detail: SPRINT_COPY.nextDetail, disabled: false }
      : { value: "next", label: SPRINT_COPY.nextLabel, detail: SPRINT_COPY.noNext, disabled: true },
    {
      value: "new",
      label: SPRINT_COPY.newLabel,
      detail: `${newSprint.name}, ${formatShortDate(newSprint.startsOn)} – ${formatShortDate(newSprint.endsOn)}`,
    },
    { value: "backlog", label: SPRINT_COPY.backlog, detail: SPRINT_COPY.backlogDetail },
  ];
  return {
    stateLabel: sprintStateLabel(cycle.state),
    actions,
    ...(cycle.state === "planned" && active ? { blockedBy: active.name } : {}),
    done,
    open,
    wontDo,
    ...(next ? { next } : {}),
    carryOptions,
    newSprint,
  };
}

/** The server's sprint report (planner-pm PM-N13-3): each bucket in issues and points. */
export interface SprintReportLike {
  cycleId: string;
  unit: "issues" | "points";
  committed: { issues: string[]; points: number };
  added: { issues: string[]; points: number };
  removed: { issues: string[]; points: number };
  completed: { issues: string[]; points: number };
  carriedOver: { issues: string[]; points: number; to: Record<string, string> };
}

export interface SprintReportRow {
  key: "committed" | "added" | "removed" | "completed" | "carriedOver";
  label: string;
  value: string;
  issues: string[];
}

const REPORT_LABELS: [SprintReportRow["key"], string][] = [
  ["committed", "Committed at start"],
  ["added", "Added after start"],
  ["removed", "Removed after start"],
  ["completed", "Completed"],
  ["carriedOver", "Carried over"],
];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The report's five rows, in points with estimation on, else in issues (DB-N11-3). */
export function sprintReportRows(report: SprintReportLike): SprintReportRow[] {
  return REPORT_LABELS.map(([key, label]) => {
    const b = report[key];
    const issues = count(b.issues.length, "issue", "issues");
    return {
      key,
      label,
      value:
        report.unit === "points" ? `${count(b.points, "point", "points")} · ${issues}` : issues,
      issues: [...b.issues],
    };
  });
}

/**
 * The sprint the board's header shows: the one the filter names, in any
 * state (so a planned sprint offers Start and a completed one its report), or
 * the sprint in force; none for `sprint:none`.
 */
export function headerSprint(
  cycles: readonly SprintLike[] | undefined,
  filterValues: readonly string[],
  now = Date.now(),
): SprintLike | undefined {
  if (filterValues.includes("none")) return undefined;
  const named = filterValues.filter((v) => v !== "current");
  if (named.length === 1) {
    const v = named[0] as string;
    const hit = (cycles ?? []).find((c) => c.id.toLowerCase() === v || slug(c.name) === v);
    if (hit) return hit;
  }
  if (named.length > 0) return undefined;
  return activeCycle(cycles as CycleLike[] | undefined, now) as SprintLike | undefined;
}

/** DB-N11-5: an action that needs a sprint, with none: two offers, no API path. */
export function noSprintOptions(): { value: string; label: string; detail: string }[] {
  return [
    {
      value: "__new_sprint__",
      label: `${SPRINT_COPY.newSprint}…`,
      detail: "Name it and pick its dates",
    },
    { value: "__plan_sprint__", label: SPRINT_COPY.plan, detail: "Seshat proposes one" },
  ];
}
