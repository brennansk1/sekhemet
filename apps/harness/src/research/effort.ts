/**
 * How hard deep research looks (design-stage §2.7.3, DS-N4-1). Effort is a
 * recorded setting, not a mood: each level fixes the number of sub-questions,
 * the page reads each sub-question may make, and the verification depth —
 * how many candidate revisions the gated critique pass may judge (§2.7.5).
 * The effort is recorded with the answer, on the ledger and in memory.
 */
export type ResearchEffort = "quick" | "standard" | "exhaustive";

export const RESEARCH_EFFORTS: readonly ResearchEffort[] = ["quick", "standard", "exhaustive"];

export interface EffortCaps {
  /** Sub-questions the question is decomposed into; 1 is a single researched question. */
  subQuestions: number;
  /** Page reads (fetched pages, documentation, papers) per sub-question. */
  pagesPerSubQuestion: number;
  /** Candidate revisions the critique pass may judge; 0 runs no critique. */
  critiqueCandidates: number;
  /** Model turns per sub-question. */
  turnsPerSubQuestion: number;
}

export const EFFORT_CAPS: Readonly<Record<ResearchEffort, EffortCaps>> = {
  quick: { subQuestions: 1, pagesPerSubQuestion: 4, critiqueCandidates: 0, turnsPerSubQuestion: 8 },
  standard: {
    subQuestions: 4,
    pagesPerSubQuestion: 6,
    critiqueCandidates: 1,
    turnsPerSubQuestion: 8,
  },
  exhaustive: {
    subQuestions: 8,
    pagesPerSubQuestion: 12,
    critiqueCandidates: 3,
    turnsPerSubQuestion: 12,
  },
};

export function parseEffort(value: unknown): ResearchEffort | undefined {
  return typeof value === "string" && (RESEARCH_EFFORTS as readonly string[]).includes(value)
    ? (value as ResearchEffort)
    : undefined;
}

/** A card's effort label (`effort:exhaustive`), so a research card can ask for one. */
export function effortOfLabels(labels: readonly string[] | undefined): ResearchEffort | undefined {
  for (const l of labels ?? []) {
    const m = /^effort:(\w+)$/i.exec(l.trim());
    const e = parseEffort(m?.[1]?.toLowerCase());
    if (e) return e;
  }
  return undefined;
}
