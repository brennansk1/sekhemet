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

/**
 * The plan's first line when no planning model answered (§2.1.2, PM-P1-3):
 * the cards use only the spec's own words, and a criterion without an
 * example keeps its card in Planning until a person or a model gives one.
 */
export const PLANNED_WITHOUT_MODEL =
  "Planned without a model: every card uses only the spec's own words, and a criterion with no example keeps its card in Planning.";

/**
 * The Planner role's model (§2.1.2, PM-P1-2): the one named on the command
 * line, else an explicit `[models] planner`, else the model Seshat runs on —
 * never none just because nothing was configured. Seshat's model is taken
 * by default only when the model registry lists it (models rule 11): an
 * unregistered one cannot be loaded under the harness's rules, so the plan
 * is made without a model and says so (PM-P1-3). A model a person named is
 * theirs to name; `none`, named or configured, plans without a model.
 */
export function resolvePlannerModel(input: {
  flag?: string | undefined;
  configured?: string | undefined;
  seshatModel: string;
  /** Whether the model registry lists a model; omitted, every model counts. */
  isRegistered?: (model: string) => boolean;
}): string | undefined {
  // "none" plans heuristically on purpose, loading nothing (PM-P1-3).
  if (input.flag === "none") return undefined;
  if (input.flag) return input.flag;
  if (input.configured === "none") return undefined;
  if (input.configured && input.configured !== "auto") return input.configured;
  if (input.isRegistered && !input.isRegistered(input.seshatModel)) return undefined;
  return input.seshatModel;
}

export interface PlannerOptions {
  /**
   * The Planner role's model (model first, §2.1.2): it writes the slices,
   * their criteria and examples. Without one — or when it cannot answer, or
   * answers badly twice — the heuristic plans, in the spec's own words, and
   * the plan says so (PM-P1-3).
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
        spec: params.spec,
        epics: [],
      };
    }

    const { stories, capabilityCeilings, source, epics, modelRefusals } = await decomposeSpidr({
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
      spec: params.spec,
      epics,
      ...(modelRefusals.length > 0 ? { modelRefusals } : {}),
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
