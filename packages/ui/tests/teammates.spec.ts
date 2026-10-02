import { describe, expect, it } from "vitest";
import {
  AI_TEAMMATES,
  aiMentions,
  aiStateLine,
  startRequestLine,
  teammatePicker,
  tileAiState,
} from "../src/teammates.js";

// B4.11, teams NEW-teams-5 (items 17–19, 19a; TEAM-15, -17, -39) and
// dashboard §2.13.8: the AI teammates as a person meets them — in pickers,
// under their own heading with the AI badge; their state in DEC-34's six
// words; and a Stakeholder's request to start the Agent as its owner reads it.

describe("TEAM-17: pickers list Seshat and the Agent as AI teammates", () => {
  const people = [
    { value: "Priya", label: "Priya" },
    { value: "Owen", label: "Owen" },
  ];

  it("a mention picker lists the members, then Agent and Seshat under AI teammates", () => {
    const p = teammatePicker({ people, purpose: "mention" });
    expect(p.map((g) => g.heading)).toEqual(["Members", "AI teammates"]);
    expect(p[0]?.options.map((o) => o.label)).toEqual(["Priya", "Owen"]);
    expect(p[1]?.options.map((o) => [o.label, o.value, o.ai])).toEqual([
      ["Agent", "@Agent", true],
      ["Seshat", "@Seshat", true],
    ]);
    // A person is never an AI teammate, and an AI teammate never a member.
    expect(p[0]?.options.every((o) => !o.ai)).toBe(true);
  });

  it("an assignee picker delegates to the Agent and shows Seshat, which takes no issue", () => {
    const p = teammatePicker({ people, purpose: "assign" });
    const ai = p.find((g) => g.heading === "AI teammates")?.options ?? [];
    expect(ai.map((o) => o.label)).toEqual(["Agent", "Seshat"]);
    expect(ai[0]).toMatchObject({ value: "worker", ai: true });
    expect(ai[0]?.disabled).toBeUndefined();
    expect(ai[1]).toMatchObject({ ai: true, disabled: true });
    expect(ai[1]?.detail).toMatch(/@Seshat/);
  });

  it("filters by what is typed, keeping the headings in order", () => {
    const p = teammatePicker({ people, purpose: "mention", query: "se" });
    expect(p.map((g) => g.heading)).toEqual(["AI teammates"]);
    expect(p[0]?.options.map((o) => o.label)).toEqual(["Seshat"]);
  });

  it("names the two teammates once", () => {
    expect(AI_TEAMMATES.map((t) => t.name)).toEqual(["Agent", "Seshat"]);
  });
});

describe("TEAM-15: a comment's @Agent and @Seshat", () => {
  it("are found wherever they stand, once each, in any case", () => {
    expect(aiMentions("@Agent please take this, and @seshat what do you think? @AGENT")).toEqual([
      "agent",
      "seshat",
    ]);
    expect(aiMentions("email me at dana@agent.example or read @Agents")).toEqual([]);
    expect(aiMentions("(@Seshat)")).toEqual(["seshat"]);
  });
});

describe("TEAM-15: the AI's state in DEC-34's words", () => {
  it("queued, with its place and an estimate", () => {
    expect(
      aiStateLine({ who: "agent", state: "queued", standing: "2nd in queue, about 6 minutes" }),
    ).toEqual({
      name: "Agent",
      label: "queued",
      sentence: "Queued: 2nd in queue, about 6 minutes.",
    });
    expect(aiStateLine({ who: "agent", state: "queued" }).sentence).toBe(
      "Queued: it starts when the issue is Ready and its turn comes.",
    );
    expect(aiStateLine({ who: "seshat", state: "queued" })).toEqual({
      name: "Seshat",
      label: "queued",
      sentence: "Queued: Seshat answers here when its turn comes.",
    });
  });

  it("working, needs you (naming whom it waits on), paused, done and failed", () => {
    expect(aiStateLine({ who: "agent", state: "working", step: 4, of: 40 }).sentence).toBe(
      "Working on step 4 of 40.",
    );
    expect(aiStateLine({ who: "agent", state: "working", checking: true }).sentence).toBe(
      "The checks are running on the Agent's work.",
    );
    expect(aiStateLine({ who: "seshat", state: "working" }).sentence).toBe(
      "Seshat is writing an answer.",
    );
    expect(
      aiStateLine({
        who: "agent",
        state: "needs you",
        waitingFor: "start",
        waitsOn: "Owen",
        requestedBy: "Dana",
      }).sentence,
    ).toBe("Dana asked the Agent to start. Waiting for Owen to start it.");
    expect(
      aiStateLine({ who: "agent", state: "needs you", waitingFor: "answer", waitsOn: "you" })
        .sentence,
    ).toBe("Waiting for you to answer a question.");
    expect(aiStateLine({ who: "agent", state: "paused" }).sentence).toBe(
      "Paused by a person. Hand it back to resume.",
    );
    // R-36: done is a person's Accept; the Agent's work waiting for review reads finished.
    expect(aiStateLine({ who: "agent", state: "done", waitingFor: "review" }).label).toBe(
      "finished",
    );
    expect(aiStateLine({ who: "agent", state: "done" }).label).toBe("done");
    expect(aiStateLine({ who: "agent", state: "done", waitingFor: "review" }).sentence).toBe(
      "Finished. Its work is waiting for review.",
    );
    expect(aiStateLine({ who: "agent", state: "done" }).sentence).toBe("Done. Its work is merged.");
    expect(aiStateLine({ who: "seshat", state: "done" }).sentence).toBe("Answered.");
    expect(
      aiStateLine({ who: "agent", state: "failed", reason: "The checks failed twice." }).sentence,
    ).toBe("Stopped: The checks failed twice.");
    expect(aiStateLine({ who: "seshat", state: "failed" }).sentence).toBe(
      "Seshat couldn't answer. Ask again in a moment.",
    );
  });
});

