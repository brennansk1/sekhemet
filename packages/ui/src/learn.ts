/**
 * Tips — the on-screen name of the Learn layer (dashboard §2.9, P4; DEC-31):
 * every lesson, the line each one computes from the project's own numbers,
 * the `?` button's markup, and the first-run question that turns Tips on for
 * a learner (§2.2.5). One pure module, unit-tested, and the one source of the
 * words: the page (`web/learn.js`) renders what this returns.
 *
 * A lesson is two sentences on what a thing is, one line from this project's
 * numbers, and a link to its canonical source — linked, never copied (the
 * Kanban Guide and the Scrum Guide are CC BY-SA). Standard conventions are
 * not explained. Tips are the one place the product says *walking skeleton*
 * (DEC-31, NAMING).
 *
 * The browser loads the compiled module as `/app/lib/learn.js`: runtime
 * imports stay relative to the other published lib modules.
 */
import { type ReviewLimitFacts, reviewBasis } from "./columns.js";
import { formatHours } from "./pm.js";
import {
  BOARD_COLUMNS,
  type GateSummary,
  ISSUE_TYPE_LABELS,
  WONT_DO_COLUMN,
  boardColumnOf,
  checksVerdict,
  columnLabel,
  issueTypeOf,
  plural,
} from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Settings kept per browser: Tips and the first-run answer (§3 per-browser)
// ---------------------------------------------------------------------------

export const TIPS_KEY = "sekhemet-tips";
export const ROLE_KEY = "sekhemet-role";

/**
 * The first-run answers; `later` is *Not now*: asked, no answer given.
 * `seshat` is *I'll just talk to Seshat* (FINDINGS SHL-03; product
 * direction: a non-developer just talks to Seshat).
 */
export type FirstRunRole = "code" | "manage" | "learn" | "seshat";
export type StoredRole = FirstRunRole | "later";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The one question the first visit asks (§2.2.5). */
export const FIRST_RUN = {
  /** SHL-03: the one-screen welcome above the question. */
  welcome: "Welcome to Sekhemet.",
  lede: "It plans your project as issues on a board, has a local model build each one against checks, and asks a person to accept the result.",
  modelStep: "First, set up a model: nothing is built until a Coding model fits this computer.",
  modelStepAdmin:
    "An Admin sets up the models; until then you can plan with Seshat and read every page.",
  setUpModels: "Set up models",
  question: "How will you use Sekhemet?",
  choices: [
    {
      role: "code" as const,
      label: "I write code",
      detail: "Opens on Review when something waits for you, otherwise the Board.",
    },
    { role: "manage" as const, label: "I manage the work", detail: "Opens on Status." },
    {
      role: "learn" as const,
      label: "I'm learning",
      detail: "Opens on the Board, with Tips that explain each part.",
    },
    {
      role: "seshat" as const,
      label: "I'll just talk to Seshat",
      detail: "Opens Seshat, the project manager: say what you need in your own words.",
    },
  ],
  later: "Not now",
  note: "Change it any time in Configuration › Preferences.",
} as const;

function read(storage: StorageLike | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage: StorageLike | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    // A browser that blocks storage keeps the choice for this page only.
  }
}

export function readRole(storage: StorageLike | undefined): StoredRole | null {
  const r = read(storage, ROLE_KEY);
  return r === "code" || r === "manage" || r === "learn" || r === "seshat" || r === "later"
    ? r
    : null;
}

/** Tips as a person last set them; with no setting, on only for *I'm learning*. Off by default. */
export function readTips(storage: StorageLike | undefined): boolean {
  const t = read(storage, TIPS_KEY);
  if (t === "on") return true;
  if (t === "off") return false;
  return readRole(storage) === "learn";
}

export function writeTips(storage: StorageLike | undefined, on: boolean): void {
  write(storage, TIPS_KEY, on ? "on" : "off");
}

/** Preferences' first-run role: the role alone, Tips left as they are. An unknown value is ignored. */
export function writeRole(storage: StorageLike | undefined, role: string): void {
  if (
    role === "code" ||
    role === "manage" ||
    role === "learn" ||
    role === "seshat" ||
    role === "later"
  )
    write(storage, ROLE_KEY, role);
}

/** Keep the answer and set Tips from it: on for *I'm learning*, off otherwise (DB-P4-7). */
export function answerFirstRun(storage: StorageLike | undefined, role: StoredRole): void {
  write(storage, ROLE_KEY, role);
  writeTips(storage, role === "learn");
}

/**
 * The question shows once, until answered or set aside (§2.2.5). With no
 * model yet it comes with the welcome's model step rather than waiting for
 * one (FINDINGS SHL-03): a Stakeholder or a Viewer never sets a model up.
 */
export function firstRunDue(storage: StorageLike | undefined, _f: { noModel: boolean }): boolean {
  return readRole(storage) === null;
}

export interface RouteFacts {
  role?: StoredRole | null;
  team?: boolean;
  /** Team: the person's profile label (teams item 8). */
  profileLabel?: string;
  /** In review holds an issue waiting for a person. */
  reviewWaiting: boolean;
  /** An issue has been accepted on this board. */
  everAccepted: boolean;
  /** No role's weights in any model folder (DB-N6-2). */
  noModel?: boolean;
  /** Team: the person's workspace level; only an Admin sets up models (SHL-03). */
  level?: string;
}

