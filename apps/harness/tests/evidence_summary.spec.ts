import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { evidenceSummary } from "../src/evidence_summary.js";
import { prBody } from "../src/wave2_github.js";

/** review-git §2.5.7, RG-S5-18: the pull request's body is the evidence summary. */
describe("the evidence summary (RG-S5-18)", () => {
  const card = {
    id: "c1",
    title: "Round totals",
    spec: "Round the invoice total to cents.",
    acceptanceCriteria: ["totals are rounded half-even"],
  } as unknown as CardRecord;
  const ev = {
    rungResults: [
      { gate: "typecheck", passed: true, durationMs: 812 },
      { gate: "unit", passed: true, durationMs: 1430 },
      { gate: "visual", passed: false, skipped: true },
    ],
    filesTouched: ["src/total.ts", "tests/total.test.ts"],
    linesAdded: 24,
    linesRemoved: 3,
    diff: [
      "diff --git a/src/total.ts b/src/total.ts",
      "--- a/src/total.ts",
      "+++ b/src/total.ts",
      "@@ -1 +1 @@",
      "diff --git a/tests/total.test.ts b/tests/total.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/tests/total.test.ts",
      "@@ -0,0 +1 @@",
    ].join("\n"),
    screenshots: [".sekhemet/evidence/visual/c1/total.png"],
  };

  it("carries the gates with durations, tests added, diff stats, abandoned attempts and screenshots", () => {
    const body = evidenceSummary(card, ev, [{ attempt: 1, stopReason: "repair_exhausted" }]);
    expect(body).toContain("Round the invoice total to cents.");
    expect(body).toContain("- totals are rounded half-even");
    expect(body).toContain("- pass typecheck (812 ms)");
    expect(body).toContain("- pass unit (1430 ms)");
    expect(body).toContain("- skipped visual");
    expect(body).toMatch(/### Tests added\n- tests\/total\.test\.ts/);
    expect(body).not.toMatch(/### Tests added\n[^#]*src\/total\.ts/);
    expect(body).toContain("2 file(s), +24 −3");
    expect(body).toContain("- attempt 1: repair_exhausted");
    expect(body).toContain("[total.png](.sekhemet/evidence/visual/c1/total.png)");
  });

  it("is the pull request's body on the App path too, with nothing invented when there is no evidence", () => {
    expect(prBody(card, ev)).toContain("- pass unit (1430 ms)");
    const bare = prBody(card, undefined);
    expect(bare).toContain("_No gate results were recorded._");
    expect(bare).not.toContain("pass");
  });
});
