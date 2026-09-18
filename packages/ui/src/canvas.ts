import type { CardRecord, CardStatus } from "@sekhemet/kernel";
import type { CanvasDimensions, ColumnLayout, VirtualCardNode, VirtualWindow } from "./types.js";

export const COLUMN_ORDER: CardStatus[] = [
  "backlog",
  "ready",
  "planning",
  "in_progress",
  "verify",
  "review",
  "done",
  // Parked cards must stay on the board: nothing may block silently.
  "parked",
];

/** Rows rendered beyond each edge of the viewport, so scrolling has no blank frame. */
const DEFAULT_OVERSCAN = 3;
const GAP = 16;

/**
 * Dual-axis windowing for the kanban board.
 *
 * The distinction that matters: this computes geometry only for cards inside the
 * scroll window plus an overscan margin. The previous implementation allocated a
 * node for every card and merely tagged an `isVisible` flag, which is O(N) time
 * and memory per frame — the cost virtualization exists to avoid. At 500+ cards
 * that is the difference between a board that scrolls at 60fps and one that
 * stutters on every wheel event.
 */
export class VirtualCanvasManager {
  private columns = new Map<CardStatus, CardRecord[]>();
  private order: CardStatus[];

  constructor(
    private dimensions: CanvasDimensions,
    columnOrder: CardStatus[] = COLUMN_ORDER,
  ) {
    this.order = columnOrder;
  }

  /** Bucket cards by column once; windowing then costs only what it renders. */
  public setCards(cards: CardRecord[]): void {
    this.columns = new Map(this.order.map((c) => [c, [] as CardRecord[]]));
    for (const card of cards) {
      const bucket = this.columns.get(card.status);
      if (bucket) bucket.push(card);
    }
  }

  public setDimensions(dimensions: CanvasDimensions): void {
    this.dimensions = dimensions;
  }

  private columnX(status: CardStatus): number {
    return Math.max(0, this.order.indexOf(status)) * (this.dimensions.columnWidth + GAP);
  }

  private rowY(index: number): number {
    return index * (this.dimensions.rowHeight + GAP);
  }

  /** Total scrollable extent, so a scrollbar can be sized without rendering rows. */
  public contentSize(): { width: number; height: number } {
    let tallest = 0;
    for (const bucket of this.columns.values()) tallest = Math.max(tallest, bucket.length);
    return {
      width: this.order.length * (this.dimensions.columnWidth + GAP),
      height: this.rowY(tallest),
    };
  }

  /** Per-column counts and offsets, used to render headers without touching rows. */
  public columnLayouts(): ColumnLayout[] {
    return this.order.map((status) => ({
      status,
      x: this.columnX(status),
      width: this.dimensions.columnWidth,
      count: this.columns.get(status)?.length ?? 0,
    }));
  }

  /**
   * Nodes intersecting the scroll window, plus overscan.
   *
   * Columns outside the horizontal window are skipped entirely rather than
   * iterated, which is what makes a wide board with many columns cheap.
   */
  public window(scrollX = 0, scrollY = 0, overscan = DEFAULT_OVERSCAN): VirtualWindow {
    const { columnWidth, rowHeight, viewportWidth, viewportHeight } = this.dimensions;
    const nodes: VirtualCardNode[] = [];

    const rowStride = rowHeight + GAP;
    const firstRow = Math.max(0, Math.floor(scrollY / rowStride) - overscan);
    const visibleRows = Math.ceil(viewportHeight / rowStride) + overscan * 2;

    for (const status of this.order) {
      const x = this.columnX(status);
      // Horizontal culling: skip the whole column before touching its cards.
      if (x + columnWidth < scrollX || x > scrollX + viewportWidth) continue;

      const bucket = this.columns.get(status);
      if (!bucket || bucket.length === 0) continue;

      const lastRow = Math.min(bucket.length, firstRow + visibleRows);
      for (let row = firstRow; row < lastRow; row++) {
        const card = bucket[row];
        if (!card) continue;
        nodes.push({
          card,
          column: status,
          rowIndex: row,
          x,
          y: this.rowY(row),
          width: columnWidth,
          height: rowHeight,
          isVisible: true,
        });
      }
    }

    return {
      nodes,
      columns: this.columnLayouts(),
      content: this.contentSize(),
      firstRow,
      overscan,
    };
  }

  /**
   * Geometry for every card, with an `isVisible` flag.
   *
   * Retained for callers that need a full layout (exports, tests, print views).
   * Interactive rendering should use {@link window}, which is the windowed path.
   */
  public layoutCards(cards: CardRecord[], scrollX = 0, scrollY = 0): VirtualCardNode[] {
    this.setCards(cards);
    const { columnWidth, rowHeight, viewportWidth, viewportHeight } = this.dimensions;
    const nodes: VirtualCardNode[] = [];

    for (const status of this.order) {
      const bucket = this.columns.get(status) ?? [];
      const x = this.columnX(status);

      for (let row = 0; row < bucket.length; row++) {
        const card = bucket[row];
        if (!card) continue;
        const y = this.rowY(row);
        nodes.push({
          card,
          column: status,
          rowIndex: row,
          x,
          y,
          width: columnWidth,
          height: rowHeight,
          isVisible:
            x + columnWidth >= scrollX &&
            x <= scrollX + viewportWidth &&
            y + rowHeight >= scrollY &&
            y <= scrollY + viewportHeight,
        });
      }
    }

    // Preserve input order for callers that index positionally.
    const byId = new Map(nodes.map((n) => [n.card.id, n]));
    return cards.map((c) => byId.get(c.id)).filter((n): n is VirtualCardNode => n !== undefined);
  }
}

export { BASALT_THEME } from "./tokens.js";
