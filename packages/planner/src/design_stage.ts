import { type DepthProposal, proposeDepthProfile } from "./depth_profile.js";
import { type AnswerCopy, DESIGN_COPY as C, type QuestionCopy } from "./design_copy.js";

/**
 * The design stage (design: "The design stage"; "Most work needs almost none
 * of this"). Before a spec becomes cards, decide how much conversation it
 * deserves — nothing, one sentence, a question at a time, or a written brief —
 * and then proceed. It never blocks: every question carries the default that
 * will be used, and the defaults are recorded as assumptions.
 *
 * Found by running the planner before this existed: a calculator, a sync tool
 * and a billing service were all handled the same way, and the billing
 * service's "fast", "secure" and "scale to many users" became three "happy
 * path" cards. A quality word is a constraint with a default, not a card.
 *
 * NEW-design-stage-1: what is at stake is read from what the request does
 * (charging a customer, people signing in, personal records), not from word
 * stems — "charging status", "author pages", "a password generator" and "a
 * health check" are none of these; the stack is detected, not assumed; a
 * question is asked only when its answers change the cards (DS-P14-8), the
 * one that changes most first; and the brief is written from what was said.
 * Every sentence shown is in `design_copy.ts`.
 */

export type Proportion = "none" | "sentence" | "questions" | "brief";

/** One answer to a design question and the cards it adds (DS-P14-8). */
export interface DesignAnswer {
  answer: string;
  cards: string[];
}

export interface DesignQuestion {
  question: string;
  /** The answer used while the question is open: the first answer's text. */
  default: string;
  answers: DesignAnswer[];
}

export interface QualityConstraint {
  quality: string;
  default: string;
}

/** What makes being wrong expensive (§2.1.2). */
export type RiskKind = "money" | "identity" | "personal";

export type StackLanguage = "typescript" | "python" | "rust" | "go";

export interface DesignStack {
  language: StackLanguage;
  /** True when the request named it; otherwise TypeScript is assumed (§2.2.7). */
  stated: boolean;
  name: string;
}

/** Something a user does, in the request's words, and the role that does it. */
export interface DesignAction {
  role?: string;
  text: string;
}

export interface DesignStageResult {
  proportion: Proportion;
  /** What the harness says before planning. Empty when there is nothing worth saying. */
  say: string[];
  /** The spec to decompose: request phrasing, quality words and stated non-goals removed. */
  buildSpec: string;
  /** Open questions, the one that most changes the cards first; at most two (DS-N1-4). */
  questions: DesignQuestion[];
  constraints: QualityConstraint[];
  assumptions: string[];
  riskiest?: string;
  risk?: RiskKind;
  firstSlice: string;
  stack: DesignStack;
  /** Sentences that must always hold, kept in `buildSpec` too (DS-N1-6). */
  invariants: string[];
  /** What the person said it will not do (DS-N1-8). */
  nonGoals: string[];
  /** The user roles the request names, singular, in order (DS-P14-7). */
  roles: string[];
  /** The roles as the request wrote them, for the brief's prose. */
  who: string[];
  /** What users do, from the request (DS-P14-7). */
  actions: DesignAction[];
  /** The depth profile proposed for a new project or a brief, with its reason (DS-P14-1). */
  depth?: DepthProposal;
}

export interface DesignContext {
  /** True when the repository has no source yet. */
  greenfield: boolean;
}

const REQUEST =
  /^(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:(?:build|make|create|write|give)\s+me\s+|i\s+(?:want|need|would like)\s+)/i;
const MODAL = /^(?:it|this|that|the\s+\w+)?\s*(?:should|must|needs?\s+to|has\s+to)\s+(?:be\s+)?/i;

const QUALITIES: { match: RegExp; default: string }[] = [
  { match: /^(?:fast|quick|performant|low[- ]latency)$/i, default: C.qualities.fast },
  { match: /^(?:secure|safe)$/i, default: C.qualities.secure },
  // Within one clause of one sentence: "scale to many users. A retried charge
  // must never…" is a quality and a hard rule, not one quality (DS-N1-6).
  { match: /^(?:scalable|scales?(?:\s+to\s+[^.;,]+)?)$/i, default: C.qualities.scalable },
  { match: /^(?:reliable|robust)$/i, default: C.qualities.reliable },
  { match: /^(?:easy to use|user[- ]friendly|simple|intuitive)$/i, default: C.qualities.usable },
];

