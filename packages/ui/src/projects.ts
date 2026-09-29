/**
 * Projects, the workspace's home (dashboard §2.11, DB-N9-9, DB-N9-21; teams
 * item 5), replacing the Workspace rollup, as a pure model. It reads like a
 * Linear or Jira projects list: the workspace's totals above one row per
 * project the person can see — health set by a person, the current release
 * and its progress, the forecast as a range with its target, what waits on
 * the person, what the Agent is doing and the lead — then the Waiting on you
 * list across projects and the models on this server with their load.
 *
 * The facts are `GET /api/projects/overview` (PM_CONTRACT §3); every word is
 * built here. No per-person count, rate or ranking (DB-N9-7); in Solo no
 * *No health set* and no *Update missing* (DB-N9-21). The forecast and the
 * health words are Status's own (`forecastDates`, `HEALTH_LABELS`).
 * `web/projects.js` renders this; the browser loads it as `/app/lib/projects.js`.
 */
import { type RosterRoleLike, formatShortDate, rosterRows } from "./pm.js";
import {
  HEALTH_LABELS,
  type HealthValue,
  type StatusFacts,
  type StatusTone,
  allDone,
  forecastDates,
} from "./status.js";
import { formatWait, parseTitle, plural } from "./vocabulary.js";

// --- Inputs ------------------------------------------------------------------

/** One project the person can see, as `GET /api/projects/overview` gives it. */
export interface ProjectFacts {
  id: string;
  name: string;
  /** The project's rollup (kernel K-N5-3). */
  state: "active" | "idle" | "done" | "paused" | "archived";
  /** The lead's name ("you" for the viewer), or null when none is named. */
  lead: string | null;
  /** Set by a person (teams TEAM-28); null until someone sets it. */
  health: { value: HealthValue; by: string; at: string } | null;
  /** Team only: 7 days without a posted update, told to the lead (TEAM-29). */
  updateMissing: boolean;
  /** The current release on the story map, requirements done of those not cut. */
  release: { name: string; done: number; total: number } | null;
  forecast: StatusFacts["forecast"];
  /** A release's target date, or null: none is recorded yet (DB-N9-3, DEC-37). */
  target: string | null;
  /** Issues and questions waiting on the viewer in this project. */
  waitingOnYou: number;
  /** The Agent's current issues here, by title, and how many are queued. */
  agent: { working: string[]; queued: number };
}

export interface WaitingFacts {
  projectId: string;
  project: string;
  cardId: string;
  title: string;
  /** A plan is one waiting for the person's approval of its criteria (Status's *Needs you*). */
  kind: "review" | "decision" | "parked" | "plan";
  /** A decision's question. */
  question?: string;
  /** When it began waiting. */
  since: string;
}

/** `GET /api/projects/overview`. */
export interface ProjectsOverview {
  setup: "solo" | "team";
  projects: ProjectFacts[];
  waiting: WaitingFacts[];
  /** Issues finished this calendar month in the projects the person can see. */
  shippedThisMonth: number;
  /** Seconds of the Agent's attempts that finished today. */
  agentSecondsToday: number;
  models: {
    roles: RosterRoleLike[];
    /** The Coding model's slots (RUN-35) and the issues running in them. */
    slots: { inUse: number; capacity: number };
    /** Ready issues waiting for a slot. */
    queue: number;
    memory: { usedBytes: number; totalBytes: number } | null;
  };
}

export interface ProjectsInput {
  now: number;
  /** null when the server has no overview route. */
  overview: ProjectsOverview | null;
}

// --- Output ------------------------------------------------------------------

export interface ProjectTotal {
  id: "waiting" | "active" | "shipped" | "agent";
  label: string;
  value: string;
  detail?: string;
  /** The label names the Agent: the page shows the *AI* badge beside it (DB-N9-18). */
  ai?: boolean;
}

export interface ProjectRow {
  id: string;
  name: string;
  state: string;
  health: { text: string; tone: StatusTone } | null;
  updateMissing: string | null;
  release: string;
  progress: { done: number; total: number; text: string } | null;
  forecast: string;
  target: string;
  waiting: string;
  agent: string;
  lead: string;
}

export interface WaitingItem {
  projectId: string;
  project: string;
  text: string;
  wait: string;
  action: string;
  href: string;
}

