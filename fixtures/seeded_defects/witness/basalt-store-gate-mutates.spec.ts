import { expect, it } from "vitest";
import { createInitialState, reduce } from "../src/store.js";
import type { CanvasCard } from "../src/tokens.js";

function card(id: string): CanvasCard {
  return {
    id,
    title: `Card ${id}`,
    status: "ready",
    cardClass: "feature",
    difficulty: 2,
    stepsUsed: 0,
    stepBudget: 32,
    gates: {
      typecheck: "pending",
      lint: "pending",
      test: "pending",
      bounds: "pending",
      visual: "pending",
    },
    dependsOn: [],
  };
}

it("does not mutate the previous state when a gate changes", () => {
  const before = createInitialState([card("a")]);
  const snapshot = structuredClone(before);
  reduce(before, { type: "updateGate", id: "a", gate: "test", state: "fail" });
  expect(before).toEqual(snapshot);
});
