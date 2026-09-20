import { type CardRecord, type CardStatus, type CardStore, matchesScope } from "@sekhemet/kernel";
import {
  type BoardService,
  type BoardState,
  type CardTransition,
  type EvidenceSummary,
  HELD_REASON_PREFIX,
  type ScopeOverlap,
  TransitionRefusedError,
  type WipLimitStatus,
} from "./types.js";

const DEFAULT_WIP_LIMITS: Record<CardStatus, number> = {
  backlog: 500,
  ready: 50,
  planning: 3,
  in_progress: 5,
  verify: 5,
  review: 3,
  done: 10000,
  rejected: 10000,
  parked: 10000,
};

/**
 * Legal column transitions.
 *
 * Without an explicit edge table any status could move to any other, so
 * `backlog -> done` was permitted: a card could be marked complete having
 * never been executed or verified.
 */
const LEGAL_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  backlog: ["ready", "parked", "rejected"],
  ready: ["planning", "in_progress", "backlog", "parked", "rejected"],
  // Planning is where a card is decomposed or replanned before execution.
  planning: ["ready", "in_progress", "backlog", "parked", "rejected"],
  in_progress: ["verify", "ready", "planning", "parked", "rejected"],
  // A regression returns the card to Planning, not In Progress, so the cause is
  // re-examined rather than patched again by the same failing approach.
  verify: ["review", "planning", "in_progress", "ready", "parked", "rejected"],
  // A regression returns the card upstream for replanning, not to In Progress.
  review: ["done", "planning", "ready", "in_progress", "parked", "rejected"],
  done: ["ready"],
  parked: ["ready", "planning", "backlog", "rejected"],
  rejected: ["backlog", "ready"],
};

/**
 * The board's view of an evidence bundle (B1, B12), in one place so the
 * dashboard, the CLI and the tests all read a bundle the same way.
 *
 * Typed structurally rather than against `@sekhemet/gates`: the board sits
 * below the gates package in the graph and needs three fields out of the
 * bundle. A skipped gate is not a failing one — it never ran.
 */
export function evidenceSummaryOf(bundle: {
  passed?: boolean;
  rungResults?: { gate?: string; layer?: string; passed?: boolean; skipped?: boolean }[];
}): EvidenceSummary {
  const rungs = bundle.rungResults ?? [];
  const failingSecurityGates = rungs
    .filter((r) => r.layer === "security" && r.passed === false && r.skipped !== true)
    .map((r) => r.gate ?? "security");
  return {
    passed: bundle.passed === true,
    gatesRun: rungs.length,
    ...(failingSecurityGates.length > 0 ? { failingSecurityGates } : {}),
  };
}

