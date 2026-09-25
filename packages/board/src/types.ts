import type { CardRecord, CardStatus } from "@sekhemet/kernel";

export interface CardTransition {
  cardId: string;
  /** The status the caller expects the card to be in: checked against the stored one (rule 26). */
  fromStatus: CardStatus;
  toStatus: CardStatus;
  actor: string;
  reason?: string;
  /**
   * The person moving the card (rule 19). An `override:` reason is refused
   * without one (rule 28, K-S4-5); until principals are opaque ids on every
   * event (NEW-kernel-2) it is recorded in the `card/override` payload.
   */
  principal?: string;
  /**
   * Card events committed in the same transaction as the move (kernel S7):
   * Accept's `card/accepted` with the move to Done (review-git §2.5.3).
   */
  with?: readonly {
    type: string;
    actor: string;
    payload: unknown;
    principal?: string;
    private?: Record<string, unknown>;
  }[];
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
  /** The board, optionally one project's (B8). */
  getBoardState(filter?: { projectId?: string }): Promise<BoardState>;
  checkWipLimits(): Promise<WipLimitStatus[]>;
}

/** Why the board refused a column move. */
export type TransitionRefusalCode =
  | "back_pressure"
  | "wip_limit"
  | "illegal_transition"
  | "card_not_found"
  /** A column's entry condition does not hold (B1). */
  | "entry_condition"
  /** The card's latest evidence fails a security-layer gate (B12). */
  | "security_gate"
  /** The caller's `fromStatus` is not the stored status (rule 26, K-S4-1). */
  | "stale_from"
  /** An `override:` from anyone but a person with a principal (rule 28, K-S4-5). */
  | "override_forbidden";

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

/** Evidence the Review entry condition reads (B1): the card's latest bundle. */
export interface EvidenceSummary {
  passed: boolean;
  /** Gates that ran, so an empty bundle does not pass as complete. */
  gatesRun: number;
  /**
   * Gate ids in the `security` layer that this evidence records as failing.
   *
   * Kept apart from the rest of the failures because the board treats them
   * differently: every other gate may be overridden by a person who takes
   * responsibility, and these may not (B12).
   */
  failingSecurityGates?: string[];
}

/** Two cards that would edit the same file, so they must not run at once (B6). */
export interface ScopeOverlap {
  cardId: string;
  files: string[];
}
