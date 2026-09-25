import { isAllowlistedCapitalWord, isEmphasisWord, isRegisteredPromptTag } from "./prompt_tags.js";

/**
 * The prompt lint (PROMPT_STANDARD rule 35.1; context CX-M1-1, CX-M1-12).
 *
 * It measures a rendered template; it never changes one. Style counts
 * (capital words, imperative rules, negations, long tool descriptions) are
 * compared with a recorded per-template baseline that may only fall (rule 36).
 * Placeholders and contradictions are defects and have no baseline.
 *
 * A placeholder is a `<…>` or `[…]` span of lower-case words, or an
 * unregistered tag with attributes (CX-M1-12). Lower-case data labels such
 * as `[typecheck]` or `[context compacted]` count too: a small model copies
 * them as readily as `[your answer]`, and CX-M1-12 makes no exception for
 * data, so they are fixed by a registered tag or a different rendering.
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
 * - `rule_sections`: the lines of the template's `<rules>` and `<tool_rules>`
 *   sections, listed or not: each line counts its directive sentences, and at
 *   least one. An empty section beside directives elsewhere is a violation.
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
  /** Parameter descriptions: each is held to the same two sentences (rule 18). */
  parameters?: readonly { name: string; description: string }[];
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
  /** Rule 11 violations the count cannot show: empty rule sections beside directives. */
  ruleViolations: string[];
}

/**
 * One template's recorded counts. A legacy template's rule count is not
 * measured (rule 36): it is recorded as `null` and not compared.
 */
export type PromptLintEntry = Omit<PromptLintCounts, "imperativeRules"> & {
  imperativeRules: number | null;
  ruleCountMethod: RuleCountMethod;
};
export type PromptLintBaseline = Record<string, PromptLintEntry>;

/** The cap on imperative rules per template (rule 11). */
export const PROMPT_RULE_CAP = 12;

/**
 * The version of what the lint measures. Raise it in any change that makes
 * the lint count differently (a new check, a check that sees more or less
 * text): the baseline records the version it was measured with, the test
 * fails while they differ, and only then may the baseline be re-measured
 * (`SEKHEMET_PROMPT_BASELINE_REMEASURE=<reason>`), so a raised count always
 * comes with a visible change to the lint.
 * - 1: the first lint (5b17ed1) and its review fixes.
 * - 2: fenced code and data-tag bodies are not checked; format strings such
 *   as `YYYY-MM-DD` are data; every sentence of a rule-section line counts.
 */
export const PROMPT_LINT_MEASURE_VERSION = 2;

/**
 * Tags whose body is data, not prompt text: what a file, a page, a tool or a
 * test says. The capital, placeholder and contradiction checks skip their
 * bodies (rule 10: data is not checked).
 */
export const PROMPT_DATA_TAGS: readonly string[] = [
  "untrusted_content",
  "document",
  "content",
  "observation",
  "acceptance_test",
];

const DATA_BODY = new RegExp(
  `<(${PROMPT_DATA_TAGS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`,
  "g",
);

/** The text with each data tag's body blanked (the tags stay, so positions of the rest hold). */
export function stripDataBodies(text: string): string {
  return text.replace(DATA_BODY, (m, tag: string) => {
    const open = m.slice(0, m.indexOf(">") + 1);
    return `${open}${" ".repeat(m.length - open.length - tag.length - 3)}</${tag}>`;
  });
}

/** A date or time format string (`YYYY-MM-DD`, `HH:MM:SS`): data, not emphasis. */
const FORMAT_STRING = /\b[YMDHS]{2,4}(?:[-/:.][YMDHS]{2,4})+\b/g;

