import { createHash } from "node:crypto";
import { AssumptionCalibrationLog } from "./calibration.js";
import { AMBIGUITY_THRESHOLD } from "./constants.js";
import { buildDecisionRequest, questionFor } from "./decision_request.js";
import {
  contentWords,
  countPhrase,
  excerpt,
  phraseOffsets,
  stripLeadVerb,
  tokenize,
} from "./text.js";
import type {
  AmbiguityCategory,
  AmbiguityClassificationResult,
  AmbiguityFinding,
  ClassifyOptions,
  CodebaseMap,
  DecisionBatch,
  DecisionRequest,
  LoggedAssumption,
  QuestionDisposition,
  SpikeProposal,
} from "./types.js";

/**
 * One ambiguity detector.
 *
 * `resolvedBy` is what keeps the detectors from crying wolf: a spec that says
 * "persist to SQLite" mentions persistence *and* answers it, so the storage
 * detector must stay quiet. Without it every detector degrades into the
 * keyword counter this module replaced.
 */
interface CategoryRule {
  category: AmbiguityCategory;
  /** Contribution of the first hit; repeats decay by half each time. */
  weight: number;
  /** Disposition before trust calibration is applied. */
  disposition: QuestionDisposition;
  triggers: readonly string[];
  /** Whole-word phrases that mean the spec already answered the question. */
  resolvedBy?: readonly string[];
  /** The trigger only counts alongside one of these in the same sentence. */
  requiresCoMarker?: readonly string[];
  /** A number in the sentence answers it (used for performance targets). */
  resolvedByNumber?: boolean;
}

const UNCERTAINTY_MARKERS = [
  "maybe",
  "perhaps",
  "possibly",
  "somehow",
  "unclear",
  "unspecified",
  "either",
  "or",
  "tbd",
  "flexible",
] as const;

/**
 * Detectors in descending weight order; the order also sets which question
 * leads a batch, so the most consequential decision is the first one a human
 * reads.
 */
const RULES: readonly CategoryRule[] = [
  {
    category: "technical_unknown",
    weight: 0.7,
    disposition: "spike",
    triggers: [
      "investigate",
      "research",
      "unknown",
      "prototype",
      "spike",
      "benchmark",
      "feasibility",
      "explore",
      "experiment",
      "unproven",
      "figure out",
      "find out",
      "not sure",
      "determine whether",
    ],
  },
  {
    category: "alternatives",
    weight: 0.6,
    disposition: "ask",
    triggers: ["or", "either", "versus", "vs", "alternatively", "alternative", "alternatives"],
  },
  {
    category: "storage",
    weight: 0.5,
    disposition: "ask",
    triggers: ["persist", "persistence", "store", "storage", "backend", "backends", "database"],
    resolvedBy: [
      "sqlite",
      "postgres",
      "postgresql",
      "mysql",
      "redis",
      "s3",
      "dynamodb",
      "memory",
      "json",
      "kernel",
    ],
  },
  {
    category: "api_surface",
    weight: 0.5,
    disposition: "ask",
    triggers: ["api", "endpoint", "interface", "expose", "public", "signature", "contract"],
    requiresCoMarker: UNCERTAINTY_MARKERS,
  },
  {
    category: "authorization",
    weight: 0.5,
    disposition: "ask",
    triggers: [
      "permission",
      "permissions",
      "role",
      "roles",
      "admin",
      "tenant",
      "authz",
      "authorize",
      "authorization",
      "authentication",
      "authenticate",
    ],
    resolvedBy: ["rbac", "acl", "deny", "allowlist", "denylist", "policy", "owner"],
  },
  {
    category: "vagueness",
    weight: 0.4,
    disposition: "ask",
    triggers: [
      "maybe",
      "perhaps",
      "possibly",
      "somehow",
      "appropriately",
      "appropriate",
      "reasonable",
      "sensible",
      "properly",
      "robust",
      "nice",
      "as needed",
      "if needed",
      "tbd",
    ],
  },
  {
    category: "scope_boundary",
    weight: 0.3,
    disposition: "assume",
    triggers: ["etc", "and so on", "similar", "among others", "various", "several", "many"],
  },
  {
    category: "performance",
    weight: 0.3,
    disposition: "assume",
    triggers: [
      "fast",
      "quick",
      "quickly",
      "performant",
      "scalable",
      "efficient",
      "efficiently",
      "responsive",
      "low latency",
      "high throughput",
      "realtime",
    ],
    resolvedByNumber: true,
  },
  {
    category: "error_handling",
    weight: 0.25,
    disposition: "assume",
    triggers: ["network", "fetch", "http", "upload", "download", "connect", "socket", "subprocess"],
    resolvedBy: [
      "retry",
      "retries",
      "timeout",
      "timeouts",
      "fallback",
      "error",
      "errors",
      "failure",
      "failures",
      "catch",
    ],
  },
];

