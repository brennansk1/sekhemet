import { describe, expect, it } from "vitest";
import {
  LESSONS_SEEN_KEY,
  PRACTICE_LESSONS,
  boardPracticeFacts,
  lessonIsNew,
  markLessonsSeen,
  practiceTipHtml,
  reviewHistory,
  tipFor,
} from "../src/learn.js";

// Dashboard NEW-dashboard-13 (§2.9.5; FINDINGS PRC-05; DESIGN_GAPS b15):
// lessons for the practice a person performs — the shape of every Tip (two
// sentences, a line from this project's numbers, one canonical link), in
// DEC-31's and DEC-52's words, offered once as a `?` marked new.

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

describe("DB-N13-1: a lesson for each practice a person performs", () => {
  it("covers reviewing, requesting changes, criteria, priority, blocked work, done, triage, sprint planning and the retrospective", () => {
    expect(PRACTICE_LESSONS).toEqual([
      "practice:review",
      "practice:request_changes",
      "practice:criteria",
      "practice:priority",
      "practice:blocked",
      "practice:definition_of_done",
      "practice:triage",
      "practice:sprint_planning",
      "practice:retrospective",
    ]);
  });

  it("gives each the shape of a Tip: two sentences, a line of its own, one canonical link", () => {
    for (const id of PRACTICE_LESSONS) {
      const t = tipFor(id, {});
      expect(t.concept.split(/(?<=[.!?])\s+/).length, id).toBeLessThanOrEqual(2);
      expect(t.yours, id).not.toBe("");
      // DB-N13-2: the Scrum Guide, Atlassian's or Linear's documentation.
      expect(t.source.url, id).toMatch(
        /^https:\/\/(scrumguides\.org|www\.atlassian\.com|linear\.app)\//,
      );
    }
  });

  it("uses the professional words (DEC-52), never the old ones", () => {
    const all = PRACTICE_LESSONS.map((id) => {
      const t = tipFor(id, {});
      return `${t.term} ${t.concept} ${t.yours}`;
    }).join(" ");
    expect(all).toContain("Request changes");
    expect(all).toContain("Acceptance criteria");
    expect(all).not.toMatch(/\bsend back\b|\bcard\b|\bcycle\b|\bpark\b/i);
    // The old name of acceptance criteria, as a term.
    expect(all).not.toMatch(/\bDone when\b/);
  });
});

