import { describe, expect, it } from "vitest";
import { invariantsNotEnforced } from "../src/vocabulary.js";

// GT-N1-1: the gate strip warns about the brief's invariants the architecture
// gate cannot check, listing each line and the two forms it could be
// restated in (the `/api/gates` payload's `invariants.notEnforced`).

const FORMS = ["`A/` does not import `B`", "`Name` is defined only in `path`"];

describe("invariants not enforced (GT-N1-1)", () => {
  it("names each line and the forms to restate it in", () => {
    const w = invariantsNotEnforced([
      { line: "Amounts are integer cents.", restate: FORMS },
      { line: "No stack traces", restate: FORMS },
    ]);
    expect(w).toEqual({
      label: "2 invariants not enforced",
      heading: "The architecture check cannot verify these lines of the brief.",
      lines: ["Amounts are integer cents.", "No stack traces"],
      forms: FORMS,
    });
    expect(invariantsNotEnforced([{ line: "x", restate: FORMS }])?.label).toBe(
      "1 invariant not enforced",
    );
  });

  it("warns about nothing when every line is enforced or the payload has none", () => {
    expect(invariantsNotEnforced([])).toBeUndefined();
    expect(invariantsNotEnforced(undefined)).toBeUndefined();
  });
});
