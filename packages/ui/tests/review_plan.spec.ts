import { describe, expect, it } from "vitest";
// The browser module as-is: the same code the page runs.
import {
  approvalNoteHtml,
  choicesOf,
  keptCandidates,
  moveLine,
  planThreadHtml,
  reviewPlanHtml,
  reviewState,
  setAnswer,
  setType,
  toggleCandidate,
} from "../web/review_plan_view.js";

/**
 * design-stage §2.9 items 5-7 (DS-P2-6, -7) on the dashboard: Review plan
 * shows the brief under its eight headings, each release with its forecast
 * or "Not enough history yet", the assumptions and the count of what
 * approval creates; the candidates are grouped Must / Should / Could, each
 * with Accept and Remove, with a movable release line; the Type is proposed
 * with its reason; at most two questions. What the person chose is what
 * Create project sends.
 */
const group = () => ({
  version: 1,
  sentence: "a recipe <site>",
  buildSpec: "a recipe site",
  brief: {
    problem: ["For people, who want to save favourites."],
    outcome: ["People can save favourites, end to end."],
    users: ["people"],
    notInScope: ["Not stated — assumed: nothing beyond what the request names."],
    constraints: ["Generator: npm init, tsc --init and Vitest"],
    priorArt: ["Not researched."],
    riskiest: ["Sign-in is secure."],
    doneMeans: ["Every issue passes its checks."],
  },
  type: { profile: "production", reason: "People sign in to it." },
  stack: { language: "typescript", name: "TypeScript on Node with Vitest", stated: false },
  generator: "npm init, tsc --init and Vitest",
  epics: [{ title: "a recipe site" }],
  cards: [{ title: "Save a favourite", criteria: ["Saving keeps it"], points: 2 }],
  requirements: [],
  candidates: [
    { key: "c_a", title: "Save favourites", priority: "must", source: "request", accepted: true },
    { key: "c_b", title: "Share a recipe", priority: "should", source: "request", accepted: true },
    {
      key: "c_c",
      title: "Person can rate",
      priority: "could",
      source: "walkthrough",
      accepted: false,
    },
  ],
  releaseLine: 2,
  releases: [
    { name: "Release 1", candidates: ["c_a", "c_b"], cards: 5 },
    {
      name: "Release 2",
      candidates: [],
      cards: 1,
      forecast: { p50Days: 3, p85Days: 6, samples: 9 },
    },
  ],
  questions: [
    {
      question: "How do people sign in?",
      default: "an email and a password",
      answers: ["an email and a password", "GitHub or Google"],
    },
  ],
  assumptions: ["TypeScript on Node with Vitest."],
  settled: [],
  cardZero: {
    title: "Card zero",
    spec: "",
    acceptanceCriteria: [],
    labels: [],
    scopeFiles: [],
    estimate: 1,
  },
  cardOne: {
    title: "Card one",
    spec: "",
    acceptanceCriteria: [],
    labels: [],
    scopeFiles: [],
    estimate: 1,
    acceptanceTests: [],
    reason: "",
  },
  creates: { project: 1, epics: 1, issues: 3, brief: 1, cardZero: 1 },
});

describe("DS-P2-6: Review plan, before anything exists", () => {
  it("shows the brief's eight headings, the releases, the assumptions and the count", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g));
    for (const h of [
      "Problem",
      "Outcome",
      "Users",
      "Not in scope",
      "Constraints",
      "Prior art",
      "Riskiest assumption",
      "Done means",
    ]) {
      expect(html).toContain(`>${h}<`);
    }
    expect(html).toContain("Not enough history yet");
    expect(html).toMatch(/50%[^<]*3 days/);
    expect(html).toMatch(/85%[^<]*6 days/);
    expect(html).toContain("TypeScript on Node with Vitest.");
    expect(html).toContain("1 project, 1 epic, 3 issues, the brief and its setup issue");
    // DEC-31: *issue*, never *card*, outside the board's tile.
    expect(html).toMatch(/2 candidates, about 5 issues/);
    expect(html.replace(/<[^>]*>/g, " ")).not.toMatch(/\bcards?\b|card zero/i);
    expect(html).toContain("Nothing exists until you create it");
    expect(html).toContain("a recipe &lt;site&gt;");
    // The on-screen words never head a list "requirements" (design-stage §2.2.6).
    expect(html.toLowerCase()).not.toContain("requirements");
  });
});

