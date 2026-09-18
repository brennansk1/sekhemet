import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ClarEvalAmbiguityClassifier } from "./ambiguity.js";
import { AssumptionCalibrationLog } from "./calibration.js";
import { AMBIGUITY_THRESHOLD, DEFAULT_TIER_BUDGET } from "./constants.js";
import { validateInvest } from "./invest.js";
import { decomposeSpidr } from "./spidr.js";
import type {
  AmbiguityClassificationResult,
  AssumptionOverrideRecord,
  ClassifyOptions,
  CodebaseMap,
  DecomposeSpecParams,
  PlannerService,
  SPIDRDecomposition,
  SpidrPlan,
  TierBudget,
  TrustCalibrationSnapshot,
} from "./types.js";

export { ClarEvalAmbiguityClassifier, scoreFindings } from "./ambiguity.js";

export interface PlannerOptions {
  /**
   * Optional planner model.
   *
   * Optional on purpose: the heuristic path is the contract, and the model
   * only ever refines slice wording and grouping. A harness with no model
   * loaded still plans.
   */
  adapter?: LocalInferenceAdapter;
  /** Shared across passes so override rates accumulate over a project. */
  calibration?: AssumptionCalibrationLog;
  /** θ_ambig; visible and adjustable per project. */
  ambiguityThreshold?: number;
  codebaseMap?: CodebaseMap;
  tierBudget?: TierBudget;
}

/**
 * SPIDR planner.
 *
 * Everything it emits is a function of the spec it was given: slices come from
 * the capabilities the spec enumerates, budgets from a difficulty score over
 * those slices, and questions from tokenized ambiguity findings. There is no
 * template — two specs cannot produce the same plan unless they say the same
 * thing.
 */
export class SpidrFeaturePlanner implements PlannerService {
  private readonly classifier: ClarEvalAmbiguityClassifier;
  private readonly calibration: AssumptionCalibrationLog;
  private readonly options: PlannerOptions;

  public constructor(options: PlannerOptions = {}) {
    this.calibration = options.calibration ?? new AssumptionCalibrationLog();
    this.classifier = new ClarEvalAmbiguityClassifier(
      this.calibration,
      options.ambiguityThreshold ?? AMBIGUITY_THRESHOLD,
    );
    this.options = options;
  }

  public async classifyAmbiguity(
    taskDesc: string,
    options: ClassifyOptions = {},
  ): Promise<AmbiguityClassificationResult> {
    const map = options.codebaseMap ?? this.options.codebaseMap;
    return this.classifier.classifyAmbiguity(taskDesc, {
      ...options,
      ...(map ? { codebaseMap: map } : {}),
    });
  }

  /**
   * Full decomposition: clarify, slice, then split until every leaf fits.
   *
   * An under-specified spec short-circuits here with no stories at all. A plan
   * built on four unanswered questions looks like progress and is not, so the
   * planner refuses to produce one.
   */
  public async decomposeSpec(params: DecomposeSpecParams): Promise<SpidrPlan> {
    const budget = params.tierBudget ?? this.options.tierBudget ?? DEFAULT_TIER_BUDGET;
    const map = params.codebaseMap ?? this.options.codebaseMap;

    const ambiguity = await this.classifyAmbiguity(params.spec, {
      cardId: params.parentId,
      ...(map ? { codebaseMap: map } : {}),
    });

    if (ambiguity.rejected) {
      return {
        stories: [],
        invest: validateInvest([], { tierBudget: budget, specText: params.spec }),
        ambiguity,
        capabilityCeilings: [],
        rejected: true,
        ...(ambiguity.rejectionReason !== undefined
          ? { rejectionReason: ambiguity.rejectionReason }
          : {}),
        source: "heuristic",
      };
    }

    const { stories, capabilityCeilings, source } = await decomposeSpidr({
      ...params,
      ...(map ? { codebaseMap: map } : {}),
      tierBudget: budget,
      findings: ambiguity.findings,
      spikes: ambiguity.spikes,
      ...(this.options.adapter ? { adapter: this.options.adapter } : {}),
    });

    return {
      stories,
      invest: validateInvest(stories, { tierBudget: budget, specText: params.spec }),
      ambiguity,
      capabilityCeilings,
      rejected: false,
      source,
    };
  }

  /** Back-compatible entry point: an epic id plus prose, stories out. */
  public async decomposeFeature(epicId: string, description: string): Promise<SPIDRDecomposition> {
    const plan = await this.decomposeSpec({
      parentId: epicId,
      parentTier: "epic",
      spec: description,
    });

    return {
      stories: plan.stories.map((story) => story.card),
      spikeNeeded: plan.ambiguity.spikes.length > 0,
      ambiguityScore: plan.ambiguity.score,
      plan,
    };
  }

  /**
   * Record whether a human kept or replaced one of the planner's assumptions.
   *
   * This is the only input the assume-to-ask shift has. Without it the planner
   * keeps assuming in categories it is reliably wrong about, and the human
   * keeps paying for it one correction at a time.
   */
  public recordAssumptionOutcome(record: AssumptionOverrideRecord): void {
    this.calibration.record(record);
  }

  public calibrationSnapshot(): TrustCalibrationSnapshot {
    return this.calibration.snapshot();
  }

  public calibrationLog(): AssumptionCalibrationLog {
    return this.calibration;
  }
}
