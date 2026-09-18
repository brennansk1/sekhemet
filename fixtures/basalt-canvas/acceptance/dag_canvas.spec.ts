import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  type Viewport,
  hitTest,
  pan,
  renderDagSvg,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "../src/dag_canvas.js";
import type { DagLayout } from "../src/dag_layout.js";

/** Two overlapping nodes: b is drawn after a, so b is on top. */
const LAYOUT: DagLayout = {
  nodes: [
    { id: "a", rank: 0, order: 0, x: 0, y: 0, width: 160, height: 40 },
    { id: "b", rank: 1, order: 0, x: 100, y: 20, width: 160, height: 40 },
  ],
  edges: [{ from: "a", to: "b", path: "M 160 20 C 130 20 130 40 100 40" }],
  width: 260,
  height: 60,
};

const VIEW: Viewport = { x: 10, y: 10, scale: 2 };

describe("basalt dag canvas: coordinate transforms", () => {
  it("maps world to screen and back", () => {
    expect(worldToScreen(VIEW, { x: 50, y: 10 })).toEqual({ x: 110, y: 30 });
    expect(screenToWorld(VIEW, { x: 110, y: 30 })).toEqual({ x: 50, y: 10 });
  });

  it("pans by a screen delta without changing scale or mutating the input", () => {
    const v = { x: 0, y: 0, scale: 1.5 };
    expect(pan(v, 30, -12)).toEqual({ x: 30, y: -12, scale: 1.5 });
    expect(v).toEqual({ x: 0, y: 0, scale: 1.5 });
  });

  it("defines the zoom limits", () => {
    expect(MIN_SCALE).toBe(0.25);
    expect(MAX_SCALE).toBe(4);
  });
});

describe("basalt dag canvas: zoom", () => {
  it("zooms about the anchor so the point under the cursor stays put", () => {
    const v = zoomAt({ x: 0, y: 0, scale: 1 }, 2, { x: 100, y: 50 });
    expect(v).toEqual({ x: -100, y: -50, scale: 2 });
    expect(worldToScreen(v, { x: 100, y: 50 })).toEqual({ x: 100, y: 50 });
  });

  it("zooms out about an anchor", () => {
    expect(zoomAt({ x: -100, y: -50, scale: 2 }, 0.5, { x: 100, y: 50 })).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it("clamps the scale to MAX_SCALE and keeps the anchor fixed", () => {
    const v = zoomAt({ x: 10, y: 10, scale: 3 }, 2, { x: 10, y: 10 });
    expect(v).toEqual({ x: 10, y: 10, scale: 4 });
  });

  it("clamps the scale to MIN_SCALE", () => {
    expect(zoomAt({ x: 0, y: 0, scale: 0.5 }, 0.25, { x: 0, y: 0 }).scale).toBe(0.25);
  });

  it("rejects a zero, negative or NaN zoom factor", () => {
    const v = { x: 0, y: 0, scale: 1 };
    expect(() => zoomAt(v, 0, { x: 0, y: 0 })).toThrow("zoom factor must be positive");
    expect(() => zoomAt(v, -2, { x: 0, y: 0 })).toThrow(RangeError);
    expect(() => zoomAt(v, Number.NaN, { x: 0, y: 0 })).toThrow(RangeError);
  });
});

describe("basalt dag canvas: hit testing", () => {
  it("returns the node under a screen point, honouring the viewport", () => {
    expect(hitTest(LAYOUT, VIEW, { x: 110, y: 30 })).toBe("a");
  });

  it("returns the topmost (last drawn) node where nodes overlap", () => {
    expect(hitTest(LAYOUT, VIEW, { x: 250, y: 70 })).toBe("b");
  });

  it("treats the left/top edges as inside and the right/bottom edges as outside", () => {
    expect(hitTest(LAYOUT, VIEW, { x: 10, y: 10 })).toBe("a");
    expect(hitTest(LAYOUT, VIEW, { x: 330, y: 30 })).toBeNull();
  });

  it("returns null for empty space and for an empty layout", () => {
    expect(hitTest(LAYOUT, VIEW, { x: 0, y: 0 })).toBeNull();
    expect(
      hitTest({ nodes: [], edges: [], width: 0, height: 0 }, VIEW, { x: 20, y: 20 }),
    ).toBeNull();
  });
});

describe("basalt dag canvas: SVG rendering", () => {
  it("renders edges before nodes inside a transformed group", () => {
    expect(renderDagSvg(LAYOUT, VIEW, null)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="260" height="60">' +
        '<g transform="translate(10 10) scale(2)">' +
        '<path class="edge" d="M 160 20 C 130 20 130 40 100 40"/>' +
        '<g class="node" data-id="a"><rect x="0" y="0" width="160" height="40" rx="4"/><text x="8" y="20">a</text></g>' +
        '<g class="node" data-id="b"><rect x="100" y="20" width="160" height="40" rx="4"/><text x="108" y="40">b</text></g>' +
        "</g></svg>",
    );
  });

  it("marks only the selected node", () => {
    const svg = renderDagSvg(LAYOUT, { x: 0, y: 0, scale: 1 }, "b");
    expect(svg.includes('<g class="node is-selected" data-id="b">')).toBe(true);
    expect(svg.includes('<g class="node" data-id="a">')).toBe(true);
    expect(svg.includes("translate(0 0) scale(1)")).toBe(true);
  });

  it("escapes node ids in attributes and labels", () => {
    const hostile: DagLayout = {
      nodes: [{ id: "<x>", rank: 0, order: 0, x: 0, y: 0, width: 10, height: 10 }],
      edges: [],
      width: 10,
      height: 10,
    };
    const svg = renderDagSvg(hostile, { x: 0, y: 0, scale: 1 }, null);
    expect(svg.includes("<x>")).toBe(false);
    expect(svg.includes('data-id="&lt;x&gt;"')).toBe(true);
    expect(svg.includes(">&lt;x&gt;</text>")).toBe(true);
  });
});
