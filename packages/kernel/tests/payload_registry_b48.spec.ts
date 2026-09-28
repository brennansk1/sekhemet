import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.8 (planner-pm PM-P6-13; review-git RG-P8-13, -14): the role
// evaluations' records are registered events, structural only — hashes,
// versions, model ids, counts and the rubric's own item names. A reply's
// text and a send-back's words stay in the result file and the dossier.

const SHA = "e".repeat(64);

describe("the role evaluations' events", () => {
  it("are registered", () => {
    for (const type of [
      "measure/seshat_evaluated",
      "measure/reviewer_seeded",
      "measure/send_backs_caught",
    ])
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
  });

  it("accept a scripted conversation run and refuse free text in it", () => {
    const run = {
      assetHash: SHA,
      assetVersion: "1",
      skillVersion: "seshat-senior-pm/1+0123456789ab",
      model: "pm-model",
      runs: [{ run: 1, met: 19, total: 20 }],
      items: [{ run: 1, id: "standup", met: false, failed: ["voice"] }],
      passes: true,
      partial: false,
    };
    expect(() => checkEventPayload("measure/seshat_evaluated", run, undefined)).not.toThrow();
    expect(() =>
      checkEventPayload(
        "measure/seshat_evaluated",
        { ...run, reply: "Great question!" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("accept the seeded-defect run and bound its recall to a share", () => {
    const run = {
      assetHash: SHA,
      assetVersion: "1",
      model: "review-model",
      items: 22,
      caught: 8,
      recall: 8 / 22,
      perItem: [{ id: "onyx-vault-project-case", caught: true, falsePositives: 0 }],
      passes: true,
      partial: false,
    };
    expect(() => checkEventPayload("measure/reviewer_seeded", run, undefined)).not.toThrow();
    expect(() =>
      checkEventPayload("measure/reviewer_seeded", { ...run, recall: 1.5 }, undefined),
    ).toThrow(/recall/);
  });

  it("accept the send-back share with its verdict only", () => {
    const share = { total: 6, caught: 2, unanchored: 1, share: 2 / 6, verdict: "meets" };
    expect(() => checkEventPayload("measure/send_backs_caught", share, undefined)).not.toThrow();
    expect(() =>
      checkEventPayload("measure/send_backs_caught", { ...share, verdict: "adopted" }, undefined),
    ).toThrow(/verdict/);
  });
});
