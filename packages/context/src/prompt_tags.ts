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

/**
 * Words used for emphasis. They are never added to the allowlist (rule 10),
 * and the lint flags them even inside a code span, where a template could
 * otherwise hide them.
 */
export const PROMPT_EMPHASIS_WORDS: readonly string[] = [
  "MUST",
  "NEVER",
  "CRITICAL",
  "IMPORTANT",
  "ALWAYS",
  "ONLY",
  "NOT",
  "DO",
  "NOTE",
  "WARNING",
];

/**
 * The copy modules, by role: the one file per role that may hold
 * model-facing sentences (rule 13, CX-M1-13). Only a file registered here is
 * exempt from the literal inventory. A file shaped like a copy module
 * (`copy.ts`, `<role>_copy.ts`, a `copy/` folder) that is not registered is a
 * finding, so a new copy module is registered in the same change that
 * creates it.
 */
export const COPY_MODULES: Readonly<Record<string, string>> = {
  gates: "packages/gates/src/copy.ts",
  qualification: "packages/models/src/qualification_copy.ts",
  worker: "packages/context/src/worker_copy.ts",
};

/** The shape of a copy module's path; a match must be registered in `COPY_MODULES`. */
export const COPY_MODULE_PATTERN = /(^|\/)(copy\/[^/]+\.ts|copy\.ts|[a-z0-9_]+_copy\.ts)$/;

const TAGS = new Set(REGISTERED_PROMPT_TAGS);
const ACRONYMS = new Set(PROMPT_ACRONYM_ALLOWLIST);
const EMPHASIS = new Set(PROMPT_EMPHASIS_WORDS);
const COPY_PATHS = new Set(Object.values(COPY_MODULES));

const normalise = (path: string) => path.replaceAll("\\", "/");

export function isRegisteredPromptTag(name: string): boolean {
  return TAGS.has(name);
}

/** True for a word used for emphasis (rule 10). */
export function isEmphasisWord(word: string): boolean {
  return EMPHASIS.has(word);
}

/** True for an all-capital word the lint's emphasis check lets through. */
export function isAllowlistedCapitalWord(word: string): boolean {
  if (EMPHASIS.has(word)) return false;
  return ACRONYMS.has(word) || PROMPT_ACRONYM_PATTERNS.some((re) => re.test(word));
}

/** True only for a registered copy module (repository-relative path). */
export function isCopyModulePath(path: string): boolean {
  return COPY_PATHS.has(normalise(path));
}

/**
 * Packages whose copy only people read (the dashboard's words). A file there
 * shaped like a copy module is not a model's copy module and need not be
 * registered.
 */
export const HUMAN_COPY_ROOTS: readonly string[] = ["packages/ui/"];

/** Paths shaped like a copy module that are not registered in `COPY_MODULES`. */
export function unregisteredCopyModules(paths: readonly string[]): string[] {
  return paths
    .map(normalise)
    .filter(
      (p) =>
        COPY_MODULE_PATTERN.test(p) &&
        !COPY_PATHS.has(p) &&
        !HUMAN_COPY_ROOTS.some((root) => p.startsWith(root)),
    );
}
