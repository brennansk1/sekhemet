import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// C2b (planner-pm §2.7 item 7a, PM-N13-1, -2; dashboard NEW-dashboard-11):
// a sprint's start names the issues committed to it, and their points when
// estimation is on; its completion names the done issues and where each
// carried issue went — a sprint id, or `backlog`. Every field is structural.

describe("a sprint's start and completion", () => {
  it("are registered", () => {
    expect(PAYLOAD_SCHEMAS["cycle/started"]).toBeDefined();
    expect(PAYLOAD_SCHEMAS["cycle/completed"]).toBeDefined();
  });

  it("a start names the sprint and its committed issues, with points optional", () => {
    expect(() =>
      checkEventPayload(
        "cycle/started",
        { id: "cycle_1", issues: ["card_a", "card_b"] },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "cycle/started",
        { id: "cycle_1", issues: ["card_a"], points: { card_a: 3 } },
        undefined,
      ),
    ).not.toThrow();
    expect(() => checkEventPayload("cycle/started", { id: "cycle_1" }, undefined)).toThrow(
      /fails its schema/,
    );
    expect(() =>
      checkEventPayload(
        "cycle/started",
        { id: "cycle_1", issues: ["card_a"], points: { card_a: -1 } },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("a completion names the done issues and each carried issue's destination", () => {
    expect(() =>
      checkEventPayload(
        "cycle/completed",
        {
          id: "cycle_1",
          done: ["card_a"],
          carried: [
            { issue: "card_b", to: "cycle_2" },
            { issue: "card_c", to: "backlog" },
          ],
        },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "cycle/completed",
        { id: "cycle_1", done: [], carried: [{ issue: "card_b" }] },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload("cycle/completed", { id: "cycle_1", done: [] }, undefined),
    ).toThrow(/fails its schema/);
  });
});
