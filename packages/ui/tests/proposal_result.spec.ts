import { describe, expect, it } from "vitest";
import { appliedResult, showsApplyAll } from "../src/pm.js";

// FINDINGS PM-06 (C2b): applying one of Seshat's proposals says what it did
// — the issue it created or changed, by title, and where it now waits, in
// the board's words — and one change shows one Apply.

describe("PM-06: an applied proposal's visible result", () => {
  it("names the issue it created and the column it waits in", () => {
    expect(
      appliedResult("create_card", [
        { id: "story_a1", title: "Save a recipe", status: "planning" },
      ]),
    ).toEqual({
      text: "Created “Save a recipe”. It waits in To do while it is planned.",
      cards: [{ id: "story_a1", title: "Save a recipe", column: "To do" }],
    });
  });

  it("counts several created issues, and names a changed one", () => {
    expect(
      appliedResult("split_card", [
        { id: "a", title: "One", status: "ready" },
        { id: "b", title: "Two", status: "ready" },
      ]).text,
    ).toBe("Created 2 issues. They wait in To do.");
    expect(
      appliedResult("update_card", [{ id: "c", title: "Export a week as CSV", status: "review" }])
        .text,
    ).toBe("Changed “Export a week as CSV”. It is in In review.");
    expect(appliedResult("update_card", []).text).toBe("Applied.");
  });

  it("shows Apply all only when more than one change is open", () => {
    expect(showsApplyAll([{ state: "open" }])).toBe(false);
    expect(showsApplyAll([{ state: "open" }, { state: "applied" }])).toBe(false);
    expect(showsApplyAll([{ state: "open" }, { state: "open" }])).toBe(true);
  });
});
