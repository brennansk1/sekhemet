/**
 * Finding a blocked card from the board, as a layout (dashboard DB-P3-17,
 * DEFINITION_OF_DONE §6.4): where each column and tile sits at a window
 * width, and the fewest actions that bring a blocked card's face — which
 * shows *Blocked* and its cause (DB-P3-6, 7) — into view. The geometry is the
 * served stylesheets' (checked in `web_css.spec.ts`); `board.js` applies the
 * same rules through `boardFit` and `openColumn` (FINDINGS BRD-01): every
 * column in view where the columns fit, relaxing to 184 px at 1280 px and
 * wider; where they do not, In review and On hold in a pane of their own at
 * the right — they cover no column — and the other columns scrolling beside
 * it, opened on the first working column at its left edge; on a phone one
 * column with a column switcher. Seshat's dock narrows the board from
 * 1280 px and overlays it below.
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
  /** On a phone the board's padding (§2.14.3). */
  phonePad: 8,
  /** The queue pane's left hairline (BRD-01). */
  paneRule: 1,
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

/**
 * How the columns sit (BRD-01): `fit` every column at its minimum or wider;
 * `tight` every column, relaxed to 184 px (1280 px and wider, no dock);
 * `split` the queues in their own pane and the rest scrolling beside it;
 * `one` a phone's single column.
 */
export type BoardMode = "fit" | "tight" | "split" | "one";

export interface BoardLayout {
  mode: BoardMode;
  colWidth: number;
  /** Where the scrolling columns rest on open: the first working column at the left edge. */
  scrollLeft: number;
  /** The columns in the queue pane at the right (`split`), which never scroll. */
  pinned: string[];
  /** Columns wholly in view, left to right. */
  visible: string[];
  /** Columns that would be in view but for the panel over them (below 1280 px). */
  underPanel: string[];
  /** Tiles wholly in view in a column before it scrolls. */
  rows: number;
}

/**
 * The column a board opens on (BRD-01: "open on the first working column"):
 * In progress where it shows, else the first column after Backlog, else the first.
 */
export function openColumn(ids: readonly string[]): string | undefined {
  if (ids.includes("in_progress")) return "in_progress";
  return ids.find((id) => id !== "backlog") ?? ids[0];
}

/** The minimum column width the stylesheets set at a width (board.css, pm.css). */
export function columnMin(width: number, dockOpen: boolean): number {
  const G = BOARD_GEOMETRY;
  if (width < G.besideFrom) return G.colMin.narrow;
  return dockOpen ? G.colMin.beside : G.colMin.wide;
}

/**
 * The mode for `n` columns in a board `boardWidth` wide (BRD-01). The board's
 * `board.js` calls it with the measured width; `boardLayout` with the window's.
 */
export function boardFit(
  n: number,
  boardWidth: number,
  vp: { width: number; dockOpen?: boolean },
): { mode: BoardMode; colMin: number } {
  const G = BOARD_GEOMETRY;
  if (vp.width < G.phoneBelow) return { mode: "one", colMin: boardWidth - 2 * G.phonePad };
  const need = (m: number) => 2 * G.pad + n * m + Math.max(0, n - 1) * G.gap;
  const min = columnMin(vp.width, Boolean(vp.dockOpen));
  if (need(min) <= boardWidth) return { mode: "fit", colMin: min };
  if (vp.width >= G.besideFrom && need(G.colMin.beside) <= boardWidth)
    return { mode: "tight", colMin: G.colMin.beside };
  return { mode: "split", colMin: min };
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
  const ids = columns.map((c) => c.id);
  const above = G.topbar + G.viewBar + (vp.cycleHeader ? G.cycleHeader : 0) + G.chipsTop + G.chip;
  const listH = vp.height - above - 2 * G.pad - G.colHeader - G.capBar;
  const rows = Math.max(0, Math.floor(listH / (G.tile + G.gap)));
  const { mode, colMin } = boardFit(columns.length, boardW, vp);
  const open = openColumn(ids);
  if (mode === "one") {
    return {
      mode,
      colWidth: colMin,
      scrollLeft: 0,
      pinned: [],
      visible: open ? [open] : [],
      underPanel: [],
      rows,
    };
  }
  const pinned = mode === "split" ? columns.filter((c) => c.queue).map((c) => c.id) : [];
  const rest = columns.filter((c) => !pinned.includes(c.id));
  // The queue pane: its columns at their minimum, a hairline, its own padding.
  const pane = pinned.length
    ? G.paneRule + 2 * G.pad + pinned.length * colMin + (pinned.length - 1) * G.gap
    : 0;
  const scrollW = boardW - pane;
  const n = rest.length;
  const colWidth = Math.min(
    G.colMax,
    Math.max(
      colMin,
      Math.floor((scrollW - 2 * G.pad - G.gap * Math.max(0, n - 1)) / Math.max(1, n)),
    ),
  );
  const left = (i: number) => G.pad + i * (colWidth + G.gap);
  const maxScroll = Math.max(0, 2 * G.pad + n * colWidth + Math.max(0, n - 1) * G.gap - scrollW);
  // Opened on the first working column at the left edge, one gap in, so no
  // sliver of the column before it shows; where the scroll ends first, on
  // the column before it, so no column opens cut (BRD-01).
  const at = (i: number) => (i === 0 ? 0 : left(i) - G.gap);
  let scrollLeft = 0;
  if (maxScroll > 0) {
    let i = Math.max(
      0,
      rest.findIndex((c) => c.id === open),
    );
    while (i > 0 && at(i) > maxScroll) i--;
    scrollLeft = at(i);
  }
  const visible: string[] = [];
  const underPanel: string[] = [];
  // Below 1280 px the panel covers the board's right edge: the queue pane first.
  const scrollCover = Math.max(0, overlay - pane);
  rest.forEach((c, i) => {
    const inScroll = left(i) >= scrollLeft && left(i) + colWidth <= scrollLeft + scrollW;
    if (!inScroll) return;
    if (left(i) + colWidth <= scrollLeft + scrollW - scrollCover) visible.push(c.id);
    else underPanel.push(c.id);
  });
  pinned.forEach((id, j) => {
    const right = scrollW + G.paneRule + G.pad + j * (colMin + G.gap) + colMin;
    if (right <= boardW - overlay) visible.push(id);
    else underPanel.push(id);
  });
  // Left to right as the person sees them: the scrolling columns, then the pane.
  return { mode, colWidth, scrollLeft, pinned, visible, underPanel, rows };
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
        else if (layout.mode === "one") reach.push(`Open ${col.label} in the column switcher`);
        else {
          // The panel covers the right edge below 1280 px: the queue pane in
          // a split, the columns themselves where they all scroll together.
          if (vp.dockOpen && vp.width < BOARD_GEOMETRY.besideFrom && layout.mode !== "split")
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
