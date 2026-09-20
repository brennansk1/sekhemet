/**
 * The card class: one definition, five consumers.
 *
 * `cardClass` is the partition key for step budgets, exemplar selection,
 * tool sets, routing and every competence row. It was previously defined in
 * three places — the exemplar store keyed on `tier:ext:keyword`, the card
 * runner on a SPIDR letter or the tier, and the tool catalog on its own
 * five-value enum — so "a class budget" and "two exemplars per class"
 * partitioned the same cards differently and the competence model could not
 * compound. This module is the only definition.
 *
 *     cardClass = "<kind>:<ext>"
 *
 * Three properties are required of the partition, and shape it:
 *
 * - **Pass rate is predictable within a class.** A spike and an
 *   implementation fail for different reasons and deserve different budgets;
 *   two implementations in the same language do not.
 * - **It is knowable before the card runs**, because budgets and tool sets
 *   are chosen up front. Both components come from the plan, never from the
 *   outcome.
 * - **It is coarse enough to fill.** Seven kinds across a handful of
 *   languages is tens of classes, which a few hundred cards can populate.
 *   Tier is deliberately excluded: it is already implied by size, and adding
 *   it would guarantee every class stays below its minimum trial count
 *   forever. A competence model that never reaches its threshold never acts.
 */

/**
 * What kind of work the card is. The first five are SPIDR, which the planner
 * already uses to decompose; the last two are the card types that produce no
 * diff. Tool sets are selected by kind alone.
 */
export type CardKind =
  | "spike" // a question answered by throwaway code
  | "interface" // a type, signature or contract, before its implementation
  | "implement" // the behaviour behind an interface (SPIDR's "path")
  | "data" // a migration, fixture, schema or seed
  | "rule" // a validation, policy or edge-case rule
  | "review" // reading work, not producing it
  | "research"; // answering a question with sources

export const CARD_KINDS: readonly CardKind[] = [
  "spike",
  "interface",
  "implement",
  "data",
  "rule",
  "review",
  "research",
];

/** SPIDR letters and words as the planner writes them into a card title. */
const SPIDR: Record<string, CardKind> = {
  s: "spike",
  spike: "spike",
  p: "implement",
  path: "implement",
  i: "interface",
  interface: "interface",
  d: "data",
  data: "data",
  r: "rule",
  rule: "rule",
};

/**
 * Keyword fallback, used only when nothing explicit says what the card is.
 * Ordered: the first match wins, so the more specific patterns come first.
 */
const KEYWORDS: [RegExp, CardKind][] = [
  [/\b(spike|investigate|explore|prototype|feasibility)\b/i, "spike"],
  [/\b(interface|signature|type|contract|api surface|declaration)\b/i, "interface"],
  [/\b(migration|schema|fixture|seed|backfill|dataset)\b/i, "data"],
  [/\b(validate|validation|rule|constraint|policy|guard|edge case)\b/i, "rule"],
  [/\b(review|audit|inspect)\b/i, "review"],
  [/\b(research|compare|evaluate|survey)\b/i, "research"],
];

export interface CardClassInput {
  title: string;
  labels?: string[] | undefined;
  scopeFiles?: string[] | undefined;
}

/**
 * The card's kind. A label is authoritative because a person set it; a SPIDR
 * marker is next because the planner set it deliberately; the keyword pass
 * is a guess and says so by defaulting to `implement`, which is both the
 * most common kind and the one whose tool set is the least surprising if the
 * guess is wrong.
 */
export function cardKind(card: CardClassInput): CardKind {
  for (const label of card.labels ?? []) {
    const l = label.toLowerCase();
    if ((CARD_KINDS as readonly string[]).includes(l)) return l as CardKind;
  }
  const marker = /\(SPIDR:\s*([A-Za-z]+)/i.exec(card.title)?.[1];
  const spidr = marker ? SPIDR[marker.toLowerCase()] : undefined;
  if (spidr) return spidr;
  return KEYWORDS.find(([re]) => re.test(card.title))?.[1] ?? "implement";
}

/** The dominant file extension of the declared scope, or `none`. */
export function scopeExtension(scopeFiles: readonly string[] | undefined): string {
  const counts = new Map<string, number>();
  for (const f of scopeFiles ?? []) {
    const ext = (/\.([a-z0-9]+)$/i.exec(f)?.[1] ?? "none").toLowerCase();
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  // Ties break by name so the same scope always yields the same class, which
  // is what keeps the assembled prompt byte-identical across runs.
  return (
    [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "none"
  );
}

/** `<kind>:<ext>` — the key budgets, routes, exemplars and competence use. */
export function cardClassOf(card: CardClassInput): string {
  return `${cardKind(card)}:${scopeExtension(card.scopeFiles)}`;
}
