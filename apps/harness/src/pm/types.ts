/**
 * Shapes shared by the PM backend and the dashboard (docs/design/PM_CONTRACT.md).
 * Change the contract first, then this file.
 */

export type PmRole = "user" | "pm" | "system";
export type PmMessageState = "queued" | "thinking" | "done" | "error";

export interface PmContext {
  cardId?: string;
  view?: string;
}

export type PmProposalKind =
  | "create_card"
  | "update_card"
  | "split_card"
  | "reorder"
  | "move_card"
  | "create_cycle"
  | "assign_cycle"
  | "park"
  | "unpark";

export type PmProposalState = "open" | "applied" | "discarded" | "stale";

export interface PmProposal {
  id: string;
  kind: PmProposalKind;
  summary: string;
  cardId?: string;
  patch?: Record<string, unknown>;
  before?: Record<string, unknown>;
  cards?: Record<string, unknown>[];
  state: PmProposalState;
  /**
   * Where the proposal's content came from: `import` for a file's rows.
   * Applied, each card it touches is recorded `card/imported` and its text
   * reaches the Worker tagged untrusted (B4.9 part 2, M3).
   */
  origin?: "import";
}

export interface PmCite {
  cardId?: string;
  runId?: string;
  evidenceId?: string;
  /** A research source: a URL when there is one, and what it is. */
  url?: string;
  label?: string;
}

export interface PmMessage {
  id: string;
  seq: number;
  role: PmRole;
  text: string;
  createdAt: string;
  state: PmMessageState;
  context?: PmContext;
  proposals?: PmProposal[];
  cites?: PmCite[];
}

export type PmPhase = "idle" | "waiting_for_step" | "loading_pm" | "thinking" | "resuming_worker";

export interface PmStatus {
  phase: PmPhase;
  detail?: string;
  model?: string;
  workerPaused?: boolean;
  since?: string;
  step?: number;
  etaSeconds?: number;
}

export interface Cycle {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  goal?: string;
  state: "planned" | "active" | "closed";
}

/** Ledger event types the PM backend writes. */
export const PM_EVENTS = {
  message: "pm/message",
  reply: "pm/reply",
  status: "pm/status",
  proposalState: "pm/proposal_state",
  cycleCreated: "cycle/created",
  cycleUpdated: "cycle/updated",
  notify: "pm/notify",
  /** A notice past the day's budget, held for the next standup (INT-20a). */
  noticeHeld: "pm/notice_held",
  /**
   * A notifier's claim on a send, by an id derived from the notice (or the
   * channel's standup and attempt), before anything is sent: of two notifiers
   * on one ledger only one may record it, so each is sent once (B4.9 part 2, B2).
   */
  notifyClaimed: "pm/notify_claimed",
  summary: "pm/summary",
} as const;
