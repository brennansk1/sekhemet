/**
 * The design stage (design: "The design stage"; "Most work needs almost none
 * of this"). Before a spec becomes cards, decide how much conversation it
 * deserves — nothing, one sentence, a question or two, or a written brief —
 * and then proceed. It never blocks: every question carries the default that
 * will be used, and the defaults are recorded as assumptions.
 *
 * Found by running the planner before this existed: a calculator, a sync tool
 * and a billing service were all handled the same way, and the billing
 * service's "fast", "secure" and "scale to many users" became three "happy
 * path" cards. A quality word is a constraint with a default, not a card.
 */

export type Proportion = "none" | "sentence" | "questions" | "brief";

export interface DesignQuestion {
  question: string;
  default: string;
}

export interface QualityConstraint {
  quality: string;
  default: string;
}

export interface DesignStageResult {
  proportion: Proportion;
  /** What the harness says before planning. Empty when there is nothing worth saying. */
  say: string[];
  /** The spec to decompose: request phrasing and quality words removed. */
  buildSpec: string;
  questions: DesignQuestion[];
  constraints: QualityConstraint[];
  assumptions: string[];
  riskiest?: string;
  firstSlice: string;
}

export interface DesignContext {
  /** True when the repository has no source yet. */
  greenfield: boolean;
}

const REQUEST =
  /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:build|make|create|write|give)\s+me\s+|i\s+(?:want|need|would like)\s+)/i;
const MODAL = /^(?:it|this|that|the\s+\w+)?\s*(?:should|must|needs?\s+to|has\s+to)\s+(?:be\s+)?/i;

const QUALITIES: { match: RegExp; default: string }[] = [
  {
    match: /^(?:fast|quick|performant|low[- ]latency)$/i,
    default:
      "No latency target was given. Assumed: correct first; a benchmark card measures it, and the target is set from what it shows.",
  },
  {
    match: /^(?:secure|safe)$/i,
    default:
      "Assumed: secrets come only from the environment and never enter the repository, and every input is validated where it enters.",
  },
  {
    match: /^(?:scalable|scale(?:s)?(?:\s+to\s+.+)?)$/i,
    default:
      "Assumed: one instance, with state kept in storage rather than in memory, so it can run as several later without a rewrite.",
  },
  {
    match: /^(?:reliable|robust)$/i,
    default: "Assumed: every failure path returns a typed error, and each has a test.",
  },
  {
    match: /^(?:easy to use|user[- ]friendly|simple|intuitive)$/i,
    default: "Assumed: every command explains itself with --help and every error says what to do.",
  },
];

/** Domains where being wrong is expensive enough to write the decisions down. */
const HIGH_RISK: { match: RegExp; riskiest: string }[] = [
  {
    match: /\b(?:bill|charg|payment|pay|invoic|refund|subscription|money|checkout)\w*/i,
    riskiest:
      "A charge is correct and happens once: a retried or duplicated request must never charge a customer twice.",
  },
  {
    match: /\b(?:auth\w*|login|log in|password|credential|sign[- ]?in|permission)\b/i,
    riskiest:
      "Only the right person gets in: a session cannot be forged, replayed, or kept after logout.",
  },
  {
    match: /\b(?:medical|health|patient|personal data|pii)\b/i,
    riskiest:
      "Personal data never leaves where it is stored, including in logs and error messages.",
  },
];

/** External contracts: hard to change once code depends on them. */
const EXTERNAL: { match: RegExp; question: DesignQuestion }[] = [
  {
    match: /\bsync\w*/i,
    question: {
      question: "When the same item changed on both sides, which wins?",
      default: "the newer change wins, and the other is kept as a conflict copy",
    },
  },
  {
    match: /\b(?:s3|aws|gcs|azure|cloud|bucket)\b/i,
    question: {
      question: "How does it authenticate to the storage provider?",
      default:
        "the provider's standard credential chain (environment, then profile); the tool stores no credential",
    },
  },
  {
    match: /\b(?:database|postgres\w*|mysql|sqlite)\b/i,
    question: {
      question: "Which database?",
      default: "SQLite in one file, behind an interface that Postgres can implement later",
    },
  },
  {
    match: /\b(?:api|http|server|endpoint|webhook)\b/i,
    question: {
      question: "Who calls it, and how?",
      default: "HTTP with JSON, unauthenticated until a card asks for authentication",
    },
  },
];

const RUNTIME =
  "TypeScript on Node 20 with Vitest — the stack this harness verifies best. Say otherwise before the first card runs.";

