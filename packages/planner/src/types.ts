import type { CardRecord, CardTier } from "@sekhemet/kernel";

/* -------------------------------------------------------------------------- */
/* SPIDR                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The five SPIDR slice kinds (design §690-700).
 *
 * The order of the union is the order the slices are executed in: a Spike
 * removes uncertainty before an Interface can be fixed, the Interface fixes
 * types before Data can persist them, and Rules harden a path that already
 * works. Dependencies between generated stories follow this order.
 */
export type SpidrSliceKind = "spike" | "interface" | "data" | "path" | "rule";

/** What the planner knows about the repository it is slicing against. */
export interface CodebaseMap {
  /** Repo-relative paths a story may claim. */
  files: string[];
  /** Exported symbols per file, when a symbol index is available. */
  symbols?: Record<string, string[]>;
  /** Measured token size per file; absent files fall back to an assumed size. */
  fileTokens?: Record<string, number>;
  /** Source root used when a slice has to invent a new file. */
  sourceDir?: string;
  /** Test root used when a slice has to invent an acceptance test. */
  testDir?: string;
}

/**
 * The budget a story has to fit inside.
 *
 * `workingContextTokens` is the *model's* window for the tier, not the pack
 * size: INVEST-S caps the pack at a fraction of it so repair turns still have
 * room to grow. A story that only fits when the window is full is a story that
 * fails on its second turn.
 */
export interface TierBudget {
  workingContextTokens: number;
  maxSteps: number;
  maxFiles: number;
}

/** An acceptance test that must exist and must fail before executor handoff. */
export interface AcceptanceTestSpec {
  filePath: string;
  /** One observable behaviour, phrased as an assertion. */
  assertion: string;
  /**
   * A test that already passes proves nothing about the card, so handoff is
   * blocked until this is confirmed `true` (design §2485, check T).
   */
  initiallyFailing: boolean;
}

/** What a story advances; a story that advances nothing is an orphan. */
export interface StoryValueLink {
  kind: "gate" | "criterion";
  ref: string;
}

/** One weighted contributor to a difficulty score, kept so the number is auditable. */
export interface DifficultyFactor {
  name: string;
  contribution: number;
  note: string;
}

export interface DifficultyScore {
  /** 1..10, one decimal. */
  value: number;
  factors: DifficultyFactor[];
}

/**
 * Routing thresholds (design §731-733).
 *
 * `direct` below 4, `edit_sketch` from 4 through 7, `split` above 7. The
 * middle band exists because a mid-difficulty card fails from a missing plan,
 * not from a missing model.
 */
export type RoutingDecision = "direct" | "edit_sketch" | "split";

/**
 * The planner-produced plan an executor applies mechanically (design §524-527).
 *
 * Deliberately not code: symbols, preconditions and invariants are what the
 * executor cannot re-derive cheaply, and boilerplate is what it can.
 */
export interface EditSketch {
  cardId: string;
  targetSymbols: { filePath: string; symbol: string; change: "add" | "modify" | "remove" }[];
  preconditions: string[];
  invariants: string[];
  /** Prose outline of the diff, never a literal patch. */
  diffSketch: string;
  /** Files the change is expected to reach, for blast-radius review. */
  blastRadius: string[];
}

/** A story after slicing, with everything INVEST-S and WSJF need to judge it. */
export interface PlannedStory {
  card: CardRecord;
  slice: SpidrSliceKind;
  /** Why this slice exists, in one line — rendered on the card. */
  rationale: string;
  /** Capability keywords the slice was derived from, kept for re-splitting. */
  keywords: string[];
  acceptanceTests: AcceptanceTestSpec[];
  advances: StoryValueLink[];
  difficulty: DifficultyScore;
  routing: RoutingDecision;
  /** Sibling story ids that must complete first. */
  dependsOn: string[];
  /** Projected context-pack size, checked against the INVEST-S fraction. */
  estimatedPackTokens: number;
  /** Set when this story came out of a split, naming the story it came from. */
  splitFrom?: string;
  /** Depth in the split tree; the recursion stops at `maxSplitDepth`. */
  splitDepth: number;
  editSketch?: EditSketch;
}

/**
 * Raised when a story cannot be made to fit and cannot be split further.
 *
 * Reporting this is the honest outcome; silently handing an oversized card to
 * an executor is what produces a budget-exhausted failure two hours later.
 */
export interface CapabilityCeiling {
  storyId: string;
  reason: string;
  /** The smallest human action that unblocks it (design §812-814). */
  smallestHumanAction: string;
}

/* -------------------------------------------------------------------------- */
/* INVEST-S                                                                   */
/* -------------------------------------------------------------------------- */

export type InvestCheckId =
  | "independent"
  | "negotiable"
  | "valuable"
  | "estimable"
  | "small"
  | "testable";

/** What the planner must do about a failed check — not advice for a human. */
export type InvestAction = "none" | "serialize_dependency" | "reject" | "resplit";

