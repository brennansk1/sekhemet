import { describe, expect, it } from "vitest";
import type { CycleLike } from "../src/pm.js";
import {
  STATUS_COPY,
  STATUS_SECTIONS,
  type StatusCardLike,
  type StatusFacts,
  type StatusInput,
  type StatusView,
  statusModel,
} from "../src/status.js";
import { plainStatus } from "../src/vocabulary.js";

/**
 * dashboard DB-P5-1, DB-P5-2, DB-N9-1..8 (§2.8, DEC-37): Status, the project
 * page for the stakeholder and the team, as a pure model with exact outputs.
 * `web/status.js` renders these in §2.8's order.
 */
const NOW = Date.parse("2026-09-27T12:00:00.000Z");

const cards: StatusCardLike[] = [
  {
    id: "card_hasher",
    title: "Hasher",
    status: "done",
    tier: "task",
    updatedAt: "2026-09-25T09:00:00.000Z",
  },
  {
    id: "card_ledger",
    title: "Ledger (SPIDR: Rule)",
    status: "review",
    tier: "task",
    owner: "p_priya",
    display: { ownerName: "Priya" },
    updatedAt: "2026-09-27T10:00:00.000Z",
  },
  {
    id: "card_search",
    title: "Search",
    status: "in_progress",
    tier: "task",
    delegate: "worker",
    updatedAt: "2026-09-27T11:00:00.000Z",
  },
  {
    id: "card_export",
    title: "Export",
    status: "parked",
    tier: "task",
    stopReason: "budget_exhausted",
    updatedAt: "2026-09-26T11:00:00.000Z",
  },
  { id: "card_import", title: "Import", status: "ready", tier: "task" },
  { id: "card_epic", title: "Ledger epic", status: "ready", tier: "epic" },
  { id: "card_old", title: "Old idea", status: "rejected", tier: "task" },
  {
    id: "card_plan",
    title: "Plan me",
    status: "planning",
    tier: "story",
    blockedReason: "Waiting on a person's approval of its criteria: sekhemet approve card_plan.",
  },
];

const cycles: CycleLike[] = [
  { id: "cyc_4", name: "Sprint 4", startsOn: "2026-09-21", endsOn: "2026-09-30", state: "active" },
];

const solo: StatusFacts = {
  setup: "solo",
  project: { id: "proj_a", name: "Chronicle" },
  isLead: true,
  canSetHealth: true,
  healthWritable: false,
  health: null,
  update: null,
  updateMissing: false,
  canPostUpdate: true,
  canUnpark: true,
  forecast: { remaining: 5, historyDays: 2, finished: 1, minimum: 5 },
  acceptedThisWeek: [{ title: "Hasher", by: "you", at: "2026-09-25T09:00:00.000Z" }],
  flow: {
    days: 30,
    cycleHours: [1, 2, 4, 10],
    finished: 3,
    sentBack: 2,
    firstTime: { passed: 3, total: 4 },
  },
};

const storyMap = {
  projectId: "proj_a",
  provenLine: "1 of 3 must-haves proven",
  projectDone: false,
  unplanned: [],
  slices: [
    {
      id: "slice_1",
      state: "unproven",
      provenLine: "1 of 3 must-haves proven",
      appetite: { cards: 8 },
      appetiteReached: true,
      accepted: false,
      requirements: [
        {
          id: "REQ-1",
          title: "Record every change",
          mustHave: true,
          state: "proven",
          why: "",
          cards: [{ id: "card_hasher", status: "done", suspect: false }],
        },
        {
          id: "REQ-2",
          title: "Verify the chain",
          mustHave: true,
          state: "passing_strength_unmet",
          why: "",
          cards: [{ id: "card_ledger", status: "review", suspect: false }],
        },
        {
          id: "REQ-3",
          title: "Export to CSV",
          mustHave: true,
          state: "planned",
          why: "",
          cards: [{ id: "card_export", status: "parked", suspect: false }],
        },
        {
          id: "REQ-4",
          title: "Search history",
          mustHave: false,
          kano: "performance",
          state: "planned",
          why: "",
          cards: [{ id: "card_search", status: "in_progress", suspect: false }],
        },
        {
          id: "REQ-5",
          title: "Dark theme",
          mustHave: false,
          kano: "attractive",
          state: "unplanned",
          why: "",
          cards: [],
        },
        {
          id: "REQ-6",
          title: "Import",
          mustHave: false,
          kano: "performance",
          state: "suspect",
          why: "",
          cards: [{ id: "card_import", status: "ready", suspect: true }],
        },
        { id: "REQ-7", title: "Old", mustHave: false, state: "cut", why: "", cards: [] },
        // No priority class recorded: a Could have, as the project documents read it.
        {
          id: "REQ-8",
          title: "Audit log",
          mustHave: false,
          state: "unplanned",
          why: "",
          cards: [],
        },
      ],
    },
  ],
};

