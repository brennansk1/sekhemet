import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  type EventLog,
  RETENTION_DAYS,
  type RetentionReport,
  pruneRetention,
} from "@sekhemet/kernel";
import { defaultSlotCacheDir, pruneSlotCache, sweepErasedSlots } from "@sekhemet/models";
import { reapOrphanedGroups, runTrusted } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter, gitEnvFor } from "@sekhemet/sync";
import { plural } from "@sekhemet/ui";
import { type AcceptReconciliation, reconcileAccepts } from "./accept.js";
import { dailyBackupIfDue } from "./backup_sets.js";
import { cardWorktree, projectRootOf } from "./card_root.js";
import { checkFreeSpace, diskLowDetail } from "./disk_space.js";
import { RUN_CLAIM_REASON } from "./execute.js";
import { reportLostRecord } from "./lost_records.js";
import { Tracer } from "./tracing.js";
import { workspaceFolderOf } from "./workspace_locator.js";

/**
 * What the supervisor does when a runner starts (runtime.md items 2, 10, 33,
 * 34; NEW-runtime-3, NEW-runtime-4). The caller holds the runner lease, so no
 * other runner is live: anything still marked running was left by a crash.
 *
 * 1. Reap the process groups a runner killed with SIGKILL left behind (RUN-12).
 * 2. Sweep crashed attempts (RUN-9): a card In Progress whose attempt is still
 *    running is finished with stop reason `crashed` (worker-loop's table:
 *    class environment, resumable), its worktree restored to its last
 *    checkpoint, and returned to Ready; its next run resumes from that step
 *    (RUN-10, the card runner's resume point).
 * 3. Retention (RUN-13, RUN-54, RUN-57): packs, observations and transcripts
 *    of cards closed 30+ days ago, pruned as one recorded erasure; spans older
 *    than 30 days deleted from `traces.db` (RUN-15).
 */

export const processRegistryDir = (repoPath: string) =>
  join(workspaceFolderOf(repoPath), ".sekhemet", "processes");

export interface CrashSweepEntry {
  cardId: string;
  /** The attempt finished; empty for a run's claim swept before its attempt began (C.6). */
  attemptId: string;
  /**
   * `crashed`, or `disk_low` when a volume the card writes to is below the
   * free-space floor (C4's design call: a run whose own stop could not be
   * appended for space is found here, WL-N11-3).
   */
  stopReason: "crashed" | "disk_low";
  /** The checkpoint the worktree was restored to, when there was one. */
  restoredTo?: string;
}

export interface SupervisorStart {
  reapedProcesses: number[];
  crashed: CrashSweepEntry[];
  /** Accepts a crash left between the merge and its record, settled (review-git RG-N8-2). */
  accepts: AcceptReconciliation[];
  retention?: RetentionReport;
  spansDeleted: number;
  /** Saved KV slot files an erasure covers, deleted (models rule 20i, MD-N14-37). */
  slotsErased: string[];
  /** Slot files over the slot directory's cap, deleted oldest first (MD-N14-37a). */
  slotsPruned: string[];
  /** The automatic backup's line, when one was written or failed (RUN-59). */
  backup?: string;
}

/**
 * The automatic backup (runtime item 35a, RUN-59): the day's first `queue`,
 * `overnight` or `serve`, and the end of every `overnight`, write a set
 * unless `[backup] enabled = false`. Returns the line to print, undefined
 * when none was due. A backup that fails — a volume below the free-space
 * floor (RUN-69) included — is said, and the run goes on.
 */
export async function automaticBackup(input: {
  workspaceFolder: string;
  db: DatabaseSync;
  log: EventLog;
  kind?: "daily" | "overnight";
}): Promise<string | undefined> {
  try {
    const r = await dailyBackupIfDue(input);
    if ("skipped" in r) return undefined;
    return `Backed up to ${r.path} (entry ${r.seq}).`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    reportLostRecord("automatic backup", err, { workspaceId: input.log.workspaceId() });
    return `Backup not written: ${why}`;
  }
}

/**
 * Finish every crashed attempt and return its card to Ready (RUN-9). An
 * attempt found while the card's project volume or the workspace folder's is
 * below the free-space floor is recorded `disk_low`, not `crashed` (RUN-70):
 * the likeliest reason its own stop was never written.
 */