/**
 * Whether this person manages the work rather than writing code
 * (NEW-dashboard-17): the first-run answer *I manage the work* in Solo, the
 * profile label Product owner or Stakeholder in the Team setup.
 */
export function managesWork(f: Pick<RouteFacts, "role" | "team" | "profileLabel">): boolean {
  if (f.team) {
    const label = (f.profileLabel ?? "").trim().toLowerCase();
    return label === "product owner" || label === "stakeholder";
  }
  return f.role === "manage";
}

/** Where *Review it* opens (DB-N17-1): the criteria view for who manages the work, else Review. */
export function reviewItHref(cardId: string, manages: boolean): string {
  return manages ? `#/card/${encodeURIComponent(cardId)}/criteria` : `#/review/${cardId}`;
}

/**
 * The page the dashboard opens on (§2.2.5): Configuration › Models while no
 * model is set up, for who can set one up — Solo's person or a Team Admin;
 * anyone else lands on their own page, where the *No Coding model* bar says
 * an Admin sets models up (FINDINGS SHL-03). In the Team setup the profile
 * label decides (a Product owner or a Stakeholder on Status, anyone else as
 * *I write code*), and with no label a Stakeholder or Viewer level opens
 * Status; in Solo the first-run answer (*I'll just talk to Seshat* opens
 * Seshat); with none, Status for a person who has never accepted an issue.
 */
export function defaultRouteFor(f: RouteFacts): string {
  if (f.noModel && (!f.team || f.level === "admin")) return "#/configuration/models";
  const dev = f.reviewWaiting ? "#/review" : "#/board";
  if (f.team) {
    const label = (f.profileLabel ?? "").trim().toLowerCase();
    if (label === "product owner" || label === "stakeholder") return "#/status";
    if (!label && (f.level === "stakeholder" || f.level === "viewer")) return "#/status";
    return dev;
  }
  if (f.role === "code") return dev;
  if (f.role === "manage") return "#/status";
  if (f.role === "learn") return "#/board";
  if (f.role === "seshat") return "#/pm";
  return f.everAccepted ? dev : "#/status";
}

// ---------------------------------------------------------------------------
// Sources: the canon each lesson links to
// ---------------------------------------------------------------------------

interface Source {
  label: string;
  url: string;
}

const KANBAN: Source = {
  label: "The Kanban Guide",
  url: "https://kanbanguides.org/the-kanban-guide/",
};
const SCRUM: Source = { label: "The Scrum Guide", url: "https://scrumguides.org/scrum-guide.html" };
const CI: Source = {
  label: "Continuous Integration, Martin Fowler",
  url: "https://martinfowler.com/articles/continuousIntegration.html",
};
const PYRAMID: Source = {
  label: "The Practical Test Pyramid, Ham Vocke",
  url: "https://martinfowler.com/articles/practical-test-pyramid.html",
};
const STORY_MAP: Source = {
  label: "Story mapping, Jeff Patton",
  url: "https://www.jpattonassociates.com/wp-content/uploads/2015/03/story_mapping.pdf",
};
const INVEST: Source = {
  label: "INVEST in good stories, Bill Wake",
  url: "https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/",
};

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/** The check families: the layers `gates.toml` places each check in (gates §3, `GateLayer`). */
export const GATE_FAMILIES = [
  "static",
  "functional",
  "robustness",
  "security",
  "visual",
  "hygiene",
] as const;
export type GateFamily = (typeof GATE_FAMILIES)[number];

/** The Insights numbers and charts (§2.10), each taught. */
export const INSIGHTS_METRICS = [
  "cycle_time",
  "sle",
  "throughput",
  "wip",
  "work_item_age",
  "cumulative_flow",
  "burnup",
] as const;
export type InsightsMetric = (typeof INSIGHTS_METRICS)[number];

const FAMILY_OF: Record<string, GateFamily> = {
  parse: "static",
  typecheck: "static",
  types: "static",
  lint: "static",
  test: "functional",
  tests: "functional",
  unit: "functional",
  mutation: "robustness",
  stryker: "robustness",
  security: "security",
  secrets: "security",
  gitleaks: "security",
  osv: "security",
  semgrep: "security",
  licence: "security",
  license: "security",
  visual: "visual",
  playwright: "visual",
  bounds: "hygiene",
  size: "hygiene",
  integrity: "hygiene",
};

/** A check's family, from its layer when known, else its id, rung or label. */
export function gateFamilyOf(idOrLabel: string, layer?: string): GateFamily | undefined {
  if (layer && (GATE_FAMILIES as readonly string[]).includes(layer)) return layer as GateFamily;
  return FAMILY_OF[String(idOrLabel).toLowerCase()];
}

