import { describe, expect, it } from "vitest";
import { itemLine } from "../src/inbox.js";
import { UI_LIB_MODULES } from "../src/index.js";
import {
  TRIAGE_COPY,
  TRIAGE_DECISIONS,
  intakeFromLine,
  snoozeChoices,
  triageDecisionFor,
  triageInboxLine,
  triageModel,
} from "../src/intake.js";
import { matchCard, parseQuery } from "../src/pm.js";

// Dashboard NEW-dashboard-10 (§2.4.19; DB-N10-2..4): the Triage view's rows
// and the lead's Inbox count, computed from the board's cards, whose
// server-derived `display.intake` names who filed an untriaged Backlog issue.

const filed = (
  id: string,
  at: string,
  from: "stakeholder" | "viewer" | "integration" | "import",
  by?: string,
) => ({
  id: `card_${id}`,
  status: "backlog",
  title: `Issue ${id}`,
  display: { shortId: id, title: `Issue ${id}`, intake: { from, at, ...(by ? { by } : {}) } },
});

describe("the Triage view's rows (DB-N10-2)", () => {
  const cards = [
    filed("b", "2026-10-02T09:00:00.000Z", "stakeholder", "Sam Stake"),
    filed("a", "2026-10-01T09:00:00.000Z", "integration", "GitHub"),
    filed("c", "2026-10-02T10:00:00.000Z", "import"),
    // Triaged (no intake facts), or no longer in Backlog: not rows.
    { id: "card_d", status: "backlog", title: "Issue d", display: { shortId: "d" } },
    { ...filed("e", "2026-09-30T09:00:00.000Z", "viewer", "Val View"), status: "ready" },
  ];

  it("lists only untriaged Backlog issues, oldest first, each with who filed it", () => {
    const m = triageModel({ cards, setup: "team" });
    expect(m.shown).toBe(true);
    expect(m.count).toBe(3);
    expect(m.rows.map((r) => [r.id, r.key, r.title, r.from])).toEqual([
      ["card_a", "a", "Issue a", "From GitHub"],
      ["card_b", "b", "Issue b", "Filed by Sam Stake, a Stakeholder"],
      ["card_c", "c", "Issue c", "Imported"],
    ]);
  });

  it("is hidden in Solo, where one person files everything (DB-N10-4)", () => {
    expect(triageModel({ cards, setup: "solo" })).toEqual({ shown: false, count: 0, rows: [] });
  });

  it("says each source in plain words", () => {
    expect(intakeFromLine({ from: "viewer", by: "Val View", at: "" })).toBe(
      "Filed by Val View, a Viewer",
    );
    expect(intakeFromLine({ from: "stakeholder", at: "" })).toBe("Filed by a Stakeholder");
    expect(intakeFromLine({ from: "integration", at: "" })).toBe("From an integration");
  });
});

describe("the four decisions (DB-N10-3)", () => {
  it("are one action each, with their keys, and never the bare word Accept", () => {
    expect(TRIAGE_DECISIONS.map((d) => [d.id, d.label, d.key])).toEqual([
      ["accept", "Accept into Backlog", "1"],
      ["decline", "Decline", "2"],
      ["duplicate", "Duplicate of…", "3"],
      ["snooze", "Snooze", "H"],
    ]);
    expect(triageDecisionFor("1")).toBe("accept");
    expect(triageDecisionFor("2")).toBe("decline");
    expect(triageDecisionFor("3")).toBe("duplicate");
    expect(triageDecisionFor("h")).toBe("snooze");
    expect(triageDecisionFor("H")).toBe("snooze");
    expect(triageDecisionFor("a")).toBeUndefined();
  });

  it("offers snooze times from now: tomorrow, in three days, next week, each at 9:00", () => {
    const now = new Date(2026, 9, 2, 15, 30);
    const at = snoozeChoices(now).map((c) => [
      c.label,
      new Date(c.until).getDate(),
      new Date(c.until).getHours(),
    ]);
    expect(at).toEqual([
      ["Tomorrow", 3, 9],
      ["In 3 days", 5, 9],
      ["Next week", 9, 9],
    ]);
  });

  it("says what Seshat's suggestions are: proposals a person applies", () => {
    expect(TRIAGE_COPY.suggestions).toBe("Seshat suggests. Nothing changes until you apply it.");
  });
});

describe("the lead's Inbox count (DB-N10-4)", () => {
  it("says how many issues wait in Triage", () => {
    expect(triageInboxLine(1)).toBe("1 issue waits in Triage.");
    expect(triageInboxLine(3)).toBe("3 issues wait in Triage.");
    const row = itemLine({
      id: "triage:proj_a",
      reason: "needs_you",
      kind: "triage",
      title: "Triage",
      count: 3,
      at: "2026-10-02T09:00:00.000Z",
      seq: 4,
      unread: true,
      saved: false,
      done: false,
      link: "#/board/triage",
    });
    expect(row).toEqual({ title: "Triage", line: "3 issues wait in Triage." });
  });
});

describe("the query is:untriaged", () => {
  it("matches the untriaged Backlog issues only", () => {
    const f = parseQuery("is:untriaged");
    expect(matchCard(filed("a", "2026-10-01T09:00:00.000Z", "import"), f)).toBe(true);
    expect(matchCard({ id: "card_d", status: "backlog", display: { shortId: "d" } }, f)).toBe(
      false,
    );
    expect(
      matchCard({ ...filed("e", "2026-10-01T09:00:00.000Z", "import"), status: "ready" }, f),
    ).toBe(false);
  });
});

it("ships to the browser as lib/intake.js", () => {
  expect(UI_LIB_MODULES).toContain("intake.js");
});
