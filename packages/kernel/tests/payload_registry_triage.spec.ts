import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// C2b (dashboard NEW-dashboard-10, DB-N10-3): a Member's triage decision on
// an untriaged Backlog issue. The decision, the duplicate's id and the snooze
// time are structural; a Decline's reason is the person's words, private and
// erasable (kernel rule 33).

describe("a triage decision", () => {
  it("is registered", () => {
    expect(PAYLOAD_SCHEMAS["issue/triaged"]).toBeDefined();
  });

  it("names the issue and one of the four decisions", () => {
    for (const decision of ["accept", "decline", "duplicate", "snooze"]) {
      expect(() =>
        checkEventPayload("issue/triaged", { cardId: "card_a", decision }, undefined),
      ).not.toThrow();
    }
    expect(() =>
      checkEventPayload("issue/triaged", { cardId: "card_a", decision: "accepted" }, undefined),
    ).toThrow(/fails its schema/);
  });

  it("a duplicate names its issue and a snooze its time", () => {
    expect(() =>
      checkEventPayload(
        "issue/triaged",
        { cardId: "card_a", decision: "duplicate", duplicateOf: "card_b" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "issue/triaged",
        { cardId: "card_a", decision: "snooze", until: "2026-10-03T09:00:00.000Z" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "issue/triaged",
        { cardId: "card_a", decision: "snooze", until: "tomorrow" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("keeps a Decline's reason out of the hashed payload", () => {
    expect(() =>
      checkEventPayload(
        "issue/triaged",
        { cardId: "card_a", decision: "decline", reason: "Out of scope" },
        undefined,
      ),
    ).toThrow(/reason/);
    expect(() =>
      checkEventPayload(
        "issue/triaged",
        { cardId: "card_a", decision: "decline" },
        { reason: "Out of scope" },
      ),
    ).not.toThrow();
  });
});
