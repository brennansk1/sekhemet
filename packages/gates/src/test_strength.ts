import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { CardChange } from "@sekhemet/kernel";
import type { ProcessSandbox } from "@sekhemet/sandbox";
import { gitEnvFor } from "@sekhemet/sync";
import ts from "typescript";
import { scanHalfDone } from "./half_done.js";
import { type JUnitCase, parseJUnit } from "./junit.js";
import { redGreenRule } from "./red_green.js";
import type { GateDefinition } from "./types.js";

/**
 * Tests that can fail, checked before the Worker starts (gates rules 6, 6a,
 * 32a; NEW-gates-6).
 *
 * - **Red at an assertion** (GT-TQ-1): the acceptance tests run against a
 *   stub of the card's declared interface — every export they import from
 *   project code that does not exist yet, present and throwing "not
 *   implemented" — and the card is red only if every test fails at an
 *   assertion or at the stub. A failure at import, collection or setup, or a
 *   runtime error of the test's own, is `tests_not_red_for_reason`.
 * - **Stub-kill** (GT-TQ-2): the same tests run against trivial
 *   implementations of those exports; a set that one of them passes cannot
 *   tell a real implementation from a trivial one.
 * - **The test-smell lint and `requireAssertions`** (GT-TQ-6).
 * - **The depth profile** (GT-TQ-12): until the project's own profile exists
 *   (P14), every project is *internal tool*, and a test gap that is only
 *   advisory goes to a person, never to the Worker.
 *
 * Until the source index exists (T2), the declared interface is read from
 * the acceptance tests' own imports with the TypeScript parser, here.
 */

// --- The depth profile (rule 32a) --------------------------------------------

export type DepthProfile = "prototype" | "internal tool" | "production" | "regulated";
export type StrengthLevel = "blocking" | "advisory" | "off";

/** Rule 32a's table, for the checks this module runs. */
export const STRENGTH_TABLE: Readonly<
  Record<
    DepthProfile,
    { smellLint: StrengthLevel; redAtAssertion: StrengthLevel; stubKill: StrengthLevel }
  >
> = {
  prototype: { smellLint: "advisory", redAtAssertion: "blocking", stubKill: "advisory" },
  "internal tool": { smellLint: "blocking", redAtAssertion: "blocking", stubKill: "blocking" },
  production: { smellLint: "blocking", redAtAssertion: "blocking", stubKill: "blocking" },
  regulated: { smellLint: "blocking", redAtAssertion: "blocking", stubKill: "blocking" },
};

/** The profile before P14 exists (rule 32a; confirmation review N7d). */
export const DEFAULT_DEPTH_PROFILE: DepthProfile = "internal tool";

// --- Parsing ----------------------------------------------------------------

const CODE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function isCode(file: string): boolean {
  return CODE_EXT.includes(extname(file).toLowerCase());
}

function parse(path: string): ts.SourceFile {
  const text = readFileSync(path, "utf8");
  const ext = extname(path).toLowerCase();
  const kind =
    ext === ".tsx"
      ? ts.ScriptKind.TSX
      : ext === ".jsx"
        ? ts.ScriptKind.JSX
        : [".js", ".mjs", ".cjs"].includes(ext)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
}

/** A test file, or a module under a test-support directory: never the interface. */
const TEST_SUPPORT =
  /(^|\/)(tests?|__tests__|__mocks__|fixtures?|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a relative specifier in `from` resolves inside `root`: an existing
 * file, or the file the card will create (a `.js` specifier in a TypeScript
 * project names a `.ts` file). Undefined outside the root.
 */
function resolveRelative(
  root: string,
  from: string,
  spec: string,
): { file: string; exists: boolean } | undefined {
  const rel = relative(root, normalize(join(root, dirname(from), spec)))
    .split(sep)
    .join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const ext = extname(rel).toLowerCase();
  const candidates: string[] = [];
  if (CODE_EXT.includes(ext)) {
    candidates.push(rel);
    const stem = rel.slice(0, -ext.length);
    for (const e of JS_TO_TS[ext] ?? []) candidates.push(stem + e);
  } else {
    for (const e of CODE_EXT) candidates.push(rel + e);
    for (const e of CODE_EXT) candidates.push(`${rel}/index${e}`);
  }
  const found = candidates.find((c) => isFile(join(root, c)));
  if (found) return { file: found, exists: true };
  const typescript =
    existsSync(join(root, "tsconfig.json")) || /\.[cm]?tsx?$/.test(from.toLowerCase());
  const planned =
    typescript && JS_TO_TS[ext]
      ? rel.slice(0, -ext.length) + (JS_TO_TS[ext]?.[0] ?? ".ts")
      : CODE_EXT.includes(ext)
        ? rel
        : rel + (typescript ? ".ts" : ".js");
  return { file: planned, exists: false };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/**
 * The names a module exports, types included; `unknown` when they cannot be
 * listed (CommonJS, `export =`, or `export *` from a package), and then no
 * name is treated as missing.
 */
function moduleExports(
  root: string,
  file: string,
  depth = 0,
): { names: Set<string>; unknown: boolean } {
  const names = new Set<string>();
  const path = join(root, file);
  if (!isFile(path) || depth > 5) return { names, unknown: true };
  const sf = parse(path);
  if (/\bmodule\.exports\b|(^|[^\w$.])exports\.[\w$]+\s*=/.test(sf.text)) {
    return { names, unknown: true };
  }
  let unknown = false;
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) unknown = true;
      else names.add("default");
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      const clause = st.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) names.add(el.name.text);
      } else if (clause && ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const spec = st.moduleSpecifier.text;
        const target = spec.startsWith(".") ? resolveRelative(root, file, spec) : undefined;
        if (!target?.exists) {
          unknown = true;
          continue;
        }
        const inner = moduleExports(root, target.file, depth + 1);
        if (inner.unknown) unknown = true;
        for (const n of inner.names) if (n !== "default") names.add(n);
      }
      continue;
    }
    if (!hasModifier(st, ts.SyntaxKind.ExportKeyword)) continue;
    if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) {
      names.add("default");
      continue;
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) bindingNames(d.name, names);
    } else if (
      (ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isTypeAliasDeclaration(st) ||
        ts.isEnumDeclaration(st) ||
        ts.isModuleDeclaration(st)) &&
      st.name &&
      ts.isIdentifier(st.name)
    ) {
      names.add(st.name.text);
    }
  }
  return { names, unknown };
}

