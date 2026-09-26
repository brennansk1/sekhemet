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

  it("starts a retry with what the earlier attempt learned, and records struggles", () => {
    const m = new WorkingMemory();
    m.seed([
      "still failing after 3 edits to src/l.ts: TS2339 no 'run'. That approach is not working",
    ]);
    expect(m.lines()[0]).toMatch(/^from an earlier attempt: still failing after 3 edits/);

    m.observe(result("src/l.ts:5:1 TS2741: missing timestamp"));
    m.noteWrite("src/l.ts");
    m.observe(result("src/l.ts:5:1 TS2741: missing timestamp"));
    m.noteWrite("src/l.ts");
    m.observe(result());
    expect(m.getStruggles()).toEqual([
      { text: "src/l.ts:5:1 TS2741: missing timestamp", edits: 1 },
    ]);
  });
});

describe("CX-N3-6: a long dossier seeding the working memory keeps Seshat's answer", () => {
  it("keeps the last line of a dossier over six lines, and prefixes a carried line once, never nested", () => {
    const m = new WorkingMemory();
    const dossier = [
      "tried A",
      "tried B",
      "from an earlier attempt: tried C",
      "tried D",
      "tried E",
      "tried F",
      "tried G",
      "Seshat: the column is named created_at, not createdAt.",
    ];
    m.seed(dossier);
    const lines = m.lines();
    expect(lines).toContain(
      "from an earlier attempt: Seshat: the column is named created_at, not createdAt.",
    );
    expect(lines.filter((l) => l.includes("from an earlier attempt: from an earlier"))).toEqual([]);
    expect(lines).toContain("from an earlier attempt: tried C");
    expect(lines.filter((l) => l.startsWith("from an earlier attempt:"))).toHaveLength(6);
  });
});
