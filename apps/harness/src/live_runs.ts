import type { AttemptRecord } from "@sekhemet/kernel";
import { runnerLease } from "./runner_lease.js";
import { liveSlotLeases } from "./slot_lease.js";

const RUN_COLUMNS = new Set(["planning", "in_progress", "verify"]);

/**
 * The cards a run backs right now (dashboard §2.1.6, §2.2.3; wave 2 A1): a
 * live runner lease or slot lease names the card (a run between its claim
 * and its first attempt included), or its latest attempt is running on the
 * ledger while some runner or slot lease of the workspace is alive (a runner
 * killed by the memory guard, OOM or sleep leaves its attempt "running"
 * until the next supervisor sweep, with no process behind it). A card merely stored In progress — a person's move, a seed, an
 * import — has none, and no view may call it the Agent's work. The board
 * carries this as each card's `liveRun`, and Projects reads it too.
 */
export function liveRunCardIds(o: {
  repoPath?: string | undefined;
  runs?: { listAttempts(cardId: string): AttemptRecord[] } | undefined;
  cards: readonly { id: string; status: string }[];
}): Set<string> {
  const live = new Set<string>();
  let held = false;
  if (o.repoPath) {
    const runner = runnerLease(o.repoPath);
    if (runner?.cardId) live.add(runner.cardId);
    const slots = liveSlotLeases(o.repoPath);
    for (const slot of slots) live.add(slot.cardId);
    held = runner !== undefined || slots.length > 0;
  }
  if (o.runs && held) {
    for (const c of o.cards) {
      // An attempt runs only while its card is being planned, built or checked.
      if (!RUN_COLUMNS.has(c.status) || live.has(c.id)) continue;
      if (o.runs.listAttempts(c.id).at(-1)?.status === "running") live.add(c.id);
    }
  }
  return live;
}
