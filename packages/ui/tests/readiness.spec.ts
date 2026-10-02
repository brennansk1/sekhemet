import { describe, expect, it } from "vitest";
import { definitionOfDone, readyToStart } from "../src/readiness.js";

/**
 * dashboard NEW-dashboard-14 (DB-N14-1, DB-N14-2; FINDINGS PRC-12,
 * DESIGN_GAPS b19): the Definition of done and *Ready to start* in plain
 * words, for a team and a junior to read — what is enforced, and nothing new.
 */
describe("the Definition of done (DB-N14-1)", () => {
  it("says, from gates.toml, the depth profile and the Accept rule, when an issue is done", () => {
    const v = definitionOfDone({
      checks: [
        { id: "types", blocking: true },
        { id: "test", blocking: true },
        { id: "lint", blocking: true },
        { id: "size", blocking: true },
        { id: "audit", blocking: false },
      ],
      profile: "internal tool",
      setup: "team",
      accepters: ["Nora Okafor", "Lee Park"],
    });
    expect(v.sentence).toBe(
      "An issue is done when its checks pass — Types, Tests, Lint, Size — its tests meet the strength rule, and a person the Accept rule names accepts it.",
    );
    expect(v.rows).toEqual([
      {
        label: "Checks that must pass",
        text: "Types, Tests, Lint, Size. Advisory, reported but not blocking: Audit.",
      },
      {
        label: "Test strength",
        text: "A test that could not fail does not count: weak tests block the issue (the project's Type: internal tool).",
      },
      {
        label: "Who approves what is built",
        text: "A person approves each issue's acceptance criteria before it is built.",
      },
      {
        label: "Who accepts",
        text: "Nora Okafor or Lee Park, as the project's Accept rule names.",
      },
    ]);
  });

  it("Solo and a prototype say so", () => {
    const v = definitionOfDone({
      checks: [{ id: "test", blocking: true }],
      profile: "prototype",
      setup: "solo",
      accepters: null,
    });
    expect(v.sentence).toBe(
      "An issue is done when its checks pass — Tests — its tests meet the strength rule, and you accept it.",
    );
    expect(v.rows[1]?.text).toBe(
      "Weak tests are reported, not blocked (the project's Type: prototype). A failing test always blocks.",
    );
    expect(v.rows[3]).toEqual({ label: "Who accepts", text: "You." });
  });
});

describe("Ready to start (DB-N14-2)", () => {
  it("names each condition, met or not, with its reason", () => {
    expect(
      readyToStart([
        { id: "dependencies", met: true },
        { id: "approval", met: false, reason: "No one has approved its acceptance criteria yet." },
        { id: "scope", met: false, reason: "It declares no files it may change." },
      ]),
    ).toEqual({
      summary: "1 of 3 met",
      ready: false,
      rows: [
        { label: "Every issue it depends on is done", met: true, state: "Met", reason: "" },
        {
          label: "Its acceptance criteria are approved",
          met: false,
          state: "Not met",
          reason: "No one has approved its acceptance criteria yet.",
        },
        {
          label: "The files it may change are declared",
          met: false,
          state: "Not met",
          reason: "It declares no files it may change.",
        },
      ],
    });
  });
});
