import { describe, expect, it } from "vitest";
import { composerStarters, nonDeveloperWalk } from "../src/seshat.js";
import {
  START_COPY,
  START_ROUTE,
  type StartGroup,
  startDraftOf,
  startDraftView,
} from "../src/start.js";
import { keptCandidates, reviewState, toggleCandidate } from "../web/review_plan_view.js";

/**
 * design-stage §2.11, NEW-design-stage-7 (DS-N7-1..3, -5): the start page's
 * live draft as a pure model. It shows only the parts the `start_project`
 * proposal group holds, offers *Review plan* once a plan exists, lays the
 * draft out as a tab beside the conversation below 768 px, and writes
 * nothing. The page itself is driven in a browser by
 * `apps/harness/tests/start_page_draft_ui.spec.ts`.
 */

const group = (over: Partial<StartGroup> = {}): StartGroup => ({
  version: 1,
  sentence: "a way to see who has which laptop and when it is due back",
  brief: {
    problem: ["Equipment is lent from a spreadsheet and goes missing."],
    outcome: ["Anyone can see who has an item and when it is due."],
    users: [],
    notInScope: [],
    constraints: [],
    priorArt: [],
    riskiest: [],
    doneMeans: ["The equipment room stops using the spreadsheet."],
  },
  candidates: [
    { key: "c_a", title: "Check an item out", priority: "must", source: "request", accepted: true },
    { key: "c_b", title: "Check an item in", priority: "must", source: "request", accepted: true },
    {
      key: "c_c",
      title: "Email a reminder",
      priority: "should",
      source: "request",
      accepted: true,
    },
    {
      key: "c_d",
      title: "Lender can reserve an item",
      priority: "could",
      source: "walkthrough",
      accepted: false,
    },
  ],
  releaseLine: 2,
  releases: [
    {
      name: "Release 1",
      candidates: ["c_a", "c_b"],
      cards: 18,
      forecast: { p50Days: 14, p85Days: 21, samples: 30 },
    },
    { name: "Release 2", candidates: ["c_c"], cards: 1 },
  ],
  ...over,
});

const proposal = (id: string, state: string, g: unknown, kind = "start_project") => ({
  id,
  kind,
  state,
  patch: { group: g },
});

