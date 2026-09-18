import type {
  PlannedStory,
  PrioritizationItem,
  PrioritizationModel,
  PrioritizationResult,
  PriorityScore,
  RiceInputs,
  WsjfInputs,
} from "./types.js";

/**
 * WSJF = (Value + TimeCriticality + RiskReduction) / (Steps × Difficulty).
 *
 * The denominator is steps × difficulty rather than story points because both
 * factors are measured here: steps are the card's own budget and difficulty is
 * scored from its shape. A ranking built on points is a ranking built on a
 * number nobody can check.
 */
export function scoreWsjf(inputs: WsjfInputs): number {
  const cost = inputs.estimatedSteps * inputs.difficulty;
  if (!Number.isFinite(cost) || cost <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (inputs.userBusinessValue + inputs.timeCriticality + inputs.riskReduction) / cost;
}

/** RICE = (Reach × Impact × Confidence) / Effort, for idea-stage repos. */
export function scoreRice(inputs: RiceInputs): number {
  if (!Number.isFinite(inputs.effort) || inputs.effort <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (inputs.reach * inputs.impact * inputs.confidence) / inputs.effort;
}

export interface PrioritizeOptions {
  model?: PrioritizationModel;
  /** Stories supply the measured half of WSJF: steps and difficulty. */
  stories?: readonly PlannedStory[];
}

/**
 * Rank items, and say plainly which ones could not be ranked.
 *
 * The planner never invents weightings (design §715-719): an item with no
 * configured value inputs comes back in `unscored` rather than at the bottom
 * of the list, because a guessed zero is indistinguishable from a real one
 * once it is in a sorted array.
 */
export function prioritize(
  items: readonly PrioritizationItem[],
  options: PrioritizeOptions = {},
): PrioritizationResult {
  const model = options.model ?? "wsjf";
  const measured = new Map<string, { steps: number; difficulty: number }>();
  for (const story of options.stories ?? []) {
    measured.set(story.card.id, {
      steps: story.card.stepBudget,
      difficulty: story.difficulty.value,
    });
  }

  const ranked: PriorityScore[] = [];
  const unscored: { itemId: string; reason: string }[] = [];

  for (const item of items) {
    if (model === "rice") {
      if (item.rice === undefined) {
        unscored.push({
          itemId: item.itemId,
          reason: "No RICE inputs configured; the planner does not invent weightings.",
        });
        continue;
      }
      ranked.push({
        itemId: item.itemId,
        model,
        score: scoreRice(item.rice),
        formula: `(${item.rice.reach} × ${item.rice.impact} × ${item.rice.confidence}) / ${item.rice.effort}`,
      });
      continue;
    }

    const weights = item.wsjf;
    if (weights === undefined) {
      unscored.push({
        itemId: item.itemId,
        reason: "No WSJF value inputs configured; the planner does not invent weightings.",
      });
      continue;
    }

    const fallback = measured.get(item.itemId);
    const steps = weights.estimatedSteps ?? fallback?.steps;
    const difficulty = weights.difficulty ?? fallback?.difficulty;
    if (steps === undefined || difficulty === undefined) {
      unscored.push({
        itemId: item.itemId,
        reason: "No measured steps or difficulty for this item; estimate it before ranking it.",
      });
      continue;
    }

    const inputs: WsjfInputs = {
      userBusinessValue: weights.userBusinessValue,
      timeCriticality: weights.timeCriticality,
      riskReduction: weights.riskReduction,
      estimatedSteps: steps,
      difficulty,
    };
    ranked.push({
      itemId: item.itemId,
      model,
      score: scoreWsjf(inputs),
      formula: `(${inputs.userBusinessValue} + ${inputs.timeCriticality} + ${inputs.riskReduction}) / (${steps} × ${difficulty})`,
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
  return { model, ranked, unscored };
}
