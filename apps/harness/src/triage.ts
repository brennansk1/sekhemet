import type { BoardServiceImpl } from "@sekhemet/board";
import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  type EventLog,
  LEGAL_TRANSITIONS,
} from "@sekhemet/kernel";
import { boardColumnLabel } from "@sekhemet/ui";
import { recordDecision } from "./accept.js";
import { releaseHeldCards } from "./execute.js";
import { isPlaybookCandidate, learnFromSendBack } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import { reportLostRecord } from "./lost_records.js";
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
  /** The person deciding (kernel rule 19); the install's person when omitted (Solo). */
  principal?: string;
}

/**
 * A decision the card's state does not allow (surface item 18b): a refusal
 * the CLI says in one line with the card's next step, and the board shows,
 * never an error that stops the process. `status` is the stored state it
 * was refused in.
 */
export class TriageRefusal extends Error {
  constructor(
    message: string,
    public readonly status: CardStatus,
  ) {
    super(message);
    this.name = "TriageRefusal";
  }
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
  await recordDecision(
    ctx,
    card,
    principal ?? ctx.principal ?? ctx.cardStore.localPrincipal(),
    decision,
    [],
  );
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
  if (!why) throw new Error("Request changes needs a reason: it is what the Agent is told next");
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
    throw new TriageRefusal(
      `${card.id} is ${stored.status === "verify" ? "being checked" : "running"}; stop it with \`sekhemet abort ${card.id}\` first. Request changes is for an issue In review or On hold.`,
      stored.status,
    );
  }
  if (stored.status !== "review" && stored.status !== "parked") {
    throw new TriageRefusal(
      `${card.id} is ${boardColumnLabel(stored.status)}; request changes on an issue In review or On hold`,
      stored.status,
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
  // RUN-89: the reason is the next attempt's instruction; a failed write is reported.
  await ctx.cardStore
    .recordDossierEntry({ cardId: card.id, kind: "send_back", text: why, actor: "human" })
    .catch((err) =>
      reportLostRecord("send_back reason", err, {
        workspaceId: ctx.cardStore.workspaceId(),
        cardId: card.id,
      }),
    );
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
  // 12, K-S7-6): the ledger is the only durable channel. RG-P8-15: only a
  // note naming a file, symbol, check or error pattern (or the plan, for
  // Seshat's PM rules) is a candidate; any other stays the dossier note above.
  if (isPlaybookCandidate(why))
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

/**
 * The states a card may be put on hold from (kernel rule 25): every state
 * whose legal edges include Parked, read from the one table.
 */
const PARKABLE = (Object.keys(LEGAL_TRANSITIONS) as CardStatus[]).filter((s) =>
  LEGAL_TRANSITIONS[s].includes("parked"),
);

/** Set a card aside. `unpark` is its undo. */
export async function park(ctx: TriageContext, card: CardRecord, reason = ""): Promise<void> {
  const why = reason.trim().slice(0, 2000);
  // Item 18b (S1B-B19): a state that cannot be put on hold is a refusal, never a crash.
  // Only when the stored state is the one the caller read: a caller that read the card
  // in another state moves from that read, so the kernel refuses it with stale_from
  // (K-S4-1, K-S4-8) and the person learns the card changed under them.
  const stored = (await ctx.cardStore.getCard(card.id)) ?? card;
  if (stored.status === card.status && !PARKABLE.includes(stored.status)) {
    const columns = [...new Set(PARKABLE.map(boardColumnLabel))];
    throw new TriageRefusal(
      `${card.id} is ${boardColumnLabel(stored.status)}; an issue is put on hold from ${columns.slice(0, -1).join(", ")} or ${columns.at(-1)}`,
      stored.status,
    );
  }
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
  if (card.status !== "parked")
    throw new TriageRefusal(
      `${card.id} is not On hold (it is ${boardColumnLabel(card.status)})`,
      card.status,
    );
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
 * Where a card may be rejected from (§2.4, RG-S5-11; S1B-B21): every state
 * of the board's In review, On hold, To do (Ready and Planning) and Backlog
 * columns — the columns the refusal names. Nothing is running in any of them.
 */
const REJECTABLE: readonly CardStatus[] = ["review", "parked", "ready", "planning", "backlog"];

/**
 * Reject a card (§2.4, RG-S5-11): from In review, On hold, To do or Backlog,
 * with a required reason; `reopen` is its undo.
 */
export async function reject(ctx: TriageContext, card: CardRecord, reason: string): Promise<void> {
  const why = reason.trim().slice(0, 2000);
  if (!why) throw new Error("A rejection needs a reason");
  const stored = (await ctx.cardStore.getCard(card.id)) ?? card;
  if (!REJECTABLE.includes(stored.status)) {
    throw new TriageRefusal(
      `${card.id} is ${boardColumnLabel(stored.status)}; an issue is rejected from In review, On hold, To do or Backlog`,
      stored.status,
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
    throw new TriageRefusal(
      `${card.id} is not marked Won't do (it is ${boardColumnLabel(card.status)})`,
      card.status,
    );
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