function qualityOf(part: string): QualityConstraint | undefined {
  const text = part.replace(MODAL, "").trim();
  const q = QUALITIES.find((x) => x.match.test(text));
  return q ? { quality: text, default: q.default } : undefined;
}

export function designStage(spec: string, ctx: DesignContext): DesignStageResult {
  const request = spec.trim().replace(REQUEST, "");
  const functional: string[] = [];
  const constraints: QualityConstraint[] = [];
  for (const raw of request.split(/[;,]/)) {
    const clause = raw.trim().replace(/^and\s+/i, "");
    if (!clause) continue;
    // "it should be fast and secure and scale to many users" is three
    // constraints; "charges customers and emails invoices" is work.
    const parts = MODAL.test(clause) ? clause.replace(MODAL, "").split(/\s+and\s+/i) : [clause];
    const kept: string[] = [];
    for (const p of parts) {
      const q = qualityOf(p);
      if (q) constraints.push(q);
      else kept.push(p.trim());
    }
    if (kept.length) functional.push(kept.join(" and "));
  }
  const buildSpec = functional.join(", ") || request;
  const firstSlice = functional[0] ?? buildSpec;

  const risk = HIGH_RISK.find((r) => r.match.test(spec));
  const questions = EXTERNAL.filter((e) => e.match.test(spec))
    .map((e) => e.question)
    .slice(0, 2);
  const assumptions = [
    ...(ctx.greenfield ? [RUNTIME] : []),
    ...constraints.map((c) => `${c.quality}: ${c.default}`),
    ...questions.map((q) => `${q.question} ${q.default}.`),
  ];

  const words = buildSpec.split(/\s+/).length;
  const proportion: Proportion = risk
    ? "brief"
    : questions.length
      ? "questions"
      : ctx.greenfield || constraints.length || words > 12
        ? "sentence"
        : "none";

  const building = `Building ${buildSpec}.`;
  const onDefaults =
    "Proceeding on the defaults, recorded as assumptions — say otherwise before those cards run.";
  const say: string[] =
    proportion === "none"
      ? []
      : proportion === "sentence"
        ? [`${building}${ctx.greenfield ? " Assumed: TypeScript on Node 20." : ""}`]
        : proportion === "questions"
          ? [
              building,
              `${questions.length === 1 ? "One thing" : "Two things"} that are hard to change later:`,
              ...questions.map((q, i) => `  ${i + 1}. ${q.question} Default: ${q.default}.`),
              onDefaults,
            ]
          : [
              `${building} Enough is at stake to write the decisions down: .sekhemet/brief.md.`,
              `Riskiest assumption: ${risk?.riskiest}`,
              ...constraints.map((c) => `  ${c.quality} — ${c.default}`),
              onDefaults,
            ];

  return {
    proportion,
    say,
    buildSpec,
    questions,
    constraints,
    assumptions,
    ...(risk ? { riskiest: risk.riskiest } : {}),
    firstSlice,
  };
}

/** The project brief (design: "What it produces"), written only when proportion is "brief". */
export function renderBrief(d: DesignStageResult, options: { gates: readonly string[] }): string {
  const assumed = (s: string) => `- *Assumed:* ${s}`;
  return [
    `# Brief: ${d.buildSpec}`,
    "",
    "Written by the design stage. Every *Assumed* line is a default the harness chose; edit it and the cards that depend on it should be re-planned.",
    "",
    "## Problem",
    assumed(`someone needs ${d.buildSpec}. Who, and what they do today instead, was not stated.`),
    "",
    "## Outcome",
    assumed(`${d.buildSpec} works end to end, checked by the gates below.`),
    "",
    "## Non-goals",
    assumed("nothing beyond what the spec names. Anything else is a new card, not scope creep."),
    "",
    "## Constraints",
    ...d.assumptions.map(assumed),
    "",
    "## Prior art",
    "- Not researched. The Researcher answers how this is usually built, with sources, when asked; nothing here is recalled from a model's memory.",
    "",
    "## Riskiest assumption",
    `- ${d.riskiest ?? "None identified."}`,
    "",
    "## The first slice",
    `- ${d.firstSlice}`,
    "",
    "## Definition of done",
    `- Every card passes: ${options.gates.join(", ") || "the gates in .sekhemet/gates.toml"}, plus reachability, regression and architecture.`,
    "",
    "## Invariants",
    "<!-- Checked on every card. Two forms are enforced:",
    "- `src/db/` does not import `src/cli.ts`",
    "- `Money` is defined only in `src/types.ts`",
    "-->",
    "",
  ].join("\n");
}
