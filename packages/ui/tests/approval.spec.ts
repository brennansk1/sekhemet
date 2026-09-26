import { describe, expect, it } from "vitest";
// The browser module as-is: the same code the page runs.
import { approvalHtml, approveShown, waitingCards } from "../web/approval_view.js";

/**
 * planner-pm PM-N7-5 on the dashboard: a card waiting on a person's approval
 * shows its criteria, example tables and the files its profile asks for, and
 * an Approve button that sends back the SHA-256 of exactly what it showed.
 */
const SHA = "a".repeat(64);
const view = (approved = false) => ({
  id: "card_1",
  profile: "production",
  sha256: SHA,
  cards: [
    {
      id: "card_1",
      title: "Save a <recipe>",
      status: "planning",
      approved,
      criteria: [{ id: "card_1.c1", text: "Saving a recipe keeps its title" }],
      examples: ['card_1.c1: given ["Soup"] → "Soup"'],
      tests: [
        { path: "tests/save.test.ts", what: "examples", approved: false, sha256: "b".repeat(64) },
      ],
    },
  ],
});

describe("PM-N7-5: the card view's approval", () => {
  it("shows the criteria, examples and files, escaped, with an Approve button", () => {
    expect(waitingCards(view()).map((c) => c.id)).toEqual(["card_1"]);
    const html = approvalHtml(view());
    expect(html).toContain("card_1.c1");
    expect(html).toContain("Saving a recipe keeps its title");
    expect(html).toContain("given [&quot;Soup&quot;]");
    expect(html).toContain("Example tables");
    expect(html).toContain("tests/save.test.ts");
    expect(html).toContain("production");
    expect(html).toContain("&lt;recipe&gt;");
    expect(html).not.toContain("<recipe>");
    expect(html).toMatch(/<button[^>]*data-approve[^>]*>Approve<\/button>/);
    // No information only on hover (DB-P12-6).
    expect(html).not.toContain("title=");
  });

  it("shows nothing when every card already carries the approval", () => {
    expect(waitingCards(view(true))).toEqual([]);
    expect(approvalHtml(view(true))).toBe("");
    expect(approvalHtml(undefined)).toBe("");
  });

  it("posts the SHA-256 of what it showed to the card's approve route", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const post = async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { ok: true, status: 200, data: { ok: true } };
    };
    await approveShown("card 1", view(), post);
    expect(calls).toEqual([{ path: "/api/cards/card%201/approve", body: { sha256: SHA } }]);
  });
});
