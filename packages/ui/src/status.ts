/**
 * Status, the project page for the stakeholder and the team (dashboard §2.8,
 * DB-P5-1, DB-P5-2, DB-N9-1..8, DEC-37), as a pure model. One page from the
 * same data for a person who is not a software engineer and for the people
 * building the project: a headline of facts, health set by a person, the
 * latest update, the key numbers with the forecast as a range, what needs
 * you and what waits on others, requirements by MoSCoW group, risks with a
 * suggestion and its reason, today's changes, Done this week, who is on
 * what, the models line and the flow strip.
 *
 * Every word is plain (§2.8.13): titles, never bare issue ids; no stop-reason
 * code or gate id. No per-person count, rate or ranking (DB-N9-7).
 * `web/status.js` renders this; the browser loads it as `/app/lib/status.js`.
 */
import { type CycleLike, activeCycle, formatHours, formatShortDate, percentile } from "./pm.js";
import { formatWait, parseTitle, plural, stopReasonLabel } from "./vocabulary.js";

// --- Inputs ------------------------------------------------------------------

/** A board card (`GET /api/board`), the fields Status reads. */
export interface StatusCardLike {
  id: string;
  title: string;
  status: string;
  tier?: string;
  owner?: string | null;
  delegate?: string | null;
  blockedReason?: string | null;
  stopReason?: string | null;
  updatedAt?: string;
  display?: { ownerName?: string; delegateName?: string };
}

export type HealthValue = "on_track" | "at_risk" | "off_track";

/** `GET /api/status` (PM_CONTRACT §3): what only the server knows. */
export interface StatusFacts {
  setup: "solo" | "team";
  project?: { id: string; name: string } | null;
  /** The viewer leads the project (or, in Solo, is its one person). */
  isLead: boolean;
  /** The viewer may set health: the project lead or a release lead (TEAM-28). */
  canSetHealth: boolean;
  /** Whether the server records health yet (B4.11, teams NEW-teams-11). */
  healthWritable: boolean;
  health?: { value: HealthValue; by: string; at: string } | null;
  update?: { text: string; by: string; at: string } | null;
  /** Team only: 7 days without a posted update, shown to the lead (TEAM-29). */
  updateMissing: boolean;
  canPostUpdate: boolean;
  /** The viewer may unpark an issue (the `review` permission, a Member's; always in Solo). */
  canUnpark: boolean;
  /** Monte Carlo over issue throughput (planner-pm §2.6 item 3): day counts, never one date. */
  forecast: {
    /** Open issues of the project. */
    remaining: number;
    p50Days?: number;
    p85Days?: number;
    /** Days of history the forecast resamples, and the issues finished in them. */
    historyDays: number;
    finished: number;
    minimum: number;
  };
  acceptedThisWeek: { title: string; by: string; at: string }[];
  /** The project's flow over the last `days` (Insights has the charts). */
  flow: {
    days: number;
    /** Each finished issue's cycle time, in hours. */
    cycleHours: number[];
    finished: number;
    sentBack: number;
    /** Issues whose first attempt passed its checks, of those attempted. */
    firstTime: { passed: number; total: number };
  };
}

export interface StatusRequirementLike {
  id: string;
  title?: string;
  mustHave: boolean;
  kano?: string;
  state: string;
  cards: { id: string; status?: string; suspect: boolean }[];
}

export interface StatusSliceLike {
  id: string;
  title?: string;
  state: string;
  appetite?: { cards?: number; hours?: number };
  appetiteReached?: boolean;
  accepted?: boolean;
  requirements: StatusRequirementLike[];
}

/** `GET /api/story-map`: the fields Status reads. */
export interface StatusStoryMapLike {
  slices: StatusSliceLike[];
}

/** `GET /api/standup`. */
export interface StandupLike {
  byState: Record<string, { id: string; title: string }[]>;
  decisionsWaiting: { id: string; cardId?: string; question: string; waitingHours: number }[];
}

/** `GET /api/signals`: one live signal's reading. */
export interface SignalLike {
  id: string;
  value: number;
  threshold?: number;
  triggered: boolean;
  response?: { action: string; mode: string; targets: string[] };
}

