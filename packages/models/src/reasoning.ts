import { REASONING_BUDGET_TOKENS } from "./http_adapter.js";
import type { ReasoningLevel } from "./types.js";

/**
 * What a step is doing, as far as reasoning is concerned (M6).
 *
 * - `planning`: a repair plan, reflection, a card breakdown.
 * - `mechanical`: an ordinary Worker step (write, edit, read, check).
 * - `repair`: a Worker step on a repair rung; `rung` says which.
 */
export interface StepReasoningContext {
  purpose: "planning" | "mechanical" | "repair";
  /** The active repair rung (`direct_repair`, `fresh_context`, `edit_sketch`, `escalate`). */
  rung?: string;
}

export interface ReasoningDecision {
  reasoning: ReasoningLevel;
  /** Thinking allowance to pass as `reasoningBudgetTokens`; 0 when off. */
  reasoningBudgetTokens: number;
}

/** Rungs where the previous direct fix already failed: thinking pays for itself here. */
const THINKING_RUNGS: Record<string, ReasoningLevel> = {
  fresh_context: "low",
  edit_sketch: "medium",
  escalate: "medium",
};

/**
 * The reasoning policy (M6, re-audit rank 12).
 *
 * Off for mechanical steps and for the first repair rung: on this hardware
 * a thinking turn costs 500-2,000 decode tokens at 7-30 tok/s, and a direct
 * fix of a typed gate failure does not need it (CHRONICLE §2 gotcha 2).
 * On once the direct fix has failed (from `fresh_context` up) and for
 * planning, where one good plan saves many Worker turns. Traces are stripped
 * by the adapter, so they never reach the next step's prompt.
 */
export function reasoningForStep(context: StepReasoningContext): ReasoningDecision {
  let reasoning: ReasoningLevel = "off";
  if (context.purpose === "planning") reasoning = "medium";
  else if (context.purpose === "repair" && context.rung !== undefined) {
    reasoning = THINKING_RUNGS[context.rung] ?? "off";
  }
  return {
    reasoning,
    reasoningBudgetTokens: reasoning === "off" ? 0 : REASONING_BUDGET_TOKENS[reasoning],
  };
}
