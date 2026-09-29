import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fieldPermission, levelNote } from "../src/team_admin.js";

/**
 * DB-N9-17 everywhere (close-out C3; dashboard §2.2.7, teams items 6, 9): the
 * board's quick-create `+`, an issue's inline field edits, drag and drop on
 * the board and the Inbox's Start are disabled, with the level held and a
 * level that can written beside them, where the viewer's level cannot do
 * them. The server still refuses each (TEAM-4); the page says so first.
 */

const web = (f: string) => readFileSync(join(import.meta.dirname, "..", "web", f), "utf8");
const where = { project: "proj_c", projectName: "Chronicle" };
const stakeholder = { mode: "team" as const, level: "stakeholder" };

describe("the permission each inline field edit needs (the server's PATCH /api/cards/:id)", () => {
  it("is priority.change for priority, and issue.edit for every other field", () => {
    expect(fieldPermission("priority")).toBe("priority.change");
    for (const f of ["estimate", "labels", "cycleId", "assignee", "epicId", "dueDate"])
      expect(fieldPermission(f)).toBe("issue.edit");
  });

  it("names the level held and one that can, for a Stakeholder; nothing for a Member or in Solo", () => {
    expect(levelNote(stakeholder, fieldPermission("priority"), where)).toBe(
      "You're a Stakeholder on Chronicle. A Member can change priority.",
    );
    expect(levelNote(stakeholder, "issue.create", where)).toBe(
      "You're a Stakeholder on Chronicle. A Member can create issues.",
    );
    expect(levelNote({ mode: "team", level: "member" }, "issue.edit", where)).toBeUndefined();
    expect(levelNote({ mode: "solo" }, "issue.edit", where)).toBeUndefined();
  });
});

describe("each control is marked with the permission it needs", () => {
  it("the board's quick-create + (issue.create, on the board's project, noted once visibly)", () => {
    const board = web("board.js");
    expect(board).toMatch(/data-create data-needs="issue\.create"/);
    expect(board).toContain("data-needs-quiet");
    expect(board).toContain("boardLevelNote");
  });

  it("the list's inline field edits (the field's permission, on the issue's project)", () => {
    const list = web("list.js");
    expect(list).toContain("data-needs=");
    expect(list).toContain("fieldPermission(col.edit)");
    expect(list).toContain("data-needs-project");
  });

  it("the list writes its level note once, visibly, above the table (not only as a title)", () => {
    const list = web("list.js");
    expect(list).toContain("levelSentence(");
    expect(list).toMatch(/class="level-note list-level-note"/);
  });

  it("Status's Set health, Set target date, Set release lead and Write update, disabled with the note", () => {
    const status = web("status.js");
    expect(status).toContain("gatedButton(");
    for (const key of ["health", "target", "releaseLead", "update"])
      expect(status).toContain(`v.gated.${key}`);
    expect(status).toContain('data-needs="${esc(permission)}"');
    expect(status).toContain("data-needs-project=");
  });

  it("keyboard and bulk field edits say the note instead of opening the menu", () => {
    const fields = web("fields.js");
    expect(fields).toContain("fieldPermission(field)");
    expect(fields).toContain("noteFor(");
  });

  it("drag and drop and Alt+arrow moves on the board (priority.change)", () => {
    const reorder = web("reorder.js");
    expect(reorder).toContain('noteFor("priority.change"');
  });

  it("the Inbox's Start on a request to start the Agent (agent.start)", () => {
    const inbox = web("inbox.js");
    expect(inbox).toMatch(/data-start="[^"]*"[^>]*data-needs="agent\.start"/);
  });

  it("a quiet control keeps its note for screen readers and as its title", () => {
    const gate = web("level_gate.js");
    expect(gate).toContain("needsQuiet");
    expect(gate).toContain("sr-only");
    expect(gate).toContain("export function noteFor");
    expect(gate).toContain("export function levelSentence");
  });
});