/** One module of the card's declared interface, as the acceptance tests import it. */
export interface InterfaceModule {
  /** Repository-relative: the existing file, or the one the card will create. */
  file: string;
  exists: boolean;
  /** Every runtime name the tests import from it (`default` for a default import). */
  names: string[];
  /** The names it does not export yet: what the stub supplies and the card adds. */
  missing: string[];
  /** The acceptance tests that import it. */
  importedBy: string[];
}

/** Names reached as `ns.name` through a namespace import. */
function namespaceMembers(sf: ts.SourceFile, ns: string): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === ns
    ) {
      out.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The project-code imports of one test file: module → names, plus the local bindings. */
function codeImports(
  root: string,
  test: string,
): {
  modules: Map<string, { exists: boolean; names: Set<string> }>;
  locals: Set<string>;
  namespaces: Set<string>;
} {
  const modules = new Map<string, { exists: boolean; names: Set<string> }>();
  const locals = new Set<string>();
  const namespaces = new Set<string>();
  const path = join(root, test);
  if (!isCode(test) || !isFile(path)) return { modules, locals, namespaces };
  const sf = parse(path);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const clause = st.importClause;
    if (clause?.isTypeOnly) continue;
    const target = resolveRelative(root, test, spec);
    if (!target || TEST_SUPPORT.test(target.file)) continue;
    const entry = modules.get(target.file) ?? { exists: target.exists, names: new Set<string>() };
    modules.set(target.file, entry);
    if (!clause) continue;
    if (clause.name) {
      entry.names.add("default");
      locals.add(clause.name.text);
    }
    const nb = clause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        entry.names.add((el.propertyName ?? el.name).text);
        locals.add(el.name.text);
      }
    } else if (nb && ts.isNamespaceImport(nb)) {
      namespaces.add(nb.name.text);
      for (const m of namespaceMembers(sf, nb.name.text)) entry.names.add(m);
    }
  }
  return { modules, locals, namespaces };
}

/**
 * The card's declared interface: what its acceptance tests import from
 * project code (relative imports outside test-support directories), with the
 * names that code does not export yet (GT-TQ-1).
 */
