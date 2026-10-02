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
import { reviewItHref } from "./learn.js";
import {
  type CycleLike,
  activeCycle,
  cycleProgress,
  formatHours,
  formatShortDate,
  percentile,
} from "./pm.js";
import { startRequestLine } from "./teammates.js";
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
  /**
   * The viewer may set health: the project lead, or a Member who leads a
   * release not yet accepted (TEAM-28, teams item 28, `project.health`).
   */
  canSetHealth: boolean;
  /** Whether the server records health (`POST /api/projects/:id/health`, teams NEW-teams-11). */
  healthWritable: boolean;
  health?: { value: HealthValue; by: string; at: string } | null;
  /**
   * The current release: the first no person has accepted (DB-N9-3), with
   * its lead when a person named one (teams item 28, DB-N9-2; Team only).
   */
  release?: { id: string; name: string; lead?: { principal: string; name: string } } | null;
  /** The current release's target date, as a person set it (DB-N9-3, DEC-37). */
  target?: { release: string; date: string; by: string; at: string } | null;
  /** The viewer may set it: the project lead or an Admin (`release.target`); always in Solo. */
  canSetTarget?: boolean;
  /** The viewer may name the release's lead: the project lead or an Admin (`release.lead`); Team only. */
  canSetReleaseLead?: boolean;
  /** Whom they may name: the project's Members and Admins, by name. */
  releaseLeadChoices?: { principal: string; name: string }[];
  update?: { text: string; by: string; at: string } | null;
  /** Team only: 7 days without a posted update, shown to the lead (TEAM-29). */
  updateMissing: boolean;
  canPostUpdate: boolean;
  /** The viewer may unpark an issue (the `review` permission, a Member's; always in Solo). */
  canUnpark: boolean;
  /**
   * The viewer is one of the people the project's Accept rule names (teams
   * item 7; FINDINGS STA-02): every issue in review needs them. Always true
   * in Solo. Absent from an older server: the owner rule decides.
   */
  mayAccept?: boolean;
  /** The names of the people who may accept, for an issue waiting on someone else. */
  accepters?: string[];
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
  /**
   * Teams TEAM-39, item 19a: Stakeholders' and Viewers' requests to start the
   * Agent that wait on the viewer — who asked (a name) and what.
   */
  agentRequests?: { id: string; cardId: string; title: string; requestedBy: string; ask: string }[];
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
  /** The viewer manages the work: *Review it* opens the criteria view (NEW-dashboard-17). */
  managesWork?: boolean;
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
  act?: "unpark" | "slice-accept" | "slice-cut" | "slice-extend" | "agent-start" | "agent-decline";
  id?: string;
  /** The issue an act is about, when `id` names something on it (a start request). */
  card?: string;
  ids?: string[];
  /** Extend: the release's card appetite now, which the new one must exceed. */
  cards?: number;
}

