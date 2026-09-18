/**
 * Lexicographic fractional indexing for manual card ordering (design §2150).
 *
 * WHY not an integer `position` column: dragging one card between two others
 * would renumber every sibling below it. On a board that is one UI gesture
 * turning into N row writes and N events in the immutable log, and two clients
 * reordering concurrently produce an interleaved renumber that silently loses
 * one of the moves. A fractional index writes exactly one row: the moved card
 * gets a string that sorts strictly between its new neighbours, and no sibling
 * is touched. `ORDER BY order_key` is then a plain index scan.
 *
 * Keys are digit strings over an ASCII-ascending alphabet, so SQLite's default
 * BINARY collation orders them identically to `compareOrderKeys` here — the
 * database and the UI cannot disagree about order.
 */

/**
 * Base-62 digits in ASCII order (`0-9` < `A-Z` < `a-z`).
 *
 * Ordering by ASCII is the point: it makes byte comparison, `<` in JS, and
 * SQLite BINARY collation the same relation.
 */
export const ORDER_KEY_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** First key on an empty board — the midpoint of the whole space. */
export const INITIAL_ORDER_KEY = keyBetween(null, null);

/** Byte-wise comparison, matching SQLite BINARY collation. */
export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable ascending sort by `orderKey`, falling back to `id` for ties. */
export function sortByOrderKey<T extends { orderKey?: string | undefined; id: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort((x, y) => {
    const byKey = compareOrderKeys(x.orderKey ?? "", y.orderKey ?? "");
    return byKey !== 0 ? byKey : x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
}

/**
 * Generate a key that sorts strictly after `a` and strictly before `b`.
 *
 * `null` means "unbounded": `keyBetween(null, first)` prepends, `keyBetween(last,
 * null)` appends, `keyBetween(null, null)` seeds an empty column.
 *
 * Throws if `a >= b`, because producing a key for an impossible position would
 * corrupt the ordering invariant silently — the caller has passed neighbours
 * that are not adjacent, or has them backwards.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertValidKey(a);
  if (b !== null) assertValidKey(b);
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: lower bound '${a}' must sort strictly before upper bound '${b}'`);
  }
  return midpoint(a ?? "", b);
}

/**
 * Generate `count` keys strictly between `a` and `b`, evenly interleaved.
 *
 * Used for bulk inserts (a planner decomposition dropping five stories into one
 * column) where calling `keyBetween` in a loop would produce keys that grow a
 * character per item.
 */
export function keysBetween(a: string | null, b: string | null, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(a, b)];

  // Split at the midpoint and recurse both halves so key length grows with
  // log2(count) rather than linearly.
  const mid = Math.floor(count / 2);
  const middle = keyBetween(a, b);
  return [...keysBetween(a, middle, mid), middle, ...keysBetween(middle, b, count - mid - 1)];
}

/**
 * A key is a non-empty digit string that does not end in the lowest digit.
 *
 * WHY the trailing-zero rule: `'1'` and `'10'` denote the same position, so
 * allowing both would make "strictly between" undefined for that pair. Refusing
 * the redundant spelling keeps every position with exactly one representation.
 */
function assertValidKey(key: string): void {
  if (key.length === 0) {
    throw new Error("keyBetween: order key must not be empty");
  }
  for (const char of key) {
    if (!ORDER_KEY_DIGITS.includes(char)) {
      throw new Error(
        `keyBetween: invalid order key '${key}' (character '${char}' not in alphabet)`,
      );
    }
  }
  if (key.endsWith(ORDER_KEY_DIGITS[0] as string)) {
    throw new Error(`keyBetween: invalid order key '${key}' (trailing '${ORDER_KEY_DIGITS[0]}')`);
  }
}

/** Shortest digit string strictly between `a` and `b` (`b === null` = +infinity). */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Carry the shared prefix through untouched and solve the remainder; this
    // is what keeps adjacent keys short instead of appending a digit per move.
    let shared = 0;
    while ((a[shared] ?? ORDER_KEY_DIGITS[0]) === b[shared]) shared++;
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
  }

  const digitA = a.length > 0 ? ORDER_KEY_DIGITS.indexOf(a[0] as string) : 0;
  const digitB = b !== null ? ORDER_KEY_DIGITS.indexOf(b[0] as string) : ORDER_KEY_DIGITS.length;

  if (digitB - digitA > 1) {
    return ORDER_KEY_DIGITS[Math.round(0.5 * (digitA + digitB))] as string;
  }

  // Digits are adjacent: there is no room at this position, so descend.
  if (b !== null && b.length > 1) {
    return b.slice(0, 1);
  }
  return (ORDER_KEY_DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}
