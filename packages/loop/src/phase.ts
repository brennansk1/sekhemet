/**
 * The phase a step belongs to (worker-loop T3, WL-T3-1): `find` (reading
 * before anything is written), `edit` (writing), `verify` (checking or
 * finishing) and `repair` (acting while a failed check stands). Computed by
 * this one pure function from what the step called and what stood before it,
 * so the evidence, the repair-phase arm (WL-T3-7) and the find-budget arm
 * (WL-T3-8) read the same answer.
 */
export type StepPhase = "find" | "edit" | "verify" | "repair";

export const STEP_PHASES: readonly StepPhase[] = ["find", "edit", "verify", "repair"];

/** Tools that write a file. */
export const PHASE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit",
  "replace_lines",
  "replace_symbol_body",
  "insert_after_symbol",
]);

/** Tools that verify: a check, or the completion claim that runs the gates. */
export const PHASE_VERIFY_TOOLS: ReadonlySet<string> = new Set(["check", "finish_card"]);

export interface PhaseInput {
  /** The tools the step called, in order. */
  tools: readonly string[];
  /** Files written before this step. */
  filesWrittenBefore: number;
  /** The last check or gate run failed and still stands at the step's start. */
  failedCheckStanding: boolean;
  /** Verification ran during the step without a verify tool (the automatic re-check). */
  verified?: boolean | undefined;
}

export function phaseOf(input: PhaseInput): StepPhase {
  if (input.verified || input.tools.some((t) => PHASE_VERIFY_TOOLS.has(t))) return "verify";
  if (input.failedCheckStanding) return "repair";
  if (input.filesWrittenBefore === 0 && !input.tools.some((t) => PHASE_WRITE_TOOLS.has(t))) {
    return "find";
  }
  return "edit";
}