/** The numbers a lesson's own line is computed from; each lesson reads the ones it needs. */
export interface LearnFacts {
  /** The board column (or pipeline stage) the `?` sits on. */
  column?: string;
  /** Issues in that column now. */
  count?: number;
  /** That column's limit, for a column other than In review. */
  limit?: number;
  /** How the In review limit was reached (`/api/board`'s `reviewLimit`). */
  reviewLimit?: ReviewLimitFacts | null;
  /** The column's points, with Preferences → Estimation on story points. */
  points?: number;
  cycleTime?: { p50Hours?: number; p85Hours?: number; finished?: number };
  throughputPerDay?: number;
  wip?: { count: number; olderThanP85?: number; oldestHours?: number };
  /** Issues per board column today, in board order. */
  columns?: Record<string, number>;
  /** The burn-up's last day, in issues or, with estimation on, points. */
  burnup?: { done: number; scope: number; unit?: "points" | "issues" };
  sprint?: { name: string; done: number; total: number; daysLeft: number };
  release?: { heading: string; done: number; total: number };
  checks?: { id: string; label: string; state: string; layer?: string }[];
  /** The issue whose type the `?` explains (the issue page's type). */
  card?: { kind?: string; change?: string; tier?: string; split?: string; title?: string };
  /** The numbers the practice lessons read (§2.9.5, NEW-dashboard-13). */
  practice?: PracticeFacts;
}

/** What the practice lessons' own lines are computed from (DB-N13-2). */
export interface PracticeFacts {
  /** This person's last reviews (`reviewHistory`). */
  reviews?: { decided: number; accepted: number; requested: number; cameBackAccepted: number };
  inReview?: number;
  criteria?: { open: number; withCriteria: number };
  priorities?: { urgent: number; high: number; medium: number; low: number; none: number };
  blocked?: { open: number; waiting: number };
  /** The checks the project's gates run. */
  checks?: number;
  /** Issues waiting in Triage. */
  triage?: number;
  /** Issues in To do (sprint planning with no sprint running). */
  ready?: number;
  done?: number;
  onHold?: number;
}

interface Lesson {
  term: string;
  concept: string;
  source: Source;
  yours: (f: LearnFacts) => string;
}

/** What a `?` opens (DB-P4-3). */
export interface TipView {
  id: string;
  term: string;
  /** The `?` button's accessible name. */
  label: string;
  /** What it is, in two sentences at most. */
  concept: string;
  /** One line from this project's own numbers (DB-P4-4). */
  yours: string;
  source: Source;
  /** Further short lessons the popover lists (the checks' families). */
  more: { term: string; concept: string }[];
}

function labelOfColumn(id: string | undefined): string {
  if (!id) return "This column";
  if (id === WONT_DO_COLUMN.id) return WONT_DO_COLUMN.label;
  return BOARD_COLUMNS.find((c) => c.id === id)?.label ?? columnLabel(id);
}

function issues(n: number): string {
  return plural(n, "issue");
}

function holds(f: LearnFacts, name: string): string {
  return `${name} holds ${issues(f.count ?? 0)} now.`;
}

/** The In review limit and where it comes from, in this project's numbers (DB-P4-4). */
function reviewLimitLine(r: ReviewLimitFacts, count: number | undefined): string {
  const now = count === undefined ? "" : ` It holds ${count} now.`;
  if (r.fixed)
    return `In review holds at most ${r.limit}, a limit set in the project configuration.${now}`;
  if (r.minutesPerDay !== undefined && r.minutesPerCard !== undefined) {
    const basis = reviewBasis(r.reviews ?? 0, "a");
    return `In review holds at most ${r.limit} because you review about ${r.minutesPerDay} minutes a day and a review takes about ${Math.round(r.minutesPerCard)} minutes (${basis}).${now}`;
  }
  return `In review holds at most ${r.limit}.${now}`;
}

function wipLine(f: LearnFacts): string {
  const col = f.column ? (boardColumnOf(f.column) ?? f.column) : undefined;
  if (col === "in_review" && f.reviewLimit) return reviewLimitLine(f.reviewLimit, f.count);
  if (f.limit !== undefined) {
    const now = f.count === undefined ? "" : ` It holds ${f.count} now.`;
    return `${labelOfColumn(f.column)} holds at most ${f.limit}.${now}`;
  }
  if (f.reviewLimit) return reviewLimitLine(f.reviewLimit, f.count);
  return "No column on this board has a limit yet.";
}

function column(term: string, concept: string, source: Source): Lesson {
  return { term, concept, source, yours: (f) => holds(f, term) };
}

const P85 = (f: LearnFacts) => f.cycleTime?.p85Hours;
const NO_FLOW = "This project has no finished issues in this period yet.";

