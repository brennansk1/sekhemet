import { describe, expect, it } from "vitest";
import { UI_LIB_MODULES } from "../src/index.js";
import {
  SPRINT_COPY,
  headerSprint,
  nextSprintDefaults,
  noSprintOptions,
  sprintLifecycle,
  sprintReportRows,
} from "../src/sprints.js";
import { eventSentence } from "../src/vocabulary.js";

// The sprint lifecycle's page rules (C2b; dashboard §2.4 item 20,
// NEW-dashboard-11, DB-N11-1..5): the actions a sprint offers, the Complete
// sheet's lists and destinations, the next sprint's defaults (the server's
// too), the report's rows, and the offers when there is no sprint.

const s = (
  id: string,
  name: string,
  state: "planned" | "active" | "closed",
  startsOn: string,
  endsOn: string,
  projectId?: string,
) => ({ id, name, state, startsOn, endsOn, ...(projectId ? { projectId } : {}) });

const s1 = s("c1", "Sprint 1", "active", "2026-09-21", "2026-10-02", "p1");
const s2 = s("c2", "Sprint 2", "planned", "2026-10-05", "2026-10-16", "p1");
const s3 = s("c3", "Sprint 3", "planned", "2026-10-19", "2026-10-30", "p1");
const other = s("c9", "Payroll 1", "planned", "2026-09-28", "2026-10-09", "p2");
const cards = [
  { id: "a", title: "Record a day's hours", status: "done", estimate: 3, cycleId: "c1" },
  { id: "b", title: "Flag overtime", status: "review", estimate: 5, cycleId: "c1" },
  { id: "c", title: "Export to CSV", status: "ready", cycleId: "c1" },
  { id: "w", title: "Old import", status: "rejected", cycleId: "c1" },
  { id: "x", title: "Elsewhere", status: "ready", cycleId: "c2" },
];

describe("sprintLifecycle", () => {
  it("DB-N11-2: the active sprint offers Complete and lists its done and not-done issues", () => {
    const v = sprintLifecycle(s1, [s1, s2, s3, other], cards);
    expect(v.actions).toEqual(["complete", "report"]);
    expect(v.stateLabel).toBe("Active");
    expect(v.done.map((c) => c.id)).toEqual(["a"]);
    expect(v.open.map((c) => c.id)).toEqual(["b", "c"]);
    // A Won't do issue stays with the sprint it was in: it is not carried.
    expect(v.wontDo.map((c) => c.id)).toEqual(["w"]);
    expect(v.next?.id).toBe("c2");
    expect(v.carryOptions).toEqual([
      { value: "next", label: "Sprint 2", detail: "The next planned sprint", disabled: false },
      { value: "new", label: "A new sprint", detail: "Sprint 4, Oct 31 – Nov 11" },
      { value: "backlog", label: "Backlog", detail: "No sprint" },
    ]);
  });

  it("DB-N11-1: a planned sprint offers Start, or names the active sprint that blocks it", () => {
    expect(sprintLifecycle(s2, [s2, s3], cards).actions).toEqual(["start"]);
    const blocked = sprintLifecycle(s2, [s1, s2, s3], cards);
    expect(blocked.actions).toEqual(["start"]);
    expect(blocked.blockedBy).toBe("Sprint 1");
    // Another project's active sprint does not block it.
    expect(sprintLifecycle(other, [s1, s2, other], cards).blockedBy).toBeUndefined();
  });

  it("DB-N11-3: a completed sprint offers its report only", () => {
    const done = { ...s1, state: "closed" as const };
    const v = sprintLifecycle(done, [done, s2], cards);
    expect(v.actions).toEqual(["report"]);
    expect(v.stateLabel).toBe("Completed");
  });

  it("PM-N13-2: with no planned sprint, `next` is offered disabled, saying why", () => {
    const v = sprintLifecycle(s1, [s1, other], cards);
    expect(v.next).toBeUndefined();
    expect(v.carryOptions[0]).toEqual({
      value: "next",
      label: "The next planned sprint",
      detail: "No planned sprint yet",
      disabled: true,
    });
  });
});

