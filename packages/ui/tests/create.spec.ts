import { describe, expect, it } from "vitest";
import { QUICK_CREATE_COPY, epicFromFilter, quickCreateRequest } from "../src/create.js";
import { parseQuery } from "../src/pm.js";

/**
 * dashboard DB-P3-12 (§2.4.7): `c` or a column's `+` opens a create form — a
 * one-line title and an optional description — whose result is a create
 * proposal from the planner pipeline, shown in Seshat for Apply. No word of
 * it sends a person to the CLI.
 */
describe("quick create (DB-P3-12)", () => {
  it("sends a trimmed title and the description, and nothing else", () => {
    expect(
      quickCreateRequest({ title: "  Export the totals as CSV ", description: "  One file.\n" }),
    ).toEqual({
      ok: true,
      body: { title: "Export the totals as CSV", description: "One file." },
    });
    expect(quickCreateRequest({ title: "Tag rows", description: "   " })).toEqual({
      ok: true,
      body: { title: "Tag rows" },
    });
  });

  it("carries the epic the board is filtered to, when there is one", () => {
    expect(quickCreateRequest({ title: "Tag rows", epicId: "ep_tag" })).toEqual({
      ok: true,
      body: { title: "Tag rows", epicId: "ep_tag" },
    });
  });

  it("carries the project the board is scoped to, so the Team check is that project's", () => {
    expect(quickCreateRequest({ title: "Tag rows", projectId: "proj_a" })).toEqual({
      ok: true,
      body: { title: "Tag rows", projectId: "proj_a" },
    });
    expect(quickCreateRequest({ title: "Tag rows", projectId: null })).toEqual({
      ok: true,
      body: { title: "Tag rows" },
    });
  });

  it("takes the epic from a filter naming exactly one", () => {
    const epics = [
      { id: "ep_tag", title: "Tag the rows" },
      { id: "ep_import", title: "Import a statement" },
    ];
    expect(epicFromFilter(parseQuery("epic:tag-the-rows"), epics)).toBe("ep_tag");
    expect(epicFromFilter(parseQuery("epic:ep_import label:api"), epics)).toBe("ep_import");
    expect(epicFromFilter(parseQuery("epic:ep_tag,ep_import"), epics)).toBeUndefined();
    expect(epicFromFilter(parseQuery("-epic:ep_tag"), epics)).toBeUndefined();
    expect(epicFromFilter(parseQuery("epic:none"), epics)).toBeUndefined();
    expect(epicFromFilter(parseQuery(""), epics)).toBeUndefined();
  });

  it("refuses an empty title in words, and a title longer than one line", () => {
    expect(quickCreateRequest({ title: "   " })).toEqual({
      ok: false,
      error: "A card needs a title.",
    });
    expect(quickCreateRequest({ title: "One\nTwo" })).toEqual({
      ok: false,
      error: "Keep the title to one line; put the rest in the description.",
    });
    expect(quickCreateRequest({ title: "x".repeat(301) })).toEqual({
      ok: false,
      error: "Keep the title under 300 characters.",
    });
  });

  it("names the planning model and Seshat, and never the CLI", () => {
    expect(QUICK_CREATE_COPY).toEqual({
      heading: "New card",
      title: "Title",
      description: "Description (optional)",
      descriptionHint: "What done looks like, in your words.",
      submit: "Propose card",
      cancel: "Cancel",
      note: "The planning model checks its size, acceptance criteria and scope, and Seshat shows it as a proposal for you to apply.",
      sent: "Proposed in Seshat. Apply it to plan the card.",
      plus: "New card",
      plusTip: "New card. The planning model decides where it starts.",
    });
    expect(JSON.stringify(QUICK_CREATE_COPY)).not.toMatch(/CLI|terminal|sekhemet plan|command/i);
  });
});