const LESSONS: Record<string, Lesson> = {
  "column:backlog": column(
    "Backlog",
    "Ideas and split-off work nobody has committed to yet. An issue leaves the Backlog once it is small, clear and has its acceptance criteria.",
    { label: "The Scrum Guide: Product Backlog", url: `${SCRUM.url}#product-backlog` },
  ),
  "column:todo": column(
    "To do",
    "Issues ready to start, and issues being planned. The Agent pulls from the top when it has room, so the order here is the order of work.",
    KANBAN,
  ),
  "column:in_progress": column(
    "In progress",
    "Work being built now: the Agent writes the change and runs the checks until they pass. An issue moves on only when every check passes, never on the Agent's word.",
    KANBAN,
  ),
  "column:in_review": {
    term: "In review",
    concept:
      "Finished work waiting for a person to accept or request changes on. Review is usually the slowest step, so it has a limit and the Agent holds new work while it is full.",
    source: KANBAN,
    yours: (f) => (f.reviewLimit ? reviewLimitLine(f.reviewLimit, f.count) : holds(f, "In review")),
  },
  "column:done": column(
    "Done",
    "Issues a person accepted after every check passed. Done needs both: the checks and a person's accept.",
    {
      label: "The Scrum Guide: Definition of Done",
      url: `${SCRUM.url}#commitment-definition-of-done`,
    },
  ),
  "column:on_hold": column(
    "On hold",
    "Issues stopped for something only a person can clear: a question, a failed attempt or a missing tool. Each one says why on the board.",
    KANBAN,
  ),
  "column:wont_do": column(
    "Won't do",
    "Issues a person decided not to build. They stay findable so the reason is not lost.",
    KANBAN,
  ),
  wip: {
    term: "WIP limit",
    concept:
      "A work-in-progress limit caps how many issues a column holds at once. Finishing before starting shortens every wait: time in progress is work in progress divided by throughput (Little's law).",
    source: KANBAN,
    yours: wipLine,
  },
  checks: {
    term: "Checks",
    concept:
      "Checks are the commands that decide whether work is finished: they build, type-check, test and measure the change. The Agent never marks its own work done; an issue is done when every check passes and a person accepts it.",
    source: CI,
    // REV-01: the verdict every view gives (`checksVerdict`), so the tip never counts differently.
    yours: (f) => {
      const list = (f.checks ?? []).map((c) => ({ ...c, failures: 0 }));
      if (!list.some((c) => c.state === "pass" || c.state === "fail"))
        return "No checks have run on this issue yet.";
      return `On this issue: ${checksVerdict(list as GateSummary[]).text}.`;
    },
  },
  "check:static": {
    term: "Static checks",
    concept:
      "Parse, type and lint checks read the code without running it. They catch the cheapest mistakes first, so they run before the tests.",
    source: CI,
    yours: familyLine("static"),
  },
  "check:functional": {
    term: "Tests",
    concept:
      "Tests run the code and compare what it does with the acceptance criteria. An issue's own tests are written first and must fail before the code exists.",
    source: PYRAMID,
    yours: familyLine("functional"),
  },
  "check:robustness": {
    term: "Mutation testing",
    concept:
      "Mutation testing changes the code on purpose and checks that a test notices. A change no test notices shows where the tests are too weak.",
    source: { label: "Mutation testing", url: "https://en.wikipedia.org/wiki/Mutation_testing" },
    yours: familyLine("robustness"),
  },
  "check:security": {
    term: "Security checks",
    concept:
      "Security checks look for leaked secrets, dependencies with known vulnerabilities and risky code patterns. A finding holds the issue until a person decides.",
    source: { label: "OWASP Top Ten", url: "https://owasp.org/www-project-top-ten/" },
    yours: familyLine("security"),
  },
  "check:visual": {
    term: "Visual checks",
    concept:
      "Visual checks compare screenshots of the page with an approved picture. A person approves each new picture before it becomes the reference.",
    source: {
      label: "Visual comparisons, Playwright",
      url: "https://playwright.dev/docs/test-snapshots",
    },
    yours: familyLine("visual"),
  },
  "check:hygiene": {
    term: "Size and integrity",
    concept:
      "Size checks keep each change small enough to review in one sitting, and integrity checks make sure no test or check was switched off. Small changes are reviewed faster and more carefully.",
    source: {
      label: "Small changes, Google engineering practices",
      url: "https://google.github.io/eng-practices/review/developer/small-cls.html",
    },
    yours: familyLine("hygiene"),
  },
  points: {
    term: "Story points",
    concept:
      "Points estimate an issue's size relative to other issues, not in hours: a 3 is about three times a 1. A team compares the points it finishes each sprint to plan the next.",
    source: {
      label: "What are story points?, Mike Cohn",
      url: "https://www.mountaingoatsoftware.com/blog/what-are-story-points",
    },
    yours: (f) =>
      f.points === undefined
        ? "No issue on this board has points yet."
        : `${labelOfColumn(f.column)} holds ${plural(f.points, "point")} of work.`,
  },
  sprint: {
    term: "Sprint",
    concept:
      "A sprint is a fixed stretch of time with a goal the team commits to. The header compares the work done with the time gone.",
    source: { label: "The Scrum Guide: The Sprint", url: `${SCRUM.url}#the-sprint` },
    yours: (f) =>
      f.sprint
        ? `${f.sprint.name}: ${f.sprint.done} of ${f.sprint.total} done, ${plural(f.sprint.daysLeft, "day")} left.`
        : "No sprint is in force.",
  },
  "metric:cycle_time": {
    term: "Cycle time",
    concept:
      "Cycle time is how long an issue takes from starting work to done. Percentiles are used, not averages, because a few slow issues hide in a mean.",
    source: KANBAN,
    yours: (f) => {
      const c = f.cycleTime;
      if (!c || c.p50Hours === undefined || c.p85Hours === undefined) return NO_FLOW;
      const n = c.finished === undefined ? "" : ` (${c.finished} finished)`;
      return `Half of this project's issues finish within ${formatHours(c.p50Hours)}, and 85% within ${formatHours(c.p85Hours)}${n}.`;
    },
  },
  "metric:sle": {
    term: "Service level expectation",
    concept:
      "A service level expectation says how long most issues take, from your own history: 85% finish within a stated time. It lets you spot an issue running late while there is still time to act.",
    source: KANBAN,
    yours: (f) => {
      const p = P85(f);
      return p === undefined
        ? NO_FLOW
        : `85% of this project's issues finish within ${formatHours(p)}.`;
    },
  },
  "metric:throughput": {
    term: "Throughput",
    concept:
      "Throughput counts the issues finished per day. With work in progress it tells how long new work waits (Little's law).",
    source: KANBAN,
    yours: (f) =>
      f.throughputPerDay === undefined
        ? NO_FLOW
        : `This project finishes about ${f.throughputPerDay.toFixed(1).replace(/\.0$/, "")} ${f.throughputPerDay === 1 ? "issue" : "issues"} a day.`,
  },
  "metric:wip": {
    term: "Work in progress",
    concept:
      "Work in progress is every issue started and not yet done. The less of it at once, the sooner each issue finishes.",
    source: KANBAN,
    yours: (f) => {
      const w = f.wip;
      if (!w) return "Nothing is in progress.";
      const old = w.olderThanP85 ?? 0;
      return `${issues(w.count)} ${w.count === 1 ? "is" : "are"} in progress; ${old === 0 ? "none is" : `${old} ${old === 1 ? "is" : "are"}`} older than 85% of finished issues.`;
    },
  },
  "metric:work_item_age": {
    term: "Work item age",
    concept:
      "Work item age is how long an unfinished issue has been in progress. An issue older than most finished issues is at risk of running late.",
    source: KANBAN,
    yours: (f) => {
      const oldest = f.wip?.oldestHours;
      const p = P85(f);
      if (oldest === undefined) return "Nothing is in progress.";
      const tail = p === undefined ? "" : `; 85% of finished issues took ${formatHours(p)} or less`;
      return `The oldest issue in progress is ${formatHours(oldest)} old${tail}.`;
    },
  },
  "metric:cumulative_flow": {
    term: "Cumulative flow",
    concept:
      "Cumulative flow stacks how many issues sit in each column, day by day. A band that widens is a queue forming there.",
    source: KANBAN,
    yours: (f) => {
      const cols = Object.entries(f.columns ?? {});
      if (!cols.length) return "This board has no issues yet.";
      return `Today: ${cols.map(([name, n]) => `${n} in ${name}`).join(", ")}.`;
    },
  },
  "metric:burnup": {
    term: "Burn-up",
    concept:
      "A burn-up draws work done and total scope as two lines. When the scope line rises, work was added; the gap between the lines is what is left.",
    source: {
      label: "Burn-up and burn-down charts",
      url: "https://en.wikipedia.org/wiki/Burn_down_chart",
    },
    yours: (f) => {
      const b = f.burnup;
      if (!b) return "No issue has been finished yet.";
      const whole = plural(b.scope, b.unit === "points" ? "point" : "issue");
      return `${b.done} of ${whole} ${b.scope === 1 ? "is" : "are"} done; ${Math.max(0, b.scope - b.done)} are left.`;
    },
  },
  release: {
    term: "Release",
    concept:
      "A release is a set of requirements that ships together, cut across the whole story map so it works end to end. Each requirement is planned into the earliest release that needs it.",
    source: STORY_MAP,
    yours: releaseLine,
  },
  first_release: {
    term: "First release",
    concept:
      "The first release is the thinnest version that works end to end across every activity, what teams call a walking skeleton. Building it first proves the whole path before any part is polished.",
    source: {
      label: "Walking skeleton, Alistair Cockburn",
      url: "https://wiki.c2.com/?WalkingSkeleton",
    },
    yours: releaseLine,
  },
};

