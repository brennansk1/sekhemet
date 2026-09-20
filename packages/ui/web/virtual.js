// Dual-axis windowing for the board (U6). Pure: tested as-is.
//
// Vertically, a long column renders only the tiles in view plus an overscan;
// horizontally, a column scrolled out of the board's view (beyond one
// viewport of overscan) keeps its header and scroll height but no tiles.

/** First and last (exclusive) row indexes to render for a vertical window. */
export function windowRange(scrollTop, viewport, stride, count, overscan = 3) {
  const first = Math.max(0, Math.floor(scrollTop / stride) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / stride) + overscan);
  return [first, Math.max(first, last)];
}

/**
 * Which columns intersect the horizontal window. `spans` are
 * `{ id, left, width }` in the board's scroll coordinates; the window is the
 * visible area widened by `overscan` pixels on each side.
 */
export function columnsInWindow(spans, scrollLeft, viewport, overscan = viewport / 2) {
  const lo = scrollLeft - overscan;
  const hi = scrollLeft + viewport + overscan;
  return new Set(spans.filter((s) => s.left + s.width > lo && s.left < hi).map((s) => s.id));
}
