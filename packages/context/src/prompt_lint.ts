import { isAllowlistedCapitalWord, isRegisteredPromptTag } from "./prompt_tags.js";

/**
 * The prompt lint (PROMPT_STANDARD rule 35.1; context CX-M1-1, CX-M1-12).
 *
 * It measures a rendered template; it never changes one. Style counts
 * (capital words, imperative rules, negations, long tool descriptions) are
 * compared with a recorded per-template baseline that may only fall (rule 36).
 * Placeholders and contradictions are defects and have no baseline.
 */

export interface PromptLintCounts {
  /** All-capital words of two or more letters, outside code spans and the allowlist. */
  capitalWords: number;
  imperativeRules: number;
  /** Negating words outside code spans. */
  negations: number;
  /** Tool descriptions longer than two sentences (rule 18). */
  longToolDescriptions: number;
}

/**
 * How the imperative rules were counted (rule 11).
 * - `rule_sections`: the items of the template's `<rules>` and `<tool_rules>`
 *   sections: one item per list line, or per non-empty line when unlisted.
 * - `legacy_directives`: a template written before the standard has no rule
 *   sections, so every sentence that directs the model counts: a sentence
 *   that starts, after any list marker and capitalised label, with an
 *   imperative verb from a fixed list, or with "do not", "don't", "never",
 *   "always", "only", "you must", "you should" or "you never".
 */
export type RuleCountMethod = "rule_sections" | "legacy_directives";

export interface ToolDescriptionInput {
  name: string;
  description: string;
}

export interface PromptLintContext {
  /** Every tool the model can call on this step. Enables the tool contradictions. */
  callableTools?: readonly string[];
  /** Whether `recall` is offered; defaults to `callableTools` containing it. */
  recallOffered?: boolean;
  /** The tool descriptions shown with this template. */
  tools?: readonly ToolDescriptionInput[];
}

export interface PromptLintReport {
  counts: PromptLintCounts;
  ruleCountMethod: RuleCountMethod;
  capitalWords: string[];
  placeholders: string[];
  contradictions: string[];
  longToolDescriptions: string[];
}

export type PromptLintEntry = PromptLintCounts & { ruleCountMethod: RuleCountMethod };
export type PromptLintBaseline = Record<string, PromptLintEntry>;

/** The cap on imperative rules per template (rule 11). */
export const PROMPT_RULE_CAP = 12;