export async function sweepCrashedAttempts(
  repoPath: string,
  cardStore: CardStore,
  boardService: Pick<BoardService, "transitionCard">,
  options: { workspaceFolder?: string; freeSpaceFloorBytes?: number } = {},
): Promise<CrashSweepEntry[]> {
  const swept: CrashSweepEntry[] = [];
  const inProgress = (await cardStore.listCards({ status: "in_progress" })) as CardRecord[];
  // C.6: a run's own move of an issue (Ready to Planning, then to In
  // Progress) comes before its attempt begins; stopped in between, the issue
  // sat there with no attempt and no stop. Its latest move was the run's.
  const stoppedClaims: { card: CardRecord; from: CardStatus }[] = [];
  for (const card of inProgress) {
    const attempt = cardStore.runs.listAttempts(card.id).at(-1);
    if (!attempt || attempt.status !== "running") {
      if (await lastMoveWasRuns(cardStore, card.id, "in_progress"))
        stoppedClaims.push({ card, from: "in_progress" });
      continue;
    }
    const root = projectRootOf(cardStore, card) ?? repoPath;
    const space = checkFreeSpace(
      [root, options.workspaceFolder ?? workspaceFolderOf(repoPath)],
      options.freeSpaceFloorBytes !== undefined ? { floorBytes: options.freeSpaceFloorBytes } : {},
    );
    const stopReason = space.ok ? "crashed" : "disk_low";
    await cardStore.runs.finishAttempt({
      attemptId: attempt.id,
      status: "halted",
      stopReason,
      tokensUsed: attempt.tokensUsed,
      secondsUsed: attempt.secondsUsed,
    });
    await cardStore.updateCard(card.id, { stopReason }, "harness");
    if (!space.ok)
      await cardStore.recordEvent({
        type: "machine/disk_low",
        cardId: card.id,
        actor: "harness",
        payload: { id: card.id, ...diskLowDetail(space) },
      });
    const checkpoint = (await cardStore.getCheckpoints(card.id)).at(-1);
    // Runtime item 2a: the card's worktree is in its own project's root.
    const worktree = cardWorktree(root, card.id);
    let restoredTo: string | undefined;
    if (
      checkpoint &&
      existsSync(worktree) &&
      (await restoreWorktree(worktree, checkpoint.gitRef))
    ) {
      restoredTo = checkpoint.gitRef;
    }
    // Through the board, the one path for every status writer (K-S4-3).
    await boardService.transitionCard({
      cardId: card.id,
      fromStatus: "in_progress",
      toStatus: "ready",
      actor: "harness",
      reason: `${stopReason === "disk_low" ? "attempt stopped by a full disk" : "crashed attempt"} ${attempt.id} swept at start-up; resumes from ${checkpoint ? `step ${checkpoint.step}` : "the start"}`,
    });
    swept.push({
      cardId: card.id,
      attemptId: attempt.id,
      stopReason,
      ...(restoredTo ? { restoredTo } : {}),
    });
  }
  // C.6 (a WAL cut, a kill -9): a run claims an issue from Ready into
  // Planning (`pullThroughPlanning`) before its attempt begins. Stopped in
  // between, the issue sat in Planning with no attempt and no stop, and
  // nothing returned it. The claim is the latest status change, made by the
  // runner from Ready; a card a person planned, or one waiting for its
  // criteria's approval, never carries it. Under the runner lease no other
  // runner is between the two.
  const planning = (await cardStore.listCards({ status: "planning" })) as CardRecord[];
  for (const card of planning)
    if (await lastMoveWasRuns(cardStore, card.id, "planning"))
      stoppedClaims.push({ card, from: "planning" });
  for (const { card, from } of stoppedClaims) {
    if (cardStore.runs.listAttempts(card.id).some((a) => a.status === "running")) continue;
    await cardStore.updateCard(card.id, { stopReason: "crashed" }, "harness");
    await boardService.transitionCard({
      cardId: card.id,
      fromStatus: from,
      toStatus: "ready",
      actor: "harness",
      reason: "a run moved this issue and stopped before its attempt began; swept at start-up",
    });
    swept.push({ cardId: card.id, attemptId: "", stopReason: "crashed" });
  }
  return swept;
}

/**
 * Whether the issue's latest status change into `to` was a run's own: the
 * claim from Ready (`RUN_CLAIM_REASON`, the planner) or the run's lifecycle
 * move into In Progress (the executor). A person's move, or a card waiting
 * for its criteria's approval, is never one.
 */
