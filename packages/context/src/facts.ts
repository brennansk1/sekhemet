/**
 * Fact keys: what a piece of guidance is about, so the same fact reaching the
 * prompt from two places (a seeded rule, an explored rule, a gate remedy, a
 * struggle lesson) can be recognised and shown once (Integration review A3).
 *
 * A key is either a canonical constraint name or a diagnostic code. Codes
 * that name exactly one constraint map to it (TS2375 is always
 * exactOptionalPropertyTypes); codes that do not (TS2307: any unresolved
 * import) stay codes, so a rule is never suppressed by an unrelated remedy.
 */

const CONSTRAINTS: { key: string; pattern: RegExp }[] = [
  {
    key: "exactOptionalPropertyTypes",
    pattern: /exactOptionalPropertyTypes|\bTS(?:2375|2379|2412)\b/i,
  },
  {
    key: "noUncheckedIndexedAccess",
    pattern:
      /noUncheckedIndexedAccess|\bTS(?:18048|18047|2532|2533)\b|lint\/style\/noNonNullAssertion/i,
  },
  { key: "node:sqlite", pattern: /node:sqlite|better-sqlite3|DatabaseSync/ },
  {
    key: "esm-js-extensions",
    pattern: /\bTS2835\b|\.js extension|end in \.js|relative import[s]? must end|`\.\/[\w-]+\.js`/i,
  },
];

const CODE = /\b(TS\d{4,5})\b|\b(lint\/[a-zA-Z]+\/[A-Za-z0-9]+)\b/g;

/** Codes subsumed by a constraint key, so they are not also listed separately. */
const SUBSUMED =
  /^(?:TS(?:2375|2379|2412|18048|18047|2532|2533|2835)|lint\/style\/noNonNullAssertion)$/;

/** The fact keys a text is about, sorted and unique. */
export function factKeysOf(text: string): string[] {
  const keys = new Set<string>();
  for (const c of CONSTRAINTS) if (c.pattern.test(text)) keys.add(c.key);
  for (const m of text.matchAll(CODE)) {
    const code = m[1] ?? m[2];
    if (code && !SUBSUMED.test(code)) keys.add(code);
  }
  return [...keys].sort();
}

/** True when every key of `keys` is in `covered` (and there is at least one). */
export function keysCovered(keys: readonly string[], covered: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every((k) => covered.has(k));
}
