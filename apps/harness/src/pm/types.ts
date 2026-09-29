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
  | "unpark"
  /** Plan a project through the one planner (PM-P1-1): `patch.brief` is the person's words. */
  | "start_project";

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
  /** Why Seshat proposes it (PM-N9-4); the summary ends "Why: <why>." */
  why?: string;
  /**
   * The suggestion on the issue this proposal is (PM-N9-1): applying either
   * applies both, discarding it dismisses the suggestion (TEAM-19).
   */
  suggestionId?: string;
  /**
   * The issue's owner, when that is not the person Seshat answered (Team
   * setup, PM-N9-9): only the owner applies it.
   */
  forOwner?: string;
  /**
   * Where the proposal's content came from: `import` for a file's rows.
   * Applied, each card it touches is recorded `card/imported` and its text
   * reaches the Worker tagged untrusted (B4.9 part 2, M3).
   */
  origin?: "import";
  /**
   * A Stakeholder's new project sent to a named Member or Admin (teams
   * TEAM-20, design-stage §2.9 item 7): nothing is created until they approve.
   */
  approval?: PmPlanApproval;
}

/** Where a sent plan stands (TEAM-20, TEAM-42); names are added for the reader. */
export interface PmPlanApproval {
  state: "sent" | "approved";
  /** The Member or Admin it was sent to, who alone approves it. */
  approver: string;
  /** The Stakeholder who sent it. */
  requestedBy: string;
  /** Review plan's choices as sent; the approver may edit them before approving. */
  choices?: Record<string, unknown>;
  /** Who approved it: the approver, who owns the issues it created. */
  approvedBy?: string;
  approverName?: string;
  requestedByName?: string;
}

export interface PmCite {
  cardId?: string;
  runId?: string;
  evidenceId?: string;
  /** A goal the reply answers from (PM-P6-1). */
  goalId?: string;
  /** A logged assumption the reply answers from (PM-P6-1). */
  assumptionId?: string;
  /** An AI review finding: its dossier entry id (PM-P6-2). */
  findingId?: string;
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
  /** Who wrote a user message; for a reply, who it answers (Team setup, PM-N9-8). */
  principal?: string;
  /** For a reply: the senior-PM skill's version it was written under (PM-P6-4). */
  skillVersion?: string;
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
  /** A notice shown in Seshat's panel instead, the board being in focus (PM-P6-10). */
  noticeShown: "pm/notice_shown",
  /** The dashboard was in focus for this person (PM-P6-10); recorded at most once a minute. */
  boardFocus: "pm/board_focus",
  /**
   * A notifier's claim on a send, by an id derived from the notice (or the
   * channel's standup and attempt), before anything is sent: of two notifiers
   * on one ledger only one may record it, so each is sent once (B4.9 part 2, B2).
   */
  notifyClaimed: "pm/notify_claimed",
  summary: "pm/summary",
  /** A Stakeholder's plan sent to a named approver (teams §3, TEAM-20). */
  planSent: "plan/sent_for_approval",
  /** The approver approved it; the project exists from here (TEAM-20, TEAM-42). */
  planApproved: "plan/approved",
} as const;
