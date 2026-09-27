import { describe, expect, it } from "vitest";
import {
  ISSUE_COPY,
  ISSUE_TABS,
  KEY_GROUPS,
  UI_LIB_MODULES,
  activityItems,
  addLineComment,
  agentPanel,
  criteriaChecks,
  issueEventsUrl,
  issueTab,
  lineCommentLabel,
  lineCommentProblem,
  oldestFirst,
  removeLineComment,
  sendBackBody,
} from "../src/index.js";

/**
 * dashboard NEW-dashboard-8 (DEC-34): the issue page for working with the
 * agent. Its pure half: the tabs, the acceptance criteria with each one's
 * check state, the agent's state and the controls it offers, the Activity
 * timeline, and the line comments a send-back carries. Exact outputs.
 */

describe("DB-N8-1: the issue page's tabs", () => {
  it("are Activity, Checks, Changes and AI review, then the run's Steps and the Plan, on keys 1 to 6", () => {
    expect(ISSUE_TABS.map((t) => [t.id, t.label, t.key])).toEqual([
      ["activity", "Activity", "1"],
      ["checks", "Checks", "2"],
      ["changes", "Changes", "3"],
      ["ai_review", "AI review", "4"],
      ["steps", "Steps", "5"],
      ["plan", "Plan", "6"],
    ]);
  });

  it("the cheat sheet names them from the one keymap", () => {
    const row = KEY_GROUPS.find((g) => g.name === "Card and lists")?.rows[0];
    expect(row).toEqual({
      label: "Activity, Checks, Changes, AI review, Steps, Plan",
      keys: ["1", "6"],
    });
    // The same list, in the same order, as the tabs themselves.
    expect(row?.label).toBe(ISSUE_TABS.map((t) => t.label).join(", "));
    expect(row?.keys).toEqual([ISSUE_TABS[0]?.key, ISSUE_TABS.at(-1)?.key]);
  });

  it("opens Activity by default, and the old tab names still land somewhere sensible", () => {
    expect(issueTab(undefined)).toBe("activity");
    expect(issueTab("nonsense")).toBe("activity");
    expect(issueTab("checks")).toBe("checks");
    expect(issueTab("evidence")).toBe("checks");
    expect(issueTab("thread")).toBe("activity");
    expect(issueTab("files")).toBe("changes");
    expect(issueTab("review")).toBe("ai_review");
    expect(issueTab("steps")).toBe("steps");
  });
});

