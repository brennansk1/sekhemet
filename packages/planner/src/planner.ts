import { createHash } from "node:crypto";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { ClarEvalAmbiguityClassifier } from "./ambiguity.js";
import { AssumptionCalibrationLog } from "./calibration.js";
import {
  AMBIGUITY_THRESHOLD,
  DEFAULT_TIER_BUDGET,
  MAX_OPEN_QUESTIONS_PER_PASS,
} from "./constants.js";
import { settledAnswerFor, settledBasis } from "./decision_store.js";
import { validateInvest } from "./invest.js";
import { decomposeSpidr } from "./spidr.js";
import type {
  AmbiguityClassificationResult,
  AssumptionOverrideRecord,
  ClassifyOptions,
  CodebaseMap,
  DecisionRequest,
  DecomposeSpecParams,
  LoggedAssumption,
  PlannerService,
  SPIDRDecomposition,
  SettledAnswer,
  SettledSource,
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

/**
 * How much a question's answer changes the backlog: the spread of its
 * options' effort, in steps ("+6 steps / ~7k tokens"), plus one for each
 * option with a consequence of its own. The planner asks the questions that
 * score highest first (PM-P2-3).
 */
export function backlogImpact(req: Pick<DecisionRequest, "options">): number {
  const steps = req.options.map((o) => {
    const m = /([+-]?\d+)\s*steps?/i.exec(o.effortDelta);
    return m ? Number(m[1]) : 0;
  });
  const spread = steps.length ? Math.max(...steps) - Math.min(...steps) : 0;
  const consequences = new Set(req.options.map((o) => o.consequence)).size;
  return spread + consequences;
}

/**
 * One planning pass's questions (planner-pm §2.10.1): a question the
 * playbook, the brief or an earlier decision already answers is not asked
 * and its answer is the assumption, with its source (PM-P2-6); of the rest,
 * the {@link MAX_OPEN_QUESTIONS_PER_PASS} whose answers most change the
 * backlog are asked — a `default_deny` one first — and every other
 * `safe_default` one takes its default, recorded as an assumption (PM-P2-3).
 * A `default_deny` question has no default to proceed on: it is always asked,
 * past the cap if need be, and is settled only from the ledger, never from a
 * brief file's text (PM-P2-4, DS-N3-2). The spec is never refused (PM-P2-5).
 */
export function questionPolicy(
  ambiguity: AmbiguityClassificationResult,
  options: { settled?: readonly SettledSource[]; now?: Date; maxOpen?: number } = {},
): AmbiguityClassificationResult {
  const now = (options.now ?? new Date()).toISOString();
  const requests = ambiguity.batch?.requests ?? (ambiguity.decision ? [ambiguity.decision] : []);
  const assumptions: LoggedAssumption[] = [...ambiguity.assumptions];
  const settled: SettledAnswer[] = [...(ambiguity.settled ?? [])];
  const assume = (req: DecisionRequest, statement: string, basis: string) => {
    assumptions.push({
      id: `asm_${createHash("sha256").update(`${req.id}:${basis}`).digest("hex").slice(0, 10)}`,
      cardId: req.cardId,
      category: req.category,
      statement,
      basis,
      excerpt: req.question.slice(0, 120),
      createdAt: now,
    });
  };
  const open: DecisionRequest[] = [];
  for (const req of requests) {
    // A `default_deny` question is settled only by what the ledger holds — a
    // person's recorded decision or an approved playbook rule — never by a
    // brief file's text, which reaches the ledger only as a proposal a person
    // applies (design-stage DS-N3-2).
    const from = (options.settled ?? []).filter(
      (s) => req.policy !== "default_deny" || s.kind !== "brief",
    );
    const s = settledAnswerFor(
      { question: req.question, options: req.options.map((o) => o.label) },
      from,
    );
    if (!s) {
      open.push(req);
      continue;
    }
    settled.push(s);
    assume(req, `${s.answer} (${req.question})`, settledBasis(s));
  }
  const ranked = open
    .map((req, i) => ({ req, i }))
    .sort(
      (a, b) =>
        Number(b.req.policy === "default_deny") - Number(a.req.policy === "default_deny") ||
        backlogImpact(b.req) - backlogImpact(a.req) ||
        a.i - b.i,
    )
    .map((x) => x.req);
  const max = options.maxOpen ?? MAX_OPEN_QUESTIONS_PER_PASS;
  // A `default_deny` question has no default to proceed on, so it is never
  // assumed: each is asked, past the cap if it must be, and holds its cards
  // (PM-P2-4). Only a `safe_default` one beyond the cap takes its default.
  const asked = ranked.filter((req, i) => i < max || req.policy === "default_deny");
  for (const req of ranked.filter((r) => !asked.includes(r))) {
    const at = req.defaultIfNoAnswer.optionIndex ?? req.recommendation.optionIndex;
    const label = req.options[at]?.label ?? "the recommended option";
    assume(
      req,
      `Assumed ${label} for: ${req.question}`,
      `Not asked: at most ${max} questions per planning pass; its default`,
    );
  }
  const { decision: _d, batch: _b, rejectionReason: _r, ...rest } = ambiguity;
  const first = asked[0];
  return {
    ...rest,
    askUser: asked.length > 0,
    ...(first ? { decision: first } : {}),
    ...(first && ambiguity.batch ? { batch: { ...ambiguity.batch, requests: asked } } : {}),
    ...(first && !ambiguity.batch
      ? {
          batch: {
            id: `batch_${first.id}`,
            cardId: first.cardId,
            requests: asked,
            createdAt: now,
          },
        }
      : {}),
    assumptions,
    rejected: false,
    ...(settled.length ? { settled } : {}),
  };
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
   * A spec is never refused for its open points (PM-P2-5): the settled ones
   * take their recorded answers, at most two are asked, the rest take their
   * defaults, and the plan proceeds on them (§2.10.1).
   */
  public async decomposeSpec(params: DecomposeSpecParams): Promise<SpidrPlan> {
    const budget = params.tierBudget ?? this.options.tierBudget ?? DEFAULT_TIER_BUDGET;
    const map = params.codebaseMap ?? this.options.codebaseMap;

    const ambiguity = questionPolicy(
      await this.classifyAmbiguity(params.spec, {
        cardId: params.parentId,
        ...(map ? { codebaseMap: map } : {}),
      }),
      params.settled ? { settled: params.settled } : {},
    );

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
