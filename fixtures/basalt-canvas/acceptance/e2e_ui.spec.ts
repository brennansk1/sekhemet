import { describe, expect, it } from "vitest";
import { auditTheme, buildDag, clickCard, contrastRatio, dragCard, renderApp } from "../src/app.js";
import { hitTest, renderDagSvg, zoomAt } from "../src/dag_canvas.js";
import { type BoardState, createInitialState, reduce } from "../src/store.js";
import { type CanvasCard, type CardStatus, THEME } from "../src/tokens.js";

function card(id: string, status: CardStatus, dependsOn: string[] = []): CanvasCard {
  return {
    id,
    title: `Card ${id}`,
    status,
    cardClass: "feature",
    difficulty: 2,
    stepsUsed: 4,
    stepBudget: 32,
    gates: { typecheck: "pass", lint: "pass", test: "pending", bounds: "pass", visual: "pass" },
    dependsOn,
  };
}

function board(): BoardState {
  return createInitialState([
    card("types", "done"),
    card("store", "doing", ["types"]),
    card("tile", "ready", ["types"]),
    card("board", "ready", ["tile", "store"]),
    card("docs", "backlog"),
  ]);
}

describe("basalt e2e: WCAG 2.1 contrast", () => {
  it("computes the reference ratios exactly (rounded to 2 decimals)", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBe(21);
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    expect(contrastRatio("#777777", "#FFFFFF")).toBe(4.48);
    expect(contrastRatio("#14120F", "#14120F")).toBe(1);
  });

  it("accepts lower-case hex and rejects malformed colors", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(() => contrastRatio("#FFF", "#000000")).toThrow("invalid color: #FFF");
    expect(() => contrastRatio("#000000", "red")).toThrow("invalid color: red");
  });

  it("audits every Basalt text and accent pair and all of them pass AA", () => {
    expect(auditTheme(THEME)).toEqual([
      { pair: "textPrimary/bgBase", ratio: 15.08, required: 4.5, pass: true },
      { pair: "textPrimary/bgSurface", ratio: 14.01, required: 4.5, pass: true },
      { pair: "textPrimary/bgRaised", ratio: 12.93, required: 4.5, pass: true },
      { pair: "textPrimary/bgOverlay", ratio: 11.81, required: 4.5, pass: true },
      { pair: "textMuted/bgBase", ratio: 6.73, required: 4.5, pass: true },
      { pair: "textMuted/bgSurface", ratio: 6.25, required: 4.5, pass: true },
      { pair: "textMuted/bgRaised", ratio: 5.77, required: 4.5, pass: true },
      { pair: "gold/bgRaised", ratio: 5.95, required: 3, pass: true },
      { pair: "nile/bgRaised", ratio: 5.18, required: 3, pass: true },
      { pair: "ochre/bgRaised", ratio: 3.59, required: 3, pass: true },
      { pair: "lapis/bgRaised", ratio: 4.72, required: 3, pass: true },
    ]);
  });

  it("fails exactly the pairs broken by a low-contrast muted text color", () => {
    const failing = auditTheme({ ...THEME, textMuted: "#3A362F" })
      .filter((c) => !c.pass)
      .map((c) => c.pair);
    expect(failing).toEqual(["textMuted/bgBase", "textMuted/bgSurface", "textMuted/bgRaised"]);
  });
});

describe("basalt e2e: drag and click transitions", () => {
  it("moves a card whose dependencies are done", () => {
    const result = dragCard(board(), "tile", "doing");
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.state.cards.find((c) => c.id === "tile")?.status).toBe("doing");
  });

  it("blocks moving into Doing while a dependency is not done", () => {
    const start = board();
    const result = dragCard(start, "board", "doing");
    expect(result).toEqual({ state: start, ok: false, reason: "blocked by tile" });
  });

  it("enforces the WIP limit of the destination column", () => {
    let s = board();
    s = reduce(s, { type: "addCard", card: card("x1", "review") });
    s = reduce(s, { type: "addCard", card: card("x2", "review") });
    const result = dragCard(s, "store", "review");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("WIP limit reached for review");
    expect(result.state).toBe(s);
  });

  it("allows moves into unlimited columns and reports unknown cards", () => {
    expect(dragCard(board(), "docs", "done").ok).toBe(true);
    const missing = dragCard(board(), "ghost", "done");
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("unknown card: ghost");
  });

  it("treats dropping a card on its own column as a successful no-op", () => {
    const s = board();
    expect(dragCard(s, "store", "doing")).toEqual({ state: s, ok: true, reason: null });
  });

  it("selects on click and deselects on a second click", () => {
    const once = clickCard(board(), "tile");
    expect(once.selectedId).toBe("tile");
    const twice = clickCard(once, "tile");
    expect(twice.selectedId).toBeNull();
    expect(twice.history).toEqual(["tile"]);
  });
});

describe("basalt e2e: rendering and layout geometry", () => {
  it("renders the filtered board with the selected tile inside main", () => {
    let s = clickCard(board(), "store");
    s = reduce(s, { type: "setFilter", filter: { text: "s" } });
    const html = renderApp(s);
    expect(html.startsWith('<main class="app"><section class="board">')).toBe(true);
    expect(html.endsWith("</section></main>")).toBe(true);
    expect(html.match(/<article /g)?.length).toBe(3);
    expect(html.includes('<article class="card-tile is-selected" data-id="store"')).toBe(true);
    expect(html.includes('data-id="tile"')).toBe(false);
  });

  it("lays out the dependency DAG from dependsOn", () => {
    const dag = buildDag(board().cards);
    expect(dag.nodes.map((n) => [n.id, n.rank, n.order, n.x, n.y])).toEqual([
      ["types", 0, 0, 0, 0],
      ["store", 1, 0, 240, 0],
      ["tile", 1, 1, 240, 64],
      ["board", 2, 0, 480, 0],
      ["docs", 0, 1, 0, 64],
    ]);
    expect(dag.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      "types->store",
      "types->tile",
      "tile->board",
      "store->board",
    ]);
    expect([dag.width, dag.height]).toEqual([640, 104]);
  });

  it("rejects a dependency on a card that is not on the board", () => {
    expect(() => buildDag([card("a", "ready", ["missing"])])).toThrow("unknown node: missing");
  });

  it("clicks a DAG node after zooming and renders it selected", () => {
    const dag = buildDag(board().cards);
    const view = zoomAt({ x: 0, y: 0, scale: 1 }, 2, { x: 0, y: 0 });
    const hit = hitTest(dag, view, { x: 2 * 250, y: 2 * 70 });
    expect(hit).toBe("tile");
    const s = clickCard(board(), hit ?? "");
    const svg = renderDagSvg(dag, view, s.selectedId);
    expect(svg.includes('<g class="node is-selected" data-id="tile">')).toBe(true);
    expect(svg.match(/is-selected/g)?.length).toBe(1);
  });
});
