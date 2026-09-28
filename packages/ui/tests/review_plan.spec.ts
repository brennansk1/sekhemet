import { describe, expect, it } from "vitest";
// The browser module as-is: the same code the page runs.
import {
  choicesOf,
  keptCandidates,
  moveLine,
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

  it("in the Team setup never promises a Send for approval that is not built (TEAM-20)", () => {
    const g = group();
    const html = reviewPlanHtml(g, reviewState(g), { setup: "team" });
    expect(html).not.toContain("Send for approval");
    // The button says what pressing it does: it creates the project and
    // accepts its brief, which is an Admin's to do (TEAM-20 not built).
    expect(html).toMatch(/data-create[^>]*>Create project and accept its brief</);
    // Who may create it is said before the press, not after a 403.
    expect(html).toMatch(/an Admin creates the project/i);
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
