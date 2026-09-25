import { describe, expect, it } from "vitest";
import { auditTheme, buildDag, dragCard, renderApp } from "../src/app.js";
import { createInitialState } from "../src/store.js";
import { type CanvasCard, THEME } from "../src/tokens.js";

// HELD OUT (measurement T11, MS-T7-8): never shown to the Planner, Seshat or
// the Worker. Project-level checks of Basalt Canvas — a readable, safe board
// that respects dependencies — that no card's acceptance test makes through
// the app. DRAFT until a person confirms it.

const card = (id: string, over: Partial<CanvasCard> = {}): CanvasCard => ({
  id,
  title: id,
  status: "ready",
  cardClass: "feature",
  difficulty: 2,
  stepsUsed: 0,
  stepBudget: 10,
  gates: {
    typecheck: "pending",
    lint: "pending",
    test: "pending",
    bounds: "pending",
    visual: "pending",
  },
  dependsOn: [],
  ...over,
});

describe("held out: basalt canvas as a whole", () => {
  it("ships a theme whose every text and accent pair meets its contrast requirement", () => {
    const failing = auditTheme(THEME).filter((c) => !c.pass);
    expect(failing).toEqual([]);
  });

  it("never renders a card title as markup", () => {
    const html = renderApp(
      createInitialState([card("x", { title: '<img src=x onerror="alert(1)">' })]),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("lets a card into Doing only once what it depends on is done", () => {
    const a = card("a");
    const b = card("b", { dependsOn: ["a"] });
    const blocked = dragCard(createInitialState([a, b]), "b", "doing");
    expect(blocked.ok).toBe(false);
    const done = dragCard(createInitialState([{ ...a, status: "done" }, b]), "b", "doing");
    expect(done.ok).toBe(true);
  });

  it("draws a dependency before the card that needs it", () => {
    const layout = buildDag([card("b", { dependsOn: ["a"] }), card("a")]);
    const rank = (id: string) => layout.nodes.find((n) => n.id === id)?.rank ?? -1;
    expect(rank("a")).toBeLessThan(rank("b"));
  });
});
