/**
 * Planner-set dynamic step budgets (L21, design "Competence model": "after
 * enough rows the planner sets budgets and routes from this repo's measured
 * pass rates instead of priors", and self-improvement's bounded change:
 * "maximum ±15% budget adjustment" per calibration).
 */
export interface BudgetEvidence {
  /** Measured attempts at this card class (and model). */
  attempts: number;
  passed: number;
  /** Steps a passing attempt used, 80th percentile. */
  stepsP80?: number | undefined;
}

export interface BudgetDecision {
  budget: number;
  changed: boolean;
  reason: string;
}

export interface BudgetPolicy {
  /** Passing attempts needed before history overrides the prior. Default 3. */
  minPassed: number;
  /** Largest relative change per calibration. Default 0.15. */
  maxChange: number;
  /** Headroom over the p80 of passing attempts. Default 1.25. */
  headroom: number;
  /** Never below this. Default 4. */
  floor: number;
}

export const DEFAULT_BUDGET_POLICY: BudgetPolicy = {
  minPassed: 3,
  maxChange: 0.15,
  headroom: 1.25,
  floor: 4,
};

/** The next step budget for a card class, moved toward what passing attempts used. */
export function calibratedStepBudget(
  current: number,
  evidence: BudgetEvidence,
  policy: Partial<BudgetPolicy> = {},
): BudgetDecision {
  const p = { ...DEFAULT_BUDGET_POLICY, ...policy };
  if (evidence.passed < p.minPassed || evidence.stepsP80 === undefined) {
    return {
      budget: current,
      changed: false,
      reason: `${evidence.passed} passing attempt(s) measured; ${p.minPassed} needed before history sets the budget`,
    };
  }
  const target = Math.ceil(evidence.stepsP80 * p.headroom);
  const lo = Math.floor(current * (1 - p.maxChange));
  const hi = Math.ceil(current * (1 + p.maxChange));
  const budget = Math.max(p.floor, Math.min(hi, Math.max(lo, target)));
  return {
    budget,
    changed: budget !== current,
    reason: `passing attempts used ${evidence.stepsP80} steps (p80 of ${evidence.passed}); target ${target}, moved at most ${Math.round(p.maxChange * 100)}% from ${current}`,
  };
}
