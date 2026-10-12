import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { issueActions, nothingToRevertText, takenOffHoldText } from "../src/issue_actions.js";
import { conflictNextStep } from "../src/review_desk.js";

/**
 * The test-and-refine loop's wave 10, the dashboard half of A1–A3
 * (sweep5_kernel_reviewgit.json): a refusal the CLI answers with a `Do:`
 * step is answered on the board with the same step, in the board's words,
 * and a move off hold says where the issue went, never "back where it was".
 */

describe("a conflicting Accept names the step that moves the issue on (wave 10 A1)", () => {
  it("asks for changes: rebase onto the integration branch and resolve the files", () => {
    expect(conflictNextStep({ onto: "main", files: ["src/shared.ts"] })).toEqual({
      detail:
        "Request changes and ask the Agent to rebase onto main and resolve the conflict in src/shared.ts.",
      note: "Rebase onto main and resolve the conflict in src/shared.ts.",
    });
  });

  it("lists several files, and none when git named none", () => {
    expect(conflictNextStep({ onto: "trunk", files: ["a.ts", "b.ts", "c.ts"] }).note).toBe(
      "Rebase onto trunk and resolve the conflict in a.ts, b.ts and c.ts.",
    );
    expect(conflictNextStep({ onto: "main", files: [] }).note).toBe(
      "Rebase onto main and resolve the conflict.",
    );
  });
});

describe("Revert on a Done issue Sekhemet merged nothing of (wave 10 A2)", () => {
  const done = { id: "card_pr", status: "done" };

  it("is disabled, saying where to revert and how to do the work again", () => {
    const desk = {
      revert: {
        may: false as const,
        nothing: { pr: "https://github.com/o/r/pull/7", merge: "b".repeat(40) },
      },
    };
    const [revert] = issueActions(done, desk);
    expect(revert).toMatchObject({ id: "revert", enabled: false });
    expect(revert?.why).toBe(
      "It was accepted through its pull request https://github.com/o/r/pull/7, merged as bbbbbbb, so there is no merge here to revert. Revert that merge where the pull request lives, then add a New issue to do the work again.",
    );
  });

  it("says so for a Done issue with no Accept on its Activity log", () => {
    expect(nothingToRevertText({})).toBe(
      "It is Done with no Accept on its Activity log, so nothing was merged here to revert. To do the work again, add a New issue.",
    );
    expect(nothingToRevertText({ pr: "https://x/pull/2" })).toBe(
      "It was accepted through its pull request https://x/pull/2, so there is no merge here to revert. Revert that merge where the pull request lives, then add a New issue to do the work again.",
    );
  });
});

describe("taking an issue off hold says where it went (wave 10 A3)", () => {
  it("names the column the server moved it to", () => {
    expect(takenOffHoldText("ready")).toBe("Taken off hold. It is in To do.");
    expect(takenOffHoldText("planning")).toBe("Taken off hold. It is in To do.");
    expect(takenOffHoldText("backlog")).toBe("Taken off hold. It is in Backlog.");
  });

  it("says an issue held from In review goes to To do and runs again", () => {
    expect(takenOffHoldText("ready", "review")).toBe(
      "Taken off hold. It is in To do, not In review: the Agent runs it again.",
    );
    expect(takenOffHoldText("ready", "ready")).toBe("Taken off hold. It is in To do.");
  });

  it("no page promises it is back where it was", () => {
    const web = join(import.meta.dirname, "..", "web");
    const hits = readdirSync(web)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => /back where it was/.test(readFileSync(join(web, f), "utf8")))
      .filter((f) => f !== "reorder.js"); // a reordered row is back where it was: true there
    expect(hits).toEqual([]);
  });
});
