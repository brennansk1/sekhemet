import { createHash } from "node:crypto";
import { DEFAULT_DECISION_DEADLINE_MS } from "./constants.js";
import { scoreDifficulty, stepBudgetForDifficulty } from "./difficulty.js";
import { estimatePackTokens, selectScopeFiles } from "./scope.js";
import { contentWords, excerpt, sentenceCase, tokenize } from "./text.js";
import type {
  AmbiguityCategory,
  AmbiguityFinding,
  CodebaseMap,
  DecisionOption,
  DecisionPolicy,
  DecisionRequest,
  DecisionResolution,
  SpidrSliceKind,
} from "./types.js";

/**
 * Actions the agent is strictly prohibited from auto-approving (design §793-795).
 *
 * Matched on whole words against the option's own text, so "undelete" and
 * "dropdown" do not trip the check while "delete" and "drop" do.
 */
const DESTRUCTIVE_MARKERS = [
  "delete",
  "deletes",
  "drop",
  "drops",
  "truncate",
  "purge",
  "wipe",
  "overwrite",
  "destroy",
  "reset",
  "rewrite",
  "force",
  "bypass",
  "disable",
  "skip",
  "relax",
  "migrate",
  "migration",
  "schema",
  "untrusted",
  "downgrade",
  "uninstall",
];

/** Categories that are security-sensitive regardless of the option text. */
const DEFAULT_DENY_CATEGORIES = new Set<AmbiguityCategory>(["authorization"]);

const EXTERNAL_DEPENDENCY_MARKERS = [
  "cloud",
  "aws",
  "s3",
  "dynamodb",
  "postgres",
  "postgresql",
  "mysql",
  "redis",
  "kafka",
  "http",
  "https",
  "network",
  "remote",
  "saas",
  "api",
];

const CONSISTENCY_MARKERS = ["cache", "caching", "concurrent", "concurrency", "async", "replica"];

/** Deterministic id: re-planning the same spec must not spawn a second request. */
function decisionId(cardId: string, category: string, question: string): string {
  return `dec_${createHash("sha256").update(`${cardId}:${category}:${question}`).digest("hex").slice(0, 10)}`;
}

export function isDestructiveText(text: string): boolean {
  const tokens = new Set(tokenize(text).map((t) => t.text));
  return DESTRUCTIVE_MARKERS.some((marker) => tokens.has(marker));
}

function riskNoteFor(label: string): string {
  const tokens = new Set(tokenize(label).map((t) => t.text));
  if (isDestructiveText(label)) {
    return "Destructive: changes or removes state that cannot be recovered from the diff alone.";
  }
  if (EXTERNAL_DEPENDENCY_MARKERS.some((m) => tokens.has(m))) {
    return "Adds an external dependency, and with it a network failure mode the gates cannot reproduce offline.";
  }
  if (CONSISTENCY_MARKERS.some((m) => tokens.has(m))) {
    return "Adds a consistency failure mode that only shows up under concurrency.";
  }
  return "No new dependency; risk stays inside the files in scope.";
}

function formatTokens(count: number): string {
  return count >= 1_000 ? `${(count / 1_000).toFixed(1)}k tokens` : `${count} tokens`;
}

interface OptionCost {
  steps: number;
  packTokens: number;
  files: string[];
  symbols: string[];
}

function costOf(
  label: string,
  slice: SpidrSliceKind,
  map: CodebaseMap | undefined,
  unknownCount: number,
): OptionCost {
  const keywords = contentWords(label);
  const selection = selectScopeFiles(slice, keywords, map);
  const difficulty = scoreDifficulty({
    slice,
    fileCount: selection.files.length,
    symbolCount: selection.symbols.length,
    unknownCount,
    crossPackage: selection.files.some((f) => f.startsWith("packages/")),
  });
  return {
    steps: stepBudgetForDifficulty(difficulty.value),
    packTokens: estimatePackTokens(selection.files, [], label, map),
    files: selection.files,
    symbols: selection.symbols,
  };
}

/**
 * The five-second preview a human needs before an executor touches a file
 * (design §229, §788-791): files, candidate symbol changes, blast radius.
 *
 * Deliberately not a literal patch. A fabricated diff reads as authoritative
 * and is wrong as often as it is right; a scope statement is checkable.
 */