describe("DB-N8-1: acceptance criteria with each one's check state", () => {
  const card = {
    acceptanceCriteria: [
      "Appending an event stores the previous hash.",
      "The first event's previous hash is 64 zeros.",
      "Changing a stored event makes verify() report it.",
    ],
    criterionIds: ["chr7.c1", "chr7.c2", "chr7.c3"],
  };
  const rung = (rung: string, passed: boolean, extra = {}) => ({
    gate: rung,
    rung,
    passed,
    ...extra,
  });
  const failure = (text: string) => ({
    gate: "unit",
    rung: "test",
    errorExcerpt: text,
    expected: "",
    actual: "",
  });

  it("are not checked before the agent's work has run its gates", () => {
    expect(criteriaChecks(card, null)).toEqual({
      items: [
        {
          id: "chr7.c1",
          text: card.acceptanceCriteria[0],
          state: "none",
          stateText: "Not checked yet",
        },
        {
          id: "chr7.c2",
          text: card.acceptanceCriteria[1],
          state: "none",
          stateText: "Not checked yet",
        },
        {
          id: "chr7.c3",
          text: card.acceptanceCriteria[2],
          state: "none",
          stateText: "Not checked yet",
        },
      ],
      passing: 0,
      total: 3,
      summary: "0 / 3",
      note: "Checked when the agent's work runs its tests.",
    });
  });

  it("all pass when every test gate passed", () => {
    const r = criteriaChecks(card, {
      passed: true,
      rungResults: [rung("typecheck", true), rung("test", true)],
      failures: [],
    });
    expect(r.items.map((i) => [i.state, i.stateText])).toEqual([
      ["pass", "Passing"],
      ["pass", "Passing"],
      ["pass", "Passing"],
    ]);
    expect(r.summary).toBe("3 / 3");
    expect(r.note).toBeUndefined();
  });

  it("a criterion a failing test names is failing; the rest are not proven while the tests fail", () => {
    const r = criteriaChecks(card, {
      passed: false,
      rungResults: [rung("test", false)],
      failures: [failure("FAIL chr7.c3: verify() reports the tampered seq\nexpected 4, got -1")],
    });
    expect(r.items.map((i) => [i.id, i.state, i.stateText])).toEqual([
      ["chr7.c1", "none", "Not proven while the tests fail"],
      ["chr7.c2", "none", "Not proven while the tests fail"],
      ["chr7.c3", "fail", "Failing"],
    ]);
    expect(r.summary).toBe("0 / 3");
  });

  it("does not mistake one id for a longer one that starts with it", () => {
    const many = {
      acceptanceCriteria: ["one", "ten"],
      criterionIds: ["x.c1", "x.c10"],
    };
    const r = criteriaChecks(many, {
      passed: false,
      rungResults: [rung("test", false)],
      failures: [failure("FAIL x.c10 › ten")],
    });
    expect(r.items.map((i) => i.state)).toEqual(["none", "fail"]);
  });

  it("are not checked when no test gate ran (a type error stopped the run first)", () => {
    const r = criteriaChecks(card, {
      passed: false,
      rungResults: [rung("typecheck", false), rung("test", false, { skipped: true })],
      failures: [],
    });
    expect(r.items.map((i) => i.state)).toEqual(["none", "none", "none"]);
    expect(r.note).toBe("No test gate ran on the latest attempt, so no criterion is proven yet.");
  });

  it("says so when the card has none", () => {
    expect(criteriaChecks({}, null)).toEqual({
      items: [],
      passing: 0,
      total: 0,
      summary: "0 / 0",
      note: "No acceptance criteria yet.",
    });
  });
});

