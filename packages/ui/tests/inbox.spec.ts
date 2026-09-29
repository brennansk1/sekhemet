import { describe, expect, it } from "vitest";
import {
  INBOX_COPY,
  INBOX_FILTERS,
  INBOX_GROUPS,
  type InboxItemFacts,
  MY_ISSUES_COPY,
  SNOOZE_CHOICES,
  WATCH_COPY,
  changeLine,
  inboxGroups,
  inviteRequestLine,
  itemLine,
  mentionInviteLine,
  myIssueGroups,
  snoozeUntil,
  strongestReason,
  watchLine,
} from "../src/inbox.js";
import { mentionHandle, personMentions } from "../src/teammates.js";

// B4.11, teams NEW-teams-7 (items 22–24; TEAM-21, -22, -23) and dashboard
// §2.17.2–3 (DB-N9-14, -15): the Inbox by reason, as Linear's reads, with
// Done, Snooze and Save; My issues grouped by project; the Watch toggle; and
// `@` mentions of people.

const item = (over: Partial<InboxItemFacts>): InboxItemFacts => ({
  id: "issue:card_a",
  reason: "watching",
  kind: "issue",
  cardId: "card_a",
  title: "Login",
  count: 1,
  at: "2026-09-28T10:00:00.000Z",
  seq: 10,
  unread: true,
  saved: false,
  done: false,
  link: "#/card/card_a/activity",
  ...over,
});

