import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { CardInterfaceSymbol } from "@sekhemet/kernel";
import type { ExampleRow } from "./criteria.js";

/**
 * Staged acceptance tests (planner-pm §2.1.5-8; PM-P1-15, PM-P1-17,
 * PM-P1-19): a behaviour criterion with concrete values is written as an
 * example table — one row per example, under a title carrying the
 * criterion's id — in the project's own test framework and test folder; the
 * interface the card carries is read back from the test's imports.
 */

export type TestFramework = "vitest" | "jest" | "node";

/** The project's test framework, from its package.json; Vitest when it names none. */
export function detectTestFramework(repoRoot?: string): TestFramework {
  if (!repoRoot) return "vitest";
  const p = join(repoRoot, "package.json");
  if (!existsSync(p)) return "vitest";
  try {
    const pkg = JSON.parse(readFileSync(p, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ("vitest" in deps) return "vitest";
    if ("jest" in deps || "ts-jest" in deps) return "jest";
    if (/\bnode\s+--test\b/.test(pkg.scripts?.test ?? "")) return "node";
  } catch {
    return "vitest";
  }
  return "vitest";
}

/** One criterion's cases: its id, its text and its example rows. */
export interface StagedCriterion {
  criterionId: string;
  criterion: string;
  rows: ExampleRow[];
}

export interface RenderedTest {
  source: string;
  /** One case per row, each naming the criterion it proves (`test/staged`). */
  cases: { name: string; criterionId: string }[];
}

/** The import specifier from a test file to a source file (`.ts` imported as `.js`). */
function importPath(testPath: string, file: string): string {
  let rel = posix.relative(posix.dirname(testPath), file).replace(/\.tsx?$/, ".js");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

function tsType(v: unknown): string {
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "unknown";
}

/** The call the rows make, as a signature: `refundInvoice(number, number) → number`. */
export function signatureFromRows(symbol: string, rows: readonly ExampleRow[]): string {
  const first = rows[0];
  if (!first) return `${symbol}()`;
  return `${symbol}(${first.args.map(tsType).join(", ")}) → ${tsType(first.expected)}`;
}

/**
 * Render the staged test: for each criterion, `it.each` over its rows
 * (Vitest and Jest), or a loop of `test` calls (`node:test`), each title
 * starting with the criterion id so the source index can trace it.
 */
export function renderExampleTest(input: {
  framework: TestFramework;
  testPath: string;
  title: string;
  symbol: CardInterfaceSymbol;
  cases: StagedCriterion[];
}): RenderedTest {
  const { framework, symbol } = input;
  const lines: string[] = [];
  if (framework === "vitest") lines.push('import { describe, expect, it } from "vitest";');
  if (framework === "node") {
    lines.push(
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
    );
  }
  lines.push(`import { ${symbol.symbol} } from "${importPath(input.testPath, symbol.file)}";`);
  lines.push("");
  lines.push(
    "// Staged by the planner: each table proves the acceptance criterion its title names.",
  );
  lines.push(`describe(${JSON.stringify(input.title)}, () => {`);
  const cases: RenderedTest["cases"] = [];
  for (const c of input.cases) {
    if (c.rows.length === 0) continue;
    const first = c.rows[0] as ExampleRow;
    const rowType = `{ args: [${first.args.map(tsType).join(", ")}]; expected: ${tsType(first.expected)} }`;
    const rows = c.rows.map(
      (r) =>
        `    { args: [${r.args.map((a) => JSON.stringify(a)).join(", ")}], expected: ${JSON.stringify(r.expected)} },`,
    );
    const title = `${c.criterionId}: ${c.criterion.replace(/\s+/g, " ").trim()}`;
    c.rows.forEach((_, i) => {
      cases.push({ name: `${title} [example ${i + 1}]`, criterionId: c.criterionId });
    });
    if (framework === "node") {
      lines.push(`  const rows: ${rowType}[] = [`, ...rows, "  ];");
      lines.push("  for (const [i, { args, expected }] of rows.entries()) {");
      lines.push(
        `    it(\`${title.replace(/[`$\\]/g, "\\$&")} [example \${i + 1}]\`, async () => {`,
      );
      lines.push(`      assert.deepEqual(await ${symbol.symbol}(...args), expected);`);
      lines.push("    });", "  }");
      continue;
    }
    lines.push(`  it.each<${rowType}>([`, ...rows, "  ])(");
    lines.push(`    ${JSON.stringify(`${title} ($args → $expected)`)},`);
    lines.push("    async ({ args, expected }) => {");
    lines.push(`      expect(await ${symbol.symbol}(...args)).toEqual(expected);`);
    lines.push("    },", "  );");
  }
  lines.push("});", "");
  return { source: lines.join("\n"), cases };
}

/** The text between the parenthesis at `open` and its match. */
function balanced(source: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return undefined;
}

/**
 * The interface a staged test expects (PM-P1-15): each name it imports from
 * a file of the repository, the file it comes from (a `.js` specifier read
 * as the `.ts` source), and its signature as the test first calls it.
 */
export function interfaceFromTest(source: string, testPath: string): CardInterfaceSymbol[] {
  const out: CardInterfaceSymbol[] = [];
  const imports = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  const body = source.replace(imports, "");
  for (const m of source.matchAll(imports)) {
    const spec = m[2] as string;
    if (!spec.startsWith(".")) continue;
    let file = posix.normalize(posix.join(posix.dirname(testPath), spec));
    file = /\.[cm]?js$/.test(file) ? file.replace(/\.([cm]?)js$/, ".$1ts") : `${file}.ts`;
    for (const raw of (m[1] as string).split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (!name) continue;
      const [symbol, local] = name.split(/\s+as\s+/).map((s) => s.trim()) as [string, string?];
      const call = new RegExp(`\\b${local ?? symbol}\\s*\\(`).exec(body);
      const args = call ? balanced(body, call.index + call[0].length - 1) : undefined;
      out.push({
        symbol,
        file,
        signature: args !== undefined ? `${symbol}(${args.replace(/\s+/g, " ").trim()})` : "",
      });
    }
  }
  return out;
}
