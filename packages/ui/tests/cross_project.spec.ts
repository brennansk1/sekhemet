import { describe, expect, it } from "vitest";
import { CROSS_PROJECT_COPY, crossProjectRows } from "../src/switcher.js";

/**
 * dashboard DB-N26-2 (DEC-57): My issues, the Inbox and the palette's
 * *Issues* list every project the person can see — and no other — with each
 * row's project named and a project filter, as a pure model.
 */
describe("crossProjectRows (DB-N26-2)", () => {
  const projects = [
    { id: "proj_a", name: "Alpha" },
    { id: "proj_b", name: "Beta" },
  ];
  const items = [
    { id: "a1", projectId: "proj_a" },
    { id: "b1", projectId: "proj_b" },
    { id: "a2", projectId: "proj_a" },
    // A project the person cannot see: never listed (TEAM-58).
    { id: "x1", projectId: "proj_hidden" },
  ];

  it("names each row's project and offers All projects and each project, with counts", () => {
    const v = crossProjectRows(items, projects);
    expect(v.rows.map((r) => [r.item.id, r.projectName])).toEqual([
      ["a1", "Alpha"],
      ["b1", "Beta"],
      ["a2", "Alpha"],
    ]);
    expect(v.showProject).toBe(true);
    expect(v.filters).toEqual([
      { id: "", label: CROSS_PROJECT_COPY.all, count: 3, selected: true },
      { id: "proj_a", label: "Alpha", count: 2, selected: false },
      { id: "proj_b", label: "Beta", count: 1, selected: false },
    ]);
  });

  it("filters to one project, and drops a filter for a project no longer listed", () => {
    expect(crossProjectRows(items, projects, "proj_b").rows.map((r) => r.item.id)).toEqual(["b1"]);
    expect(crossProjectRows(items, projects, "proj_b").filters[2]?.selected).toBe(true);
    expect(crossProjectRows(items, projects, "proj_gone").rows).toHaveLength(3);
  });

  it("with one project, names none and offers no filter", () => {
    const v = crossProjectRows(
      [{ id: "a1", projectId: "proj_a" }],
      [projects[0] as { id: string; name: string }],
    );
    expect(v.showProject).toBe(false);
    expect(v.filters).toEqual([]);
  });
});
