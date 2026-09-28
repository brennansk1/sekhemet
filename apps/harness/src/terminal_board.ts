import type { BoardState } from "@sekhemet/board";
import type { CardStatus } from "@sekhemet/kernel";
import { BOARD_COLUMNS, columnLabel } from "@sekhemet/ui";

/**
 * `sekhemet board --terminal` in the board's words (surface NEW-surface-2,
 * SUR-27): NAMING.md's board columns, each card with its stored state's name
 * where a column holds two states, and a WIP limit only where one is set.
 */

/**
 * The stored states' names and the default board's columns: the dashboard's
 * one label map (`vocabulary.ts`, DB-N2-3), never a copy. Won't do is a filter.
 */
const COLUMNS = BOARD_COLUMNS.map((c) => ({
  name: c.label,
  states: c.states,
  onlyWhenNonEmpty: c.onlyWithCards,
}));

/**
 * Above this a limit is a safety cap, not a WIP limit a team set — the same
 * line the dashboard draws (`board.js` `LIMIT_SHOWN`). The backlog's 500 and
 * Done's 10,000 are never shown as limits.
 */
const LIMIT_SHOWN = 20;

function limitOf(state: BoardState, s: CardStatus): number | undefined {
  const l = state.wipLimits[s];
  return typeof l === "number" && l <= LIMIT_SHOWN && s !== "backlog" && s !== "done"
    ? l
    : undefined;
}

export function terminalBoardLines(state: BoardState): string[] {
  const out: string[] = [];
  if (state.backpressureActive) {
    out.push(
      "Review is full: finished cards wait in Verify until you accept, send back or park one.",
      "",
    );
  }
  for (const col of COLUMNS) {
    const cards = state.cards.filter((c) => col.states.includes(c.status));
    if (col.onlyWhenNonEmpty && cards.length === 0) continue;
    const count = (s: CardStatus) => cards.filter((c) => c.status === s).length;
    let heading = `${col.name}  ${cards.length}`;
    if (col.states.length === 1) {
      const limit = limitOf(state, col.states[0] as CardStatus);
      if (limit !== undefined) heading = `${col.name}  ${cards.length}/${limit}`;
    } else {
      const limits = col.states
        .map((s) => ({ s, limit: limitOf(state, s) }))
        .filter((x) => x.limit !== undefined)
        .map((x) => `${columnLabel(x.s)} ${count(x.s)}/${x.limit}`);
      if (limits.length) heading += `  (${limits.join(" · ")})`;
    }
    out.push(heading);
    if (cards.length === 0) out.push("  —");
    for (const c of cards) {
      const stateName = col.states.length > 1 ? `  ${columnLabel(c.status)}` : "";
      out.push(`  ${c.id}  ${c.title}${stateName}  · ${c.stepsUsed}/${c.stepBudget} steps`);
    }
    out.push("");
  }
  return out;
}