describe("DB-N8-2: the agent's state and the controls it offers", () => {
  const moved = (seq: number, toStatus: string) => ({
    seq,
    type: "card/status_changed",
    payload: { toStatus },
  });
  const base = { status: "in_progress", stepsUsed: 4, stepBudget: 12 };

  it("while it runs: a message box for the agent, Pause and Take over", () => {
    expect(agentPanel(base, [moved(1, "in_progress")])).toEqual({
      state: "working",
      label: "working",
      sentence: "The agent is working on step 5 of 12.",
      controls: ["pause", "take_over"],
      messageBox: true,
    });
    expect(ISSUE_COPY.messageLabel).toBe("Message the agent — it reads this at its next step");
  });

  it("after Pause is asked and before the step boundary: pausing, still reachable by message", () => {
    const events = [moved(1, "in_progress"), { seq: 2, type: "card/pause_requested", payload: {} }];
    expect(agentPanel(base, events)).toEqual({
      state: "pausing",
      label: "working",
      sentence: "Pausing at the end of step 5.",
      controls: ["take_over"],
      messageBox: true,
    });
  });

  it("a pause asked before the latest move no longer counts", () => {
    const events = [{ seq: 1, type: "card/pause_requested", payload: {} }, moved(2, "in_progress")];
    expect(agentPanel(base, events).state).toBe("working");
  });

  const pausedAt = (seq: number) => ({
    seq,
    type: "card/updated",
    payload: { patch: { stopReason: "paused" } },
  });

  it("a reload reads the card's newest entries, so a long run's pause is not lost past the first 1,000", () => {
    expect(issueEventsUrl("card a")).toBe("/api/events?card=card%20a&order=desc&limit=1000");
    const steps = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ seq: from + i, type: "card/step", payload: {} }));
    const ledger = [moved(1, "in_progress"), ...steps(2, 1400), pausedAt(1402), ...steps(1403, 50)];
    // What `order=desc&limit=1000` answers, newest first, put back in order.
    const page = oldestFirst([...ledger].reverse().slice(0, 1000));
    expect(page[0]?.seq).toBe(453);
    expect(page.at(-1)?.seq).toBe(1452);
    const card = { ...base, stopReason: "paused" };
    expect(agentPanel(card, page).state).toBe("paused");
    // The page that stayed open holds the same entries, and says the same.
    expect(agentPanel(card, ledger).state).toBe("paused");
  });

  it("paused: Hand back with a note, or Take over", () => {
    expect(
      agentPanel({ ...base, stopReason: "paused" }, [moved(1, "in_progress"), pausedAt(2)]),
    ).toEqual({
      state: "paused",
      label: "paused",
      sentence:
        "Paused after step 4. Its branch and checkpoint are kept; hand it back to resume from there.",
      controls: ["hand_back", "take_over"],
      messageBox: false,
    });
  });

  it("a resumed run is working, though the stored stop reason still says paused until it stops", () => {
    const events = [
      moved(1, "in_progress"),
      pausedAt(2),
      moved(3, "ready"),
      moved(4, "in_progress"),
    ];
    expect(agentPanel({ ...base, stopReason: "paused" }, events).state).toBe("working");
    // Nothing in the ledger says it paused: it is not shown as paused.
    expect(agentPanel({ ...base, stopReason: "paused" }, [moved(1, "in_progress")]).state).toBe(
      "working",
    );
  });

  it("taken over: run the checks on the person's work, or Hand back with a note", () => {
    const events = [moved(1, "in_progress"), { seq: 2, type: "card/taken_over", payload: {} }];
    expect(agentPanel(base, events)).toEqual({
      state: "taken_over",
      label: "paused",
      sentence:
        "Taken over by a person. Work in the card's worktree; the agent's work so far is on its branch.",
      controls: ["submit", "hand_back"],
      messageBox: false,
    });
  });

  it("a hand-back ends the take-over", () => {
    const events = [
      moved(1, "in_progress"),
      { seq: 2, type: "card/taken_over", payload: {} },
      moved(3, "ready"),
    ];
    expect(agentPanel({ ...base, status: "ready" }, events)).toEqual({
      state: "idle",
      label: "queued",
      sentence: "Queued: the agent starts this issue when a slot is free.",
      controls: [],
      messageBox: false,
    });
  });

  it("offers nothing to steer when the agent is not on the issue", () => {
    expect(agentPanel({ ...base, status: "verify" }, []).controls).toEqual([]);
    expect(agentPanel({ ...base, status: "verify" }, []).sentence).toBe(
      "The checks are running on the agent's work.",
    );
    expect(agentPanel({ ...base, status: "review" }, []).label).toBe("needs you");
    expect(agentPanel({ ...base, status: "done" }, []).label).toBe("done");
    expect(agentPanel({ ...base, status: "backlog" }, [])).toEqual({
      state: "idle",
      label: "",
      sentence: "The agent isn't working on this issue.",
      controls: [],
      messageBox: false,
    });
  });
});