export function declaredInterface(root: string, tests: readonly string[]): InterfaceModule[] {
  const byFile = new Map<string, { exists: boolean; names: Set<string>; importedBy: string[] }>();
  for (const test of tests) {
    for (const [file, m] of codeImports(root, test).modules) {
      const entry = byFile.get(file) ?? {
        exists: m.exists,
        names: new Set<string>(),
        importedBy: [],
      };
      for (const n of m.names) entry.names.add(n);
      entry.importedBy.push(test);
      byFile.set(file, entry);
    }
  }
  return [...byFile.entries()]
    .map(([file, e]) => {
      const names = [...e.names].sort();
      const exported = e.exists
        ? moduleExports(root, file)
        : { names: new Set<string>(), unknown: false };
      const missing = exported.unknown ? [] : names.filter((n) => !exported.names.has(n));
      return { file, exists: e.exists, names, missing, importedBy: e.importedBy };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

// --- Stand-ins ----------------------------------------------------------------

/** The trivial implementations stub-kill runs the tests against (rule 6a), in order. */
export const STAND_INS = [
  "returns undefined",
  "returns 0",
  'returns ""',
  "returns false",
  "returns []",
  "returns {}",
  "returns its first argument",
] as const;
export type StandIn = "not-implemented" | (typeof STAND_INS)[number];

const STAND_IN_BODY: Record<Exclude<StandIn, "not-implemented">, string> = {
  "returns undefined": "return undefined;",
  "returns 0": "return 0;",
  'returns ""': 'return "";',
  "returns false": "return false;",
  "returns []": "return [];",
  "returns {}": "return {};",
  "returns its first argument": "return args[0];",
};

/** What the interface stub throws; a failure carrying it reached the declared interface. */
export const NOT_IMPLEMENTED = "sekhemet: not implemented";

/**
 * The stub throws on any use — a call, `new`, or reading a member — so a test
 * that uses a declared class's static member fails at the stub, not with a
 * TypeError of its own.
 */
const STUB_FACTORY = `const __sekhemetStub = (name) => new Proxy(function () {}, {
  apply() { throw new Error("${NOT_IMPLEMENTED}: " + name); },
  construct() { throw new Error("${NOT_IMPLEMENTED}: " + name); },
  get(_t, p) {
    if (typeof p === "symbol" || p === "then" || p === "prototype" || p === "toJSON") return undefined;
    throw new Error("${NOT_IMPLEMENTED}: " + name + "." + String(p));
  },
});`;

function standInSource(names: readonly string[], standIn: StandIn): string {
  const lines: string[] = [
    "",
    "// Sekhemet: a stand-in for the card's declared interface, removed before any work.",
  ];
  if (standIn === "not-implemented") {
    lines.push(STUB_FACTORY);
    for (const n of names) {
      lines.push(
        n === "default"
          ? `export default __sekhemetStub("default");`
          : `export const ${n} = __sekhemetStub(${JSON.stringify(n)});`,
      );
    }
  } else {
    const body = STAND_IN_BODY[standIn];
    for (const n of names) {
      lines.push(
        n === "default"
          ? `export default function (...args) { ${body} }`
          : `export function ${n}(...args) { ${body} }`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write the stand-in for every missing name of the interface into the tree,
 * and return the function that restores the tree exactly: appended files to
 * their bytes, created files and directories removed.
 */
export function stageStandIn(
  root: string,
  modules: readonly InterfaceModule[],
  standIn: StandIn,
): () => void {
  const originals = new Map<string, Buffer>();
  const created: string[] = [];
  const createdDirs: string[] = [];
  const restore = () => {
    for (const [path, bytes] of originals) writeFileSync(path, bytes);
    for (const path of created) rmSync(path, { force: true });
    for (const dir of createdDirs.reverse()) {
      try {
        if (readdirSync(dir).length === 0) rmdirSync(dir);
      } catch {
        // Already gone.
      }
    }
  };
  try {
    for (const m of modules) {
      const path = join(root, m.file);
      if (m.exists) {
        if (m.missing.length === 0) continue;
        const bytes = readFileSync(path);
        originals.set(path, bytes);
        const text = bytes.toString("utf8");
        writeFileSync(
          path,
          `${text}${text.endsWith("\n") ? "" : "\n"}${standInSource(m.missing, standIn)}`,
        );
      } else {
        // Record each directory this creates, outermost first.
        const missingDirs: string[] = [];
        for (let d = dirname(path); !existsSync(d) && d.startsWith(root); d = dirname(d)) {
          missingDirs.unshift(d);
        }
        mkdirSync(dirname(path), { recursive: true });
        createdDirs.push(...missingDirs);
        created.push(path);
        writeFileSync(
          path,
          m.missing.length > 0 ? standInSource(m.missing, standIn) : "export {};\n",
        );
      }
    }
  } catch (err) {
    restore();
    throw err;
  }
  return restore;
}

// --- The acceptance run --------------------------------------------------------

/** How one acceptance test ended, judged from its own result (rule 6). */
export type AcceptanceKind =
  /** Failed at an assertion: red for the right reason. */
  | "assertion"
  /** Failed at the interface stub: it reached the declared interface. */
  | "not_implemented"
  | "passed"
  /** The file could not be imported or collected. */
  | "import"
  /** A setup hook failed before the test ran. */
  | "setup"
  /** A runtime error of the test's own, not at an assertion. */
  | "error"
  /** It executed no assertion (`requireAssertions`). */
  | "no_assertion"
  | "skipped"
  /** The runner reported nothing for the file. */
  | "missing";

export interface AcceptanceTestResult {
  /** `file > test name`, or the file alone for a file-level failure. */
  test: string;
  file: string;
  kind: AcceptanceKind;
  message?: string;
}

export type AcceptanceRun =
  | { results: AcceptanceTestResult[]; requireAssertions: boolean; command: string }
  | { unavailable: string };

const NO_ASSERTION =
  /expected (?:any number of|at least one|\d+) assertions?,? but (?:got|received) (?:none|\d+)/i;
const IMPORT_ERROR =
  /Cannot find module|Failed to load url|ERR_MODULE_NOT_FOUND|does not provide an export|is not exported by|SyntaxError|Failed to resolve import|Transform failed|ModuleNotFoundError|ImportError|collection failure/i;

function brief(text: string | undefined): string | undefined {
  const line = text
    ?.split("\n")
    .find((l) => l.trim())
    ?.trim();
  return line ? line.slice(0, 300) : undefined;
}

function caseKind(c: JUnitCase): AcceptanceKind {
  const msg = `${c.message ?? ""}\n${c.text ?? ""}`;
  if (c.status === "passed") return "passed";
  if (c.status === "skipped") return "skipped";
  if (msg.includes(NOT_IMPLEMENTED)) return "not_implemented";
  if (NO_ASSERTION.test(msg)) return "no_assertion";
  if (c.status === "error") return IMPORT_ERROR.test(msg) ? "import" : "setup";
  if (/assert/i.test(c.type ?? "") || /^\s*(AssertionError\b|assert\s)/m.test(msg)) {
    return "assertion";
  }
  return "error";
}

/** Does a report case belong to acceptance test `file`? */
function belongs(c: JUnitCase, file: string): boolean {
  if (c.file === file || c.classname === file || c.file.endsWith(`/${file}`)) return true;
  // pytest: `tests.test_a` or `tests.test_a.TestX` for tests/test_a.py.
  const dotted = file.replace(/\.py$/, "").split("/").join(".");
  return c.classname === dotted || c.classname.startsWith(`${dotted}.`);
}

/** Each acceptance test's own result, from the report's cases (rule 6). */
export function classifyCases(
  cases: readonly JUnitCase[],
  tests: readonly string[],
): AcceptanceTestResult[] {
  const out: AcceptanceTestResult[] = [];
  for (const file of tests) {
    const own = cases.filter((c) => belongs(c, file));
    const level = own.filter(
      (c) => c.fileLevel && (c.status === "failure" || c.status === "error"),
    );
    const cases_ = own.filter((c) => !c.fileLevel);
    const levelMsg = level.map((c) => `${c.message ?? ""}\n${c.text ?? ""}`).join("\n");
    const levelKind: AcceptanceKind | undefined =
      level.length === 0
        ? undefined
        : levelMsg.includes(NOT_IMPLEMENTED)
          ? "not_implemented"
          : IMPORT_ERROR.test(levelMsg)
            ? "import"
            : "setup";
    const levelMessage = brief(level[0]?.message ?? level[0]?.text);
    if (cases_.length === 0) {
      out.push({
        test: file,
        file,
        kind: levelKind ?? "missing",
        ...(levelMessage ? { message: levelMessage } : { message: "no test in this file ran" }),
      });
      continue;
    }
    for (const c of cases_) {
      const kind = c.status === "skipped" && levelKind ? levelKind : caseKind(c);
      const message =
        c.status === "skipped" && levelKind ? levelMessage : brief(c.message ?? c.text);
      out.push({ test: `${file} > ${c.name}`, file, kind, ...(message ? { message } : {}) });
    }
  }
  return out;
}

function mentions(argv: readonly string[], tool: string): boolean {
  return argv.some((a) => new RegExp(`(^|[/\\\\])${tool}(\\.m?js)?$|^${tool}\\b`).test(a));
}

/**
 * The test gate's command narrowed to the acceptance tests and writing a
 * JUnit report: Vitest (`--reporter=junit`, and `--expect.requireAssertions`
 * when asked) and pytest (`--junitxml`). `bail` stops at the first failing
 * test: a stub-kill run needs only to know whether every test passed, and a
 * stand-in that leaves a server waiting would otherwise cost every test's
 * timeout (a frozen-suite card took six minutes without it). Undefined for a
 * runner with no such path here.
 */
export function acceptanceCommand(
  gate: GateDefinition,
  tests: readonly string[],
  reportPath: string,
  requireAssertions: boolean,
  bail = false,
): { command: string; args: string[]; requireAssertions: boolean } | undefined {
  const argv = [gate.command, ...gate.args];
  // `npm test` passes arguments on only after `--`.
  const sep = gate.command === "npm" && !gate.args.includes("--") ? ["--"] : [];
  if (gate.parser === "vitest" || mentions(argv, "vitest")) {
    return {
      command: gate.command,
      args: [
        ...gate.args,
        ...sep,
        ...tests,
        "--reporter=junit",
        `--outputFile=${reportPath}`,
        ...(requireAssertions ? ["--expect.requireAssertions"] : []),
        ...(bail ? ["--bail=1"] : []),
      ],
      requireAssertions,
    };
  }
  if (gate.parser === "pytest" || mentions(argv, "pytest")) {
    return {
      command: gate.command,
      args: [...gate.args, ...sep, ...tests, `--junitxml=${reportPath}`, ...(bail ? ["-x"] : [])],
      requireAssertions: false,
    };
  }
  return undefined;
}

/** The harness's scratch directory for reports, inside the worktree (the sandbox writes only there). */
const REPORT_DIR = ".sekhemet-strength";
let reportSeq = 0;

/**
 * Run the acceptance tests alone through the project's test gate, confined
 * with no network, and read each test's own result from the JUnit report.
 * When the runner rejects `requireAssertions` (an older Vitest), it runs once
 * more without it and says so. The report directory is removed afterwards.
 */
export async function runAcceptanceTests(
  sandbox: ProcessSandbox,
  root: string,
  gate: GateDefinition,
  tests: readonly string[],
  options: { bail?: boolean } = {},
): Promise<AcceptanceRun> {
  const dir = join(root, REPORT_DIR);
  mkdirSync(dir, { recursive: true });
  try {
    for (const want of [true, false]) {
      const report = join(dir, `run-${process.pid}-${++reportSeq}.xml`);
      const cmd = acceptanceCommand(gate, tests, report, want, options.bail === true);
      if (!cmd) {
        return {
          unavailable: `the test gate ${gate.id} (parser ${gate.parser}) has no JUnit path here: red at an assertion is judged for Vitest and pytest`,
        };
      }
      const shown = [cmd.command, ...cmd.args].join(" ");
      let r: Awaited<ReturnType<ProcessSandbox["execute"]>>;
      try {
        r = await sandbox.execute(cmd.command, cmd.args, {
          allowedPaths: [root],
          allowNetwork: false,
          timeoutMs: gate.timeoutMs,
          cwd: root,
          // As CI: a runner writes no new snapshot, so a stand-in cannot
          // pass by recording its own output as the expected value.
          env: { CI: "1" },
        });
      } catch (err) {
        return { unavailable: `${shown} could not run: ${brief(String(err)) ?? "it threw"}` };
      }
      if (r.notStarted) return { unavailable: `${gate.command} did not start` };
      if (r.timedOut) return { unavailable: `${shown} timed out after ${gate.timeoutMs}ms` };
      if (isFile(report)) {
        let cases: JUnitCase[];
        try {
          cases = parseJUnit(readFileSync(report, "utf8"));
        } catch (err) {
          return { unavailable: `the JUnit report could not be read: ${brief(String(err))}` };
        }
        return {
          results: classifyCases(cases, tests),
          requireAssertions: cmd.requireAssertions,
          command: shown,
        };
      }
      if (!cmd.requireAssertions) {
        return {
          unavailable: `${shown} wrote no JUnit report (exit ${r.exitCode}): ${brief(r.stderr) ?? brief(r.stdout) ?? "no output"}`,
        };
      }
    }
    return { unavailable: "the runner wrote no JUnit report" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- The test-smell lint (GT-TQ-6) ---------------------------------------------

export type SmellKind =
  | "no_assertion"
  | "computed_expected"
  | "constant_assertion"
  | "assertion_in_catch"
  | "unreachable_assertion"
  | "skipped"
  | "focused"
  | "todo";

export interface TestSmell {
  file: string;
  line: number;
  /** The test's title, or the file for a finding outside any test. */
  test: string;
  smell: SmellKind;
  detail: string;
}

const SMELL_TEXT: Record<SmellKind, string> = {
  no_assertion: "has no assertion, so it passes whatever the code does",
  computed_expected:
    "takes its expected value from the code under test, so it agrees with any implementation",
  constant_assertion: "compares two constants, so it tests nothing",
  assertion_in_catch: "asserts only inside a catch, which never runs when nothing throws",
  unreachable_assertion: "has an assertion that can never run",
  skipped: "is skipped, so it never runs",
  focused: "is focused (.only), so the tests beside it never run",
  todo: "is a todo, so it never runs",
};

const TEST_FNS = new Set(["it", "test", "xit", "xtest", "fit", "bench"]);
const EQUALITY = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toBeCloseTo",
  "toContainEqual",
  "toHaveProperty",
]);
const UNARY_MATCHERS = new Set([
  "toBeTruthy",
  "toBeFalsy",
  "toBeDefined",
  "toBeUndefined",
  "toBeNull",
  "toBeNaN",
]);
const ASSERT_EQUAL = new Set([
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "is",
  "same",
]);

function rootIdentifier(e: ts.Expression): string | undefined {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
      cur = cur.expression;
    else if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else return undefined;
  }
}

/** `expect.assertions(n)` and `expect.hasAssertions()`: guards, not assertions. */
function isGuard(call: ts.CallExpression): boolean {
  const c = call.expression;
  return (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === "expect" &&
    (c.name.text === "assertions" || c.name.text === "hasAssertions")
  );
}

function isAssertionCall(call: ts.CallExpression, helpers: ReadonlySet<string>): boolean {
  if (isGuard(call)) return false;
  const root = rootIdentifier(call.expression);
  if (!root) return false;
  if (["expect", "assert", "expectTypeOf", "assertType", "should"].includes(root)) return true;
  if (/^assert[A-Z_]/.test(root)) return true;
  return ts.isIdentifier(call.expression) && helpers.has(call.expression.text);
}

function isConstant(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  if (ts.isParenthesizedExpression(e)) return isConstant(e.expression);
  if (
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isBigIntLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && (e.text === "undefined" || e.text === "NaN"))
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(e)) return isConstant(e.operand);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => isConstant(x));
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.every((p) => ts.isPropertyAssignment(p) && isConstant(p.initializer));
  }
  return false;
}

/**
 * The call to the code under test that `e` is entirely — an imported
 * function, a member of an imported namespace or an imported class, directly
 * or through a local `const` — or undefined when `e` is anything else (a
 * literal, a template with a literal part, a structure).
 */
function codeCall(
  e: ts.Expression | undefined,
  code: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  consts: ReadonlyMap<string, ts.Expression>,
  depth = 0,
): ts.CallExpression | ts.NewExpression | undefined {
  if (!e || depth > 5) return undefined;
  if (
    ts.isParenthesizedExpression(e) ||
    ts.isAwaitExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e)
  ) {
    return codeCall(e.expression, code, namespaces, consts, depth + 1);
  }
  if (ts.isIdentifier(e)) {
    return codeCall(consts.get(e.text), code, namespaces, consts, depth + 1);
  }
  if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
    const callee = e.expression;
    if (ts.isIdentifier(callee) && code.has(callee.text)) return e;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text)
    ) {
      return e;
    }
  }
  return undefined;
}

