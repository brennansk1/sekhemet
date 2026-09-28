import { describe, expect, it } from "vitest";
import { AUTO_APPLY_CHOICES, autoApplyView } from "../src/settings.js";

// planner-pm PM-N9-2, teams TEAM-18 and item 20: Preferences shows, per
// project, the four properties an Admin may let Seshat's suggestions apply
// automatically — never the assignee or health — and says who changes them.

describe("Preferences → Apply Seshat's suggestions automatically", () => {
  it("offers labels, priority, the duplicate link and a split, each off until an Admin turns it on", () => {
    expect(AUTO_APPLY_CHOICES.map((c) => c.property)).toEqual([
      "label",
      "priority",
      "duplicate",
      "split",
    ]);
    expect(JSON.stringify(AUTO_APPLY_CHOICES)).not.toMatch(/assign|health/i);
    const view = autoApplyView({ auto_apply: { priority: true } }, "");
    expect(view.rows).toEqual([
      { property: "label", label: "Labels", on: false, disabled: false },
      { property: "priority", label: "Priority", on: true, disabled: false },
      { property: "duplicate", label: "Duplicate link", on: false, disabled: false },
      { property: "split", label: "Split into smaller issues", on: false, disabled: false },
    ]);
    expect(view.note).toMatch(/assignee and health are always a person's/i);
    expect(view.note).not.toMatch(/!/);
  });

  it("is read-only below Admin, with the reason", () => {
    const view = autoApplyView({}, "Read-only: an Admin changes this.");
    expect(view.rows.every((r) => r.disabled && !r.on)).toBe(true);
    expect(view.note).toMatch(/Read-only: an Admin changes this\./);
  });
});
