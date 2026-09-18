import type { CardRecord, CardStatus, CardStore } from "@sekhemet/kernel";
import type { BoardService, BoardState, CardTransition, WipLimitStatus } from "./types.js";

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

export interface BoardServiceOptions {
  customLimits?: Partial<Record<CardStatus, number>>;
  /** Minutes a human can spend reviewing per day, used to derive ReviewWIP. */
  reviewMinutesPerDay?: number;
  /** Allow a transition the edge table forbids, recording the reason. */
  onOverride?: (t: CardTransition, reason: string) => void;
}

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
      "onOverride" in optionsOrLimits
        ? (optionsOrLimits as BoardServiceOptions)
        : { customLimits: optionsOrLimits as Partial<Record<CardStatus, number>> };

    this.options = options;
    this.wipLimits = { ...DEFAULT_WIP_LIMITS, ...(options.customLimits ?? {}) };
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

    const accepted = await this.cardStore.listCards({ status: "done" });
    const durations = accepted
      .map((c) => this.reviewMinutes(c))
      .filter((m): m is number => m !== undefined && m > 0)
      .sort((a, b) => a - b);

    if (durations.length === 0) return this.wipLimits.review;

    const mid = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 === 0
        ? ((durations[mid - 1] as number) + (durations[mid] as number)) / 2
        : (durations[mid] as number);

    return Math.max(1, Math.floor(budget / median));
  }

  /** Minutes a card spent between its last update and creation, as a proxy. */
  private reviewMinutes(card: CardRecord): number | undefined {
    const created = Date.parse(card.createdAt);
    const updated = Date.parse(card.updatedAt);
    if (Number.isNaN(created) || Number.isNaN(updated) || updated <= created) return undefined;
    return (updated - created) / 60_000;
  }

  /** Apply a history-derived ReviewWIP, replacing the static default. */
  public async calibrateReviewWip(reviewMinutesPerDay: number): Promise<number> {
    const limit = await this.computeReviewWip(reviewMinutesPerDay);
    this.wipLimits = { ...this.wipLimits, review: limit };
    return limit;
  }

  public async transitionCard(t: CardTransition): Promise<void> {
    const card = await this.cardStore.getCard(t.cardId);
    if (!card) throw new Error(`Card not found: ${t.cardId}`);

    if (t.toStatus === t.fromStatus) {
      await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, t.actor);
      return;
    }

    const legal = LEGAL_TRANSITIONS[t.fromStatus] ?? [];
    if (!legal.includes(t.toStatus)) {
      const override = t.reason?.startsWith("override:");
      if (!override) {
        throw new Error(
          `Illegal transition '${t.fromStatus}' -> '${t.toStatus}' for card ${t.cardId}. Legal destinations: ${legal.join(", ")}`,
        );
      }
      this.options.onOverride?.(t, t.reason ?? "unspecified");
    }

    // Back-pressure blocks entry to VERIFY, not Review (design §392). Holding
    // cards one column upstream is what stops work piling into a queue the
    // human cannot drain; blocking at Review would let Verify fill instead.
    if (t.toStatus === "verify") {
      const reviewCards = await this.cardStore.listCards({ status: "review" });
      if (reviewCards.length >= this.wipLimits.review) {
        throw new Error(
          `Back-pressure: Review is at capacity (${reviewCards.length}/${this.wipLimits.review}). No card may enter Verify until a review is accepted or returned.`,
        );
      }
    }

    const cardsInTarget = await this.cardStore.listCards({ status: t.toStatus });
    const limit = this.wipLimits[t.toStatus];
    if (cardsInTarget.length >= limit) {
      throw new Error(
        `WIP limit exceeded for column '${t.toStatus}': ${cardsInTarget.length}/${limit} cards active`,
      );
    }

    await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason, t.actor);
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

  public async getBoardState(): Promise<BoardState> {
    const cards = await this.cardStore.listCards();
    const reviewCount = cards.filter((c) => c.status === "review").length;

    return {
      cards,
      wipLimits: this.wipLimits,
      backpressureActive: reviewCount >= this.wipLimits.review,
    };
  }
}
