// Where a dragged card lands (B11), as the neighbours the server's
// fractional index needs: the card it should follow and the one it should
// precede. Pure, so it is tested in node.

/**
 * @param {string[]} ids  the column's card ids in their current order
 * @param {string} dragged  the moving card
 * @param {number} index  the slot it is dropped into, counted in `ids` before the move
 * @returns {{ afterCardId?: string, beforeCardId?: string } | null} null when nothing moves
 */
export function neighboursFor(ids, dragged, index) {
  const from = ids.indexOf(dragged);
  if (from === -1) return null;
  const rest = ids.filter((id) => id !== dragged);
  const at = Math.max(0, Math.min(rest.length, index > from ? index - 1 : index));
  if (at === from) return null;
  const after = rest[at - 1];
  const before = rest[at];
  return { ...(after ? { afterCardId: after } : {}), ...(before ? { beforeCardId: before } : {}) };
}

/** The slot a pointer at `y` falls into, given each tile's vertical midpoint. */
export function dropIndex(midpoints, y) {
  const i = midpoints.findIndex((m) => y < m);
  return i === -1 ? midpoints.length : i;
}