describe("nextSprintDefaults", () => {
  it("follows the sprint with the same length, its number one more", () => {
    expect(nextSprintDefaults(s1, [s1])).toEqual({
      name: "Sprint 2",
      startsOn: "2026-10-03",
      endsOn: "2026-10-14",
    });
  });

  it("starts after the project's last planned sprint and never repeats a name it has", () => {
    expect(nextSprintDefaults(s1, [s1, s2, s3, other])).toEqual({
      name: "Sprint 4",
      startsOn: "2026-10-31",
      endsOn: "2026-11-11",
    });
    expect(
      nextSprintDefaults(s("q", "Polish", "active", "2026-09-21", "2026-10-02"), []).name,
    ).toBe("Polish 2");
  });
});

describe("sprintReportRows", () => {
  const report = {
    cycleId: "c1",
    unit: "points" as const,
    committed: { issues: ["a", "b", "d"], points: 9 },
    added: { issues: ["c"], points: 2 },
    removed: { issues: ["d"], points: 1 },
    completed: { issues: ["a"], points: 3 },
    carriedOver: { issues: ["b", "c"], points: 7, to: { b: "c2", c: "c2" } },
  };

  it("DB-N11-3: five rows, in points with estimation on", () => {
    expect(sprintReportRows(report).map((r) => [r.label, r.value])).toEqual([
      ["Committed at start", "9 points · 3 issues"],
      ["Added after start", "2 points · 1 issue"],
      ["Removed after start", "1 point · 1 issue"],
      ["Completed", "3 points · 1 issue"],
      ["Carried over", "7 points · 2 issues"],
    ]);
  });

  it("in issues with estimation off", () => {
    expect(sprintReportRows({ ...report, unit: "issues" }).map((r) => r.value)).toEqual([
      "3 issues",
      "1 issue",
      "1 issue",
      "1 issue",
      "2 issues",
    ]);
  });
});

describe("headerSprint", () => {
  const now = Date.parse("2026-09-25T12:00:00Z");
  it("is the active sprint, or the sprint the filter names in any state", () => {
    expect(headerSprint([s1, s2], [], now)?.id).toBe("c1");
    expect(headerSprint([s1, s2], ["current"], now)?.id).toBe("c1");
    expect(headerSprint([s1, s2], ["sprint-2"], now)?.id).toBe("c2");
    const closed = { ...s1, state: "closed" as const };
    expect(headerSprint([closed, s2], ["c1"], now)?.id).toBe("c1");
    expect(headerSprint([s1, s2], ["none"], now)).toBeUndefined();
  });
});

describe("the browser's copy", () => {
  it("is served as /app/lib/sprints.js", () => {
    expect(UI_LIB_MODULES).toContain("sprints.js");
  });
});

describe("DB-N11-5: no sprint", () => {
  it("offers New sprint and Plan a sprint with Seshat, and never an API path", () => {
    expect(noSprintOptions()).toEqual([
      { value: "__new_sprint__", label: "New sprint…", detail: "Name it and pick its dates" },
      {
        value: "__plan_sprint__",
        label: "Plan a sprint with Seshat",
        detail: "Seshat proposes one",
      },
    ]);
    for (const v of Object.values(SPRINT_COPY)) {
      if (typeof v === "string") expect(v).not.toMatch(/\/api\/|POST|cycle/i);
    }
  });
});

describe("the Activity log", () => {
  const line = (type: string, payload: Record<string, unknown>) => {
    const s = eventSentence({ actor: "human", seq: 1, type, payload } as never, () => undefined);
    return [s.actor, s.verb, s.title, s.rest].filter(Boolean).join(" ");
  };
  it("says a sprint was started with its committed issues, and completed with what was carried", () => {
    expect(line("cycle/started", { id: "c1", issues: ["a", "b", "c"] })).toBe(
      "You started a sprint · 3 issues committed",
    );
    expect(
      line("cycle/completed", {
        id: "c1",
        done: ["a"],
        carried: [
          { issue: "b", to: "c2" },
          { issue: "c", to: "backlog" },
        ],
      }),
    ).toBe("You completed a sprint · 1 done, 2 carried over");
  });
});
