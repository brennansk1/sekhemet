import { condenseCommandOutput, maskOlderObservations } from "./condenser.js";
import type { EvidenceStore } from "./evidence.js";
import type { TurnHistoryItem } from "./prompts.js";
import { estimateTokens } from "./tokens.js";

/**
 * Graduated context pressure (Design §465).
 *
 * "Masking tightens at 70%, 80%, 85%, and 90% of budget; at 95% the step ends
 * with `budget_exhausted` rather than truncating silently."
 *
 * Each tier is a *named, inspectable* strategy rather than a magic number
 * buried in a formatter: the caller can report which tier it ran at, and the
 * competence model can correlate tiers with pass rates.
 */

export type PressureTier =
  | "nominal"
  | "tier_1_trim_skills"
  | "tier_2_mask_sooner"
  | "tier_3_drop_repo_map"
  | "tier_4_mask_all"
  | "budget_exhausted";

export interface PressureStrategy {
  /** Human-readable name of what this tier does. */
  label: string;
  /** Observations newer than this many turns stay verbatim. */
  keepRecentTurns: number;
  /** Line ceiling handed to the condenser for retained observations. */
  observationMaxLines: number;
  /** Zone 2 skills degrade to their one-line manifest entries. */
  skillBodiesDropped: boolean;
  /** Zone 3 repo map is omitted entirely. */
  repoMapDropped: boolean;
  /** Fraction of the repo map retained when it is not dropped (1 = all). */
  repoMapRetention: number;
  /** Every observation becomes a pointer, including the most recent. */
  maskAllObservations: boolean;
  /** The step must end instead of being silently truncated. */
  stop: boolean;
}

export interface PressureThresholds {
  tier1: number;
  tier2: number;
  tier3: number;
  tier4: number;
  hardStop: number;
}

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  tier1: 0.7,
  tier2: 0.8,
  tier3: 0.85,
  tier4: 0.9,
  hardStop: 0.95,
};

const STRATEGIES: Record<PressureTier, PressureStrategy> = {
  nominal: {
    label: "nominal: full pack",
    keepRecentTurns: 2,
    observationMaxLines: 40,
    skillBodiesDropped: false,
    repoMapDropped: false,
    repoMapRetention: 1,
    maskAllObservations: false,
    stop: false,
  },
  tier_1_trim_skills: {
    label: "tier 1 (>=70%): skill bodies collapse to manifest lines",
    keepRecentTurns: 2,
    observationMaxLines: 24,
    skillBodiesDropped: true,
    repoMapDropped: false,
    repoMapRetention: 1,
    maskAllObservations: false,
    stop: false,
  },
  tier_2_mask_sooner: {
    label: "tier 2 (>=80%): only the last observation stays verbatim, repo map halved",
    keepRecentTurns: 1,
    observationMaxLines: 12,
    skillBodiesDropped: true,
    repoMapDropped: false,
    repoMapRetention: 0.5,
    maskAllObservations: false,
    stop: false,
  },
  tier_3_drop_repo_map: {
    label: "tier 3 (>=85%): repo map dropped, observations clipped hard",
    keepRecentTurns: 1,
    observationMaxLines: 6,
    skillBodiesDropped: true,
    repoMapDropped: true,
    repoMapRetention: 0,
    maskAllObservations: false,
    stop: false,
  },
  tier_4_mask_all: {
    label: "tier 4 (>=90%): every observation becomes a pointer",
    keepRecentTurns: 0,
    observationMaxLines: 3,
    skillBodiesDropped: true,
    repoMapDropped: true,
    repoMapRetention: 0,
    maskAllObservations: true,
    stop: false,
  },
  budget_exhausted: {
    label: "hard stop (>=95%): step ends with budget_exhausted",
    keepRecentTurns: 0,
    observationMaxLines: 3,
    skillBodiesDropped: true,
    repoMapDropped: true,
    repoMapRetention: 0,
    maskAllObservations: true,
    stop: true,
  },
};

