import type { BoardServiceImpl } from "@sekhemet/board";
import type { CardRecord, CardStatus, CardStore, EventLog } from "@sekhemet/kernel";
import { recordDecision } from "./accept.js";
import { releaseHeldCards } from "./execute.js";
import { learnFromSendBack } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import { hookEngineFor } from "./user_hooks.js";

/**
 * The human's decisions on a card, one implementation for every surface.
 *
 * The board could send a card back or park it and the command line could not
 * — the asymmetry the design's command-surface rule forbids: every action
 * reachable from the interface is reachable from the command line, with its
 * undo. So the board's handlers and the CLI's commands both call these.
 */
export interface TriageContext {
  repoPath: string;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  log: EventLog;
}

export {
  AcceptRefusedError,
  acceptCard,
  enableAutoAccept,
  recordReviewOpened,
  revertAccept,
} from "./accept.js";

/** A person's decision on a card in Review is a review, for ReviewWIP (S6, RG-S6-6). */
async function decidedInReview(
  ctx: TriageContext,
  card: CardRecord,
  decision: "send_back" | "park" | "reject",
  principal?: string,
): Promise<void> {
  if (card.status !== "review") return;
  await recordDecision(ctx, card, principal ?? ctx.cardStore.localPrincipal(), decision, []);
}

/** Cards in Review can move once one leaves it. */
async function drainReview(ctx: TriageContext, card: CardRecord): Promise<void> {
  if (card.status !== "review") return;
  await releaseHeldCards({
    repoPath: ctx.repoPath,
    restrictedMode: false,
    cardStore: ctx.cardStore,
    boardService: ctx.boardService,
  }).catch(() => []);
}

/** A send-back's reason, recorded as a candidate playbook rule (K-S7-6). */
export const PLAYBOOK_CANDIDATE_EVENT = "playbook/candidate";

/**
 * Send a card back to Ready with a reason. The reason is what the Worker is
 * told next: it goes into the card's dossier, which the runner puts in the
 * next attempt's prompt, and it is a candidate playbook rule — a correction a
 * person had to make once should not be needed twice.
 */
/** A person's comment on one line of the diff (DEC-34; WL-N10-4). */
export interface LineComment {
  file: string;
  line: number;
  text: string;
}

export async function sendBack(
  ctx: TriageContext,
  card: CardRecord,
  reason: string,
  options: { comments?: readonly LineComment[] } = {},
): Promise<void> {
  const why = reason.trim().slice(0, 2000);
  if (!why) throw new Error("A send-back needs a reason: it is what the agent is told next");
  const comments = options.comments ?? [];
  for (const c of comments) {
    if (!c.file?.trim() || !Number.isInteger(c.line) || c.line < 1 || !c.text?.trim()) {
      throw new Error("A line comment names its file and line (1 or more) and says something");
    }
  }
  // §2.4, RG-S5-12: a send-back is a verdict on finished work, from Review
  // or Parked. A running card is stopped with `abort`.
  const stored = (await ctx.cardStore.getCard(card.id)) ?? card;
  if (stored.status === "in_progress" || stored.status === "verify") {
    throw new Error(
      `${card.id} is ${stored.status === "verify" ? "being verified" : "running"}; stop it with \`sekhemet abort ${card.id}\` first. A send-back is for a card in Review or Parked.`,
    );
  }
  if (stored.status !== "review" && stored.status !== "parked") {
    throw new Error(
      `${card.id} is in '${stored.status}'; a send-back is for a card in Review or Parked`,
    );
  }
  await decidedInReview(ctx, stored, "send_back");
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: stored.status,
    toStatus: "ready",
    actor: "human",
    reason: `returned: ${why}`,
  });
  await ctx.cardStore
    .recordDossierEntry({ cardId: card.id, kind: "send_back", text: why, actor: "human" })
    .catch(() => undefined);
  // WL-N10-4: each line comment is an instruction to the next attempt, with
  // its file and line.
  for (const c of comments) {
    await ctx.cardStore.recordDossierEntry({
      cardId: card.id,
      kind: "send_back",
      text: `${c.file.trim()}:${c.line} — ${c.text.trim().slice(0, 1000)}`,
      actor: "human",
    });
  }
  await hookEngineFor(ctx.repoPath)
    .engine.emit("review/return", { cardId: card.id, data: { reason: why } })
    .catch(() => undefined);
  await learnFromSendBack(new LearningStore(ctx.log), card, why).catch(() => undefined);
  // The playbook candidate is a ledger event, not a side file (kernel rule
  // 12, K-S7-6): the ledger is the only durable channel.
  await ctx.cardStore.recordEvent({
    type: PLAYBOOK_CANDIDATE_EVENT,
    cardId: card.id,
    actor: "human",
    payload: { cardId: card.id },
    // A person's note is free text: the private part, erasable (rule 33, K-S7-9).
    private: { reason: why },
  });
  await drainReview(ctx, card);
}