// ---------------------------------------------------------------------------
// The practice a person performs (§2.9.5, NEW-dashboard-13; FINDINGS PRC-05)
// ---------------------------------------------------------------------------

const ATLASSIAN_REVIEW: Source = {
  label: "Atlassian: code reviews",
  url: "https://www.atlassian.com/agile/software-development/code-reviews",
};

/** The practice lessons, in the order §2.9.5 names them. */
export const PRACTICE_LESSONS = [
  "practice:review",
  "practice:request_changes",
  "practice:criteria",
  "practice:priority",
  "practice:blocked",
  "practice:definition_of_done",
  "practice:triage",
  "practice:sprint_planning",
  "practice:retrospective",
] as const;
export type PracticeLesson = (typeof PRACTICE_LESSONS)[number];

const waitsIn = (n: number, where: string) =>
  `${issues(n)} ${n === 1 ? "waits" : "wait"} in ${where} now.`;

const PRACTICE: Record<PracticeLesson, Lesson> = {
  "practice:review": {
    term: "Reviewing a change",
    concept:
      "A review reads the change against its acceptance criteria and the checks' results before anything reaches main. Read what changed and why, then Accept or Request changes; a review held to one issue at a time stays quick.",
    source: ATLASSIAN_REVIEW,
    yours: (f) => {
      const r = f.practice?.reviews;
      const waiting = f.practice?.inReview;
      const queue = waiting === undefined ? "" : ` ${waitsIn(waiting, "In review")}`;
      if (!r || r.decided === 0) return `You have not reviewed an issue here yet.${queue}`;
      return `You reviewed ${issues(r.decided)} here: ${r.accepted} accepted, changes requested on ${r.requested}.${queue}`;
    },
  },
  "practice:request_changes": {
    term: "Request changes",
    concept:
      "Request changes returns the issue to To do with your note, and the note is the first thing the Agent reads next. A useful note names the file, the behaviour you expected and the check that should prove it.",
    source: ATLASSIAN_REVIEW,
    yours: (f) => {
      const r = f.practice?.reviews;
      if (!r || r.requested === 0) return "You have not requested changes here yet.";
      return `You requested changes on ${r.requested} of your last ${plural(r.decided, "review")}; ${r.cameBackAccepted} of those came back and ${r.cameBackAccepted === 1 ? "was" : "were"} accepted on the next review.`;
    },
  },
  "practice:criteria": {
    term: "Acceptance criteria",
    concept:
      "Acceptance criteria are the testable statements that say when an issue is finished. Approving them before the Agent starts means the checks prove what you meant, not what was guessed.",
    source: {
      label: "Atlassian: acceptance criteria",
      url: "https://www.atlassian.com/work-management/project-management/acceptance-criteria",
    },
    yours: (f) => {
      const c = f.practice?.criteria;
      if (!c || c.open === 0) return "No issue is open here yet.";
      return `${c.withCriteria} of ${c.open} open ${c.open === 1 ? "issue" : "issues"} here ${c.withCriteria === 1 ? "has" : "have"} acceptance criteria.`;
    },
  },
  "practice:priority": {
    term: "Priority",
    concept:
      "Priority says what to do first when everything cannot be done at once, from Urgent to Low. Requirements use MoSCoW the same way: Must have, Should have, Could have and Won't have this time.",
    source: { label: "Linear: priority", url: "https://linear.app/docs/priority" },
    yours: (f) => {
      const p = f.practice?.priorities;
      if (!p) return "No issue is open here yet.";
      return `Open issues here: ${p.urgent} Urgent, ${p.high} High, ${p.medium} Medium, ${p.low} Low and ${p.none} with no priority.`;
    },
  },
  "practice:blocked": {
    term: "Blocked work",
    concept:
      "An issue is blocked when it waits on another to finish first. Naming what blocks it lets the board order the work and shows where one late issue holds up others.",
    source: { label: "Linear: issue relations", url: "https://linear.app/docs/issue-relations" },
    yours: (f) => {
      const b = f.practice?.blocked;
      if (!b || b.open === 0) return "No issue is open here yet.";
      return `${b.waiting} of ${b.open} open ${b.open === 1 ? "issue waits" : "issues wait"} on another issue to finish.`;
    },
  },
  "practice:definition_of_done": {
    term: "Definition of done",
    concept:
      "The Definition of done is the team's shared statement of when work is finished, the same for every issue. Here it is enforced, not only written: the checks must pass and a person must accept.",
    source: {
      label: "The Scrum Guide: Definition of Done",
      url: `${SCRUM.url}#commitment-definition-of-done`,
    },
    yours: (f) => {
      const n = f.practice?.checks;
      const checks =
        n === undefined ? "checks" : `${n} ${n === 1 ? "check passes" : "checks pass"}`;
      return n === undefined
        ? "Here an issue is done when its checks pass and a person the Accept rule names accepts it."
        : `Here an issue is done when its ${checks} and a person the Accept rule names accepts it.`;
    },
  },
  "practice:triage": {
    term: "Triage",
    concept:
      "Triage is the first look at work filed by people outside the team, before it joins the Backlog. Accept it, mark it a duplicate, or close it as Won't do, so the Backlog holds only work the team means to do.",
    source: { label: "Linear: triage", url: "https://linear.app/docs/triage" },
    yours: (f) => {
      const n = f.practice?.triage;
      return n === undefined || n === 0 ? "Nothing waits in Triage now." : waitsIn(n, "Triage");
    },
  },
  "practice:sprint_planning": {
    term: "Sprint planning",
    concept:
      "Sprint planning chooses the issues the team commits to for the next sprint, and the goal they serve. Commit to what recent sprints show the team finishes, not to everything that is ready.",
    source: { label: "The Scrum Guide: Sprint Planning", url: `${SCRUM.url}#sprint-planning` },
    yours: (f) => {
      const s = f.sprint;
      if (s)
        return `${s.name} has ${s.done} of ${plural(s.total, "issue")} done, with ${plural(s.daysLeft, "day")} left.`;
      const ready = f.practice?.ready;
      return ready === undefined
        ? "No sprint is running."
        : `No sprint is running; ${plural(ready, "issue")} ${ready === 1 ? "is" : "are"} in To do.`;
    },
  },
  "practice:retrospective": {
    term: "Retrospective",
    concept:
      "A retrospective looks back at how the work went, not at what was built, and picks one or two changes to try next. It works best right after a sprint or a release, while the facts are fresh.",
    source: {
      label: "The Scrum Guide: Sprint Retrospective",
      url: `${SCRUM.url}#sprint-retrospective`,
    },
    yours: (f) => {
      const done = f.practice?.done;
      if (done === undefined) return "Nothing is Done here yet.";
      const held = f.practice?.onHold ?? 0;
      return `${plural(done, "issue")} ${done === 1 ? "is" : "are"} Done here and ${held} ${held === 1 ? "is" : "are"} on hold: what held them up is a place to start.`;
    },
  },
};

