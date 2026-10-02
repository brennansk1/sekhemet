import { describe, expect, it } from "vitest";
import {
  FIRST_RUN,
  GATE_FAMILIES,
  INSIGHTS_METRICS,
  ROLE_KEY,
  TIPS_KEY,
  answerFirstRun,
  columnLessonId,
  defaultRouteFor,
  firstRunDue,
  gateFamilyOf,
  kindTip,
  readRole,
  readTips,
  tipButtonHtml,
  tipFor,
  writeRole,
  writeTips,
} from "../src/learn.js";
import { BOARD_COLUMNS, PIPELINE_COLUMNS, WONT_DO_COLUMN } from "../src/vocabulary.js";

// dashboard §2.9, P4 (DB-P4-1..8): Tips, the on-screen name of the Learn
// layer (DEC-31). The page renders what these return and nothing else.

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    map: m,
  };
}

/** A tip is teaching, never a template: two sentences at most, its own line, a canonical link. */
function wellFormed(id: string) {
  const t = tipFor(id, {});
  expect(t.term, id).not.toBe("");
  expect(t.concept, id).not.toBe("");
  expect(t.concept.split(/(?<=[.!?])\s+/).length, id).toBeLessThanOrEqual(2);
  expect(t.yours, id).not.toBe("");
  expect(t.source.url, id).toMatch(/^https:\/\//);
  expect(t.source.label, id).not.toBe("");
  expect(t.label, id).toBe(`About ${t.term}`);
}

describe("DB-P4-5: a lesson for every board column, check family and Insights metric", () => {
  it("every board column, pipeline stage and Won't do has a lesson", () => {
    const ids = [...BOARD_COLUMNS, ...PIPELINE_COLUMNS, WONT_DO_COLUMN].map((c) => c.id);
    for (const id of ids) wellFormed(columnLessonId(id));
    expect(BOARD_COLUMNS.map((c) => columnLessonId(c.id))).toEqual([
      "column:backlog",
      "column:todo",
      "column:in_progress",
      "column:in_review",
      "column:done",
      "column:on_hold",
    ]);
    // A pipeline stage is taught as the board column it belongs to.
    expect(columnLessonId("verify")).toBe("column:in_progress");
    expect(columnLessonId("planning")).toBe("column:todo");
    expect(columnLessonId("parked")).toBe("column:on_hold");
    expect(columnLessonId("rejected")).toBe("column:wont_do");
  });

  it("every check family has a lesson, and every check the page names maps to one", () => {
    expect(GATE_FAMILIES).toEqual([
      "static",
      "functional",
      "robustness",
      "security",
      "visual",
      "hygiene",
    ]);
    for (const f of GATE_FAMILIES) wellFormed(`check:${f}`);
    wellFormed("checks");
    expect(
      ["parse", "typecheck", "Types", "lint", "test", "Tests", "bounds", "Size", "visual"].map(
        (g) => gateFamilyOf(g),
      ),
    ).toEqual([
      "static",
      "static",
      "static",
      "static",
      "functional",
      "functional",
      "hygiene",
      "hygiene",
      "visual",
    ]);
    expect(gateFamilyOf("gitleaks")).toBe("security");
    expect(gateFamilyOf("mutation")).toBe("robustness");
    expect(gateFamilyOf("whatever", "security")).toBe("security");
    expect(gateFamilyOf("whatever")).toBeUndefined();
  });

  it("every Insights metric has a lesson", () => {
    expect(INSIGHTS_METRICS).toEqual([
      "cycle_time",
      "sle",
      "throughput",
      "wip",
      "work_item_age",
      "cumulative_flow",
      "burnup",
    ]);
    for (const m of INSIGHTS_METRICS) wellFormed(`metric:${m}`);
  });

  it("the WIP limit, points, the sprint and the story map's releases have lessons", () => {
    for (const id of ["wip", "points", "sprint", "release", "first_release"]) wellFormed(id);
  });

  it("an unknown lesson is an error, never an empty popover", () => {
    expect(() => tipFor("column:nowhere", {})).toThrow(/column:nowhere/);
  });
});

describe("DB-P4-3, DB-P4-4: each popover's line comes from the project's own numbers", () => {
  it("In review's limit of 3 at 60 review minutes a day says so, with those numbers", () => {
    const t = tipFor("wip", {
      column: "in_review",
      count: 2,
      reviewLimit: { limit: 3, fixed: false, minutesPerDay: 60, minutesPerCard: 20, reviews: 5 },
    });
    expect(t.term).toBe("WIP limit");
    expect(t.yours).toBe(
      "In review holds at most 3 because you review about 60 minutes a day and a review takes about 20 minutes (the median of 5 reviews). It holds 2 now.",
    );
    expect(t.source).toEqual({
      label: "The Kanban Guide",
      url: "https://kanbanguides.org/the-kanban-guide/",
    });
  });

  it("before the first review the limit says it is the starting estimate", () => {
    expect(
      tipFor("wip", {
        column: "in_review",
        count: 0,
        reviewLimit: { limit: 4, fixed: false, minutesPerDay: 60, minutesPerCard: 15, reviews: 0 },
      }).yours,
    ).toBe(
      "In review holds at most 4 because you review about 60 minutes a day and a review takes about 15 minutes (a starting estimate until you review an issue). It holds 0 now.",
    );
  });

  it("BRD-04: under five reviews the line still names the starting estimate, and how many so far", () => {
    expect(
      tipFor("wip", {
        column: "in_review",
        count: 1,
        reviewLimit: { limit: 4, fixed: false, minutesPerDay: 60, minutesPerCard: 15, reviews: 1 },
      }).yours,
    ).toBe(
      "In review holds at most 4 because you review about 60 minutes a day and a review takes about 15 minutes (a starting estimate until five reviews are recorded; 1 so far). It holds 1 now.",
    );
  });

  it("a limit a person fixed, and a column with none, say so", () => {
    expect(
      tipFor("wip", { column: "in_review", count: 3, reviewLimit: { limit: 3, fixed: true } })
        .yours,
    ).toBe("In review holds at most 3, a limit set in the project configuration. It holds 3 now.");
    expect(tipFor("wip", { column: "ready", count: 2, limit: 5 }).yours).toBe(
      "Ready holds at most 5. It holds 2 now.",
    );
    expect(tipFor("wip", {}).yours).toBe("No column on this board has a limit yet.");
  });

  it("a column's line counts its issues", () => {
    expect(tipFor("column:in_review", { count: 1 }).yours).toBe("In review holds 1 issue now.");
    expect(tipFor("column:backlog", { count: 7 }).yours).toBe("Backlog holds 7 issues now.");
  });

  it("In review's column lesson carries the limit's numbers too", () => {
    expect(
      tipFor("column:in_review", {
        count: 2,
        reviewLimit: { limit: 3, fixed: false, minutesPerDay: 60, minutesPerCard: 20, reviews: 5 },
      }).yours,
    ).toBe(
      "In review holds at most 3 because you review about 60 minutes a day and a review takes about 20 minutes (the median of 5 reviews). It holds 2 now.",
    );
  });

  it("the Insights lessons read this project's flow", () => {
    const flow = {
      cycleTime: { p50Hours: 2.1, p85Hours: 6.2, finished: 12 },
      throughputPerDay: 1.4,
      wip: { count: 5, olderThanP85: 1, oldestHours: 9 },
      columns: { "To do": 4, "In progress": 2, "In review": 3, Done: 10 },
    };
    expect(tipFor("metric:cycle_time", flow).yours).toBe(
      "Half of this project's issues finish within 2.1h, and 85% within 6.2h (12 finished).",
    );
    expect(tipFor("metric:sle", flow).yours).toBe(
      "85% of this project's issues finish within 6.2h.",
    );
    expect(tipFor("metric:throughput", flow).yours).toBe(
      "This project finishes about 1.4 issues a day.",
    );
    expect(tipFor("metric:wip", flow).yours).toBe(
      "5 issues are in progress; 1 is older than 85% of finished issues.",
    );
    expect(tipFor("metric:work_item_age", flow).yours).toBe(
      "The oldest issue in progress is 9h old; 85% of finished issues took 6.2h or less.",
    );
    expect(tipFor("metric:cumulative_flow", flow).yours).toBe(
      "Today: 4 in To do, 2 in In progress, 3 in In review, 10 in Done.",
    );
    expect(tipFor("metric:cycle_time", {}).yours).toBe(
      "This project has no finished issues in this period yet.",
    );
  });

  it("the burn-up, the sprint, points and releases read their own numbers", () => {
    expect(tipFor("metric:burnup", { burnup: { done: 8, scope: 13 } }).yours).toBe(
      "8 of 13 issues are done; 5 are left.",
    );
    expect(tipFor("metric:burnup", { burnup: { done: 1, scope: 1, unit: "points" } }).yours).toBe(
      "1 of 1 point is done; 0 are left.",
    );
    expect(
      tipFor("sprint", { sprint: { name: "Sprint 4", done: 3, total: 8, daysLeft: 2 } }).yours,
    ).toBe("Sprint 4: 3 of 8 done, 2 days left.");
    expect(tipFor("points", { column: "todo", points: 13 }).yours).toBe(
      "To do holds 13 points of work.",
    );
    expect(tipFor("release", { release: { heading: "Release 2", done: 3, total: 5 } }).yours).toBe(
      "Release 2: 3 of 5 requirements done.",
    );
  });

  it("the checks lesson names this issue's results and teaches each family present", () => {
    const t = tipFor("checks", {
      checks: [
        { id: "typecheck", label: "Types", state: "pass" },
        { id: "test", label: "Tests", state: "fail" },
        { id: "bounds", label: "Size", state: "pass" },
      ],
    });
    // REV-01: the same verdict the Review queue and the Checks heading give.
    expect(t.yours).toBe("On this issue: Tests failed · 2 of 3 passed.");
    expect(
      tipFor("checks", {
        checks: [
          { id: "unit", label: "Tests", state: "pass" },
          { id: "osv", label: "OSV", state: "skipped" },
        ],
      }).yours,
    ).toBe("On this issue: 1 check that ran passed · OSV skipped.");
    expect(t.more.map((m) => m.term)).toEqual(["Static checks", "Tests", "Size and integrity"]);
    expect(tipFor("checks", { checks: [] }).yours).toBe("No checks have run on this issue yet.");
  });

  it("only Tips say *walking skeleton*: the first release names it", () => {
    expect(tipFor("first_release", {}).concept).toMatch(/walking skeleton/);
    expect(tipFor("release", {}).concept).not.toMatch(/walking skeleton/);
  });
});

describe("DB-P4-6: an enabler is explained as one, never as a SPIDR split", () => {
  const SPIDR = /\b(spike|path|interface|data|rules?)\b|SPIDR/i;

  it("an interface issue (the old *Contract*) is an enabler, and no split axis is named", () => {
    for (const kind of ["interface", "contract"]) {
      const t = kindTip({ kind, split: "interface" });
      expect(t.concept).toMatch(/\benabler\b/i);
      expect(`${t.term} ${t.concept} ${t.yours}`).not.toMatch(SPIDR);
    }
  });

  it("a split child names its SPIDR axis from its stored split, never from its kind", () => {
    const t = kindTip({ kind: "implement", split: "path" });
    expect(t.term).toBe("Story");
    expect(t.yours).toBe(
      "Split from a larger story along its Path: one way through it, built end to end.",
    );
    expect(kindTip({ kind: "data" }).yours).toBe("This issue was not split from a larger one.");
    expect(kindTip({ change: "fix" }).term).toBe("Bug");
  });

  it("the issue page's ? on the type opens the same lesson", () => {
    expect(tipFor("type", { card: { kind: "interface" } })).toEqual(kindTip({ kind: "interface" }));
    expect(tipFor("type", { card: { kind: "implement", split: "rules" } }).yours).toBe(
      "Split from a larger story along its Rules: one of its rules, the rest later.",
    );
  });
});

describe("DB-P4-1, DB-P4-2: with Tips off nothing renders; on, a labelled ? button", () => {
  it("off: no markup at all", () => {
    expect(tipButtonHtml(false, "column:in_review", "In review")).toBe("");
  });

  it("on: one button with its name, the lesson and its context", () => {
    expect(tipButtonHtml(true, "wip", "WIP limit", "in_review")).toBe(
      '<button class="tip-q" type="button" data-tip="wip" data-tip-ctx="in_review" aria-label="About WIP limit" aria-haspopup="dialog" aria-expanded="false">?</button>',
    );
    // Spliced into a page with String.replace: a `$` must not act as a pattern.
    expect(tipButtonHtml(true, "type", "Story", '{"t":"$&"}')).toContain(
      'data-tip-ctx="{&quot;t&quot;:&quot;&#36;&amp;&quot;}"',
    );
    expect(tipButtonHtml(true, "metric:burnup", 'Burn-up "chart"')).toBe(
      '<button class="tip-q" type="button" data-tip="metric:burnup" aria-label="About Burn-up &quot;chart&quot;" aria-haspopup="dialog" aria-expanded="false">?</button>',
    );
  });
});

describe("DB-P4-7: the first-run question sets Tips and the default route", () => {
  it("asks one question with four answers, one of them just talking to Seshat (SHL-03)", () => {
    expect(FIRST_RUN.question).toBe("How will you use Sekhemet?");
    expect(FIRST_RUN.choices.map((c) => [c.role, c.label])).toEqual([
      ["code", "I write code"],
      ["manage", "I manage the work"],
      ["learn", "I'm learning"],
      ["seshat", "I'll just talk to Seshat"],
    ]);
  });

  it("I'm learning turns Tips on; I write code and I manage the work leave them off", () => {
    const learn = memory();
    answerFirstRun(learn, "learn");
    expect(readTips(learn)).toBe(true);
    expect(learn.map.get(ROLE_KEY)).toBe("learn");
    expect(learn.map.get(TIPS_KEY)).toBe("on");
    for (const role of ["code", "manage"] as const) {
      const s = memory();
      answerFirstRun(s, role);
      expect(readTips(s)).toBe(false);
    }
  });

  it("Tips stay as a person last set them, and default off", () => {
    expect(readTips(memory())).toBe(false);
    const s = memory({ [ROLE_KEY]: "learn", [TIPS_KEY]: "off" });
    expect(readTips(s)).toBe(false);
    writeTips(s, true);
    expect(readTips(s)).toBe(true);
    expect(readTips(undefined)).toBe(false);
  });

  it("Preferences changes the role alone, leaving Tips as they are", () => {
    const s = memory();
    answerFirstRun(s, "learn");
    writeRole(s, "manage");
    expect(readRole(s)).toBe("manage");
    expect(readTips(s)).toBe(true);
    writeRole(s, "nonsense");
    expect(readRole(s)).toBe("manage");
  });

  it("asks once; with no model yet it asks with the welcome's model step (SHL-03)", () => {
    expect(firstRunDue(memory(), { noModel: false })).toBe(true);
    expect(firstRunDue(memory(), { noModel: true })).toBe(true);
    expect(firstRunDue(memory({ [ROLE_KEY]: "code" }), { noModel: false })).toBe(false);
    const later = memory();
    answerFirstRun(later, "later");
    expect(firstRunDue(later, { noModel: false })).toBe(false);
    expect(readTips(later)).toBe(false);
  });

  it("each answer has its home page (§2.2.5)", () => {
    const base = { reviewWaiting: false, everAccepted: true, noModel: false, team: false };
    expect(defaultRouteFor({ ...base, role: "code" })).toBe("#/board");
    expect(defaultRouteFor({ ...base, role: "code", reviewWaiting: true })).toBe("#/review");
    expect(defaultRouteFor({ ...base, role: "manage" })).toBe("#/status");
    expect(defaultRouteFor({ ...base, role: "learn", reviewWaiting: true })).toBe("#/board");
    // No answer: someone who never accepted an issue lands on Status.
    expect(defaultRouteFor({ ...base, role: null, everAccepted: false })).toBe("#/status");
    expect(defaultRouteFor({ ...base, role: "later", everAccepted: true })).toBe("#/board");
    // No model anywhere: Configuration › Models first (DB-N6-2).
    expect(defaultRouteFor({ ...base, role: "learn", noModel: true })).toBe(
      "#/configuration/models",
    );
    // Team: the profile label sets the home page; the question sets only Tips.
    const team = { ...base, team: true, role: "manage" as const };
    expect(defaultRouteFor({ ...team, profileLabel: "Product owner" })).toBe("#/status");
    expect(defaultRouteFor({ ...team, profileLabel: "Stakeholder" })).toBe("#/status");
    expect(defaultRouteFor({ ...team, profileLabel: "Developer", reviewWaiting: true })).toBe(
      "#/review",
    );
    expect(defaultRouteFor({ ...team })).toBe("#/board");
  });
});
