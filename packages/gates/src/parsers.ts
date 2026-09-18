import type { FailureLocation, GateDefinition, GateFailure } from "./types.js";

export interface ParseContext {
  gate: GateDefinition;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Command that reproduces this run verbatim. */
  minimalRepro: string;
}

export type FailureParser = (ctx: ParseContext) => GateFailure[];

const NOISE = /^(?:\s*$|>|\$ |npm |pnpm |yarn |Progress|\[\d+\/\d+\])/;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Rank failures so the agent repairs causes before symptoms.
 *
 * Failures are grouped by file and ordered by how many other failures reference
 * that file: fixing the most-referenced file first typically clears the rest,
 * which is why the design caps a repair attempt at the top three rather than
 * handing over every error at once.
 */
export function rankFailures(failures: GateFailure[], limit = 3): GateFailure[] {
  const references = new Map<string, number>();
  for (const failure of failures) {
    for (const file of failure.suggestedFixFiles) {
      references.set(file, (references.get(file) ?? 0) + 1);
    }
  }

  const weight = (failure: GateFailure): number =>
    failure.suggestedFixFiles.reduce((max, f) => Math.max(max, references.get(f) ?? 0), 0);

  return [...failures].sort((a, b) => weight(b) - weight(a)).slice(0, limit);
}

/**
 * Concrete remedies for the diagnostics local models loop on.
 *
 * "Resolve TS18048" names the problem, not the idiom. Chronicle's verifier card
 * burned its whole repair ladder alternating between an index access that may
 * be undefined and the `!` assertion lint forbids; one sentence with the
 * narrowing pattern is the difference between a pass and repair_exhausted.
 */
const NARROW =
  "The value may be undefined (noUncheckedIndexedAccess). Narrow it before use: `const item = items[i]; if (item === undefined) continue;` or loop with `for (const item of items)` / `items.entries()`. Do not use the `!` non-null assertion: lint forbids it.";

export function remedyFor(code: string, message: string): string | undefined {
  switch (code) {
    case "TS18048":
    case "TS18047":
    case "TS2532":
    case "TS2533":
    case "lint/style/noNonNullAssertion":
      return NARROW;
    case "TS2339":
    case "TS2345":
    case "TS2322":
      return /\| undefined\b|undefined'/.test(message) ? NARROW : undefined;
    case "TS2375":
    case "TS2379":
    case "TS2412":
      return "exactOptionalPropertyTypes is on: an optional property may be absent but may not be set to undefined. Omit the property (`{ valid: false, totalEvents: n }`), or add it only when defined: `...(value !== undefined ? { key: value } : {})`.";
    case "TS2304":
      return 'The name is not in scope. Import it (`import type { Name } from "./types.js";` for a type), or define it. Read the module that declares it for the exact export name.';
    case "TS2307":
      return "The import path does not resolve. Use a relative path with a .js extension (`./types.js`) and check the file exists with list_dir.";
    case "TS2353":
    case "TS2561":
      return "That property is not part of the target type. Read the type's declaration (or the library's .d.ts) and use only the fields it declares.";
    case "TS2305":
    case "TS2724":
      return "The module does not export that name. Read the module and use its actual export.";
    case "lint/style/noUnusedTemplateLiteral":
      return "Replace the backtick string with a plain quoted string: it has no ${} interpolation.";
    case "lint/suspicious/noExplicitAny":
      return "Replace `any` with `unknown` and narrow it, or with the precise type.";
    case "lint/style/useTemplate":
      return "Replace string concatenation with a template literal.";
    default:
      return undefined;
  }
}

/** `src/a.ts(12,5): error TS2345: message` */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

const tscParser: FailureParser = (ctx) => {
  const failures: GateFailure[] = [];
  const lines = `${ctx.stdout}\n${ctx.stderr}`.split("\n");

  for (const line of lines) {
    const m = TSC_LINE.exec(line.trim());
    if (!m) continue;
    const [, file, lineNo, col, code, message] = m;
    if (!file) continue;

    const location: FailureLocation = {
      file,
      line: Number.parseInt(lineNo ?? "0", 10),
      column: Number.parseInt(col ?? "0", 10),
    };

    failures.push({
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: `${file}:${location.line}:${location.column} ${code}: ${message}`,
      suggestedFixFiles: [file],
      location,
      expected: "type-correct program",
      actual: `${code}: ${message}`,
      minimalRepro: ctx.minimalRepro,
      suggestedAction:
        remedyFor(code ?? "", message ?? "") ??
        `Resolve ${code} at ${file}:${location.line}. Read the surrounding lines before editing.`,
    });
  }

  return failures;
};