describe("DB-N9-14: the Inbox groups what reached you by reason", () => {
  it("names the five groups in the order teams item 24 lists them", () => {
    expect(INBOX_GROUPS.map((g) => g.label)).toEqual([
      "Needs you",
      "Mentioned",
      "Review requested",
      "Watching",
      "Agent finished",
    ]);
    expect(INBOX_FILTERS.map((f) => f.label)).toEqual(["Inbox", "Saved", "Done"]);
    expect([INBOX_COPY.done, INBOX_COPY.snooze, INBOX_COPY.save]).toEqual([
      "Done",
      "Snooze",
      "Save",
    ]);
    expect(INBOX_COPY.empty).toBe("Nothing needs you.");
  });

  it("groups items under their reason, keeps only groups with items, newest first", () => {
    const groups = inboxGroups([
      item({ id: "a", reason: "watching", seq: 1 }),
      item({ id: "b", reason: "mentioned", seq: 2 }),
      item({ id: "c", reason: "watching", seq: 3 }),
      item({ id: "d", reason: "needs_you", kind: "start_request", seq: 4 }),
    ]);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Needs you", ["d"]],
      ["Mentioned", ["b"]],
      ["Watching", ["c", "a"]],
    ]);
  });

  it("Needs you is longest wait first, as decision requests always were (§2.5.2)", () => {
    const groups = inboxGroups([
      item({
        id: "new",
        reason: "needs_you",
        kind: "decision",
        seq: 0,
        at: "2026-09-28T12:00:00Z",
      }),
      item({
        id: "old",
        reason: "needs_you",
        kind: "decision",
        seq: 0,
        at: "2026-09-28T08:00:00Z",
      }),
      item({
        id: "mid",
        reason: "needs_you",
        kind: "start_request",
        seq: 9,
        at: "2026-09-28T10:00:00Z",
      }),
    ]);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["old", "mid", "new"]);
  });

  it("an issue's row sits under its strongest reason: a mention beats watching", () => {
    expect(strongestReason(["watching", "mentioned"])).toBe("mentioned");
    expect(strongestReason(["watching", "review_requested"])).toBe("review_requested");
    expect(strongestReason(["review_requested", "agent_finished"])).toBe("agent_finished");
    expect(strongestReason([])).toBe("watching");
  });

  it("says each change as a person reads it, naming who did it", () => {
    expect(changeLine({ type: "commented", by: "Dana Lee" })).toBe("Dana Lee commented.");
    expect(changeLine({ type: "mentioned", by: "Dana Lee" })).toBe("Dana Lee mentioned you.");
    expect(changeLine({ type: "status", by: "Mo Member", status: "review" })).toBe(
      "Mo Member moved it to Review.",
    );
    expect(changeLine({ type: "status", byAi: "agent", status: "review" })).toBe(
      "Agent moved it to Review.",
    );
    expect(changeLine({ type: "owner", by: "Ada Admin", to: "you" })).toBe(
      "Ada Admin made you the owner.",
    );
    expect(changeLine({ type: "delegated", by: "Mo Member", toAi: "agent" })).toBe(
      "Mo Member delegated it to the Agent.",
    );
    expect(changeLine({ type: "delegated", by: "Mo Member", to: "Lee Lead" })).toBe(
      "Mo Member delegated it to Lee Lead.",
    );
    expect(changeLine({ type: "updated", by: "Mo Member", fields: ["priority", "labels"] })).toBe(
      "Mo Member changed the priority and labels.",
    );
    expect(changeLine({ type: "created", by: "Ada Admin" })).toBe("Ada Admin created it.");
    // Review verdicts and threads, as a pull request's notifications read.
    expect(changeLine({ type: "reviewed", by: "Mo Member" })).toBe("Mo Member left a review.");
    expect(changeLine({ type: "replied", by: "Lee Lead" })).toBe(
      "Lee Lead replied in a review thread.",
    );
    expect(changeLine({ type: "resolved", by: "Lee Lead" })).toBe(
      "Lee Lead resolved a review thread.",
    );
    expect(changeLine({ type: "reopened", by: "Mo Member" })).toBe(
      "Mo Member reopened a review thread.",
    );
    expect(changeLine({ type: "accept_dismissed", to: "you" })).toBe(
      "Accept dismissed: new commits since you accepted it.",
    );
    // A change of unknown origin still reads as a sentence.
    expect(changeLine({ type: "commented" })).toBe("Someone commented.");
  });

  it("an item about the Agent's work carries its state in DEC-34's words", () => {
    const line = itemLine(
      item({
        reason: "agent_finished",
        change: { type: "status", byAi: "agent", status: "review" },
        ai: [{ who: "agent", state: "done", waitingFor: "review" }],
      }),
    );
    expect(line.ai).toEqual([
      { name: "Agent", label: "done", sentence: "Finished. Its work is waiting for review." },
    ]);
    expect(line.line).toBe("Agent moved it to Review.");
    // More than one change since it was done: the row says how many.
    expect(itemLine(item({ count: 3, change: { type: "commented", by: "Vic" } })).line).toBe(
      "Vic commented. 3 updates.",
    );
  });

  it("a request to start the Agent, a plan and an invite read as their questions", () => {
    expect(
      itemLine(
        item({
          reason: "needs_you",
          kind: "start_request",
          request: { id: "asr_1", requestedBy: "Sam Stakeholder", ask: "@Agent go" },
        }),
      ).line,
    ).toBe("Sam Stakeholder asked the Agent to work on Login: “@Agent go”. Start it?");
    expect(
      itemLine(item({ reason: "needs_you", kind: "plan_approval", by: "Sam Stakeholder" })).line,
    ).toBe("Sam Stakeholder sent this plan for your approval.");
    expect(
      itemLine(
        item({
          reason: "needs_you",
          kind: "mention_invite",
          mention: { commentId: "cmt_1", people: ["Rae Removed"], project: "Chronicle" },
        }),
      ).line,
    ).toBe("Rae Removed can't see Chronicle. Invite them?");
    expect(
      itemLine(
        item({
          reason: "needs_you",
          kind: "invite_request",
          by: "Sam Stakeholder",
          mention: { commentId: "cmt_1", people: ["Rae Removed"], project: "Chronicle" },
        }),
      ).line,
    ).toBe("Sam Stakeholder asked to invite Rae Removed to Chronicle, from a mention on Login.");
    expect(
      itemLine(item({ reason: "needs_you", kind: "decision", question: "Which index?" })).line,
    ).toBe("The Agent asks: Which index?");
  });

  it("TEAM-22: the author is asked whether to invite a person who cannot see the project", () => {
    expect(mentionInviteLine(["Rae Removed"], "Chronicle")).toBe(
      "Rae Removed can't see Chronicle. Invite them?",
    );
    expect(mentionInviteLine(["Rae", "Pat"], "Chronicle")).toBe(
      "Rae and Pat can't see Chronicle. Invite them?",
    );
    expect(mentionInviteLine(["Rae", "Pat", "Kim"], undefined)).toBe(
      "Rae, Pat and Kim can't see this project. Invite them?",
    );
    expect(inviteRequestLine({ by: "Sam", people: ["Rae"], project: "Chronicle" })).toBe(
      "Sam asked to invite Rae to Chronicle.",
    );
    expect([INBOX_COPY.invite, INBOX_COPY.dontInvite]).toEqual(["Invite", "Don't invite"]);
  });
});

