/**
 * Finding a blocked card from the board, as a layout (dashboard DB-P3-17,
 * DEFINITION_OF_DONE §6.4): where each column and tile sits at a window
 * width, and the fewest actions that bring a blocked card's face — which
 * shows *Blocked* and its cause (DB-P3-6, 7) — into view. The geometry is the
 * served stylesheets' (checked in `web_css.spec.ts`); `board.js` applies the
 * same rules: In review and On hold pinned right when the board overflows,
 * In progress scrolled beside them, Seshat's dock narrowing the board from
 * 1280 px and overlaying it below.
 *
 * The browser loads the compiled module as `/app/lib/reach.js`.
 */
import type { BoardModel, ColumnCardLike } from "./columns.js";
import { type TileCardLike, tileModel } from "./tiles.js";

export const BOARD_GEOMETRY = {
  colMin: { wide: 200, narrow: 220, beside: 184 },
  colMax: 300,
  gap: 8,
  pad: 16,
  colHeader: 36,
  /** The 2 px capacity bar under a limited column's header. */
  capBar: 2,
  listPad: 8,
  /** Compact tiles: the fixed height the windowing relies on (§2.4.4). */
  tile: 88,
  viewBar: 40,
  /** §2.4.13: the cycle header while a cycle is in force. */
  cycleHeader: 56,
  chip: 28,
  chipsTop: 12,
  topbar: 44,
  sidebar: { wide: 216, narrow: 176 },
  dock: { wide: 400, narrow: 380 },
  /** At and above this width the dock sits beside the board; below, over it. */
  besideFrom: 1280,
  phoneBelow: 768,
} as const;

export interface BoardViewport {
  width: number;
  height: number;
  /** Seshat's panel is open (§2.7). */
  dockOpen?: boolean;
  /** A cycle is in force, so its header sits above the board. */
  cycleHeader?: boolean;
}

export interface BoardLayout {
  colWidth: number;
  /** Where the board rests: scrolled so In progress sits beside the pinned queues. */
  scrollLeft: number;
  /** Columns wholly in view, left to right. */
  visible: string[];
  /** Columns that would be in view but for the panel over them (below 1280 px). */
  underPanel: string[];
  /** Tiles wholly in view in a column before it scrolls. */
  rows: number;
}

/** Where the columns sit at a width, as the stylesheets and `board.js` place them. */
export function boardLayout(
  columns: readonly { id: string; queue: boolean }[],
  vp: BoardViewport,
): BoardLayout {
  const G = BOARD_GEOMETRY;
  const phone = vp.width < G.phoneBelow;
  const beside = vp.width >= G.besideFrom;
  const sidebar = phone ? 0 : beside ? G.sidebar.wide : G.sidebar.narrow;
  const dock = vp.dockOpen && !phone ? (beside ? G.dock.wide : G.dock.narrow) : 0;
  const overlay = beside ? 0 : dock;
  const boardW = vp.width - sidebar - (beside ? dock : 0);
  const min = phone
    ? vp.width - 2 * 8
    : !beside
      ? G.colMin.narrow
      : vp.dockOpen
        ? G.colMin.beside
        : G.colMin.wide;
  const n = columns.length;
  const inner = boardW - 2 * G.pad;
  const colWidth = Math.min(
    G.colMax,
    Math.max(min, Math.floor((inner - G.gap * Math.max(0, n - 1)) / Math.max(1, n))),
  );
  const left = (i: number) => G.pad + i * (colWidth + G.gap);
  const overflow = 2 * G.pad + n * colWidth + Math.max(0, n - 1) * G.gap > boardW;
  const pinned = new Set(overflow ? columns.filter((c) => c.queue).map((c) => c.id) : []);
  const right = pinned.size * (colWidth + G.gap);
  // board.js pinQueueColumns: until a person scrolls, In progress is kept
  // just left of the pinned queues.
  let scrollLeft = 0;
  const ip = columns.findIndex((c) => c.id === "in_progress");
  if (overflow && ip >= 0) {
    const end = left(ip) + colWidth;
    const edge = boardW - right;
    if (end > edge) scrollLeft = end - edge + G.gap;
  }
  const fits = (i: number, id: string, cover: number) =>
    pinned.has(id)
      ? cover === 0
      : left(i) >= scrollLeft && left(i) + colWidth <= scrollLeft + boardW - right - cover;
  const visible: string[] = [];
  const underPanel: string[] = [];
  columns.forEach((c, i) => {
    if (fits(i, c.id, overlay)) visible.push(c.id);
    else if (overlay && fits(i, c.id, 0)) underPanel.push(c.id);
  });
  const above = G.topbar + G.viewBar + (vp.cycleHeader ? G.cycleHeader : 0) + G.chipsTop + G.chip;
  const listH = vp.height - above - 2 * G.pad - G.colHeader - G.capBar;
  const rows = Math.max(0, Math.floor(listH / (G.tile + G.gap)));
  return { colWidth, scrollLeft, visible, underPanel, rows };
}

export interface BlockedPath {
  cardId: string;
  column: string;
  /** What the tile's face says: *Blocked* and its cause. */
  cause: string;
  /** The fewest actions to bring that face into view; none when it already is. */
  actions: string[];
}

const FILTER = ["Press / to filter", "Type is:blocked and press Enter"];

/**
 * For each blocked card on the board, the shorter of two ways to its face:
 * scanning (open its column's chip, close the panel over it, scroll the board
 * to it, then a screen at a time down its column) or the `is:blocked` filter
 * (which puts the blocked cards first in each column). Scanning wins a tie.
 */
export function blockedCardPaths<C extends ColumnCardLike & TileCardLike>(
  model: BoardModel<C>,
  vp: BoardViewport,
  ctx: { now: number },
): BlockedPath[] {
  const layout = boardLayout(model.columns, vp);
  const out: BlockedPath[] = [];
  for (const col of [...model.columns, ...model.chips]) {
    const chip = model.chips.includes(col);
    const blocked = col.cards
      .map((card, index) => ({ card, index, blocker: tileModel(card, ctx).blocker }))
      .filter((x) => x.blocker !== undefined);
    blocked.forEach(({ card, index, blocker }, nth) => {
      const reach: string[] = [];
      if (chip) {
        // Opening a chip makes it a column and scrolls it into view (board.js).
        reach.push(`Open the ${col.label} chip`);
      } else if (!layout.visible.includes(col.id)) {
        if (layout.underPanel.includes(col.id)) reach.push("Close the Seshat panel");
        else {
          if (vp.dockOpen && vp.width < BOARD_GEOMETRY.besideFrom)
            reach.push("Close the Seshat panel");
          reach.push(`Scroll the board to ${col.label}`);
        }
      }
      const down = (i: number) =>
        Array.from(
          { length: Math.max(0, Math.ceil((i + 1 - layout.rows) / Math.max(1, layout.rows))) },
          () => `Scroll ${col.label} down a screen`,
        );
      const scan = [...reach, ...down(index)];
      const filtered = [...FILTER, ...reach, ...down(nth)];
      out.push({
        cardId: card.id,
        column: col.id,
        cause: blocker?.text ?? "",
        actions: filtered.length < scan.length ? filtered : scan,
      });
    });
  }
  return out;
}
