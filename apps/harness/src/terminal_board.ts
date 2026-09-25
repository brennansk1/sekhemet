import type { BoardState } from "@sekhemet/board";
import type { CardStatus } from "@sekhemet/kernel";

/**
 * `sekhemet board --terminal` in the board's words (surface NEW-surface-2,
 * SUR-27): NAMING.md's board columns, each card with its stored state's name
 * where a column holds two states, and a WIP limit only where one is set.
 */

/** The stored states' names, in sentence case (NAMING.md "Card states"). */
export const STATE_NAMES: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  in_progress: "In progress",
  verify: "Verify",
  review: "Review",
  done: "Done",
  parked: "Parked",
  rejected: "Rejected",
};

/** The default board's columns (NAMING.md "Board columns"); Won't do is a filter. */
const COLUMNS: { name: string; states: CardStatus[]; onlyWhenNonEmpty?: boolean }[] = [
  { name: "Backlog", states: ["backlog"] },
  { name: "To do", states: ["ready", "planning"] },
  { name: "In progress", states: ["in_progress", "verify"] },
  { name: "In review", states: ["review"] },
  { name: "Done", states: ["done"] },
  { name: "On hold", states: ["parked"], onlyWhenNonEmpty: true },
];

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
        .map((x) => `${STATE_NAMES[x.s]} ${count(x.s)}/${x.limit}`);
      if (limits.length) heading += `  (${limits.join(" · ")})`;
    }
    out.push(heading);
    if (cards.length === 0) out.push("  —");
    for (const c of cards) {
      const stateName = col.states.length > 1 ? `  ${STATE_NAMES[c.status]}` : "";
      out.push(`  ${c.id}  ${c.title}${stateName}  · ${c.stepsUsed}/${c.stepBudget} steps`);
    }
    out.push("");
  }
  return out;
}
