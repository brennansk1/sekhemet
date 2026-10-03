import { describe, expect, it } from "vitest";
import { removalView } from "../src/team_admin.js";

// Teams item 9a, NEW-teams-13 (TEAM-49): what *Remove* says first — what the
// person owns and leads, their seats in Accept rules, and the Agent work
// they started — in plain words, before anything is removed.

const summary = {
  principal: "p_lee",
  name: "Lee Lead",
  owns: [
    { id: "c1", title: "Hash the chain", status: "review" },
    { id: "c2", title: "Verify the chain", status: "ready" },
  ],
  leads: {
    projects: [{ id: "proj_c", name: "Chronicle" }],
    releases: [{ project: "proj_c", id: "sl_1", name: "Release 1" }],
  },
  acceptSeats: [
    { project: "proj_c", name: "Chronicle", emptied: true },
    { project: "proj_a", name: "Atlas", emptied: false },
  ],
  agentWork: [
    { id: "c3", title: "Export the ledger", status: "in_progress", running: true },
    { id: "c4", title: "Import from CSV", status: "ready", running: false },
  ],
};

describe("TEAM-49: Remove lists what the person leaves behind", () => {
  it("names the person and says their sessions end", () => {
    const v = removalView(summary);
    expect(v.title).toBe("Remove Lee Lead?");
    expect(v.lines[0]).toBe("Their sessions and tokens end now.");
  });

  it("lists their issues, which keep their assignee", () => {
    expect(removalView(summary).lines).toContain(
      "They are the assignee of 2 open issues: Hash the chain, Verify the chain. Each keeps its assignee; reassign them on the board.",
    );
  });

  it("lists what they lead", () => {
    const lines = removalView(summary).lines;
    expect(lines).toContain("They lead Chronicle. Name a new lead in the project's settings.");
    expect(lines).toContain("They lead Release 1.");
  });

  it("warns that an Accept rule naming only them leaves no one able to accept, with no fallback", () => {
    const v = removalView(summary);
    expect(v.warnings).toEqual([
      "Chronicle's Accept rule names only them. Its issues cannot be accepted until the project lead or an Admin edits the rule; no one else gains Accept.",
    ]);
    expect(v.lines).toContain(
      "They are on Atlas's Accept rule; the others on it can still accept.",
    );
  });

  it("says the Agent work they started pauses", () => {
    expect(removalView(summary).lines).toContain(
      "The Agent work they started pauses: 1 running issue stops at its next step, and 1 queued issue waits on hold.",
    );
  });

  it("says so when they leave nothing behind, and never prints a principal id", () => {
    const v = removalView({
      principal: "p_9a75c0ffee",
      owns: [],
      leads: { projects: [], releases: [] },
      acceptSeats: [],
      agentWork: [],
    });
    expect(v.title).toBe("Remove this person?");
    expect(v.lines).toEqual([
      "Their sessions and tokens end now.",
      "They own, lead and started nothing here.",
    ]);
    expect(JSON.stringify(v)).not.toContain("p_9a75");
  });
});
