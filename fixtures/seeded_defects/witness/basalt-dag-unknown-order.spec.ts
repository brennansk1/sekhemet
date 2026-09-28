import { expect, it } from "vitest";
import { computeRanks } from "../src/dag_layout.js";

it("names the edge's source first when both ends are unknown", () => {
  expect(() => computeRanks(["a"], [{ from: "p", to: "q" }])).toThrow("unknown node: p");
});
