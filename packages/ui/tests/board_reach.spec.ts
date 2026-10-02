import { describe, expect, it } from "vitest";
import { boardModel } from "../src/columns.js";
import { blockedCardPaths, boardLayout, openColumn } from "../src/reach.js";

/**
 * dashboard DB-P3-17 (DEFINITION_OF_DONE §6.4): at 1440 and 1100 px a
 * developer finds which card is blocked, and why, within three actions. The
 * board's geometry (`BOARD_GEOMETRY`, checked against the served stylesheets
 * in `web_css.spec.ts`) places each column and tile; a blocked tile shows
 * *Blocked* and its cause on its face (DB-P3-6, 7), so reading it costs no
 * action. The browser check of the same layout runs in the sweep.
 */
const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const c = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  status,
  tier: "story",
  title: id,
  ...extra,
});
const range = (n: number, f: (i: number) => ReturnType<typeof c>) =>
  Array.from({ length: n }, (_, i) => f(i));

const cards = [
  ...range(12, (i) =>
    c(`b${i}`, "backlog", i === 11 ? { blockedReason: "Needs the bank's API key" } : {}),
  ),
  ...range(6, (i) =>
    c(`t${i}`, "ready", i === 2 ? { display: { waitsOn: [{ id: "t0", title: "hasher" }] } } : {}),
  ),
  c("p0", "in_progress"),
  c("p1", "in_progress", { blockedReason: "Waiting for the fixture file" }),
  ...range(3, (i) => c(`r${i}`, "review")),
  ...range(20, (i) => c(`d${i}`, "done")),
  c("h0", "parked"),
];
const model = boardModel({ cards, now: NOW });
const paths = (width: number, height: number, dockOpen: boolean) =>
  Object.fromEntries(
    blockedCardPaths(model, { width, height, dockOpen, cycleHeader: true }, { now: NOW }).map(
      (p) => [p.cardId, p.actions],
    ),
  );

describe("the board's layout at a width (DB-P3-17, BRD-01)", () => {
  it("at 1440 px every column is in view: the columns relax to 184 px rather than scroll", () => {
    expect(boardLayout(model.columns, { width: 1440, height: 900, cycleHeader: true })).toEqual({
      mode: "tight",
      colWidth: 192,
      scrollLeft: 0,
      pinned: [],
      visible: ["backlog", "todo", "in_progress", "in_review", "done", "on_hold"],
      underPanel: [],
      rows: 6,
    });
  });

  it("beside the dock the queues sit in their own pane and cover nothing; the board opens on In progress, uncut", () => {
    const l = boardLayout(model.columns, {
      width: 1440,
      height: 900,
      cycleHeader: true,
      dockOpen: true,
    });
    expect(l.mode).toBe("split");
    expect(l.pinned).toEqual(["in_review", "on_hold"]);
    // In progress cannot sit at the left edge (the scroll ends first), so the
    // board opens on the column before it, never on a column cut in half.
    expect(l.scrollLeft).toBe(200);
    expect(l.visible).toEqual(["todo", "in_progress", "in_review", "on_hold"]);
  });

  it("at 1100 px the board opens on In progress at the left edge, with the queues pinned beside it", () => {
    expect(boardLayout(model.columns, { width: 1100, height: 800, cycleHeader: true })).toEqual({
      mode: "split",
      colWidth: 220,
      scrollLeft: 464,
      pinned: ["in_review", "on_hold"],
      visible: ["in_progress", "in_review", "on_hold"],
      underPanel: [],
      rows: 5,
    });
    expect(
      boardLayout(model.columns, { width: 1100, height: 800, cycleHeader: true, dockOpen: true }),
    ).toMatchObject({
      mode: "split",
      scrollLeft: 464,
      visible: ["in_progress"],
      underPanel: ["in_review", "on_hold"],
    });
  });

  it("on a phone one column shows, the first working one, and the switcher reaches the rest", () => {
    expect(boardLayout(model.columns, { width: 400, height: 800 })).toMatchObject({
      mode: "one",
      colWidth: 384,
      scrollLeft: 0,
      pinned: [],
      visible: ["in_progress"],
    });
    expect(openColumn(["backlog", "todo", "in_review"])).toBe("todo");
    expect(openColumn(["backlog"])).toBe("backlog");
    expect(openColumn(["backlog", "todo", "in_progress", "done"])).toBe("in_progress");
  });
});

