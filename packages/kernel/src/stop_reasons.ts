import type { CardStopReason } from "./types.js";

/**
 * The class a stop reason is shown under (worker-loop rule 31, DEC-24): one
 * success class that holds only `gate_passed`, and seven failure classes —
 * the old six plus `environment`, failures of the machine or the repository
 * that must never read as the Worker's fault. A new condition is a new
 * stored reason inside a class, never a new class.
 */
export type StopReasonClass =
  | "success"
  | "budget_exhausted"
  | "no_progress"
  | "done_pending_gates"
  | "scope_violation"
  | "capability_ceiling"
  | "human_abort"
  | "environment";

export const STOP_REASON_CLASSES: readonly StopReasonClass[] = [
  "success",
  "budget_exhausted",
  "no_progress",
  "done_pending_gates",
  "scope_violation",
  "capability_ceiling",
  "human_abort",
  "environment",
];

/** One row of the stop-reason table (worker-loop rule 31). */
export interface StopReasonRow {
  class: StopReasonClass;
  /**
   * Whether the card parks for a person. `unless_gates_ran`: a budget stop
   * parks only when it never reached the gates; one that did has a verdict to
   * re-plan against (L22).
   */
  parks: "yes" | "no" | "unless_gates_ran";
  /** The next run resumes from the last checkpoint rather than restarting (H17). */
  resumable: boolean;
  /** The runner may run one verification after it when the scope is complete. */
  mayVerify: boolean;
  /** A checkpoint captures the partial work at this stop, so a resume starts from it. */
  checkpoints: boolean;
  /** No further pass@k sample is drawn after it (G25). */
  endsSampling: boolean;
  /** The attempt is recorded `halted`, not `failed`: it says nothing about the model. */
  halts: boolean;
  /** The attempt counts in the competence model. */
  measuresModel: boolean;
  /** Where the card goes. */
  goesTo: string;
  /** The next action shown to the person. */
  nextAction: string;
}

/**
 * The one stop-reason table (worker-loop rule 31, WL-T3-2, WL-T3-9,
 * WL-T3-10). The runner, the session, the evidence bundle and the dashboard
 * read it; no other list of stop reasons exists. `CARD_STOP_REASONS` is its
 * keys, so a reason cannot be stored without a row.
 */
