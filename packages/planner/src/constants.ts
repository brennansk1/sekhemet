import { DEFAULT_STEP_BUDGET } from "@sekhemet/kernel";
import type { TierBudget } from "./types.js";

/**
 * θ_ambig. At or above this the planner stops assuming and puts the question
 * to a human (design §754-760).
 */
export const AMBIGUITY_THRESHOLD = 0.5;

/**
 * More than three questions means the spec, not the planner, is the problem.
 *
 * Planning around four unknowns produces a plan that is four guesses deep, so
 * the spec is refused as under-specified instead (design §754-760).
 */
export const MAX_QUESTIONS_PER_SPEC = 3;

/**
 * INVEST-S sizing: the step budget may be at most this, and the card's Zone 3
 * content must fit Zone 3's cap (`small.ts`). Both must hold.
 */
export const INVEST_MAX_STEPS = DEFAULT_STEP_BUDGET;

/** Above this, a card is re-split. A hard gate, not a warning (design §2485). */
export const DIFFICULTY_SPLIT_THRESHOLD = 7;

/** Below this, a card goes straight to the executor with a plan (design §731). */
export const DIFFICULTY_DIRECT_THRESHOLD = 4;

/** Bounds cards share with the `bounds` gate: three files, no more. */
export const MAX_SCOPE_FILES = 3;

/**
 * Override rate at which a category stops being assumed and starts being
 * asked (design §827-831). Visible and adjustable, as the design requires.
 */
export const OVERRIDE_RATE_SHIFT_THRESHOLD = 0.15;

/** Recursion guard: a spec that needs more than this is a spec, not a card. */
export const DEFAULT_MAX_SPLIT_DEPTH = 4;

/** Assumed token cost of a file with no measurement in the codebase map. */
export const ASSUMED_FILE_TOKENS = 1_200;

/** Pack overhead: system prompt, repo map and card header. */
export const PACK_OVERHEAD_TOKENS = 700;

/** Acceptance tests are read into the pack too, at roughly a third of a file. */
export const ASSUMED_TEST_TOKENS = 400;

/** How long a decision may sit before its default (or Parked) applies. */
export const DEFAULT_DECISION_DEADLINE_MS = 12 * 60 * 60 * 1_000;

/** The reference Worker's window (16,384): W = 9,984, Zone 3's cap 3,792 (DEC-27). */
export const REFERENCE_WORKER_WINDOW = 16_384;

/**
 * Default budget for a story-tier card: the reference Worker's window
 * (16,384) until the caller passes the resolved Worker's from the registry
 * (models rule 11). INVEST's *Small* is Zone 3's cap at that Worker's prompt
 * budget (`small.ts`, DEC-27); there is no pack fraction.
 */
export const DEFAULT_TIER_BUDGET: TierBudget = {
  workerWindowTokens: REFERENCE_WORKER_WINDOW,
  maxSteps: INVEST_MAX_STEPS,
  maxFiles: MAX_SCOPE_FILES,
};