describe("TEAM-23: Snooze until a time", () => {
  // A Monday, 10:00 local.
  const now = new Date(2026, 8, 28, 10, 0, 0);

  it("offers Linear's choices and turns each into a time", () => {
    expect(SNOOZE_CHOICES.map((c) => c.label)).toEqual(["Later today", "Tomorrow", "Next week"]);
    expect(new Date(snoozeUntil("later", now)).getTime()).toBe(
      new Date(2026, 8, 28, 13, 0, 0).getTime(),
    );
    expect(new Date(snoozeUntil("tomorrow", now)).getTime()).toBe(
      new Date(2026, 8, 29, 9, 0, 0).getTime(),
    );
    // Next week: the next Monday at 09:00.
    expect(new Date(snoozeUntil("next_week", now)).getTime()).toBe(
      new Date(2026, 9, 5, 9, 0, 0).getTime(),
    );
  });
});

describe("DB-N9-15: My issues, grouped by project", () => {
  it("groups by project name and says why each issue is yours", () => {
    const groups = myIssueGroups([
      {
        id: "c1",
        title: "Search",
        status: "ready",
        why: ["owner"],
        project: { id: "p2", name: "Zeta" },
      },
      {
        id: "c2",
        title: "Login",
        status: "review",
        why: ["owner", "review"],
        project: { id: "p1", name: "Chronicle" },
      },
      {
        id: "c3",
        title: "Export",
        status: "in_progress",
        why: ["delegated"],
        project: { id: "p1", name: "Chronicle" },
      },
    ]);
    expect(groups.map((g) => [g.name, g.issues.map((i) => i.id)])).toEqual([
      ["Chronicle", ["c2", "c3"]],
      ["Zeta", ["c1"]],
    ]);
    expect(groups[0]?.issues[0]?.whyLabel).toBe("Owner · Review requested");
    expect(groups[0]?.issues[1]?.whyLabel).toBe("Delegated to you");
    expect(groups[0]?.issues[0]?.statusLabel).toBe("Review");
    expect(MY_ISSUES_COPY.title).toBe("My issues");
  });
});

describe("TEAM-21: the Watch toggle", () => {
  it("reads Watch, or Watching when the person gets every change", () => {
    expect(watchLine({ watching: false, watchers: [] })).toMatchObject({
      label: WATCH_COPY.watch,
      pressed: false,
    });
    expect(watchLine({ watching: true, watchers: ["You", "Mo Member"] })).toMatchObject({
      label: "Watching",
      pressed: true,
      detail: "2 watching: You, Mo Member",
    });
  });
});

describe("teams item 23: `@` mentions people as well as the AI teammates", () => {
  const people = [
    { principal: "p_dana", name: "Dana Lee" },
    { principal: "p_mo", name: "Mo Member" },
  ];

  it("reads @Name as the picker inserts it, any case, each person once", () => {
    expect(mentionHandle("Dana Lee")).toBe("DanaLee");
    expect(personMentions("@DanaLee and @momember, over to @DanaLee.", people)).toEqual([
      "p_dana",
      "p_mo",
    ]);
  });

  it("never inside an email address, a longer name, or an AI teammate", () => {
    expect(personMentions("mail dana@DanaLee.test", people)).toEqual([]);
    expect(personMentions("@DanaLeeX @Agent @Seshat", people)).toEqual([]);
  });
});