export interface NeedsYouItem {
  kind: "review" | "decision" | "parked" | "slice" | "plan" | "agent_request";
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
  /** The health picker's choices, in order, and the one set now (TEAM-28). */
  healthChoices: { value: HealthValue; label: string; checked: boolean }[];
  /** The current release's target line: *Target 20 Nov · set by Lee · 28 Sep*, or null. */
  target: string | null;
  /** *Set target date* for the current release, to the lead or an Admin (DB-N9-3); null otherwise. */
  setTarget: { release: string; name: string; date: string | null } | null;
  /** The current release's lead, in the Team setup: *Release 2 lead: Mo Member*, or null (teams item 28). */
  releaseLead: string | null;
  /** *Set release lead*, to the project lead or an Admin, with whom they may name; null otherwise. */
  setReleaseLead: {
    release: string;
    name: string;
    lead: string | null;
    choices: { principal: string; name: string }[];
  } | null;
  update: { text: string; byline: string } | null;
  updateMissing: string | null;
  writeUpdate: boolean;
  /**
   * DB-N9-17 (dashboard §2.2.7): each header action the viewer's level does
   * not allow, by the permission it needs — shown disabled with the level
   * they hold and one that can, never hidden. Team only; an action with
   * nothing to act on (no release, health not recorded) is not offered.
   */
  gated: {
    health?: "project.health";
    target?: "release.target";
    releaseLead?: "release.lead";
    update?: "project.update";
  };
  numbers: KeyNumber[];
  appetite?: string;
  forecast: { band?: { from: string; to: string }; target?: string };
  needsYou: { items: NeedsYouItem[]; empty: string };
  waiting: { items: string[]; empty: string } | null;
  /**
   * By release, each with the count its key number uses (FINDINGS STA-01),
   * and in each release by MoSCoW group.
   */
  requirements: {
    releases: {
      name: string;
      /** *1 of 3 requirements done*: the release's Must haves, as the key number counts them. */
      summary: string;
      /** The release the key number and the burn-up are about. */
      current: boolean;
      groups: { label: string; summary: string; rows: RequirementRow[] }[];
    }[];
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
  healthLegend: "Project health",
  healthHint:
    "Your call as the project lead or a release's lead: it shows with your name and today's date. Seshat never sets it.",
  setTarget: "Set target date",
  changeTarget: "Change target date",
  targetLabel: "Target date",
  targetHint:
    "The day this release should be done. Status draws it as a line against the forecast range.",
  clearTarget: "Clear target",
  healthSaved: "Health set.",
  targetSaved: "Target date set.",
  targetCleared: "Target date cleared.",
  setReleaseLead: "Set release lead",
  changeReleaseLead: "Change release lead",
  releaseLeadLabel: "Release lead",
  releaseLeadHint:
    "A Member or an Admin who leads this release. While it is open they may set the project's health.",
  noReleaseLead: "No lead",
  releaseLeadSaved: "Release lead set.",
  releaseLeadCleared: "Release lead cleared.",
  updateLabel: "Project update",
  updateHint:
    "Seshat drafted this from the project's history in five parts: status, done, next, risks and asks. Edit it; nothing is posted until you press Post.",
  post: "Post",
  cancel: "Cancel",
  posted: "Update posted.",
  loadingDraft: "Seshat is drafting the update…",
  extendLabel: "New size limit, in issues",
  save: "Save",
  askLabel: "Ask Seshat about this project",
  askPlaceholder: "How is it going? What's at risk?",
  ask: "Ask",
  startProject: "Start a new project",
  notOnServer: "Status isn't on this server yet.",
  notOnServerDetail: "Update Sekhemet and restart it.",
  loadFailed: "Couldn't load the project's facts.",
  loadFailedDetail: "Health, the update, the forecast and the flow are missing below.",
  tryAgain: "Try again",
  askEmpty: "Type a question for Seshat first.",
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
 * when every release is done), with its requirements done: its Must have
 * requirements proven, of those not cut — the planner's count
 * (`provenLine`, *requirements done*), so Status, Projects and Seshat's
 * /status say one number (FINDINGS STA-01). *Tests too weak* is never done.
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
  const must = live.filter((r) => r.mustHave);
  return {
    slice,
    name: releaseName(slice, index),
    done: must.filter((r) => r.state === "proven").length,
    total: must.length,
    live,
    weak: must.filter((r) => r.state === "passing_strength_unmet").length,
    suspect: live.filter((r) => r.state === "suspect"),
  };
}

/** A release's Must haves done, in the planner's words: *1 of 3 requirements done*. */
function doneLine(done: number, total: number): string {
  return `${done} of ${plural(total, "requirement")} done`;
}

/**
 * The key number *requirements done* (§2.8.2) in words, as Status shows it
 * and Seshat's /status says it (FINDINGS STA-01): the current release's Must
 * haves, with those whose tests are too weak and those to re-check named.
 */
