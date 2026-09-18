import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { BASALT_THEME, VirtualCanvasManager } from "../src/canvas.js";

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

  it("exports valid Basalt theme surface ladder tokens", () => {
    expect(BASALT_THEME.surfaceBackground).toBe("#121214");
    expect(BASALT_THEME.surfaceRaised).toBe("#18181b");
    expect(BASALT_THEME.accentGreen).toBe("#22c55e");
  });
});
