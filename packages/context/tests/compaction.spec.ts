import { describe, expect, it } from "vitest";
import { compactHistory, retrieveMaskedObservation } from "../src/condenser.js";

describe("@sekhemet/context auto-compaction", () => {
  const turns = Array.from({ length: 12 }, (_, i) => ({
    turn: i + 1,
    action: i % 2 ? "check" : "edit",
    result: `turn ${i + 1} output\nsrc/a.ts:${i}:1 TS2339 detail line`,
  }));

  it("folds older turns into one entry and keeps the recent ones verbatim", () => {
    const { turns: out, compacted } = compactHistory(turns, 3);
    expect(compacted).toBe(9);
    expect(out).toHaveLength(4);
    expect(out[0]?.action).toBe("compacted history");
    expect(out[0]?.result).toContain("Turns 1-9 compacted (9 turns)");
    expect(out.slice(1).map((t) => t.turn)).toEqual([10, 11, 12]);
  });

  it("is reversible: every compacted line carries a ref that recalls the full text", () => {
    const { turns: out } = compactHistory(turns, 3);
    const ref = /\[ref ([^\]]+)\]/.exec(out[0]?.result ?? "")?.[1] ?? "";
    expect(retrieveMaskedObservation(ref)).toBe(turns[0]?.result);
  });

  it("leaves short histories alone", () => {
    expect(compactHistory(turns.slice(0, 4), 3).compacted).toBe(0);
  });
});
