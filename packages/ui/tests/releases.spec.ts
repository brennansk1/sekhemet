import { describe, expect, it } from "vitest";
import { activityItems } from "../src/issue.js";
import {
  type NextReleaseLike,
  RELEASES_COPY,
  type RetroStateLike,
  nextReleaseView,
  pushFailureLine,
  retroView,
} from "../src/releases.js";

/**
 * Status's *Next release* and *Retrospective* sections (C2b; planner-pm
 * NEW-planner-pm-11, -12; review-git NEW-review-git-7), as a pure model with
 * exact words: the open Next release with its issues by title and the one
 * action that fits (*Propose release*, or the proposed release's notes and
 * *Tag*), whether pushes leave the server and why one failed; the
 * retrospective Seshat drafted, its actions as proposals a person applies,
 * and the ones posted.
 */
const next = (over: Partial<NextReleaseLike> = {}): NextReleaseLike => ({
  project: "proj_a",
  lastTag: { tag: "v1.2.3", sha: "a".repeat(40), at: "2026-09-30T10:00:00.000Z" },
  issues: [
    { id: "c1", title: "Fix the overtime total", category: "Fixed" },
    { id: "c2", title: "Add a weekly total row", category: "Added" },
  ],
  proposed: null,
  push: { on: false, remote: "origin", failed: [] },
  ...over,
});

describe("Next release (PM-N12-1, -4)", () => {
  it("lists the issues accepted since the last tag, by title, and offers Propose release", () => {
    const v = nextReleaseView(next(), true);
    expect(v.lede).toBe("2 issues accepted since v1.2.3.");
    expect(v.issues).toEqual([
      { id: "c1", title: "Fix the overtime total", category: "Fixed" },
      { id: "c2", title: "Add a weekly total row", category: "Added" },
    ]);
    expect(v.action).toEqual({ act: "release-propose", label: "Propose release" });
    expect(v.push).toBe(
      "Push to remote is off: tags and accepted work stay in this server's repository.",
    );
  });

  it("offers no Propose release when nothing was accepted since the last tag", () => {
    const v = nextReleaseView(next({ issues: [] }), true);
    expect(v.lede).toBe(RELEASES_COPY.nothingSince("v1.2.3"));
    expect(v.action).toBeNull();
    expect(nextReleaseView(next({ lastTag: null, issues: [] }), true).lede).toBe(
      "Nothing accepted yet. Issues accepted outside a planned release collect here.",
    );
  });

  it("shows a proposed release's notes and changelog with Tag, and no Propose", () => {
    const v = nextReleaseView(
      next({
        proposed: {
          version: "1.2.4",
          tag: "v1.2.4",
          issues: ["c1"],
          notes: "Fixed\n- Fix the overtime total",
          changelog: "## [1.2.4] - 2026-10-02\n\n### Fixed\n\n- fix the overtime total (abc1234)\n",
          sha: "b".repeat(40),
          at: "2026-10-02T10:00:00.000Z",
        },
      }),
      true,
    );
    expect(v.proposed?.heading).toBe("Release 1.2.4 is proposed. Read the notes, then tag it.");
    expect(v.proposed?.notes).toBe("Fixed\n- Fix the overtime total");
    expect(v.action).toEqual({ act: "release-tag", label: "Tag v1.2.4" });
  });

  it("disables the action for a person who may not accept, saying why", () => {
    expect(nextReleaseView(next(), false).action).toEqual({
      act: "release-propose",
      label: "Propose release",
      disabled: "The people the project's Accept rule names propose and tag its releases.",
    });
  });

  it("says where pushes go, and each failed push with why (RG-N7-3)", () => {
    const v = nextReleaseView(
      next({
        push: {
          on: true,
          remote: "origin",
          failed: [
            {
              ref: "refs/heads/main",
              sha: "c".repeat(40),
              remote: "origin",
              result: "refused",
              reason: "rejected (fetch first): the remote holds commits this branch does not have",
              at: "2026-10-02T10:00:00.000Z",
            },
          ],
        },
      }),
      true,
    );
    expect(v.push).toBe("Accepted work and tags are pushed to origin.");
    expect(v.failed).toEqual([
      "main was not pushed to origin: rejected (fetch first): the remote holds commits this branch does not have. It is pushed again at the next Accept or tag.",
    ]);
    expect(pushFailureLine({ ref: "refs/tags/v1.2.4", remote: "origin", reason: "denied." })).toBe(
      "The tag v1.2.4 was not pushed to origin: denied. It is pushed again at the next Accept or tag.",
    );
  });
});