function previewSketchFor(label: string, cost: OptionCost): string {
  const symbols =
    cost.symbols.length > 0
      ? cost.symbols.slice(0, 4).join(", ")
      : "new exported symbols (none exist yet)";
  return [
    `touches ${cost.files.join(", ")}`,
    `candidate symbols: ${symbols}`,
    `blast radius: ${cost.files.length} file(s), ~${formatTokens(cost.packTokens)} of context`,
  ].join(" · ");
}

export interface BuildDecisionParams {
  cardId: string;
  category: AmbiguityCategory;
  question: string;
  /** Candidate answers, extracted from the spec — never invented wholesale. */
  optionLabels: string[];
  /** The spec sentence the question came from. */
  sourceExcerpt: string;
  codebaseMap?: CodebaseMap;
  /** Slice the decision affects, used to cost each option. */
  slice?: SpidrSliceKind;
  unknownCount?: number;
  deadlineMs?: number;
  now?: Date;
}

/**
 * Build a decision request whose every field is derived from the input.
 *
 * Effort, risk and preview come from costing each option against the codebase
 * map, so two different specs cannot produce the same request — which is
 * exactly what the previous hardcoded implementation did.
 */
export function buildDecisionRequest(params: BuildDecisionParams): DecisionRequest {
  const now = params.now ?? new Date();
  const slice = params.slice ?? "path";
  const unknownCount = params.unknownCount ?? 0;

  const labels = params.optionLabels.map((l) => sentenceCase(l.trim())).filter((l) => l.length > 0);
  const costs = labels.map((label) => costOf(label, slice, params.codebaseMap, unknownCount));
  const cheapest = costs.reduce((min, c) => Math.min(min, c.steps), Number.POSITIVE_INFINITY);

  const options: DecisionOption[] = labels.map((label, index) => {
    const cost = costs[index] ?? { steps: 0, packTokens: 0, files: [], symbols: [] };
    const destructive = isDestructiveText(label) || isDestructiveText(params.sourceExcerpt);
    const others = labels.filter((_, i) => i !== index);
    const delta = cost.steps - cheapest;
    return {
      label,
      consequence:
        others.length > 0
          ? `Commits the card to ${label.toLowerCase()}; ${others.length} other reading(s) named in the spec are dropped from scope.`
          : `Commits the card to ${label.toLowerCase()}.`,
      effortDelta:
        delta === 0
          ? `baseline (${cost.steps} steps, ~${formatTokens(cost.packTokens)})`
          : `+${delta} steps / ~${formatTokens(cost.packTokens)}`,
      riskNote: riskNoteFor(label),
      previewSketch: previewSketchFor(label, cost),
      ...(destructive ? { destructive: true } : {}),
    };
  });

  const recommendedIndex = pickRecommendation(options, costs);
  const recommended = options[recommendedIndex];
  const anyDestructive = options.some((o) => o.destructive === true);
  const policy: DecisionPolicy =
    anyDestructive || DEFAULT_DENY_CATEGORIES.has(params.category)
      ? "default_deny"
      : "safe_default";

  const deadline = new Date(
    now.getTime() + (params.deadlineMs ?? DEFAULT_DECISION_DEADLINE_MS),
  ).toISOString();

  /**
   * A `default_deny` request carries no default option at all. Leaving one in
   * place "for reference" is how a destructive default gets applied by a later
   * caller that only reads `defaultIfNoAnswer`.
   */
  const applicable = policy === "safe_default" && recommended?.destructive !== true;

  return {
    id: decisionId(params.cardId, params.category, params.question),
    cardId: params.cardId,
    question: params.question,
    options,
    previewSketches: options.map((o) => o.previewSketch ?? ""),
    recommendation: {
      optionIndex: recommendedIndex,
      rationale: recommendationRationale(options, costs, recommendedIndex, params.codebaseMap),
    },
    policy,
    defaultIfNoAnswer: {
      ...(applicable ? { optionIndex: recommendedIndex } : {}),
      deadline,
    },
    category: params.category,
    createdAt: now.toISOString(),
  };
}

