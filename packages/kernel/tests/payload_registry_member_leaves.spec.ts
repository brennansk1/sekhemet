import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// C2b (teams item 9a, NEW-teams-13, TEAM-52): what a member's removal
// settled, and an assignment to a member who left, are on the ledger with
// structural fields only — principals, issue ids and project ids, never a
// name, an email or free text.

describe("a member's removal settled, and a refused assignment", () => {
  it("are registered", () => {
    expect(PAYLOAD_SCHEMAS["member/removal_settled"]).toBeDefined();
    expect(PAYLOAD_SCHEMAS["member/assignment_refused"]).toBeDefined();
  });

  it("the settlement names the person and the ids of what was listed, paused, held and emptied", () => {
    expect(() =>
      checkEventPayload(
        "member/removal_settled",
        {
          principal: "p_lee",
          owns: ["card_a"],
          leads: ["proj_c"],
          releases: [],
          acceptSeats: ["proj_c", "proj_a"],
          paused: ["card_b"],
          held: ["card_c"],
          emptiedRules: ["proj_c"],
        },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("member/removal_settled", { principal: "Lee Lead" }, undefined),
    ).toThrow(/fails its schema/);
  });

  it("a refused assignment names the person and the issue", () => {
    expect(() =>
      checkEventPayload(
        "member/assignment_refused",
        { principal: "p_lee", cardId: "card_a" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("member/assignment_refused", { principal: "p_lee" }, undefined),
    ).toThrow(/fails its schema/);
  });
});
