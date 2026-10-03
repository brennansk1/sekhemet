import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DeterministicGateRunner, compileEvidence, loadGatesConfig } from "@sekhemet/gates";
import type { CardStore, EventRecord } from "@sekhemet/kernel";
import { confinedSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { contextForCard, isolateCard } from "./card_root.js";
import type { ExecutionContext } from "./execute.js";
import { recordLedgerRun } from "./ledger_evidence.js";
import { workspaceFolderOf } from "./workspace_locator.js";

/**
 * Collaborating on a running issue (worker-loop NEW-worker-loop-10, DEC-34).
 *
 * A person steers a card through the ledger, like `abort` (L25): the runner
 * reads these events between steps, since the queue may run in another
 * process. A message reaches the Worker's next step (WL-N10-1); a pause stops
 * the card at the next step boundary with the resumable `paused`, and a
 * hand-back resumes it from its checkpoint with the person's note
 * (WL-N10-2); a take-over makes the person the attempt's builder, under the
 * same gates, outside the Worker's competence record (WL-N10-3).
 */
export const COLLABORATION_EVENTS = {
  message: "card/message",
  pauseRequested: "card/pause_requested",
  handedBack: "card/handed_back",
  delivered: "card/message_delivered",
  takenOver: "card/taken_over",
} as const;

/** One message or hand-back note on a card, and the step it reached. */
export interface CardMessage {
  id: string;
  seq: number;
  kind: "message" | "hand_back";
  principal: string;
  text: string;
  postedAt: string;
  /** The Worker step whose prompt carried it; absent until delivered. */
  reachedStep?: number;
}

async function requireCard(cardStore: CardStore, cardId: string) {
  const card = await cardStore.getCard(cardId);
  if (!card) throw new Error(`Issue not found: ${cardId}`);
  return card;
}

/** WL-N10-1: post a message for the agent running this card. */
export async function postCardMessage(
  cardStore: CardStore,
  cardId: string,
  text: string,
  principal = cardStore.localPrincipal(),
): Promise<void> {
  const message = text.trim();
  if (!message) throw new Error("A message needs text");
  await requireCard(cardStore, cardId);
  await cardStore.recordEvent({
    type: COLLABORATION_EVENTS.message,
    cardId,
    actor: "human",
    principal,
    payload: { id: cardId, principal },
    private: { message },
  });
}

/** Every message and hand-back note on a card, oldest first, with the step each reached. */
export async function cardMessages(cardStore: CardStore, cardId: string): Promise<CardMessage[]> {
  const events = await cardStore.cardEvents(cardId, [
    COLLABORATION_EVENTS.message,
    COLLABORATION_EVENTS.handedBack,
    COLLABORATION_EVENTS.delivered,
  ]);
  const reached = new Map<string, number>();
  for (const e of events) {
    if (e.type !== COLLABORATION_EVENTS.delivered) continue;
    const p = e.payload as { message: string; step: number };
    if (!reached.has(p.message)) reached.set(p.message, p.step);
  }
  return events
    .filter((e) => e.type !== COLLABORATION_EVENTS.delivered)
    .map((e) => toMessage(e, reached.get(e.id)));
}

function toMessage(e: EventRecord, reachedStep: number | undefined): CardMessage {
  const hand = e.type === COLLABORATION_EVENTS.handedBack;
  const priv = (e as EventRecord & { private?: Record<string, unknown> }).private ?? {};
  return {
    id: e.id,
    seq: e.seq,
    kind: hand ? "hand_back" : "message",
    principal: String((e.payload as { principal?: string }).principal ?? ""),
    text: String((hand ? priv.note : priv.message) ?? ""),
    postedAt: e.createdAt,
    ...(reachedStep !== undefined ? { reachedStep } : {}),
  };
}

/** Messages and notes no Worker step has carried yet, oldest first. */
export async function undeliveredMessages(
  cardStore: CardStore,
  cardId: string,
): Promise<CardMessage[]> {
  return (await cardMessages(cardStore, cardId)).filter(
    (m) => m.reachedStep === undefined && m.text !== "",
  );
}

/** Record that step `step`'s prompt carried these messages (WL-N10-1: shown with that step). */
export async function recordDelivered(
  cardStore: CardStore,
  cardId: string,
  messageIds: string[],
  step: number,
): Promise<void> {
  for (const message of messageIds) {
    await cardStore.recordEvent({
      type: COLLABORATION_EVENTS.delivered,
      cardId,
      actor: "executor",
      payload: { id: cardId, message, step },
    });
  }
}

/** The prompt line a message or hand-back note becomes. */
export function messageLabel(m: CardMessage): string {
  return m.kind === "hand_back"
    ? "a person handed the card back to you"
    : "a person's message while you work";
}

/** WL-N10-2: ask the process running this card to pause it at the next step boundary. */
export async function requestPause(
  cardStore: CardStore,
  cardId: string,
  principal = cardStore.localPrincipal(),
): Promise<void> {
  await requireCard(cardStore, cardId);
  await cardStore.recordEvent({
    type: COLLABORATION_EVENTS.pauseRequested,
    cardId,
    actor: "human",
    principal,
    payload: { id: cardId, principal },
  });
}

/** The seq of the latest pause request, so a run counts only those made after it started. */
export async function lastPauseSeq(cardStore: CardStore, cardId: string): Promise<number> {
  return (
    (await cardStore.cardEvents(cardId, [COLLABORATION_EVENTS.pauseRequested])).at(-1)?.seq ?? 0
  );
}

/** A pause requested after `sinceSeq`: the principal who asked. */
export async function pendingPause(
  cardStore: CardStore,
  cardId: string,
  sinceSeq: number,
): Promise<string | undefined> {
  const last = (await cardStore.cardEvents(cardId, [COLLABORATION_EVENTS.pauseRequested]))
    .filter((e) => e.seq > sinceSeq)
    .at(-1);
  return last
    ? String((last.payload as { principal?: string }).principal ?? "a person")
    : undefined;
}

/**
 * WL-N10-2: hand a paused card back. It returns to Ready; its next run
 * resumes from the checkpoint the pause kept, and the note reaches its first step.
 */
export async function handBack(
  ctx: ExecutionContext,
  cardId: string,
  note: string,
  principal = ctx.cardStore.localPrincipal(),
): Promise<void> {
  const card = await requireCard(ctx.cardStore, cardId);
  // FINDINGS ISS-02: a run a person stopped (`human_abort`, resumable from its
  // checkpoint) resumes the same way, from In progress or the Verify it stopped in.
  const stopped =
    card.stopReason === "human_abort" &&
    (card.status === "in_progress" || card.status === "verify");
  if (!stopped && (card.stopReason !== "paused" || card.status !== "in_progress")) {
    throw new Error(
      `${cardId} is not paused or stopped; only a paused or stopped issue is handed back`,
    );
  }
  // The note and the move in one transaction (kernel S7): a refused move records neither.
  await ctx.boardService.transitionCard({
    cardId,
    fromStatus: card.status,
    toStatus: "ready",
    actor: "human",
    principal,
    reason: stopped ? "resumed after a stop" : "handed back to the Agent",
    with: [
      {
        type: COLLABORATION_EVENTS.handedBack,
        actor: "human",
        principal,
        payload: { id: cardId, principal },
        ...(note.trim() ? { private: { note: note.trim() } } : {}),
      },
    ],
  });
}

/** Whether an attempt at this card is running now. */
function running(cardStore: CardStore, cardId: string): boolean {
  return cardStore.runs.listAttempts(cardId).at(-1)?.status === "running";
}

/**
 * WL-N10-3: a person takes the issue over. The card moves to In Progress
 * with its worktree (created from the integration branch if it has none);
 * the person works there, then `submitTakenOver` runs the gates.
 */
export async function takeOver(
  ctx: ExecutionContext,
  cardId: string,
  principal = ctx.cardStore.localPrincipal(),
): Promise<{ worktreePath: string }> {
  const card = await requireCard(ctx.cardStore, cardId);
  if (running(ctx.cardStore, cardId)) {
    throw new Error(`${cardId}'s agent is running; pause it before taking it over`);
  }
  if (card.status === "done" || card.status === "rejected") {
    throw new Error(`${cardId} is ${card.status}; reopen it before taking it over`);
  }
  // Runtime item 2a: the worktree is in the card's own project's root.
  const place = contextForCard(ctx, card);
  const adapter = new NodeGitSyncAdapter(place.repoPath);
  let worktreePath = join(place.repoPath, ".sekhemet", "worktrees", cardId);
  if (!existsSync(worktreePath)) {
    const { integrationBranch } = await import("./accept.js");
    worktreePath = await adapter.createWorktree(
      cardId,
      integrationBranch(place.repoPath),
      card.title,
      card.parentId ?? null,
    );
  }
  if (card.status !== "in_progress") {
    await ctx.boardService.transitionCard({
      cardId,
      fromStatus: card.status,
      toStatus: "in_progress",
      actor: "human",
      principal,
      reason: "taken over by a person",
    });
  }
  await ctx.cardStore.recordEvent({
    type: COLLABORATION_EVENTS.takenOver,
    cardId,
    actor: "human",
    principal,
    payload: { id: cardId, principal },
  });
  return { worktreePath };
}

/**
 * WL-N10-3: check a person's work on a card they took over — the card's
 * blocking gates, as for the Worker. The attempt is recorded as the
 * person's (`builtBy`), so it never enters the Worker's competence record
 * or its pass rate by model (K-N6-4). A pass moves the card to Review.
 */
export async function submitTakenOver(
  ctx: ExecutionContext,
  cardId: string,
  principal = ctx.cardStore.localPrincipal(),
): Promise<{ passed: boolean; failures: string[]; evidenceId: string }> {
  const card = await requireCard(ctx.cardStore, cardId);
  const taken = (await ctx.cardStore.cardEvents(cardId, [COLLABORATION_EVENTS.takenOver])).at(-1);
  if (!taken) throw new Error(`${cardId} was not taken over`);
  if (card.status !== "in_progress") {
    throw new Error(`${cardId} is ${card.status}, not in progress`);
  }
  // Runtime item 2a: the card's own project's root; the workspace's evidence.
  const place = contextForCard(ctx, card);
  const worktree = join(place.repoPath, ".sekhemet", "worktrees", cardId);
  if (!existsSync(worktree)) throw new Error(`${cardId} has no worktree`);
  const adapter = new NodeGitSyncAdapter(place.repoPath);
  const attempt = ctx.cardStore.runs.nextAttemptNumber(cardId);
  // The person's work as a checkpoint: no model named, none co-authoring.
  const sha = await adapter.commitCheckpoint({
    cardId,
    step: attempt,
    gateStatus: "partial",
    agentModel: "none",
    agentHarness: "sekhemet",
    agentRole: "implementer",
    coAuthors: [],
    message: `checkpoint: ${cardId}, the work of the person who took it over`,
  });
  const gatesConfig = loadGatesConfig(place.repoPath);
  const rungs = [...new Set(gatesConfig.gates.filter((g) => g.blocking).map((g) => g.rung))];
  // Security item 10a: the person's checks see only this project too.
  const release = isolateCard(place, cardId);
  const result = await new DeterministicGateRunner(confinedSandbox(ctx.restrictedMode), {
    repoRoot: place.repoPath,
    expectedConfigSha256: gatesConfig.sha256,
  })
    .runGates(rungs, worktree)
    .finally(release);
  const failures = result.failures.map(
    (f) => `[${f.gate ?? f.rung}] ${f.errorExcerpt.split("\n")[0]}`,
  );
  const stats = await adapter.getDiffStats(cardId).catch(() => undefined);
  const repoState = await adapter.getRepoStateHash(cardId).catch(() => undefined);
  const evidence = {
    ...compileEvidence({
      cardId,
      attempt,
      diff: "",
      filesTouched: stats?.filesTouched ?? [],
      linesAdded: stats?.linesAdded ?? 0,
      linesRemoved: stats?.linesRemoved ?? 0,
      gateResult: result,
      turnsUsed: 0,
      // A failing check leaves the card with the person, who may keep going or hand it back.
      stopReason: result.passed ? "gate_passed" : "paused",
      checkpointShas: [sha],
      tokens: { promptTokens: 0, completionTokens: 0 },
      durationMs: result.durationMs,
      settings: { modelId: "person", toolArm: "none" },
      gatesConfigSha256: gatesConfig.sha256,
    }),
    builtBy: { kind: "person" as const, id: principal },
    ...(repoState ? { repoState } : {}),
  };
  const dir = join(
    place.workspaceFolder ?? workspaceFolderOf(place.repoPath),
    ".sekhemet",
    "evidence",
  );
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(dir, `${evidence.id}.json`), body);
  writeFileSync(join(dir, `latest-${cardId}.json`), body);
  await recordLedgerRun(ctx.cardStore, {
    cardId,
    modelId: "person",
    passed: result.passed,
    stopReason: result.passed ? "gate_passed" : "paused",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    filesTouched: stats?.filesTouched ?? [],
    secondsUsed: Math.round(result.durationMs / 1000),
    builtBy: { kind: "person", id: principal },
  });
  await ctx.cardStore.updateCard(
    cardId,
    { evidenceId: evidence.id, blockedReason: result.passed ? null : failures.join("; ") },
    "human",
  );
  if (result.passed) {
    for (const [from, to] of [
      ["in_progress", "verify"],
      ["verify", "review"],
    ] as const) {
      await ctx.boardService.transitionCard({
        cardId,
        fromStatus: from,
        toStatus: to,
        actor: "human",
        principal,
        reason: "the person's take-over passed the checks",
      });
    }
  }
  return { passed: result.passed, failures, evidenceId: evidence.id };
}
