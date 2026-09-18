import type { GateResult } from "@sekhemet/gates";
import { describe, expect, it } from "vitest";
import { WorkingMemory } from "../src/working_memory.js";

const result = (...excerpts: string[]): GateResult => ({
  passed: excerpts.length === 0,
  durationMs: 1,
  failures: excerpts.map((errorExcerpt) => ({
    rung: "typecheck",
    gate: "typecheck",
    exitCode: 2,
    errorExcerpt,
    suggestedFixFiles: [],
  })),
});

describe("@sekhemet/loop working memory", () => {
  it("records a fix that did not work and an error that was fixed", () => {
    const m = new WorkingMemory();
    m.observe(result("src/l.ts:10:5 TS2339: no 'run'", "src/l.ts:20:1 TS2741: missing timestamp"));
    expect(m.lines()).toEqual([]);

    m.noteWrite("src/l.ts");
    // The line moved (10 -> 12) but it is the same error; the other was fixed.
    m.observe(result("src/l.ts:12:5 TS2339: no 'run'"));
    expect(m.lines()).toEqual([
      "still failing after 1 edit to src/l.ts: src/l.ts:12:5 TS2339: no 'run'. That approach is not working: change strategy, do not repeat it.",
      "fixed: src/l.ts:20:1 TS2741: missing timestamp (do not reintroduce)",
    ]);
  });

  it("does not count a re-check without an edit as a failed approach", () => {
    const m = new WorkingMemory();
    m.observe(result("a TS1"));
    m.observe(result("a TS1"));
    expect(m.lines()).toEqual([]);
  });
});
