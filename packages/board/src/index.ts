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
  isExceeded: boolean;
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
