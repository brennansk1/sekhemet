import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// Close-out C3 (teams item 28, DB-N9-2; design-stage §2.9 item 7): a
// release's lead, named by a person, and a message in a sent plan's thread
// between its approver and the person who sent it. The lead is structural (a
// release, a project, a principal); a message's words are free text, kept in
// the erasable private part.

describe("a release's lead", () => {
  it("is registered", () => {
    expect(PAYLOAD_SCHEMAS["release/lead_set"]).toBeDefined();
  });

  it("names a person on a named release; without one the lead is cleared", () => {
    expect(() =>
      checkEventPayload(
        "release/lead_set",
        { sliceId: "SLICE-1", projectId: "proj_1", lead: "p_mo" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("release/lead_set", { sliceId: "SLICE-1", projectId: "proj_1" }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "release/lead_set",
        { sliceId: "SLICE-1", projectId: "proj_1", lead: "Mo Member" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    expect(() => checkEventPayload("release/lead_set", { lead: "p_mo" }, undefined)).toThrow(
      /fails its schema/,
    );
  });
});

describe("a message in a sent plan's thread", () => {
  it("is registered", () => {
    expect(PAYLOAD_SCHEMAS["plan/commented"]).toBeDefined();
  });

  it("keeps its words private, never in the hashed payload", () => {
    expect(() =>
      checkEventPayload(
        "plan/commented",
        { proposalId: "prop_1", id: "pcm_1" },
        { text: "Why is search in the first release?" },
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "plan/commented",
        { proposalId: "prop_1", id: "pcm_1", text: "Why is search in the first release?" },
        undefined,
      ),
    ).toThrow();
    expect(() => checkEventPayload("plan/commented", { id: "pcm_1" }, { text: "?" })).toThrow(
      /fails its schema/,
    );
  });
});