export interface StatusInput {
  now: number;
  /** The viewer's principal. */
  me?: string;
  facts?: StatusFacts | null;
  cards: StatusCardLike[];
  cycles?: CycleLike[];
  storyMap?: StatusStoryMapLike | null;
  standup?: StandupLike | null;
  signals?: SignalLike[] | null;
  /** `GET /api/queue/standing`. */
  standing?: { place: number; estimateSeconds: number }[] | null;
}

// --- Output ------------------------------------------------------------------

export type StatusTone = "pass" | "parked" | "fail" | "running" | "";

export interface KeyNumber {
  id: "forecast" | "requirements" | "issues" | "sprint" | "attention";
  label: string;
  value: string;
  detail?: string;
  /** A section of this page the number jumps to (never a hash link: that is a route). */
  jump?: "needs";
}

export interface StatusButton {
  label: string;
  href?: string;
  act?: "unpark" | "slice-accept" | "slice-cut" | "slice-extend";
  id?: string;
  ids?: string[];
  /** Extend: the release's card appetite now, which the new one must exceed. */
  cards?: number;
}

export interface NeedsYouItem {
  kind: "review" | "decision" | "parked" | "slice" | "plan";
  text: string;
  buttons: StatusButton[];
}

export type RequirementWord = "done" | "in_progress" | "tests_too_weak" | "blocked" | "not_started";

export interface RequirementRow {
  id: string;
  title: string;
  state: RequirementWord;
  label: string;
  tone: StatusTone;
}

export interface RiskItem {
  sentence: string;
  suggested: string;
  why: string;
  action?: { label: string; href: string };
}

export interface StatusView {
  headline: string;
  health: { text: string; tone: StatusTone } | null;
  setHealth: boolean;
  update: { text: string; byline: string } | null;
  updateMissing: string | null;
  writeUpdate: boolean;
  numbers: KeyNumber[];
  appetite?: string;
  forecast: { band?: { from: string; to: string }; target?: string };
  needsYou: { items: NeedsYouItem[]; empty: string };
  waiting: { items: string[]; empty: string } | null;
  requirements: {
    groups: { label: string; summary: string; rows: RequirementRow[] }[];
    empty?: string;
  };
  risks: { items: RiskItem[]; empty: string };
  standup: { lines: string[]; empty: string };
  doneThisWeek: { items: string[]; empty: string };
  working: { rows: { who: string; ai: boolean; item: string }[]; empty: string };
  models: string;
  flow: { items: { label: string; value: string; href: string }[]; note?: string };
}

// --- Words -------------------------------------------------------------------

/**
 * The page's sections below the headline, health and update, in §2.8's order
 * (DB-N9-1); `web/status.js` renders one per entry. Waiting on others shows
 * in the Team setup only.
 */
export const STATUS_SECTIONS = [
  { id: "numbers", heading: "Key numbers" },
  { id: "burnup", heading: "Burn-up" },
  { id: "needs", heading: "Needs you" },
  { id: "waiting", heading: "Waiting on others" },
  { id: "requirements", heading: "Requirements" },
  { id: "risks", heading: "Risks" },
  { id: "done", heading: "Done this week" },
  { id: "today", heading: "Today's changes" },
  { id: "working", heading: "Who's working on what" },
  { id: "models", heading: "Models" },
  { id: "flow", heading: "Flow" },
  { id: "ask", heading: "Ask Seshat" },
] as const;

/** Every other word of the page's controls (DEC-31). */
export const STATUS_COPY = {
  title: "Status",
  writeUpdate: "Write update",
  setHealth: "Set health",
  updateLabel: "Project update",
  updateHint:
    "Seshat drafted this from the project's history in five parts: status, done, next, risks and asks. Edit it; nothing is posted until you press Post.",
  post: "Post",
  cancel: "Cancel",
  posted: "Update posted.",
  loadingDraft: "Seshat is drafting the update…",
  extendLabel: "New appetite, in issues",
  save: "Save",
  askLabel: "Ask Seshat about this project",
  askPlaceholder: "How is it going? What's at risk?",
  ask: "Ask",
  startProject: "Start a new project",
  notOnServer: "Status isn't on this server yet.",
  notOnServerDetail: "Update Sekhemet and restart it.",
  loadFailed: "Couldn't load the project's facts.",
  loadFailedDetail:
    "Health, the update, the forecast and the flow are missing below. Reload the page to try again.",
} as const;

