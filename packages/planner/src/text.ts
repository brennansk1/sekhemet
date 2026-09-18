/**
 * Whole-word spec matching.
 *
 * Every keyword lookup in this package goes through {@link tokenize}. The
 * reason is a concrete defect: the previous classifier tested
 * `description.includes("or")`, which fires on "for", "order", "storage",
 * "worktree" and "editor" — the ambiguity signal was indistinguishable from
 * noise. A keyword may only count when it appears as a word.
 */

/** One word of a spec, with the offset the UI needs to highlight it. */
export interface SpecToken {
  /** Lower-cased word. */
  text: string;
  /** Character offset into the original (non-lower-cased) spec. */
  offset: number;
}

/**
 * Hyphens split, underscores do not: "rate-limiting" is two English words but
 * `is_archived` is one identifier, and both appear in real specs.
 */
const TOKEN_PATTERN = /[a-z0-9][a-z0-9_]*/g;

const CLAUSE_SPLIT = /[.!?;\n]+/;
const SUB_CLAUSE_SPLIT = /,|\band\b|\bwith\b|\bplus\b|\bas well as\b|\balong with\b/i;

/**
 * Words that carry no capability meaning, so a clause made only of these is
 * not a unit of work worth a card.
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "for",
  "it",
  "its",
  "we",
  "our",
  "us",
  "let",
  "lets",
  "s",
  "be",
  "is",
  "are",
  "should",
  "must",
  "can",
  "will",
  "that",
  "this",
  "there",
  "then",
  "also",
  "and",
  "or",
  "but",
  "so",
  "by",
  "at",
  "as",
  "from",
  "into",
  "over",
  "via",
  "add",
  "implement",
  "support",
  "build",
  "create",
  "make",
  "provide",
  "allow",
  "enable",
  "developer",
  "user",
  "system",
]);

/** Leading verbs stripped when a clause is turned into a card title. */
const LEAD_VERBS = new Set([
  "implement",
  "add",
  "support",
  "build",
  "create",
  "make",
  "provide",
  "allow",
  "enable",
  "introduce",
  "wire",
  "handle",
  "expose",
  "let",
  "lets",
]);

export function tokenize(text: string): SpecToken[] {
  const tokens: SpecToken[] = [];
  const lower = text.toLowerCase();
  TOKEN_PATTERN.lastIndex = 0;
  let match = TOKEN_PATTERN.exec(lower);
  while (match !== null) {
    tokens.push({ text: match[0], offset: match.index });
    match = TOKEN_PATTERN.exec(lower);
  }
  return tokens;
}

/**
 * Find a one-or-more-word phrase in a token stream.
 *
 * Returns the first token of the match so callers can report where in the spec
 * the signal came from rather than asserting it exists somewhere.
 */
export function findPhrase(tokens: SpecToken[], phrase: string): SpecToken | undefined {
  const words = phrase.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) {
    return undefined;
  }
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < words.length; j += 1) {
      if (tokens[i + j]?.text !== words[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return tokens[i];
    }
  }
  return undefined;
}

export function hasPhrase(tokens: SpecToken[], phrase: string): boolean {
  return findPhrase(tokens, phrase) !== undefined;
}

/** Count whole-word occurrences, used for repeat-decayed ambiguity weighting. */
export function countPhrase(tokens: SpecToken[], phrase: string): number {
  const words = phrase.split(" ").filter((w) => w.length > 0);
  if (words.length === 0) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < words.length; j += 1) {
      if (tokens[i + j]?.text !== words[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      count += 1;
    }
  }
  return count;
}

/** Offsets of every whole-word occurrence, so each hit can be cited separately. */
export function phraseOffsets(tokens: SpecToken[], phrase: string): number[] {
  const words = phrase.split(" ").filter((w) => w.length > 0);
  const offsets: number[] = [];
  if (words.length === 0) {
    return offsets;
  }
  for (let i = 0; i + words.length <= tokens.length; i += 1) {
    let matched = true;
    for (let j = 0; j < words.length; j += 1) {
      if (tokens[i + j]?.text !== words[j]) {
        matched = false;
        break;
      }
    }
    const start = tokens[i];
    if (matched && start !== undefined) {
      offsets.push(start.offset);
    }
  }
  return offsets;
}

/** All phrases from `phrases` that occur as whole words, with their positions. */
export function matchPhrases(
  tokens: SpecToken[],
  phrases: readonly string[],
): { phrase: string; token: SpecToken }[] {
  const hits: { phrase: string; token: SpecToken }[] = [];
  for (const phrase of phrases) {
    const token = findPhrase(tokens, phrase);
    if (token !== undefined) {
      hits.push({ phrase, token });
    }
  }
  return hits;
}

/** Sentence-level split; the unit an ambiguity finding is quoted from. */
export function splitSentences(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Clause-level split.
 *
 * SPIDR slicing needs the individual capabilities a sentence enumerates
 * ("JWT session cookies, password hashing, and rate limiting" is three), not
 * the sentence as one lump.
 */
export function splitClauses(text: string): string[] {
  const clauses: string[] = [];
  for (const sentence of splitSentences(text)) {
    for (const part of sentence.split(SUB_CLAUSE_SPLIT)) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        clauses.push(trimmed);
      }
    }
  }
  return clauses;
}

/** Content words of a clause: what makes it a distinct unit of work. */
export function contentWords(text: string): string[] {
  return tokenize(text)
    .map((t) => t.text)
    .filter((w) => !STOPWORDS.has(w) && w.length > 1);
}

/** Strip the imperative lead so "Implement rate limiting" reads "rate limiting". */
export function stripLeadVerb(text: string): string {
  const words = text.trim().split(/\s+/);
  const first = words[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (first !== undefined && LEAD_VERBS.has(first) && words.length > 1) {
    return words.slice(1).join(" ");
  }
  return text.trim();
}

export function slugify(text: string): string {
  const slug = contentWords(text).slice(0, 3).join("_");
  return slug.length > 0 ? slug : "feature";
}

/** Sentence case without touching acronyms the human wrote in caps. */
export function sentenceCase(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.charAt(0);
  return first.length === 0 ? trimmed : first.toUpperCase() + trimmed.slice(1);
}

/** Short quote of the spec, for decision requests and assumption logs. */
export function excerpt(text: string, max = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
