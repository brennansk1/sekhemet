import type { CardStore, EventLog } from "@sekhemet/kernel";
import { DISK_FULL_FREE, describeError, isDiskFull } from "../process_errors.js";

/** Why a plan created nothing, for the person applying it. */
export class PipelineRefusal extends Error {
  constructor(
    message: string,
    /** The step that moves things on (surface item 18b's `Do:` line). */
    readonly next?: string,
  ) {
    super(message);
    this.name = "PipelineRefusal";
  }
}

/**
 * A plan that stopped partway (wave 9 A2, sweep 5): the ledger is
 * append-only, so what it wrote stays — its epic and first issues, with no
 * `plan/created` — and is named here, with the step that moves things on,
 * never left as if planned behind a bare *stopped*.
 */
export class UnfinishedPlanRefusal extends PipelineRefusal {
  constructor(
    message: string,
    next: string,
    /** The cards the stopped plan kept. */
    readonly kept: string[],
    /** What stopped it. */
    readonly stoppedBy: unknown,
  ) {
    super(message, next);
    this.name = "UnfinishedPlanRefusal";
  }
}

/** What a plan write has to know to name itself if it stops partway. */
export interface PlanWrite {
  epicId: string;
  /** The epic was made for this plan (not one it plans under). */
  madeEpic: boolean;
  /** Card ids before the plan wrote anything. */
  before: ReadonlySet<string>;
  /** `plan/created` events for this epic before the plan wrote anything. */
  plansBefore: number;
}

async function plansFor(log: EventLog, epicId: string): Promise<number> {
  const events = await log.getEventsByTypes(["plan/created"]);
  return events.filter((e) => (e.payload as { epicId?: string }).epicId === epicId).length;
}

/** Start a plan write: what exists before it, to name what it kept if it stops. */
export async function beginPlanWrite(
  store: CardStore,
  log: EventLog,
  epicId: string,
  madeEpic: boolean,
): Promise<PlanWrite> {
  return {
    epicId,
    madeEpic,
    before: new Set((await store.listCards()).map((c) => c.id)),
    plansBefore: await plansFor(log, epicId),
  };
}

/**
 * The error a plan write that threw should surface: an
 * {@link UnfinishedPlanRefusal} naming the cards it kept when it kept any
 * and recorded no plan; the error itself otherwise (nothing was kept, or the
 * plan was recorded and only a later step failed).
 */
export async function unfinishedPlan(
  store: CardStore,
  log: EventLog,
  write: PlanWrite,
  err: unknown,
): Promise<unknown> {
  if (err instanceof PipelineRefusal) return err;
  let kept: { id: string; tier?: string }[];
  try {
    if ((await plansFor(log, write.epicId)) > write.plansBefore) return err;
    kept = (await store.listCards())
      .filter((c) => !write.before.has(c.id))
      .map((c) => ({ id: c.id, tier: c.tier }));
  } catch {
    // The ledger cannot be read now: the error as it was.
    return err;
  }
  if (kept.length === 0) return err;
  const issues = kept.filter((c) => c.tier !== "epic").map((c) => c.id);
  const epics = kept.filter((c) => c.tier === "epic").map((c) => c.id);
  const parts = [
    ...(epics.length ? [`epic ${epics.join(", ")}`] : []),
    ...(issues.length ? [`${issues.length === 1 ? "issue" : "issues"} ${issues.join(", ")}`] : []),
  ];
  const cause = isDiskFull(err) ? "the disk is full" : describeError(err);
  const message = `The plan stopped partway (${cause}), so no plan was recorded: ${parts.join(" and ")} ${kept.length === 1 ? "was" : "were"} kept on the board.`;
  const reject = `reject each of them (sekhemet reject <id> "unfinished plan") and plan again`;
  const next = isDiskFull(err) ? `${DISK_FULL_FREE}; then ${reject}` : reject;
  return new UnfinishedPlanRefusal(
    message,
    next,
    kept.map((c) => c.id),
    err,
  );
}