async function lastMoveWasRuns(
  cardStore: CardStore,
  cardId: string,
  to: CardStatus,
): Promise<boolean> {
  const last = (await cardStore.cardEvents(cardId, ["card/status_changed"])).at(-1);
  const p = last?.payload as
    | { fromStatus?: string; toStatus?: string; reason?: string }
    | undefined;
  if (p?.toStatus !== to) return false;
  if (to === "planning") return p.fromStatus === "ready" && p.reason === RUN_CLAIM_REASON;
  return last?.actor === "executor";
}

/**
 * Reset a card's worktree to a checkpoint and remove what a partial step left
 * untracked (the staged acceptance tests excepted), with git's environment
 * pinned to the harness's record of the worktree (security item 18).
 */
async function restoreWorktree(worktree: string, gitRef: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,64}$/i.test(gitRef)) return false;
  let env: NodeJS.ProcessEnv;
  try {
    env = gitEnvFor(worktree);
  } catch {
    // Tampered git metadata: leave it for the card runner's own refusal.
    return false;
  }
  const reset = await runTrusted("git", ["reset", "-q", "--hard", gitRef], {
    cwd: worktree,
    env,
    timeoutMs: 30_000,
  });
  if (reset.exitCode !== 0) return false;
  const clean = await runTrusted("git", ["clean", "-fdq", "-e", "tests/"], {
    cwd: worktree,
    env,
    timeoutMs: 30_000,
  });
  return clean.exitCode === 0;
}

/** Retention for every card of the repository, as one recorded erasure (RUN-13). */
export async function runRetention(
  repoPath: string,
  cardStore: CardStore,
  log: EventLog,
  now = Date.now(),
): Promise<RetentionReport> {
  const cards = await cardStore.listCards();
  return pruneRetention(
    repoPath,
    log,
    cards.map((c) => ({
      id: c.id,
      status: c.status,
      updatedAt: c.updatedAt,
      packIds: cardStore.runs.contextPackIds(c.id),
    })),
    { now },
  );
}

/** Delete spans older than the retention period from `traces.db` (RUN-15). */
export function pruneTraces(repoPath: string, now = Date.now()): number {
  if (!existsSync(join(repoPath, ".sekhemet", "traces.db"))) return 0;
  const tracer = Tracer.forRepo(repoPath);
  try {
    return tracer.prune(now - RETENTION_DAYS * 24 * 3600 * 1000);
  } finally {
    tracer.close();
  }
}

/** The supervisor's start-up pass; call it holding the runner lease. */
export async function supervisorStart(
  ctx: {
    repoPath: string;
    cardStore: CardStore;
    log: EventLog;
    boardService: Pick<BoardService, "transitionCard">;
  },
  options: {
    now?: number;
    /** The managed servers' slot directories; default `SEKHEMET_SLOT_CACHE`'s. */
    slotDirs?: string[];
    /** RUN-59: write the automatic backup when it is due (queue, overnight). */
    backup?: { db: DatabaseSync; kind?: "daily" | "overnight" };
  } = {},
): Promise<SupervisorStart> {
  const reapedProcesses = reapOrphanedGroups(processRegistryDir(ctx.repoPath));
  const crashed = await sweepCrashedAttempts(ctx.repoPath, ctx.cardStore, ctx.boardService);
  // RG-N8-2: an Accept that merged but never recorded it is settled from git.
  const accepts = await reconcileAccepts(ctx.repoPath, ctx.cardStore, ctx.boardService);
  // The workspace's run files and traces are beside its ledger (runtime item 2).
  const state = workspaceFolderOf(ctx.repoPath);
  const retention = await runRetention(state, ctx.cardStore, ctx.log, options.now).catch(
    () => undefined,
  );
  const spansDeleted = pruneTraces(state, options.now);
  // The spine (erasure), after the retention prune's own erasure: a saved KV
  // slot whose prompt text an erasure covers is deleted before any restore
  // (models rule 20i, MD-N14-37). A slot of unknown sources goes on any
  // erasure newer than the last sweep.
  const index = ctx.log.erasureIndex();
  const slotDirs = options.slotDirs ?? [defaultSlotCacheDir()];
  const slotsErased = slotDirs.flatMap((dir) => {
    try {
      return sweepErasedSlots(dir, index);
    } catch {
      return [];
    }
  });
  // F31, MD-N14-37a: then the directory is pruned to its cap, oldest first,
  // never a slot a running engine holds.
  const slotsPruned = slotDirs.flatMap((dir) => {
    try {
      return pruneSlotCache(dir);
    } catch {
      return [];
    }
  });
  const backup = options.backup
    ? await automaticBackup({
        workspaceFolder: state,
        db: options.backup.db,
        log: ctx.log,
        ...(options.backup.kind ? { kind: options.backup.kind } : {}),
      })
    : undefined;
  return {
    reapedProcesses,
    crashed,
    accepts,
    ...(retention ? { retention } : {}),
    spansDeleted,
    slotsErased,
    slotsPruned,
    ...(backup ? { backup } : {}),
  };
}

