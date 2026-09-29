import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, checkEventPayload } from "../src/payload_registry.js";

// B4.11 T6 (teams NEW-teams-11, TEAM-28; dashboard DB-N9-3): a project's
// health, set by a person, and a release's target date, set by a person.
// Both structural: the project, the release, one of three words, a day.

describe("health and a release's target date", () => {
  it("are registered", () => {
    for (const type of ["project/health_set", "release/target_set"])
      expect(PAYLOAD_SCHEMAS[type]).toBeDefined();
  });

  it("health is one of the three words, on a named project", () => {
    for (const health of ["on_track", "at_risk", "off_track"])
      expect(() =>
        checkEventPayload("project/health_set", { project: "proj_1", health }, undefined),
      ).not.toThrow();
    expect(() =>
      checkEventPayload("project/health_set", { project: "proj_1", health: "fine" }, undefined),
    ).toThrow(/fails its schema/);
    expect(() => checkEventPayload("project/health_set", { health: "at_risk" }, undefined)).toThrow(
      /fails its schema/,
    );
  });

  it("a target is a day on a named release; without one the target is cleared", () => {
    expect(() =>
      checkEventPayload(
        "release/target_set",
        { sliceId: "SLICE-1", projectId: "proj_1", target: "2026-10-30" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "release/target_set",
        { sliceId: "SLICE-1", projectId: "proj_1" },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "release/target_set",
        { sliceId: "SLICE-1", projectId: "proj_1", target: "next Friday" },
        undefined,
      ),
    ).toThrow(/fails its schema/);
  });
});
