import { existsSync } from "node:fs";
import { join } from "node:path";
import { type GateFailure, detectGateTemplate, redactSecrets } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { researchCopy } from "./research_copy.js";

/**
 * The Researcher asked early, with the card in hand (design-stage
 * NEW-design-stage-5). When a failing card's struggle has no known remedy,
 * the repair batch asks the Researcher before the repair plan is written
 * (DS-N5-2), passing the card's spec, criteria and scope files, the failing
 * gate's typed failure and the project's detected stack — never a hard-coded
 * language (DS-N5-1). The answer is recorded whole on the card's dossier by
 * the research service (`card/research`, DS-N5-3) and handed to the plan's
 * author.
 */

/** The project's stack as its manifests say, for the Researcher; "unknown" when none is recognised. */
export function projectStack(repoPath: string): string {
  const has = (f: string) => existsSync(join(repoPath, f));
  const template = detectGateTemplate(repoPath);
  switch (template) {
    case "pnpm":
    case "npm":
    case "yarn":
      return `${has("tsconfig.json") ? "TypeScript" : "JavaScript"} (Node.js, ${template})`;
    case "python":
      return "Python";
    case "rust":
      return "Rust (Cargo)";
    case "go":
      return "Go";
    default:
      return "unknown-stack";
  }
}

/** One card whose failure may prompt research: its record, the gate's failures, the struggle. */
export interface FailingCard {
  card: CardRecord;
  failures: readonly GateFailure[];
  /** The unexplained struggle that prompted research, when one did. */
  struggle?: string;
}

/**
 * The question about a failing card (DS-N5-1). It carries the card's whole
 * spec and the gate's actual output, so every secret in it is redacted
 * (`redactSecrets`), and it is asked only of a Researcher on this machine
 * (`AskOptions.localOnly`).
 */
export function repairQuestion(input: FailingCard, stack: string): string {
  const f = input.failures[0];
  return redactSecrets(
    researchCopy.repairQuestion({
      title: input.card.title,
      spec: input.card.spec ?? input.card.title,
      criteria: input.card.acceptanceCriteria ?? [],
      scopeFiles: input.card.scopeFiles,
      stack,
      failure: f
        ? {
            gate: `${f.gate || f.rung}${f.layer ? ` (${f.layer})` : ""}`,
            location: f.location
              ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ""}`
              : ".",
            ...(f.expected ? { expected: f.expected } : {}),
            actual: (f.actual || f.errorExcerpt).slice(0, 2000),
            ...(f.minimalRepro ? { repro: f.minimalRepro } : {}),
          }
        : { gate: "none recorded", location: ".", actual: input.struggle ?? "(no failure text)" },
      ...(input.struggle ? { struggle: input.struggle.slice(0, 2000) } : {}),
    }),
  );
}

/** A cited answer for the plan's author. */
export interface RepairResearch {
  answer: string;
  sources: string[];
}

/**
 * Research each failing card before its repair plan (DS-N5-2): one question
 * per card, at most `max`, answered grounded or not at all. `ask` records the
 * answer whole on the card's dossier (the research service does, DS-N5-3).
 */
export async function researchBeforeRepair(
  repoPath: string,
  cards: readonly FailingCard[],
  ask: (
    question: string,
    cardId: string,
  ) => Promise<{ grounded: boolean; answer: string; sources: string[] } | undefined>,
  max = 4,
): Promise<Map<string, RepairResearch>> {
  const stack = projectStack(repoPath);
  const out = new Map<string, RepairResearch>();
  for (const c of cards.slice(0, max)) {
    const r = await ask(repairQuestion(c, stack), c.card.id).catch(() => undefined);
    if (r?.grounded) out.set(c.card.id, { answer: r.answer, sources: r.sources });
  }
  return out;
}
