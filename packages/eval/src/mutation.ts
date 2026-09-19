import ts from "typescript";

/**
 * Loop 10, DemoEvolve / mutants to tests (E16): mutate the code a card
 * changed, run its tests against each mutant, and turn every surviving
 * mutant into a concrete test to add (a behaviour the tests do not pin
 * down). Mutation operators work on TypeScript/JavaScript tokens from the
 * compiler's scanner, so strings and comments are never mutated.
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

const SWAPS: Record<number, { to: string; op: string }> = {
  [ts.SyntaxKind.EqualsEqualsEqualsToken]: { to: "!==", op: "equality" },
  [ts.SyntaxKind.ExclamationEqualsEqualsToken]: { to: "===", op: "equality" },
  [ts.SyntaxKind.LessThanToken]: { to: "<=", op: "boundary" },
  [ts.SyntaxKind.LessThanEqualsToken]: { to: "<", op: "boundary" },
  [ts.SyntaxKind.GreaterThanToken]: { to: ">=", op: "boundary" },
  [ts.SyntaxKind.GreaterThanEqualsToken]: { to: ">", op: "boundary" },
  [ts.SyntaxKind.PlusToken]: { to: "-", op: "arithmetic" },
  [ts.SyntaxKind.MinusToken]: { to: "+", op: "arithmetic" },
  [ts.SyntaxKind.AsteriskToken]: { to: "/", op: "arithmetic" },
  [ts.SyntaxKind.AmpersandAmpersandToken]: { to: "||", op: "logical" },
  [ts.SyntaxKind.BarBarToken]: { to: "&&", op: "logical" },
  [ts.SyntaxKind.TrueKeyword]: { to: "false", op: "boolean" },
  [ts.SyntaxKind.FalseKeyword]: { to: "true", op: "boolean" },
};

/**
 * Every single-token mutant of `source`, optionally limited to changed
 * lines (1-based), capped at `max`.
 */
export function generateMutants(
  source: string,
  options: { lines?: number[]; max?: number; fileName?: string } = {},
): Mutant[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source,
  );
  const sf = ts.createSourceFile(options.fileName ?? "x.ts", source, ts.ScriptTarget.Latest, false);
  const lines = options.lines ? new Set(options.lines) : undefined;
  const out: Mutant[] = [];
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken && out.length < (options.max ?? 50)) {
    const swap = SWAPS[kind];
    if (swap) {
      const start = scanner.getTokenStart();
      const end = scanner.getTokenEnd();
      const pos = sf.getLineAndCharacterOfPosition(start);
      if (!lines || lines.has(pos.line + 1)) {
        out.push({
          id: `m${out.length + 1}`,
          line: pos.line + 1,
          column: pos.character + 1,
          operator: swap.op,
          original: source.slice(start, end),
          replacement: swap.to,
          source: `${source.slice(0, start)}${swap.to}${source.slice(end)}`,
        });
      }
    }
    kind = scanner.scan();
  }
  return out;
}

export interface MutationReport {
  total: number;
  killed: number;
  survived: Mutant[];
  score: number;
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
    score: total ? Math.round(((total - survived.length) / total) * 1000) / 1000 : 1,
    proposals: survived.map(
      (m) =>
        `Add a test that fails if ${file}:${m.line} used \`${m.replacement}\` instead of \`${m.original}\` (${m.operator} mutant survives).`,
    ),
  };
}
