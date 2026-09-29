import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.11 (teams NEW-teams-5, TEAM-15, -39, -40): a comment on an issue and a
// Stakeholder's or Viewer's request to start the Agent are registered
// events. Their words — the comment, what the person asked — are personal
// free text: private, never in the hashed payload (teams §3, O14).

describe("the AI teammates' events", () => {
  it("are registered", () => {
    for (const type of ["issue/commented", "agent/start_requested", "agent/start_answered"])
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
  });

  it("keep a message to Seshat private, so an @Seshat comment's text is erasable (T1/T5)", () => {
    const payload = { id: "pmm_1", createdAt: "2026-09-28T00:00:00Z", context: { cardId: "c1" } };
    expect(() => checkEventPayload("pm/message", payload, { text: "@Seshat why?" })).not.toThrow();
    expect(() =>
      checkEventPayload("pm/message", { ...payload, text: "in the payload" }, undefined),
    ).toThrow(/private part/);
  });

  it("keep a comment's text private and name the AI teammates it mentions", () => {
    const payload = { id: "cmt_1", cardId: "c1", ai: ["agent", "seshat"] };
    expect(() =>
      checkEventPayload("issue/commented", payload, { text: "@Agent please start" }),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("issue/commented", { ...payload, text: "in the payload" }, undefined),
    ).toThrow();
    expect(() =>
      checkEventPayload("issue/commented", { ...payload, ai: ["someone"] }, undefined),
    ).toThrow(/fails its schema/);
  });

  it("name who asked the Agent and whom the request waits on, never what they asked", () => {
    const payload = { id: "asr_1", cardId: "c1", requested_by: "p_dana", to: "p_owen" };
    expect(() =>
      checkEventPayload("agent/start_requested", payload, { ask: "@Agent fix the login" }),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("agent/start_requested", { ...payload, requested_by: "Dana" }, undefined),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload("agent/start_answered", { id: "asr_1", answer: "started" }, undefined),
    ).not.toThrow();
    expect(() =>
      checkEventPayload("agent/start_answered", { id: "asr_1", answer: "maybe" }, undefined),
    ).toThrow(/fails its schema/);
  });
});
