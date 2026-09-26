import { factsOfText } from "@sekhemet/gates";

/**
 * Loop 10, DemoEvolve / mutants to tests (E16): mutate the code a card
 * changed, run its tests against each mutant, and turn every surviving
 * mutant into a concrete test to add (a behaviour the tests do not pin
 * down). Mutation operators work on the source index's operator tokens,
 * so strings and comments are never mutated.
 */
export interface Mutant {
  id: string;
  line: number;
  column: number;
  operator: string;
  original: string;
  replacement: string;
  source: string;
}

/** Each operator token, what a mutant swaps it for, and the operator's family, by the token's text. */
const SWAPS: Readonly<Record<string, { to: string; op: string }>> = {
  "===": { to: "!==", op: "equality" },
  "!==": { to: "===", op: "equality" },
  "<": { to: "<=", op: "boundary" },
  "<=": { to: "<", op: "boundary" },
  ">": { to: ">=", op: "boundary" },
  ">=": { to: ">", op: "boundary" },
  "+": { to: "-", op: "arithmetic" },
  "-": { to: "+", op: "arithmetic" },
  "*": { to: "/", op: "arithmetic" },
  "&&": { to: "||", op: "logical" },
  "||": { to: "&&", op: "logical" },
  true: { to: "false", op: "boolean" },
  false: { to: "true", op: "boolean" },
};

/**
 * Every single-token mutant of `source`, optionally limited to changed
 * lines (1-based), capped at `max`. The tokens are the source index's
 * operator facts (gates T2), so strings and comments are never mutated.
 */
export function generateMutants(
  source: string,
  options: { lines?: number[]; max?: number; fileName?: string } = {},
): Mutant[] {
  const lines = options.lines ? new Set(options.lines) : undefined;
  const out: Mutant[] = [];
  for (const token of factsOfText(options.fileName ?? "x.ts", source).operators) {
    if (out.length >= (options.max ?? 50)) break;
    const swap = SWAPS[token.text];
    if (!swap || (lines && !lines.has(token.line))) continue;
    out.push({
      id: `m${out.length + 1}`,
      line: token.line,
      column: token.column,
      operator: swap.op,
      original: token.text,
      replacement: swap.to,
      source: `${source.slice(0, token.start)}${swap.to}${source.slice(token.end)}`,
    });
  }
  return out;
}

export interface MutationReport {
  total: number;
  killed: number;
  survived: Mutant[];
  /** Killed over total; `null` when there was nothing to mutate (MS-M10-2), never 1. */
  score: number | null;
  /** One suggested test per surviving mutant. */
  proposals: string[];
}

/**
 * Run the tests against every mutant. `runTests` installs the mutated
 * source, runs the card's tests and restores it; true means the tests
 * passed (the mutant survived).
 */
export async function runMutationCampaign(
  file: string,
  mutants: readonly Mutant[],
  runTests: (mutatedSource: string) => Promise<boolean>,
): Promise<MutationReport> {
  const survived: Mutant[] = [];
  for (const m of mutants) if (await runTests(m.source)) survived.push(m);
  const total = mutants.length;
  return {
    total,
    killed: total - survived.length,
    survived,
    score: total ? Math.round(((total - survived.length) / total) * 1000) / 1000 : null,
    proposals: survived.map(
      (m) =>
        `Add a test that fails if ${file}:${m.line} used \`${m.replacement}\` instead of \`${m.original}\` (${m.operator} mutant survives).`,
    ),
  };
}