describe("DS-P2-7: candidates by priority, the release line, the Type, two questions", () => {
  it("groups the candidates with Accept and Remove on each, and the line between them", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g));
    const must = html.indexOf("Must have");
    const should = html.indexOf("Should have");
    const could = html.indexOf("Could have");
    expect(must).toBeGreaterThan(-1);
    expect(should).toBeGreaterThan(must);
    expect(could).toBeGreaterThan(should);
    expect(html.match(/data-accept=/g)).toHaveLength(3);
    expect(html.match(/data-remove=/g)).toHaveLength(3);
    expect(html).toContain("data-release-line");
    expect(html).toContain("People sign in to it.");
    expect(html).toContain("How do people sign in?");
  });

  it("what the person chose is what Create project sends", () => {
    const g = group();
    let s = reviewState(g);
    expect(keptCandidates(g, s).map((c) => c.key)).toEqual(["c_a", "c_b"]);
    s = toggleCandidate(s, "c_c", "accept");
    s = toggleCandidate(s, "c_b", "remove");
    expect(keptCandidates(g, s).map((c) => c.key)).toEqual(["c_a", "c_c"]);
    s = moveLine(g, s, -1);
    expect(s.line).toBe(1);
    s = moveLine(g, s, -5);
    expect(s.line).toBe(1);
    s = moveLine(g, s, +9);
    expect(s.line).toBe(2);
    s = setType(s, "internal tool");
    s = setAnswer(s, 0, 1);
    expect(choicesOf(s)).toEqual({
      accept: ["c_c"],
      remove: ["c_b"],
      releaseLine: 2,
      type: "internal tool",
      answers: { "0": 1 },
    });
    const html = reviewPlanHtml(g, s);
    expect(html).toContain("data-create");
    expect(html).toContain("Create project");
  });

  it("for a person who may create a project in the Team setup, says an Admin or a project lead creates it and accepts its brief", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g), { setup: "team" });
    expect(html).not.toContain("Send for approval");
    // The button says what pressing it does: it creates the project and
    // accepts its brief, which is an Admin's to do (TEAM-20 not built).
    expect(html).toMatch(/data-create[^>]*>Create project and accept its brief</);
    // Who may create it is said before the press, not after a 403 (TEAM-57).
    expect(html).toMatch(/an Admin or a project lead creates the project/i);
  });

  it("TEAM-57: a Member who leads no project sends it for approval instead of creating it", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g), {
      setup: "team",
      level: "member",
      me: "p_member",
      mayCreate: false,
      approvers: [{ principal: "p_admin", name: "Ada Admin" }],
    });
    expect(html).toMatch(/data-send[^>]*>Send for approval</);
    expect(html).not.toContain("data-create");
    expect(html).toMatch(/An Admin or a project lead approves it/);
  });
});

describe("TEAM-20: a Stakeholder sends the plan for approval instead of creating it", () => {
  const approvers = [
    { principal: "p_member", name: "Mo Member" },
    { principal: "p_admin", name: "Ada Admin" },
  ];

  it("offers Send for approval with a Member or Admin to name, and no Create project", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g), {
      setup: "team",
      level: "stakeholder",
      me: "p_stake",
      approvers,
    });
    expect(html).toMatch(/data-send[^>]*>Send for approval</);
    expect(html).not.toContain("data-create");
    expect(html).not.toMatch(/>Create project/);
    expect(html).toMatch(/<select[^>]*data-approver/);
    expect(html).toContain('value="p_member"');
    expect(html).toContain("Ada Admin");
    // What pressing it does is said before the press.
    expect(html).toMatch(/Nothing is created until they approve it/);
  });

  it("with no Admin or project lead to send it to, says so and sends nothing", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g), {
      setup: "team",
      level: "stakeholder",
      approvers: [],
    });
    expect(html).toMatch(/data-send[^>]*disabled/);
    expect(html).toMatch(/No one here can approve it yet/);
  });

  it("once sent, tells the Stakeholder who approves it, with nothing to press", () => {
    const g = group();
    const approval = {
      state: "sent",
      approver: "p_member",
      approverName: "Mo Member",
      requestedBy: "p_stake",
      requestedByName: "Sam Stakeholder",
    };
    const html = reviewPlanHtml(g, reviewState(g), {
      setup: "team",
      level: "stakeholder",
      me: "p_stake",
      approval,
    });
    expect(html).toMatch(/Sent to Mo Member for approval/);
    expect(html).not.toContain("data-send");
    expect(html).not.toContain("data-create");
    expect(html).not.toContain("data-approve");
  });

  it("says in Seshat's thread who approves a sent plan, or who sent it to you", () => {
    const approval = {
      state: "sent",
      approver: "p_member",
      approverName: "Mo Member",
      requestedBy: "p_stake",
      requestedByName: "Sam Stakeholder",
    };
    expect(approvalNoteHtml(approval, "p_stake")).toContain("Sent to Mo Member for approval.");
    expect(approvalNoteHtml(approval, "p_member")).toContain(
      "Sam Stakeholder sent this plan for your approval.",
    );
    expect(approvalNoteHtml(undefined, "p_member")).toBe("");
  });

  it("offers the approver Approve, starting from the choices sent, which they can edit", () => {
    const g = group();
    const choices = { remove: ["c_b"], releaseLine: 1, type: "prototype", answers: { "0": 1 } };
    const approval = {
      state: "sent",
      approver: "p_member",
      approverName: "Mo Member",
      requestedBy: "p_stake",
      requestedByName: "Sam Stakeholder",
      choices,
    };
    const state = reviewState(g, choices);
    expect(choicesOf(state)).toEqual(choices);
    const html = reviewPlanHtml(g, state, {
      setup: "team",
      level: "member",
      me: "p_member",
      approval,
    });
    expect(html).toMatch(/data-approve[^>]*>Approve</);
    expect(html).toMatch(/Sam Stakeholder sent this plan for your approval/);
    // TEAM-42, said before the press: its issues will be the approver's.
    expect(html).toMatch(/you own its issues/i);
    expect(html).not.toContain("data-send");
    // The approver edits the plan as anyone reviewing it does.
    expect(html).toContain("data-accept");
    expect(html).toContain("data-line-up");
  });
});

