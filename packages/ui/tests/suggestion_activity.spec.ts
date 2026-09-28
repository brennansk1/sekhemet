import { describe, expect, it } from "vitest";
import { activityItems } from "../src/issue.js";

// planner-pm PM-N9-2, teams TEAM-41: the issue's Activity says when an
// Admin's rule applied Seshat's suggestion and when a person undid it, in
// plain words, with the property and never the suggestion's id.

describe("Activity: suggestions applied by a rule, and undone", () => {
  it("names the rule's change, a person's apply, dismiss and undo", () => {
    const events = [
      {
        seq: 1,
        type: "suggestion/applied",
        actor: "system",
        cardId: "card_a",
        payload: { id: "sug_1", auto: true, kind: "priority", before: { priority: 0 } },
        createdAt: "2026-09-28T10:00:00Z",
      },
      {
        seq: 2,
        type: "suggestion/undone",
        actor: "human",
        cardId: "card_a",
        payload: { id: "sug_1", kind: "priority" },
        createdAt: "2026-09-28T10:05:00Z",
      },
      {
        seq: 3,
        type: "suggestion/applied",
        actor: "human",
        cardId: "card_a",
        payload: { id: "sug_2", auto: false, kind: "label" },
        createdAt: "2026-09-28T10:06:00Z",
      },
      {
        seq: 4,
        type: "suggestion/dismissed",
        actor: "human",
        cardId: "card_a",
        payload: { id: "sug_3" },
        createdAt: "2026-09-28T10:07:00Z",
      },
    ];
    const items = activityItems({ cardId: "card_a", events, messages: [], decisions: [] });
    expect(items.map((i) => [i.who, i.ai, i.text])).toEqual([
      ["Seshat", true, "applied its priority suggestion under an Admin's auto-apply rule"],
      ["You", false, "undid Seshat's priority change"],
      ["You", false, "applied Seshat's labels suggestion"],
      ["You", false, "dismissed a suggestion from Seshat"],
    ]);
    expect(JSON.stringify(items)).not.toMatch(/sug_/);
  });
});
