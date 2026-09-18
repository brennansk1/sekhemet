import type { CardStore, EventLog, EventRecord } from "@sekhemet/kernel";

/**
 * The planner's durable state lives in the kernel's hash-chained ledger,
 * as events of its own types, and is rebuilt by projection: decisions,
 * goals, calibration outcomes and plan versions survive a restart and are
 * covered by the chain, with no table of their own.
 */
export interface PlannerLedger {
  store: CardStore;
  log: EventLog;
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
