/**
 * Null baselines (measurement rule 13, MS-T7-6). The context pruner's null
 * arm lives beside the pruner in `@sekhemet/context` (the prompt assembly
 * calls it behind the RunProfile's `prune` arm); it is re-exported here as
 * part of the measurement API.
 */
export { randomLinePrune } from "@sekhemet/context";
