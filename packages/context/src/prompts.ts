import { workerCopy } from "./worker_copy.js";

/** The Worker's fixed system text (zone 1), from its copy module. */
export const PROMPT_ZONE_1_SYSTEM = workerCopy.system;

export interface TurnHistoryItem {
  turn: number;
  action: string;
  result: string;
}

/**
 * How much of a matched skill reaches Zone 2. `manifest` is the progressive
 * disclosure default under context pressure: one line per skill instead of the
 * full body (§1426-1436).
 */
export type SkillDisclosure = "full" | "manifest";
