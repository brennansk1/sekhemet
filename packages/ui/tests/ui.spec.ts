import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { VirtualCanvasManager } from "../src/canvas.js";
import { BASALT, SAND, contrastRatio, generateTokenCss } from "../src/tokens.js";

describe("@sekhemet/ui", () => {
  it("computes virtual card geometry and culls off-screen nodes", () => {
    const manager = new VirtualCanvasManager({
      viewportWidth: 800,
      viewportHeight: 600,
      totalColumns: 5,
      columnWidth: 300,
      rowHeight: 120,
    });

    const cards: CardRecord[] = [];
    const now = new Date().toISOString();
    for (let i = 0; i < 50; i++) {
      cards.push({
        id: `card_${i}`,
        tier: "task",
        title: `Task ${i}`,
        status: i % 2 === 0 ? "ready" : "in_progress",
        scopeFiles: ["index.ts"],
        stepBudget: 50,
        stepsUsed: 0,
        createdAt: now,
        updatedAt: now,
      });
    }

    const nodes = manager.layoutCards(cards, 0, 0); // scrollX = 0, scrollY = 0

    expect(nodes.length).toBe(50);
    // Nodes at top should be visible
    const topNode = nodes[0];
    expect(topNode?.isVisible).toBe(true);
    expect(topNode?.width).toBe(300);

    // Nodes far down (e.g. y > 600) should be culled
    const culledNodes = nodes.filter((n) => !n.isVisible);
    expect(culledNodes.length).toBeGreaterThan(0);
  });

  it("exports the specified Basalt and Sand palettes", () => {
    // The design fixes these values; a generic palette is a different product.
    expect(BASALT.bgBase).toBe("#14120F");
    expect(BASALT.accent).toBe("#C8952A"); // Egyptian Gold
    expect(BASALT.statePass).toBe("#4FA36B"); // Nile Green
    // Red Ochre, minimally lifted so it actually clears the AA bar the design
    // claims for it; the doc's own #C9503F measures 4.19:1 on this ground.
    // Lifted once more (from #CC5A4A) so it also clears 4.5:1 on --bg-surface,
    // where evidence panels render failure text; see tokens.spec.ts.
    expect(BASALT.stateFail).toBe("#D2614F");
    expect(BASALT.stateRunning).toBe("#4C8ED9"); // Lapis Lazuli
    expect(SAND.bgBase).toBe("#F6F3EC");

    // Both themes must define every role, or a component falls back to nothing.
    expect(Object.keys(SAND).sort()).toEqual(Object.keys(BASALT).sort());
  });

  it("meets WCAG AA contrast in both themes", () => {
    // Asserting the ratio rather than the claim: body copy needs 7:1, and
    // interactive/state colors need 4.5:1 against the surface they sit on.
    expect(contrastRatio(BASALT.textPrimary, BASALT.bgBase)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(SAND.textPrimary, SAND.bgBase)).toBeGreaterThanOrEqual(7);

    for (const [name, theme] of [
      ["basalt", BASALT],
      ["sand", SAND],
    ] as const) {
      for (const role of ["accent", "statePass", "stateFail", "stateRunning"] as const) {
        const ratio = contrastRatio(theme[role], theme.bgBase);
        expect(ratio, `${name}.${role} contrast ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(theme.textSecondary, theme.bgBase)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("emits every color role as a CSS custom property in both themes", () => {
    const css = generateTokenCss();
    expect(css).toContain("--bg-base: #14120F;");
    expect(css).toContain('[data-theme="sand"]');
    expect(css).toContain("--state-running: #4C8ED9;");
    // Every role must appear as a variable, or a component would hard-code it.
    for (const key of Object.keys(BASALT)) {
      const varName = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
      expect(css, `missing ${varName}`).toContain(`${varName}:`);
    }
  });

  it("windows only the cards intersecting the viewport", () => {
    const manager = new VirtualCanvasManager({
      viewportWidth: 800,
      viewportHeight: 600,
      totalColumns: 6,
      columnWidth: 300,
      rowHeight: 120,
    });

    const now = new Date().toISOString();
    const many: CardRecord[] = Array.from({ length: 600 }, (_, i) => ({
      id: `card_${i}`,
      tier: "task" as const,
      title: `Task ${i}`,
      status: "ready" as const,
      scopeFiles: [],
      stepBudget: 40,
      stepsUsed: 0,
      createdAt: now,
      updatedAt: now,
    }));

    manager.setCards(many);
    const win = manager.window(0, 0);

    // The whole point: 600 cards must not produce 600 nodes.
    expect(win.nodes.length).toBeLessThan(20);
    expect(win.nodes.length).toBeGreaterThan(0);
    // Content height still reflects all 600 rows so the scrollbar is correct.
    expect(win.content.height).toBe(600 * (120 + 16));

    // Scrolling far down yields a different, equally small window.
    const deep = manager.window(0, 20_000);
    expect(deep.nodes.length).toBeLessThan(20);
    expect(deep.nodes[0]?.rowIndex).toBeGreaterThan(100);
    expect(deep.nodes.some((n) => n.card.id === "card_0")).toBe(false);
  });
});