const standup = {
  text: "card_hasher Hasher",
  byState: {
    passed: [
      { id: "card_hasher", title: "Hasher", line: "card_hasher Hasher" },
      // Another project's issue (the standup is the workspace's): not this page's.
      { id: "card_elsewhere", title: "Storefront checkout", line: "x" },
    ],
    in_progress: [{ id: "card_search", title: "Search", line: "card_search Search (3/40 steps)" }],
    review: [{ id: "card_ledger", title: "Ledger (SPIDR: Rule)", line: "x" }],
    parked: [{ id: "card_export", title: "Export", line: "card_export Export: budget_exhausted" }],
  },
  decisionsWaiting: [
    {
      id: "dec_1",
      cardId: "card_import",
      question: "Should card_import read CSV or JSON?",
      waitingHours: 2,
    },
    { id: "dec_2", cardId: "card_elsewhere", question: "Which payment provider?", waitingHours: 1 },
  ],
  nextWindow: [],
};

const signals = [
  { id: "burn_up", value: 0.2, triggered: false, detail: "1 of 6 cards verified" },
  {
    id: "review_backlog",
    value: 3,
    threshold: 3,
    triggered: true,
    detail: "3 in Review against a ReviewWIP of 3",
    response: { action: "backpressure_verify", mode: "automatic", targets: [] },
  },
  {
    id: "blocked_time",
    value: 14.5,
    threshold: 12,
    triggered: true,
    detail: "1 card(s) blocked over 12h; oldest 14.5h",
    response: { action: "escalate_blockers", mode: "proposal", targets: ["card_export"] },
  },
  {
    id: "scope_drift",
    value: 0.25,
    threshold: 0.2,
    triggered: true,
    detail: "2 cards added to epic_x's 8-card plan",
    response: { action: "halt_aux_cards_and_ask", mode: "decision", targets: [] },
  },
];

const standing = [
  { place: 1, estimateSeconds: 120 },
  { place: 2, estimateSeconds: 360 },
];

const input = (over: Partial<StatusInput> = {}): StatusInput => ({
  now: NOW,
  me: "p_me",
  facts: solo,
  cards,
  cycles,
  storyMap,
  standup,
  signals,
  standing,
  ...over,
});

/** Every word a person reads on the page: the view's strings, leaving out links and ids. */
function words(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) words(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (["href", "id", "ids", "act", "kind", "state", "tone", "band", "target"].includes(k))
        continue;
      words(x, out);
    }
  }
  return out;
}

describe("plainStatus (§2.8.13)", () => {
  it("names each stored state in plain words", () => {
    expect(
      [
        "backlog",
        "ready",
        "planning",
        "in_progress",
        "verify",
        "review",
        "done",
        "parked",
        "rejected",
      ].map(plainStatus),
    ).toEqual([
      "Not started",
      "Ready to start",
      "Being planned",
      "Being built",
      "Being checked",
      "Waiting for review",
      "Done",
      "On hold",
      "Won't do",
    ]);
  });
});