export interface ModelRow {
  label: string;
  model: string;
  state: string;
  load: string;
  /** The label names Seshat: the *AI* badge goes beside it (DB-N9-18). */
  seshat: boolean;
}

export interface ProjectsView {
  title: string;
  crumb: string;
  /** The primary action, when there are projects (the empty state has its own button). */
  newProject: string | null;
  empty: { heading: string; detail: string; button: string } | null;
  /** The server has no Projects route yet. */
  unavailable?: string;
  totals: ProjectTotal[];
  /** The table's columns: Solo has a Health column only once a health is set (TEAM-45). */
  columns: readonly { id: keyof ProjectRow; label: string; ai?: boolean }[];
  rows: ProjectRow[];
  waiting: { heading: string; items: WaitingItem[]; empty: string } | null;
  models: { heading: string; rows: ModelRow[]; memory: string } | null;
}

// --- Words -------------------------------------------------------------------

/** The table's columns, left to right; the Agent's carries the *AI* badge. */
export const PROJECTS_COLUMNS: readonly { id: keyof ProjectRow; label: string; ai?: boolean }[] = [
  { id: "name", label: "Project" },
  { id: "health", label: "Health" },
  { id: "release", label: "Release" },
  { id: "forecast", label: "Forecast" },
  { id: "target", label: "Target" },
  { id: "waiting", label: "Waiting on you" },
  { id: "agent", label: "Agent", ai: true },
  { id: "lead", label: "Lead" },
];

/** Every other word of the page (DEC-31). */
export const PROJECTS_COPY = {
  title: "Projects",
  newProject: "New project",
  startFirst: "Start your first project",
  startDetail: "Tell Seshat what you want to build; it plans the first issues with you.",
  waiting: "Waiting on you",
  waitingEmpty: "Nothing is waiting on you.",
  models: "Models on this server",
  tableLabel: "Projects you can see",
  notOnServer: "The Projects page isn't on this server yet.",
  notOnServerDetail: "Update Sekhemet and restart it.",
} as const;

const STATE_WORDS: Record<ProjectFacts["state"], string> = {
  active: "Active",
  idle: "Idle",
  done: "Done",
  paused: "Paused",
  archived: "Archived",
};

/** The roster's states in plain words (Configuration › Models has the detail). */
const MODEL_STATE_WORDS: Record<string, string> = {
  resident: "Loaded",
  swapped: "Not loaded",
  unconfigured: "Not set",
};

const titleOf = (raw: string) => parseTitle(raw).title;
const GB = 1024 ** 3;
const gb = (bytes: number) => String(Math.round((bytes / GB) * 10) / 10);
const capital = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);

function waitingItem(w: WaitingFacts, now: number): WaitingItem & { ms: number } {
  const title = titleOf(w.title);
  const ms = Math.max(0, now - Date.parse(w.since));
  const base = {
    projectId: w.projectId,
    project: w.project,
    wait: `Waiting ${formatWait(ms)}`,
    ms,
  };
  switch (w.kind) {
    case "review":
      return {
        ...base,
        text: `${title} is waiting for your review.`,
        action: "Review it",
        href: `#/review/${w.cardId}`,
      };
    case "plan":
      return {
        ...base,
        text: `${title} has a plan waiting for your approval.`,
        action: "Review plan",
        href: `#/card/${w.cardId}/plan`,
      };
    case "decision":
      return {
        ...base,
        text: w.question
          ? `${title} needs your answer: ${w.question}`
          : `${title} needs your answer.`,
        action: "Answer",
        href: "#/inbox",
      };
    default:
      return {
        ...base,
        text: `${title} is on hold.`,
        action: "Open",
        href: `#/card/${w.cardId}`,
      };
  }
}

function agentWords(a: ProjectFacts["agent"]): string {
  const working = a.working.map(titleOf);
  const doing = working.length
    ? `Working on ${working[0]}${working.length > 1 ? ` and ${working.length - 1} more` : ""}`
    : "";
  const queued = a.queued ? `${a.queued} queued` : "";
  return [doing, queued].filter(Boolean).join(" · ") || "Idle";
}

// --- The model ---------------------------------------------------------------

