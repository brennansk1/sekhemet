import { contentWords, sentenceCase, tokenize } from "./text.js";

/**
 * Acceptance criteria that say what the code must do (planner-pm §2.3,
 * PM-P1-5, PM-P1-6, PM-P1-19): the criterion lint, stable criterion ids,
 * the correct criterion for a hard invariant, and the example rows a
 * criterion's concrete values give.
 */

/**
 * The words a criterion or title may use that are not the spec's own nouns:
 * Given/When/Then scaffolding, counts, outcomes and the planner's fixed
 * labels. Everything else a heuristic card says must come from the spec
 * (§2.1.2, PM-P1-3); the lint's domain-noun check ignores these.
 */
export const STRUCTURAL_WORDS: ReadonlySet<string> = new Set([
  "given",
  "when",
  "then",
  "it",
  "its",
  "they",
  "them",
  "each",
  "every",
  "no",
  "not",
  "never",
  "always",
  "only",
  "exactly",
  "once",
  "twice",
  "zero",
  "one",
  "two",
  "three",
  "none",
  "retried",
  "retry",
  "retries",
  "duplicated",
  "repeated",
  "returns",
  "return",
  "original",
  "result",
  "records",
  "recorded",
  "leaves",
  "is",
  "was",
  "has",
  "have",
  "spike",
  "resolve",
  "riskiest",
  "assumption",
  "happens",
]);

export type CriterionProblemCode =
  | "no_domain_noun"
  | "no_outcome"
  | "no_value"
  | "repeats_title"
  | "title_only";

export interface CriterionProblem {
  code: CriterionProblemCode;
  detail: string;
}

/** One criterion's lint result (§3 `criterion_lint`). */
export interface CriterionLint {
  criterion: string;
  ok: boolean;
  problems: CriterionProblem[];
}

/** Words that name something a test can observe happen. */
const OUTCOME =
  /\b(?:then|returns?|leaves|records?|recorded|shows?|rejects?|rejected|refuses?|refused|throws?|responds?|equals?|contains?|produces?|lists?|emits?|writes?|stores?|saves?|fails?|becomes?|gives?|yields?|reports?|sends?|displays?|prints?|outputs?|has|have|remains?|counts?)\b/i;

/** A number, a quoted literal, or a count word: a value a test can assert. */
const VALUE =
  /\d|"[^"]+"|'[^']+'|`[^`]+`|\b(?:zero|one|two|three|four|five|once|twice|none|empty|true|false|null)\b/i;

/** What an empty export named after the title already satisfies (§2.3.2 e). */
const TRIVIAL = new Set([
  "exported",
  "export",
  "exports",
  "exists",
  "exist",
  "defined",
  "implemented",
  "available",
  "present",
  "works",
  "observable",
  "surface",
  "module",
  "function",
  "file",
  "code",
  "src",
  "ts",
  "js",
  "through",
]);

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Split a camelCase or snake_case identifier into its words. */
function identifierWords(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** Two words are the same noun when one is the other's stem ("refund", "refunding"). */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

/**
 * The criterion lint (§2.3.2, PM-P1-5): refuses a criterion that (a) names
 * no domain noun from the spec, (b) names no observable outcome, (c) has no
 * concrete value, (d) repeats the card title, or (e) is satisfied by the
 * title alone. Without the spec text, (a) is not checked.
 */
export function lintCriterion(
  criterion: string,
  context: { title: string; specText?: string | undefined },
): CriterionLint {
  const problems: CriterionProblem[] = [];
  const words = contentWords(criterion);
  const titleWords = contentWords(context.title);
  if (context.specText !== undefined) {
    const spec = contentWords(context.specText);
    const domain = words.filter((w) => !STRUCTURAL_WORDS.has(w) && !/^\d/.test(w));
    if (!domain.some((w) => spec.some((s) => sameWord(w, s)))) {
      problems.push({
        code: "no_domain_noun",
        detail: "names nothing the spec names",
      });
    }
  }
  if (!OUTCOME.test(criterion)) {
    problems.push({ code: "no_outcome", detail: "names no outcome a test can observe" });
  }
  if (!VALUE.test(criterion)) {
    problems.push({ code: "no_value", detail: "has no concrete value to assert" });
  }
  const repeats =
    norm(criterion) === norm(context.title) ||
    (words.length > 0 && words.every((w) => titleWords.some((t) => sameWord(w, t))));
  if (repeats) {
    problems.push({ code: "repeats_title", detail: "repeats the card's title" });
  }
  // (e): what is left once the title's words — including an export named
  // after it — and the words an empty export satisfies are taken away.
  const expanded = tokenize(criterion.replace(/([a-z0-9])([A-Z])/g, "$1 $2")).flatMap((t) =>
    identifierWords(t.text),
  );
  const rest = expanded.filter(
    (w) =>
      w.length > 1 &&
      !TRIVIAL.has(w) &&
      !titleWords.some((t) => sameWord(w, t)) &&
      !contentWords(w).every((x) => titleWords.includes(x)),
  );
  const said = rest.filter((w) => contentWords(w).length > 0 && !STRUCTURAL_WORDS.has(w));
  // A value in an outcome ("leaves 1") is something no empty export can satisfy.
  const valued = /\d|"[^"]+"|'[^']+'/.test(criterion) && OUTCOME.test(criterion);
  if (!repeats && said.length === 0 && !valued) {
    problems.push({
      code: "title_only",
      detail: "an empty export named after the title satisfies it",
    });
  }
  return { criterion, ok: problems.length === 0, problems };
}

