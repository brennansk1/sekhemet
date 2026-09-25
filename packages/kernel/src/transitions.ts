import type { CardStatus } from "./types.js";

/**
 * The transition law (kernel.md rules 23, 25, 26; S4). It lives in the
 * kernel, the root of the package graph, so the one method that writes a
 * card's status checks it against the stored status: no caller can reach a
 * state by naming a status it only believes the card is in.
 */

/** The nine stored states, and nothing else (rule 23). */
export const CARD_STATUSES: readonly CardStatus[] = [
  "backlog",
  "ready",
  "planning",
  "in_progress",
  "verify",
  "review",
  "done",
  "parked",
  "rejected",
];

export function isCardStatus(value: unknown): value is CardStatus {
  return typeof value === "string" && (CARD_STATUSES as readonly string[]).includes(value);
}

/**
 * The states a card may be created in (rule 26, K-S4-9), and `parked` with
 * its recorded reason (`blockedReason`). Verify, Review and Done are reached
 * only by a move that meets their entry conditions (a finished attempt,
 * passing evidence, a person's acceptance), and Rejected only by a decision:
 * creating a card there would be a status write outside the law.
 */
export const INITIAL_CARD_STATUSES: readonly CardStatus[] = [
  "backlog",
  "ready",
  "planning",
  "in_progress",
];

/**
 * The legal edges, one table (rule 25). Without it any status could move to
 * any other, so `backlog -> done` was permitted: a card could be marked
 * complete having never been executed or verified.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<CardStatus, readonly CardStatus[]>> = {
  backlog: ["ready", "parked", "rejected"],
  ready: ["planning", "in_progress", "backlog", "parked", "rejected"],
  // Planning is where a card is decomposed or replanned before execution.
  planning: ["ready", "in_progress", "backlog", "parked", "rejected"],
  in_progress: ["verify", "ready", "planning", "parked", "rejected"],
  // A regression returns the card to Planning, not In Progress, so the cause is
  // re-examined rather than patched again by the same failing approach.
  verify: ["review", "planning", "in_progress", "ready", "parked", "rejected"],
  review: ["done", "planning", "ready", "in_progress", "parked", "rejected"],
  done: ["ready"],
  // Unpark returns to Backlog or Planning, or re-queues at Ready; never into
  // the middle of a state (rule 25, K-N5-6).
  parked: ["ready", "planning", "backlog", "rejected"],
  rejected: ["backlog", "ready"],
};

/** Why the kernel refused a status write (rule 26). */
export type StatusRefusalCode =
  /** The caller named a status the card is not in. */
  | "stale_from"
  /** The edge from the stored status is not in `LEGAL_TRANSITIONS`. */
  | "illegal_transition"
  /** Not one of the nine states. */
  | "invalid_status"
  | "card_not_found";

export class StatusTransitionError extends Error {
  public readonly code: StatusRefusalCode;
  public readonly cardId: string;
  public readonly toStatus: string;

  constructor(code: StatusRefusalCode, cardId: string, toStatus: string, message: string) {
    super(message);
    this.name = "StatusTransitionError";
    this.code = code;
    this.cardId = cardId;
    this.toStatus = toStatus;
  }
}
