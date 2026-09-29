import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.11 (teams NEW-teams-7, TEAM-21, -22, -23, -43; §3 events): watching an
// issue, the people a comment mentions, the author's answer to a mention of
// someone who cannot see the project, the Inbox's read, done, snoozed and
// saved marks, and the notices a watcher gets. All structural: issues,
// people by opaque principal, sequence numbers and times; no free text.

describe("the Inbox's and the watch toggle's events", () => {
  it("are registered", () => {
    for (const type of [
      "issue/watched",
      "issue/unwatched",
      "issue/mention_answered",
      "inbox/read",
      "inbox/done",
      "inbox/snoozed",
      "inbox/saved",
    ])
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
  });

  it("a watch names the issue", () => {
    expect(() => checkEventPayload("issue/watched", { cardId: "card_1" }, undefined)).not.toThrow();
    expect(() => checkEventPayload("issue/unwatched", {}, undefined)).toThrow(/fails its schema/);
  });

  it("a comment names the people it mentions, and those held back, by principal", () => {
    expect(() =>
      checkEventPayload(
        "issue/commented",
        { id: "cmt_1", cardId: "card_1", people: ["p_dana"], held: ["p_rae"] },
        { text: "@DanaLee @RaeRemoved look" },
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "issue/commented",
        { id: "cmt_1", cardId: "card_1", people: ["Dana Lee"] },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("the author's answer is invite or skip", () => {
    expect(() =>
      checkEventPayload(
        "issue/mention_answered",
        { id: "cmt_1", cardId: "card_1", answer: "invite" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "issue/mention_answered",
        { id: "cmt_1", cardId: "card_1", answer: "maybe" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("read, done, snoozed and saved name the item and how far they reach", () => {
    expect(() =>
      checkEventPayload("inbox/read", { item: "issue:card_1", seq: 12 }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("inbox/done", { item: "issue:card_1", seq: 12 }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("inbox/done", { item: "issue:card_1", seq: 12, undo: true }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "inbox/snoozed",
        { item: "asr_1", seq: 3, until: "2026-09-29T09:00:00.000Z" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("inbox/snoozed", { item: "asr_1", seq: 3, until: "tomorrow" }, undefined),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload("inbox/saved", { item: "issue:card_1", saved: true }, undefined),
    ).not.toThrow();
    expect(() => checkEventPayload("inbox/read", { item: "x", seq: -1 }, undefined)).toThrow(
      /fails its schema/,
    );
  });

  it("a watcher's notices, a posted update and the digest are notice kinds (TEAM-43)", () => {
    for (const kind of ["watching", "mentioned", "project_update", "digest"]) {
      expect(() =>
        checkEventPayload(
          "pm/notice_held",
          { kind, to: "p_dana", notice: "evt_1", day: "2026-09-28" },
          undefined,
        ),
      ).not.toThrow();
    }
  });
});