describe("DB-N8-1, DB-N8-3: Activity interleaves the agent and the people in time order", () => {
  const at = (m: number) => `2026-09-27T10:${String(m).padStart(2, "0")}:00.000Z`;
  const events = [
    {
      seq: 1,
      type: "card/status_changed",
      actor: "worker",
      createdAt: at(1),
      payload: { fromStatus: "ready", toStatus: "in_progress" },
    },
    {
      seq: 2,
      type: "card/step",
      actor: "worker",
      createdAt: at(2),
      payload: { turn: 1, calls: [{ name: "note", target: "Add appendEvent, reuse hashEvent" }] },
    },
    {
      seq: 3,
      type: "card/step",
      actor: "worker",
      createdAt: at(3),
      payload: { turn: 2, calls: [{ name: "read_file", target: "src/hash.ts" }] },
    },
    {
      seq: 4,
      type: "card/step",
      actor: "worker",
      createdAt: at(4),
      payload: { turn: 3, calls: [{ name: "write_file", target: "src/ledger.ts" }] },
    },
    {
      seq: 5,
      type: "card/step",
      actor: "worker",
      createdAt: at(6),
      payload: {
        turn: 4,
        calls: [{ name: "run_tests" }],
        gate: { passed: false, failed: ["test"], errors: 2 },
      },
    },
    // Private text: shown from the messages list, never twice.
    { seq: 6, type: "card/message", actor: "human", createdAt: at(11), payload: {} },
    { seq: 7, type: "card/message_delivered", actor: "executor", createdAt: at(12), payload: {} },
    { seq: 8, type: "checkpoint/recorded", actor: "harness", createdAt: at(12), payload: {} },
  ];
  const messages = [
    {
      id: "ev6",
      seq: 6,
      kind: "message",
      principal: "prn_bk",
      principalName: "Brennan Kelley",
      text: "64 zeros. Keep the error format of verify().",
      postedAt: at(11),
      reachedStep: 5,
    },
  ];
  const decisions = [
    {
      id: "dec_1",
      cardId: "card_a",
      source: "planner",
      question: "What should the first event's previous hash be?",
      options: [{ label: "64 zeros" }, { label: "Empty string" }, { label: "null" }],
      policy: "safe_default",
      defaultIndex: 0,
      createdAt: at(9),
    },
    { id: "dec_other", cardId: "card_b", question: "Not ours", options: [], createdAt: at(5) },
  ];

  it("in time order, steps grouped, the plan and checks called out, and each message with the step it reached", () => {
    const items = activityItems({ cardId: "card_a", events, messages, decisions });
    expect(
      items.map((i) => [i.kind, i.who, i.ai, i.text, i.quote ?? "", i.meta ?? "", i.tone]),
    ).toEqual([
      ["event", "Worker", false, "moved from To do to In progress", "", "", "neutral"],
      ["plan", "Agent", true, "noted its plan", "Add appendEvent, reuse hashEvent", "", "neutral"],
      ["steps", "Agent", true, "took steps 2–3 · last editing src/ledger.ts", "", "", "neutral"],
      ["checks", "Checks", false, "ran on step 4: Tests failed · 2 errors", "", "", "fail"],
      [
        "question",
        "Agent",
        true,
        "asked a question",
        "What should the first event's previous hash be?",
        "",
        "neutral",
      ],
      [
        "message",
        "Brennan Kelley",
        false,
        "wrote to the agent",
        "64 zeros. Keep the error format of verify().",
        "Seen by the agent at step 5",
        "neutral",
      ],
    ]);
  });

  it("DB-N8-3: a question shows its options as buttons, its default, and that the agent continues on it", () => {
    const [q] = activityItems({ cardId: "card_a", events: [], messages: [], decisions });
    expect(q?.question).toEqual({
      id: "dec_1",
      source: "planner",
      options: [
        { index: 0, label: "64 zeros", isDefault: true },
        { index: 1, label: "Empty string", isDefault: false },
        { index: 2, label: "null", isDefault: false },
      ],
      continuing: true,
      line: "Default: 64 zeros. The agent continues with it unless you answer.",
    });
  });

  it("DB-N8-3: where the default is to stop, the agent waits", () => {
    const [q] = activityItems({
      cardId: "card_a",
      events: [],
      messages: [],
      decisions: [
        {
          id: "dec_2",
          cardId: "card_a",
          source: "kernel",
          category: "permission",
          question: "Run `npm install`?",
          options: [{ label: "Allow" }, { label: "Deny" }],
          policy: "default_deny",
          createdAt: at(1),
        },
      ],
    });
    expect([q?.text, q?.question?.continuing, q?.question?.line]).toEqual([
      "asked for permission",
      false,
      "The agent waits for your answer.",
    ]);
    const [parked] = activityItems({
      cardId: "card_a",
      events: [],
      messages: [],
      decisions: [
        {
          id: "dec_3",
          cardId: "card_a",
          source: "planner",
          question: "Which store?",
          options: [{ label: "SQLite" }, { label: "Files" }],
          policy: "park",
          defaultIndex: 1,
          createdAt: at(1),
        },
      ],
    });
    expect(parked?.question?.line).toBe("Default: Files. The agent waits for your answer.");
  });

  it("a message the agent has not read yet says when it will, and a hand-back shows its note", () => {
    const items = activityItems({
      cardId: "card_a",
      events: [],
      messages: [
        {
          id: "m1",
          seq: 1,
          kind: "message",
          principal: "prn_x",
          text: "Use named exports.",
          postedAt: at(1),
        },
        {
          id: "m2",
          seq: 2,
          kind: "hand_back",
          principal: "prn_x",
          principalName: "Ada",
          text: "Also export b.",
          postedAt: at(2),
          reachedStep: 3,
        },
      ],
      decisions: [],
    });
    expect(items.map((i) => [i.kind, i.who, i.text, i.quote, i.meta])).toEqual([
      [
        "message",
        "A person",
        "wrote to the agent",
        "Use named exports.",
        "Not read yet: the agent reads it at its next step",
      ],
      [
        "hand_back",
        "Ada",
        "handed the issue back to the agent",
        "Also export b.",
        "Seen by the agent at step 3",
      ],
    ]);
  });

  it("pause and take-over are in the timeline; every other ledger entry only on request", () => {
    const more = [
      { seq: 1, type: "card/pause_requested", actor: "human", createdAt: at(1), payload: {} },
      { seq: 2, type: "card/taken_over", actor: "human", createdAt: at(2), payload: {} },
      {
        seq: 3,
        type: "checkpoint/recorded",
        actor: "harness",
        createdAt: at(3),
        payload: { step: 2 },
      },
    ];
    const brief = activityItems({ cardId: "card_a", events: more, messages: [], decisions: [] });
    expect(brief.map((i) => [i.who, i.text])).toEqual([
      ["You", "asked the agent to pause at its next step"],
      ["You", "took the issue over"],
    ]);
    const all = activityItems({
      cardId: "card_a",
      events: more,
      messages: [],
      decisions: [],
      all: true,
    });
    expect(all.map((i) => [i.who, i.text])).toEqual([
      ["You", "asked the agent to pause at its next step"],
      ["You", "took the issue over"],
      ["Sekhemet", "checkpointed at step 2"],
    ]);
  });
});

