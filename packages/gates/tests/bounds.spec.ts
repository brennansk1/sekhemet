import { describe, expect, it } from "vitest";
import { checkBounds, parseNumstat } from "../src/runner.js";

describe("@sekhemet/gates bounds gate (G10)", () => {
  it("passes a change at exactly the limits", () => {
    expect(
      checkBounds({ filesTouched: ["a.ts", "b.ts", "c.ts"], linesAdded: 150, linesRemoved: 50 }),
    ).toEqual({ passed: true });
  });

  it("fails one file over the limit with a typed hygiene failure naming every file", () => {
    const r = checkBounds({
      filesTouched: ["a.ts", "b.ts", "c.ts", "d.ts"],
      linesAdded: 4,
      linesRemoved: 0,
    });
    expect(r.passed).toBe(false);
    expect(r.failure).toMatchObject({
      rung: "bounds",
      gate: "bounds",
      layer: "hygiene",
      expected: "at most 3 files changed",
      actual: "4 files changed",
      suggestedFixFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
  });

  it("fails one line over the limit, counting removals as well as additions", () => {
    const r = checkBounds({ filesTouched: ["a.ts"], linesAdded: 101, linesRemoved: 100 });
    expect(r.failure?.actual).toBe("201 diff lines");
    expect(r.failure?.errorExcerpt).toBe(
      "Exceeded LOC diff limit: 201 diff lines (limit: 200) across 1 files",
    );
  });

  it("uses the project's limits from gates.toml when given", () => {
    expect(
      checkBounds({ filesTouched: ["a", "b"], linesAdded: 1, linesRemoved: 0, maxFiles: 1 }).passed,
    ).toBe(false);
    expect(
      checkBounds({ filesTouched: ["a"], linesAdded: 400, linesRemoved: 0, maxLines: 500 }).passed,
    ).toBe(true);
  });

  it("rejects nonsense limits and negative counts instead of passing them", () => {
    expect(() =>
      checkBounds({ filesTouched: [], linesAdded: 0, linesRemoved: 0, maxFiles: 0 }),
    ).toThrow("positive integers");
    expect(() =>
      checkBounds({ filesTouched: [], linesAdded: 0, linesRemoved: 0, maxLines: 2.5 }),
    ).toThrow("positive integers");
    expect(() => checkBounds({ filesTouched: [], linesAdded: -1, linesRemoved: 0 })).toThrow(
      "negative",
    );
  });

  it("parses git numstat, including binary files and renames", () => {
    const text = [
      "12\t3\tsrc/a.ts",
      "-\t-\tassets/logo.png",
      "0\t4\tsrc/{old.ts => new.ts}",
      "2\t0\tlib/x.ts => lib/y.ts",
      "garbage line",
      "",
    ].join("\n");
    expect(parseNumstat(text)).toEqual([
      { file: "src/a.ts", added: 12, removed: 3 },
      { file: "assets/logo.png", added: 0, removed: 0 },
      { file: "src/new.ts", added: 0, removed: 4 },
      { file: "lib/y.ts", added: 2, removed: 0 },
    ]);
    expect(parseNumstat("")).toEqual([]);
  });
});
