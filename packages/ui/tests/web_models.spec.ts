import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { boardModel } from "../src/columns.js";
import { type NavContext, chordTarget, navNameOf, visibleNav } from "../src/nav.js";
import { tileModel } from "../src/tiles.js";
import { BOARD_COLUMN_ORDER, describeCard } from "../src/vocabulary.js";

/**
 * DB-N2-1: the board, tile and nav models asserted with exact outputs for
 * every stored state, and at least two negative cases each. The page modules
 * (`board.js`, `tile.js`, `shell.js`) render these models and nothing else.
 */

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();

function card(status: string, patch: Partial<CardRecord> = {}) {
  const c = {
    id: `card_${status}`,
    tier: "story",
    title: "A card",
    status,
    scopeFiles: [],
    stepBudget: 40,
    stepsUsed: 0,
    createdAt: at(48),
    updatedAt: at(1),
    ...patch,
  } as CardRecord;
  return { ...c, display: describeCard(c, { now: NOW, enteredColumnAt: at(1) }) };
}

const quiet = (text: string, tone: string, mark: string) => ({
  text,
  tone,
  mark,
  old: false,
  wraps: false,
});

describe("the tile model, every stored state (DB-N2-1)", () => {
  // Backlog and Ready say nothing on the tile (DB-P3-8); the rest say what is true now.
  const expected: Record<string, { column?: string; status?: object; age?: string }> = {
    backlog: { column: "backlog" },
    ready: { column: "todo" },
    planning: { column: "todo", status: quiet("Being planned", "neutral", "planning") },
    in_progress: {
      column: "in_progress",
      status: quiet("Starting", "running", "running"),
      age: "1h",
    },
    verify: {
      column: "in_progress",
      status: quiet("Running checks…", "running", "running"),
      age: "1h",
    },
    review: { column: "in_review", status: quiet("Waiting 1h", "pass", "wait"), age: "1h" },
    done: { column: "done", status: quiet("Accepted · 1h ago", "neutral", "done") },
    parked: { column: "on_hold", status: quiet("On hold", "parked", "parked") },
    rejected: { column: "wont_do", status: quiet("Rejected", "neutral", "none") },
  };

  for (const status of BOARD_COLUMN_ORDER) {
    it(`${status}`, () => {
      const t = tileModel(card(status), { now: NOW });
      expect({ column: t.column, status: t.status, age: t.age }).toEqual({
        column: expected[status]?.column,
        status: expected[status]?.status,
        age: expected[status]?.age,
      });
    });
  }

  it("negative: a state the board does not know has no column, and its name is humanised", () => {
    const t = tileModel(card("mystery_state"), { now: NOW });
    expect(t.column).toBeUndefined();
    expect(t.status?.text).toBe("Mystery state");
  });

  it("negative: a planning card after a failed attempt carries no failure mark (DB-N1-3)", () => {
    const failed = {
      passed: false,
      rungResults: [{ gate: "typecheck", rung: "typecheck", passed: false }],
      failures: [{ gate: "typecheck", rung: "typecheck", errorExcerpt: "x" }],
    };
    const c = { ...card("planning") };
    c.display = describeCard(c, { now: NOW, evidence: failed });
    const t = tileModel(c, { now: NOW });
    expect(t.status?.mark).toBe("planning");
    expect(t.status?.tone).not.toBe("fail");
  });
});

describe("the board model, every stored state (DB-N2-1)", () => {
  const all = BOARD_COLUMN_ORDER.map((s) => card(s));

  it("places each stored state in exactly one column, and Rejected behind Won't do", () => {
    const m = boardModel({ cards: all, now: NOW });
    expect(m.columns.map((c) => [c.id, c.cards.map((x) => x.id)])).toEqual([
      ["backlog", ["card_backlog"]],
      ["todo", ["card_ready", "card_planning"]],
      ["in_progress", ["card_in_progress", "card_verify"]],
      ["in_review", ["card_review"]],
      ["done", ["card_done"]],
      ["on_hold", ["card_parked"]],
    ]);
  });

  it("negative: a card in a state no column holds is never drawn, and nothing else moves", () => {
    const m = boardModel({ cards: [...all, card("mystery_state")], now: NOW });
    const ids = m.columns.flatMap((c) => c.cards.map((x) => x.id));
    expect(ids).not.toContain("card_mystery_state");
    expect(ids).toHaveLength(8);
  });

  it("negative: an empty board draws its columns as chips, with no cards anywhere", () => {
    const m = boardModel({ cards: [], now: NOW });
    expect(m.columns.flatMap((c) => c.cards)).toEqual([]);
    expect(m.chips.length).toBeGreaterThan(0);
  });
});

describe("the nav model (DB-N2-1)", () => {
  const views = new Set(["review", "board", "pm", "runs", "configuration", "projects"]);
  const ctx: NavContext = {
    views,
    team: false,
    completedRuns: 1,
    dependencyEdges: 0,
    playbookEntries: 0,
  };

  it("shows exactly the mounted views with something in them, in order", () => {
    expect(visibleNav(ctx).map((i) => i.name)).toEqual([
      "projects",
      "board",
      "review",
      "pm",
      "runs",
      "configuration",
    ]);
  });

  it("negative: a view that is not mounted is never shown, even with content", () => {
    expect(visibleNav({ ...ctx, views: new Set(["board"]) }).map((i) => i.name)).toEqual(["board"]);
  });

  it("negative: a chord with no view shown goes nowhere; an unknown route belongs to no item", () => {
    const shown = visibleNav(ctx);
    expect(chordTarget("z", shown)).toBeUndefined();
    expect(chordTarget("d", shown)).toBeUndefined(); // Dependencies: no edges, not shown
    expect(navNameOf("card")).toBe("");
    expect(navNameOf("nowhere")).toBe("");
    expect(navNameOf("settings")).toBe("configuration");
  });
});