/** Vitest failures: a `FAIL`/`×` header plus the assertion detail beneath it. */
const vitestParser: FailureParser = (ctx) => {
  const combined = `${ctx.stdout}\n${ctx.stderr}`;
  const lines = combined.split("\n");
  const failures: GateFailure[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    const failMatch = /^(?:FAIL|×|✕)\s+(.+?)(?:\s+>\s+(.*))?$/.exec(line);
    if (!failMatch) continue;

    const rawTarget = failMatch[1] ?? "";
    const testName = failMatch[2];
    const file = rawTarget.split(" ")[0] ?? rawTarget;

    // The assertion detail follows the header; capture the informative part.
    const detail: string[] = [];
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      const next = (lines[j] as string).trim();
      if (/^(?:FAIL|×|✕|PASS|✓)\s/.test(next)) break;
      if (next && !NOISE.test(next)) detail.push(next);
      if (detail.length >= 6) break;
    }

    const expected = detail.find((d) => d.startsWith("Expected"))?.replace(/^Expected:?\s*/, "");
    const actual = detail.find((d) => d.startsWith("Received"))?.replace(/^Received:?\s*/, "");

    failures.push({
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: [line, ...detail].join("\n"),
      suggestedFixFiles: dedupe([file].filter((f) => /\.[cm]?[jt]sx?$/.test(f))),
      ...(file ? { location: { file } } : {}),
      ...(expected ? { expected } : {}),
      ...(actual ? { actual } : {}),
      minimalRepro: testName
        ? `${ctx.minimalRepro} -t ${JSON.stringify(testName)}`
        : ctx.minimalRepro,
      suggestedAction:
        "Make the implementation satisfy this assertion. Do not modify the test — assertions are immutable to the implementer role.",
    });
  }

  return failures;
};

/** Biome diagnostics: `path/file.ts:12:5 lint/rule ... × message` */
const biomeParser: FailureParser = (ctx) => {
  const combined = `${ctx.stdout}\n${ctx.stderr}`;
  const failures: GateFailure[] = [];
  const header = /^(.+?):(\d+):(\d+)\s+(\S+)/;
  const lines = combined.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const m = header.exec((lines[i] as string).trim());
    if (!m) continue;
    const [, file, lineNo, col, rule] = m;
    if (!file) continue;

    const message: string =
      lines
        .slice(i + 1, i + 5)
        .map((l) => l.trim())
        .find((l) => l.startsWith("×"))
        ?.replace(/^×\s*/, "") ??
      rule ??
      "lint violation";

    failures.push({
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: `${file}:${lineNo}:${col} ${rule}: ${message}`,
      suggestedFixFiles: [file],
      location: {
        file,
        line: Number.parseInt(lineNo ?? "0", 10),
        column: Number.parseInt(col ?? "0", 10),
      },
      expected: `no ${rule} violations`,
      actual: message,
      minimalRepro: ctx.minimalRepro,
      suggestedAction: remedyFor(rule ?? "", message) ?? `Fix ${rule} at ${file}:${lineNo}.`,
    });
  }

  return failures;
};

/** Fallback for tools without a dedicated parser. */
const genericParser: FailureParser = (ctx) => {
  const combined = `${ctx.stderr}\n${ctx.stdout}`;
  const lines = combined.split("\n").map((l) => l.trim());

  const signal = lines.filter(
    (l) => l && !NOISE.test(l) && /error|failed|failure|cannot|unexpected|✕|×/i.test(l),
  );

  const fileRe = /([\w./-]+\.(?:ts|tsx|js|jsx|mts|cts|json|py|rs|go))/g;
  const files = new Set<string>();
  for (const line of signal) {
    let m: RegExpExecArray | null = fileRe.exec(line);
    while (m !== null) {
      const path = m[1];
      if (path && !path.includes("node_modules") && !path.includes("dist/")) files.add(path);
      m = fileRe.exec(line);
    }
  }

  const excerpt = (signal.length > 0 ? signal : lines.filter(Boolean)).slice(0, 8).join("\n");

  return [
    {
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: excerpt || `Gate ${ctx.gate.id} failed with exit code ${ctx.exitCode}`,
      suggestedFixFiles: [...files],
      expected: `${ctx.gate.id} to exit 0`,
      actual: `exit code ${ctx.exitCode}`,
      minimalRepro: ctx.minimalRepro,
      suggestedAction: `Re-run \`${ctx.minimalRepro}\` after addressing the output above.`,
    },
  ];
};

/**
 * Registry mapping a gate's declared `parser` to its implementation.
 *
 * A per-tool parser is what turns a wall of log output into a typed failure the
 * agent can act on; one generic regex for every tool produces excerpts that
 * name no location and suggest no action.
 */
export class FailureParserRegistry {
  private parsers = new Map<string, FailureParser>([
    ["tsc", tscParser],
    ["typescript", tscParser],
    ["vitest", vitestParser],
    ["jest", vitestParser],
    ["biome", biomeParser],
    ["eslint", biomeParser],
    ["generic", genericParser],
  ]);

  public register(name: string, parser: FailureParser): void {
    this.parsers.set(name, parser);
  }

  public parse(ctx: ParseContext): GateFailure[] {
    const parser = this.parsers.get(ctx.gate.parser) ?? genericParser;
    const failures = parser(ctx);
    // A parser that matched nothing must still report the failure.
    return failures.length > 0 ? failures : genericParser(ctx);
  }
}

export const defaultParserRegistry = new FailureParserRegistry();
