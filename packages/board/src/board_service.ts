import type { CardRecord, CardStatus, CardStore } from "@sekhemet/kernel";
import type { BoardService, BoardState, CardTransition, WipLimitStatus } from "./types.js";

const DEFAULT_WIP_LIMITS: Record<CardStatus, number> = {
  backlog: 500,
  ready: 50,
  in_progress: 5,
  verify: 5,
  review: 3, // Solo developer review bottleneck
  done: 10000,
  rejected: 10000,
  parked: 10000,
};

export class BoardServiceImpl implements BoardService {
  private wipLimits: Record<CardStatus, number>;

  constructor(
    private cardStore: CardStore,
    customLimits: Partial<Record<CardStatus, number>> = {},
  ) {
    this.wipLimits = { ...DEFAULT_WIP_LIMITS, ...customLimits };
  }

  public async transitionCard(t: CardTransition): Promise<void> {
    const card = await this.cardStore.getCard(t.cardId);
    if (!card) {
      throw new Error(`Card not found: ${t.cardId}`);
    }

    // Check WIP limit on destination column
    if (t.toStatus !== t.fromStatus) {
      const cardsInTarget = await this.cardStore.listCards({ status: t.toStatus });
      const limit = this.wipLimits[t.toStatus];
      if (cardsInTarget.length >= limit) {
        throw new Error(
          `WIP limit exceeded for column '${t.toStatus}': ${cardsInTarget.length}/${limit} cards active`,
        );
      }
    }

    await this.cardStore.updateCardStatus(t.cardId, t.toStatus, t.reason);
  }

  public async checkWipLimits(): Promise<WipLimitStatus[]> {
    const cards = await this.cardStore.listCards();
    const counts: Record<CardStatus, number> = {
      backlog: 0,
      ready: 0,
      in_progress: 0,
      verify: 0,
      review: 0,
      done: 0,
      rejected: 0,
      parked: 0,
    };

    for (const c of cards) {
      counts[c.status]++;
    }

    const result: WipLimitStatus[] = [];
    for (const [col, limit] of Object.entries(this.wipLimits) as [CardStatus, number][]) {
      const currentCount = counts[col];
      result.push({
        column: col,
        currentCount,
        maxLimit: limit,
        isExceeded: currentCount > limit,
      });
    }

    return result;
  }

  public async getBoardState(): Promise<BoardState> {
    const cards = await this.cardStore.listCards();
    const reviewCount = cards.filter((c) => c.status === "review").length;
    const reviewLimit = this.wipLimits.review;
    const backpressureActive = reviewCount >= reviewLimit;

    return {
      cards,
      wipLimits: this.wipLimits,
      backpressureActive,
    };
  }
}
