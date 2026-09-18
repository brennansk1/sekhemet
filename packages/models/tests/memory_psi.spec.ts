import { describe, expect, it } from "vitest";
import { psiPressureLevel } from "../src/memory.js";

describe("@sekhemet/models Linux memory pressure (PSI)", () => {
  it("maps stall shares onto the normal/warning/critical scale", () => {
    const psi = (some: number, full: number) =>
      `some avg10=${some} avg60=0.00 avg300=0.00 total=1\nfull avg10=${full} avg60=0.00 avg300=0.00 total=1\n`;
    expect(psiPressureLevel(psi(0.5, 0))).toBe(1);
    expect(psiPressureLevel(psi(15, 1))).toBe(2);
    expect(psiPressureLevel(psi(20, 6))).toBe(4);
    expect(psiPressureLevel(psi(45, 0))).toBe(4);
    expect(psiPressureLevel("garbage")).toBeUndefined();
  });
});
