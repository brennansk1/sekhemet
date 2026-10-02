import { describe, expect, it } from "vitest";
import {
  activityItems,
  agentPanel,
  criteriaChecks,
  issueDocumentTitle,
  issueProperties,
  peekFacts,
} from "../src/issue.js";
import { acceptChecklist, openConversations } from "../src/review_desk.js";
import { gateStripModel } from "../src/strip.js";
import { aiStateLine } from "../src/teammates.js";
import {
  type GateSummary,
  checksVerdict,
  outcomeSentence,
  statusLine,
  stopReasonLabel,
} from "../src/vocabulary.js";

// C2a, the issue page and Review (FINDINGS ISS-01..09, REV-01..10;
// dashboard §2.5, §2.6, NEW-dashboard-17, NEW-dashboard-19). The pure half:
// the words and the models the pages render; the pages are tested in a real
// Chromium by apps/harness/tests/issue_review_page_ui.spec.ts.

const g = (id: string, label: string, state: GateSummary["state"]): GateSummary => ({
  id,
  label,
  state,
  failures: state === "fail" ? 2 : 0,
});

const thirteen: GateSummary[] = [
  ...[
    "Tests",
    "Licenses",
    "Trailers",
    "Reachability",
    "Regression",
    "Architecture",
    "Integrity",
    "Size",
    "Secrets",
    "Dependencies",
    "Hygiene",
  ].map((l) => g(l.toLowerCase(), l, "pass")),
  g("osv", "OSV", "skipped"),
  g("semgrep", "Semgrep", "skipped"),
];

describe("REV-01: one answer to 'did it pass?'", () => {
  it("counts a skipped check as neither a pass nor a failure", () => {
    const v = checksVerdict(thirteen);
    expect(v.tone).toBe("pass");
    expect(v.passed).toBe(11);
    expect(v.ran).toBe(11);
    expect(v.text).toBe("All 11 checks that ran passed · OSV and Semgrep skipped");
    expect(v.short).toBe("11 passed · 2 skipped");
  });

  it("names the failures first, then the passes among those that ran", () => {
    const v = checksVerdict([
      g("unit", "Tests", "fail"),
      g("types", "Types", "pass"),
      g("lint", "Lint", "not_run"),
    ]);
    expect(v.tone).toBe("fail");
    expect(v.text).toBe("Tests failed · 1 of 2 passed · Lint not run");
    expect(v.short).toBe("1 failed · 1 passed · 1 not run");
  });

  it("says plainly when every check passed, and when none ran", () => {
    expect(checksVerdict([g("unit", "Tests", "pass"), g("types", "Types", "pass")]).text).toBe(
      "All 2 checks passed",
    );
    expect(checksVerdict([]).text).toBe("No checks ran");
    expect(checksVerdict([g("osv", "OSV", "skipped")]).tone).toBe("neutral");
  });

  it("gives a family of skipped and passed checks the skipped state, not a failure", () => {
    const strip = gateStripModel([...thirteen, g("secrets2", "Gitleaks", "pass")]);
    const security = strip.segments.find((s) => s.gates.some((x) => x.id === "osv"));
    expect(security?.state).toBe("skipped");
    expect(security?.state).not.toBe("fail");
  });
});

describe("ISS-03: no fixed 'you' in words every viewer reads", () => {
  it("a stop and a pause name no viewer", () => {
    for (const reason of ["human_abort", "paused"]) {
      const l = stopReasonLabel(reason);
      expect(`${l.short} ${l.sentence}`, reason).not.toMatch(/\byou\b/i);
    }
    expect(stopReasonLabel("human_abort").short).toBe("Stopped");
  });
});

describe("ISS-02: a stopped run shows one state, with Resume", () => {
  const card = { status: "verify", stopReason: "human_abort", stepsUsed: 2, stepBudget: 5 };
  const events = [
    {
      seq: 10,
      type: "card/status_changed",
      payload: { fromStatus: "ready", toStatus: "in_progress" },
    },
    {
      seq: 12,
      type: "card/abort_requested",
      actor: "human",
      principalName: "Nora",
      payload: { reason: "stopped from the dashboard" },
    },
    {
      seq: 17,
      type: "card/status_changed",
      payload: { fromStatus: "in_progress", toStatus: "verify" },
    },
    { seq: 18, type: "card/updated", payload: { patch: { stopReason: "human_abort" } } },
  ];

  it("is Stopped, by the person the ledger names, with Resume as its control", () => {
    const p = agentPanel(card, events);
    expect(p.state).toBe("stopped");
    expect(p.label).toBe("paused");
    expect(p.sentence).toBe(
      "Stopped by Nora after step 2. Its work so far is kept; Resume continues from its last checkpoint.",
    );
    expect(p.controls).toEqual(["resume"]);
    expect(p.sentence).not.toMatch(/checks are running/);
  });

  it("says who stopped it in Activity, never a fixed 'you'", () => {
    const items = activityItems({ cardId: "TS-108", events, messages: [], decisions: [] });
    const stop = items.find((i) => i.text === "stopped the run");
    expect(stop?.who).toBe("Nora");
    // The stored Verify and the board's In progress are one column: no "to Verify".
    expect(items.map((i) => i.text).join("\n")).not.toMatch(/to Verify/);
  });

  it("the Agent's server-side state line for a stopped run is not 'working'", () => {
    const l = aiStateLine({ who: "agent", state: "paused", stopped: true });
    expect(l.sentence).toBe("Stopped by a person. Resume continues from its last checkpoint.");
  });
});

