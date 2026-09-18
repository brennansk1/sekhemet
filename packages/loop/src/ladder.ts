import type { GateFailure } from "@sekhemet/gates";

/**
 * Escalation rungs applied when verification fails.
 *
 * Each rung changes *strategy*, not just temperature. Retrying the same
 * approach against the same context is what produces the repeat-until-budget
 * failure mode; escalation exists so a second failure is met with a different
 * kind of attempt.
 */
export type RepairRung = "direct_repair" | "fresh_context" | "edit_sketch" | "escalate";

export interface RungPolicy {
  rung: RepairRung;
  /** Attempts permitted at this rung before escalating. */
  maxAttempts: number;
  /** Discard accumulated turn history and re-read the scope from disk. */
  resetContext: boolean;
  /** Require a written plan before any edit is applied. */
  requireSketch: boolean;
  /** Guidance injected into the prompt at this rung. */
  directive: string;
  /** Entering this rung asks for a new plan (rung 3). */
  replan?: boolean;
  /** Entering this rung stops the card for parking with a diagnosis (rung 4). */
  park?: boolean;
}

/**
 * Attempt caps are 2 / 1 / 1 (design §634-637).
 *
 * The first rung gets two attempts because a typed compiler error is often
 * genuinely fixable on a second read; the later rungs get one each because if
 * a changed strategy does not work once, repeating it is not informative.
 */
export const REPAIR_LADDER: RungPolicy[] = [
  {
    rung: "direct_repair",
    maxAttempts: 2,
    resetContext: false,
    requireSketch: false,
    directive:
      "Repair the specific failure above. Make the smallest change that addresses the named location. Do not restructure working code.",
  },
  {
    rung: "fresh_context",
    maxAttempts: 1,
    resetContext: true,
    requireSketch: false,
    directive:
      "Previous repair attempts did not resolve this. Your turn history has been cleared. Re-read the relevant files from disk before editing — do not rely on what you believed the file contained.",
  },
  {
    rung: "edit_sketch",
    maxAttempts: 1,
    resetContext: true,
    requireSketch: true,
    replan: true,
    directive:
      "Direct repair has failed repeatedly. First state, in one short note, the root cause and the exact edit you intend to make. Then make only that edit.",
  },
  {
    rung: "escalate",
    maxAttempts: 0,
    resetContext: false,
    requireSketch: false,
    park: true,
    directive:
      "Repair ladder exhausted. Stopping for human review rather than continuing to consume budget.",
  },
];

export interface LadderState {
  rungIndex: number;
  attemptsAtRung: number;
  totalAttempts: number;
}

/**
 * Tracks position in the repair ladder across verification failures.
 *
 * Deliberately has no notion of success beyond `reset()`: a card that passes
 * its gates leaves the ladder entirely, and one that regresses later starts
 * over rather than resuming a partially-spent escalation.
 */
export class RepairLadder {
  private state: LadderState = { rungIndex: 0, attemptsAtRung: 0, totalAttempts: 0 };

  constructor(private ladder: RungPolicy[] = REPAIR_LADDER) {}

  public get current(): RungPolicy {
    return this.ladder[Math.min(this.state.rungIndex, this.ladder.length - 1)] as RungPolicy;
  }

  public get snapshot(): LadderState {
    return { ...this.state };
  }

  public get exhausted(): boolean {
    return this.current.rung === "escalate";
  }

  /**
   * Record a failed verification and advance if this rung is spent.
   *
   * Returns the policy now in force, so the caller can apply its context reset
   * and directive on the next turn.
   */
  public recordFailure(): RungPolicy {
    this.state.attemptsAtRung++;
    this.state.totalAttempts++;

    if (this.state.attemptsAtRung >= this.current.maxAttempts) {
      this.state.rungIndex = Math.min(this.state.rungIndex + 1, this.ladder.length - 1);
      this.state.attemptsAtRung = 0;
    }

    return this.current;
  }

  public reset(): void {
    this.state = { rungIndex: 0, attemptsAtRung: 0, totalAttempts: 0 };
  }

  /** Human-readable position, used in checkpoint messages and the dashboard. */
  public describe(failure?: GateFailure): string {
    const position = `rung ${this.state.rungIndex + 1}/${this.ladder.length} (${this.current.rung})`;
    return failure ? `${position} after ${failure.gate ?? failure.rung} failure` : position;
  }
}