/** The lines `queue` prints for the start-up pass. */
export function describeSupervisorStart(start: SupervisorStart): string[] {
  const lines: string[] = [];
  if (start.reapedProcesses.length > 0) {
    lines.push(
      `Reaped ${plural(start.reapedProcesses.length, "process group")} a killed runner left: ${start.reapedProcesses.join(", ")}.`,
    );
  }
  for (const c of start.crashed) {
    lines.push(
      c.attemptId === ""
        ? `A run's claim of ${c.cardId} that stopped before its attempt began swept: back to Ready.`
        : `${c.stopReason === "disk_low" ? "Attempt stopped by a full disk" : "Crashed attempt"} of ${c.cardId} (${c.attemptId}) swept: back to Ready${c.restoredTo ? `, worktree restored to ${c.restoredTo.slice(0, 10)}` : ""}.`,
    );
  }
  for (const a of start.accepts) {
    lines.push(
      "reconciled" in a
        ? `Accept of ${a.cardId} found merged as ${a.reconciled.slice(0, 10)} with no record: recorded now, Done.`
        : `Accept of ${a.cardId} never reached the integration branch: recorded as failed; it stays In review.`,
    );
  }
  const r = start.retention;
  if (r?.skipped) lines.push(`Retention: ${r.skipped}.`);
  if (r && r.pruned.length > 0) {
    lines.push(
      `Retention: pruned ${plural(r.removed.packs, "pack")}, ${plural(r.removed.observations, "observation")}, ${plural(r.removed.transcripts, "transcript")} of ${plural(r.closedCards.length, "closed issue")}, recorded as ledger/erased seq ${r.erasedBySeq}.`,
    );
    for (const item of r.pruned) {
      lines.push(`   ${item.cardId ?? "(no issue)"}: ${item.kind} ${item.id}`);
    }
  }
  if (start.slotsErased.length > 0) {
    lines.push(
      `Erasure: ${plural(start.slotsErased.length, "saved model slot")} holding erased text deleted.`,
    );
  }
  if (start.slotsPruned.length > 0) {
    lines.push(
      `Slots: ${plural(start.slotsPruned.length, "saved model slot")} over the cache cap deleted.`,
    );
  }
  if (start.spansDeleted > 0) {
    lines.push(`Retention: ${plural(start.spansDeleted, "span")} older than 30 days deleted.`);
  }
  if (start.backup) lines.push(start.backup);
  return lines;
}

/**
 * Remove a card's worktree when it is closed, keeping its branch (RUN-16):
 * subscribed to the ledger, so every path that closes a card — the board, the
 * CLI's triage, the dashboard — is covered. Returns the unsubscribe.
 */
export function removeWorktreesOnClose(
  repoPath: string,
  log: EventLog,
  cardStore?: CardStore,
): () => void {
  return log.subscribe({ type: "card/status_changed" }, (event) => {
    const p = event.payload as { toStatus?: string; fromStatus?: string };
    const cardId = event.cardId;
    if (p.toStatus !== "rejected" || !cardId) return;
    void (async () => {
      // Runtime item 2a: the worktree is in the card's own project's root.
      const card = cardStore ? await cardStore.getCard(cardId) : undefined;
      const root = (cardStore && card ? projectRootOf(cardStore, card) : undefined) ?? repoPath;
      if (!existsSync(cardWorktree(root, cardId))) return;
      await new NodeGitSyncAdapter(root).removeWorktree(cardId);
    })().catch(() => undefined);
  });
}
