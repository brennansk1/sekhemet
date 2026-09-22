import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { FailureLocation, GateDefinition, GateFailure } from "./types.js";

export interface ParseContext {
  gate: GateDefinition;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Command that reproduces this run verbatim. */
  minimalRepro: string;
  /** Where the gate ran, so a parser can read a file the failure names. */
  cwd?: string;
}

export type FailureParser = (ctx: ParseContext) => GateFailure[];

const NOISE = /^(?:\s*$|>|\$ |npm |pnpm |yarn |Progress|\[\d+\/\d+\])/;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Lower sorts first: causes before symptoms, behaviour before style. */
const RUNG_SEVERITY: Record<string, number> = {
  parse: 0,
  typecheck: 1,
  test: 2,
  default: 2,
  bounds: 3,
  lint: 4,
};

/**
 * Rank failures so the agent repairs causes before symptoms.
 *
 * Failures are ordered by severity, then by how many other failures reference
 * their file: fixing the most-referenced file first typically clears the rest,
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

  // Severity first: a style nit must never push a failing test out of the
  // top three. Chronicle run 5's ledger card was shown three lint errors while
  // a real persistence test failed unseen (its protected file carries no fix
  // files, so reference weight ranked it last), and it ran out of attempts.
  const severity = (failure: GateFailure): number =>
    RUNG_SEVERITY[String(failure.rung)] ?? RUNG_SEVERITY.default ?? 2;

  return [...failures]
    .sort((a, b) => severity(a) - severity(b) || weight(b) - weight(a))
    .slice(0, limit);
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
    case "TS2352":
      return /SQLOutputValue|Record<string, unknown>/.test(message)
        ? "Database rows are untyped records. Map each row to your type field by field (`rows.map((r) => ({ id: String(r.id), seq: Number(r.seq) }))`), or cast through unknown: `stmt.all() as unknown as Row[]`."
        : "The cast is between unrelated types. Build a value of the target type explicitly, or cast through unknown only if you have checked the shape.";
    case "TS2741":
    case "TS2739":
      return "An object is missing required properties of its declared type. Add every required field listed (the code below shows the type's members), or change the type if the contract allows.";
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

/**
 * The names a TypeScript module exports, read from its source.
 *
 * Deterministic and deliberately shallow — declarations and export lists, no
 * type checker — because it only has to answer "what may I import from here".
 * Returns undefined when the file cannot be read, so the caller falls back to
 * words rather than to a wrong list.
 */