function callText(
  sf: ts.SourceFile,
  call: ts.CallExpression | ts.NewExpression,
): { callee: string; args: string } {
  return {
    callee: call.expression.getText(sf),
    args: (call.arguments ?? []).map((a) => a.getText(sf).replace(/\s+/g, "")).join(","),
  };
}

/** The `expect(A)` call at the base of a matcher chain, and whether `.not` is on it. */
function expectBase(
  callee: ts.Expression,
): { actual?: ts.Expression; negated: boolean } | undefined {
  let negated = false;
  let cur: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(cur)) {
    if (cur.name.text === "not") negated = true;
    cur = cur.expression;
  }
  if (
    ts.isCallExpression(cur) &&
    ts.isIdentifier(cur.expression) &&
    cur.expression.text === "expect"
  ) {
    return { ...(cur.arguments[0] ? { actual: cur.arguments[0] } : {}), negated };
  }
  return undefined;
}

function isFalseLiteral(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return isFalseLiteral(e.expression);
  return (
    e.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isNumericLiteral(e) && Number(e.text) === 0) ||
    (ts.isStringLiteral(e) && e.text === "") ||
    e.kind === ts.SyntaxKind.NullKeyword
  );
}

/** Is `node` after a `return` or `throw` in an enclosing block, or in a branch that cannot run? */
function unreachable(node: ts.Node, stop: ts.Node): boolean {
  let child: ts.Node = node;
  for (let p = node.parent; p && p !== stop.parent; child = p, p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p)) {
      const idx = p.statements.indexOf(child as ts.Statement);
      if (
        idx > 0 &&
        p.statements.slice(0, idx).some((s) => ts.isReturnStatement(s) || ts.isThrowStatement(s))
      ) {
        return true;
      }
    }
    if (ts.isIfStatement(p)) {
      if (child === p.thenStatement && isFalseLiteral(p.expression)) return true;
      if (child === p.elseStatement && p.expression.kind === ts.SyntaxKind.TrueKeyword) return true;
    }
    if (p === stop) break;
  }
  return false;
}