export function projectsModel(input: ProjectsInput): ProjectsView {
  const { now } = input;
  const o = input.overview;
  const base = {
    title: PROJECTS_COPY.title,
    totals: [] as ProjectTotal[],
    columns: PROJECTS_COLUMNS,
    rows: [] as ProjectRow[],
    waiting: null,
    models: null,
  };
  if (!o)
    return {
      ...base,
      crumb: "",
      newProject: null,
      empty: null,
      unavailable: PROJECTS_COPY.notOnServer,
    };
  const team = o.setup === "team";
  const projects = o.projects.filter((p) => p.state !== "archived");

  // DB-N9-21: with no projects, one empty state and nothing else.
  if (projects.length === 0) {
    return {
      ...base,
      crumb: "",
      newProject: null,
      empty: {
        heading: PROJECTS_COPY.startFirst,
        detail: PROJECTS_COPY.startDetail,
        button: PROJECTS_COPY.startFirst,
      },
    };
  }

  const waitingItems = o.waiting
    .map((w) => waitingItem(w, now))
    .sort((a, b) => b.ms - a.ms)
    .map(({ ms: _ms, ...w }) => w);

  const agentTime = o.agentSecondsToday > 0 ? formatWait(o.agentSecondsToday * 1000) : "None yet";
  const totals: ProjectTotal[] = [
    { id: "waiting", label: "Waiting on you", value: String(waitingItems.length) },
    {
      id: "active",
      label: "Active projects",
      value: String(projects.filter((p) => p.state === "active").length),
    },
    {
      id: "shipped",
      label: "Shipped this month",
      value: String(o.shippedThisMonth),
      detail: "issues finished",
    },
    { id: "agent", label: "Agent time today", value: agentTime, ai: true },
  ];

  const rows: ProjectRow[] = projects.map((p) => {
    const dates = forecastDates(p.forecast, now);
    const health = p.health
      ? {
          text: `${HEALTH_LABELS[p.health.value]?.label ?? "Health set"} · set by ${p.health.by} · ${formatShortDate(p.health.at)}`,
          tone: HEALTH_LABELS[p.health.value]?.tone ?? ("" as StatusTone),
        }
      : team
        ? { text: "No health set", tone: "" as StatusTone }
        : null;
    return {
      id: p.id,
      name: p.name,
      state: STATE_WORDS[p.state] ?? capital(p.state),
      health,
      updateMissing: team && p.updateMissing ? "Update missing" : null,
      release: p.release?.name ?? "No release planned",
      progress: p.release
        ? {
            done: p.release.done,
            total: p.release.total,
            text: `${p.release.done} of ${plural(p.release.total, "requirement")} done`,
          }
        : null,
      forecast: allDone(p.forecast)
        ? "All issues done"
        : dates
          ? `50% ${formatShortDate(dates.p50)} · 85% ${formatShortDate(dates.p85)}`
          : "Not enough history yet",
      target: p.target ? formatShortDate(p.target) : "No target set",
      waiting: p.waitingOnYou ? plural(p.waitingOnYou, "item") : "None",
      agent: agentWords(p.agent),
      lead: p.lead ? capital(p.lead) : "No lead",
    };
  });

  const { slots, queue, memory } = o.models;
  const modelRows: ModelRow[] = rosterRows(o.models.roles).map((r) => ({
    label: r.label,
    model: r.model ?? "Not set",
    state: MODEL_STATE_WORDS[r.state] ?? "Not set",
    load:
      r.role === "worker"
        ? `${slots.inUse} of ${plural(slots.capacity, "slot")} in use · ${queue ? `${queue} in queue` : "nothing queued"}`
        : "",
    seshat: r.role === "manager",
  }));

  return {
    ...base,
    crumb: `${plural(projects.length, "project")} ${team ? "you can see" : "on this machine"}`,
    // Solo: health is optional (TEAM-45), so the column shows only once the person set one.
    columns:
      team || projects.some((p) => p.health)
        ? PROJECTS_COLUMNS
        : PROJECTS_COLUMNS.filter((c) => c.id !== "health"),
    newProject: PROJECTS_COPY.newProject,
    empty: null,
    totals,
    rows,
    waiting: {
      heading: PROJECTS_COPY.waiting,
      items: waitingItems,
      empty: PROJECTS_COPY.waitingEmpty,
    },
    models: {
      heading: PROJECTS_COPY.models,
      rows: modelRows,
      memory: memory
        ? `Memory in use: ${gb(memory.usedBytes)} of ${gb(memory.totalBytes)} GB`
        : "Memory in use: not measured",
    },
  };
}
