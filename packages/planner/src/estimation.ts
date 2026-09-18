import type { CardRecord } from "@sekhemet/kernel";
import type { PlannedStory } from "./types.js";

/**
 * Estimation in tokens, seconds and steps (P4, design "Estimation"):
 *
 *   EstimatedTokens = BasePackTokens + Difficulty x HistoricalTokensPerDifficulty[Class]
 *
 * and the same for seconds. `HistoricalTokensPerDifficulty` is learned from
 * the actuals the card runner writes back on every card (`tokensUsed`,
 * `secondsUsed`, `stepsUsed`): accepted cards of the same class are the
 * sample. Until a class has `minSamples` of them the prior (from measured
 * decode speed, when given) is used, and every estimate says which basis it
 * came from. No story points.
 */
export interface EstimateBasis {
  kind: "measured" | "prior";
  samples: number;
  cardClass: string;
}

export interface CardEstimate {
  tokens: number;
  seconds: number;
  steps: number;
  /** 80% range from the sample spread (measured) or +-50% (prior). */
  tokensRange: [number, number];
  secondsRange: [number, number];
  basis: EstimateBasis;
}

export interface EstimationPriors {
  /** Tokens per difficulty point with no history. Default 6,000. */
  tokensPerDifficulty: number;
  /** Decode speed, tok/s, to turn tokens into seconds. Default 20. */
  decodeTokensPerSecond: number;
  /** Fraction of tokens that are decoded (the rest is prefill). Default 0.08. */
  decodeShare: number;
  /** Prefill speed, tok/s. Default 200. */
  prefillTokensPerSecond: number;
}

export const DEFAULT_ESTIMATION_PRIORS: EstimationPriors = {
  tokensPerDifficulty: 6_000,
  decodeTokensPerSecond: 20,
  decodeShare: 0.08,
  prefillTokensPerSecond: 200,
};

/** The class a card's actuals are pooled under: tier and slice/label and difficulty band. */
export function estimationClass(input: {
  tier: string;
  labels?: string[] | undefined;
  difficulty?: number | undefined;
}): string {
  const slice =
    input.labels?.find((l) => ["spike", "interface", "data", "path", "rule"].includes(l)) ??
    "any";
  const d = input.difficulty ?? 5;
  const band = d < 4 ? "low" : d <= 7 ? "mid" : "high";
  return `${input.tier}:${slice}:${band}`;
}

interface Sample {
  tokensPerDifficulty: number;
  secondsPerDifficulty: number;
  steps: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export class EstimationModel {
  private samples = new Map<string, Sample[]>();

  constructor(
    private readonly priors: EstimationPriors = DEFAULT_ESTIMATION_PRIORS,
    private readonly minSamples = 3,
  ) {}

  /** Learn from cards with recorded actuals (the write-back the runner does). */
  public static fromCards(
    cards: readonly CardRecord[],
    priors?: EstimationPriors,
    minSamples?: number,
  ): EstimationModel {
    const model = new EstimationModel(priors, minSamples);
    for (const c of cards) model.observe(c);
    return model;
  }

  /** Fold one finished card in. Cards without actuals or not done are ignored. */
  public observe(card: CardRecord): void {
    if (card.status !== "done") return;
    if (!card.tokensUsed || !card.secondsUsed || !card.difficulty) return;
    const cls = estimationClass(card);
    const list = this.samples.get(cls) ?? [];
    list.push({
      tokensPerDifficulty: card.tokensUsed / card.difficulty,
      secondsPerDifficulty: card.secondsUsed / card.difficulty,
      steps: card.stepsUsed,
    });
    this.samples.set(cls, list);
  }

  public estimate(input: {
    tier: string;
    labels?: string[] | undefined;
    difficulty: number;
    basePackTokens: number;
    stepBudget: number;
  }): CardEstimate {
    const cls = estimationClass(input);
    const list = this.samples.get(cls) ?? [];
    const d = Math.max(1, input.difficulty);
    if (list.length >= this.minSamples) {
      const tpd = list.map((s) => s.tokensPerDifficulty).sort((a, b) => a - b);
      const spd = list.map((s) => s.secondsPerDifficulty).sort((a, b) => a - b);
      const steps = list.map((s) => s.steps).sort((a, b) => a - b);
      const tokens = Math.round(input.basePackTokens + d * quantile(tpd, 0.5));
      const seconds = Math.round(d * quantile(spd, 0.5));
      return {
        tokens,
        seconds,
        steps: Math.max(1, Math.round(quantile(steps, 0.5))),
        tokensRange: [
          Math.round(input.basePackTokens + d * quantile(tpd, 0.1)),
          Math.round(input.basePackTokens + d * quantile(tpd, 0.9)),
        ],
        secondsRange: [Math.round(d * quantile(spd, 0.1)), Math.round(d * quantile(spd, 0.9))],
        basis: { kind: "measured", samples: list.length, cardClass: cls },
      };
    }
    const p = this.priors;
    const tokens = Math.round(input.basePackTokens + d * p.tokensPerDifficulty);
    const seconds = Math.round(
      (tokens * p.decodeShare) / p.decodeTokensPerSecond +
        (tokens * (1 - p.decodeShare)) / p.prefillTokensPerSecond,
    );
    return {
      tokens,
      seconds,
      steps: input.stepBudget,
      tokensRange: [Math.round(tokens * 0.5), Math.round(tokens * 1.5)],
      secondsRange: [Math.round(seconds * 0.5), Math.round(seconds * 1.5)],
      basis: { kind: "prior", samples: list.length, cardClass: cls },
    };
  }

  /** Estimate a planned story (its pack tokens are the base). */
  public estimateStory(story: PlannedStory): CardEstimate {
    return this.estimate({
      tier: story.card.tier,
      labels: [story.slice],
      difficulty: story.difficulty.value,
      basePackTokens: story.estimatedPackTokens,
      stepBudget: story.card.stepBudget,
    });
  }
}
