import { expect, it } from "vitest";
import { layoutDag } from "../src/dag_layout.js";

it("routes edges through the middle of custom-height nodes", () => {
  const layout = layoutDag(["p", "q"], [{ from: "p", to: "q" }], {
    nodeWidth: 100,
    nodeHeight: 20,
    rankGap: 50,
    nodeGap: 10,
  });
  expect(layout.edges[0]?.path).toBe("M 100 10 C 125 10 125 10 150 10");
});
