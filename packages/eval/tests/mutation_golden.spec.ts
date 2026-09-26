import { describe, expect, it } from "vitest";
import { generateMutants } from "../src/mutation.js";

/**
 * Characterization of the improve step's mutant generator, recorded from the
 * compiler's scanner before it read the source index's operator facts (T2).
 */
const CORPUS = [
  "export function clamp(x: number, lo: number, hi: number): boolean {",
  '  const s = "a < b && c"; // x === y',
  "  if (x < lo || x > hi) return false;",
  "  if (x >= lo && x <= hi) return x !== 0;",
  "  return x === lo + hi - 1 * 2 ? true : false;",
  "}",
].join("\n");

describe("the improve step's mutants keep their tokens (T2)", () => {
  it("generates the same mutants, lines and columns", () => {
    expect(
      generateMutants(CORPUS, { max: 100 }).map(
        (m) => `${m.id} ${m.line}:${m.column} ${m.operator} ${m.original}->${m.replacement}`,
      ),
    ).toMatchSnapshot();
    expect(generateMutants(CORPUS, { lines: [3], max: 100 }).map((m) => m.line)).toEqual([
      3, 3, 3, 3,
    ]);
  });
});
