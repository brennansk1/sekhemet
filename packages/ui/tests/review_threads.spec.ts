import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  THREAD_COPY,
  dismissalNote,
  openThreadText,
  threadBlocker,
  threadPlace,
  threadRows,
} from "../src/review_desk.js";

/**
 * B4.11, teams item 25 (NEW-teams-8; TEAM-24, -25) and dashboard §2.5 row
 * 9: the *Comment* verdict beside Accept and Send back, the review threads
 * on the Changes tab, Accept disabled naming the open thread when the
 * project requires it, and the note an accept dismissed by new commits
 * leaves — GitHub's pull-request review words, exact.
 */

const web = (name: string) => readFileSync(join(import.meta.dirname, "..", "web", name), "utf8");

const lineThread = {
  id: "thr_1",
  file: "src/b.ts",
  line: 1,
  name: "Mo Member",
  principal: "p_mo",
  resolved: false,
  comments: [
    { text: "Name this for what it holds.", name: "Mo Member", principal: "p_mo" },
    { text: "Maybe `retryLimit`?", name: "Vic Viewer", principal: "p_vic" },
  ],
};
const wholeThread = {
  id: "thr_2",
  name: "Sam Stakeholder",
  principal: "p_sam",
  resolved: true,
  resolvedByName: "Lee Lead",
  comments: [{ text: "Is the copy final?", name: "Sam Stakeholder", principal: "p_sam" }],
};

describe("where a thread is", () => {
  it("names the file and line, the file, or the whole change", () => {
    expect(threadPlace({ file: "src/b.ts", line: 12 })).toBe("src/b.ts:12");
    expect(threadPlace({ file: "src/b.ts" })).toBe("src/b.ts");
    expect(threadPlace({})).toBe("the whole change");
  });
});

describe("TEAM-25: Accept waits on the open thread only when the project requires it", () => {
  it("names the first open thread, who opened it and its first words, and how many more", () => {
    const open2 = { ...wholeThread, id: "thr_3", resolved: false };
    expect(openThreadText([lineThread, open2], true)).toBe(
      "This project needs every review thread resolved before Accept. Open thread on src/b.ts:1 from Mo Member: “Name this for what it holds.” (and 1 more open).",
    );
    expect(openThreadText([wholeThread], true)).toBe("");
    expect(openThreadText([lineThread], false)).toBe("");
    const long = { ...lineThread, comments: [{ text: `${"word ".repeat(30)}end` }] };
    expect(openThreadText([long], true)).toMatch(/: “(word ){11}word…”\.$/);
  });

  it("the desk's own wording wins; otherwise the page works it out", () => {
    expect(threadBlocker({ openThread: "Server says so." })).toBe("Server says so.");
    expect(threadBlocker({ threads: [lineThread], requireResolvedThreads: true })).toMatch(
      /^This project needs every review thread resolved before Accept\./,
    );
    expect(threadBlocker({ threads: [lineThread] })).toBe("");
    expect(threadBlocker(null)).toBe("");
  });

  it("the page puts it after who may accept and before findings and files", () => {
    const desk = web("review_desk.js");
    const deskBlocker = desk.slice(desk.indexOf("export function deskBlocker"));
    const who = deskBlocker.indexOf("acceptPermissionText");
    const thread = deskBlocker.indexOf("threadBlocker(desk)");
    const friction = deskBlocker.indexOf("acceptBlockers(");
    expect(who).toBeGreaterThan(-1);
    expect(thread).toBeGreaterThan(who);
    expect(friction).toBeGreaterThan(thread);
  });
});

describe("TEAM-24: an accept dismissed by new commits", () => {
  it("says so on the triage bar, naming whose accept and the pull request", () => {
    expect(dismissalNote({ acceptDismissed: { pr: 5, accepterName: "Lee Lead" } })).toEqual({
      text: "Accept dismissed: new commits since it was accepted",
      detail:
        "Lee Lead's accept of pull request #5 no longer holds. Review the new commits, then accept again.",
    });
    expect(dismissalNote({ acceptDismissed: {} })?.detail).toBe(
      "The accept no longer holds. Review the new commits, then accept again.",
    );
    expect(dismissalNote({})).toBeUndefined();
    expect(web("triage.js")).toContain("dismissalNote(detail?.desk)");
  });
});

describe("the Comment verdict and the review threads on the page", () => {
  it("lists open threads first, the reader as You, and what each person may do", () => {
    const rows = threadRows({ threads: [wholeThread, lineThread] }, "p_vic", true);
    expect(rows.heading).toBe("Review threads");
    expect(rows.count).toBe("1 open of 2");
    expect(rows.rows).toEqual([
      {
        id: "thr_1",
        place: "src/b.ts:1",
        resolved: false,
        state: "Open",
        comments: [
          { who: "Mo Member", text: "Name this for what it holds." },
          { who: "You", text: "Maybe `retryLimit`?" },
        ],
        action: { verb: "resolve", label: "Resolve conversation" },
      },
      {
        id: "thr_2",
        place: "the whole change",
        resolved: true,
        state: "Resolved by Lee Lead",
        comments: [{ who: "Sam Stakeholder", text: "Is the copy final?" }],
        action: { verb: "reopen", label: "Unresolve conversation" },
      },
    ]);
    // Below Member, the control is there, disabled, naming the level that may.
    const viewer = threadRows({ threads: [lineThread] }, "p_vic", false);
    expect(viewer.rows[0]?.action).toEqual({
      verb: "resolve",
      label: "Resolve conversation",
      disabled: "A Member can resolve conversations.",
    });
    expect(threadRows({ threads: [] }, "p_vic", true).count).toBe("");
  });

  it("the triage bar offers Comment (ghost) in the Team setup, beside Accept and Send back", () => {
    const triage = web("triage.js");
    expect(THREAD_COPY.comment).toBe("Comment");
    expect(triage).toMatch(/class="btn ghost" type="button" data-comment/);
    expect(triage).toContain('getSession().mode === "team"');
    expect(triage).toContain("/reviews`");
    // The issue page and Review both answer the button.
    expect(web("card.js")).toContain("[data-comment]");
    expect(web("review.js")).toContain("[data-comment]");
    // The Changes tab shows the threads, with Reply and Resolve.
    const threads = web("threads.js");
    expect(threads).toContain("threadRows(");
    expect(threads).toContain("/replies`");
    expect(web("changes.js")).toContain("threadsHtml(");
  });
});