describe("finding a blocked card and why, within three actions (DB-P3-17)", () => {
  it("names each blocked card's cause as its face shows it", () => {
    expect(
      blockedCardPaths(model, { width: 1440, height: 900 }, { now: NOW }).map((p) => [
        p.cardId,
        p.column,
        p.cause,
      ]),
    ).toEqual([
      ["b11", "backlog", "Blocked · Needs the bank's API key"],
      ["t2", "todo", "Blocked · waits on hasher"],
      ["p1", "in_progress", "Blocked · Waiting for the fixture file"],
    ]);
  });

  it("1440 × 900: in view on the face, or one screen down; the dock narrows the board", () => {
    expect(paths(1440, 900, false)).toEqual({
      b11: ["Scroll Backlog down a screen"],
      t2: [],
      p1: [],
    });
    expect(paths(1440, 900, true)).toEqual({
      b11: ["Scroll the board to Backlog", "Scroll Backlog down a screen"],
      t2: [],
      p1: [],
    });
  });

  it("1100 × 800: three at most; Seshat's panel overlays only the pinned queues, never the scrolled columns", () => {
    const closed = paths(1100, 800, false);
    expect(closed).toEqual({
      b11: [
        "Scroll the board to Backlog",
        "Scroll Backlog down a screen",
        "Scroll Backlog down a screen",
      ],
      t2: ["Scroll the board to To do"],
      p1: [],
    });
    // The panel covers the queue pane at the right, not the columns that scroll.
    expect(paths(1100, 800, true)).toEqual(closed);
  });

  it("takes the filter when it is shorter, and a folded column costs opening its chip", () => {
    const folded = boardModel({ cards, now: NOW, collapsed: new Set(["todo"]) });
    const byId = Object.fromEntries(
      blockedCardPaths(folded, { width: 1440, height: 900 }, { now: NOW }).map((p) => [
        p.cardId,
        p.actions,
      ]),
    );
    expect(byId.t2).toEqual(["Open the To do chip"]);
    // Twelve blocked cards deep in a long Backlog: the filter puts them first.
    const many = boardModel({
      cards: range(30, (i) => c(`x${i}`, "backlog", i >= 18 ? { blockedReason: "No key" } : {})),
      now: NOW,
    });
    const deep = Object.fromEntries(
      blockedCardPaths(many, { width: 1100, height: 800, cycleHeader: true }, { now: NOW }).map(
        (p) => [p.cardId, p.actions],
      ),
    );
    expect(deep.x18).toEqual(["Press / to filter", "Type is:blocked and press Enter"]);
    // The twelfth blocked card in one column is past two screens even filtered.
    expect(deep.x29).toEqual([
      "Press / to filter",
      "Type is:blocked and press Enter",
      "Scroll Backlog down a screen",
      "Scroll Backlog down a screen",
    ]);
  });

  it("every blocked card on the board is within three actions at 1440 and 1100", () => {
    for (const [w, h, dockOpen] of [
      [1440, 900, false],
      [1440, 900, true],
      [1100, 800, false],
    ] as const) {
      for (const p of blockedCardPaths(
        model,
        { width: w, height: h, dockOpen, cycleHeader: true },
        { now: NOW },
      )) {
        expect(
          p.actions.length,
          `${p.cardId} at ${w}${dockOpen ? " beside the panel" : ""}`,
        ).toBeLessThanOrEqual(3);
      }
    }
  });
});