export const HEALTH_LABELS: Record<HealthValue, { label: string; tone: StatusTone }> = {
  on_track: { label: "On track", tone: "pass" },
  at_risk: { label: "At risk", tone: "parked" },
  off_track: { label: "Off track", tone: "fail" },
};

const REQUIREMENT_WORDS: Record<RequirementWord, { label: string; tone: StatusTone }> = {
  done: { label: "Done", tone: "pass" },
  in_progress: { label: "In progress", tone: "running" },
  tests_too_weak: { label: "Tests too weak", tone: "parked" },
  blocked: { label: "Blocked", tone: "fail" },
  not_started: { label: "Not started", tone: "" },
};

const WORD_ORDER: RequirementWord[] = [
  "done",
  "in_progress",
  "tests_too_weak",
  "blocked",
  "not_started",
];

/** The four questions of the flow strip link where the charts answer them (§2.10). */
const INSIGHTS = "#/insights";
/** Insights' own minimum (§2.10.6): three finished issues before any percentile. */
const FLOW_MINIMUM = 3;
const DAY = 86_400_000;
const WEEK = 7 * DAY;

const APPROVAL_HOLD = /Waiting on a person's approval of its criteria/;
const titleOf = (raw: string) => parseTitle(raw).title;
const isWork = (c: StatusCardLike) => !c.tier || c.tier === "story" || c.tier === "task";
const isBlocked = (status?: string, blockedReason?: string | null) =>
  status === "parked" || Boolean(blockedReason);

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) / DAY);
}

/** Known issue ids in a sentence become their titles (DB-P5-2: no bare ids). */
function withTitles(text: string, titles: Map<string, string>): string {
  return text.replace(/\bcard_[A-Za-z0-9_.:-]+/g, (id) => titles.get(id) ?? "an issue");
}

/**
 * A requirement's state in the page's five words (§2.8.5): the on-screen
 * words for §2.4.17's proven, planned, passing with strength unmet and
 * unplanned; blocked when an issue it traces to is blocked. *Tests too weak*
 * is never done. Failing on main and suspect are work still in progress.
 */
export function requirementWord(
  r: StatusRequirementLike,
  blocked: (cardId: string) => boolean,
): RequirementWord {
  if (r.state === "proven") return "done";
  if (r.state === "passing_strength_unmet") return "tests_too_weak";
  if (r.cards.some((c) => blocked(c.id))) return "blocked";
  if (r.state === "unplanned") return "not_started";
  return "in_progress";
}

/**
 * DEC-31: Must have, Should have, Could have — the same rule the project
 * documents use (`project_docs.ts` `moscowOf`): a performance feature is a
 * Should have, any other that is not a Must have a Could have.
 */
export function moscowOf(r: StatusRequirementLike): "Must have" | "Should have" | "Could have" {
  if (r.mustHave) return "Must have";
  return r.kano === "performance" ? "Should have" : "Could have";
}

function releaseName(slice: StatusSliceLike, index: number): string {
  return slice.title?.trim() ? slice.title.trim() : `Release ${index + 1}`;
}

/**
 * The forecast's 50% and 85% dates (DB-N9-3), or undefined when the server
 * gave no range (below the minimum history): a range or nothing, never one date.
 * Status and Projects read the forecast through this one function.
 */
export function forecastDates(
  fc: StatusFacts["forecast"] | undefined,
  now: number,
): { p50: string; p85: string } | undefined {
  if (!fc || fc.p50Days === undefined || fc.p85Days === undefined) return undefined;
  if (allDone(fc)) return undefined;
  return { p50: isoDay(now + fc.p50Days * DAY), p85: isoDay(now + fc.p85Days * DAY) };
}

