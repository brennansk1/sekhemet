import { DIFFICULTY_DIRECT_THRESHOLD, DIFFICULTY_SPLIT_THRESHOLD } from "./constants.js";
import type {
  DifficultyFactor,
  DifficultyScore,
  RoutingDecision,
  SpidrSliceKind,
} from "./types.js";

/**
 * Baseline difficulty per slice kind.
 *
 * An Interface slice is cheap because its failure mode is a compiler error; a
 * Data or Rule slice is expensive because its failure mode is a wrong value
 * that still typechecks.
 */
const SLICE_BASE: Record<SpidrSliceKind, number> = {
  spike: 3,
  interface: 2,
  data: 4,
  path: 3,
  rule: 4,
};

export interface DifficultyInputs {
  slice: SpidrSliceKind;
  /** Files the story will edit. */
  fileCount: number;
  /** Known symbols the story must touch, when a symbol index is available. */
  symbolCount?: number;
  /** Failure modes the story must handle (timeouts, retries, boundaries). */
  hazardCount?: number;
  /** Unresolved ambiguity findings attached to this story. */
  unknownCount?: number;
  /** True when the story spans more than one package. */
  crossPackage?: boolean;
  /** 0..1 from the competence DB; absent means no measured history. */
  historicalFailureRate?: number;
}

function factor(name: string, contribution: number, note: string): DifficultyFactor {
  return { name, contribution: Math.round(contribution * 10) / 10, note };
}

/**
 * Score a story 1..10 from its measurable shape, never from a vibe.
 *
 * Every contributor is returned alongside the number: a difficulty that cannot
 * be argued with is a difficulty nobody will trust enough to re-split on.
 */
export function scoreDifficulty(inputs: DifficultyInputs): DifficultyScore {
  const factors: DifficultyFactor[] = [];
  const base = SLICE_BASE[inputs.slice];
  factors.push(factor("slice_base", base, `${inputs.slice} slices start at ${base}`));

  const extraFiles = Math.max(0, inputs.fileCount - 1);
  if (extraFiles > 0) {
    factors.push(
      factor("scope_breadth", extraFiles * 1.2, `${inputs.fileCount} files in scope, not 1`),
    );
  }

  const symbolCount = inputs.symbolCount ?? 0;
  if (symbolCount > 0) {
    factors.push(factor("symbols", symbolCount * 0.3, `${symbolCount} symbols touched`));
  }

  const hazards = inputs.hazardCount ?? 0;
  if (hazards > 0) {
    factors.push(factor("hazards", hazards * 0.8, `${hazards} failure modes to handle`));
  }

  const unknowns = inputs.unknownCount ?? 0;
  if (unknowns > 0) {
    factors.push(factor("unknowns", unknowns * 1.5, `${unknowns} unresolved ambiguities`));
  }

  if (inputs.crossPackage === true) {
    factors.push(factor("cross_package", 1.5, "change crosses a package boundary"));
  }

  const failureRate = inputs.historicalFailureRate;
  if (failureRate !== undefined && failureRate > 0) {
    factors.push(
      factor(
        "measured_history",
        failureRate * 3,
        `${Math.round(failureRate * 100)}% historical gate-failure rate in this scope`,
      ),
    );
  }

  const raw = factors.reduce((sum, f) => sum + f.contribution, 0);
  const value = Math.min(10, Math.max(1, Math.round(raw * 10) / 10));

  return { value, factors };
}

/**
 * Difficulty to route (design §731-733).
 *
 * Below 4 the card is small enough that a plan is overhead; 4 through 7 it
 * fails for want of a plan, so the planner writes an edit sketch first; above
 * 7 no plan saves it and it is split.
 */
export function routeByDifficulty(difficulty: number): RoutingDecision {
  if (difficulty < DIFFICULTY_DIRECT_THRESHOLD) {
    return "direct";
  }
  if (difficulty <= DIFFICULTY_SPLIT_THRESHOLD) {
    return "edit_sketch";
  }
  return "split";
}

/**
 * Steps this story needs, deliberately uncapped.
 *
 * Clamping to the tier's cap here would hide the very thing INVEST-S exists to
 * catch: a story that needs 27 steps in an 18-step tier does not become an
 * 18-step story by being assigned 18 steps, it becomes a story that runs out.
 * The number stays honest and the sizing gate splits it.
 */
export function stepBudgetForDifficulty(difficulty: number): number {
  return Math.max(8, Math.round(8 + difficulty * 3.5));
}
