import { describe, expect, it } from "vitest";
// The browser module, imported as the page runs it.
import { dropIndex, neighboursFor } from "../web/reorder_logic.js";

describe("drag-to-reorder neighbours (B11)", () => {
  const ids = ["a", "b", "c", "d"];
  it("names the new neighbours for a move up, a move down and the ends", () => {
    expect(neighboursFor(ids, "c", 1)).toEqual({ afterCardId: "a", beforeCardId: "b" });
    expect(neighboursFor(ids, "a", 3)).toEqual({ afterCardId: "c", beforeCardId: "d" });
    expect(neighboursFor(ids, "d", 0)).toEqual({ beforeCardId: "a" });
    expect(neighboursFor(ids, "a", 4)).toEqual({ afterCardId: "d" });
  });
  it("is a no-op for a drop onto the card's own slot", () => {
    expect(neighboursFor(ids, "b", 1)).toBeNull();
    expect(neighboursFor(ids, "b", 2)).toBeNull();
    expect(neighboursFor(ids, "x", 0)).toBeNull();
  });
  it("finds the slot from tile midpoints", () => {
    expect(dropIndex([10, 30, 50], 5)).toBe(0);
    expect(dropIndex([10, 30, 50], 35)).toBe(2);
    expect(dropIndex([10, 30, 50], 99)).toBe(3);
  });
});
