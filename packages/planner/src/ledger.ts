import { type BoardService, BoardServiceImpl } from "@sekhemet/board";
import type { CardStatus, CardStore, EventLog, EventRecord } from "@sekhemet/kernel";

/**
 * The planner's durable state lives in the kernel's hash-chained ledger,
 * as events of its own types, and is rebuilt by projection: decisions,
 * goals, calibration outcomes and plan versions survive a restart and are
 * covered by the chain, with no table of their own.
 */
export interface PlannerLedger {
  store: CardStore;
  log: EventLog;
  /**
   * The board every status change goes through (kernel rule 26, K-S4-3).
   * The harness passes its own; without one, a board over the same store
   * with entry conditions on is used.
   */
  board?: Pick<BoardService, "transitionCard">;
}

/**
 * Move a card through the board: a compare-and-set against the status the
 * planner read (`from`), under the transition law, the entry conditions and
 * the WIP limits. The planner never writes a status itself.
 */
export async function moveCard(
  ledger: PlannerLedger,
  move: { cardId: string; from: CardStatus; to: CardStatus; reason: string; actor?: string },
): Promise<void> {
  const board = ledger.board ?? new BoardServiceImpl(ledger.store, { entryConditions: true });
  await board.transitionCard({
    cardId: move.cardId,
    fromStatus: move.from,
    toStatus: move.to,
    actor: move.actor ?? "planner",
    reason: move.reason,
  });
}

export async function appendPlannerEvent<T>(
  ledger: PlannerLedger,
  type: string,
  payload: T,
  options: { cardId?: string | undefined; actor?: string } = {},
): Promise<EventRecord> {
  return ledger.log.append({
    actor: options.actor ?? "planner",
    type,
    payload,
    ...(options.cardId ? { cardId: options.cardId } : {}),
  });
}

export async function plannerEvents(
  ledger: PlannerLedger,
  types: string[],
): Promise<EventRecord[]> {
  return ledger.log.getEventsByTypes(types);
}