describe("the page's sections and words (§2.8's order, DB-N9-1)", () => {
  it("lays the page out in §2.8's order", () => {
    expect(STATUS_SECTIONS.map((x) => x.heading)).toEqual([
      "Key numbers",
      "Burn-up",
      "Needs you",
      "Waiting on others",
      "Requirements",
      "Risks",
      "Done this week",
      "Today's changes",
      "Who's working on what",
      "Models",
      "Flow",
      "Ask Seshat",
    ]);
  });

  it("names every control in the words teams use", () => {
    expect(STATUS_COPY).toEqual({
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
    });
  });
});

describe("Status (DB-P5-1, DB-N9-1)", () => {
  const v: StatusView = statusModel(input());

  it("leads with a sentence of facts, never a health word", () => {
    expect(v.headline).toBe("1 of 6 issues done. 1 being built, 1 waiting for review, 1 on hold.");
    expect(statusModel(input({ cards: [] })).headline).toBe(
      "No issues yet. Start a new project and Seshat plans the first ones with you.",
    );
  });

  it("DB-N9-3: shows the forecast as a range, and says when history is too short", () => {
    expect(v.numbers[0]).toEqual({
      id: "forecast",
      label: "Forecast",
      value: "Not enough history yet",
      detail: "A range needs 5 days of history with finished issues: 2 days so far, 1 finished.",
    });
    // The forecast is the project's; a sprint's end is not its target (DEC-37).
    expect(v.forecast).toEqual({});
    const ranged = statusModel(
      input({
        facts: {
          ...solo,
          forecast: {
            remaining: 5,
            p50Days: 3,
            p85Days: 6,
            historyDays: 9,
            finished: 6,
            minimum: 5,
          },
        },
      }),
    );
    expect(ranged.numbers[0]).toEqual({
      id: "forecast",
      label: "Forecast",
      value: "50% Sep 30 · 85% Oct 3 · no target set",
      detail: "From 9 days of finished issues; 5 issues left.",
    });
    expect(ranged.forecast).toEqual({ band: { from: "2026-09-30", to: "2026-10-03" } });
    // With no sprint there is no target either, and the range is still two dates.
    const noTarget = statusModel(
      input({
        cycles: [],
        facts: {
          ...solo,
          forecast: {
            remaining: 1,
            p50Days: 1,
            p85Days: 1,
            historyDays: 9,
            finished: 6,
            minimum: 5,
          },
        },
      }),
    );
    expect(noTarget.numbers[0]?.value).toBe("50% Sep 28 · 85% Sep 28 · no target set");
    // Nothing left: never one date for both percentiles.
    const finished = statusModel(
      input({
        facts: {
          ...solo,
          forecast: {
            remaining: 0,
            p50Days: 0,
            p85Days: 0,
            historyDays: 9,
            finished: 6,
            minimum: 5,
          },
        },
      }),
    );
    expect(finished.numbers[0]).toEqual({
      id: "forecast",
      label: "Forecast",
      value: "All issues done",
      detail: "6 issues finished in the last 9 days; none left.",
    });
    expect(finished.forecast).toEqual({});
  });

  it("DB-N9-5: counts requirements done per release, never counting tests too weak as done", () => {
    expect(v.numbers.slice(1)).toEqual([
      {
        id: "requirements",
        label: "Requirements",
        value: "Release 1 · 1 of 7 requirements done",
        detail: "1 with tests too weak, not counted as done. Suspect since a change: Import.",
      },
      { id: "issues", label: "Issues done", value: "1 of 6" },
      { id: "sprint", label: "Sprint", value: "Sprint 4 · 3 days left" },
      // A jump to Needs you on this page; a hash link would change the route.
      { id: "attention", label: "Needs attention", value: "5", jump: "needs" },
    ]);
    expect(v.appetite).toBe("Appetite used: 5 of 8 issues.");
  });

  it("DB-N9-5: groups requirements as Must, Should and Could have, each in one of five states", () => {
    expect(v.requirements.groups).toEqual([
      {
        label: "Must have",
        summary: "1 done · 1 tests too weak · 1 blocked",
        rows: [
          { id: "REQ-1", title: "Record every change", state: "done", label: "Done", tone: "pass" },
          {
            id: "REQ-2",
            title: "Verify the chain",
            state: "tests_too_weak",
            label: "Tests too weak",
            tone: "parked",
          },
          { id: "REQ-3", title: "Export to CSV", state: "blocked", label: "Blocked", tone: "fail" },
        ],
      },
      {
        label: "Should have",
        summary: "2 in progress",
        rows: [
          {
            id: "REQ-4",
            title: "Search history",
            state: "in_progress",
            label: "In progress",
            tone: "running",
          },
          {
            id: "REQ-6",
            title: "Import",
            state: "in_progress",
            label: "In progress",
            tone: "running",
          },
        ],
      },
      {
        label: "Could have",
        summary: "2 not started",
        rows: [
          {
            id: "REQ-5",
            title: "Dark theme",
            state: "not_started",
            label: "Not started",
            tone: "",
          },
          {
            id: "REQ-8",
            title: "Audit log",
            state: "not_started",
            label: "Not started",
            tone: "",
          },
        ],
      },
    ]);
    const none = statusModel(input({ storyMap: null }));
    expect(none.requirements).toEqual({
      groups: [],
      empty: "No requirements yet. Seshat lists them when a person accepts the project's brief.",
    });
    expect(none.numbers[1]).toEqual({
      id: "requirements",
      label: "Requirements",
      value: "None yet",
      detail: "Accept a brief with Seshat to list them.",
    });
  });

  it("DB-P5-1: lists what needs you with plain buttons", () => {
    expect(v.needsYou.items).toEqual([
      {
        kind: "review",
        text: "Ledger is waiting for your review.",
        buttons: [{ label: "Review it", href: "#/review/card_ledger" }],
      },
      {
        kind: "decision",
        text: "A question waits for your answer: Should Import read CSV or JSON?",
        buttons: [{ label: "Answer", href: "#/inbox" }],
      },
      {
        kind: "parked",
        text: "Export is on hold. Used every budgeted step without passing.",
        buttons: [{ label: "Unpark", act: "unpark", id: "card_export" }],
      },
      {
        // Unproven, so it cannot be accepted yet; a requirement is unplanned, so it cannot be extended.
        kind: "slice",
        text: "Release 1 reached its appetite with 2 of 3 Must have requirements not done. Choose how it goes on.",
        buttons: [
          {
            label: "Move the rest to Later",
            act: "slice-cut",
            id: "slice_1",
            ids: ["REQ-4", "REQ-5", "REQ-6", "REQ-8"],
          },
        ],
      },
      {
        kind: "plan",
        text: "Plan me has a plan waiting for your approval.",
        buttons: [{ label: "Review plan", href: "#/card/card_plan/plan" }],
      },
    ]);
    // Solo has no one else to wait on.
    expect(v.waiting).toBeNull();
  });

  it("PM-P13-9: offers Accept only for a proven release and Extend only when nothing is unplanned", () => {
    const [slice] = storyMap.slices;
    if (!slice) throw new Error("fixture");
    const ready = {
      ...storyMap,
      slices: [
        {
          ...slice,
          state: "proven",
          requirements: slice.requirements.map((r) =>
            r.state === "unplanned" ? { ...r, state: "planned" } : r,
          ),
        },
      ],
    };
    const item = statusModel(input({ storyMap: ready })).needsYou.items.find(
      (i) => i.kind === "slice",
    );
    expect(item?.buttons).toEqual([
      { label: "Accept as it is", act: "slice-accept", id: "slice_1" },
      {
        label: "Move the rest to Later",
        act: "slice-cut",
        id: "slice_1",
        ids: ["REQ-4", "REQ-5", "REQ-6", "REQ-8"],
      },
      { label: "Extend", act: "slice-extend", id: "slice_1", cards: 8 },
    ]);
  });

  it("DB-N9-6: shows each fired risk as a sentence, then Suggested and Why; nothing is applied here", () => {
    expect(v.risks.items).toEqual([
      {
        sentence: "3 issues wait for review, as many as review can take.",
        suggested: "Review the waiting issues before starting more.",
        why: "Finished work is not done until a person accepts it, and the Agent holds new work while review is full.",
        action: { label: "Open Review", href: "#/review" },
      },
      {
        sentence: "Export has been blocked for 14.5 hours.",
        suggested: "Ask whoever holds the blocker, or unblock it.",
        why: "Blocked work ages quietly and delays everything that waits on it.",
        action: { label: "See Seshat's proposal", href: "#/pm" },
      },
      {
        sentence: "Scope grew by 25% since the plan was made.",
        suggested: "Hold the added issues until you confirm the goal has grown.",
        why: "More than 20% was added after work began, and growth hidden in a plan moves every date.",
        action: { label: "Answer", href: "#/inbox" },
      },
    ]);
    // A blocked issue that is not on this page is another project's (PM-N9-8).
    const elsewhere = statusModel(
      input({
        signals: [
          {
            id: "blocked_time",
            value: 30,
            threshold: 12,
            triggered: true,
            response: { action: "escalate_blockers", mode: "proposal", targets: ["card_other"] },
          },
        ],
      }),
    );
    expect(elsewhere.risks.items).toEqual([]);
    expect(statusModel(input({ signals: [] })).risks).toEqual({
      items: [],
      empty:
        "No risks right now. Sekhemet watches scope, blocked work, failures and the review queue.",
    });
  });

  it("gives today's standup, Done this week with who accepted it, and the models line", () => {
    expect(v.standup).toEqual({
      lines: [
        "Done: Hasher",
        "Being built: Search",
        "Waiting for review: Ledger",
        "On hold: Export",
        "1 question waits for an answer.",
      ],
      empty: "Nothing changed in the last day.",
    });
    expect(v.doneThisWeek).toEqual({
      items: ["Hasher · accepted by you · Sep 25"],
      empty: "Nothing accepted this week yet.",
    });
    expect(v.models).toBe("Coding model busy · 2 in queue, about 6 minutes");
    expect(statusModel(input({ cards: [], standing: [] })).models).toBe("Coding model idle");
  });

  it("DB-N9-8: the flow strip gives median and 85th-percentile cycle time, throughput, sent back and first-time passes, each linking to Insights", () => {
    expect(v.flow).toEqual({
      items: [
        { label: "Cycle time, median", value: "3h", href: "#/insights" },
        { label: "Cycle time, 85th percentile", value: "7.3h", href: "#/insights" },
        { label: "Throughput", value: "0.7 issues a week", href: "#/insights" },
        { label: "Sent back", value: "2 in 30 days", href: "#/insights" },
        { label: "Checks passed first time", value: "75% (3 of 4)", href: "#/insights" },
      ],
    });
    const thin = statusModel(
      input({ facts: { ...solo, flow: { ...solo.flow, cycleHours: [2], finished: 1 } } }),
    );
    expect(thin.flow.items[0]?.value).toBe("Not enough yet");
    expect(thin.flow.note).toBe("Cycle time needs 3 finished issues; there is 1.");
  });

  it("DB-P5-2: no stop-reason code, bare issue id or gate id reaches a word on the page", () => {
    const text = words(v).join("\n");
    expect(text).not.toMatch(/\bcard_[a-z]/);
    expect(text).not.toMatch(/budget_exhausted|oscillation_detected|no_progress|repair_exhausted/);
    expect(text).not.toMatch(/ReviewWIP|\bp50\b|\bp95\b|epic_x/);
    expect(text).not.toMatch(/sekhemet approve/);
  });

  it("shows only this project's issues from the workspace's standup (PM-N9-8)", () => {
    const text = words(v).join("\n");
    expect(text).not.toMatch(/Storefront checkout|payment provider/);
  });
});