/** Known storage engines, used to offer real options instead of invented ones. */
const ENGINE_NAMES = [
  "sqlite",
  "postgres",
  "postgresql",
  "mysql",
  "redis",
  "dynamodb",
  "s3",
  "memory",
] as const;

interface SentenceSpan {
  text: string;
  offset: number;
}

function sentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const char = i === text.length ? "." : text.charAt(i);
    if (
      i === text.length ||
      char === "." ||
      char === "!" ||
      char === "?" ||
      char === ";" ||
      char === "\n"
    ) {
      const raw = text.slice(start, i);
      if (raw.trim().length > 0) {
        spans.push({ text: raw.trim(), offset: start + (raw.length - raw.trimStart().length) });
      }
      start = i + 1;
    }
  }
  return spans;
}

function specCardId(spec: string): string {
  return `spec_${createHash("sha256").update(spec).digest("hex").slice(0, 10)}`;
}

function subjectOf(sentence: string, trigger: string): string {
  const words = contentWords(stripLeadVerb(sentence)).filter((w) => !trigger.includes(w));
  const subject = words.slice(0, 3).join(" ");
  return subject.length > 0 ? subject : "this behaviour";
}

/** Split a clause on its alternation markers; the options are the human's words. */
function splitAlternatives(sentence: string): string[] {
  return sentence
    .split(/\bor\b|\beither\b|\bversus\b|\bvs\b|\balternatively\b|,/i)
    .map((part) => stripLeadVerb(part).trim())
    .filter((part) => contentWords(part).length > 0);
}

function optionLabelsFor(
  finding: AmbiguityFinding,
  sentence: string,
  subject: string,
  spec: string,
  map: CodebaseMap | undefined,
): string[] {
  switch (finding.category) {
    case "alternatives": {
      const parts = splitAlternatives(sentence);
      return parts.length >= 2
        ? parts.slice(0, 4)
        : [`${subject} as written`, `${subject} deferred`];
    }
    case "storage": {
      const haystack = `${spec} ${(map?.files ?? []).join(" ")}`.toLowerCase();
      const named = ENGINE_NAMES.filter((engine) => haystack.includes(engine));
      return named.length >= 2
        ? named.slice(0, 4).map((engine) => `persist ${subject} in ${engine}`)
        : [`persist ${subject} through the existing store module`, `keep ${subject} in memory`];
    }
    case "api_surface":
      return [
        `a minimal ${subject} surface with one exported entry point`,
        `a full ${subject} surface with typed options per field`,
      ];
    case "authorization":
      return [`deny ${subject} by default`, `allow ${subject} by default`];
    case "performance":
      return [
        `no numeric target for ${subject}`,
        `a measured target for ${subject} held by a gate`,
      ];
    case "error_handling":
      return [`propagate a typed error from ${subject}`, `retry ${subject} with a bounded backoff`];
    case "scope_boundary":
      return [`only the items named for ${subject}`, "the named items plus the implied remainder"];
    case "vagueness":
      return [`the narrow reading of ${subject}`, `the broad reading of ${subject}`];
    case "technical_unknown":
      return [`run a time-boxed spike on ${subject} first`, "proceed on documented behaviour"];
  }
}