export interface InvestCheckResult {
  check: InvestCheckId;
  passed: boolean;
  offendingStoryIds: string[];
  detail: string;
  action: InvestAction;
}

export interface InvestValidationReport {
  passed: boolean;
  checks: InvestCheckResult[];
  /** Hard gate: these stories must be re-split before any handoff. */
  mustResplit: string[];
  /** Hard gate: these stories must not be created at all. */
  rejected: string[];
}

/* -------------------------------------------------------------------------- */
/* Ambiguity / questions                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ambiguity categories.
 *
 * Categories, not individual keywords, are the unit of calibration and of
 * question batching: two "or"s in one spec are one decision, and the override
 * rate that flips assume to ask is measured per category.
 */
export type AmbiguityCategory =
  | "alternatives"
  | "storage"
  | "api_surface"
  | "authorization"
  | "error_handling"
  | "scope_boundary"
  | "vagueness"
  | "performance"
  | "technical_unknown";

/** The three-way question policy (design §754-760). */
export type QuestionDisposition = "assume" | "ask" | "spike";

export interface AmbiguityFinding {
  category: AmbiguityCategory;
  /** The exact word or phrase in the spec that raised it. */
  trigger: string;
  /** Character offset of the trigger, so the UI can point at it. */
  offset: number;
  /** The sentence the trigger appeared in. */
  excerpt: string;
  /** Contribution to the ambiguity score before repeat decay. */
  weight: number;
  disposition: QuestionDisposition;
}

/** An assumption the planner took instead of asking; always logged on the card. */
export interface LoggedAssumption {
  id: string;
  cardId: string;
  category: AmbiguityCategory;
  /** What was assumed, in one sentence. */
  statement: string;
  /** Why it was safe to assume — the convention or default relied on. */
  basis: string;
  /** The spec text that triggered it. */
  excerpt: string;
  createdAt: string;
}

/** A time-boxed research card for uncertainty that only code can resolve. */
export interface SpikeProposal {
  topic: string;
  question: string;
  /** Hard cap; a spike that overruns is itself a finding. */
  timeboxSteps: number;
  /** Doc notes plus a toy test — the spike's only deliverable (design §690). */
  deliverable: string[];
}

/**
 * All questions from one planning pass, batched.
 *
 * Serial questioning is what makes async HITL unbearable: the human answers,
 * the planner finds the next question, the human answers again. One pass
 * produces one batch.
 */
export interface DecisionBatch {
  id: string;
  cardId: string;
  requests: DecisionRequest[];
  createdAt: string;
}

export interface ClassifyOptions {
  /** Card the assumptions and decisions are logged against. */
  cardId?: string;
  codebaseMap?: CodebaseMap;
  now?: Date;
  /** Overrides how long a decision may sit before its default applies. */
  deadlineMs?: number;
}

export interface AmbiguityClassificationResult {
  /** True when at least one finding is dispositioned `ask`. */
  askUser: boolean;
  /** The first request of {@link batch}, retained for single-question callers. */
  decision?: DecisionRequest;
  batch?: DecisionBatch;
  /** 0..1, compared against `AMBIGUITY_THRESHOLD`. */
  score: number;
  findings: AmbiguityFinding[];
  assumptions: LoggedAssumption[];
  spikes: SpikeProposal[];
  /**
   * True when the spec raised more than `MAX_QUESTIONS_PER_SPEC` questions:
   * the spec is refused as under-specified rather than planned around.
   */
  rejected: boolean;
  rejectionReason?: string;
}

/* -------------------------------------------------------------------------- */
/* Decision requests                                                          */
/* -------------------------------------------------------------------------- */

export interface DecisionOption {
  label: string;
  /** What choosing this forecloses or commits to. */
  consequence: string;
  /** Effort relative to the cheapest option, e.g. "+6 steps / ~7k tokens". */
  effortDelta: string;
  riskNote: string;
  /** Files touched, symbol changes and blast radius (design §229, §788-791). */
  previewSketch?: string;
  /**
   * Deletes data, relaxes a gate, adds an untrusted dependency or changes a
   * schema. Never auto-approved at a deadline (design §793-795).
   */
  destructive?: boolean;
}

export interface DecisionRecommendation {
  optionIndex: number;
  rationale: string;
}

export interface DecisionDefault {
  /** Absent when no option may be applied without an answer. */
  optionIndex?: number;
  /** ISO 8601. */
  deadline: string;
}

/**
 * `safe_default` applies the default at the deadline and proceeds;
 * `default_deny` halts in Parked and notifies. Security-sensitive decisions
 * are always `default_deny`.
 */
export type DecisionPolicy = "safe_default" | "default_deny";