describe("TEAM-39: a request to start the Agent, as its owner reads it", () => {
  it("names who asked and what, and offers Start", () => {
    expect(
      startRequestLine({
        requestedBy: "Dana",
        ask: "@Agent fix the login redirect",
        title: "Login",
      }),
    ).toEqual({
      text: "Dana asked the Agent to work on Login: “@Agent fix the login redirect”. Start it?",
      start: "Start",
      decline: "Decline",
    });
  });
});

describe("the browser imports the same module", () => {
  it("is served as a compiled pure module", async () => {
    const { UI_LIB_MODULES } = await import("../src/index.js");
    expect(UI_LIB_MODULES).toContain("teammates.js");
  });
});

describe("the comment box's words", () => {
  it("say what an AI teammate's mention did, from its state", async () => {
    const { COMMENT_COPY } = await import("../src/teammates.js");
    expect(
      COMMENT_COPY.reached(
        aiStateLine({
          who: "agent",
          state: "needs you",
          waitingFor: "start",
          requestedBy: "you",
          waitsOn: "Owen",
        }),
      ),
    ).toBe("Agent: You asked the Agent to start. Waiting for Owen to start it.");
  });
});

describe("teams item 19: the Agent's state on a board card's tile", () => {
  it("is the Agent's state word with its sentence, from the server's facts", () => {
    expect(
      tileAiState([{ who: "agent", state: "queued", standing: "2nd in queue, about 6 minutes" }]),
    ).toEqual({
      name: "Agent",
      label: "queued",
      sentence: "Queued: 2nd in queue, about 6 minutes.",
    });
    expect(tileAiState([{ who: "agent", state: "working", step: 3, of: 40 }])?.sentence).toBe(
      "Working on step 3 of 40.",
    );
  });

  it("shows nothing when the Agent is not on the issue, or only Seshat is", () => {
    expect(tileAiState(undefined)).toBeUndefined();
    expect(tileAiState([])).toBeUndefined();
    expect(tileAiState([{ who: "seshat", state: "working" }])).toBeUndefined();
  });
});

/**
 * Planner-pm PM-N10-2 (RG-S5-2), fix round F3: a long comment to Seshat is
 * committed as a project document on the integration branch, and when a
 * checkout is on that branch the comment route returns how it catches up.
 * The issue page says so, as the composer does, and keeps the notice on
 * screen until it is closed: it carries a command to run.
 */
describe("PM-N10-2: what posting a comment says", () => {
  it("names the AI teammates it reached, then the checkout notice, kept until closed", async () => {
    const { commentPostedToasts, COMMENT_COPY } = await import("../src/teammates.js");
    const notice =
      "Your checkout /w/app is on main, which moved to 0123456789; to bring its files up to date (unsaved edits kept): `git -C /w/app read-tree -m -u abc main`";
    const toasts = commentPostedToasts({
      ai: [{ who: "seshat", state: "queued", standing: "1st in queue" }],
      notice,
    });
    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toMatchObject({ text: COMMENT_COPY.posted, tone: "info" });
    expect(toasts[0]?.detail).toMatch(/^Seshat: /);
    expect(toasts[1]).toEqual({
      text: COMMENT_COPY.documented,
      detail: notice,
      tone: "info",
      sticky: true,
    });
  });

  it("says only that the comment was posted when nothing else happened", async () => {
    const { commentPostedToasts, COMMENT_COPY } = await import("../src/teammates.js");
    expect(commentPostedToasts({})).toEqual([{ text: COMMENT_COPY.posted, tone: "info" }]);
    expect(commentPostedToasts(undefined)).toEqual([{ text: COMMENT_COPY.posted, tone: "info" }]);
  });

  it("is what the issue page shows after a comment", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const page = readFileSync(join(import.meta.dirname, "..", "web", "activity.js"), "utf8");
    expect(page).toMatch(/for \(const t of commentPostedToasts\(res\.data\)\) toast\(t\);/);
  });
});
