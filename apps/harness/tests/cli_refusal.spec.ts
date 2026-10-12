import { describe, expect, it } from "vitest";
import {
  LIST_ISSUES_STEP,
  nextStepFor,
  noIssueRefusal,
  refusalLines,
} from "../src/commands/cli_result.js";

/**
 * Surface item 18b (S1B-B19): one refusal style for the CLI — one
 * `sekhemet:` line, a `Do:` line with the step that moves things on, and an
 * unknown issue ID answered with the closest ID and where the IDs are listed.
 */
describe("the CLI's refusal style (item 18b)", () => {
  it("is one `sekhemet:` line, and a `Do:` line only when there is a step", () => {
    expect(refusalLines("no issue x", "sekhemet status")).toEqual([
      "sekhemet: no issue x",
      "  Do: sekhemet status",
    ]);
    expect(refusalLines("a rejection needs a reason")).toEqual([
      "sekhemet: a rejection needs a reason",
    ]);
  });

  it("an unknown issue names the closest ID within two edits, else none, and always where IDs are listed", () => {
    const ids = ["story_path_eb4275c2", "story_path_261b38e9", "card_t"];
    expect(noIssueRefusal("story_path_eb4275c3", ids)).toEqual({
      what: "no issue story_path_eb4275c3. Did you mean story_path_eb4275c2?",
      next: LIST_ISSUES_STEP,
    });
    expect(noIssueRefusal("nope", ids)).toEqual({ what: "no issue nope", next: LIST_ISSUES_STEP });
    expect(noIssueRefusal("card_t", [])).toEqual({
      what: "no issue card_t",
      next: LIST_ISSUES_STEP,
    });
  });

  it("every stored state has a next step, naming the issue, in the board's commands", () => {
    const states = [
      "backlog",
      "ready",
      "planning",
      "in_progress",
      "verify",
      "review",
      "done",
      "parked",
      "rejected",
    ];
    for (const status of states) {
      const step = nextStepFor({ id: "c9", status });
      expect(step, status).toMatch(/c9/);
      // NAMING: no stored state id in a person's words (DEC-52).
      expect(step, status).not.toMatch(/\b(in_progress|parked|rejected|verify)\b/);
    }
    expect(nextStepFor({ id: "c9", status: "ready" })).toMatch(/^sekhemet run c9/);
    expect(nextStepFor({ id: "c9", status: "planning" })).toMatch(/^sekhemet approve c9/);
    expect(nextStepFor({ id: "c9", status: "parked" })).toBe("sekhemet unpark c9");
    expect(nextStepFor({ id: "c9", status: "rejected" })).toBe("sekhemet reopen c9");
    expect(nextStepFor({ id: "c9", status: "unknown_state" })).toBeUndefined();
  });
});
