import { describe, expect, it } from "vitest";
import { mutationNotMeasured } from "../src/builtin.js";

/**
 * MS-M10-3: any changed code the TypeScript/JavaScript operators cannot
 * mutate is reported as not measured. The rule names what is safe to skip,
 * so an unlisted language is reported, never silently skipped; one rule for
 * the gate and the mutation step (B2.4 review).
 */
describe("mutationNotMeasured", () => {
  it("reports every code language the operators cannot mutate", () => {
    for (const f of ["a.py", "b.rs", "c.dart", "d.ex", "e.lua", "f.vue", "g.svelte", "h.sh"]) {
      expect(mutationNotMeasured(f)).toMatch(/no mutation operators for \.\w+ files/);
    }
  });

  it("measures JS/TS and skips what is not code or is a test", () => {
    for (const f of [
      "src/a.ts",
      "src/b.mjs",
      "c.tsx",
      "README.md",
      "x.json",
      "types.d.ts",
      "Makefile",
    ]) {
      expect(mutationNotMeasured(f)).toBeUndefined();
    }
    expect(mutationNotMeasured("tests/a.py")).toBeUndefined();
  });
});