export interface PressureAssessment {
  tier: PressureTier;
  /** `usedTokens / budgetTokens`, clamped at 0 from below. */
  ratio: number;
  usedTokens: number;
  budgetTokens: number;
  strategy: PressureStrategy;
  /** True at >=95%: the caller must end the step rather than truncate. */
  stop: boolean;
  /** Set only when `stop` is true, so it can be forwarded as a stop reason. */
  stopReason?: "budget_exhausted";
  thresholds: PressureThresholds;
}

export function pressureStrategyFor(tier: PressureTier): PressureStrategy {
  return STRATEGIES[tier];
}

export function tierForRatio(
  ratio: number,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): PressureTier {
  if (ratio >= thresholds.hardStop) return "budget_exhausted";
  if (ratio >= thresholds.tier4) return "tier_4_mask_all";
  if (ratio >= thresholds.tier3) return "tier_3_drop_repo_map";
  if (ratio >= thresholds.tier2) return "tier_2_mask_sooner";
  if (ratio >= thresholds.tier1) return "tier_1_trim_skills";
  return "nominal";
}

/** Classifies current occupancy into a tier and returns that tier's strategy. */
export function assessContextPressure(
  usedTokens: number,
  budgetTokens: number,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): PressureAssessment {
  const safeBudget = budgetTokens > 0 ? budgetTokens : 1;
  const ratio = Math.max(0, usedTokens) / safeBudget;
  const tier = tierForRatio(ratio, thresholds);
  const strategy = STRATEGIES[tier];

  return {
    tier,
    ratio,
    usedTokens,
    budgetTokens,
    strategy,
    stop: strategy.stop,
    ...(strategy.stop ? { stopReason: "budget_exhausted" as const } : {}),
    thresholds,
  };
}

export interface PressureApplication {
  turns: TurnHistoryItem[];
  repoMap: string;
  /** True when Zone 2 must render skills as manifest lines only. */
  skillBodiesDropped: boolean;
  tier: PressureTier;
  strategy: PressureStrategy;
  tokensBefore: number;
  tokensAfter: number;
  tokensSaved: number;
  stop: boolean;
  stopReason?: "budget_exhausted";
}

export interface ApplyPressureInput {
  turns: TurnHistoryItem[];
  repoMap?: string;
  evidenceStore?: EvidenceStore;
  cardId?: string;
}

function trimRepoMap(repoMap: string, retention: number): string {
  if (retention >= 1) return repoMap;
  if (retention <= 0) return "";
  const lines = repoMap.split("\n");
  const keep = Math.max(1, Math.floor(lines.length * retention));
  if (keep >= lines.length) return repoMap;
  return `${lines.slice(0, keep).join("\n")}\n// ... [repo map trimmed under context pressure] ...`;
}

/**
 * Applies a tier's strategy to the volatile material. Zone 1 and Zone 2 prefix
 * bytes are deliberately untouched except for the skill-body flag, which the
 * prompt builder honours at a card boundary, so cache stability survives
 * pressure escalation within a card.
 */
export function applyContextPressure(
  input: ApplyPressureInput,
  assessment: PressureAssessment,
): PressureApplication {
  const { strategy } = assessment;
  const repoMapIn = input.repoMap ?? "";

  const tokensBefore =
    input.turns.reduce((acc, t) => acc + estimateTokens(t.result), 0) + estimateTokens(repoMapIn);

  const condensed = input.turns.map((t) => ({
    turn: t.turn,
    action: t.action,
    result: condenseCommandOutput(t.result, { maxLines: strategy.observationMaxLines }).condensed,
  }));

  const turns = maskOlderObservations(condensed, strategy.keepRecentTurns, {
    ...(input.evidenceStore ? { evidenceStore: input.evidenceStore } : {}),
    ...(input.cardId ? { cardId: input.cardId } : {}),
    maskAll: strategy.maskAllObservations,
  });

  const repoMap = strategy.repoMapDropped ? "" : trimRepoMap(repoMapIn, strategy.repoMapRetention);

  const tokensAfter =
    turns.reduce((acc, t) => acc + estimateTokens(t.result), 0) + estimateTokens(repoMap);

  return {
    turns,
    repoMap,
    skillBodiesDropped: strategy.skillBodiesDropped,
    tier: assessment.tier,
    strategy,
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    stop: strategy.stop,
    ...(strategy.stop ? { stopReason: "budget_exhausted" as const } : {}),
  };
}