function inCatch(node: ts.Node, stop: ts.Node): boolean {
  for (let p = node.parent; p && p !== stop; p = p.parent) if (ts.isCatchClause(p)) return true;
  return false;
}

interface TestCall {
  title: string;
  line: number;
  modifier?: "skip" | "only" | "todo";
  body?: ts.FunctionLikeDeclaration;
}

function testCall(sf: ts.SourceFile, call: ts.CallExpression): TestCall | undefined {
  let callee = call.expression;
  let modifier: TestCall["modifier"];
  // it.each(table)(title, fn)
  if (ts.isCallExpression(callee)) callee = callee.expression;
  const names: string[] = [];
  let cur: ts.Expression = callee;
  while (ts.isPropertyAccessExpression(cur)) {
    names.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur) || !TEST_FNS.has(cur.text)) return undefined;
  if (cur.text === "xit" || cur.text === "xtest") modifier = "skip";
  if (cur.text === "fit") modifier = "only";
  for (const n of names) {
    if (n === "skip" || n === "skipIf" || n === "runIf") modifier = "skip";
    else if (n === "only") modifier = "only";
    else if (n === "todo") modifier = "todo";
  }
  const first = call.arguments[0];
  const title =
    first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ? first.text
      : (first?.getText(sf) ?? "(untitled)");
  const body = [...call.arguments]
    .reverse()
    .find(
      (a): a is ts.ArrowFunction | ts.FunctionExpression =>
        ts.isArrowFunction(a) || ts.isFunctionExpression(a),
    );
  return {
    title,
    line: sf.getLineAndCharacterOfPosition(call.getStart(sf)).line + 1,
    ...(modifier ? { modifier } : {}),
    ...(body ? { body } : {}),
  };
}

/** File-level functions whose bodies assert: a test calling one asserts (one fixpoint). */
function assertingHelpers(sf: ts.SourceFile): Set<string> {
  const fns = new Map<string, ts.Node>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) fns.set(st.name.text, st.body);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          fns.set(d.name.text, d.initializer.body);
        }
      }
    }
  }
  const helpers = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of fns) {
      if (helpers.has(name)) continue;
      let asserts = false;
      const visit = (n: ts.Node): void => {
        if (asserts) return;
        if (ts.isCallExpression(n) && isAssertionCall(n, helpers)) asserts = true;
        else ts.forEachChild(n, visit);
      };
      visit(body);
      if (asserts) {
        helpers.add(name);
        changed = true;
      }
    }
  }
  return helpers;
}

