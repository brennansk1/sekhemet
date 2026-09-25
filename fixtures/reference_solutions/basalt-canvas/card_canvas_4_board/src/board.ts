import { renderCardTile } from "./card_tile.js";
import type { CanvasCard, CardStatus } from "./tokens.js";

export const COLUMNS: CardStatus[] = ["backlog", "ready", "doing", "review", "done"];

export const WIP_LIMITS: Record<CardStatus, number | null> = {
  backlog: null,
  ready: null,
  doing: 3,
  review: 2,
  done: null,
};

export interface ColumnModel {
  status: CardStatus;
  cards: CanvasCard[];
  count: number;
  limit: number | null;
  overLimit: boolean;
  backpressure: boolean;
}

export function buildColumns(cards: CanvasCard[]): ColumnModel[] {
  return COLUMNS.map((status) => {
    const inColumn = cards.filter((c) => c.status === status);
    const limit = WIP_LIMITS[status];
    const count = inColumn.length;
    return {
      status,
      cards: inColumn,
      count,
      limit,
      overLimit: limit !== null && count > limit,
      backpressure: status === "review" && limit !== null && count >= limit,
    };
  });
}

export interface ScrollViewport {
  scrollTop: number;
  height: number;
}

/** The rows a virtualised list renders, with `overscan` rows either side. */
export function visibleRange(
  count: number,
  rowHeight: number,
  viewport: ScrollViewport,
  overscan = 2,
): { start: number; end: number } {
  if (rowHeight <= 0) throw new RangeError("rowHeight must be positive");
  if (count <= 0) return { start: 0, end: 0 };
  const start = Math.min(count, Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - overscan));
  const end = Math.min(
    count,
    Math.ceil((viewport.scrollTop + viewport.height) / rowHeight) + overscan,
  );
  return { start, end };
}

export function renderColumnHeader(column: ColumnModel): string {
  const badge = column.limit === null ? `${column.count}` : `${column.count}/${column.limit}`;
  const badgeClass = column.overLimit ? "wip-badge over-limit" : "wip-badge";
  const warning = column.backpressure
    ? '<span class="backpressure-warning">Review is full</span>'
    : "";
  return `<header><span class="column-name">${column.status}</span><span class="${badgeClass}">${badge}</span>${warning}</header>`;
}

export function renderBoard(cards: CanvasCard[], selectedId: string | null = null): string {
  const columns = buildColumns(cards)
    .map((column) => {
      const tiles = column.cards
        .map((card) => renderCardTile(card, { selected: card.id === selectedId }))
        .join("");
      return `<div class="column" data-status="${column.status}">${renderColumnHeader(column)}${tiles}</div>`;
    })
    .join("");
  return `<section class="board">${columns}</section>`;
}