describe("Status in the Team setup (DB-N9-2, DB-N9-4, DB-N9-7, DB-N9-21)", () => {
  const team: StatusFacts = {
    ...solo,
    setup: "team",
    isLead: false,
    canSetHealth: false,
    canPostUpdate: false,
    health: { value: "at_risk", by: "Priya", at: "2026-09-24T10:00:00.000Z" },
    update: { text: "Status\nA good week.", by: "Priya", at: "2026-09-26T09:00:00.000Z" },
  };

  it("shows health with who set it and when, and the latest update with its author", () => {
    const v = statusModel(input({ facts: team }));
    expect(v.health).toEqual({ text: "At risk · set by Priya · Sep 24", tone: "parked" });
    expect(v.update).toEqual({ text: "Status\nA good week.", byline: "Posted by Priya · Sep 26" });
    expect(v.setHealth).toBe(false);
    expect(v.writeUpdate).toBe(false);
  });

  it("DB-N9-2: says No health set in Team, offers Set health only to the lead, and never in Solo", () => {
    expect(statusModel(input({ facts: { ...team, health: null } })).health).toEqual({
      text: "No health set",
      tone: "",
    });
    expect(statusModel(input({ facts: { ...solo, health: null } })).health).toBeNull();
    const lead = { ...team, isLead: true, canSetHealth: true };
    expect(statusModel(input({ facts: { ...lead, healthWritable: true } })).setHealth).toBe(true);
    // Health is recorded by B4.11's route; until it exists nothing offers to set it.
    expect(statusModel(input({ facts: lead })).setHealth).toBe(false);
  });

  it("DB-N9-4, DB-N9-21: Update missing reaches the lead in Team, and never shows in Solo", () => {
    expect(
      statusModel(input({ facts: { ...team, isLead: true, updateMissing: true } })).updateMissing,
    ).toBe("Update missing: no update has been posted in the last 7 days.");
    // Only the lead is shown it (TEAM-29).
    expect(
      statusModel(input({ facts: { ...team, updateMissing: true } })).updateMissing,
    ).toBeNull();
    expect(
      statusModel(input({ facts: { ...solo, updateMissing: true } })).updateMissing,
    ).toBeNull();
  });

  it("offers Unpark only to a level that may use it; a Stakeholder's parked issue waits on a Member", () => {
    const mine = cards.map((c) => (c.id === "card_export" ? { ...c, owner: "p_me" } : c));
    const member = statusModel(input({ cards: mine, facts: team }));
    expect(member.needsYou.items.find((i) => i.kind === "parked")?.buttons).toEqual([
      { label: "Unpark", act: "unpark", id: "card_export" },
    ]);
    const stakeholder = statusModel(input({ cards: mine, facts: { ...team, canUnpark: false } }));
    expect(stakeholder.needsYou.items.map((i) => i.kind)).toEqual(["decision"]);
    expect(stakeholder.waiting?.items).toContain(
      "Export · on hold · waiting for a Member to take it off hold",
    );
  });

  it("lists another person's review and plan approval under Waiting on others, not Needs you", () => {
    const v = statusModel(input({ facts: team }));
    expect(v.needsYou.items.map((i) => i.kind)).toEqual(["decision"]);
    expect(v.waiting).toEqual({
      items: [
        "Ledger · waiting for Priya's review · 2h",
        // No owner: it waits on the project's lead.
        "Plan me · plan waiting for the project lead's approval",
      ],
      empty: "Nothing waits on anyone else.",
    });
  });

  it("DB-N9-7: Who's working on what names each person's and the Agent's current item, and counts nothing", () => {
    const withPeople: StatusCardLike[] = [
      ...cards,
      {
        id: "card_docs",
        title: "Docs",
        status: "in_progress",
        tier: "task",
        delegate: "p_sam",
        display: { delegateName: "Sam" },
        updatedAt: "2026-09-27T09:00:00.000Z",
      },
      {
        id: "card_notes",
        title: "Notes",
        status: "in_progress",
        tier: "task",
        delegate: "p_sam",
        display: { delegateName: "Sam" },
        updatedAt: "2026-09-27T11:30:00.000Z",
      },
    ];
    const v = statusModel(input({ facts: team, cards: withPeople }));
    expect(v.working).toEqual({
      rows: [
        { who: "Agent", ai: true, item: "Search" },
        { who: "Sam", ai: false, item: "Notes" },
      ],
      empty: "No one is working on an issue right now.",
    });
    expect(words(v.working).join(" ")).not.toMatch(/\d/);
  });
});

