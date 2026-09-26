import { CARD_ESTIMATES } from "@sekhemet/kernel";

/**
 * The human estimate: points on 1, 2, 3, 5, 8 (planner-pm §2.6.2, PM-N1-1),
 * derived from a card's difficulty and the project's history — never the
 * machine's tokens and seconds, which set its budgets. An 8 is a card the
 * planner proposes to split (PM-N1-2).
 */
export interface PointsEstimate {
  points: number;
  basis: "prior" | "history";
  /** Finished cards of the same difficulty band the history came from. */
  samples: number;
}

/** Finished cards needed in a band before its history replaces the prior. */
export const POINTS_MIN_HISTORY = 3;

/** The estimate the planner proposes to split in the same plan. */
export const SPLIT_POINTS = 8;

/** The prior: difficulty 1–10 onto the Fibonacci points. */
function priorPoints(difficulty: number): number {
  if (difficulty <= 2) return 1;
  if (difficulty <= 3.5) return 2;
  if (difficulty <= 5) return 3;
  if (difficulty <= 7) return 5;
  return 8;
}

/** The routing bands: direct below 4, edit sketch to 7, split above. */
function band(difficulty: number): "low" | "mid" | "high" {
  return difficulty < 4 ? "low" : difficulty <= 7 ? "mid" : "high";
}

/** The nearest allowed estimate, rounding a tie up. */
function snap(value: number): number {
  let best = CARD_ESTIMATES[0] as number;
  for (const p of CARD_ESTIMATES) {
    if (Math.abs(p - value) <= Math.abs(best - value)) best = p;
  }
  return best;
}

/**
 * Points for a card of this difficulty: the median estimate of the project's
 * finished cards in the same difficulty band once there are
 * {@link POINTS_MIN_HISTORY} of them, else the prior.
 */
export function estimatePoints(
  difficulty: number,
  history: readonly { difficulty: number; estimate: number }[],
): PointsEstimate {
  const same = history
    .filter((h) => band(h.difficulty) === band(difficulty))
    .map((h) => h.estimate)
    .sort((a, b) => a - b);
  if (same.length >= POINTS_MIN_HISTORY) {
    const mid = same.length / 2;
    const median =
      same.length % 2 === 1
        ? (same[Math.floor(mid)] as number)
        : ((same[mid - 1] as number) + (same[mid] as number)) / 2;
    return { points: snap(median), basis: "history", samples: same.length };
  }
  return { points: priorPoints(difficulty), basis: "prior", samples: same.length };
}
