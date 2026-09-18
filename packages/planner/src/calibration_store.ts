import { AssumptionCalibrationLog } from "./calibration.js";
import { type PlannerLedger, appendPlannerEvent, plannerEvents } from "./ledger.js";
import type { AssumptionOverrideRecord, LoggedAssumption } from "./types.js";

/**
 * Trust calibration, persisted (P15, design "Trust calibration"). Every
 * outcome of a logged assumption (kept or overridden by a human) is an
 * `assumption/outcome` event; the calibration log is rebuilt from them, so
 * the 15% assume-to-ask shift accumulates across runs instead of resetting
 * with the process. Assumptions themselves are logged on their cards as
 * `assumption/logged` events plus a dossier note (P8).
 */
export const ASSUMPTION_EVENTS = {
  logged: "assumption/logged",
  outcome: "assumption/outcome",
} as const;

export async function loadCalibrationLog(
  ledger: PlannerLedger,
  options: { threshold?: number; minimumSamples?: number } = {},
): Promise<AssumptionCalibrationLog> {
  const events = await plannerEvents(ledger, [ASSUMPTION_EVENTS.outcome]);
  return new AssumptionCalibrationLog({
    ...options,
    history: events.map((e) => e.payload as AssumptionOverrideRecord),
  });
}

/** Record a human keeping or overriding an assumption; returns the updated log. */
export async function recordAssumptionOutcome(
  ledger: PlannerLedger,
  record: AssumptionOverrideRecord,
): Promise<AssumptionCalibrationLog> {
  await appendPlannerEvent(ledger, ASSUMPTION_EVENTS.outcome, record, {
    cardId: (await ledger.store.getCard(record.cardId)) ? record.cardId : undefined,
    actor: "human",
  });
  return loadCalibrationLog(ledger);
}

/** Every assumption logged on a card (or all of them). */
export async function loggedAssumptions(
  ledger: PlannerLedger,
  cardId?: string,
): Promise<LoggedAssumption[]> {
  const events = await plannerEvents(ledger, [ASSUMPTION_EVENTS.logged]);
  return events
    .map((e) => e.payload as LoggedAssumption)
    .filter((a) => cardId === undefined || a.cardId === cardId);
}
