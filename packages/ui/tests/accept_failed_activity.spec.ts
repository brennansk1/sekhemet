import { describe, expect, it } from "vitest";
import { activityItems } from "../src/issue.js";
import { eventSentence } from "../src/vocabulary.js";

/**
 * Loop wave 10 A1 (sweep 5, review-git RG-S5-4, RG-N8-1): an Accept that
 * conflicts is on the issue's Activity log by default, saying why in the
 * board's words — the files and the integration branch — and that nothing
 * moved, never the raw "issue accept failed".
 */
const conflict = {
  seq: 7,
  type: "card/accept_failed",
  actor: "human",
  cardId: "card_cf2",
  createdAt: "2026-10-12T00:00:00.000Z",
  payload: {
    id: "card_cf2",
    reason: "conflict",
    integration: "main",
    files: ["src/shared.ts"],
  },
};

describe("a failed Accept on the Activity log (loop wave 10 A1)", () => {
  it("RG-S5-4: a conflict names the files and the integration branch, and that the issue stays In review", () => {
    expect(eventSentence(conflict)).toMatchObject({
      actor: "You",
      verb: "could not accept",
      rest: "· it conflicts with main in src/shared.ts; nothing was written and it stays In review",
      tone: "fail",
    });
  });

  it("RG-N8-1: shown in the brief Activity log, not only under every entry", () => {
    const items = activityItems({
      cardId: "card_cf2",
      events: [conflict],
      messages: [],
      decisions: [],
    });
    expect(items.map((i) => [i.who, i.text, i.tone])).toEqual([
      [
        "You",
        "could not accept · it conflicts with main in src/shared.ts; nothing was written and it stays In review",
        "fail",
      ],
    ]);
  });

  it("RG-N8-1: a refused or crashed Accept says nothing moved, without a reason it does not have", () => {
    const refused = { ...conflict, payload: { id: "card_cf2", reason: "refused" } };
    expect(eventSentence(refused)).toMatchObject({
      verb: "could not accept",
      rest: "· nothing was written and it stays In review",
      tone: "fail",
    });
    const missing = {
      ...conflict,
      actor: "harness",
      payload: { id: "card_cf2", reason: "merge_missing" },
    };
    expect(eventSentence(missing).rest).toBe(
      "· its merge never reached the integration branch; it stays In review",
    );
  });
});