/** Set a card aside. `unpark` is its undo. */
export async function park(ctx: TriageContext, card: CardRecord, reason = ""): Promise<void> {
  const why = reason.trim().slice(0, 2000);
  await decidedInReview(ctx, card, "park");
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: "parked",
    actor: "human",
    reason: `parked${why ? `: ${why}` : ""}`,
  });
  await drainReview(ctx, card);
}

/**
 * Where an unparked card goes (kernel rule 25, K-N5-6): back to Backlog or
 * Planning when it was parked from there, and re-queued at Ready otherwise,
 * never into the middle of a state. The parked-from state is read from the
 * ledger's `card/status_changed` into `parked`.
 */
export async function unparkTarget(cardStore: CardStore, cardId: string): Promise<CardStatus> {
  const into = (await cardStore.cardEvents(cardId, ["card/status_changed"]))
    .filter((e) => (e.payload as { toStatus?: string }).toStatus === "parked")
    .at(-1);
  const from = (into?.payload as { fromStatus?: CardStatus } | undefined)?.fromStatus;
  return from === "backlog" || from === "planning" ? from : "ready";
}

/** Put a parked card back where it was parked from, or in Ready. */
export async function unpark(ctx: TriageContext, card: CardRecord): Promise<CardStatus> {
  if (card.status !== "parked") throw new Error(`${card.id} is not parked (it is ${card.status})`);
  const to = await unparkTarget(ctx.cardStore, card.id);
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: "parked",
    toStatus: to,
    actor: "human",
    reason: "unparked",
  });
  return to;
}

/**
 * Reject a card (§2.4, RG-S5-11): from Review, Parked, Ready or Backlog,
 * with a required reason; `reopen` is its undo.
 */
export async function reject(ctx: TriageContext, card: CardRecord, reason: string): Promise<void> {
  const why = reason.trim().slice(0, 2000);
  if (!why) throw new Error("A rejection needs a reason");
  const stored = (await ctx.cardStore.getCard(card.id)) ?? card;
  if (!["review", "parked", "ready", "backlog"].includes(stored.status)) {
    throw new Error(
      `${card.id} is in '${stored.status}'; a card is rejected from Review, Parked, Ready or Backlog`,
    );
  }
  await decidedInReview(ctx, stored, "reject");
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: stored.status,
    toStatus: "rejected",
    actor: "human",
    reason: `rejected: ${why}`,
  });
  await drainReview(ctx, stored);
}

/** Put a rejected card back in Ready (`sekhemet reopen`; kernel rule 25, K-S4-7). */
export async function reopen(ctx: TriageContext, card: CardRecord, reason = ""): Promise<void> {
  if (card.status !== "rejected") {
    throw new Error(`${card.id} is not rejected (it is ${card.status})`);
  }
  const why = reason.trim().slice(0, 2000);
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: "rejected",
    toStatus: "ready",
    actor: "human",
    reason: `reopened${why ? `: ${why}` : ""}`,
  });
}

/** The card most in need of a person: the oldest in Review. */
export async function nextForReview(ctx: TriageContext): Promise<CardRecord | undefined> {
  const state = await ctx.boardService.getBoardState();
  return state.cards
    .filter((c) => c.status === "review")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
}