describe("TEAM-39: a request to start the Agent in Needs you", () => {
  it("names who asked and what, and offers Start and Decline", () => {
    const facts: StatusFacts = {
      ...solo,
      setup: "team",
      isLead: false,
      agentRequests: [
        {
          id: "asr_1",
          cardId: "card_login",
          title: "Login",
          requestedBy: "Dana",
          ask: "@Agent fix the login redirect",
        },
      ],
    };
    const item = statusModel(input({ facts })).needsYou.items.find(
      (i) => i.kind === "agent_request",
    );
    expect(item).toEqual({
      kind: "agent_request",
      text: "Dana asked the Agent to work on Login: “@Agent fix the login redirect”. Start it?",
      buttons: [
        { label: "Start", act: "agent-start", id: "asr_1", card: "card_login" },
        { label: "Decline", act: "agent-decline", id: "asr_1", card: "card_login" },
      ],
    });
  });
});

describe("B4.11 T6: health a person sets and a release's target date (TEAM-28, DB-N9-2, DB-N9-3)", () => {
  const ranged = {
    remaining: 5,
    p50Days: 3,
    p85Days: 6,
    historyDays: 9,
    finished: 6,
    minimum: 5,
  };
  const lead: StatusFacts = {
    ...solo,
    setup: "team",
    isLead: true,
    canSetHealth: true,
    healthWritable: true,
    health: { value: "off_track", by: "you", at: "2026-09-26T10:00:00.000Z" },
    release: { id: "SLICE-2", name: "Release 2" },
    target: { release: "SLICE-2", date: "2026-10-09", by: "Lee", at: "2026-09-25T09:00:00.000Z" },
    canSetTarget: true,
    forecast: ranged,
  };

  it("offers the lead the three health words, the one set now checked", () => {
    const v = statusModel(input({ facts: lead }));
    expect(v.setHealth).toBe(true);
    expect(v.healthChoices).toEqual([
      { value: "on_track", label: "On track", checked: false },
      { value: "at_risk", label: "At risk", checked: false },
      { value: "off_track", label: "Off track", checked: true },
    ]);
    expect(v.health).toEqual({ text: "Off track · set by you · Sep 26", tone: "fail" });
  });

  it("DB-N9-3: the forecast range ends with the release's target, drawn as the burn-up's line", () => {
    const v = statusModel(input({ facts: lead }));
    expect(v.numbers[0]?.value).toBe("50% Sep 30 · 85% Oct 3 · target Oct 9");
    expect(v.forecast).toEqual({
      band: { from: "2026-09-30", to: "2026-10-03" },
      target: "2026-10-09",
    });
    expect(v.target).toBe("Release 2 target Oct 9 · set by Lee · Sep 25");
    expect(v.setTarget).toEqual({ release: "SLICE-2", name: "Release 2", date: "2026-10-09" });
    // Too little history: still no single date, and the target is still said.
    const short = statusModel(
      input({
        facts: { ...lead, forecast: { ...ranged, p50Days: undefined, p85Days: undefined } },
      }),
    );
    expect(short.numbers[0]?.value).toBe("Not enough history yet");
    expect(short.numbers[0]?.detail).toMatch(/ Target Oct 9\.$/);
  });

  it("offers Set target date only where the server says the viewer may, and only with a release", () => {
    expect(statusModel(input({ facts: { ...lead, canSetTarget: false } })).setTarget).toBeNull();
    expect(statusModel(input({ facts: { ...lead, release: null } })).setTarget).toBeNull();
    const none = statusModel(input({ facts: { ...lead, target: null } }));
    expect(none.target).toBeNull();
    expect(none.setTarget).toEqual({ release: "SLICE-2", name: "Release 2", date: null });
    expect(none.numbers[0]?.value).toBe("50% Sep 30 · 85% Oct 3 · no target set");
  });
});

