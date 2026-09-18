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

/** Why the board refused a column move. */
export type TransitionRefusalCode =
  | "back_pressure"
  | "wip_limit"
  | "illegal_transition"
  | "card_not_found";

/**
 * A refused column move, typed so a caller can tell back-pressure (hold the
 * card and carry on) from a programming error (an illegal edge).
 *
 * `code` is a plain string property, so a package that cannot import the board
 * (the loop sits below it) can still recognise the refusal by duck-typing.
 */
export class TransitionRefusedError extends Error {
  public readonly code: TransitionRefusalCode;
  public readonly cardId: string;
  public readonly toStatus: CardStatus;

  constructor(code: TransitionRefusalCode, cardId: string, toStatus: CardStatus, message: string) {
    super(message);
    this.name = "TransitionRefusedError";
    this.code = code;
    this.cardId = cardId;
    this.toStatus = toStatus;
  }
}

/** Prefix of `blockedReason` on a card the runner held at a refused move. */
export const HELD_REASON_PREFIX = "held:";
