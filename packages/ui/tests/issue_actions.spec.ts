import { describe, expect, it } from "vitest";
import { UI_LIB_MODULES } from "../src/index.js";
import {
  ISSUE_ACTION_COPY,
  issueActions,
  revertConfirmText,
  revertRefusalText,
} from "../src/issue_actions.js";

// Dashboard NEW-dashboard-21 (§2.6 *Issue actions*; FINDINGS ISS-04): which
// closing and reopening actions an issue offers, in NAMING's words (DEC-52),
// and why Revert is disabled for a person the Accept rule does not name.

const card = (status: string) => ({ id: "card_1", status });

describe("the actions an issue offers by its column (DB-N21-1)", () => {
  it("offers Won't do in Backlog, To do, In review and On hold", () => {
    for (const status of ["backlog", "ready", "review", "parked"]) {
      expect(issueActions(card(status)).map((a) => a.id)).toEqual(["wontdo"]);
    }
  });

  it("offers nothing to close an issue in any other column", () => {
    for (const status of ["planning", "in_progress", "verifying"]) {
      expect(issueActions(card(status))).toEqual([]);
    }
  });

  it("offers Reopen on a Won't do issue and Revert on a Done one (DB-N21-2, -3)", () => {
    expect(issueActions(card("rejected")).map((a) => a.id)).toEqual(["reopen"]);
    expect(issueActions(card("done")).map((a) => a.id)).toEqual(["revert"]);
  });

  it("names each action in DEC-52's words, with its one-line hint", () => {
    const [wontDo] = issueActions(card("ready"));
    expect(wontDo).toMatchObject({
      label: "Won't do",
      hint: "Closes the issue without building it. You can reopen it.",
      enabled: true,
    });
    expect(issueActions(card("rejected"))[0]?.label).toBe("Reopen");
    expect(issueActions(card("done"))[0]).toMatchObject({
      label: "Revert",
      hint: "Adds a commit that undoes the accepted change.",
    });
  });
});

describe("Revert for a person the Accept rule does not name (DB-N21-3)", () => {
  it("is enabled when the review desk says the viewer may revert", () => {
    expect(issueActions(card("done"), { revert: { may: true } })[0]).toMatchObject({
      enabled: true,
    });
  });

  it("is disabled, saying who may revert, when the desk says no", () => {
    const desk = {
      revert: {
        may: false,
        who: [
          { principal: "p_ada", name: "Ada Admin" },
          { principal: "p_lee", name: "Lee Lead" },
        ],
      },
    };
    const [revert] = issueActions(card("done"), desk);
    expect(revert?.enabled).toBe(false);
    expect(revert?.why).toBe(
      "Only Ada Admin and Lee Lead can revert it: the Accept rule names them.",
    );
  });

  it("says the rule needs a person when it names no one now", () => {
    expect(revertRefusalText([])).toBe(
      "The Accept rule names no current member, so no one can revert it. The project lead or an Admin can edit the rule.",
    );
  });

  it("never prints a principal id for a person with no name", () => {
    expect(revertRefusalText([{ principal: "p_9a75c0ffee" }])).not.toContain("p_9a75");
  });
});

describe("the Revert confirmation names what it does", () => {
  it("names the commit it undoes and where the issue goes", () => {
    expect(revertConfirmText("ba1338e0c0ffee")).toBe(
      "Revert adds a commit to main that undoes ba1338e, and moves this issue back to To do.",
    );
  });

  it("names the integration branch when it is not main", () => {
    expect(revertConfirmText("ba1338e0c0ffee", "trunk")).toContain("a commit to trunk");
  });
});

describe("the result toasts", () => {
  it("say what happened in the board's words", () => {
    expect(ISSUE_ACTION_COPY.wontDoDone).toBe("Marked Won't do. You can reopen it.");
    expect(ISSUE_ACTION_COPY.reopened).toBe("Reopened. It is back in To do.");
    expect(ISSUE_ACTION_COPY.reverted("0123456789")).toBe(
      "Reverted as 0123456. The issue is back in To do.",
    );
  });

  it("is a module the browser imports", () => {
    expect(UI_LIB_MODULES).toContain("issue_actions.js");
  });
});