/** Cheapest non-destructive option; only falls back to index 0 if all are destructive. */
function pickRecommendation(options: DecisionOption[], costs: OptionCost[]): number {
  let best = -1;
  let bestSteps = Number.POSITIVE_INFINITY;
  for (let i = 0; i < options.length; i += 1) {
    if (options[i]?.destructive === true) {
      continue;
    }
    const steps = costs[i]?.steps ?? Number.POSITIVE_INFINITY;
    if (steps < bestSteps) {
      bestSteps = steps;
      best = i;
    }
  }
  return best >= 0 ? best : 0;
}

function recommendationRationale(
  options: DecisionOption[],
  costs: OptionCost[],
  index: number,
  map: CodebaseMap | undefined,
): string {
  const option = options[index];
  const cost = costs[index];
  if (option === undefined || cost === undefined) {
    return "No option could be costed; answer required.";
  }
  const knownFiles = cost.files.filter((f) => (map?.files ?? []).includes(f));
  const groundedIn =
    knownFiles.length > 0
      ? `it lands in ${knownFiles.join(", ")}, which already exist`
      : "it introduces the fewest new files";
  return `${option.label}: ${groundedIn}, costs ${cost.steps} steps, and ${option.riskNote.charAt(0).toLowerCase()}${option.riskNote.slice(1, -1)}.`;
}

/**
 * Apply a decision's default once its deadline has passed.
 *
 * The one invariant this function exists to hold: a destructive option is
 * never applied without an answer, no matter how long the deadline has been
 * past. `default_deny` parks the card and notifies instead.
 */
export function resolveDecisionAtDeadline(
  request: DecisionRequest,
  now: Date = new Date(),
): DecisionResolution {
  if (now.getTime() < Date.parse(request.defaultIfNoAnswer.deadline)) {
    return {
      requestId: request.id,
      applied: false,
      outcome: "awaiting",
      eventType: "decision/pending",
      reason: `Deadline ${request.defaultIfNoAnswer.deadline} has not passed.`,
    };
  }

  const index = request.defaultIfNoAnswer.optionIndex;
  const option = index === undefined ? undefined : request.options[index];

  if (request.policy === "default_deny" || index === undefined || option === undefined) {
    return {
      requestId: request.id,
      applied: false,
      outcome: "parked",
      eventType: "decision/parked",
      reason:
        request.policy === "default_deny"
          ? "Policy is default_deny: the card halts in Parked rather than auto-approving."
          : "No option is applicable without an answer.",
    };
  }

  if (option.destructive === true) {
    return {
      requestId: request.id,
      applied: false,
      outcome: "parked",
      eventType: "decision/parked",
      reason: `Option "${option.label}" is destructive and is never auto-approved at a deadline.`,
    };
  }

  return {
    requestId: request.id,
    applied: true,
    optionIndex: index,
    outcome: "default_applied",
    eventType: "decision/default_applied",
    reason: `No answer by ${request.defaultIfNoAnswer.deadline}; applied the safe default "${option.label}".`,
  };
}

/**
 * Question text for a finding, with the spec quoted back.
 *
 * The lead-in names the category so a human can triage a batch at a glance;
 * everything after it is the human's own words.
 */
export function questionFor(finding: AmbiguityFinding, subject: string, options: string[]): string {
  const quoted = excerpt(finding.excerpt, 90);
  const list = options.map((o) => `"${o}"`).join(" or ");
  switch (finding.category) {
    case "alternatives":
      return `Multiple architectural paths are named in "${quoted}": ${list}. Which should this card implement?`;
    case "storage":
      return `Multiple architectural paths remain for persisting ${subject} in "${quoted}": ${list}. Which should this card use?`;
    case "api_surface":
      return `The public surface for ${subject} is unspecified in "${quoted}". Which shape should this card expose: ${list}?`;
    case "authorization":
      return `Access rules for ${subject} are unspecified in "${quoted}". Which should this card enforce: ${list}?`;
    case "performance":
      return `"${quoted}" states a performance goal with no number. Which target should this card be held to: ${list}?`;
    case "error_handling":
      return `Failure behaviour for ${subject} is unspecified in "${quoted}". Which should this card implement: ${list}?`;
    case "scope_boundary":
      return `The scope of ${subject} is open-ended in "${quoted}". Which boundary should this card take: ${list}?`;
    case "vagueness":
      return `"${finding.trigger}" in "${quoted}" has more than one reading. Which did you mean: ${list}?`;
    case "technical_unknown":
      return `"${quoted}" cannot be answered without running code. Should this card be preceded by a spike: ${list}?`;
  }
}
