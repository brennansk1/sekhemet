import { describe, expect, it } from "vitest";
import { planReportLines } from "../src/wave2.js";

// Persona B's P2s (S1B-P2s, wave 1): the plan's report quotes each issue's
// title, so a title reads as a title, and a title two issues share is said
// as its own marker beside the title, not as words that seem part of it.
type PlanResult = Parameters<typeof planReportLines>[0];

const issue = (id: string, title: string) => ({
  id,
  title,
  points: 2,
  difficulty: 2,
  routing: "direct",
  estimate: { tokens: 1000, basis: { kind: "default" } },
  zone3Tokens: 100,
});

const result = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    source: "heuristic",
    version: 1,
    created: [
      issue("story_interface_4afe8954", "A CSV export of a week"),
      issue("story_path_dde4d5e8", "A CSV export of a week"),
    ],
    held: [
      { id: "story_interface_4afe8954", reasons: ["no example"] },
      { id: "story_path_dde4d5e8", reasons: ["no example"] },
    ],
    rejected: [],
    serialized: [],
    epics: [],
    proposedChanges: [],
    proposedSplits: [],
    modelRefusals: [],
    invest: { passed: true, checks: [] },
    ...over,
  }) as unknown as PlanResult;

describe("the plan's report quotes titles (S1B-P2s)", () => {
  it("quotes each issue's title, and says a shared title as its own marker", () => {
    const rows = planReportLines(result()).filter((l) => l.startsWith("  story_"));
    expect(rows).toEqual([
      '  story_interface_4afe8954  "A CSV export of a week"  · held in Planning',
      '  story_path_dde4d5e8       "A CSV export of a week"  · same title as story_interface_4afe8954  · held in Planning',
    ]);
  });

  it("quotes the titles of a rejected issue, an epic to re-split and a proposed change", () => {
    const lines = planReportLines(
      result({
        rejected: [{ title: "Export to PDF", reason: "traces to no accepted requirement" }],
        epics: [{ title: "Reports", mechanism: "report builder" }],
        proposedChanges: [{ title: "Rename the totals column", reason: "the header says Sum" }],
      }),
    );
    expect(lines).toContain('Rejected: "Export to PDF" — traces to no accepted requirement');
    expect(lines).toContain(
      'Re-split as an epic: "Reports" — a report builder is many issues, not one; plan it on its own.',
    );
    expect(lines).toContain(
      'Proposed change (not an issue): "Rename the totals column" — the header says Sum.',
    );
  });
});