interface DecidedEvent {
  seq: number;
  cardId?: string;
  principal?: string;
  type?: string;
  payload?: unknown;
}

/**
 * This person's last ten reviews (`review/decided`), and of the changes they
 * requested, how many were accepted at the issue's next review (DB-N13-2).
 */
export function reviewHistory(
  events: readonly DecidedEvent[],
  me: string,
): { decided: number; accepted: number; requested: number; cameBackAccepted: number } {
  const all = [...events]
    .filter((e) => !e.type || e.type === "review/decided")
    .sort((a, b) => a.seq - b.seq);
  const body = (e: DecidedEvent) =>
    (e.payload ?? {}) as { decision?: string; principal?: string; id?: string };
  const decision = (e: DecidedEvent) => body(e).decision;
  // The event's own principal, else the one `review/decided` records in its payload.
  const who = (e: DecidedEvent) => e.principal ?? body(e).principal;
  const card = (e: DecidedEvent) => e.cardId ?? body(e).id;
  const mine = all.filter((e) => who(e) === me).slice(-10);
  let requested = 0;
  let cameBackAccepted = 0;
  for (const e of mine) {
    if (decision(e) !== "send_back") continue;
    requested++;
    const next = all.find((n) => n.seq > e.seq && card(n) === card(e));
    if (next && decision(next) === "accept") cameBackAccepted++;
  }
  return {
    decided: mine.length,
    accepted: mine.filter((e) => decision(e) === "accept").length,
    requested,
    cameBackAccepted,
  };
}