describe("DB-N13-2: one line from the project's own numbers", () => {
  const decided = (seq: number, card: string, decision: string, principal = "p_me") => ({
    seq,
    cardId: card,
    principal,
    type: "review/decided",
    payload: { decision },
  });

  it("counts this person's last reviews, and the requests for changes that came back ready", () => {
    const events = [
      decided(1, "a", "send_back"),
      decided(2, "a", "accept", "p_other"),
      decided(3, "b", "send_back"),
      decided(4, "b", "send_back"),
      decided(5, "b", "accept"),
      decided(6, "c", "accept"),
      decided(7, "d", "park", "p_other"),
    ];
    const h = reviewHistory(events, "p_me");
    expect(h).toEqual({ decided: 5, accepted: 2, requested: 3, cameBackAccepted: 2 });
    // As `GET /api/events` serves them: the principal and the issue in the payload.
    const served = events.map(({ principal, cardId, ...e }) => ({
      ...e,
      payload: { ...e.payload, principal, id: cardId },
    }));
    expect(reviewHistory(served, "p_me")).toEqual(h);
    expect(tipFor("practice:request_changes", { practice: { reviews: h } }).yours).toBe(
      "You requested changes on 3 of your last 5 reviews; 2 of those came back and were accepted on the next review.",
    );
    expect(tipFor("practice:review", { practice: { reviews: h, inReview: 2 } }).yours).toBe(
      "You reviewed 5 issues here: 2 accepted, changes requested on 3. 2 issues wait in In review now.",
    );
  });

  it("says so when the person has not reviewed yet", () => {
    expect(tipFor("practice:review", { practice: { inReview: 1 } }).yours).toBe(
      "You have not reviewed an issue here yet. 1 issue waits in In review now.",
    );
    expect(tipFor("practice:request_changes", {}).yours).toBe(
      "You have not requested changes here yet.",
    );
  });

  it("reads criteria, priority, blocked work and what is done from the board", () => {
    const cards = [
      { status: "ready", priority: 1, acceptanceCriteria: ["x"], display: { waitsOn: [] } },
      {
        status: "in_progress",
        priority: 2,
        acceptanceCriteria: [],
        display: { waitsOn: [{ id: "z" }] },
      },
      { status: "review", priority: 0, display: {} },
      { status: "done", priority: 4, acceptanceCriteria: ["y"] },
      {
        status: "parked",
        priority: 3,
        acceptanceCriteria: ["w"],
        display: { waitsOn: [{ id: "q" }] },
      },
    ];
    const practice = boardPracticeFacts(cards);
    expect(practice).toMatchObject({
      inReview: 1,
      criteria: { open: 4, withCriteria: 2 },
      priorities: { urgent: 1, high: 1, medium: 1, low: 0, none: 1 },
      blocked: { open: 4, waiting: 2 },
      done: 1,
      onHold: 1,
    });
    expect(tipFor("practice:criteria", { practice }).yours).toBe(
      "2 of 4 open issues here have acceptance criteria.",
    );
    expect(tipFor("practice:priority", { practice }).yours).toBe(
      "Open issues here: 1 Urgent, 1 High, 1 Medium, 0 Low and 1 with no priority.",
    );
    expect(tipFor("practice:blocked", { practice }).yours).toBe(
      "2 of 4 open issues wait on another issue to finish.",
    );
  });

  it("states the project's Definition of done, triage, sprint and retrospective in its numbers", () => {
    expect(tipFor("practice:definition_of_done", { practice: { checks: 11 } }).yours).toBe(
      "Here an issue is done when its 11 checks pass and a person the Accept rule names accepts it.",
    );
    expect(tipFor("practice:triage", { practice: { triage: 3 } }).yours).toBe(
      "3 issues wait in Triage now.",
    );
    expect(
      tipFor("practice:sprint_planning", {
        sprint: { name: "Sprint 4", done: 5, total: 12, daysLeft: 3 },
      }).yours,
    ).toBe("Sprint 4 has 5 of 12 issues done, with 3 days left.");
    expect(tipFor("practice:sprint_planning", { practice: { ready: 6 } }).yours).toBe(
      "No sprint is running; 6 issues are in To do.",
    );
    expect(tipFor("practice:retrospective", { practice: { done: 9, onHold: 2 } }).yours).toBe(
      "9 issues are Done here and 2 are on hold: what held them up is a place to start.",
    );
  });
});

describe("DB-N13-3: offered once, never blocking the action", () => {
  it("marks a lesson new until it was offered, and remembers that per browser", () => {
    const s = memory();
    expect(lessonIsNew(s, "practice:review")).toBe(true);
    markLessonsSeen(s, ["practice:review"]);
    expect(lessonIsNew(s, "practice:review")).toBe(false);
    expect(lessonIsNew(s, "practice:triage")).toBe(true);
    expect(JSON.parse(s.map.get(LESSONS_SEEN_KEY) ?? "[]")).toEqual(["practice:review"]);
    // A browser that blocks storage never sees a lesson marked new forever.
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(lessonIsNew(blocked, "practice:review")).toBe(false);
  });

  it("is the Tip's ? button, marked new, and nothing at all with Tips off", () => {
    const on = practiceTipHtml(true, "practice:review", "Reviewing a change", "", true);
    expect(on).toContain('data-tip="practice:review"');
    expect(on).toContain('data-new="true"');
    expect(on).toContain('aria-label="About Reviewing a change, new"');
    expect(practiceTipHtml(true, "practice:review", "Reviewing a change", "", false)).not.toContain(
      "data-new",
    );
    expect(practiceTipHtml(false, "practice:review", "Reviewing a change", "", true)).toBe("");
  });
});