/** Replace inline and fenced code spans with a neutral word. */
export function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " code ").replace(/`[^`\n]*`/g, " code ");
}

export function findCapitalEmphasis(text: string): string[] {
  const out: string[] = [];
  for (const token of stripCodeSpans(text).match(/[A-Za-z0-9_]+/g) ?? []) {
    const letters = token.replace(/[^A-Za-z]/g, "");
    if (letters.length < 2 || letters !== letters.toUpperCase()) continue;
    if (!isAllowlistedCapitalWord(token)) out.push(token);
  }
  return out;
}

const IMPERATIVE_VERBS = new Set(
  (
    "address answer apply ask avoid batch call check choose cite compare confirm copy create " +
    "decide delegate describe drop edit emit ensure explain extract finish fix fold follow give " +
    "ground include judge keep lead list look make mark name output pass plan prefer proceed " +
    "propose put read recommend refer remember reply report reproduce respond return rewrite run " +
    "say search show split start state stay stop submit summarise summarize think touch treat try " +
    "use verify wait work write"
  ).split(" "),
);

const DIRECTIVE_OPENINGS =
  /^(do not|don't|never|always|only|you must|you should|you never|you may not)\b/i;

function isDirective(sentence: string): boolean {
  const s = sentence.trim().replace(/^["'“(]+/, "");
  if (!s) return false;
  if (DIRECTIVE_OPENINGS.test(s)) return true;
  const first = /^[A-Za-z']+/.exec(s)?.[0]?.toLowerCase();
  return first !== undefined && IMPERATIVE_VERBS.has(first);
}

function listItems(body: string): number {
  const lines = body.split("\n").filter((l) => l.trim());
  const listed = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l));
  return listed.length > 0 ? listed.length : lines.length;
}

export function countImperativeRules(text: string): { count: number; method: RuleCountMethod } {
  const sections = [...text.matchAll(/<(rules|tool_rules)>([\s\S]*?)<\/\1>/g)];
  if (sections.length > 0) {
    return {
      count: sections.reduce((n, m) => n + listItems(m[2] ?? ""), 0),
      method: "rule_sections",
    };
  }
  let count = 0;
  for (const raw of stripCodeSpans(text).split("\n")) {
    const line = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^[A-Z][A-Z0-9 -]*[A-Z0-9]:\s*/, "");
    for (const sentence of line.split(/(?<=[.!?;])\s+/)) if (isDirective(sentence)) count++;
  }
  return { count, method: "legacy_directives" };
}

export function countNegations(text: string): number {
  return (stripCodeSpans(text).match(/\b(?:not|no|never|none|nothing|nor|cannot)\b|n't\b/gi) ?? [])
    .length;
}

/** Lower-case words, as a placeholder is written: letters, spaces and light punctuation. */
const LOWER_WORDS = /^[a-z][a-z_' ,/-]*$/;

export function findPlaceholders(text: string): string[] {
  const found: { at: number; span: string }[] = [];
  for (const m of text.matchAll(/<(\/?)([^<>\n]{1,80})>/g)) {
    const inner = m[2] ?? "";
    const name = inner.split(/\s/)[0] ?? "";
    const attributes = inner.slice(name.length);
    if (
      isRegisteredPromptTag(name) &&
      (attributes === "" || /^(\s+[a-z_]+="[^"]*")+$/.test(attributes))
    ) {
      continue;
    }
    if (LOWER_WORDS.test(inner)) found.push({ at: m.index ?? 0, span: m[0] });
  }
  for (const m of text.matchAll(/\[([^[\]\n]{1,80})\]/g)) {
    if (LOWER_WORDS.test(m[1] ?? "")) found.push({ at: m.index ?? 0, span: m[0] });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.span);
}

export function countSentences(text: string): number {
  const plain = stripCodeSpans(text).replace(/\b(e\.g|i\.e|etc|vs)\./gi, "$1");
  return plain.split(/[.!?](?=\s|$)/).filter((s) => /[A-Za-z]/.test(s)).length;
}

export function findLongToolDescriptions(tools: readonly ToolDescriptionInput[]): string[] {
  return tools
    .map((t) => ({ name: t.name, n: countSentences(t.description) }))
    .filter((t) => t.n > 2)
    .map((t) => `${t.name} (${t.n} sentences)`);
}

function mentions(text: string, name: string): boolean {
  return new RegExp(
    `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`,
  ).test(text);
}

/** The contradictions of rule 12 that can be found mechanically (CX-M1-1). */
export function findContradictions(text: string, ctx: PromptLintContext = {}): string[] {
  const out: string[] = [];
  if (/no other tools? exists?/i.test(text) && ctx.callableTools) {
    const unlisted = ctx.callableTools.filter((t) => !mentions(text, t));
    if (unlisted.length > 0) {
      out.push(
        `"No other tool exists" while ${unlisted.join(", ")} ${unlisted.length > 1 ? "are" : "is"} callable and not listed`,
      );
    }
  }
  if (/several (?:tool )?calls/i.test(text) && /exactly one tool call/i.test(text)) {
    out.push('both "several calls" and "exactly one tool call"');
  }
  const noReread = /do not (?:re-?read|read_file) (?:it|this file|the file)/i;
  if (noReread.test(text)) {
    const rest = text.replace(new RegExp(noReread.source, "gi"), "");
    if (/\b(?:read the file|re-?read (?:it|the file)|read it again)\b/i.test(rest)) {
      out.push('a "do not re-read" marker beside an instruction to read the file again');
    }
  }
  const recall = ctx.recallOffered ?? ctx.callableTools?.includes("recall");
  if (recall === false && /EvidenceRef:|recall\(/.test(text)) {
    out.push("an observation pointer while recall is not offered");
  }
  if (/^\s*\d+[.)]\s+\d+[.)]\s/m.test(text)) out.push("a list item numbered twice");
  if (/\bWAL\b/.test(text)) out.push('the string "WAL"');
  if (/NON-NEGOTIABLE/.test(text)) out.push('the string "NON-NEGOTIABLE"');
  return out;
}

export function lintPrompt(text: string, ctx: PromptLintContext = {}): PromptLintReport {
  const capitalWords = findCapitalEmphasis(text);
  const rules = countImperativeRules(text);
  const longToolDescriptions = findLongToolDescriptions(ctx.tools ?? []);
  return {
    counts: {
      capitalWords: capitalWords.length,
      imperativeRules: rules.count,
      negations: countNegations(text),
      longToolDescriptions: longToolDescriptions.length,
    },
    ruleCountMethod: rules.method,
    capitalWords,
    placeholders: findPlaceholders(text),
    contradictions: findContradictions(text, ctx),
    longToolDescriptions,
  };
}

const COUNT_KEYS: (keyof PromptLintCounts)[] = [
  "capitalWords",
  "imperativeRules",
  "negations",
  "longToolDescriptions",
];

/**
 * Compare this build's counts with the recorded baseline (rule 36). A count
 * may fall, never rise; every rendered template needs a recorded entry; a
 * recorded entry that is no longer rendered is removed; and a template in
 * rule-section form is held to the cap of 12 whatever its record says.
 */
export function compareWithBaseline(
  current: PromptLintBaseline,
  baseline: PromptLintBaseline,
): string[] {
  const out: string[] = [];
  for (const [name, entry] of Object.entries(current)) {
    const recorded = baseline[name];
    if (!recorded) {
      out.push(`${name}: no recorded baseline; record it (rule 36)`);
    } else {
      for (const key of COUNT_KEYS) {
        if (entry[key] > recorded[key]) {
          out.push(`${name}: ${key} rose from ${recorded[key]} to ${entry[key]}`);
        }
      }
    }
    if (entry.ruleCountMethod === "rule_sections" && entry.imperativeRules > PROMPT_RULE_CAP) {
      out.push(
        `${name}: ${entry.imperativeRules} imperative rules, over the cap of ${PROMPT_RULE_CAP} (rule 11)`,
      );
    }
  }
  for (const name of Object.keys(baseline)) {
    if (!(name in current)) {
      out.push(`${name}: recorded but no longer rendered; remove it from the baseline`);
    }
  }
  return out;
}

/**
 * The baseline to write back: new templates recorded as they are and counts
 * lowered where they fell. It refuses to raise a recorded count (rule 36).
 */
export function lowerBaseline(
  current: PromptLintBaseline,
  baseline: PromptLintBaseline,
): PromptLintBaseline {
  const next: PromptLintBaseline = {};
  for (const name of Object.keys(current).sort()) {
    const entry = current[name] as PromptLintEntry;
    const recorded = baseline[name];
    if (recorded) {
      for (const key of COUNT_KEYS) {
        if (entry[key] > recorded[key]) {
          throw new Error(`${name}: ${key} would rise from ${recorded[key]} to ${entry[key]}`);
        }
      }
    }
    next[name] = { ...entry };
  }
  return next;
}
