import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// C2b (planner-pm NEW-planner-pm-11, -12; review-git NEW-review-git-7):
// a maintenance release is proposed with no slice and the accepted issues it
// holds, and tagged with no slice; each push to the project's remote is
// recorded with its ref, sha, remote and result, its reason private; a
// posted retrospective names its project, sprint and window, its text
// private; and the push setting is a project setting.

const SHA = "a".repeat(40);

describe("a maintenance release", () => {
  it("is proposed with no slice, the issues it holds and the sha it is computed at", () => {
    expect(() =>
      checkEventPayload(
        "release/proposed",
        {
          projectId: "proj_a",
          version: "1.2.4",
          requirementIds: [],
          issues: ["card_a", "card_b"],
          sha: SHA,
        },
        { changelog: { Fixed: ["login no longer fails (abc1234)"] }, notes: "Fixed\n- Login" },
      ),
    ).not.toThrow();
    // A slice's release is unchanged.
    expect(() =>
      checkEventPayload(
        "release/proposed",
        { sliceId: "SLICE-1", projectId: "proj_a", version: "0.1.0", requirementIds: ["REQ-1"] },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "release/proposed",
        { projectId: "proj_a", version: "1.2.4", requirementIds: [], issues: [""] },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });

  it("is tagged with no slice", () => {
    expect(() =>
      checkEventPayload(
        "release/tagged",
        { projectId: "proj_a", tag: "v1.2.4", sha: SHA, proven: SHA },
        undefined,
      ),
    ).not.toThrow();
  });
});

describe("remote/pushed (RG-N7-4)", () => {
  it("is registered with the ref, the sha, the remote and the result; the reason is private", () => {
    expect(PAYLOAD_SCHEMAS["remote/pushed"]).toBeDefined();
    for (const result of ["pushed", "refused", "not_allowed"]) {
      expect(() =>
        checkEventPayload(
          "remote/pushed",
          { project: "proj_a", ref: "refs/heads/main", sha: SHA, remote: "origin", result },
          result === "pushed" ? undefined : { reason: "the remote holds commits main lacks" },
        ),
      ).not.toThrow();
    }
    expect(() =>
      checkEventPayload(
        "remote/pushed",
        {
          project: "proj_a",
          ref: "refs/heads/main",
          sha: SHA,
          remote: "origin",
          result: "refused",
          code: "behind",
        },
        { reason: "rejected (fetch first)" },
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "remote/pushed",
        {
          project: "proj_a",
          ref: "refs/heads/main",
          sha: SHA,
          remote: "origin",
          result: "refused",
          code: "the remote said no",
        },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload(
        "remote/pushed",
        {
          project: "proj_a",
          ref: "refs/tags/v1.0.0",
          sha: SHA,
          remote: "origin",
          result: "forced",
        },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    expect(() =>
      checkEventPayload(
        "remote/pushed",
        { project: "proj_a", ref: "main", sha: SHA, remote: "origin", result: "pushed" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
    // The reason is free text: never in the payload.
    expect(() =>
      checkEventPayload(
        "remote/pushed",
        {
          project: "proj_a",
          ref: "refs/heads/main",
          sha: SHA,
          remote: "origin",
          result: "refused",
          reason: "x",
        },
        undefined,
      ),
    ).toThrow(/private part/);
  });
});

describe("retrospective/posted (PM-N11-3)", () => {
  it("names the project, the sprint when there was one and the window; the text is private", () => {
    expect(PAYLOAD_SCHEMAS["retrospective/posted"]).toBeDefined();
    const at = "2026-10-02T09:00:00.000Z";
    expect(() =>
      checkEventPayload(
        "retrospective/posted",
        { id: "retro_1", project: "proj_a", sprint: "cycle_1", from: at, to: at },
        { text: "What went well…" },
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "retrospective/posted",
        { id: "retro_2", project: "proj_a", from: at, to: at },
        { text: "Kanban" },
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "retrospective/posted",
        { id: "retro_3", project: "proj_a", from: at, to: at, text: "in the payload" },
        undefined,
      ),
    ).toThrow(/private part/);
  });
});

describe("project/settings_changed: push_to_remote (RG-N7-5)", () => {
  it("records the push setting on or off", () => {
    expect(() =>
      checkEventPayload(
        "project/settings_changed",
        { project: "proj_a", push_to_remote: true },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "project/settings_changed",
        { project: "proj_a", push_to_remote: "yes" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });
});