describe("close-out C3: a release's lead (teams item 28, DB-N9-2)", () => {
  const team: StatusFacts = {
    ...solo,
    setup: "team",
    isLead: true,
    canSetHealth: true,
    healthWritable: true,
    health: null,
    release: {
      id: "SLICE-2",
      name: "Release 2",
      lead: { principal: "p_mo", name: "Mo Member" },
    },
    canSetReleaseLead: true,
    releaseLeadChoices: [
      { principal: "p_lee", name: "Lee Lead" },
      { principal: "p_mo", name: "Mo Member" },
    ],
  };

  it("names the current release's lead to everyone", () => {
    expect(statusModel(input({ facts: { ...team, canSetReleaseLead: false } })).releaseLead).toBe(
      "Release 2 lead: Mo Member",
    );
    const none = { ...team, release: { id: "SLICE-2", name: "Release 2" } };
    expect(statusModel(input({ facts: none })).releaseLead).toBeNull();
  });

  it("offers the project lead or an Admin the Members and Admins to name, the current one chosen", () => {
    expect(statusModel(input({ facts: team })).setReleaseLead).toEqual({
      release: "SLICE-2",
      name: "Release 2",
      lead: "p_mo",
      choices: [
        { principal: "p_lee", name: "Lee Lead" },
        { principal: "p_mo", name: "Mo Member" },
      ],
    });
    expect(
      statusModel(input({ facts: { ...team, canSetReleaseLead: false } })).setReleaseLead,
    ).toBeNull();
    expect(statusModel(input({ facts: { ...team, release: null } })).setReleaseLead).toBeNull();
    // Solo has one person: no release lead is shown or offered.
    const soloView = statusModel(input({ facts: { ...team, setup: "solo" } }));
    expect(soloView.releaseLead).toBeNull();
    expect(soloView.setReleaseLead).toBeNull();
  });
});