describe("the start page's live draft (NEW-design-stage-7)", () => {
  it("DS-N7-1: New project opens the start page's own route", () => {
    expect(START_ROUTE).toBe("#/projects/new");
  });

  it("DS-N7-1: the draft is the latest open start_project proposal carrying a group", () => {
    const g1 = group({ sentence: "first" });
    const g2 = group({ sentence: "second" });
    const messages = [
      { role: "user", text: "Start a new project: first" },
      { role: "pm", proposals: [proposal("p1", "open", g1)] },
      { role: "pm", proposals: [proposal("p2", "open", g2), proposal("p3", "open", {}, "x")] },
      { role: "pm", proposals: [proposal("p4", "applied", group({ sentence: "made" }))] },
    ];
    expect(startDraftOf(messages)?.id).toBe("p2");
    // A discarded or applied draft is no longer a draft; nothing at all is none.
    expect(startDraftOf([{ role: "pm", proposals: [proposal("p5", "discarded", g1)] }])).toBe(null);
    expect(startDraftOf([])).toBe(null);
    expect(startDraftOf(undefined)).toBe(null);
  });

  it("DS-N7-1: before Seshat drafts anything, no part is shown and Review plan says why it waits", () => {
    const v = startDraftView(null, { width: 1440 });
    expect(v.tabs).toEqual([]);
    expect(v.reviewPlan.enabled).toBe(false);
    expect(v.reviewPlan.reason).toBe(START_COPY.reviewPlanWaits);
    expect(v.empty).toBe(START_COPY.nothingYet);
    expect(v.heading).toBe("Draft · updates as you talk");
  });

  it("DS-N7-1: only the brief's filled sections, never an empty one", () => {
    const v = startDraftView(group(), { width: 1440 });
    expect(v.brief.map((s) => s.label)).toEqual(["Problem", "Outcome", "Done means"]);
    expect(v.brief.every((s) => s.lines.length > 0)).toBe(true);
    expect(JSON.stringify(v)).not.toMatch(/Not stated|to be filled|TBD/i);
  });

  it("DS-N7-1: the tabs are the parts the group holds, Brief, Requirements and Plan", () => {
    expect(startDraftView(group(), { width: 1440 }).tabs.map((t) => t.label)).toEqual([
      "Brief",
      "Requirements",
      "Plan",
    ]);
    const noBrief = group({
      brief: {
        problem: [],
        outcome: [],
        users: [],
        notInScope: [],
        constraints: [],
        priorArt: [],
        riskiest: [],
        doneMeans: [],
      },
    });
    expect(startDraftView(noBrief, { width: 1440 }).tabs.map((t) => t.id)).toEqual([
      "requirements",
      "plan",
    ]);
    const noPlan = group({ releases: [] });
    const v = startDraftView(noPlan, { width: 1440 });
    expect(v.tabs.map((t) => t.id)).toEqual(["brief", "requirements"]);
    expect(v.reviewPlan.enabled).toBe(false);
    expect(v.reviewPlan.reason).toBe(START_COPY.reviewPlanWaits);
    // The Requirements tab counts what is in the plan.
    expect(startDraftView(group(), { width: 1440 }).tabs[1]?.count).toBe(3);
  });

  it("DS-N7-1: Requirements by priority, each with where it came from, and the release line", () => {
    const v = startDraftView(group(), { width: 1440 });
    expect(v.requirements.map((p) => p.label)).toEqual(["Must have", "Should have", "Could have"]);
    const must = v.requirements[0]?.items ?? [];
    expect(must.map((i) => i.title)).toEqual(["Check an item out", "Check an item in"]);
    expect(must[0]?.from).toBe("You said");
    expect(must[0]?.state).toBe("Accepted");
    const could = v.requirements[2]?.items[0];
    expect(could?.state).toBe("Proposed");
    // Seshat's own suggestion is shown as Seshat's (DEC-36).
    expect(could?.ai).toBe(true);
    // The line sits after the second kept requirement.
    expect(v.lineAfter).toBe("c_b");
    expect(v.lineLabel).toBe("Release 1 ends here");
  });

  it("DS-N7-1: Accept and Remove change the draft as Review plan's do, and carry into it", () => {
    let s = reviewState({ ...group(), type: { profile: "internal tool" } });
    s = toggleCandidate(s, "c_d", "accept");
    s = toggleCandidate(s, "c_a", "remove");
    const v = startDraftView(group(), { width: 1440, state: s });
    const kept = keptCandidates(group(), s).map((c: { key: string }) => c.key);
    const shown = v.requirements
      .flatMap((p) => p.items)
      .filter((i) => i.state === "Accepted")
      .map((i) => i.key);
    expect(shown).toEqual(kept);
    expect(v.requirements[0]?.items[0]?.state).toBe("Removed");
  });

  it("DS-N7-1: the plan is the releases with their forecast ranges and issue counts", () => {
    const v = startDraftView(group(), { width: 1440 });
    expect(v.plan).toEqual([
      {
        name: "Release 1",
        holds: "2 requirements",
        issues: "about 18 issues",
        when: "2 to 3 weeks",
      },
      {
        name: "Release 2",
        holds: "1 requirement",
        issues: "about 1 issue",
        when: "Not enough history yet",
      },
    ]);
  });

  it("DS-N7-1, §2.11 item 2: Review plan is offered once a plan exists, with a one-line summary", () => {
    const v = startDraftView(group(), { width: 1440 });
    expect(v.reviewPlan).toEqual({
      enabled: true,
      label: "Review plan",
      summary: "Release 1: 2 requirements · about 18 issues · 2 to 3 weeks",
    });
    const short = startDraftView(
      group({
        releases: [
          {
            name: "Release 1",
            candidates: [],
            cards: 4,
            forecast: { p50Days: 3, p85Days: 5, samples: 9 },
          },
        ],
      }),
      { width: 1440 },
    );
    expect(short.reviewPlan.summary).toBe(
      "Release 1: 2 requirements · about 4 issues · 3 to 5 days",
    );
    const none = startDraftView(
      group({ releases: [{ name: "Release 1", candidates: [], cards: 4 }] }),
      {
        width: 1440,
      },
    );
    expect(none.reviewPlan.summary).toBe("Release 1: 2 requirements · about 4 issues");
  });

  it("DS-N7-2: narrower than 768 px the draft is a tab beside the conversation", () => {
    expect(startDraftView(group(), { width: 1440 }).layout).toBe("split");
    expect(startDraftView(group(), { width: 768 }).layout).toBe("split");
    const phone = startDraftView(group(), { width: 400 });
    expect(phone.layout).toBe("tabs");
    expect(phone.pageTabs).toEqual(["Conversation", "Draft"]);
  });

  it("DS-N7-2, DB-P5-7: the non-developer's walk starts a project on the start page", () => {
    const nav = [{ name: "status", label: "Status", route: "#/status", short: "Status" }] as never;
    const steps = nonDeveloperWalk(1440, nav).steps;
    expect(steps[1]).toMatchObject({ where: "Status", route: START_ROUTE });
    expect(steps[2]).toMatchObject({ press: "Send", route: START_ROUTE });
    expect(steps[3]).toMatchObject({ press: "Review plan", route: START_ROUTE });
  });

  it("DS-N7-3: the Seshat panel keeps its Start a new project starter", () => {
    expect(composerStarters().map((s) => s.label)).toContain("Start a new project");
  });

  it("DS-N7-5: the model only reads the group; it writes nothing back", () => {
    const g = group();
    const before = JSON.stringify(g);
    startDraftView(g, { width: 400 });
    expect(JSON.stringify(g)).toBe(before);
  });
});
