import type { CardRecord, CardStatus } from "@sekhemet/kernel";

export interface CardTransition {
  cardId: string;
  fromStatus: CardStatus;
  toStatus: CardStatus;
  actor: string;
  reason?: string;
}

export interface WipLimitStatus {
  column: CardStatus;
  currentCount: number;
  maxLimit: number;
  /** Strictly over the limit — should never happen if enforcement is working. */
  isExceeded: boolean;
  /**
   * At or over the limit, so the next transition into this column is blocked.
   *
   * Enforcement rejects at `>= limit`, so this — not `isExceeded` — is what the
   * board must show. Reporting "fine" while transitions are being refused is
   * how a queue looks healthy and behaves stuck.
   */
  isAtCapacity: boolean;
}

export interface BoardState {
  cards: CardRecord[];
  wipLimits: Record<CardStatus, number>;
  backpressureActive: boolean;
}

export interface BoardService {
  transitionCard(t: CardTransition): Promise<void>;
  getBoardState(): Promise<BoardState>;
  checkWipLimits(): Promise<WipLimitStatus[]>;
}