/**
 * Every issue of the project is finished: the forecast is *All issues done*,
 * never a range whose two dates are both today (DB-N9-3).
 */
export function allDone(fc: StatusFacts["forecast"] | undefined): boolean {
  return Boolean(fc && fc.remaining === 0 && fc.finished > 0);
}

/**
 * The current release: the first on the story map not done yet (the first
 * when every release is done), with its requirements done out of those not
 * cut. *Tests too weak* is never done. Status and Projects share it.
 */
export function currentRelease(slices: StatusSliceLike[]):
  | {
      slice: StatusSliceLike;
      name: string;
      done: number;
      total: number;
      live: StatusRequirementLike[];
      weak: number;
      suspect: StatusRequirementLike[];
    }
  | undefined {
  const index = Math.max(
    0,
    slices.findIndex((s) => s.state !== "done"),
  );
  const slice = slices[index];
  if (!slice) return undefined;
  const live = slice.requirements.filter((r) => r.state !== "cut");
  return {
    slice,
    name: releaseName(slice, index),
    done: live.filter((r) => r.state === "proven").length,
    total: live.length,
    live,
    weak: live.filter((r) => r.state === "passing_strength_unmet").length,
    suspect: live.filter((r) => r.state === "suspect"),
  };
}

// --- Signals as risks (planner-pm §2.12, §2.18) --------------------------------

function riskOf(s: SignalLike, titles: Map<string, string>): RiskItem | undefined {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const targets = s.response?.targets ?? [];
  const mode = s.response?.mode;
  // Applying happens where the proposal or question lives, by a person's press.
  const action =
    mode === "decision"
      ? { label: "Answer", href: "#/inbox" }
      : mode === "proposal"
        ? { label: "See Seshat's proposal", href: "#/pm" }
        : undefined;
  switch (s.id) {
    case "scope_drift":
      return {
        sentence: `Scope grew by ${pct(s.value)} since the plan was made.`,
        suggested: "Hold the added issues until you confirm the goal has grown.",
        why: `More than ${pct(s.threshold ?? 0.2)} was added after work began, and growth hidden in a plan moves every date.`,
        ...(action ? { action } : {}),
      };
    case "cycle_time":
      return {
        sentence: `The slowest issues take ${s.value} times as long as a typical one.`,
        suggested: "Give the long-running issues more steps, or split them.",
        why: "When a few issues take far longer than the rest, every forecast gets less reliable.",
        ...(action ? { action } : {}),
      };
    case "blocked_time": {
      const hours = `${s.value} hours`;
      const sentence =
        targets.length === 1
          ? `${titles.get(targets[0] as string) ?? "An issue"} has been blocked for ${hours}.`
          : `${plural(targets.length, "issue")} have been blocked; the oldest for ${hours}.`;
      return {
        sentence,
        suggested: "Ask whoever holds the blocker, or unblock it.",
        why: "Blocked work ages quietly and delays everything that waits on it.",
        ...(action ? { action } : {}),
      };
    }
    case "failure_concentration":
      return {
        sentence: `Checks failed ${s.value} times in the same place.`,
        suggested: "Split that part of the work into smaller issues.",
        why: "Failures in one place usually mean the issue is too big to finish in one pass.",
        ...(action ? { action } : {}),
      };
    case "review_backlog":
      return {
        sentence: `${plural(s.value, "issue")} ${s.value === 1 ? "waits" : "wait"} for review, as many as review can take.`,
        suggested: "Review the waiting issues before starting more.",
        why: "Finished work is not done until a person accepts it, and the Agent holds new work while review is full.",
        action: { label: "Open Review", href: "#/review" },
      };
    case "risk_register":
      return {
        sentence: `${plural(s.value, "risky assumption")} ${s.value === 1 ? "has" : "have"} not been checked for over a day.`,
        suggested: "Run a short spike to check it before building on it.",
        why: "An assumption nobody has checked can undo the work built on top of it.",
        ...(action ? { action } : {}),
      };
    default:
      return undefined;
  }
}

// --- The model ---------------------------------------------------------------