function assumptionFor(
  finding: AmbiguityFinding,
  subject: string,
  belowThreshold: boolean,
): { statement: string; basis: string } {
  if (belowThreshold && finding.disposition === "ask") {
    return {
      statement: `Took the narrow reading of ${subject}: only what "${excerpt(finding.excerpt, 60)}" states literally is in scope.`,
      basis: `Ambiguity score for this spec is below θ_ambig (${AMBIGUITY_THRESHOLD}); interrupting a human costs more than the narrow reading risks.`,
    };
  }
  switch (finding.category) {
    case "scope_boundary":
      return {
        statement: `Only the items enumerated for ${subject} are in scope; the open-ended remainder is not.`,
        basis: "Convention: scope is what the spec enumerates, never what it gestures at.",
      };
    case "performance":
      return {
        statement: `No numeric performance target for ${subject}; the card is held to the correctness gates only.`,
        basis:
          "No measured baseline exists for this scope, so a target would be invented rather than derived.",
      };
    case "error_handling":
      return {
        statement: `Failures in ${subject} propagate as typed errors with no retry.`,
        basis:
          "Convention: retries are added when a measured failure rate justifies them, not pre-emptively.",
      };
    default:
      return {
        statement: `Took the conventional reading of ${subject}.`,
        basis: "No divergent interpretation affects a public API or user-visible behaviour.",
      };
  }
}

/**
 * Three-way ambiguity classifier: assume, ask, or spike.
 *
 * Named for ClarEval (arXiv:2602.14820), which is the calibration target: the
 * measure that matters is not how many ambiguities are detected but how often
 * a human overrides the ones that were assumed. {@link AssumptionCalibrationLog}
 * feeds that measure back in, so a category the planner is repeatedly wrong
 * about stops being assumed.
 */
export class ClarEvalAmbiguityClassifier {
  private readonly calibration: AssumptionCalibrationLog;
  private readonly threshold: number;

  public constructor(calibration?: AssumptionCalibrationLog, threshold = AMBIGUITY_THRESHOLD) {
    this.calibration = calibration ?? new AssumptionCalibrationLog();
    this.threshold = threshold;
  }

  public calibrationLog(): AssumptionCalibrationLog {
    return this.calibration;
  }

  /** Findings only — exposed so the decomposer can attach unknowns to slices. */
  public findAmbiguities(spec: string): AmbiguityFinding[] {
    const findings: AmbiguityFinding[] = [];
    /**
     * Resolution is judged across the whole spec, co-occurrence within the
     * sentence: "persist it" in one sentence and "in SQLite" in the next is an
     * answered question, but an "api" three paragraphs from a "maybe" is not a
     * co-occurrence.
     */
    const specTokens = tokenize(spec);

    for (const span of sentenceSpans(spec)) {
      const tokens = tokenize(span.text);
      const hasNumber = /\d/.test(span.text);

      for (const rule of RULES) {
        if (rule.resolvedByNumber === true && hasNumber) {
          continue;
        }
        if (rule.resolvedBy?.some((phrase) => countPhrase(specTokens, phrase) > 0) === true) {
          continue;
        }
        if (
          rule.requiresCoMarker !== undefined &&
          !rule.requiresCoMarker.some((phrase) => countPhrase(tokens, phrase) > 0)
        ) {
          continue;
        }

        for (const trigger of rule.triggers) {
          for (const offset of phraseOffsets(tokens, trigger)) {
            findings.push({
              category: rule.category,
              trigger,
              offset: span.offset + offset,
              excerpt: span.text,
              weight: rule.weight,
              disposition: this.dispositionFor(rule),
            });
          }
        }
      }
    }

    return findings;
  }

  private dispositionFor(rule: CategoryRule): QuestionDisposition {
    if (rule.disposition === "assume" && this.calibration.shouldAskInsteadOfAssume(rule.category)) {
      return "ask";
    }
    return rule.disposition;
  }

