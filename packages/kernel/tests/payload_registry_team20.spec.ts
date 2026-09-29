import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.11 (teams NEW-teams-6, TEAM-20, TEAM-42; §3 events): a Stakeholder's
// plan sent to a named approver, and its approval, are registered events.
// Both are structural: the proposal, the approver (an opaque principal) and
// Review plan's choices (candidate keys, the release line, the Type, the
// questions' answer indexes); no free text.

describe("a stakeholder plan's approval events", () => {
  it("are registered", () => {
    for (const type of ["plan/sent_for_approval", "plan/approved"])
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
  });

  it("name the approver by principal, with the choices sent", () => {
    expect(() =>
      checkEventPayload(
        "plan/sent_for_approval",
        {
          proposalId: "pmp_1",
          approver: "p_member",
          choices: { accept: ["c1"], releaseLine: 2, type: "prototype", answers: { "0": 1 } },
        },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "plan/sent_for_approval",
        { proposalId: "pmp_1", approver: "dana@example.com" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload(
        "plan/sent_for_approval",
        { proposalId: "pmp_1", approver: "p_member", choices: { note: "free text" } },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("record the approval with the project it created", () => {
    expect(() =>
      checkEventPayload("plan/approved", { proposalId: "pmp_1", projectId: "prj_1" }, undefined),
    ).not.toThrow();
    expect(() => checkEventPayload("plan/approved", {}, undefined)).toThrow(/fails its schema/);
  });
});