export function statusModel(input: StatusInput): StatusView {
  const { now, me } = input;
  const facts = input.facts ?? null;
  const team = facts?.setup === "team";
  const isLead = facts ? facts.isLead : true;
  const cards = input.cards;
  const titles = new Map(cards.map((c) => [c.id, titleOf(c.title)]));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const work = cards.filter((c) => isWork(c) && c.status !== "rejected");
  const count = (s: string) => work.filter((c) => c.status === s).length;

  // 1. The headline: facts only; the health word is a person's (§2.8.1).
  const done = count("done");
  const building = count("in_progress") + count("verify");
  const clauses = [
    building ? `${building} being built` : "",
    count("review") ? `${count("review")} waiting for review` : "",
    count("parked") ? `${count("parked")} on hold` : "",
  ].filter(Boolean);
  const headline =
    work.length === 0
      ? "No issues yet. Start a new project and Seshat plans the first ones with you."
      : `${done} of ${plural(work.length, "issue")} done.${clauses.length ? ` ${clauses.join(", ")}.` : ""}`;

  // Health: a person's call with their name and date; *No health set* only in Team.
  const health = facts?.health
    ? {
        text: `${HEALTH_LABELS[facts.health.value]?.label ?? "Health set"} · set by ${facts.health.by} · ${formatShortDate(facts.health.at)}`,
        tone: HEALTH_LABELS[facts.health.value]?.tone ?? ("" as StatusTone),
      }
    : team
      ? { text: "No health set", tone: "" as StatusTone }
      : null;
  const update = facts?.update
    ? {
        text: facts.update.text,
        byline: `Posted by ${facts.update.by} · ${formatShortDate(facts.update.at)}`,
      }
    : null;
  const updateMissing =
    team && isLead && facts?.updateMissing
      ? "Update missing: no update has been posted in the last 7 days."
      : null;

  // The sprint in force has its own key number. The forecast is the project's, and its
  // target is a release's (DB-N9-3, DEC-37): none is recorded yet, so none is drawn —
  // a sprint's end is not the project's target.
  const cycle = activeCycle(input.cycles, now);

  // 2. Key numbers. The forecast is a range or *Not enough history yet*, never one date.
  const fc = facts?.forecast;
  const forecast: StatusView["forecast"] = {};
  let forecastNumber: KeyNumber;
  const dates = forecastDates(fc, now);
  if (fc && allDone(fc)) {
    forecastNumber = {
      id: "forecast",
      label: "Forecast",
      value: "All issues done",
      detail: `${plural(fc.finished, "issue")} finished in the last ${plural(fc.historyDays, "day")}; none left.`,
    };
  } else if (fc && dates) {
    const { p50, p85 } = dates;
    forecast.band = { from: p50, to: p85 };
    forecastNumber = {
      id: "forecast",
      label: "Forecast",
      value: `50% ${formatShortDate(p50)} · 85% ${formatShortDate(p85)} · no target set`,
      detail: `From ${plural(fc.historyDays, "day")} of finished issues; ${plural(fc.remaining, "issue")} left.`,
    };
  } else {
    const have = fc?.historyDays ?? 0;
    const need = fc?.minimum ?? 5;
    forecastNumber = {
      id: "forecast",
      label: "Forecast",
      value: "Not enough history yet",
      detail: `A range needs ${plural(need, "day")} of history with finished issues: ${plural(have, "day")} so far, ${fc?.finished ?? 0} finished.`,
    };
  }

  // Requirements (§2.8.5), from the requirement graph's story map.
  const blockedCard = (id: string) => {
    const c = byId.get(id);
    return c ? isBlocked(c.status, c.blockedReason) : false;
  };
  const slices = input.storyMap?.slices ?? [];
  const seen = new Set<string>();
  const reqs: StatusRequirementLike[] = [];
  for (const s of slices)
    for (const r of s.requirements)
      if (!seen.has(r.id) && r.state !== "cut") {
        seen.add(r.id);
        reqs.push(r);
      }
  const groups = (["Must have", "Should have", "Could have"] as const)
    .map((label) => {
      const rows: RequirementRow[] = reqs
        .filter((r) => moscowOf(r) === label)
        .map((r) => {
          const state = requirementWord(r, blockedCard);
          return {
            id: r.id,
            title: r.title?.trim() || "Untitled requirement",
            state,
            ...REQUIREMENT_WORDS[state],
          };
        });
      const summary = WORD_ORDER.map((w) => [w, rows.filter((r) => r.state === w).length] as const)
        .filter(([, n]) => n > 0)
        .map(([w, n]) => `${n} ${REQUIREMENT_WORDS[w].label.toLowerCase()}`)
        .join(" · ");
      return { label, summary, rows };
    })
    .filter((g) => g.rows.length > 0);
  const requirements: StatusView["requirements"] =
    input.storyMap && reqs.length > 0
      ? { groups }
      : {
          groups: [],
          empty:
            "No requirements yet. Seshat lists them when a person accepts the project's brief.",
        };

  const release = currentRelease(slices);
  let requirementsNumber: KeyNumber;
  let appetite: string | undefined;
  if (release) {
    const { slice: current, live, weak, suspect } = release;
    const detail = [
      weak ? `${weak} with tests too weak, not counted as done.` : "",
      suspect.length
        ? `Suspect since a change: ${suspect.map((r) => r.title?.trim() || "an untitled requirement").join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    requirementsNumber = {
      id: "requirements",
      label: "Requirements",
      value: `${release.name} · ${release.done} of ${plural(release.total, "requirement")} done`,
      ...(detail ? { detail } : {}),
    };
    if (current.appetite?.cards) {
      const used = new Set(live.flatMap((r) => r.cards.map((c) => c.id))).size;
      appetite = `Appetite used: ${used} of ${plural(current.appetite.cards, "issue")}.`;
    }
  } else {
    requirementsNumber = {
      id: "requirements",
      label: "Requirements",
      value: "None yet",
      detail: "Accept a brief with Seshat to list them.",
    };
  }

  // 4. Needs you, and (Team) Waiting on others.
  const mine = (c: StatusCardLike) => !team || c.owner === me || (!c.owner && isLead);
  // Unpark is offered only to a level that may use it (a Member's `review`).
  const canUnpark = facts ? facts.canUnpark !== false : true;
  // Who an item waits on: its owner, or the project's lead when it has none.
  const ownerWord = (c: StatusCardLike) =>
    c.owner ? (c.display?.ownerName ?? "its owner") : "the project lead";
  const needs: NeedsYouItem[] = [];
  const waitingItems: string[] = [];
  for (const c of work.filter((x) => x.status === "review")) {
    if (mine(c)) {
      needs.push({
        kind: "review",
        text: `${titleOf(c.title)} is waiting for your review.`,
        buttons: [{ label: "Review it", href: `#/review/${c.id}` }],
      });
    } else {
      const who = ownerWord(c);
      const waited = c.updatedAt ? ` · ${formatWait(now - Date.parse(c.updatedAt))}` : "";
      waitingItems.push(`${titleOf(c.title)} · waiting for ${who}'s review${waited}`);
    }
  }
  // The standup is the workspace's: only this page's issues, and a question
  // about no issue only while the page is the whole workspace's (PM-N9-8).
  const onPage = (id?: string) => (id ? byId.has(id) : !facts?.project || !team);
  for (const d of (input.standup?.decisionsWaiting ?? []).filter((x) => onPage(x.cardId))) {
    needs.push({
      kind: "decision",
      text: `A question waits for your answer: ${withTitles(d.question, titles)}`,
      buttons: [{ label: "Answer", href: "#/inbox" }],
    });
  }
  for (const c of work.filter((x) => x.status === "parked" && mine(x))) {
    if (!canUnpark) {
      waitingItems.push(`${titleOf(c.title)} · on hold · waiting for a Member to take it off hold`);
      continue;
    }
    const why = c.stopReason
      ? stopReasonLabel(c.stopReason).sentence
      : c.blockedReason
        ? withTitles(c.blockedReason, titles)
        : "";
    needs.push({
      kind: "parked",
      text: `${titleOf(c.title)} is on hold.${why ? ` ${why}` : ""}`,
      buttons: [{ label: "Unpark", act: "unpark", id: c.id }],
    });
  }
  if (isLead) {
    slices.forEach((s, i) => {
      if (!s.appetiteReached || s.accepted || s.state === "done") return;
      // PM-P13-9's three choices, each offered only where the server allows it:
      // Accept a proven release; move what is not a Must have to Later; Extend
      // only with nothing unplanned (the server also asks for red tests).
      const live = s.requirements.filter((r) => r.state !== "cut");
      const must = live.filter((r) => r.mustHave);
      const open = must.filter((r) => r.state !== "proven").length;
      const rest = live.filter((r) => !r.mustHave && r.state !== "proven").map((r) => r.id);
      const buttons: StatusButton[] = [];
      if (s.state === "proven")
        buttons.push({ label: "Accept as it is", act: "slice-accept", id: s.id });
      if (rest.length)
        buttons.push({ label: "Move the rest to Later", act: "slice-cut", id: s.id, ids: rest });
      if (!live.some((r) => r.state === "unplanned"))
        buttons.push({
          label: "Extend",
          act: "slice-extend",
          id: s.id,
          ...(s.appetite?.cards ? { cards: s.appetite.cards } : {}),
        });
      if (!buttons.length) buttons.push({ label: "Ask Seshat", href: "#/pm" });
      needs.push({
        kind: "slice",
        text: `${releaseName(s, i)} reached its appetite with ${
          open
            ? `${open} of ${must.length} Must have requirements not done`
            : "every Must have requirement done"
        }. Choose how it goes on.`,
        buttons,
      });
    });
  }
  for (const c of cards.filter(
    (x) => x.status === "planning" && APPROVAL_HOLD.test(x.blockedReason ?? ""),
  )) {
    if (mine(c))
      needs.push({
        kind: "plan",
        text: `${titleOf(c.title)} has a plan waiting for your approval.`,
        buttons: [{ label: "Review plan", href: `#/card/${c.id}/plan` }],
      });
    else waitingItems.push(`${titleOf(c.title)} · plan waiting for ${ownerWord(c)}'s approval`);
  }

  const sprintNumber: KeyNumber = cycle
    ? {
        id: "sprint",
        label: "Sprint",
        value: (() => {
          const left = Math.max(0, dayNumber(cycle.endsOn) - dayNumber(isoDay(now)));
          return `${cycle.name} · ${left === 0 ? "ends today" : `${plural(left, "day")} left`}`;
        })(),
      }
    : { id: "sprint", label: "Sprint", value: "No sprint running" };

  const numbers: KeyNumber[] = [
    forecastNumber,
    requirementsNumber,
    { id: "issues", label: "Issues done", value: `${done} of ${work.length}` },
    sprintNumber,
    { id: "attention", label: "Needs attention", value: String(needs.length), jump: "needs" },
  ];

  // 6. Risks: the fired signals, each a sentence with Suggested and Why.
  // The server scopes them to the project (PM-N9-8); a blocked issue that is not on
  // this page is still another project's, and is never this page's risk.
  const risks = (input.signals ?? [])
    .filter((s) => s.triggered)
    .filter(
      (s) =>
        s.id !== "blocked_time" ||
        !(s.response?.targets.length && s.response.targets.every((t) => !byId.has(t))),
    )
    .map((s) => riskOf(s, titles))
    .filter((r): r is RiskItem => r !== undefined);

  // 7. Today's changes (the standup in plain mode) and Done this week.
  const st = input.standup;
  const line = (state: string, words: string) =>
    (st?.byState[state] ?? [])
      .filter((x) => onPage(x.id))
      .map((x) => `${words}: ${titleOf(x.title)}`);
  const questions = (st?.decisionsWaiting ?? []).filter((x) => onPage(x.cardId)).length;
  const standupLines = [
    ...line("passed", "Done"),
    ...line("in_progress", "Being built"),
    ...line("review", "Waiting for review"),
    ...line("parked", "On hold"),
    ...(questions
      ? [`${plural(questions, "question")} ${questions === 1 ? "waits" : "wait"} for an answer.`]
      : []),
  ];
  const accepted = (facts?.acceptedThisWeek ?? [])
    .filter((a) => now - Date.parse(a.at) <= WEEK)
    .map((a) => `${titleOf(a.title)} · accepted by ${a.by} · ${formatShortDate(a.at)}`);

  // 8. Who's working on what: each person's and the Agent's current item only.
  const running = cards
    .filter((c) => (c.status === "in_progress" || c.status === "verify") && isWork(c))
    .sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
  const rows: StatusView["working"]["rows"] = [];
  const agentCard = running.find((c) => !c.delegate || c.delegate === "worker");
  if (agentCard) rows.push({ who: "Agent", ai: true, item: titleOf(agentCard.title) });
  const people = new Set<string>();
  for (const c of running) {
    if (!c.delegate || c.delegate === "worker" || people.has(c.delegate)) continue;
    people.add(c.delegate);
    rows.push({
      who: c.display?.delegateName ?? "A teammate",
      ai: false,
      item: titleOf(c.title),
    });
  }

  // 9. The models line (teams item 31).
  const queued = input.standing?.length ?? 0;
  const longest = Math.max(0, ...(input.standing ?? []).map((s) => s.estimateSeconds));
  const models =
    building === 0 && queued === 0
      ? "Coding model idle"
      : `Coding model ${building ? "busy" : "idle"} · ${
          queued
            ? `${queued} in queue, about ${plural(Math.max(1, Math.round(longest / 60)), "minute")}`
            : "nothing queued"
        }`;

  // 10. The flow strip (DB-N9-8), each linking to Insights.
  const hours = facts?.flow.cycleHours ?? [];
  const enough = hours.length >= FLOW_MINIMUM;
  const days = facts?.flow.days ?? 30;
  const finished = facts?.flow.finished ?? 0;
  const perWeek = Math.round(((finished * 7) / Math.max(1, days)) * 10) / 10;
  const ft = facts?.flow.firstTime ?? { passed: 0, total: 0 };
  const flow: StatusView["flow"] = {
    items: [
      {
        label: "Cycle time, median",
        value: enough ? formatHours(percentile(hours, 50)) : "Not enough yet",
        href: INSIGHTS,
      },
      {
        label: "Cycle time, 85th percentile",
        value: enough ? formatHours(percentile(hours, 85)) : "Not enough yet",
        href: INSIGHTS,
      },
      {
        label: "Throughput",
        value: `${perWeek} ${perWeek === 1 ? "issue" : "issues"} a week`,
        href: INSIGHTS,
      },
      { label: "Sent back", value: `${facts?.flow.sentBack ?? 0} in ${days} days`, href: INSIGHTS },
      {
        label: "Checks passed first time",
        value: ft.total
          ? `${Math.round((ft.passed / ft.total) * 100)}% (${ft.passed} of ${ft.total})`
          : "None yet",
        href: INSIGHTS,
      },
    ],
    ...(enough
      ? {}
      : {
          note: `Cycle time needs ${FLOW_MINIMUM} finished issues; there ${hours.length === 1 ? "is" : "are"} ${hours.length}.`,
        }),
  };

  return {
    headline,
    health,
    setHealth: Boolean(facts?.healthWritable && facts.canSetHealth),
    update,
    updateMissing,
    writeUpdate: Boolean(facts?.canPostUpdate),
    numbers,
    ...(appetite ? { appetite } : {}),
    forecast,
    needsYou: {
      items: needs,
      empty:
        "Nothing needs you. Finished issues, questions and plans for you to approve appear here.",
    },
    waiting: team ? { items: waitingItems, empty: "Nothing waits on anyone else." } : null,
    requirements,
    risks: {
      items: risks,
      empty:
        "No risks right now. Sekhemet watches scope, blocked work, failures and the review queue.",
    },
    standup: { lines: standupLines, empty: "Nothing changed in the last day." },
    doneThisWeek: { items: accepted, empty: "Nothing accepted this week yet." },
    working: { rows, empty: "No one is working on an issue right now." },
    models,
    flow,
  };
}