export function requirementsWords(slices: StatusSliceLike[]): { value: string; detail?: string } {
  const release = currentRelease(slices);
  if (!release) return { value: "None yet", detail: "Accept a brief with Seshat to list them." };
  const others = release.live.length - release.total;
  const detail = [
    "Must have requirements.",
    release.weak ? `${release.weak} with tests too weak, not counted as done.` : "",
    release.suspect.length
      ? `To re-check since a change: ${release.suspect.map((r) => r.title?.trim() || "an untitled requirement").join(", ")}.`
      : "",
    others > 0 ? "Should and Could have requirements are listed below and not counted." : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { value: `${release.name} · ${doneLine(release.done, release.total)}`, detail };
}

/**
 * The forecast key number in words (§2.8.2, DB-N9-3): a range with the
 * target, *All issues done*, or *Not enough history yet* — never one date.
 * Status, Projects and Seshat's /status and /forecast say these words
 * (FINDINGS STA-01).
 */
export function forecastWords(
  fc: StatusFacts["forecast"] | undefined,
  now: number,
  targetDate?: string,
): { value: string; detail: string } {
  const targetNote = targetDate ? ` Target ${formatShortDate(targetDate)}.` : "";
  if (fc && allDone(fc)) {
    return {
      value: "All issues done",
      detail: `${plural(fc.finished, "issue")} finished in the last ${plural(fc.historyDays, "day")}; none left.${targetNote}`,
    };
  }
  const dates = forecastDates(fc, now);
  if (fc && dates) {
    const targetWords = targetDate ? `target ${formatShortDate(targetDate)}` : "no target set";
    return {
      value: `50% ${formatShortDate(dates.p50)} · 85% ${formatShortDate(dates.p85)} · ${targetWords}`,
      detail: `From ${plural(fc.historyDays, "day")} of finished issues; ${plural(fc.remaining, "issue")} left.`,
    };
  }
  const have = fc?.historyDays ?? 0;
  const need = fc?.minimum ?? 5;
  return {
    value: "Not enough history yet",
    detail: `A range needs ${plural(need, "day")} of history with finished issues: ${plural(have, "day")} so far, ${fc?.finished ?? 0} finished.${targetNote}`,
  };
}

/** A sprint's whole days left, today included: the board's sprint header's count (`cycleProgress`). */
export function sprintDaysLeft(cycle: CycleLike, now: number): number {
  return cycleProgress(cycle, [], now).daysLeft;
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
  const dates = forecastDates(fc, now);
  // The current release's target date, as a person set it (DB-N9-3): the line on the
  // burn-up and the last part of the forecast, never a date the forecast made.
  const targetDate = facts?.target?.date;
  if (targetDate) forecast.target = targetDate;
  if (fc && dates) forecast.band = { from: dates.p50, to: dates.p85 };
  // The words Seshat's /status and /forecast say too (STA-01).
  const forecastNumber: KeyNumber = {
    id: "forecast",
    label: "Forecast",
    ...forecastWords(fc, now, targetDate),
  };

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
  const groupsOf = (list: StatusRequirementLike[]) =>
    (["Must have", "Should have", "Could have"] as const)
      .map((label) => {
        const rows: RequirementRow[] = list
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
        const summary = WORD_ORDER.map(
          (w) => [w, rows.filter((r) => r.state === w).length] as const,
        )
          .filter(([, n]) => n > 0)
          .map(([w, n]) => `${n} ${REQUIREMENT_WORDS[w].label.toLowerCase()}`)
          .join(" · ");
        return { label, summary, rows };
      })
      .filter((g) => g.rows.length > 0);
  // By release, each counted as its key number counts it (STA-01): a requirement
  // shows under the first release that lists it.
  const listed = new Set<string>();
  const currentIndex = Math.max(
    0,
    slices.findIndex((x) => x.state !== "done"),
  );
  const releases = slices
    .map((sl, i) => {
      const live = sl.requirements.filter(
        (r) => r.state !== "cut" && reqs.includes(r) && !listed.has(r.id),
      );
      for (const r of live) listed.add(r.id);
      const must = live.filter((r) => r.mustHave);
      return {
        name: releaseName(sl, i),
        summary: doneLine(must.filter((r) => r.state === "proven").length, must.length),
        current: i === currentIndex,
        groups: groupsOf(live),
      };
    })
    .filter((r) => r.groups.length > 0);
  const requirements: StatusView["requirements"] =
    input.storyMap && reqs.length > 0
      ? { releases }
      : {
          releases: [],
          empty:
            "No requirements yet. Seshat lists them when a person accepts the project's brief.",
        };

  const release = currentRelease(slices);
  const requirementsNumber: KeyNumber = {
    id: "requirements",
    label: "Requirements",
    ...requirementsWords(slices),
  };
  let appetite: string | undefined;
  if (release?.slice.appetite?.cards) {
    const used = new Set(release.live.flatMap((r) => r.cards.map((c) => c.id))).size;
    appetite = `Size limit used: ${used} of ${plural(release.slice.appetite.cards, "issue")}.`;
  }

  // 4. Needs you, and (Team) Waiting on others.
  const mine = (c: StatusCardLike) => !team || c.owner === me || (!c.owner && isLead);
  // Unpark is offered only to a level that may use it (a Member's `review`).
  const canUnpark = facts ? facts.canUnpark !== false : true;
  // Who an item waits on: its owner, or the project's lead when it has none.
  const ownerWord = (c: StatusCardLike) =>
    c.owner ? (c.display?.ownerName ?? "its assignee") : "the project lead";
  const needs: NeedsYouItem[] = [];
  const waitingItems: string[] = [];
  // STA-02: an issue in review needs whoever the Accept rule names (DEC-36),
  // and waits on them, by name, for anyone else.
  const accepts = (c: StatusCardLike) =>
    facts?.mayAccept !== undefined ? facts.mayAccept : mine(c);
  const reviewers = facts?.accepters?.length ? facts.accepters.join(" or ") : "";
  for (const c of work.filter((x) => x.status === "review")) {
    if (accepts(c)) {
      needs.push({
        kind: "review",
        text: `${titleOf(c.title)} is waiting for your review.`,
        buttons: [{ label: "Review it", href: reviewItHref(c.id, input.managesWork === true) }],
      });
    } else {
      const waited = c.updatedAt ? ` · ${formatWait(now - Date.parse(c.updatedAt))}` : "";
      waitingItems.push(
        reviewers
          ? `${titleOf(c.title)} · waiting for review by ${reviewers}${waited}`
          : `${titleOf(c.title)} · waiting for ${ownerWord(c)}'s review${waited}`,
      );
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
  // TEAM-39: "Dana asked the Agent to … Start it?" — the server lists only those waiting on the viewer.
  for (const r of facts?.agentRequests ?? []) {
    const line = startRequestLine({
      requestedBy: r.requestedBy,
      ask: r.ask,
      title: titleOf(r.title),
    });
    needs.push({
      kind: "agent_request",
      text: line.text,
      buttons: [
        { label: line.start, act: "agent-start", id: r.id, card: r.cardId },
        { label: line.decline, act: "agent-decline", id: r.id, card: r.cardId },
      ],
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
      buttons: [{ label: "Take off hold", act: "unpark", id: c.id }],
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
        text: `${releaseName(s, i)} reached its size limit with ${
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
        // The board's count, today included (STA-01): its last day reads *ends today*.
        value: (() => {
          const left = sprintDaysLeft(cycle, now);
          return `${cycle.name} · ${left <= 1 ? "ends today" : `${plural(left, "day")} left`}`;
        })(),
      }
    : { id: "sprint", label: "Sprint", value: "No sprint running" };

  // The count says what it leaves out, so it reads against the board's tiles (STA-01).
  const epics = cards.filter((c) => c.tier === "epic" || c.tier === "initiative").length;
  const wontDo = cards.filter((c) => isWork(c) && c.status === "rejected").length;
  const left = [
    epics ? plural(epics, "epic") : "",
    wontDo ? `${wontDo} won't do ${wontDo === 1 ? "issue" : "issues"}` : "",
  ].filter(Boolean);
  const issuesNumber: KeyNumber = {
    id: "issues",
    label: "Issues done",
    value: `${done} of ${work.length}`,
    ...(left.length ? { detail: `Not counted: ${left.join(" and ")}.` } : {}),
  };
  const numbers: KeyNumber[] = [
    forecastNumber,
    requirementsNumber,
    issuesNumber,
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
      {
        label: "Changes requested",
        value: `${facts?.flow.sentBack ?? 0} in ${days} days`,
        href: INSIGHTS,
      },
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
    healthChoices: (Object.keys(HEALTH_LABELS) as HealthValue[]).map((value) => ({
      value,
      label: HEALTH_LABELS[value].label,
      checked: facts?.health?.value === value,
    })),
    target: facts?.target
      ? `${facts.release?.name ?? "Release"} target ${formatShortDate(facts.target.date)} · set by ${facts.target.by} · ${formatShortDate(facts.target.at)}`
      : null,
    setTarget:
      facts?.release && facts.canSetTarget
        ? { release: facts.release.id, name: facts.release.name, date: facts.target?.date ?? null }
        : null,
    releaseLead:
      facts?.setup === "team" && facts.release?.lead
        ? `${facts.release.name} lead: ${facts.release.lead.name}`
        : null,
    setReleaseLead:
      facts?.setup === "team" && facts.release && facts.canSetReleaseLead
        ? {
            release: facts.release.id,
            name: facts.release.name,
            lead: facts.release.lead?.principal ?? null,
            choices: facts.releaseLeadChoices ?? [],
          }
        : null,
    update,
    updateMissing,
    writeUpdate: Boolean(facts?.canPostUpdate),
    gated:
      facts?.setup === "team" && facts.project
        ? {
            ...(facts.healthWritable && !facts.canSetHealth
              ? { health: "project.health" as const }
              : {}),
            ...(facts.release && !facts.canSetTarget ? { target: "release.target" as const } : {}),
            ...(facts.release && !facts.canSetReleaseLead
              ? { releaseLead: "release.lead" as const }
              : {}),
            ...(!facts.canPostUpdate ? { update: "project.update" as const } : {}),
          }
        : {},
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