interface BoardCardLike {
  status: string;
  priority?: number;
  acceptanceCriteria?: readonly unknown[];
  display?: { waitsOn?: readonly unknown[] };
}

/** The practice lessons' board numbers: open issues' criteria, priorities, blocked work. */
export function boardPracticeFacts(cards: readonly BoardCardLike[]): PracticeFacts {
  const open = cards.filter((c) => c.status !== "done" && c.status !== "rejected");
  const priorities = { urgent: 0, high: 0, medium: 0, low: 0, none: 0 };
  const key = ["none", "urgent", "high", "medium", "low"] as const;
  for (const c of open) priorities[key[c.priority ?? 0] ?? "none"]++;
  return {
    inReview: cards.filter((c) => c.status === "review").length,
    criteria: {
      open: open.length,
      withCriteria: open.filter((c) => (c.acceptanceCriteria?.length ?? 0) > 0).length,
    },
    priorities,
    blocked: {
      open: open.length,
      waiting: open.filter((c) => (c.display?.waitsOn?.length ?? 0) > 0).length,
    },
    ready: cards.filter((c) => c.status === "ready").length,
    done: cards.filter((c) => c.status === "done").length,
    onHold: cards.filter((c) => c.status === "parked").length,
  };
}

/** The practice lessons already offered in this browser (DB-N13-3). */
export const LESSONS_SEEN_KEY = "sekhemet-lessons-seen";

