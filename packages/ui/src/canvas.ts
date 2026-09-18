import type { CardRecord, CardStatus } from "@sekhemet/kernel";
import type { BasaltThemeTokens, CanvasDimensions, VirtualCardNode } from "./types.js";

export const BASALT_THEME: BasaltThemeTokens = {
  surfaceBackground: "#121214",
  surfaceRaised: "#18181b",
  surfaceOverlay: "#27272a",
  borderSubtle: "#3f3f46",
  textPrimary: "#fafafa",
  textMuted: "#a1a1aa",
  accentGreen: "#22c55e",
  accentRed: "#ef4444",
  accentAmber: "#f59e0b",
};

const COLUMN_ORDER: CardStatus[] = ["backlog", "ready", "in_progress", "verify", "review", "done"];

export class VirtualCanvasManager {
  constructor(private dimensions: CanvasDimensions) {}

  public layoutCards(cards: CardRecord[], scrollX = 0, scrollY = 0): VirtualCardNode[] {
    const nodes: VirtualCardNode[] = [];
    const columnCardCounts: Partial<Record<CardStatus, number>> = {};

    const colWidth = this.dimensions.columnWidth;
    const rowHeight = this.dimensions.rowHeight;
    const gap = 16;

    for (const card of cards) {
      const col = card.status;
      const colIndex = Math.max(0, COLUMN_ORDER.indexOf(col));
      const rowIndex = columnCardCounts[col] ?? 0;
      columnCardCounts[col] = rowIndex + 1;

      const x = colIndex * (colWidth + gap);
      const y = rowIndex * (rowHeight + gap);

      // Check viewport visibility
      const isVisible =
        x + colWidth >= scrollX &&
        x <= scrollX + this.dimensions.viewportWidth &&
        y + rowHeight >= scrollY &&
        y <= scrollY + this.dimensions.viewportHeight;

      nodes.push({
        card,
        column: col,
        x,
        y,
        width: colWidth,
        height: rowHeight,
        isVisible,
      });
    }

    return nodes;
  }
}
