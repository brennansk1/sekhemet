import { describe, expect, it } from "vitest";
import { flowEmptyState, flowFinished, flowUrl } from "../src/pm.js";
import { type StatusFacts, statusModel } from "../src/status.js";

/**
 * Wave 2 A3 (dashboard §2.10 item 6, DB-N9-8): Insights and Status count
 * finished issues as Status's key numbers and Projects do — every issue
 * moved to Done in the period — never the cycle-time samples, which only an
 * issue built through In progress here has (an imported or seeded Done card
 * has none). When the finished count is enough but the samples are not, the
 * words say which is missing.
 */
describe("A3: one count of finished issues", () => {
  it("Insights: under 3 finished, the empty state counts the period's finished issues", () => {
    // One issue moved to Done (throughput 1), with no cycle-time sample.
    expect(flowEmptyState(1, 0)).toEqual({
      heading: "Not enough finished issues to measure flow yet.",
      detail: "Insights need at least 3 finished issues; this period has 1.",
    });
  });

  it("Insights: enough finished issues but too few built here names the cycle times as missing", () => {
    expect(flowEmptyState(5, 1)).toEqual({
      heading: "Not enough cycle times to measure flow yet.",
      detail:
        "5 issues finished in this period, but only 1 went through In progress here; cycle time needs at least 3.",
    });
    expect(flowEmptyState(5, 3)).toBeNull();
  });

  // Review finding 4: one count from one source. The server's `finished`
  // (Status's rule and scope) wins over the throughput's sum of moves, which
  // counts a re-accepted issue twice, a done epic and other projects.
  it("Insights reads the server's finished count, on the page's project", () => {
    const throughput = [
      { date: "2026-10-10", done: 2 },
      { date: "2026-10-11", done: 1 },
    ];
    expect(flowFinished({ finished: 2, throughput })).toBe(2);
    expect(flowFinished({ finished: 0, throughput })).toBe(0);
    // A server without it (read-only): the moves are all there is.
    expect(flowFinished({ throughput })).toBe(3);
    expect(flowUrl(30, "proj 1")).toBe("/api/metrics/flow?days=30&project=proj%201");
    expect(flowUrl(7, undefined)).toBe("/api/metrics/flow?days=7");
  });

  it("Status's flow note counts finished issues the same way", () => {
    const facts = (finished: number, cycleHours: number[]) =>
      ({
        setup: "solo",
        isLead: true,
        flow: { days: 30, cycleHours, finished, sentBack: 0, firstTime: { passed: 0, total: 0 } },
      }) as unknown as StatusFacts;
    const note = (finished: number, hours: number[]) =>
      statusModel({
        now: Date.parse("2026-10-11T12:00:00Z"),
        facts: facts(finished, hours),
        cards: [],
      }).flow.note;
    expect(note(1, [])).toBe("Cycle time and throughput need 3 finished issues; there is 1.");
    expect(note(5, [2])).toBe(
      "Cycle time needs 3 issues built through In progress; 1 of the 5 finished was.",
    );
    expect(note(5, [1, 2, 3])).toBeUndefined();
  });
});