export interface DecisionRequest {
  id: string;
  cardId: string;
  question: string;
  options: DecisionOption[];
  /**
   * Flattened per-option previews, in option order, so a UI can render the
   * five-second comparison strip without walking `options`.
   */
  previewSketches: string[];
  recommendation: DecisionRecommendation;
  policy: DecisionPolicy;
  defaultIfNoAnswer: DecisionDefault;
  /** The ambiguity that produced the question. */
  category: AmbiguityCategory;
  createdAt: string;
}

export interface DecisionResolution {
  requestId: string;
  applied: boolean;
  optionIndex?: number;
  outcome: "default_applied" | "parked" | "awaiting";
  /** Kernel event type to append. */
  eventType: "decision/default_applied" | "decision/parked" | "decision/pending";
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* Trust calibration                                                          */
/* -------------------------------------------------------------------------- */

/** One observation of whether a human kept or replaced a planner assumption. */
export interface AssumptionOverrideRecord {
  assumptionId: string;
  cardId: string;
  category: AmbiguityCategory;
  /** True when the human replaced the assumption with a different answer. */
  overridden: boolean;
  recordedAt: string;
  /** What the human chose instead, when they said. */
  humanAnswer?: string;
}

export interface CategoryCalibration {
  category: AmbiguityCategory;
  observed: number;
  overridden: number;
  /** `overridden / observed`, 0 when nothing observed. */
  overrideRate: number;
  /** Effective disposition after calibration. */
  disposition: "assume" | "ask";
  /** True once the override rate crossed the threshold and forced `ask`. */
  shifted: boolean;
}

export interface TrustCalibrationSnapshot {
  /** The visible, adjustable threshold (design §827-831). */
  threshold: number;
  minimumSamples: number;
  categories: CategoryCalibration[];
}

/* -------------------------------------------------------------------------- */
/* Prioritization                                                             */
/* -------------------------------------------------------------------------- */

export type PrioritizationModel = "wsjf" | "rice";

export interface WsjfInputs {
  userBusinessValue: number;
  timeCriticality: number;
  riskReduction: number;
  estimatedSteps: number;
  difficulty: number;
}

export interface RiceInputs {
  reach: number;
  impact: number;
  confidence: number;
  effort: number;
}

export interface PriorityScore {
  itemId: string;
  model: PrioritizationModel;
  score: number;
  /** The formula as applied, so a ranking can be argued with. */
  formula: string;
}

/**
 * An item awaiting prioritization.
 *
 * The value inputs are required rather than defaulted: "the planner never
 * invents weightings" (design §715-719), so an unweighted item is reported
 * unscored instead of being guessed at.
 */
export interface PrioritizationItem {
  itemId: string;
  wsjf?: Omit<WsjfInputs, "estimatedSteps" | "difficulty"> &
    Partial<Pick<WsjfInputs, "estimatedSteps" | "difficulty">>;
  rice?: RiceInputs;
}

export interface PrioritizationResult {
  model: PrioritizationModel;
  ranked: PriorityScore[];
  /** Items with no configured weighting, left unranked on purpose. */
  unscored: { itemId: string; reason: string }[];
}

/* -------------------------------------------------------------------------- */
/* Decomposition entry points                                                 */
/* -------------------------------------------------------------------------- */

export interface DecomposeSpecParams {
  /** Card the decomposition hangs under. */
  parentId: string;
  /** Tier of the parent; children are placed one tier below it. */
  parentTier?: CardTier;
  spec: string;
  codebaseMap?: CodebaseMap;
  tierBudget?: TierBudget;
  /** Goal criteria the stories must advance, for the INVEST `valuable` check. */
  goalCriteriaIds?: string[];
  /** Gate ids the acceptance tests run under. */
  gateIds?: string[];
  maxSplitDepth?: number;
  /** The design stage's riskiest assumption: planned as a rule, proven right after the contract. */
  riskiest?: string;
}

export interface SpidrPlan {
  stories: PlannedStory[];
  invest: InvestValidationReport;
  ambiguity: AmbiguityClassificationResult;
  /** Stories that could not be made to fit, with the human action that helps. */
  capabilityCeilings: CapabilityCeiling[];
  /** True when the spec was refused as under-specified; `stories` is empty. */
  rejected: boolean;
  rejectionReason?: string;
  /** How the slices were produced, so a plan can be reproduced. */
  source: "heuristic" | "model_assisted";
}

/** Legacy shape kept for existing callers of {@link PlannerService}. */
export interface SPIDRDecomposition {
  stories: CardRecord[];
  spikeNeeded: boolean;
  ambiguityScore: number;
  /** The full plan the flattened `stories` were taken from. */
  plan: SpidrPlan;
}

export interface PlannerService {
  decomposeFeature(epicId: string, description: string): Promise<SPIDRDecomposition>;
  decomposeSpec(params: DecomposeSpecParams): Promise<SpidrPlan>;
  classifyAmbiguity(
    taskDesc: string,
    options?: ClassifyOptions,
  ): Promise<AmbiguityClassificationResult>;
}