function lintFile(root: string, file: string): TestSmell[] {
  const path = join(root, file);
  if (!isCode(file) || !isFile(path)) return [];
  const sf = parse(path);
  const { locals, namespaces } = codeImports(root, file);
  const helpers = assertingHelpers(sf);
  const out: TestSmell[] = [];
  const add = (test: TestCall, smell: SmellKind, line = test.line): void => {
    if (out.some((s) => s.test === test.title && s.smell === smell && s.line === test.line)) return;
    out.push({
      file,
      line,
      test: test.title,
      smell,
      detail: `"${test.title}" ${SMELL_TEXT[smell]}`,
    });
  };
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visitTest = (t: TestCall): void => {
    const body = t.body;
    if (!body?.body) return;
    const consts = new Map<string, ts.Expression>();
    let guarded = false;
    const sites: ts.CallExpression[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        consts.set(n.name.text, n.initializer);
      }
      if (ts.isCallExpression(n)) {
        if (isGuard(n)) guarded = true;
        else if (isAssertionCall(n, helpers)) {
          sites.push(n);
          // A matcher chain is one assertion: do not count `expect(a)` inside it again.
          return;
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(body.body);
    const reachable = sites.filter((s) => !unreachable(s, body.body as ts.Node));
    if (sites.length === 0) add(t, "no_assertion");
    else if (reachable.length === 0) add(t, "unreachable_assertion", lineOf(sites[0] as ts.Node));
    else if (reachable.length < sites.length) {
      add(t, "unreachable_assertion", lineOf(sites.find((s) => !reachable.includes(s)) as ts.Node));
    }
    if (!guarded && sites.length > 0 && sites.every((s) => inCatch(s, body))) {
      add(t, "assertion_in_catch", lineOf(sites[0] as ts.Node));
    }
    // An expected value borrowed from the code under test: a tautology
    // (`expect(f(x)).toBe(f(x))`), or a test whose every check takes its
    // expected value wholly from another function under test, with no
    // independent oracle. A metamorphic relation — the same function on
    // different inputs — is not a smell.
    let computed = 0;
    let borrowed: ts.CallExpression | undefined;
    for (const s of sites) {
      const callee = s.expression;
      let actual: ts.Expression | undefined;
      let expected: ts.Expression | undefined;
      let matcher = "";
      let negated = false;
      if (ts.isPropertyAccessExpression(callee)) {
        const base = expectBase(callee.expression);
        if (base) {
          actual = base.actual;
          negated = base.negated;
          matcher = callee.name.text;
          expected = s.arguments[0];
        } else if (rootIdentifier(callee) === "assert" && ASSERT_EQUAL.has(callee.name.text)) {
          actual = s.arguments[0];
          expected = s.arguments[1];
          matcher = "toEqual";
        }
      }
      if (!matcher) continue;
      if (
        isConstant(actual) &&
        ((EQUALITY.has(matcher) && isConstant(expected)) || UNARY_MATCHERS.has(matcher))
      ) {
        add(t, "constant_assertion", lineOf(s));
      }
      if (negated || !EQUALITY.has(matcher)) continue;
      const want = codeCall(expected, locals, namespaces, consts);
      if (!want) continue;
      computed++;
      const got = codeCall(actual, locals, namespaces, consts);
      const w = callText(sf, want);
      const g = got ? callText(sf, got) : undefined;
      if (g && g.callee === w.callee && g.args === w.args) add(t, "computed_expected", lineOf(s));
      else if (!g || g.callee !== w.callee) borrowed ??= s;
    }
    if (borrowed && computed === sites.length) add(t, "computed_expected", lineOf(borrowed));
  };

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const t = testCall(sf, n);
      if (t) {
        if (!t.modifier) visitTest(t);
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // Skipped, focused and todo tests: ast-grep, or the text scan without it.
  const titles = new Map<number, string>();
  const collect = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const t = testCall(sf, n);
      if (t) titles.set(t.line, t.title);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  return out.concat(modifierSmells(root, [file], titles));
}

function modifierSmells(
  root: string,
  files: readonly string[],
  titles: ReadonlyMap<number, string> = new Map(),
  astGrep?: string | false,
): TestSmell[] {
  const kinds: Record<string, SmellKind> = { skip: "skipped", only: "focused", todo: "todo" };
  return scanHalfDone(root, files, astGrep === undefined ? {} : { astGrep })
    .filter((f) => f.kind !== "stub")
    .map((f) => {
      const smell = kinds[f.kind] as SmellKind;
      const test = titles.get(f.line) ?? f.file;
      return { file: f.file, line: f.line, test, smell, detail: `"${test}" ${SMELL_TEXT[smell]}` };
    });
}

/**
 * The test-smell lint over the staged acceptance tests (rule 6a, GT-TQ-6):
 * no assertion, an expected value computed by the code under test, two
 * constants compared, assertions only inside a `catch` or where they cannot
 * run, and skipped, focused or todo tests.
 */
export function lintTestSmells(root: string, tests: readonly string[]): TestSmell[] {
  const out: TestSmell[] = [];
  for (const file of tests) {
    if (isCode(file)) out.push(...lintFile(root, file));
    else out.push(...modifierSmells(root, [file]));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// --- The test-strength record ---------------------------------------------------

/**
 * One stub-kill run. The run stops at the first failure (`bail`), so only
 * the failures are counted: a run with any is a stand-in the tests killed.
 */
export interface StandInRun {
  standIn: StandIn;
  failed: number;
  /** The first test that failed against the stand-in. */
  killedBy?: string;
}

/** The test-strength record of rule 32a, as far as NEW-gates-6 builds it (GT-TQ-9). */
export interface TestStrengthRecord {
  /**
   * Who wrote the tests (lead ruling under DEC-42): `card` — the Planner or
   * the test author, for this card — or `external` — the frozen suite's, a
   * person's, a repository's own, which the Worker cannot change.
   */
  origin: TestOrigin;
  /** Each staged test file's own origin (`testOrigins`; lead ruling, B4.0b review). */
  origins?: Record<string, TestOrigin>;
  /**
   * External tests that fail on the base for the wrong reason, each with the
   * phase it failed in: recorded for a person, never a stop (DEC-42 ruling).
   */
  redForWrongReason: { test: string; phase: AcceptanceKind; message?: string }[];
  profile: DepthProfile;
  /** "depth profile: internal tool (default)" until P14 exists (GT-TQ-12). */
  profileNote: string;
  interface: { file: string; exists: boolean; missing: string[] }[];
  smells: TestSmell[];
  redAtAssertion: {
    status: "red" | "not_red_for_reason" | "vacuous" | "not_judged";
    results: AcceptanceTestResult[];
    requireAssertions: boolean;
    reason?: string;
  };
  stubKill: {
    status: "killed" | "survived" | "not_applicable" | "not_judged";
    runs: StandInRun[];
    standIn?: StandIn;
    passing?: string[];
    reason?: string;
  };
  /** Weak tests found at an advisory level: for a person, never the Worker (GT-TQ-12). */
  testGaps: string[];
  verdict: {
    /** Undefined when nothing here decides red-first: the caller judges as before. */
    status?: "fails" | "vacuous" | "refused";
    stopReason?: "vacuous_tests" | "tests_not_red_for_reason";
    detail: string;
  };
}

/** Who wrote the acceptance tests (lead ruling under DEC-42). */
export type TestOrigin = "card" | "external";

/** Who wrote a staged test file, as its `test/staged` record says. */
export type TestAuthor = "planner" | "test-author" | "pm" | "person" | "repository" | "suite";

/** The authors whose tests are written for the card: their records make a file `card`. */
export const CARD_TEST_AUTHORS: readonly TestAuthor[] = ["planner", "test-author", "pm"];

/** A `test/staged` record: a test file staged for a card, by its path, SHA-256 and author. */
export interface StagedTestRecord {
  path: string;
  sha256: string;
  author: string;
}

/**
 * Each test file's origin (lead ruling, B4.0b review): `card` when its
 * SHA-256 matches a Planner, test-author or PM carry-over `test/staged`
 * record, or when the card's own diff wrote it (the Worker writes it
 * red-first); `external` otherwise — the frozen suite's staged tests, a
 * person's, the repository's existing tests. `forced` names every file's
 * origin explicitly (the frozen suite passes `external`), so a measurement
 * never changes because a record appeared.
 */
export function testOrigins(input: {
  root: string;
  tests: readonly string[];
  staged: readonly StagedTestRecord[];
  /** Files the card's own diff changed or added, the harness's staged acceptance tests excluded. */
  cardDiff?: readonly string[] | undefined;
  forced?: TestOrigin | undefined;
}): Record<string, TestOrigin> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const written = new Set(
    input.staged
      .filter((r) => (CARD_TEST_AUTHORS as readonly string[]).includes(r.author))
      .map((r) => r.sha256),
  );
  const diff = new Set((input.cardDiff ?? []).map(norm));
  const out: Record<string, TestOrigin> = {};
  for (const t of input.tests) {
    const file = norm(t);
    if (input.forced) {
      out[file] = input.forced;
      continue;
    }
    let sha: string | undefined;
    try {
      sha = createHash("sha256")
        .update(readFileSync(join(input.root, file)))
        .digest("hex");
    } catch {
      sha = undefined;
    }
    out[file] = diff.has(file) || (sha !== undefined && written.has(sha)) ? "card" : "external";
  }
  return out;
}

export interface TestStrengthInput {
  /**
   * `card`: written for this card by the Planner or the test author — the
   * checks stop it. `external`: received from outside and unchangeable by
   * the Worker — they need only fail on the base, and what the checks find
   * is recorded for a person (DEC-42 ruling; `card_vang_2_hmac`).
   */
  origin: TestOrigin;
  /**
   * Each test file's own origin (`testOrigins`), which takes precedence over
   * `origin` for that file: only the card's own tests can stop the card.
   */
  origins?: Readonly<Record<string, TestOrigin>> | undefined;
  sandbox: ProcessSandbox;
  /** The card's worktree, with the acceptance tests staged. */
  root: string;
  /** The project's test gate, whose runner runs the acceptance tests alone. */
  testGate: GateDefinition;
  /** The staged acceptance tests, repository-relative. */
  tests: readonly string[];
  change?: CardChange | undefined;
  /** `interface`: a types-only card, red on the typecheck (rule 6). */
  kind?: string | undefined;
  profile?: DepthProfile | undefined;
}

function list(items: readonly string[], max = 4): string {
  return items.length <= max
    ? items.join("; ")
    : `${items.slice(0, max).join("; ")}; and ${items.length - max} more`;
}

function describeResult(r: AcceptanceTestResult): string {
  const why: Record<AcceptanceKind, string> = {
    assertion: "failed at an assertion",
    not_implemented: "failed at the stub",
    passed: "passed",
    import: "failed at import",
    setup: "failed in setup",
    error: "failed with an error of its own, not at an assertion",
    no_assertion: "executed no assertion",
    skipped: "did not run",
    missing: "reported no result",
  };
  return `${r.test} ${why[r.kind]}${r.message ? ` (${r.message})` : ""}`;
}

/**
 * Judge the acceptance tests' strength before any work (rules 6, 6a, 32a):
 * the smell lint first (no run), then red at an assertion against the
 * interface stub, then stub-kill. Every stand-in is removed before this
 * returns, so the Worker starts from the base.
 */
export async function checkTestStrength(input: TestStrengthInput): Promise<TestStrengthRecord> {
  // The check leaves no trace (B4.0b review): the tree afterwards is the tree before.
  const restoreTree = preserveTree(input.root);
  try {
    return await judgeStrength(input);
  } finally {
    restoreTree();
  }
}

/**
 * Every non-ignored path git reports as changed or untracked, with its
 * two-letter status. Like every git call here, it runs with the guarded
 * environment in a card's worktree (security items 19–21), so the
 * repository's config cannot make git run a program.
 */
function porcelain(root: string): Map<string, string> {
  const out = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
      env: gitEnvFor(root),
    },
  );
  const entries = new Map<string, string>();
  for (const entry of out.split("\0")) {
    if (entry.length > 3) entries.set(entry.slice(3), entry.slice(0, 2));
  }
  return entries;
}

function bytesOf(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Record the tree before the strength check runs the tests, and return the
 * function that puts it back exactly: a file the check created is removed
 * (with the directories it leaves empty), a clean tracked file it changed
 * or deleted is restored from the index, and a file that was already
 * changed or new before the check — the Worker's own — is put back to its
 * exact bytes only if the check changed it, never removed. Outside git
 * there is nothing to compare against, and nothing is touched.
 */
export function preserveTree(cwd: string): () => void {
  let before: Map<string, string>;
  let root: string;
  try {
    before = porcelain(cwd);
    // Porcelain paths are relative to the repository's top level.
    root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: gitEnvFor(cwd),
    }).trim();
  } catch {
    return () => {};
  }
  const saved = new Map<string, Buffer | null>();
  for (const p of before.keys()) saved.set(p, bytesOf(join(root, p)));
  const putBack = (p: string, was: Buffer | null) => {
    const path = join(root, p);
    const now = bytesOf(path);
    if (was === null) {
      if (now !== null) rmSync(path, { force: true });
    } else if (now === null || !now.equals(was)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, was);
    }
  };
  return () => {
    let after: Map<string, string>;
    try {
      after = porcelain(root);
    } catch {
      return;
    }
    const fromIndex: string[] = [];
    for (const [p, status] of after) {
      if (saved.has(p)) continue;
      if (status === "??") {
        const path = join(root, p);
        rmSync(path, { force: true });
        // The directories it created, now empty (git keeps no empty directory).
        for (let d = dirname(path); d.startsWith(`${root}${sep}`); d = dirname(d)) {
          try {
            if (readdirSync(d).length > 0) break;
            rmdirSync(d);
          } catch {
            break;
          }
        }
      } else {
        fromIndex.push(p);
      }
    }
    for (const [p, was] of saved) putBack(p, was);
    if (fromIndex.length > 0) {
      execFileSync("git", ["checkout", "--", ...fromIndex], {
        cwd: root,
        stdio: "ignore",
        timeout: 60_000,
        env: gitEnvFor(root),
      });
    }
  };
}