describe("DB-N9-17 on Status: a header action the viewer's level cannot do is shown disabled", () => {
  const member: StatusFacts = {
    ...solo,
    setup: "team",
    isLead: false,
    canSetHealth: false,
    healthWritable: true,
    health: null,
    release: { id: "SLICE-2", name: "Release 2" },
    canSetTarget: false,
    canSetReleaseLead: false,
    canPostUpdate: false,
  };

  it("names each one with the permission it needs, so the page writes the level note beside it", () => {
    const v = statusModel(input({ facts: member }));
    expect(v.setHealth).toBe(false);
    expect(v.setTarget).toBeNull();
    expect(v.setReleaseLead).toBeNull();
    expect(v.writeUpdate).toBe(false);
    expect(v.gated).toEqual({
      health: "project.health",
      target: "release.target",
      releaseLead: "release.lead",
      update: "project.update",
    });
  });

  it("gates nothing the viewer may do, nothing that has no release to act on, and nothing in Solo", () => {
    const lead = {
      ...member,
      isLead: true,
      canSetHealth: true,
      canSetTarget: true,
      canSetReleaseLead: true,
      canPostUpdate: true,
    };
    expect(statusModel(input({ facts: lead })).gated).toEqual({});
    expect(statusModel(input({ facts: { ...member, release: null } })).gated).toEqual({
      health: "project.health",
      update: "project.update",
    });
    expect(
      statusModel(input({ facts: { ...member, healthWritable: false } })).gated.health,
    ).toBeUndefined();
    expect(statusModel(input({ facts: { ...member, setup: "solo" } })).gated).toEqual({});
  });
});