describe("ISS-06: Activity reads as sentences", () => {
  it("folds the AI review's findings into one line with its counts", () => {
    const review = (seq: number, verdict: string) => ({
      seq,
      type: "card/review",
      actor: "reviewer",
      payload: { kind: "review", verdict, text: "x", attempt: 1 },
    });
    const items = activityItems({
      cardId: "TS-102",
      events: [
        review(1, "met"),
        review(2, "unclear"),
        review(3, "unmet"),
        review(4, "unmet"),
        review(5, "coverage"),
        {
          seq: 6,
          type: "card/status_changed",
          actor: "executor",
          payload: { fromStatus: "verify", toStatus: "review" },
        },
      ],
      messages: [],
      decisions: [],
    });
    const lines = items.map((i) => `${i.who} ${i.text}`);
    expect(lines).toEqual([
      "AI review reviewed the change: 2 unmet, 1 unclear, 1 met",
      "Agent moved from In progress to In review",
    ]);
    expect(lines.join("\n")).not.toMatch(/card review/);
  });
});

describe("ISS-01: the properties rail", () => {
  const base = {
    id: "TS-102",
    status: "review",
    title: "Flag hours past 40 in a week as overtime",
    assignee: "worker",
    delegate: { kind: "worker" },
    priority: 1,
    estimate: 3,
    labels: ["overtime-rules"],
    cycleId: "c1",
    epicId: "e1",
    dueDate: "2026-10-09",
    dependsOn: ["TS-101"],
  };
  const ctx = {
    cycles: [{ id: "c1", name: "Sprint 3" }],
    epics: [{ id: "e1", title: "Overtime" }],
    cards: [
      {
        id: "TS-101",
        status: "review",
        title: "Show the weekly total",
        display: { shortId: "TS-101" },
      },
      {
        id: "TS-109",
        status: "ready",
        title: "Pay overtime",
        dependsOn: ["TS-102"],
        display: { shortId: "TS-109" },
      },
    ],
    estimation: "points",
    reporter: "Planning model",
    branch: "sekhemet/timesheets/TS-102-flag-hours",
    reviewers: ["Priya Nair"],
    watchers: ["Nora", "Mo"],
    agentState: "needs you",
  };

  it("lists the mockup's properties in its order, each with its value", () => {
    const rows = issueProperties(base, ctx);
    expect(rows.map((r) => r.label)).toEqual([
      "Assignee",
      "Delegate",
      "Reviewers",
      "Reporter",
      "Type",
      "Priority",
      "Points",
      "Sprint",
      "Epic",
      "Labels",
      "Due",
      "Blocked by",
      "Blocks",
      "Branch",
      "Watchers",
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by.Assignee?.text).toBe("Agent");
    expect(by.Delegate).toMatchObject({ text: "Agent", ai: true, state: "needs you" });
    expect(by.Priority?.text).toBe("Urgent");
    expect(by.Points?.text).toBe("3 pts");
    expect(by.Sprint?.text).toBe("Sprint 3");
    expect(by.Epic?.text).toBe("Overtime");
    expect(by.Due?.text).toBe("Oct 9");
    expect(by["Blocked by"]?.links).toEqual([
      { id: "TS-101", text: "TS-101", column: "In review" },
    ]);
    expect(by.Blocks?.links).toEqual([{ id: "TS-109", text: "TS-109", column: "To do" }]);
    expect(by.Branch).toMatchObject({ mono: true, copy: "sekhemet/timesheets/TS-102-flag-hours" });
    // Each editable value names the list's editor for it (DB-N19-2).
    expect(rows.filter((r) => r.field).map((r) => r.field)).toEqual([
      "assignee",
      "priority",
      "estimate",
      "cycleId",
      "epicId",
      "labels",
      "dueDate",
    ]);
  });

  it("drops Points with estimation off, and says None for an empty value", () => {
    const rows = issueProperties(
      { ...base, estimate: undefined, labels: [] },
      {
        ...ctx,
        estimation: "off",
      },
    );
    expect(rows.some((r) => r.label === "Points")).toBe(false);
    expect(rows.find((r) => r.label === "Labels")?.text).toBe("None");
  });
});

describe("ISS-05: the peek carries difficulty, assignee, delegate and suggested accepters", () => {
  it("lists them as plain facts", () => {
    const facts = peekFacts(
      { difficulty: 4, assignee: "worker", delegate: { kind: "worker" } },
      { accepters: ["Priya Nair"] },
    );
    expect(facts).toEqual([
      { label: "Difficulty", text: "4 of 10" },
      { label: "Assignee", text: "Agent" },
      { label: "Delegate", text: "Agent", ai: true },
      { label: "Suggested accepters", text: "Priya Nair" },
    ]);
  });
});

describe("ISS-08: the browser tab names the issue", () => {
  it("is the key and the title, then the project", () => {
    expect(
      issueDocumentTitle(
        { id: "TS-102", title: "Flag hours", display: { shortId: "TS-102" } },
        "timesheets",
      ),
    ).toBe("TS-102 Flag hours · timesheets");
  });
});

describe("REV-02, REV-03: Accept's conditions are a checklist above the bar", () => {
  it("lists each blocker on its own line, with its kind, and the open conversations", () => {
    const desk = {
      threads: [
        {
          id: "t1",
          file: "src/overtime.ts",
          line: 3,
          resolved: false,
          comments: [{ text: "Contractors?" }],
        },
        { id: "t2", resolved: true, comments: [{ text: "ok" }] },
      ],
    };
    expect(
      acceptChecklist("3 findings to acknowledge · 1 file not yet shown: src/overtime.ts", desk),
    ).toEqual([
      { kind: "findings", text: "3 findings to acknowledge", blocking: true },
      { kind: "files", text: "1 file not yet shown: src/overtime.ts", blocking: true },
      { kind: "conversation", text: "1 open conversation", blocking: false },
    ]);
    expect(openConversations(desk)).toBe("1 open conversation");
  });

  it("puts the server's refusal first, where Accept was pressed", () => {
    const items = acceptChecklist("", null, "Couldn't accept. The branch moved since the preview.");
    expect(items[0]).toMatchObject({ kind: "refused", blocking: true });
  });

  it("names a gate condition as checks and an Accept rule as who", () => {
    expect(acceptChecklist("Accept needs every check passing.")[0]?.kind).toBe("checks");
    expect(
      acceptChecklist(
        "You do not hold the Accept permission on this project. Who may accept: Nora.",
      )[0]?.kind,
    ).toBe("who");
  });
});

describe("ISS-02: the outcome line of a stopped run", () => {
  it("says it stopped, never that it failed", () => {
    const s = outcomeSentence({ passed: false, stopReason: "human_abort", turnsUsed: 2 }, []);
    expect(s).toBe("Stopped on step 2");
  });
});

describe("ISS-02: a stopped run's tile and queue line", () => {
  it("reads Stopped, on hold's tone, never Failed", () => {
    const line = statusLine({ id: "c", status: "verify", stepsUsed: 2, stepBudget: 5 } as never, {
      evidence: { passed: false, stopReason: "human_abort", turnsUsed: 2 } as never,
    });
    expect(line).toMatchObject({ text: "Stopped at step 2", tone: "parked" });
  });
});

describe("REV-01: a criterion no test exercises is not 'Passing'", () => {
  const evidence = {
    passed: true,
    rungResults: [{ gate: "unit", rung: "test", passed: true }],
    failures: [],
  };
  it("says no test checks it when the issue has no acceptance test", () => {
    const c = criteriaChecks(
      { acceptanceCriteria: ["Hours past 40 are overtime."], acceptanceTests: [] },
      evidence,
    );
    expect(c.items[0]).toMatchObject({ state: "none", stateText: "No test checks it" });
    expect(c.summary).toBe("0 / 1");
    expect(c.note).toBe(
      "No acceptance test is staged for this issue: the checks passed, but no test proves a criterion.",
    );
  });
  it("keeps Passing when acceptance tests are staged", () => {
    const c = criteriaChecks(
      {
        acceptanceCriteria: ["Hours past 40 are overtime."],
        acceptanceTests: ["overtime.spec.ts"],
      },
      evidence,
    );
    expect(c.items[0]?.state).toBe("pass");
  });
});