async function judgeStrength(input: TestStrengthInput): Promise<TestStrengthRecord> {
  const profile = input.profile ?? DEFAULT_DEPTH_PROFILE;
  const rules = STRENGTH_TABLE[profile];
  const profileNote = `depth profile: ${profile}${input.profile ? "" : " (default)"}`;
  const tests = [...input.tests];
  const iface = declaredInterface(input.root, tests);
  const originOf = (file: string): TestOrigin =>
    input.origins?.[file.replace(/\\/g, "/").replace(/^\.\//, "")] ?? input.origin;
  const origins: Record<string, TestOrigin> = Object.fromEntries(
    tests.map((t) => [t, originOf(t)]),
  );
  // The checks can stop the card only through a test written for it.
  const external = !tests.some((t) => originOf(t) === "card");
  const record: TestStrengthRecord = {
    origin: external ? "external" : "card",
    origins,
    redForWrongReason: [],
    profile,
    profileNote,
    interface: iface.map((m) => ({ file: m.file, exists: m.exists, missing: m.missing })),
    smells: [],
    redAtAssertion: { status: "not_judged", results: [], requireAssertions: false },
    stubKill: { status: "not_judged", runs: [] },
    testGaps: [],
    verdict: { detail: "" },
  };

  // 1. The smell lint: no run needed.
  record.smells = rules.smellLint === "off" ? [] : lintTestSmells(input.root, tests);
  const smellsOf = (own: boolean) =>
    record.smells.filter((s) => (originOf(s.file) === "card") === own);
  const outsideSmells = smellsOf(false);
  if (outsideSmells.length > 0) {
    record.testGaps.push(
      `test smells (tests from outside the card): ${list(outsideSmells.map((s) => `${s.file}:${s.line} ${s.detail}`))}`,
    );
  }
  const ownSmells = smellsOf(true);
  if (ownSmells.length > 0) {
    const named = list(ownSmells.map((s) => `${s.file}:${s.line} ${s.detail}`));
    if (rules.smellLint === "blocking") {
      record.redAtAssertion.reason = "not run: the test-smell lint stopped the card first";
      record.stubKill.reason = record.redAtAssertion.reason;
      record.verdict = {
        status: "vacuous",
        stopReason: "vacuous_tests",
        detail: `The acceptance tests cannot fail as written: ${named}.`,
      };
      return record;
    }
    record.testGaps.push(`test smells (${profile}: advisory): ${named}`);
  }

  // 2. Red at an assertion: only where the base must be red, and not for a
  //    types-only card, whose red is the typecheck's.
  const rule = redGreenRule(input.change);
  if (rule.onBase !== "red" || input.kind === "interface") {
    record.redAtAssertion.reason =
      rule.onBase !== "red"
        ? `a ${rule.change} card's tests must pass on the base`
        : "a types-only card is red on the typecheck";
    record.stubKill = { status: "not_applicable", runs: [], reason: record.redAtAssertion.reason };
    return record;
  }
  const restore = stageStandIn(input.root, iface, "not-implemented");
  let run: AcceptanceRun;
  try {
    run = await runAcceptanceTests(input.sandbox, input.root, input.testGate, tests);
  } finally {
    restore();
  }
  if ("unavailable" in run) {
    record.redAtAssertion.reason = run.unavailable;
    record.stubKill.reason = "not run: red at an assertion was not judged";
    return record;
  }
  record.redAtAssertion.results = run.results;
  record.redAtAssertion.requireAssertions = run.requireAssertions;
  const own = (r: AcceptanceTestResult) => originOf(r.file) === "card";
  const allNotRed = run.results.filter(
    (r) => r.kind !== "assertion" && r.kind !== "not_implemented" && r.kind !== "passed",
  );
  const allPassing = run.results.filter((r) => r.kind === "passed");
  // Tests the Worker cannot change need only fail on the base: the gate run
  // decides that. A wrong-reason failure is a visible finding (DEC-42 ruling).
  const outsideNotRed = allNotRed.filter((r) => !own(r));
  if (outsideNotRed.length > 0) {
    record.redForWrongReason = outsideNotRed.map((r) => ({
      test: r.test,
      phase: r.kind,
      ...(r.message ? { message: r.message } : {}),
    }));
    record.testGaps.push(
      `redForWrongReason (tests from outside the card): ${list(outsideNotRed.map(describeResult))}`,
    );
  }
  const notRed = allNotRed.filter(own);
  const passing = allPassing.filter(own);
  const outsidePassing = allPassing.filter((r) => !own(r));
  if (outsidePassing.length > 0) {
    // Whether they fail on the base is the gate run's to say, as before.
    record.testGaps.push(
      `tests from outside the card that pass against the interface stub: ${list(outsidePassing.map((r) => r.test))}`,
    );
  }
  if (notRed.length === 0 && outsideNotRed.length > 0) {
    record.redAtAssertion.status = "not_red_for_reason";
    record.stubKill.reason = "not run: the tests are not red for the right reason";
    return record;
  }
  if (notRed.length > 0) {
    record.redAtAssertion.status = "not_red_for_reason";
    record.stubKill.reason = "not run: the tests are not red for the right reason";
    record.verdict = {
      status: "refused",
      stopReason: "tests_not_red_for_reason",
      detail: `Against a stub of the card's declared interface, ${list(notRed.map(describeResult))}: a test must fail at an assertion before any work, or it goes green as soon as the file exists, whatever the code does.`,
    };
    return record;
  }
  if (passing.length === 0 && outsidePassing.length > 0) {
    record.redAtAssertion.status = "vacuous";
    record.stubKill.reason = "not run: some tests already pass against the stub";
    return record;
  }
  if (passing.length > 0) {
    record.redAtAssertion.status = "vacuous";
    record.stubKill.reason = "not run: the tests already pass against the stub";
    record.verdict = {
      status: "vacuous",
      stopReason: "vacuous_tests",
      detail: `${list(passing.map((r) => r.test))} already pass against a stub whose every export throws "not implemented", so they cannot tell whether this card did anything.`,
    };
    return record;
  }
  record.redAtAssertion.status = "red";
  record.verdict = {
    status: "fails",
    detail: `every acceptance test fails at an assertion or at the stub (${run.results.length} test(s))`,
  };

  // 3. Stub-kill: the declared exports the card adds, replaced by trivial bodies.
  const added = iface.filter((m) => m.missing.length > 0);
  if (added.length === 0) {
    record.stubKill = {
      status: "not_applicable",
      runs: [],
      reason: "the card declares no new export",
    };
    return record;
  }
  if (rules.stubKill === "off") {
    record.stubKill = {
      status: "not_applicable",
      runs: [],
      reason: `off at the ${profile} profile`,
    };
    return record;
  }
  record.stubKill = { status: "killed", runs: [] };
  for (const standIn of STAND_INS) {
    const back = stageStandIn(input.root, iface, standIn);
    let r: AcceptanceRun;
    try {
      r = await runAcceptanceTests(input.sandbox, input.root, input.testGate, tests, {
        bail: true,
      });
    } finally {
      back();
    }
    if ("unavailable" in r) {
      record.stubKill = { status: "not_judged", runs: record.stubKill.runs, reason: r.unavailable };
      return record;
    }
    const passed = r.results.filter((x) => x.kind === "passed");
    const failed = r.results.filter((x) => x.kind !== "passed");
    record.stubKill.runs.push({
      standIn,
      failed: failed.length,
      ...(failed[0] ? { killedBy: failed[0].test } : {}),
    });
    if (failed.length === 0 && r.results.length > 0) {
      record.stubKill.status = "survived";
      record.stubKill.standIn = standIn;
      record.stubKill.passing = passed.map((x) => x.test);
      const detail = `${list(passed.map((x) => x.test))} pass against a stand-in whose every export ${standIn}, so they cannot tell a real implementation from a trivial one.`;
      if (rules.stubKill === "blocking" && !external) {
        record.verdict = { status: "vacuous", stopReason: "vacuous_tests", detail };
      } else {
        record.testGaps.push(
          `stub-kill (${external ? "tests from outside the card" : `${profile}: advisory`}): ${detail}`,
        );
      }
      return record;
    }
  }
  return record;
}