/** The shortest legal route between two columns (for rollup), or undefined. */
export function legalPath(from: CardStatus, to: CardStatus): CardStatus[] | undefined {
  if (from === to) return [];
  const queue: CardStatus[][] = [[from]];
  const seen = new Set<CardStatus>([from]);
  while (queue.length > 0) {
    const path = queue.shift() as CardStatus[];
    for (const next of LEGAL_TRANSITIONS[path[path.length - 1] as CardStatus] ?? []) {
      if (seen.has(next)) continue;
      if (next === to) return [...path.slice(1), next];
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return undefined;
}

export interface BoardServiceOptions {
  customLimits?: Partial<Record<CardStatus, number>>;
  /** Minutes a human can spend reviewing per day, used to derive ReviewWIP. */
  reviewMinutesPerDay?: number;
  /**
   * Called for every override (an `override:` reason past an illegal edge or
   * an entry condition). The board also records a `card/override` event.
   */
  onOverride?: (t: CardTransition, reason: string) => void;
  /**
   * Check each column's entry condition (B1, design "Entry conditions").
   * The harness turns this on; a bare board (and its unit tests) checks
   * only the edge table and the WIP limits.
   */
  entryConditions?: boolean;
  /** The card's latest evidence, for the Review entry condition. */
  evidenceFor?: (
    cardId: string,
  ) => Promise<EvidenceSummary | undefined> | EvidenceSummary | undefined;
}

/** Who may record acceptance (the Done entry condition): a person, or the harness's --auto-accept. */
const ACCEPTING_ACTORS = new Set(["human", "harness"]);

/**
 * Columns a card only reaches by having passed its gates (B12).
 *
 * Moving into either is the act an override exists to force, so these are the
 * two doors the security refusal below has to stand at.
 */
const GATED_COLUMNS = new Set<CardStatus>(["review", "done"]);

export class BoardServiceImpl implements BoardService {
  private wipLimits: Record<CardStatus, number>;
  private options: BoardServiceOptions;

  constructor(
    private cardStore: CardStore,
    optionsOrLimits: BoardServiceOptions | Partial<Record<CardStatus, number>> = {},
  ) {
    // Accept the legacy positional limits object as well as the options form.
    const options: BoardServiceOptions =
      "customLimits" in optionsOrLimits ||
      "reviewMinutesPerDay" in optionsOrLimits ||
      "onOverride" in optionsOrLimits ||
      "entryConditions" in optionsOrLimits ||
      "evidenceFor" in optionsOrLimits
        ? (optionsOrLimits as BoardServiceOptions)
        : { customLimits: optionsOrLimits as Partial<Record<CardStatus, number>> };

    this.options = options;
    this.wipLimits = { ...DEFAULT_WIP_LIMITS, ...(options.customLimits ?? {}) };
  }

  /**
   * The entry condition a move into `to` fails, or undefined (B1). Checked
   * after the edge table, before back-pressure and WIP.
   */
  public async entryConditionFailure(
    card: CardRecord,
    t: CardTransition,
  ): Promise<string | undefined> {
    const to = t.toStatus;
    if (to === "ready" || to === "in_progress" || to === "planning") {
      const waiting = this.cardStore.waitingOn(card.id);
      if (waiting.length > 0) {
        return `${card.id} waits on ${waiting.join(", ")}, which ${waiting.length === 1 ? "is" : "are"} not done`;
      }
    }
    if (to === "ready" && t.fromStatus === "backlog") {
      const criteria =
        (card.acceptanceCriteria?.length ?? 0) > 0 || (card.acceptanceTests?.length ?? 0) > 0;
      if (!criteria)
        return `${card.id} has no acceptance criteria or tests; write them before it is Ready`;
    }
    // A parent's scope is its children's; it never runs itself (B7 rollup).
    const isParent = (await this.cardStore.listCards({ parentId: card.id })).length > 0;
    if (to === "in_progress" && card.scopeFiles.length === 0 && !isParent) {
      return `${card.id} declares no scope files; declare what it may change before it starts`;
    }
    if (to === "review") {
      const evidence = await this.options.evidenceFor?.(card.id);
      if (!evidence) return `${card.id} has no evidence bundle; Review needs one`;
      if (!evidence.passed || evidence.gatesRun === 0) {
        return `${card.id}'s latest evidence ${evidence.gatesRun === 0 ? "ran no gates" : "did not pass every gate"}`;
      }
    }
    if (to === "done" && !ACCEPTING_ACTORS.has(t.actor)) {
      return `Only a person accepts a card (actor was ${t.actor})`;
    }
    return undefined;
  }

  /** Record an override on the ledger as the human decision it is (B1). */
  private async recordOverride(t: CardTransition, what: string): Promise<void> {
    this.options.onOverride?.(t, t.reason ?? "unspecified");
    await this.cardStore
      .recordEvent({
        type: "card/override",
        cardId: t.cardId,
        actor: t.actor === "human" ? "human" : "system",
        payload: {
          id: t.cardId,
          from: t.fromStatus,
          to: t.toStatus,
          overrode: what,
          reason: t.reason ?? "",
        },
      })
      .catch(() => undefined);
  }

  /**
   * ReviewWIP = floor(reviewMinutesPerDay / medianReviewMinutesPerCard), min 1.
   *
   * Derived from the project's own accepted-card history rather than fixed at a
   * constant, because the bottleneck being modelled is a specific human's
   * available review time.
   */
  public async computeReviewWip(reviewMinutesPerDay?: number): Promise<number> {
    const budget = reviewMinutesPerDay ?? this.options.reviewMinutesPerDay;
    if (!budget || budget <= 0) return this.wipLimits.review;

    const durations = (await this.measuredReviewMinutes()).sort((a, b) => a - b);

    if (durations.length === 0) return this.wipLimits.review;

    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
        : (durations[mid] as number);

    return Math.max(1, Math.floor(budget / median));
  }

  /**
   * Minutes each review took (B3): from a card entering Review to the
   * person's verdict (accept, return, park), read from the ledger's status
   * changes. Every review counts, not only accepted ones: a return costs the
   * reviewer the same reading time.
   */
  public async measuredReviewMinutes(): Promise<number[]> {
    const out: number[] = [];
    for (const card of await this.cardStore.listCards()) {
      const changes = await this.cardStore.cardEvents(card.id, ["card/status_changed"]);
      let enteredAt: number | undefined;
      for (const e of changes) {
        const p = e.payload as { toStatus?: string; fromStatus?: string; updatedAt?: string };
        const at = Date.parse(p.updatedAt ?? e.createdAt);
        if (p.toStatus === "review") enteredAt = at;
        else if (p.fromStatus === "review" && enteredAt !== undefined) {
          const minutes = (at - enteredAt) / 60_000;
          if (minutes > 0) out.push(minutes);
          enteredAt = undefined;
        }
      }
    }
    return out;
  }

  /** Apply a history-derived ReviewWIP, replacing the static default. */
  public async calibrateReviewWip(reviewMinutesPerDay: number): Promise<number> {
    const limit = await this.computeReviewWip(reviewMinutesPerDay);
    this.wipLimits = { ...this.wipLimits, review: limit };
    return limit;
  }

  public async transitionCard(t: CardTransition): Promise<void> {
    const card = await this.cardStore.getCard(t.cardId);
    if (!card) {
      throw new TransitionRefusedError(
        "card_not_found",
        t.cardId,
        t.toStatus,
        `Card not found: ${t.cardId}`,
      );
    }

    if (t.toStatus === t.fromStatus) {
      await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, t.actor);
      return;
    }

    const legal = LEGAL_TRANSITIONS[t.fromStatus] ?? [];
    const override = t.reason?.startsWith("override:") === true;

    // B12: an override is a person taking responsibility for a judgement the
    // board would otherwise refuse — but never for a secret in the diff or a
    // vulnerable dependency. Those are not judgement calls, and a harness that
    // lets one through on a typed reason has no security layer at all. Checked
    // before the override branches below, so nothing can swallow it.
    if (GATED_COLUMNS.has(t.toStatus)) {
      const failing = (await this.options.evidenceFor?.(card.id))?.failingSecurityGates ?? [];
      if (failing.length > 0) {
        throw new TransitionRefusedError(
          "security_gate",
          t.cardId,
          t.toStatus,
          `${t.cardId} cannot move to '${t.toStatus}': its latest evidence fails the security gate(s) ${failing.join(", ")}. A security-layer failure is never overridden; fix it, or reject the card.`,
        );
      }
    }
    if (!legal.includes(t.toStatus)) {
      if (!override) {
        throw new TransitionRefusedError(
          "illegal_transition",
          t.cardId,
          t.toStatus,
          `Illegal transition '${t.fromStatus}' -> '${t.toStatus}' for card ${t.cardId}. Legal destinations: ${legal.join(", ")}`,
        );
      }
      await this.recordOverride(t, "edge");
    }

    if (this.options.entryConditions) {
      const failure = await this.entryConditionFailure(card, t);
      if (failure && !override) {
        throw new TransitionRefusedError("entry_condition", t.cardId, t.toStatus, failure);
      }
      if (failure) await this.recordOverride(t, `entry condition: ${failure}`);
    }

    // Back-pressure blocks entry to VERIFY, not Review (design §392). Holding
    // cards one column upstream is what stops work piling into a queue the
    // human cannot drain; blocking at Review would let Verify fill instead.
    if (t.toStatus === "verify") {
      const reviewCards = await this.cardStore.listCards({ status: "review" });
      if (reviewCards.length >= this.wipLimits.review) {
        throw new TransitionRefusedError(
          "back_pressure",
          t.cardId,
          t.toStatus,
          `Back-pressure: Review is at capacity (${reviewCards.length}/${this.wipLimits.review}). No card may enter Verify until a review is accepted or returned.`,
        );
      }
    }

    const cardsInTarget = await this.cardStore.listCards({ status: t.toStatus });
    const limit = this.wipLimits[t.toStatus];
    if (cardsInTarget.length >= limit) {
      throw new TransitionRefusedError(
        "wip_limit",
        t.cardId,
        t.toStatus,
        `WIP limit exceeded for column '${t.toStatus}': ${cardsInTarget.length}/${limit} cards active`,
      );
    }

    await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, t.actor);
  }

  /**
   * Hold a card where it stands with a recorded reason (defect 1).
   *
   * Used when a move the runner wanted was refused by back-pressure: the card
   * keeps its column and its work, the board shows why it is waiting, and the
   * queue carries on instead of aborting. `releaseHeld` resumes it later.
   */
  public async holdCard(cardId: string, reason: string, actor = "executor"): Promise<void> {
    const text = reason.trim();
    if (!text) throw new Error("A held card needs a reason");
    const card = await this.cardStore.getCard(cardId);
    if (!card) {
      throw new TransitionRefusedError(
        "card_not_found",
        cardId,
        "verify",
        `Card not found: ${cardId}`,
      );
    }
    const blockedReason = text.startsWith(HELD_REASON_PREFIX)
      ? text
      : `${HELD_REASON_PREFIX} ${text}`;
    await this.cardStore.updateCard(cardId, { blockedReason }, actor);
  }

  /** Cards the runner held, oldest first. */
  public async listHeld(): Promise<CardRecord[]> {
    const cards = await this.cardStore.listCards();
    return cards
      .filter((c) => c.blockedReason?.startsWith(HELD_REASON_PREFIX))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  /**
   * Retry the move a held card was waiting for, clearing the hold on success.
   * Returns false (and keeps the hold) while the move is still refused.
   */
  public async releaseHeld(
    cardId: string,
    toStatus: CardStatus,
    actor = "executor",
  ): Promise<boolean> {
    const card = await this.cardStore.getCard(cardId);
    if (!card?.blockedReason?.startsWith(HELD_REASON_PREFIX)) return false;
    try {
      await this.transitionCard({
        cardId,
        fromStatus: card.status,
        toStatus,
        actor,
        reason: "released from hold",
      });
    } catch (err) {
      if (
        err instanceof TransitionRefusedError &&
        (err.code === "back_pressure" || err.code === "wip_limit")
      ) {
        return false;
      }
      throw err;
    }
    await this.cardStore.updateCard(cardId, { blockedReason: null }, actor);
    return true;
  }

  public async checkWipLimits(): Promise<WipLimitStatus[]> {
    const cards = await this.cardStore.listCards();
    const counts = {} as Record<CardStatus, number>;
    for (const column of Object.keys(this.wipLimits) as CardStatus[]) counts[column] = 0;
    for (const c of cards) counts[c.status] = (counts[c.status] ?? 0) + 1;

    return (Object.entries(this.wipLimits) as [CardStatus, number][]).map(([col, limit]) => ({
      column: col,
      currentCount: counts[col] ?? 0,
      maxLimit: limit,
      isExceeded: (counts[col] ?? 0) > limit,
      // Enforcement blocks at >= limit, so this is the flag the UI reads.
      isAtCapacity: (counts[col] ?? 0) >= limit,
    }));
  }

  /**
   * Running cards that would edit a file `card` declares (B6). Two cards
   * that touch the same file must be serialised: their worktrees would
   * merge into a conflict, and each gate run would measure the other's
   * half-done change.
   */
  public async overlappingRunning(card: CardRecord): Promise<ScopeOverlap[]> {
    // A held card is waiting for a column, not editing: it does not block.
    const running = (await this.cardStore.listCards({ status: "in_progress" })).filter(
      (c) => c.id !== card.id && !c.blockedReason?.startsWith(HELD_REASON_PREFIX),
    );
    const out: ScopeOverlap[] = [];
    for (const other of running) {
      const files = card.scopeFiles.filter((f) =>
        other.scopeFiles.some((g) => matchesScope(f, g) || matchesScope(g, f)),
      );
      if (files.length > 0) out.push({ cardId: other.id, files });
    }
    return out;
  }

  public async getBoardState(filter: { projectId?: string } = {}): Promise<BoardState> {
    const all = await this.cardStore.listCards();
    // B8: a project's board shows its own cards (cards from before projects
    // existed have none and belong to every board).
    const cards = filter.projectId
      ? all.filter((c) => !c.projectId || c.projectId === filter.projectId)
      : all;
    const reviewCount = cards.filter((c) => c.status === "review").length;

    return {
      cards,
      wipLimits: this.wipLimits,
      backpressureActive: reviewCount >= this.wipLimits.review,
    };
  }
}
