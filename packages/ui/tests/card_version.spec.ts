import { describe, expect, it } from "vitest";
import { CARD_VERSION_FIELDS, cardVersion } from "../src/pm.js";

// DB-N16-4 (C4, FINDINGS REL-08): an issue's version is a digest of the
// fields a person edits, computed by one function on the server and on the
// page, so the page can say which version it edited from.
describe("cardVersion (DB-N16-4)", () => {
  const card = {
    id: "card_1",
    title: "Weekly total",
    priority: 3,
    estimate: 2,
    labels: ["ui", "time"],
    gateChecks: { unit: true, lint: false },
    stepsUsed: 4,
    updatedAt: "2026-10-05T10:00:00.000Z",
  };

  it("is 16 hex digits, and the same for the same editable values", () => {
    expect(cardVersion(card)).toMatch(/^[0-9a-f]{16}$/);
    expect(cardVersion({ ...card })).toBe(cardVersion(card));
    // Through JSON, as the page receives the issue.
    expect(cardVersion(JSON.parse(JSON.stringify(card)))).toBe(cardVersion(card));
  });

  it("changes when an editable field changes, and only then", () => {
    const v = cardVersion(card);
    for (const [field, value] of [
      ["title", "Weekly totals"],
      ["priority", 1],
      ["estimate", 3],
      ["labels", ["time", "ui"]],
      ["assignee", "p_priya"],
      ["dueDate", "2026-10-09"],
      ["gateChecks", { unit: false, lint: false }],
    ] as const)
      expect(cardVersion({ ...card, [field]: value }), field).not.toBe(v);
    // A run's step count and the time of the last write are not a person's edit.
    expect(cardVersion({ ...card, stepsUsed: 9, updatedAt: "2026-10-05T11:00:00.000Z" })).toBe(v);
    // An object's key order is not a change; a missing field is the same as null.
    expect(cardVersion({ ...card, gateChecks: { lint: false, unit: true } })).toBe(v);
    expect(cardVersion({ ...card, assignee: null })).toBe(v);
  });

  it("covers every field PATCH /api/cards/:id edits", () => {
    expect([...CARD_VERSION_FIELDS].sort()).toEqual(
      [
        "assignee",
        "cycleId",
        "dueDate",
        "epicId",
        "estimate",
        "gateChecks",
        "labels",
        "priority",
        "title",
      ].sort(),
    );
  });
});