/** Replace inline and fenced code spans with a neutral word. */
export function stripCodeSpans(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " code ").replace(/`[^`\n]*`/g, " code ");
}

/**
 * Capital words used for emphasis (rule 10). Fenced code, data-tag bodies and
 * format strings are not checked; an inline code span is checked for the
 * emphasis words only, where a template could otherwise hide them.
 */
export function findCapitalEmphasis(raw: string): string[] {
  const blank = (m: string) => " ".repeat(m.length);
  const text = stripDataBodies(raw)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(FORMAT_STRING, blank);
  const out: { at: number; word: string }[] = [];
  const code = /`[^`\n]*`/g;
  let last = 0;
  const scan = (chunk: string, offset: number, inCode: boolean) => {
    for (const m of chunk.matchAll(/[A-Za-z0-9_]+/g)) {
      const token = m[0];
      const letters = token.replace(/[^A-Za-z]/g, "");
      if (letters.length < 2 || letters !== letters.toUpperCase()) continue;
      if (inCode ? isEmphasisWord(token) : !isAllowlistedCapitalWord(token)) {
        out.push({ at: offset + (m.index ?? 0), word: token });
      }
    }
  };
  for (const m of text.matchAll(code)) {
    scan(text.slice(last, m.index), last, false);
    scan(m[0], m.index ?? 0, true);
    last = (m.index ?? 0) + m[0].length;
  }
  scan(text.slice(last), last, false);
  return out.sort((a, b) => a.at - b.at).map((x) => x.word);
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
  /^(do not|don['’]t|never|always|only|you must|you should|you never|you may not)\b/i;

function isDirective(sentence: string): boolean {
  const s = sentence.trim().replace(/^["'“‘(]+/, "");
  if (!s) return false;
  if (DIRECTIVE_OPENINGS.test(s)) return true;
  const first = /^[A-Za-z'’]+/.exec(s)?.[0]?.toLowerCase();
  return first !== undefined && IMPERATIVE_VERBS.has(first);
}

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

function sentencesOf(line: string): string[] {
  const body = line.replace(LIST_MARKER, "").replace(/^[A-Z][A-Z0-9 -]*[A-Z0-9]:\s*/, "");
  return body.split(/(?<=[.!?;])\s+/).filter((x) => /[A-Za-z]/.test(x));
}

function directiveSentences(line: string): number {
  return sentencesOf(line).filter(isDirective).length;
}

/**
 * Rule-section lines, listed or not. A rule section holds only directives
 * (rule 11), so every sentence counts, and each line at least once.
 */
function sectionRules(body: string): number {
  return stripCodeSpans(body)
    .split("\n")
    .filter((l) => l.trim())
    .reduce((n, l) => n + Math.max(1, sentencesOf(l).length), 0);
}

function legacyDirectives(text: string): number {
  return stripCodeSpans(text)
    .split("\n")
    .reduce((n, l) => n + directiveSentences(l), 0);
}

const RULE_SECTION = /<(rules|tool_rules)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;

export function countImperativeRules(text: string): {
  count: number;
  method: RuleCountMethod;
  violations: string[];
} {
  const sections = [...text.matchAll(RULE_SECTION)];
  if (sections.length > 0) {
    const count = sections.reduce((n, m) => n + sectionRules(m[2] ?? ""), 0);
    const outside = count === 0 ? legacyDirectives(text.replace(RULE_SECTION, " ")) : 0;
    return {
      count,
      method: "rule_sections",
      violations:
        outside > 0
          ? [
              `the rule sections are empty while ${outside} directive${outside > 1 ? "s" : ""} sit outside them (rule 11)`,
            ]
          : [],
    };
  }
  return { count: legacyDirectives(text), method: "legacy_directives", violations: [] };
}

export function countNegations(text: string): number {
  return (
    stripCodeSpans(text).match(/\b(?:not|no|never|none|nothing|nor|cannot)\b|n['’]t\b/gi) ?? []
  ).length;
}

/**
 * Lower-case words, as a placeholder is written: a letter, then letters,
 * digits, spaces and light punctuation (`<file:line>`, `<path/to/file.ts>`,
 * `<your answer…>`).
 */
const LOWER_WORDS = /^[a-z][a-z0-9_'’ ,/.:…-]*$/;
/** Attributes, double- or single-quoted, and an optional self-closing slash. */
const ATTRIBUTES = /^(\s+[a-z_][a-z0-9_-]*=("[^"]*"|'[^']*'))*\s*\/?$/;

/**
 * A span right after a letter or digit is code: `Map<string, number>`,
 * `rows[index]`. Not after an underscore: `test_<name>.ts` is a placeholder.
 */
const afterIdentifier = (text: string, at: number) =>
  at > 0 && /[A-Za-z0-9]/.test(text[at - 1] ?? "");

export function findPlaceholders(raw: string): string[] {
  const text = stripDataBodies(raw);
  const found: { at: number; span: string }[] = [];
  for (const m of text.matchAll(/<(\/?)([^<>\n]{1,80})>/g)) {
    const at = m.index ?? 0;
    // A closing tag follows text by nature; only an opening span can be a type argument.
    if (m[1] === "" && afterIdentifier(text, at)) continue;
    const inner = m[2] ?? "";
    if (/^https?:\/\//.test(inner)) continue;
    const name = /^[^\s/]*/.exec(inner)?.[0] ?? "";
    const attributes = inner.slice(name.length);
    const tagShaped = /^[a-z_][a-z0-9_-]*$/.test(name) && ATTRIBUTES.test(attributes);
    if (tagShaped && isRegisteredPromptTag(name)) continue;
    if (tagShaped || LOWER_WORDS.test(inner)) found.push({ at, span: m[0] });
  }
  for (const m of text.matchAll(/\[([^[\]\n]{1,80})\]/g)) {
    const at = m.index ?? 0;
    if (afterIdentifier(text, at)) continue;
    if (LOWER_WORDS.test(m[1] ?? "")) found.push({ at, span: m[0] });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.span);
}

export function countSentences(text: string): number {
  const plain = stripCodeSpans(text).replace(/\b(e\.g|i\.e|etc|vs)\./gi, "$1");
  return plain.split(/[.!?](?=\s|$)/).filter((s) => /[A-Za-z]/.test(s)).length;
}

/** Tool and parameter descriptions longer than two sentences (rule 18). */
export function findLongToolDescriptions(tools: readonly ToolDescriptionInput[]): string[] {
  return tools
    .flatMap((t) => [
      { name: t.name, n: countSentences(t.description) },
      ...(t.parameters ?? []).map((p) => ({
        name: `${t.name}.${p.name}`,
        n: countSentences(p.description),
      })),
    ])
    .filter((t) => t.n > 2)
    .map((t) => `${t.name} (${t.n} sentences)`);
}

function mentions(text: string, name: string): boolean {
  return new RegExp(
    `(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`,
  ).test(text);
}

/** The contradictions of rule 12 that can be found mechanically (CX-M1-1). */
export function findContradictions(raw: string, ctx: PromptLintContext = {}): string[] {
  const text = stripDataBodies(raw);
  const out: string[] = [];
  // The closed-tool-set claim, in the old words or the rewritten ones (B5).
  if (/no other tools? exists?|call only (?:the )?tools named/i.test(text) && ctx.callableTools) {
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
  // Coarse by design: any "re-read" or "read the file" elsewhere in the
  // request, beside any marker, is reported; the finding names no file.
  const noReread = /(?:do not|don['’]t) (?:re-?read|read_file)(?: (?:it|this file|the file))?/gi;
  if (noReread.test(text)) {
    const rest = text.replace(noReread, "");
    // Also a read_file instruction for the same content (B2): "read_file with
    // a line range", "read_file them". A logged `read_file(path=…)` call in the
    // history is data, not an instruction, and is not matched.
    if (
      /\bre-?read\b|\bread the file\b|\bread it again\b|\bread the surrounding lines\b|\bread_file (?:with a line range|them|it again)\b/i.test(
        rest,
      )
    ) {
      out.push('a "do not re-read" marker beside an instruction to read the file again');
    }
  }
  const recall = ctx.recallOffered ?? ctx.callableTools?.includes("recall");
  if (recall === false && /EvidenceRef:|recall\(/.test(text)) {
    out.push("an observation pointer while recall is not offered");
  }
  if (/^\s*(?:[-*•]|\d+[.)])\s+\d+[.)]\s/m.test(text)) out.push("a list item numbered twice");
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
    ruleViolations: rules.violations,
  };
}

/** A report as the baseline records it: a legacy rule count is not measured (rule 36). */
export function baselineEntryOf(report: PromptLintReport): PromptLintEntry {
  return {
    ...report.counts,
    imperativeRules:
      report.ruleCountMethod === "legacy_directives" ? null : report.counts.imperativeRules,
    ruleCountMethod: report.ruleCountMethod,
  };
}

const COUNT_KEYS: (keyof PromptLintCounts)[] = [
  "capitalWords",
  "imperativeRules",
  "negations",
  "longToolDescriptions",
];

/** Counts that rose from the record; a count not measured on either side is skipped. */
function rises(name: string, entry: PromptLintEntry, recorded: PromptLintEntry): string[] {
  const out: string[] = [];
  for (const key of COUNT_KEYS) {
    const now = entry[key];
    const was = recorded[key];
    if (now === null || was === null) continue;
    if (now > was) out.push(`${name}: ${key} rose from ${was} to ${now}`);
  }
  return out;
}

const backToLegacy = (entry: PromptLintEntry, recorded: PromptLintEntry | undefined) =>
  recorded?.ruleCountMethod === "rule_sections" && entry.ruleCountMethod === "legacy_directives";

/**
 * Compare this build's counts with the recorded baseline (rule 36). A count
 * may fall, never rise; a legacy template's rule count is not measured; a
 * template may not go back from rule sections to legacy; every rendered
 * template needs a recorded entry; a recorded entry that is no longer
 * rendered is removed; and a template in rule-section form is held to the
 * cap of 12 whatever its record says.
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
      out.push(...rises(name, entry, recorded));
      if (backToLegacy(entry, recorded)) {
        out.push(`${name}: switched from rule sections back to legacy directives (rule 36)`);
      }
    }
    if (
      entry.ruleCountMethod === "rule_sections" &&
      entry.imperativeRules !== null &&
      entry.imperativeRules > PROMPT_RULE_CAP
    ) {
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

/** `SEKHEMET_PROMPT_BASELINE_RENAME=old:new[,old:new]`: templates renamed in this change. */
export function parseBaselineRenames(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (value ?? "").split(",").map((p) => p.trim())) {
    if (!pair) continue;
    const [from, to, ...rest] = pair.split(":");
    if (!from || !to || rest.length > 0) {
      throw new Error(`SEKHEMET_PROMPT_BASELINE_RENAME: "${pair}" is not old:new`);
    }
    out[from] = to;
  }
  return out;
}

/** Counts a new template may not bring in: they are violations, not style (rule 36). */
const NEW_TEMPLATE_ZERO: (keyof PromptLintCounts)[] = ["capitalWords", "longToolDescriptions"];

export interface LowerBaselineOptions {
  /** Templates renamed in this change, old name to new (`SEKHEMET_PROMPT_BASELINE_RENAME`). */
  renames?: Record<string, string>;
  /**
   * A change to the lint's own measurement (a new check, wider coverage): it
   * may raise counts and record new templates with existing violations. The
   * caller records why. Dropped templates and a return to legacy still fail.
   */
  remeasure?: boolean;
}

/**
 * The baseline to write back: counts lowered where they fell (rule 36). It
 * refuses to raise a recorded count, to drop a recorded template that is no
 * longer rendered unless `renames` names its new name (whose counts are then
 * held to the old record), to take a template from rule sections back to
 * legacy, and to record a new template with capital emphasis or a long tool
 * description.
 */
export function lowerBaseline(
  current: PromptLintBaseline,
  baseline: PromptLintBaseline,
  options: LowerBaselineOptions = {},
): PromptLintBaseline {
  const renames = options.renames ?? {};
  const renamedFrom = new Map(Object.entries(renames).map(([from, to]) => [to, from]));
  for (const name of Object.keys(baseline)) {
    if (name in current) continue;
    const to = renames[name];
    if (to === undefined || !(to in current)) {
      throw new Error(
        `${name}: recorded but not rendered; if it was renamed, record with SEKHEMET_PROMPT_BASELINE_RENAME=${name}:${to ?? Object.keys(current).find((c) => !(c in baseline)) ?? "<new name>"}`,
      );
    }
  }
  const next: PromptLintBaseline = {};
  for (const name of Object.keys(current).sort()) {
    const entry = current[name] as PromptLintEntry;
    const from = renamedFrom.get(name);
    const recorded = baseline[name] ?? (from !== undefined ? baseline[from] : undefined);
    if (recorded) {
      const up = rises(name, entry, recorded);
      if (up.length > 0 && !options.remeasure) {
        throw new Error(up[0]?.replace(" rose from ", " would rise from "));
      }
      if (backToLegacy(entry, recorded)) {
        throw new Error(`${name}: would switch from rule sections back to legacy directives`);
      }
    } else if (!options.remeasure) {
      for (const key of NEW_TEMPLATE_ZERO) {
        if ((entry[key] ?? 0) > 0) {
          throw new Error(`${name}: a new template may not record ${key} ${entry[key]} (rule 36)`);
        }
      }
    }
    next[name] = { ...entry };
  }
  return next;
}

/** One re-measure of the baseline: the lint version, the real date and why. */
export interface PromptLintRemeasure {
  version: number;
  date: string;
  reason: string;
}

/** `prompt_lint_baseline.json`. */
export interface PromptLintBaselineFile {
  about: string;
  /** The `PROMPT_LINT_MEASURE_VERSION` the counts were measured with. */
  measureVersion: number;
  /** Append-only: every re-measure, carried forward by every later record. */
  remeasures: PromptLintRemeasure[];
  templates: PromptLintBaseline;
}

/** Totals across templates, which the test pins so a hand edit of the file shows. */
export function baselineTotals(templates: PromptLintBaseline): {
  templates: number;
  capitalWords: number;
  negations: number;
  longToolDescriptions: number;
} {
  const entries = Object.values(templates);
  const sum = (k: "capitalWords" | "negations" | "longToolDescriptions") =>
    entries.reduce((n, e) => n + e[k], 0);
  return {
    templates: entries.length,
    capitalWords: sum("capitalWords"),
    negations: sum("negations"),
    longToolDescriptions: sum("longToolDescriptions"),
  };
}

/**
 * The baseline file to write back (rule 36). A plain record needs the lint's
 * measurement version unchanged and may only lower counts. A re-measure
 * (`remeasure` holds the reason) is allowed only when the version changed,
 * needs a reason, may raise counts, and is appended to the log that every
 * later record carries forward.
 */
export function nextBaselineFile(
  file: PromptLintBaselineFile,
  current: PromptLintBaseline,
  options: {
    about: string;
    /** Today's real date, `YYYY-MM-DD`. */
    today: string;
    renames?: Record<string, string>;
    remeasure?: string | undefined;
  },
): PromptLintBaselineFile {
  const changed = file.measureVersion !== PROMPT_LINT_MEASURE_VERSION;
  const remeasures = [...(file.remeasures ?? [])];
  if (options.remeasure !== undefined) {
    const reason = options.remeasure.trim();
    if (!reason) throw new Error("SEKHEMET_PROMPT_BASELINE_REMEASURE needs a reason");
    if (!changed) {
      throw new Error(
        `the lint's measurement version is unchanged (${PROMPT_LINT_MEASURE_VERSION}): a re-measure needs a change to what the lint counts, with PROMPT_LINT_MEASURE_VERSION raised`,
      );
    }
    remeasures.push({ version: PROMPT_LINT_MEASURE_VERSION, date: options.today, reason });
  } else if (changed) {
    throw new Error(
      `the baseline was measured with lint version ${file.measureVersion} and the lint is now version ${PROMPT_LINT_MEASURE_VERSION}: re-record with SEKHEMET_PROMPT_BASELINE_REMEASURE=<reason>`,
    );
  }
  return {
    about: options.about,
    measureVersion: PROMPT_LINT_MEASURE_VERSION,
    remeasures,
    templates: lowerBaseline(current, file.templates, {
      renames: options.renames ?? {},
      remeasure: options.remeasure !== undefined,
    }),
  };
}