function seenLessons(storage: StorageLike | undefined): string[] | undefined {
  try {
    const raw = storage?.getItem(LESSONS_SEEN_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return undefined;
  }
}

/**
 * Whether a practice lesson is still to be offered here, as its `?` marked
 * new. A browser that keeps nothing never marks one new, so none stays new.
 */
export function lessonIsNew(storage: StorageLike | undefined, id: string): boolean {
  const seen = seenLessons(storage);
  return seen !== undefined && !seen.includes(id);
}

export function markLessonsSeen(storage: StorageLike | undefined, ids: readonly string[]): void {
  const seen = seenLessons(storage);
  if (!seen) return;
  const next = [...new Set([...seen, ...ids])];
  try {
    storage?.setItem(LESSONS_SEEN_KEY, JSON.stringify(next));
  } catch {}
}

/** A practice lesson's `?`: the Tip's button, marked new the first time (DB-N13-3). */
export function practiceTipHtml(
  on: boolean,
  id: string,
  term: string,
  ctx = "",
  isNew = false,
): string {
  const html = tipButtonHtml(on, id, isNew ? `${term}, new` : term, ctx);
  return html && isNew ? html.replace("<button ", '<button data-new="true" ') : html;
}

function releaseLine(f: LearnFacts): string {
  const r = f.release;
  if (!r) return "No release is planned yet.";
  return `${r.heading}: ${r.done} of ${plural(r.total, "requirement")} done.`;
}

function familyLine(family: GateFamily): (f: LearnFacts) => string {
  return (f) => {
    const mine = (f.checks ?? []).filter((c) => gateFamilyOf(c.id, c.layer) === family);
    if (!mine.length) return "None of these ran on this issue.";
    const said = (c: { label: string; state: string }) =>
      `${c.label} ${c.state === "pass" ? "passed" : c.state === "fail" ? "failed" : "did not run"}`;
    return `${mine.map(said).join(", ")}.`;
  };
}

/** The lesson for a board column or pipeline stage: a stage is taught as its column. */
export function columnLessonId(id: string): string {
  if (LESSONS[`column:${id}`]) return `column:${id}`;
  const col = boardColumnOf(id);
  return `column:${col ?? id}`;
}

/** What a `?` opens: the concept, this project's line and the canonical link (DB-P4-3). */
export function tipFor(id: string, facts: LearnFacts): TipView {
  if (id === "type") return kindTip(facts.card ?? {});
  const l = LESSONS[id] ?? PRACTICE[id as PracticeLesson];
  if (!l) throw new Error(`No lesson for ${id}`);
  const more: TipView["more"] = [];
  if (id === "checks") {
    const seen = new Set<GateFamily>();
    for (const c of facts.checks ?? []) {
      const fam = gateFamilyOf(c.id, c.layer) ?? gateFamilyOf(c.label);
      if (!fam || seen.has(fam)) continue;
      seen.add(fam);
      const f = LESSONS[`check:${fam}`] as Lesson;
      more.push({ term: f.term, concept: f.concept });
    }
  }
  return {
    id,
    term: l.term,
    label: `About ${l.term}`,
    concept: l.concept,
    yours: l.yours(facts),
    source: l.source,
    more,
  };
}

// ---------------------------------------------------------------------------
// Issue types, and what a split child's split was (§2.4 issue type row)
// ---------------------------------------------------------------------------

const SPLIT_AXES: Record<string, string> = {
  spike: "Spike: the unknown answered first, apart from the build.",
  path: "Path: one way through it, built end to end.",
  interface: "Interface: one way a person reaches it.",
  data: "Data: one kind of data it handles.",
  rules: "Rules: one of its rules, the rest later.",
};

const TYPE_SOURCES: Record<string, Source> = {
  story: INVEST,
  task: SCRUM,
  bug: PYRAMID,
  spike: {
    label: "Spikes, Agile Alliance",
    url: "https://www.agilealliance.org/glossary/spike/",
  },
  epic: STORY_MAP,
};

/**
 * An issue's type explained (DB-P4-6). An interface issue — the internal kind
 * the older design called *Contract* — is an **enabler**: it fixes the shape
 * other issues build on and adds no behaviour of its own, so it is never
 * called a split. Otherwise a split child names its SPIDR axis from its
 * stored `split`, never derived from its kind.
 */
export function kindTip(card: {
  kind?: string;
  change?: string;
  tier?: string;
  split?: string;
  title?: string;
}): TipView {
  const enabler = card.kind === "interface" || card.kind === "contract";
  if (enabler) {
    return {
      id: "type",
      term: "Enabler",
      label: "About enablers",
      concept:
        "An enabler fixes the shape other issues build on, such as types, an API or a schema, before they are built. It adds no behaviour a person uses by itself, which is why it is planned before the stories that need it.",
      yours: "Other issues on this board build on what this one fixes.",
      source: {
        label: "Enablers, Scaled Agile Framework",
        url: "https://scaledagileframework.com/enablers/",
      },
      more: [],
    };
  }
  const type = issueTypeOf(card);
  const meta = ISSUE_TYPE_LABELS[type];
  // Display only: destructured so the K-N9-4 scan (no decision reads `split`) stays exact.
  const { split } = card;
  const axis = split ? SPLIT_AXES[split] : undefined;
  return {
    id: "type",
    term: meta.label,
    label: `About ${meta.label}`,
    concept: meta.tooltip,
    yours: axis
      ? `Split from a larger story along its ${axis}`
      : "This issue was not split from a larger one.",
    source: TYPE_SOURCES[type] ?? INVEST,
    more: [],
  };
}

// ---------------------------------------------------------------------------
// The `?` button (DB-P4-1, -2)
// ---------------------------------------------------------------------------

function attr(v: string): string {
  return (
    v
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      // A `$` in a title must not become a replacement pattern where a page
      // splices this markup in with String.replace.
      .replace(/\$/g, "&#36;")
  );
}

/**
 * The `?` beside a term: nothing at all with Tips off, so the page's DOM and
 * layout are exactly those without the feature (DB-P4-1); on, a real button a
 * keyboard reaches, named for its term, whose lesson and context the popover
 * reads when it opens.
 */
export function tipButtonHtml(on: boolean, id: string, term: string, ctx = ""): string {
  if (!on) return "";
  const c = ctx ? ` data-tip-ctx="${attr(ctx)}"` : "";
  return `<button class="tip-q" type="button" data-tip="${attr(id)}"${c} aria-label="About ${attr(term)}" aria-haspopup="dialog" aria-expanded="false">?</button>`;
}
