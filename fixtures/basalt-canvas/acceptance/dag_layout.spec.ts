import { describe, expect, it } from "vitest";
import { bezierPath, computeRanks, layoutDag } from "../src/dag_layout.js";

const DIAMOND_IDS = ["a", "b", "c", "d"];
const DIAMOND_EDGES = [
  { from: "a", to: "b" },
  { from: "a", to: "c" },
  { from: "b", to: "d" },
  { from: "c", to: "d" },
];

describe("basalt dag: ranks", () => {
  it("ranks sources at 0 and each node one past its deepest predecessor", () => {
    const ranks = computeRanks(DIAMOND_IDS, DIAMOND_EDGES);
    expect(Object.fromEntries(ranks)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it("uses the longest path, not the shortest", () => {
    const ranks = computeRanks(
      ["a", "b", "c"],
      [
        { from: "a", to: "c" },
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    expect(Object.fromEntries(ranks)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("ranks isolated nodes at 0", () => {
    expect(Object.fromEntries(computeRanks(["x", "y"], []))).toEqual({ x: 0, y: 0 });
  });

  it("rejects a cycle, including a self-loop", () => {
    expect(() =>
      computeRanks(
        ["a", "b"],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).toThrow("cycle detected");
    expect(() => computeRanks(["a"], [{ from: "a", to: "a" }])).toThrow("cycle detected");
  });

  it("rejects an edge that names an unknown node", () => {
    expect(() => computeRanks(["a"], [{ from: "a", to: "ghost" }])).toThrow("unknown node: ghost");
    expect(() => computeRanks(["a"], [{ from: "phantom", to: "a" }])).toThrow(
      "unknown node: phantom",
    );
  });
});

describe("basalt dag: bezier paths", () => {
  it("draws a horizontal S-curve with control points at the midpoint x", () => {
    expect(bezierPath(160, 20, 240, 84)).toBe("M 160 20 C 200 20 200 84 240 84");
  });

  it("handles fractional midpoints and a straight line", () => {
    expect(bezierPath(0, 0, 5, 0)).toBe("M 0 0 C 2.5 0 2.5 0 5 0");
    expect(bezierPath(10, 7, 10, 7)).toBe("M 10 7 C 10 7 10 7 10 7");
  });
});

describe("basalt dag: layout", () => {
  it("places nodes by rank (x) and order within rank (y) with default sizes", () => {
    const layout = layoutDag(DIAMOND_IDS, DIAMOND_EDGES);
    expect(layout.nodes).toEqual([
      { id: "a", rank: 0, order: 0, x: 0, y: 0, width: 160, height: 40 },
      { id: "b", rank: 1, order: 0, x: 240, y: 0, width: 160, height: 40 },
      { id: "c", rank: 1, order: 1, x: 240, y: 64, width: 160, height: 40 },
      { id: "d", rank: 2, order: 0, x: 480, y: 0, width: 160, height: 40 },
    ]);
    expect(layout.width).toBe(640);
    expect(layout.height).toBe(104);
  });

  it("routes each edge from the source's right middle to the target's left middle", () => {
    const layout = layoutDag(DIAMOND_IDS, DIAMOND_EDGES);
    expect(layout.edges).toEqual([
      { from: "a", to: "b", path: "M 160 20 C 200 20 200 20 240 20" },
      { from: "a", to: "c", path: "M 160 20 C 200 20 200 84 240 84" },
      { from: "b", to: "d", path: "M 400 20 C 440 20 440 20 480 20" },
      { from: "c", to: "d", path: "M 400 84 C 440 84 440 20 480 20" },
    ]);
  });

  it("honours custom sizes and gaps", () => {
    const layout = layoutDag(["p", "q", "r"], [{ from: "p", to: "q" }], {
      nodeWidth: 100,
      nodeHeight: 20,
      rankGap: 50,
      nodeGap: 10,
    });
    expect(layout.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["p", 0, 0],
      ["q", 150, 0],
      ["r", 0, 30],
    ]);
    expect(layout.width).toBe(250);
    expect(layout.height).toBe(50);
  });

  it("returns a zero-size layout for an empty graph", () => {
    expect(layoutDag([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("sizes a single node exactly to the node", () => {
    const layout = layoutDag(["solo"], []);
    expect([layout.width, layout.height]).toEqual([160, 40]);
  });

  it("propagates cycle errors from ranking", () => {
    expect(() =>
      layoutDag(
        ["a", "b"],
        [
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      ),
    ).toThrow("cycle detected");
  });
});