/**
 * What is at stake, read from what the request does (DS-N1-1, -2): money
 * changing hands, people signing in, personal records. A word that only
 * looks like one — charging a battery, an author, generating a password,
 * checking a service's health — is not.
 */
const RISKS: { kind: RiskKind; match: RegExp[]; settled?: RegExp }[] = [
  {
    kind: "money",
    match: [
      /\bbill(?:ing|s|ed)?\b/i,
      /\bcharg(?:e|es|ed|ing)\s+(?:the\s+|a\s+|their\s+|each\s+|every\s+)?(?:customer|user|client|card|member|subscriber|account|buyer|people|person)s?\b/i,
      /\bpayments?\b/i,
      /\bpay(?:s|ing)?\s+(?:for|with|by|online|out)\b/i,
      /\binvoic\w*/i,
      /\brefund\w*/i,
      /\bsubscriptions?\b/i,
      /\bcheckout\b/i,
      /\bmoney\b/i,
      /\bpayouts?\b/i,
    ],
    settled: /\b(?:stripe|paypal|paddle|braintree|square)\b/i,
  },
  {
    kind: "identity",
    match: [
      /\bsign(?:s|ing)?[- ]?(?:up|in)\b/i,
      /\bsignups?\b/i,
      /\blog(?:s|ging)?[- ]?in\b/i,
      /\blogins?\b/i,
      /\bauth(?:entication|enticat\w*|orization|orizat\w*|n|z)?\b/i,
      /\b(?:oauth|sso|single sign-on)\b/i,
      /\b(?:user|their|own|member|customer)\s+accounts?\b/i,
      /\b(?:reset|store|stores|storing|hash\w*|forgot\w*)\s+(?:(?:their|the|user|users'?)\s+)?passwords?\b/i,
      /\bpasswords?\s+(?:reset|recovery)\b/i,
    ],
    settled: /\b(?:oauth|github|google|magic link|passwords?)\b/i,
  },
  {
    kind: "personal",
    match: [
      /\b(?:medical|patients?|clinic(?:al)?|health\s+(?:records?|data|information)|personal data|pii|dates? of birth|social security)\b/i,
    ],
  },
];

/** External contracts: hard to change once code depends on them. */
const EXTERNAL: { copy: QuestionCopy; match: RegExp; settled: RegExp }[] = [
  {
    copy: C.external.sync,
    match: /\bsync\w*/i,
    settled: /\b(?:newer|newest|latest|last)\s+(?:change\s+|edit\s+|write\s+)?wins\b|\bconflict/i,
  },
  {
    copy: C.external.storage,
    match: /\b(?:s3|aws|gcs|azure|cloud|bucket)\b/i,
    settled: /\b(?:credential|iam|access key|profile)\w*/i,
  },
  {
    copy: C.external.database,
    match: /\b(?:database|postgres\w*|mysql|sqlite|mongo\w*)\b/i,
    settled: /\b(?:postgres\w*|mysql|sqlite|mongo\w*|mariadb)\b/i,
  },
  {
    copy: C.external.api,
    match: /\b(?:api|http|server|endpoint|webhook)\b/i,
    settled: /\b(?:grpc|graphql|rest|json|api key)\b/i,
  },
];

const STACKS: { language: StackLanguage; match: RegExp }[] = [
  { language: "python", match: /\b(?:python|django|flask|fastapi|pytest|pandas)\b/i },
  { language: "rust", match: /\b(?:rust|cargo)\b/i },
  { language: "go", match: /\b(?:golang|go\s+(?:cli|service|program|module|server))\b/i },
  {
    language: "typescript",
    match: /\b(?:typescript|node(?:\.js)?|javascript|deno|bun|react|vite)\b/i,
  },
];

const INVARIANT = /\b(?:must never|must not|never|must always|always|exactly once|at most once)\b/i;
const NON_GOAL = /^(?:but\s+)?(?:without|not|no)\s+(.+)$/i;
/**
 * A prohibition — "No customer may ever be charged twice" — is a hard rule,
 * not something left out: a "No"/"Not" clause with a modal or a verb of
 * being states what must hold (DS-N1-6), where a non-goal names a thing
 * ("no mobile app", "not a customer portal"; DS-N1-8).
 */
const PROHIBITION =
  /^(?:but\s+)?(?:no|not)\s+.*\b(?:may|might|can|could|shall|should|must|will|would|ever|is|are|be|gets?)\b/i;

/** User roles a request may name, with the singular a walkthrough uses. */
const ROLES: [RegExp, string][] = [
  [/\bpeople\b|\bpersons?\b/i, "person"],
  [/\busers?\b/i, "user"],
  [/\bcustomers?\b/i, "customer"],
  [/\badmin(?:istrator)?s?\b/i, "admin"],
  [/\bauthors?\b/i, "author"],
  [/\breaders?\b/i, "reader"],
  [/\bvisitors?\b/i, "visitor"],
  [/\bmembers?\b/i, "member"],
  [/\bstudents?\b/i, "student"],
  [/\bteachers?\b/i, "teacher"],
  [/\bpatients?\b/i, "patient"],
  [/\bmanagers?\b/i, "manager"],
  [/\bguests?\b/i, "guest"],
  [/\bbuyers?\b/i, "buyer"],
  [/\bsellers?\b/i, "seller"],
  [/\bplayers?\b/i, "player"],
  [/\bclients?\b/i, "client"],
];

/** Where a product's name ends and what it does begins. */
const RELATIVE = /\s+(?:that|which|where|who|so that|to let|for)\s+/i;
const ROLE_LEAD = /^(\w+)\s+(?:can|could|may|will|to|should)?\s*/i;

/** Does any answer change the cards? At least two answers must give different cards (DS-P14-8). */
export function changesCards(q: Pick<DesignQuestion, "answers">): boolean {
  return new Set(q.answers.map((a) => [...a.cards].sort().join("\u0000"))).size >= 2;
}

/** How many different sets of cards the answers produce: the question's value. */
function outcomes(q: DesignQuestion): number {
  return new Set(q.answers.map((a) => [...a.cards].sort().join("\u0000"))).size;
}

function question(copy: QuestionCopy): DesignQuestion {
  const answers = copy.answers.map((a: AnswerCopy) => ({ answer: a.answer, cards: [...a.cards] }));
  return { question: copy.question, default: answers[0]?.answer ?? "", answers };
}

function qualityOf(part: string): QualityConstraint | undefined {
  const text = part.replace(MODAL, "").trim();
  const q = QUALITIES.find((x) => x.match.test(text));
  return q ? { quality: text, default: q.default } : undefined;
}

function stackOf(spec: string): DesignStack {
  const named = STACKS.find((s) => s.match.test(spec));
  const language = named?.language ?? "typescript";
  return { language, stated: named !== undefined, name: C.stacks[language].name };
}

/** The roles the text names, singular and as written, in order of appearance. */
function rolesOf(text: string): { roles: string[]; who: string[] } {
  const found = ROLES.map(([re, role]) => ({ role, m: re.exec(text) }))
    .filter((x): x is { role: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => a.m.index - b.m.index);
  const roles: string[] = [];
  const who: string[] = [];
  for (const f of found) {
    if (roles.includes(f.role)) continue;
    roles.push(f.role);
    who.push(f.m[0].toLowerCase());
  }
  return { roles, who };
}

function roleNamed(word: string): string | undefined {
  return ROLES.find(([re]) => new RegExp(`^(?:${re.source})$`, "i").test(word))?.[1];
}

/**
 * What users do, from the product's first sentence: "a recipe website where
 * people can sign up and save favourites" is a person signing up and saving
 * favourites. A clause with no role is the product's own work ("charges
 * customers monthly"), not a user's step.
 */
function actionsOf(firstSentence: string): DesignAction[] {
  const rel = RELATIVE.exec(firstSentence);
  if (!rel) return [];
  const rest = firstSentence.slice(rel.index + rel[0].length);
  const out: DesignAction[] = [];
  let role: string | undefined;
  for (const raw of rest.split(/,\s*|\s+and\s+/i)) {
    let seg = raw.trim().replace(/^and\s+/i, "");
    if (!seg) continue;
    const lead = ROLE_LEAD.exec(seg);
    const named = lead ? roleNamed(lead[1] as string) : undefined;
    if (named) {
      role = named;
      seg = seg.slice((lead as RegExpExecArray)[0].length).trim();
    }
    if (role && seg) out.push({ role, text: seg });
  }
  return out;
}

/** The product's kind: the words before what it does ("a recipe website"). */
export function productHead(buildSpec: string): string {
  const first = buildSpec.split(/(?<=[.!?])\s+/)[0] ?? buildSpec;
  const rel = RELATIVE.exec(first);
  return (rel ? first.slice(0, rel.index) : first).replace(/[.!?]$/, "").trim();
}

function essentialsOf(head: string): string | undefined {
  const words = head.toLowerCase().split(/[^a-z]+/);
  const kinds = C.kinds as Readonly<Record<string, string>>;
  for (const w of words) {
    const key = w.replace(/s$/, "");
    if (kinds[key]) return kinds[key];
  }
  return undefined;
}

export function designStage(spec: string, ctx: DesignContext): DesignStageResult {
  const request = spec.trim().replace(REQUEST, "");
  const sentences: string[] = [];
  const constraints: QualityConstraint[] = [];
  const invariants: string[] = [];
  const nonGoals: string[] = [];
  for (const rawSentence of request.split(/(?<=[.!?])\s+/)) {
    const sentence = rawSentence.trim().replace(/[.!?]+$/, "");
    if (!sentence) continue;
    const functional: string[] = [];
    for (const raw of sentence.split(/[;,]/)) {
      const clause = raw.trim().replace(/^and\s+/i, "");
      if (!clause) continue;
      // A hard rule stays in what is built, whole (DS-N1-6) — checked before
      // a non-goal, so "No customer may…" is never filed as something left out.
      if (INVARIANT.test(clause) || PROHIBITION.test(clause)) {
        invariants.push(`${clause}.`);
        functional.push(clause);
        continue;
      }
      const nonGoal = NON_GOAL.exec(clause);
      if (nonGoal) {
        nonGoals.push((nonGoal[1] as string).trim());
        continue;
      }
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
    if (functional.length) sentences.push(functional.join(", "));
  }
  const buildSpec = sentences.join(". ") || request.replace(/[.!?]+$/, "");
  const firstSlice = sentences[0] ?? buildSpec;

  const risk = RISKS.find((r) => r.match.some((re) => re.test(spec)));
  const riskiest = risk ? C.risks[risk.kind].riskiest : undefined;
  // DS-P14-8, DS-N1-4: a question is asked only when its answers change the
  // cards and the request has not already settled it; the one that changes
  // the most is asked first, and never more than two are open.
  const candidates: DesignQuestion[] = [
    ...(risk && !risk.settled?.test(spec) ? [question(C.risks[risk.kind].question)] : []),
    ...EXTERNAL.filter((e) => e.match.test(spec) && !e.settled.test(spec)).map((e) =>
      question(e.copy),
    ),
  ].filter(changesCards);
  const questions = candidates
    .map((q, i) => ({ q, i }))
    .sort((a, b) => outcomes(b.q) - outcomes(a.q) || a.i - b.i)
    .map((x) => x.q)
    .slice(0, 2);

  const stack = stackOf(spec);
  const assumptions = [
    ...(ctx.greenfield ? [C.stacks[stack.language].assumed] : []),
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

  const { roles, who } = rolesOf(buildSpec);
  const actions = actionsOf(sentences[0] ?? buildSpec);
  const depth =
    ctx.greenfield || proportion === "brief"
      ? proposeDepthProfile(spec, {
          ...(risk ? { risk: risk.kind } : {}),
          proportion,
          constraints: constraints.length,
          questions: questions.length,
        })
      : undefined;

  const essentials = essentialsOf(productHead(buildSpec));
  const building = essentials
    ? C.say.buildingKind(buildSpec, essentials)
    : C.say.building(buildSpec);
  const stackNote = !ctx.greenfield
    ? ""
    : stack.stated
      ? C.say.stackStated(stack.name)
      : C.say.stackAssumed(stack.name);
  const first = questions[0];
  const say: string[] =
    proportion === "none"
      ? []
      : proportion === "sentence"
        ? [`${building}${stackNote}`]
        : proportion === "questions"
          ? [
              `${building}${stackNote}`,
              ...(first ? [C.say.firstQuestion(first.question, first.default)] : []),
              C.say.onDefaults,
            ]
          : [
              C.say.brief(buildSpec),
              C.say.riskiest(riskiest as string),
              ...(first ? [C.say.firstQuestion(first.question, first.default)] : []),
              ...invariants.map((i) => C.say.mustHold(i)),
              ...constraints.map((c) => C.say.constraint(c.quality, c.default)),
              C.say.onDefaults,
            ];

  return {
    proportion,
    say,
    buildSpec,
    questions,
    constraints,
    assumptions,
    ...(riskiest ? { riskiest } : {}),
    ...(risk ? { risk: risk.kind } : {}),
    firstSlice,
    stack,
    invariants,
    nonGoals,
    roles,
    who,
    actions,
    ...(depth ? { depth } : {}),
  };
}

const joinAnd = (items: readonly string[]) =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const capital = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * The project brief (design: "What it produces"), written only when
 * proportion is "brief". Problem, Outcome and Non-goals come from what the
 * person said, and say "Not stated — assumed:" where they said nothing
 * (DS-N1-8); the depth profile proposed is a constraint, and a regulated
 * profile says it claims no compliance (DS-P14-4).
 */
export function renderBrief(d: DesignStageResult, options: { gates: readonly string[] }): string {
  const assumed = (s: string) => `- *Assumed:* ${s}`;
  const notStated = (s: string) => `- *${C.brief.notStated}* ${s}`;
  const whoText = joinAnd(d.who);
  const doing = joinAnd(d.actions.map((a) => a.text));
  const problem = whoText
    ? `- ${C.brief.problem(whoText, doing ? `to ${doing}` : d.buildSpec)} *${C.brief.notStated}* ${C.brief.problemToday}.`
    : notStated(
        `someone who needs ${d.buildSpec}; what they do today instead: ${C.brief.problemToday}.`,
      );
  const outcome =
    whoText && doing
      ? `- ${C.brief.outcome(capital(whoText), doing)}`
      : `- ${C.brief.outcomeWhole(capital(d.buildSpec))}`;
  const nonGoals = d.nonGoals.length
    ? d.nonGoals.map((n) => C.brief.stated(n))
    : [notStated(C.brief.nonGoalsAssumed)];
  const stackLine = d.stack.stated
    ? `- ${d.stack.name} (as stated).`
    : assumed(C.stacks[d.stack.language].assumed);
  return [
    `# Brief: ${d.buildSpec}`,
    "",
    C.brief.intro,
    "",
    "## Problem",
    problem,
    "",
    "## Outcome",
    outcome,
    ...d.invariants.map((i) => `- ${C.say.mustHold(i)}`),
    "",
    "## Non-goals",
    ...nonGoals,
    "",
    "## Constraints",
    stackLine,
    ...(d.depth ? [`- ${C.brief.depth(d.depth.profile, d.depth.reason)}`] : []),
    ...(d.depth?.profile === "regulated" ? [`- ${C.depth.regulatedNote}`] : []),
    ...d.assumptions.filter((a) => a !== C.stacks[d.stack.language].assumed).map(assumed),
    "",
    "## Prior art",
    C.brief.priorArtNone,
    "",
    "## Riskiest assumption",
    `- ${d.riskiest ?? C.brief.riskNone}`,
    "",
    "## The first slice",
    `- ${d.firstSlice}`,
    "",
    "## Definition of done",
    `- ${C.brief.done(options.gates.join(", ") || C.brief.gatesFallback)}`,
    "",
    "## Invariants",
    ...C.brief.invariantsComment,
    "",
  ].join("\n");
}
