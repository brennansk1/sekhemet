/**
 * What a need is about, in words that may leave the machine (design-stage
 * S8, P7): the keyword query the survey and `find_library` send, the
 * relevance test every candidate must pass, and the needs the language
 * itself covers, for which no package is looked for at all (DS-P7-6).
 * A leaf module: the survey and the registry search both read it.
 */

const STOP = new Set(
  "a an the that this it its and or of to for in on with by from my our your their which who whether is are be should must can will me us".split(
    " ",
  ),
);
/**
 * Words that say what kind of thing is built, or that it is built, not what
 * it is about. Live searches on "handles refunds" and "a CLI that
 * deduplicates photos" returned a streams library and a GraphQL tool,
 * matched on exactly these. The language is the search's own qualifier
 * (DS-P7-5), never a keyword.
 */
const GENERIC = new Set(
  "cli tool tools app apps application service services library lib program script system handles handle manages manage folder directory file files simple basic small new node typescript javascript python golang rust build make create write want need".split(
    " ",
  ),
);

/**
 * Words of needs the standard library of any language covers: arithmetic,
 * counting, strings, conversions. A need made only of these (after the stop
 * and generic words) needs no package, and the survey says so (DS-P7-6).
 * No word here names a thing a domain is about: "user" or "name" would make
 * "checks the user" (authentication) or "random names" (a data generator)
 * a standard-library need that is never searched.
 */
const BUILT_IN = new Set(
  "calculator calculate calculation compute arithmetic add addition subtract subtraction multiply multiplication divide division sum total average mean median percentage percent tip two number numbers integer integers counter count word words character characters letter letters sentence string text reverse palindrome uppercase lowercase hello world greet greeting check split bill fizzbuzz factorial fibonacci prime primes even odd square root temperature celsius fahrenheit convert converter conversion kilometres miles guess guessing dice roll coin flip random list print".split(
    " ",
  ),
);

const stem = (w: string): string => w.slice(0, 5);

/** Content words of a text, lower-cased, without stop or generic words. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !GENERIC.has(w));
}

/** A short keyword query: what leaves the machine is this, not the spec. */
export function queryFor(need: string): string {
  return contentWords(need).slice(0, 4).join(" ");
}

/** Stems of a text's words, with hyphenated words also read joined. */
function stems(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = [...lower.split(/[^a-z]+/), ...lower.replace(/-/g, "").split(/[^a-z]+/)].filter(
    (w) => w.length > 2,
  );
  return new Set(words.map(stem));
}

/**
 * Does a candidate share what the need is about? At least two of the need's
 * content words (one, when it has only one), by stem, in its name or
 * description. A candidate that matched only a popular keyword is not one.
 */
export function relevant(need: string, text: string, minimum = 2): boolean {
  const wanted = [...new Set(queryFor(need).split(" ").filter(Boolean).map(stem))];
  if (!wanted.length) return false;
  const have = stems(text);
  const overlap = wanted.filter((w) => have.has(w)).length;
  return overlap >= Math.min(minimum, wanted.length);
}

/**
 * A need the language itself covers — "a calculator", "reverse a string" —
 * so no package is recommended and none is searched for (DS-P7-6). Every
 * content word must be one of the built-in words: "a calculator that parses
 * expressions" is not one.
 */
export function builtInNeed(need: string): boolean {
  const words = contentWords(need).map((w) => w.replace(/s$/, ""));
  return words.length > 0 && words.every((w) => BUILT_IN.has(w) || BUILT_IN.has(`${w}s`));
}
