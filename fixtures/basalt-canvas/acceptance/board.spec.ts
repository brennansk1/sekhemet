import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  WIP_LIMITS,
  buildColumns,
  renderBoard,
  renderColumnHeader,
  visibleRange,
} from "../src/board.js";
import { renderCardTile } from "../src/card_tile.js";
import type { CanvasCard, CardStatus } from "../src/tokens.js";

function card(id: string, status: CardStatus): CanvasCard {
  return {
    id,
    title: `Card ${id}`,
    status,
    cardClass: "feature",
    difficulty: 1,
    stepsUsed: 0,
    stepBudget: 32,
    gates: { typecheck: "pass", lint: "pass", test: "pass", bounds: "pass", visual: "pass" },
    dependsOn: [],
  };
}

describe("basalt board: column model", () => {
  it("defines the five columns and their WIP limits", () => {
    expect(COLUMNS).toEqual(["backlog", "ready", "doing", "review", "done"]);
    expect(WIP_LIMITS).toEqual({ backlog: null, ready: null, doing: 3, review: 2, done: null });
  });

  it("groups cards by status, preserving input order", () => {
    const cols = buildColumns([card("a", "doing"), card("b", "ready"), card("c", "doing")]);
    expect(cols.map((c) => c.status)).toEqual(COLUMNS);
    expect(cols.map((c) => c.count)).toEqual([0, 1, 2, 0, 0]);
    expect(cols[2]?.cards.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("flags a column only when its count exceeds the limit", () => {
    const atLimit = buildColumns(["a", "b", "c"].map((id) => card(id, "doing")));
    expect(atLimit[2]?.overLimit).toBe(false);
    const over = buildColumns(["a", "b", "c", "d"].map((id) => card(id, "doing")));
    expect(over[2]?.overLimit).toBe(true);
    expect(over[0]?.overLimit).toBe(false);
  });

  it("raises Review backpressure when Review reaches its limit, not before", () => {
    expect(buildColumns([card("a", "review")])[3]?.backpressure).toBe(false);
    const full = buildColumns([card("a", "review"), card("b", "review")]);
    expect(full[3]).toMatchObject({ count: 2, limit: 2, backpressure: true, overLimit: false });
  });

  it("never raises backpressure on a column other than Review", () => {
    const cols = buildColumns(["a", "b", "c", "d"].map((id) => card(id, "doing")));
    expect(cols.map((c) => c.backpressure)).toEqual([false, false, false, false, false]);
  });
});

describe("basalt board: virtualization", () => {
  it("computes the visible row window with the default overscan of 2", () => {
    expect(visibleRange(1000, 40, { scrollTop: 400, height: 200 })).toEqual({ start: 8, end: 17 });
  });

  it("clamps the window at the top and bottom of the list", () => {
    expect(visibleRange(1000, 40, { scrollTop: 0, height: 200 })).toEqual({ start: 0, end: 7 });
    expect(visibleRange(10, 40, { scrollTop: 300, height: 200 })).toEqual({ start: 5, end: 10 });
  });

  it("honours a custom overscan, including zero", () => {
    expect(visibleRange(1000, 40, { scrollTop: 400, height: 200 }, 0)).toEqual({
      start: 10,
      end: 15,
    });
  });

  it("returns an empty window for an empty list", () => {
    expect(visibleRange(0, 40, { scrollTop: 0, height: 200 })).toEqual({ start: 0, end: 0 });
  });

  it("rejects a non-positive row height", () => {
    expect(() => visibleRange(10, 0, { scrollTop: 0, height: 200 })).toThrow(
      "rowHeight must be positive",
    );
    expect(() => visibleRange(10, -5, { scrollTop: 0, height: 200 })).toThrow(RangeError);
  });
});

describe("basalt board: rendering", () => {
  it("renders a header with a limit badge", () => {
    const [, , doing] = buildColumns([card("a", "doing")]);
    if (!doing) throw new Error("missing column");
    expect(renderColumnHeader(doing)).toBe(
      '<header><span class="column-name">doing</span><span class="wip-badge">1/3</span></header>',
    );
  });

  it("renders an unlimited column badge as a bare count", () => {
    const [backlog] = buildColumns([card("a", "backlog"), card("b", "backlog")]);
    if (!backlog) throw new Error("missing column");
    expect(renderColumnHeader(backlog)).toBe(
      '<header><span class="column-name">backlog</span><span class="wip-badge">2</span></header>',
    );
  });

  it("renders the over-limit badge and the Review backpressure warning", () => {
    const cols = buildColumns([
      ...["a", "b", "c", "d"].map((id) => card(id, "doing")),
      card("r1", "review"),
      card("r2", "review"),
    ]);
    expect(renderColumnHeader(cols[2] as (typeof cols)[number])).toBe(
      '<header><span class="column-name">doing</span><span class="wip-badge over-limit">4/3</span></header>',
    );
    expect(renderColumnHeader(cols[3] as (typeof cols)[number])).toBe(
      '<header><span class="column-name">review</span><span class="wip-badge">2/2</span><span class="backpressure-warning">Review is full</span></header>',
    );
  });

  it("renders all five columns in order with their tiles", () => {
    const a = card("a", "ready");
    const html = renderBoard([a]);
    expect(
      html.startsWith('<section class="board"><div class="column" data-status="backlog">'),
    ).toBe(true);
    expect(html.endsWith("</div></section>")).toBe(true);
    expect(html.match(/<div class="column" /g)?.length).toBe(5);
    expect(
      html.includes(
        `<div class="column" data-status="ready"><header><span class="column-name">ready</span><span class="wip-badge">1</span></header>${renderCardTile(a)}</div>`,
      ),
    ).toBe(true);
  });

  it("marks only the selected card's tile as selected", () => {
    const html = renderBoard([card("a", "ready"), card("b", "ready")], "b");
    expect(html.match(/is-selected/g)?.length).toBe(1);
    expect(html.includes('<article class="card-tile is-selected" data-id="b"')).toBe(true);
  });
});
