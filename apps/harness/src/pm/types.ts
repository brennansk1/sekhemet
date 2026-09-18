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
}

export interface PmCite {
  cardId?: string;
  runId?: string;
  evidenceId?: string;
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
} as const;
