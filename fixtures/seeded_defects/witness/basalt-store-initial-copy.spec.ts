import { expect, it } from "vitest";
import { createInitialState } from "../src/store.js";
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

it("copies the cards it is given", () => {
  const input = [card("a")];
  const state = createInitialState(input);
  input.push(card("b"));
  expect(state.cards.map((c) => c.id)).toEqual(["a"]);
});