export function moduleExports(file: string): string[] | undefined {
  try {
    return exportsFromSource(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The names a TypeScript source text exports. One definition, used for a
 * file on disk and for a file's text at an earlier commit, so the two sides
 * of any comparison can never disagree about syntax.
 */
export function exportsFromSource(src: string): string[] {
  const names = new Set<string>();
  const decl =
    /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(decl)) if (m[1]) names.add(m[1]);
  for (const m of src.matchAll(/^\s*export\s*(?:type\s*)?\{([^}]*)\}/gm)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.replace(/^type\s+/, "")
        .trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** `Module '"./tokens.js"' has no exported member 'X'` -> the module's source path. */
function moduleFileFor(importer: string, message: string, cwd: string): string | undefined {
  const spec = /Module '"([^"]+)"'/.exec(message)?.[1];
  if (!spec?.startsWith(".")) return undefined;
  const base = resolve(cwd, dirname(importer), spec.replace(/\.(m|c)?js$/, ""));
  for (const ext of [".ts", ".tsx", ".mts", ".cts", "/index.ts"]) {
    if (existsSync(`${base}${ext}`)) return `${base}${ext}`;
  }
  return undefined;
}

/**
 * A missing export, answered rather than described.
 *
 * The generic remedy said "Read the module and use its actual export", and
 * the first frozen-suite run showed where that leads: a Worker read the
 * module four times, learned nothing it could act on, and was stopped for
 * repeating itself. A suggested action has to be completable in one step, so
 * this one carries what the model was being sent to fetch.
 */
function missingExportRemedy(
  code: string,
  message: string,
  importer: string,
  cwd: string | undefined,
): string | undefined {
  if ((code !== "TS2305" && code !== "TS2724") || !cwd) return undefined;
  const target = moduleFileFor(importer, message, cwd);
  const names = target ? moduleExports(target) : undefined;
  if (!target || !names) return undefined;
  const missing = /exported member '([^']+)'/.exec(message)?.[1] ?? "that name";
  const rel = relative(cwd, target);
  if (!names.length) {
    return `${rel} exports nothing yet, so ${missing} cannot be imported from it. Define ${missing} where you use it, or — if it genuinely belongs in ${rel} and that file is outside this card's scope — do not keep reading it: use note to say so, and finish.`;
  }
  return `${rel} does not export ${missing}. It exports exactly: ${names.join(", ")}. Import one of those, or define ${missing} yourself. There is no need to read ${rel} again.`;
}

/**
 * An unknown member, answered with the type's real members.
 *
 * Suite runs 4 and 5 lost cards on two different models the same way: the
 * model guessed a library API (`db.lastInsertRowId`, `{ create: true }`), the
 * error said the member does not exist, and the model went looking for the
 * declaration — Cyber-Tiel asked tool_search for it eight times — until it was
 * stopped. The failure carries what it was looking for.
 */
function unknownMemberRemedy(
  code: string,
  message: string,
  cwd: string | undefined,
): string | undefined {
  if (!cwd || !["TS2339", "TS2353", "TS2551"].includes(code)) return undefined;
  const m = /'([^']+)' does not exist (?:on|in) type '([A-Za-z_$][\w$]*)(?:<[^']*>)?'/.exec(
    message,
  );
  const member = m?.[1];
  const type = m?.[2];
  if (!member || !type) return undefined;
  const members = typeMembers(type, cwd);
  if (!members?.length) return undefined;
  return `${type} has no member ${member}. Its members are exactly: ${members.join(", ")}. Use one of those, or change the approach; there is no need to look the type up.`;
}

/** Files that may declare a type: the project's source and Node's own types. */
function declarationFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number, suffix: RegExp) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0) walk(full, depth - 1, suffix);
      } else if (suffix.test(name)) out.push(full);
    }
  };
  walk(join(cwd, "src"), 4, /\.[cm]?tsx?$/);
  // pnpm does not hoist @types/node: it lives under .pnpm/@types+node@<v>/.
  const hoisted = join(cwd, "node_modules", "@types", "node");
  let nodeTypes = existsSync(hoisted) ? hoisted : undefined;
  if (!nodeTypes) {
    try {
      const store = join(cwd, "node_modules", ".pnpm");
      const newest = readdirSync(store)
        .filter((d) => d.startsWith("@types+node@"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .pop();
      if (newest) nodeTypes = join(store, newest, "node_modules", "@types", "node");
    } catch {
      // No pnpm store: only the project's own types are searched.
    }
  }
  if (nodeTypes) walk(nodeTypes, 1, /\.d\.ts$/);
  return out;
}

/** Top-level member names of every interface, class or object type named `type`. */
function typeMembers(type: string, cwd: string): string[] | undefined {
  const decl = new RegExp(
    `\\b(?:interface|class)\\s+${type.replace(/\$/g, "\\$")}\\b[^{]*\\{|\\btype\\s+${type.replace(/\$/g, "\\$")}\\s*=\\s*\\{`,
    "g",
  );
  const names = new Set<string>();
  for (const file of declarationFiles(cwd)) {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const hit of src.matchAll(decl)) {
      let depth = 0;
      let line = "";
      for (let i = (hit.index ?? 0) + hit[0].length - 1; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        if (ch === "\n") {
          const name =
            /^\s*(?:(?:readonly|static|public|protected|abstract)\s+)*([A-Za-z_$][\w$]*)\??\s*[(:<]/.exec(
              line,
            )?.[1];
          if (name && name !== "constructor") names.add(name);
          line = "";
        } else if (depth === 1) line += ch;
      }
    }
  }
  return names.size ? [...names].sort().slice(0, 40) : undefined;
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
        missingExportRemedy(code ?? "", message ?? "", file, ctx.cwd) ??
        unknownMemberRemedy(code ?? "", message ?? "", ctx.cwd) ??
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