describe("Retrospective (PM-N11-1..3)", () => {
  const state = (over: Partial<RetroStateLike> = {}): RetroStateLike => ({
    due: {
      sprint: { id: "cycle_1", name: "Sprint 1" },
      from: "2026-09-21T00:00:00.000Z",
      to: "2026-10-02T00:00:00.000Z",
      reason: "Sprint 1 completed",
    },
    draft: {
      wentWell: ["2 issues accepted: A; B."],
      slowed: ["Review wait: 2h at the median."],
      actions: [
        { kind: "playbook", text: "Make it a rule.", why: "Twice.", href: "#/playbook" },
        { kind: "issue", text: "Create an issue.", why: "On hold.", title: "Remove the blocker" },
      ],
      text: "Retrospective: Sprint 1\n\n…",
      basedOn: "Based on: Activity log #1–#9 · 2 issues accepted.",
    },
    posted: [],
    ...over,
  });

  it("presents Seshat's draft, its figures and its actions as proposals a person applies", () => {
    const v = retroView(state());
    expect(v.draft?.lede).toBe(
      "Seshat drafted the retrospective for Sprint 1 from the Activity log. Nothing changes until someone applies an action.",
    );
    expect(v.draft?.groups).toEqual([
      { heading: "What went well", items: ["2 issues accepted: A; B."] },
      { heading: "What slowed the team", items: ["Review wait: 2h at the median."] },
    ]);
    expect(v.draft?.actions).toEqual([
      { text: "Make it a rule.", why: "Twice.", href: "#/playbook", label: "Open the Playbook" },
      {
        text: "Create an issue.",
        why: "On hold.",
        act: "retro-issue",
        title: "Remove the blocker",
        label: "File it in Triage",
      },
    ]);
    expect(v.draft?.basedOn).toBe("Based on: Activity log #1–#9 · 2 issues accepted.");
    expect(v.empty).toBeNull();
  });

  it("lists the posted retrospectives, newest first, each named and linked", () => {
    const v = retroView(
      state({
        due: null,
        draft: null,
        posted: [
          {
            id: "retro_1",
            sprint: "cycle_1",
            from: "",
            to: "",
            text: "One",
            by: "Ana",
            at: "2026-09-20T10:00:00.000Z",
          },
          {
            id: "retro_2",
            from: "",
            to: "",
            text: "Two",
            by: "You",
            at: "2026-10-02T10:00:00.000Z",
          },
        ],
      }),
      { cycle_1: "Sprint 1" },
    );
    expect(v.draft).toBeNull();
    expect(v.posted.map((p) => [p.id, p.title, p.byline, p.text])).toEqual([
      ["retro_2", "Retrospective", "Posted by You · Oct 2", "Two"],
      ["retro_1", "Retrospective: Sprint 1", "Posted by Ana · Sep 20", "One"],
    ]);
  });

  it("says when one will be drafted when none is due and none was posted", () => {
    expect(retroView(state({ due: null, draft: null })).empty).toBe(
      "No retrospective yet. Seshat drafts one from the Activity log when a sprint completes, or after every few accepted issues in a project without sprints.",
    );
  });
});

describe("the issue's Activity says a push after its Accept, and why one failed (RG-N7-3)", () => {
  it("words a push made and a push refused, from the payload alone", () => {
    const items = activityItems({
      cardId: "c1",
      messages: [],
      decisions: [],
      events: [
        {
          seq: 1,
          type: "remote/pushed",
          actor: "harness",
          cardId: "c1",
          createdAt: "2026-10-02T10:00:00.000Z",
          payload: { ref: "refs/heads/main", remote: "origin", result: "pushed" },
        },
        {
          seq: 2,
          type: "remote/pushed",
          actor: "harness",
          cardId: "c1",
          createdAt: "2026-10-02T10:01:00.000Z",
          payload: { ref: "refs/heads/main", remote: "origin", result: "refused", code: "behind" },
        },
      ],
    });
    expect(items.map((i) => [i.who, i.text, i.tone])).toEqual([
      ["Sekhemet", "pushed main to origin", "pass"],
      [
        "Sekhemet",
        "could not push main to origin: the remote holds commits this branch does not have. It is pushed again at the next Accept or tag",
        "fail",
      ],
    ]);
  });
});
