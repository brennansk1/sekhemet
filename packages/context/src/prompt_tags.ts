/**
 * The registered tag vocabulary and the capital-word allowlist
 * (PROMPT_STANDARD rules 5 and 10; context CX-M1-12).
 *
 * The prompt lint (`prompt_lint.ts`) allows a registered tag, opening or
 * closing, with or without attributes; any other `<…>` or `[…]` span of
 * lower-case words is a placeholder. A new tag or acronym joins these lists in
 * the same change as the template that first uses it, and goes through the
 * prompt change steps with that template (rule 35).
 */

/** The tags the prompt standard names (rule 5). */
export const REGISTERED_PROMPT_TAGS: readonly string[] = [
  "rules",
  "tool_rules",
  "example",
  "prefer",
  "instead_of",
  "card",
  "criteria",
  "acceptance_test",
  "observation",
  "document",
  "source",
  "content",
  "untrusted_content",
];

/** Acronyms and identifiers a model needs in capitals (rule 10). */
export const PROMPT_ACRONYM_ALLOWLIST: readonly string[] = [
  "JSON",
  "HTTP",
  "URL",
  "API",
  "SQL",
  "CLI",
  "LSP",
];

/** Identifiers allowed by pattern: TypeScript error codes such as `TS2375`. */
export const PROMPT_ACRONYM_PATTERNS: readonly RegExp[] = [/^TS\d{4,5}$/];

/** Words used for emphasis. They are never added to the allowlist (rule 10). */
export const PROMPT_EMPHASIS_WORDS: readonly string[] = ["MUST", "NEVER", "CRITICAL", "IMPORTANT"];

/**
 * A copy module: the one file per role that may hold model-facing sentences
 * (rule 13, CX-M1-13). Named `copy.ts`, `<role>_copy.ts`, or kept in a
 * `copy/` folder. None exists yet; every model-facing literal is recorded in
 * the grandfathered inventory until it moves into one.
 */
export const COPY_MODULE_PATTERN = /(^|\/)(copy\/[^/]+\.ts|copy\.ts|[a-z0-9_]+_copy\.ts)$/;

const TAGS = new Set(REGISTERED_PROMPT_TAGS);
const ACRONYMS = new Set(PROMPT_ACRONYM_ALLOWLIST);
const EMPHASIS = new Set(PROMPT_EMPHASIS_WORDS);

export function isRegisteredPromptTag(name: string): boolean {
  return TAGS.has(name);
}

/** True for an all-capital word the lint's emphasis check lets through. */
export function isAllowlistedCapitalWord(word: string): boolean {
  if (EMPHASIS.has(word)) return false;
  return ACRONYMS.has(word) || PROMPT_ACRONYM_PATTERNS.some((re) => re.test(word));
}

export function isCopyModulePath(path: string): boolean {
  return COPY_MODULE_PATTERN.test(path.replaceAll("\\", "/"));
}
