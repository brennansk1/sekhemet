import { describe, expect, it } from "vitest";
import { mutantsOnLines } from "../src/builtin.js";

/**
 * Characterization of the mutation operators' token source, recorded from
 * the compiler's scanner before the operators read the source index's
 * operator facts (T2, IX-1): the same tokens, never strings or comments.
 */
const MUTATION_CORPUS = [
  "export function clamp(x: number, lo: number, hi: number): boolean {",
  '  const s = "a < b && c"; // x === y',
  "  if (x < lo || x > hi) return false;",
  "  if (x >= lo && x <= hi) return x !== 0;",
  "  return x === lo + hi - 1 * 2 ? true : false;",
  "}",
  "const list: Array<string> = [];",
].join("\n");

describe("mutation operators keep their tokens (T2)", () => {
  it("mutates the same tokens on the given lines", () => {
    const all = new Set([1, 2, 3, 4, 5, 6, 7]);
    expect(
      mutantsOnLines("src/m.ts", MUTATION_CORPUS, all, 100).map(
        (m) => `${m.line} ${m.original}->${m.replacement}`,
      ),
    ).toMatchSnapshot();
    expect(mutantsOnLines("src/m.ts", MUTATION_CORPUS, new Set([3]), 2)).toHaveLength(2);
  });
});