/** One stable id per criterion of a card: `<card>.c<n>`, tag-safe (PM-P1-17). */
export function criterionIdsFor(cardId: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${cardId}.c${i + 1}`);
}

const RETRY_WORD = /\b(?:retried|retries|retry|duplicated|repeated|resubmitted|replayed)\b/i;
const ONCE_WORD = /\b(?:twice|exactly once|at most once|idempoten\w*|more than once)\b/i;

/**
 * The criterion of a hard invariant about repetition (§2.2.3, PM-P1-6):
 * a retried operation returns the original result and records exactly one
 * of the thing — never "the retry is rejected". Undefined when the clause
 * is not such an invariant.
 */
export function invariantCriterion(clause: string): string | undefined {
  if (!ONCE_WORD.test(clause)) return undefined;
  // The subject: the words after the retry word, up to the modal ("a
  // retried charge must never…" → "charge"); else the clause's first noun.
  const words = clause
    .replace(/[.,;:]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const stop = /^(?:must|should|shall|will|can|may|is|are|never|not|or|and)$/i;
  let subject: string[] = [];
  const at = words.findIndex((w) => RETRY_WORD.test(w));
  if (at >= 0) {
    for (const w of words.slice(at + 1)) {
      if (RETRY_WORD.test(w)) continue;
      if (stop.test(w)) {
        if (subject.length > 0) break;
        continue;
      }
      subject.push(w.toLowerCase());
      if (subject.length === 2) break;
    }
  }
  if (subject.length === 0) subject = contentWords(clause).slice(0, 1);
  const thing = subject[0];
  if (!thing) return undefined;
  const named = subject.join(" ");
  return `Given a ${named}, when it is retried, then the retry returns the original result and exactly one ${thing} is recorded.`;
}

/** One example of a criterion: the values in, and the value out. */
export interface ExampleRow {
  args: unknown[];
  expected: unknown;
}

const REFUSAL = /\b(?:reject\w*|refus\w*|throws?|error|fails?)\b/i;
const EXPECT_AT =
  /\b(?:leaves|returns|gives|yields|equals|is|becomes|makes|produces|totals)\b\s+(?:a\s+|an\s+|the\s+)?(?:\w+\s+){0,2}?(?:of\s+)?(-?\d+(?:\.\d+)?|"[^"]*"|'[^']*'|true|false)/i;
const NUMBER = /-?\d+(?:\.\d+)?/g;

function literal(raw: string): unknown {
  if (/^-?\d/.test(raw)) return Number(raw);
  if (raw === "true" || raw === "false") return raw === "true";
  return raw.slice(1, -1);
}

/**
 * The example rows a behaviour criterion's concrete values give
 * (PM-P1-19): one per example, where examples are separated by `;` — the
 * numbers before the outcome word are the arguments, the value after it is
 * the expected result. A refusal is not an example of a returned value, and
 * a criterion with no values gives none.
 */
export function exampleRows(criterion: string): ExampleRow[] {
  if (REFUSAL.test(criterion)) return [];
  const rows: ExampleRow[] = [];
  for (const part of criterion.split(";")) {
    // The last outcome word with values before it: "the invoice is 1000
    // cents, refunding 400 leaves 600" expects 600, not 1000.
    const m = [...part.matchAll(new RegExp(EXPECT_AT.source, "gi"))]
      .reverse()
      .find((x) => (part.slice(0, x.index).match(NUMBER) ?? []).length > 0);
    if (!m || m.index === undefined) continue;
    const before = part.slice(0, m.index);
    const args = (before.match(NUMBER) ?? []).map(Number);
    if (args.length === 0) continue;
    rows.push({ args, expected: literal(m[1] as string) });
  }
  return rows;
}

/** A criterion in the spec's own words, for the heuristic: the clause, stated. */
export function statedCriterion(clause: string): string {
  return `${sentenceCase(clause.trim().replace(/[.;:]+$/, ""))}.`;
}