export const STOP_REASONS: Readonly<Record<CardStopReason, StopReasonRow>> = {
  gate_passed: {
    class: "success",
    parks: "no",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Review",
    nextAction: "Ready for review.",
  },
  budget_exhausted: {
    class: "budget_exhausted",
    parks: "unless_gates_ran",
    resumable: false,
    mayVerify: true,
    checkpoints: true,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Parked; Planning with the failures when the gates ran",
    nextAction:
      "By the budget that ran out: steps — raise the step budget for the class or split the card; context — the prompt reached 95% of its budget, so split the card or narrow its scope (raising the step budget cannot help).",
  },
  token_budget_exhausted: {
    class: "budget_exhausted",
    parks: "unless_gates_ran",
    resumable: false,
    mayVerify: true,
    checkpoints: true,
    endsSampling: true,
    halts: false,
    measuresModel: true,
    goesTo: "Parked; Planning with the failures when the gates ran",
    nextAction: "Tokens used of the budget: raise it for the class or split the card.",
  },
  time_budget_exhausted: {
    class: "budget_exhausted",
    parks: "unless_gates_ran",
    resumable: false,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: false,
    measuresModel: true,
    goesTo: "Parked; Planning with the failures when the gates ran",
    nextAction: "Seconds used of the budget: raise it for the class or split the card.",
  },
  no_progress: {
    class: "no_progress",
    parks: "no",
    resumable: false,
    mayVerify: true,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Verify",
    nextAction: "Read what the agent said on each silent step, and the call it should have made.",
  },
  oscillation_detected: {
    class: "no_progress",
    parks: "no",
    resumable: false,
    mayVerify: true,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Verify",
    nextAction: "See the repeated call and what to do instead.",
  },
  vacuous_tests: {
    class: "no_progress",
    parks: "yes",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: false,
    goesTo: "Parked, before any step",
    nextAction: "The tests already pass: rewrite them to fail until the behaviour exists.",
  },
  tests_not_red_for_reason: {
    class: "no_progress",
    parks: "yes",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: true,
    halts: false,
    measuresModel: false,
    goesTo: "Parked, before any step",
    nextAction:
      "A test fails for the wrong reason (an import, compile, collection or setup error): have the test-author step make it fail at an assertion.",
  },
  base_not_green: {
    class: "no_progress",
    parks: "yes",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: true,
    halts: false,
    // A precondition that failed before any work: never the Worker's.
    measuresModel: false,
    goesTo: "Parked, before any step",
    nextAction:
      "A characterize, refactor or upgrade card's tests fail on the base: they must pass there before the card can start. Fix the tests, or plan the card as a fix.",
  },
  done_pending_gates: {
    class: "done_pending_gates",
    parks: "no",
    resumable: false,
    mayVerify: true,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Verify",
    nextAction: "Run the checks.",
  },
  scope_violation: {
    class: "scope_violation",
    parks: "no",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Verify",
    nextAction: "See the file it tried to change, and widen the scope if it belongs to the card.",
  },
  git_metadata_tampered: {
    class: "scope_violation",
    parks: "yes",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: true,
    halts: false,
    measuresModel: true,
    goesTo: "Parked; the worktree is discarded",
    nextAction:
      "Compare the gitdir the .git pointer names with the harness's record (no git command ran), and inspect before re-queuing the card from Ready.",
  },
  repair_exhausted: {
    class: "capability_ceiling",
    parks: "yes",
    resumable: false,
    mayVerify: true,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Parked",
    nextAction: "See what was tried, what failed each time, and what is suspected.",
  },
  capability_ceiling: {
    class: "capability_ceiling",
    parks: "yes",
    resumable: false,
    mayVerify: true,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: true,
    goesTo: "Parked",
    nextAction: "See what was tried after the re-plan; split the card or use a stronger model.",
  },
  replan_requested: {
    class: "capability_ceiling",
    parks: "no",
    resumable: false,
    mayVerify: false,
    checkpoints: true,
    endsSampling: false,
    halts: true,
    measuresModel: false,
    goesTo: "Planning",
    nextAction: "The planning model re-plans; the plan is recorded in the dossier.",
  },
  gate_suspected: {
    class: "capability_ceiling",
    parks: "yes",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: true,
    halts: false,
    measuresModel: true,
    goesTo: "Parked",
    nextAction:
      "See the check and the agent's reason, and decide whether the check or the issue is wrong.",
  },
  human_abort: {
    class: "human_abort",
    parks: "no",
    resumable: true,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Stays; resumes from its last checkpoint",
    nextAction: "See who stopped it; resume or reject.",
  },
  paused: {
    class: "human_abort",
    parks: "no",
    resumable: true,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Stays in progress until a person hands it back; resumes from its checkpoint",
    nextAction: "Hand it back with a note, or take it over.",
  },
  hook_veto: {
    class: "human_abort",
    parks: "yes",
    resumable: true,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Parked",
    nextAction: "See the hook and its reason; change the hook or the card, then unpark.",
  },
  error: {
    class: "environment",
    parks: "no",
    resumable: true,
    mayVerify: true,
    checkpoints: true,
    endsSampling: true,
    halts: false,
    measuresModel: false, // rule 31: never the Worker's fault (DEC-42)
    goesTo: "Resumes from its last checkpoint",
    nextAction: "See the error; the next run resumes.",
  },
  memory_pressure: {
    class: "environment",
    parks: "no",
    resumable: true,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Held; resumes when the watchdog allows",
    nextAction: "See the watchdog level and what to free.",
  },
  quota_suspended: {
    class: "environment",
    parks: "no",
    resumable: true,
    mayVerify: false,
    checkpoints: true,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Held; resumes when the quota returns",
    nextAction: "See the quota and when it resets.",
  },
  crashed: {
    class: "environment",
    parks: "no",
    resumable: true,
    mayVerify: false,
    checkpoints: false,
    endsSampling: true,
    halts: true,
    measuresModel: false,
    goesTo: "Ready, worktree restored to the last checkpoint",
    nextAction: "Resumes from the last completed step on the next run.",
  },
  rebase_conflict: {
    class: "environment",
    parks: "no",
    resumable: false,
    mayVerify: true,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: false, // rule 31: never the Worker's fault (DEC-42)
    // RG-N1: the Worker gets the hunks first; the reason is stored only when it parks.
    goesTo:
      "Parked: the conflict lies outside the card's scope, or the Worker's budget ended with it unresolved (one decision request names both cards)",
    nextAction: "See the conflicting hunks.",
  },
  integration_failed: {
    class: "environment",
    parks: "no",
    resumable: false,
    mayVerify: false,
    checkpoints: false,
    endsSampling: false,
    halts: false,
    measuresModel: false, // rule 31: never the Worker's fault (DEC-42)
    goesTo: "Planning",
    nextAction: "See the checks that passed on the issue branch and failed after the rebase.",
  },
};

/** The row for a stop reason. */
export function stopReasonRow(reason: CardStopReason): StopReasonRow {
  return STOP_REASONS[reason];
}

/** Which budget ran out, stored with `budget_exhausted` (worker-loop rule 31a). */
export type BudgetDetail =
  | { budget: "steps"; used: number; of: number }
  | { budget: "context"; zone: string; tokens: number; cap: number };

/**
 * The one default step budget, per sample (worker-loop rule 5, WL-T3-11): the
 * card record, the CLI, the queue, the planner and the benchmark all read it.
 */
export const DEFAULT_STEP_BUDGET = 40;

/** Seconds per step behind the seconds budget (the overnight floor, models rule 9). */
export const SECONDS_PER_STEP = 70;

/** The seconds budget a step budget implies, per sample: steps × 70 s. */
export function defaultSecondsBudget(stepBudget: number = DEFAULT_STEP_BUDGET): number {
  return stepBudget * SECONDS_PER_STEP;
}
