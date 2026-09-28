import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BoardService } from "@sekhemet/board";
import {
  type CardRecord,
  type CardStore,
  type EventLog,
  RETENTION_DAYS,
  type RetentionReport,
  pruneRetention,
} from "@sekhemet/kernel";
import { defaultSlotCacheDir, sweepErasedSlots } from "@sekhemet/models";
import { reapOrphanedGroups, runTrusted } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter, gitEnvFor } from "@sekhemet/sync";
import { Tracer } from "./tracing.js";

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

export const processRegistryDir = (repoPath: string) => join(repoPath, ".sekhemet", "processes");

export interface CrashSweepEntry {
  cardId: string;
  attemptId: string;
  /** The checkpoint the worktree was restored to, when there was one. */
  restoredTo?: string;
}

export interface SupervisorStart {
  reapedProcesses: number[];
  crashed: CrashSweepEntry[];
  retention?: RetentionReport;
  spansDeleted: number;
  /** Saved KV slot files an erasure covers, deleted (models rule 20i, MD-N14-37). */
  slotsErased: string[];
}

/** Finish every crashed attempt and return its card to Ready (RUN-9). */
export async function sweepCrashedAttempts(
  repoPath: string,
  cardStore: CardStore,
  boardService: Pick<BoardService, "transitionCard">,
): Promise<CrashSweepEntry[]> {
  const swept: CrashSweepEntry[] = [];
  const inProgress = (await cardStore.listCards({ status: "in_progress" })) as CardRecord[];
  for (const card of inProgress) {
    const attempt = cardStore.runs.listAttempts(card.id).at(-1);
    if (!attempt || attempt.status !== "running") continue;
    await cardStore.runs.finishAttempt({
      attemptId: attempt.id,
      status: "halted",
      stopReason: "crashed",
      tokensUsed: attempt.tokensUsed,
      secondsUsed: attempt.secondsUsed,
    });
    await cardStore.updateCard(card.id, { stopReason: "crashed" }, "harness");
    const checkpoint = (await cardStore.getCheckpoints(card.id)).at(-1);
    const worktree = join(repoPath, ".sekhemet", "worktrees", card.id);
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
      reason: `crashed attempt ${attempt.id} swept at start-up; resumes from ${checkpoint ? `step ${checkpoint.step}` : "the start"}`,
    });
    swept.push({ cardId: card.id, attemptId: attempt.id, ...(restoredTo ? { restoredTo } : {}) });
  }
  return swept;
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
  } = {},
): Promise<SupervisorStart> {
  const reapedProcesses = reapOrphanedGroups(processRegistryDir(ctx.repoPath));
  const crashed = await sweepCrashedAttempts(ctx.repoPath, ctx.cardStore, ctx.boardService);
  const retention = await runRetention(ctx.repoPath, ctx.cardStore, ctx.log, options.now).catch(
    () => undefined,
  );
  const spansDeleted = pruneTraces(ctx.repoPath, options.now);
  // The spine (erasure), after the retention prune's own erasure: a saved KV
  // slot whose prompt text an erasure covers is deleted before any restore
  // (models rule 20i, MD-N14-37). A slot of unknown sources goes on any
  // erasure newer than the last sweep.
  const index = ctx.log.erasureIndex();
  const slotsErased = (options.slotDirs ?? [defaultSlotCacheDir()]).flatMap((dir) => {
    try {
      return sweepErasedSlots(dir, index);
    } catch {
      return [];
    }
  });
  return {
    reapedProcesses,
    crashed,
    ...(retention ? { retention } : {}),
    spansDeleted,
    slotsErased,
  };
}

/** The lines `queue` prints for the start-up pass. */
export function describeSupervisorStart(start: SupervisorStart): string[] {
  const lines: string[] = [];
  if (start.reapedProcesses.length > 0) {
    lines.push(
      `Reaped ${start.reapedProcesses.length} process group(s) a killed runner left: ${start.reapedProcesses.join(", ")}.`,
    );
  }
  for (const c of start.crashed) {
    lines.push(
      `Crashed attempt of ${c.cardId} (${c.attemptId}) swept: back to Ready${c.restoredTo ? `, worktree restored to ${c.restoredTo.slice(0, 10)}` : ""}.`,
    );
  }
  const r = start.retention;
  if (r?.skipped) lines.push(`Retention: ${r.skipped}.`);
  if (r && r.pruned.length > 0) {
    lines.push(
      `Retention: pruned ${r.removed.packs} pack(s), ${r.removed.observations} observation(s), ${r.removed.transcripts} transcript(s) of ${r.closedCards.length} closed issue(s), recorded as ledger/erased seq ${r.erasedBySeq}.`,
    );
    for (const item of r.pruned) {
      lines.push(`   ${item.cardId ?? "(no issue)"}: ${item.kind} ${item.id}`);
    }
  }
  if (start.slotsErased.length > 0) {
    lines.push(
      `Erasure: ${start.slotsErased.length} saved model slot(s) holding erased text deleted.`,
    );
  }
  if (start.spansDeleted > 0) {
    lines.push(`Retention: ${start.spansDeleted} span(s) older than 30 days deleted.`);
  }
  return lines;
}

/**
 * Remove a card's worktree when it is closed, keeping its branch (RUN-16):
 * subscribed to the ledger, so every path that closes a card — the board, the
 * CLI's triage, the dashboard — is covered. Returns the unsubscribe.
 */
export function removeWorktreesOnClose(repoPath: string, log: EventLog): () => void {
  return log.subscribe({ type: "card/status_changed" }, (event) => {
    const p = event.payload as { toStatus?: string; fromStatus?: string };
    if (p.toStatus !== "rejected" || !event.cardId) return;
    const worktree = join(repoPath, ".sekhemet", "worktrees", event.cardId);
    if (!existsSync(worktree)) return;
    void new NodeGitSyncAdapter(repoPath).removeWorktree(event.cardId).catch(() => undefined);
  });
}
