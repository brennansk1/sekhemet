import { describe, expect, it } from "vitest";
import {
  QUICK_CREATE_COPY,
  epicFromFilter,
  issueSpec,
  quickCreateRequest,
  reproductionText,
} from "../src/create.js";
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
      error: "An issue needs a title.",
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
      heading: "New issue",
      title: "Title",
      description: "Description (optional)",
      descriptionHint: "What done looks like, in your words.",
      submit: "Propose issue",
      cancel: "Cancel",
      note: "The planning model checks its size, acceptance criteria and scope, and Seshat shows it as a proposal for you to apply.",
      sent: "Proposed in Seshat. Apply it to plan the issue.",
      plus: "New issue",
      plusTip: "New issue. The planning model decides where it starts.",
      type: "Type",
      priority: "Priority",
      labels: "Labels",
      labelsHint: "Separate labels with commas.",
      sprint: "Sprint",
      noSprint: "No sprint",
      assignee: "Assignee",
      unassigned: "Unassigned",
      reproduction: "How to see the bug",
      reproductionHint:
        "Each is optional. The planning model turns them into the test that shows the bug.",
      happened: "What happened",
      expected: "What you expected",
      steps: "Steps",
      release: "Release",
      noRelease: "Not in a release",
    });
    expect(JSON.stringify(QUICK_CREATE_COPY)).not.toMatch(/CLI|terminal|sekhemet plan|command/i);
  });

  it("NEW-dashboard-15: carries the type and the properties a person chose (DB-N15-1)", () => {
    expect(
      quickCreateRequest({
        title: "Show hours as 7h 30m",
        type: "task",
        priority: 2,
        labels: [" timesheet ", "", "display"],
        cycleId: "cyc_1",
        assignee: "p_jane",
      }),
    ).toEqual({
      ok: true,
      body: {
        title: "Show hours as 7h 30m",
        type: "task",
        priority: 2,
        labels: ["timesheet", "display"],
        cycleId: "cyc_1",
        assignee: "p_jane",
      },
    });
    expect(quickCreateRequest({ title: "X", type: "epic" })).toEqual({
      ok: false,
      error: "Choose Story, Bug, Task or Spike.",
    });
    expect(quickCreateRequest({ title: "X", priority: 9 })).toEqual({
      ok: false,
      error: "Choose a priority from No priority to Urgent.",
    });
  });

  it("a Bug carries its reproduction; any other type leaves it out (DB-N15-2)", () => {
    const reproduction = {
      happened: " Sunday is not counted. ",
      expected: "",
      steps: "1. Enter Sunday hours",
      release: "v0.3.0",
    };
    expect(quickCreateRequest({ title: "Sunday ignored", type: "bug", reproduction })).toEqual({
      ok: true,
      body: {
        title: "Sunday ignored",
        type: "bug",
        reproduction: {
          happened: "Sunday is not counted.",
          steps: "1. Enter Sunday hours",
          release: "v0.3.0",
        },
      },
    });
    expect(quickCreateRequest({ title: "Sunday ignored", type: "story", reproduction })).toEqual({
      ok: true,
      body: { title: "Sunday ignored", type: "story" },
    });
  });

  it("the reproduction joins the description as the issue's text, in the form's words", () => {
    expect(
      reproductionText({
        happened: "32 hours",
        expected: "40 hours",
        steps: "1. a\n2. b",
        release: "v1",
      }),
    ).toBe("What happened: 32 hours\nWhat you expected: 40 hours\nSteps:\n1. a\n2. b\nRelease: v1");
    expect(reproductionText({ steps: "1. a" })).toBe("Steps:\n1. a");
    expect(issueSpec("Seen on Mondays.", { happened: "32 hours" })).toBe(
      "Seen on Mondays.\n\nWhat happened: 32 hours",
    );
    expect(issueSpec(undefined, undefined)).toBe("");
  });
});