  /**
   * Score, then decide.
   *
   * The score is a saturating sum rather than a keyword count: a second "or"
   * in the same spec is weaker evidence than the first, and no amount of
   * repetition can push a single category past certainty.
   */
  public async classifyAmbiguity(
    taskDesc: string,
    options: ClassifyOptions = {},
  ): Promise<AmbiguityClassificationResult> {
    const cardId = options.cardId ?? specCardId(taskDesc);
    const now = options.now ?? new Date();
    const findings = this.findAmbiguities(taskDesc);
    const score = scoreFindings(findings);

    const spikes: SpikeProposal[] = [];
    const assumptions: LoggedAssumption[] = [];
    const askCategories = new Map<AmbiguityCategory, AmbiguityFinding>();
    const belowThreshold = score < this.threshold;

    for (const finding of findings) {
      const subject = subjectOf(finding.excerpt, finding.trigger);

      if (finding.disposition === "spike") {
        if (!spikes.some((s) => s.topic === subject)) {
          spikes.push({
            topic: subject,
            question: `What does "${excerpt(finding.excerpt, 80)}" resolve to when run?`,
            timeboxSteps: 12,
            deliverable: [
              `docs/spikes/${subject.replace(/\s+/g, "_")}.md — findings, in prose`,
              "a single toy test that demonstrates the answer",
            ],
          });
        }
        continue;
      }

      /**
       * Below θ_ambig an `ask` degrades to a logged assumption rather than
       * disappearing: the human still sees what was decided on their behalf,
       * which is what makes the override rate measurable.
       */
      if (finding.disposition === "assume" || belowThreshold) {
        const { statement, basis } = assumptionFor(finding, subject, belowThreshold);
        if (!assumptions.some((a) => a.category === finding.category)) {
          assumptions.push({
            id: `asm_${createHash("sha256").update(`${cardId}:${finding.category}:${statement}`).digest("hex").slice(0, 10)}`,
            cardId,
            category: finding.category,
            statement,
            basis,
            excerpt: excerpt(finding.excerpt, 120),
            createdAt: now.toISOString(),
          });
        }
        continue;
      }

      if (!askCategories.has(finding.category)) {
        askCategories.set(finding.category, finding);
      }
    }

    const requests: DecisionRequest[] = [];
    for (const [category, finding] of askCategories) {
      const subject = subjectOf(finding.excerpt, finding.trigger);
      const labels = optionLabelsFor(
        finding,
        finding.excerpt,
        subject,
        taskDesc,
        options.codebaseMap,
      );
      requests.push(
        buildDecisionRequest({
          cardId,
          category,
          question: questionFor(finding, subject, labels),
          optionLabels: labels,
          sourceExcerpt: finding.excerpt,
          unknownCount: findings.length,
          now,
          ...(options.codebaseMap ? { codebaseMap: options.codebaseMap } : {}),
          ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
        }),
      );
    }

    if (requests.length === 0) {
      return { askUser: false, score, findings, assumptions, spikes, rejected: false };
    }

    /** One batch per planning pass: serial questioning is what makes async HITL unbearable. */
    const batch: DecisionBatch = {
      id: `batch_${createHash("sha256")
        .update(`${cardId}:${requests.map((r) => r.id).join(",")}`)
        .digest("hex")
        .slice(0, 10)}`,
      cardId,
      requests,
      createdAt: now.toISOString(),
    };
    const first = requests[0];

    return {
      askUser: true,
      ...(first ? { decision: first } : {}),
      batch,
      score,
      findings,
      assumptions,
      spikes,
      rejected: false,
    };
  }
}

/**
 * Saturating score in [0, 1).
 *
 * `raw / (raw + 1)` crosses 0.5 exactly when the decayed evidence sums to 1.0,
 * which is one strong signal plus a corroborating one — the point at which
 * asking is cheaper than guessing wrong.
 */
export function scoreFindings(findings: readonly AmbiguityFinding[]): number {
  const seen = new Map<AmbiguityCategory, number>();
  let raw = 0;
  for (const finding of findings) {
    const repeats = seen.get(finding.category) ?? 0;
    raw += finding.weight * 0.5 ** repeats;
    seen.set(finding.category, repeats + 1);
  }
  return raw / (raw + 1);
}