describe("DS-P2-1..3 on the card's Plan tab", () => {
  it("says what card zero's and card one's gates are", async () => {
    const { startCardNote } = await import("../web/review_plan_view.js");
    expect(startCardNote({ labels: ["card-zero"] })).toContain("generator");
    expect(startCardNote({ labels: ["card-one"] })).toContain("fails at an assertion");
    for (const l of ["card-zero", "card-one"])
      expect(startCardNote({ labels: [l] })).not.toMatch(/\bcards?\b|\bgates?\b/i);
    expect(startCardNote({ labels: [] })).toBe("");
  });
});

describe("design-stage §2.9 item 7: the approver asks a question in the plan's thread", () => {
  const sent = {
    state: "sent",
    approver: "p_member",
    approverName: "Mo Member",
    requestedBy: "p_stake",
    requestedByName: "Sam Stakeholder",
  };
  const asked = {
    ...sent,
    thread: [
      {
        id: "pcm_1",
        by: "p_member",
        byName: "Mo Member",
        text: "Why is <search> first?",
        at: "2026-09-28T10:00:00.000Z",
      },
    ],
  };

  it("offers the approver Ask a question, and the sender the answer box, while it is sent", () => {
    const approver = planThreadHtml(sent, "p_member");
    expect(approver).toContain("Questions");
    expect(approver).toContain("No questions yet.");
    expect(approver).toContain("data-plan-comment");
    expect(approver).toContain(">Ask a question</label>");
    expect(approver).toContain(">Ask</button>");
    const sender = planThreadHtml(asked, "p_stake");
    expect(sender).toContain("Mo Member");
    // The words are escaped: a person's text is never markup.
    expect(sender).toContain("Why is &lt;search&gt; first?");
    expect(sender).toContain(">Answer</label>");
    expect(sender).toContain(">Send answer</button>");
  });

  it("shows the thread read-only to anyone else, and once approved", () => {
    expect(planThreadHtml(asked, "p_member2")).not.toContain("data-plan-comment");
    expect(planThreadHtml(asked, "p_member2")).toContain("Why is &lt;search&gt; first?");
    expect(planThreadHtml({ ...asked, state: "approved" }, "p_member")).not.toContain(
      "data-plan-comment",
    );
    expect(planThreadHtml(undefined, "p_member")).toBe("");
  });

  it("is part of Review plan for a sent plan, and the thread's note says a question waits", () => {
    const html = reviewPlanHtml(group(), reviewState(group()), {
      setup: "team",
      level: "stakeholder",
      me: "p_stake",
      approval: asked,
    });
    expect(html).toContain("data-plan-comment");
    expect(approvalNoteHtml(asked, "p_stake")).toContain(
      "Mo Member asked a question: open Review plan to answer.",
    );
    expect(approvalNoteHtml(asked, "p_member")).not.toContain("asked a question");
  });
});
