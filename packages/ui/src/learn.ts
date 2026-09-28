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
import type { ReviewLimitFacts } from "./columns.js";
import { formatHours } from "./pm.js";
import {
  BOARD_COLUMNS,
  ISSUE_TYPE_LABELS,
  WONT_DO_COLUMN,
  boardColumnOf,
  columnLabel,
  issueTypeOf,
  plural,
} from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Settings kept per browser: Tips and the first-run answer (§3 per-browser)
// ---------------------------------------------------------------------------

export const TIPS_KEY = "sekhemet-tips";
export const ROLE_KEY = "sekhemet-role";

/** The first-run answers; `later` is *Not now*: asked, no answer given. */
export type FirstRunRole = "code" | "manage" | "learn";
export type StoredRole = FirstRunRole | "later";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The one question the first visit asks (§2.2.5). */
export const FIRST_RUN = {
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
  return r === "code" || r === "manage" || r === "learn" || r === "later" ? r : null;
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
  if (role === "code" || role === "manage" || role === "learn" || role === "later")
    write(storage, ROLE_KEY, role);
}

/** Keep the answer and set Tips from it: on for *I'm learning*, off otherwise (DB-P4-7). */
export function answerFirstRun(storage: StorageLike | undefined, role: StoredRole): void {
  write(storage, ROLE_KEY, role);
  writeTips(storage, role === "learn");
}

/** The question shows once, and only once a model is set up (§2.2.5, DB-N6-2). */
export function firstRunDue(storage: StorageLike | undefined, f: { noModel: boolean }): boolean {
  return !f.noModel && readRole(storage) === null;
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
}

/**
 * The page the dashboard opens on (§2.2.5): Configuration › Models while no
 * model is set up; in the Team setup the profile label decides (a Product
 * owner or a Stakeholder on Status, anyone else as *I write code*); in Solo
 * the first-run answer; with none, Status for a person who has never
 * accepted an issue.
 */
export function defaultRouteFor(f: RouteFacts): string {
  if (f.noModel) return "#/configuration/models";
  const dev = f.reviewWaiting ? "#/review" : "#/board";
  if (f.team) {
    const label = (f.profileLabel ?? "").trim().toLowerCase();
    return label === "product owner" || label === "stakeholder" ? "#/status" : dev;
  }
  if (f.role === "code") return dev;
  if (f.role === "manage") return "#/status";
  if (f.role === "learn") return "#/board";
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
    const basis =
      (r.reviews ?? 0) > 0
        ? `the median of ${plural(r.reviews ?? 0, "review")}`
        : "a starting estimate until you review an issue";
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
      "Finished work waiting for a person to accept or send back. Review is usually the slowest step, so it has a limit and the Agent holds new work while it is full.",
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
    "Issues stopped for something only a person can clear: a question, a failed attempt or a missing tool. Each one says why on its card.",
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
    yours: (f) => {
      const list = f.checks ?? [];
      const ran = list.filter((c) => c.state === "pass" || c.state === "fail");
      if (!ran.length) return "No checks have run on this issue yet.";
      const passed = ran.filter((c) => c.state === "pass").length;
      const failed = list.filter((c) => c.state === "fail").map((c) => c.label);
      return `On this issue ${passed} of ${plural(ran.length, "check")} passed${failed.length ? `; ${failed.join(", ")} failed` : ""}.`;
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
  const l = LESSONS[id];
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
      label: "About Enabler",
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
