import { describe, expect, it } from "vitest";
import {
  compactHistory,
  maskOlderObservations,
  retrieveMaskedObservation,
} from "../src/condenser.js";

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
    const ref = /\(EvidenceRef: (ev_[0-9a-f]+)\)/.exec(out[0]?.result ?? "")?.[1] ?? "";
    // Not a bracketed span a model could copy as a placeholder (CX-M1-12).
    expect(out[0]?.result).not.toMatch(/\[ref /);
    expect(retrieveMaskedObservation(ref)).toBe(turns[0]?.result);
  });

  it("CX-M1-5: masking leaves the compaction index visible, not folded into a pointer", () => {
    const { turns: out } = compactHistory(turns, 3);
    const masked = maskOlderObservations(out, 2);
    expect(masked[0]?.action).toBe("compacted history");
    expect(masked[0]?.result).toBe(out[0]?.result);
    const all = maskOlderObservations(out, 2, { maskAll: true });
    expect(all[0]?.result).toBe(out[0]?.result);
  });

  it("leaves short histories alone", () => {
    expect(compactHistory(turns.slice(0, 4), 3).compacted).toBe(0);
  });
});