describe("DB-N8-4: comments on diff lines, carried by Send back", () => {
  it("need a file, a line of 1 or more, and words — the server's own rule", () => {
    expect(lineCommentProblem({ file: "src/a.ts", line: 12, text: "Name it answer." })).toBe(
      undefined,
    );
    for (const bad of [
      { file: "", line: 12, text: "x" },
      { file: "src/a.ts", line: 0, text: "x" },
      { file: "src/a.ts", line: 1.5, text: "x" },
      { file: "src/a.ts", line: 3, text: "   " },
    ]) {
      expect(lineCommentProblem(bad)).toBe(
        "A line comment names its file and line (1 or more) and says something",
      );
    }
  });

  it("are added, trimmed and removed; a second comment on the same line joins the first", () => {
    const one = addLineComment([], { file: " src/a.ts ", line: 12, text: " Name it answer. " });
    expect(one).toEqual({ comments: [{ file: "src/a.ts", line: 12, text: "Name it answer." }] });
    const refused = addLineComment(one.comments, { file: "src/a.ts", line: 0, text: "x" });
    expect(refused).toEqual({
      comments: one.comments,
      problem: "A line comment names its file and line (1 or more) and says something",
    });
    const joined = addLineComment(one.comments, {
      file: "src/a.ts",
      line: 12,
      text: "And export it.",
    });
    expect(joined.comments).toEqual([
      { file: "src/a.ts", line: 12, text: "Name it answer.\nAnd export it." },
    ]);
    const two = addLineComment(joined.comments, {
      file: "src/b.ts",
      line: 3,
      text: "Remove this.",
    });
    expect(two.comments.map(lineCommentLabel)).toEqual(["src/a.ts:12", "src/b.ts:3"]);
    expect(removeLineComment(two.comments, 0)).toEqual([
      { file: "src/b.ts", line: 3, text: "Remove this." },
    ]);
  });

  it("travel with the send-back's reason, and are left out when there are none", () => {
    const c = [{ file: "src/a.ts", line: 12, text: "Name it answer." }];
    expect(sendBackBody("  Rename the constant. ", c)).toEqual({
      reason: "Rename the constant.",
      comments: c,
    });
    expect(sendBackBody("Rename it.", [])).toEqual({ reason: "Rename it." });
    expect(ISSUE_COPY.lineComment.sendBack(2)).toBe("Send back with 2 line comments");
    expect(ISSUE_COPY.lineComment.carried(1)).toBe("Send back carries 1 line comment.");
  });
});

describe("the browser can load it", () => {
  it("is one of the compiled modules the page loads", () => {
    expect(UI_LIB_MODULES).toContain("issue.js");
  });
});
