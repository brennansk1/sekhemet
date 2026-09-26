import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import { onPath } from "./builtin.js";
import { factsOfText } from "./index/source_index.js";

/**
 * Half-done patterns across languages: skipped, focused and todo tests, and
 * "not implemented" stubs (DEC-44). ast-grep (MIT) is used as a separate
 * program when it is installed — it parses with tree-sitter and runs no
 * repository code — and a line-based text scan stands in when it is absent,
 * with every finding naming which one found it.
 *
 * The test-smell lint reads the test patterns (gates rule 6a, GT-TQ-6); the
 * stub patterns serve the take-over's half-done detection (DS-TO-8).
 */

export type HalfDoneKind = "skip" | "only" | "todo" | "stub";

export interface HalfDoneFinding {
  /** Repository-relative. */
  file: string;
  /** 1-based. */
  line: number;
  kind: HalfDoneKind;
  text: string;
  tool: "ast-grep" | "text";
}

type Lang = "ts" | "py" | "rs";

function langOf(file: string): Lang | undefined {
  const ext = extname(file).toLowerCase();
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts";
  if (ext === ".py") return "py";
  if (ext === ".rs") return "rs";
  return undefined;
}

// --- The text fallback ------------------------------------------------------

const TEXT_RULES: Record<Lang, { kind: HalfDoneKind; re: RegExp }[]> = {
  ts: [
    { kind: "skip", re: /\b(?:it|test|describe|suite|bench)\.(?:skip|skipIf|runIf)\b/ },
    { kind: "skip", re: /(?:^|[^\w$.])(?:xit|xtest|xdescribe)\s*\(/ },
    { kind: "only", re: /\b(?:it|test|describe|suite|bench)\.only\b/ },
    { kind: "only", re: /(?:^|[^\w$.])(?:fit|fdescribe)\s*\(/ },
    { kind: "todo", re: /\b(?:it|test|describe)\.todo\b/ },
    { kind: "stub", re: /throw\s+new\s+Error\s*\(\s*["'`][^"'`]*not.?implemented/i },
  ],
  py: [
    { kind: "skip", re: /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip)\b/ },
    { kind: "skip", re: /\bpytest\.skip\s*\(/ },
    { kind: "stub", re: /\braise\s+NotImplementedError\b/ },
  ],
  rs: [
    { kind: "skip", re: /#\[ignore\b/ },
    { kind: "stub", re: /\b(?:todo|unimplemented)!\s*\(/ },
  ],
};

function isComment(lang: Lang, line: string): boolean {
  const t = line.trim();
  if (lang === "py") return t.startsWith("#");
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function textScan(root: string, files: readonly string[]): HalfDoneFinding[] {
  const out: HalfDoneFinding[] = [];
  for (const file of files) {
    const lang = langOf(file);
    const path = join(root, file);
    if (!lang || !existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (isComment(lang, line)) return;
      const hit = TEXT_RULES[lang].find((r) => r.re.test(line));
      if (hit) out.push({ file, line: i + 1, kind: hit.kind, text: line.trim(), tool: "text" });
    });
  }
  return out;
}

// --- ast-grep ---------------------------------------------------------------

/** The rules, one YAML document each, as `ast-grep scan --inline-rules` reads them. */
function astGrepRules(): string {
  const any = (patterns: string[]) =>
    `  any:\n${patterns.map((p) => `    - pattern: ${JSON.stringify(p)}`).join("\n")}`;
  const tsRules = (language: string) => [
    `id: skip-${language}\nlanguage: ${language}\nrule:\n${any([
      "it.skip($$$)",
      "test.skip($$$)",
      "describe.skip($$$)",
      "it.skipIf($$$)",
      "test.skipIf($$$)",
      "it.runIf($$$)",
      "test.runIf($$$)",
      "xit($$$)",
      "xtest($$$)",
      "xdescribe($$$)",
    ])}`,
    `id: only-${language}\nlanguage: ${language}\nrule:\n${any([
      "it.only($$$)",
      "test.only($$$)",
      "describe.only($$$)",
      "fit($$$)",
      "fdescribe($$$)",
    ])}`,
    `id: todo-${language}\nlanguage: ${language}\nrule:\n${any(["it.todo($$$)", "test.todo($$$)"])}`,
    `id: stub-${language}\nlanguage: ${language}\nrule:\n  pattern: "throw new Error($MSG)"\nconstraints:\n  MSG:\n    regex: "(?i)not.?implemented"`,
  ];
  return [
    ...tsRules("TypeScript"),
    ...tsRules("Tsx"),
    ...tsRules("JavaScript"),
    `id: skip-Python\nlanguage: Python\nrule:\n  kind: decorator\n  regex: "pytest\\\\.mark\\\\.(skip|skipif|xfail)|unittest\\\\.skip"`,
    `id: stub-Python\nlanguage: Python\nrule:\n${any(["raise NotImplementedError", "raise NotImplementedError($$$)"])}`,
    `id: skip-Rust\nlanguage: Rust\nrule:\n  kind: attribute_item\n  regex: "^#\\\\[ignore"`,
    `id: stub-Rust\nlanguage: Rust\nrule:\n${any(["todo!($$$)", "unimplemented!($$$)"])}`,
  ].join("\n---\n");
}

interface AstGrepMatch {
  file: string;
  ruleId: string;
  text: string;
  range: { start: { line: number } };
}

/** Run ast-grep over the files; undefined when it cannot, so the text scan stands in. */
function astGrepScan(
  program: string,
  root: string,
  files: readonly string[],
): HalfDoneFinding[] | undefined {
  const present = files.filter((f) => langOf(f) && existsSync(join(root, f)));
  if (present.length === 0) return [];
  // Run from a private empty directory with absolute paths: ast-grep finds
  // its project configuration (`sgconfig.yml`: rule directories, custom
  // languages) from its working directory upward, and the repository's must
  // never add to or change the harness's rules.
  const cwd = mkdtempSync(join(tmpdir(), "sekhemet-sg-"));
  let r: SpawnSyncReturns<string>;
  try {
    r = spawnSync(
      program,
      [
        "scan",
        "--inline-rules",
        astGrepRules(),
        "--json=stream",
        ...present.map((f) => join(root, f)),
      ],
      { cwd, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  if (r.error || r.status === null || (r.status !== 0 && r.status !== 1)) return undefined;
  const out: HalfDoneFinding[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    let m: AstGrepMatch;
    try {
      m = JSON.parse(line) as AstGrepMatch;
    } catch {
      return undefined;
    }
    const kind = m.ruleId.split("-")[0] as HalfDoneKind;
    out.push({
      file: isAbsolute(m.file) ? relative(root, m.file).split(sep).join("/") : m.file,
      line: m.range.start.line + 1,
      kind,
      text: m.text.split("\n")[0]?.trim() ?? "",
      tool: "ast-grep",
    });
  }
  return out;
}

/**
 * The installed ast-grep program, if any: `ast-grep`, or its short name
 * `sg` only when `sg --version` says it is ast-grep — on Linux `sg` is also
 * shadow-utils' switch-group command.
 */
export function astGrepProgram(): string | undefined {
  if (onPath("ast-grep")) return "ast-grep";
  if (!onPath("sg")) return undefined;
  const r = spawnSync("sg", ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return r.status === 0 && /ast-grep/i.test(`${r.stdout}`) ? "sg" : undefined;
}

/**
 * Find half-done patterns in `files` (repository-relative). `astGrep: false`
 * forces the text scan; a program name forces that program.
 */
export function scanHalfDone(
  root: string,
  files: readonly string[],
  options: { astGrep?: string | false } = {},
): HalfDoneFinding[] {
  const program = options.astGrep === false ? undefined : (options.astGrep ?? astGrepProgram());
  const found = program ? astGrepScan(program, root, files) : undefined;
  const all = found ?? textScan(root, files);
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// --- Unfinished wiring (DS-TO-8) ----------------------------------------------

/**
 * The take-over's other half-done detectors (design-stage §2.10 step 3,
 * DS-TO-8): a route or UI control registered with no handler, an import of a
 * module that does not exist, and a schema table no migration creates. Each
 * reads files only — no repository code runs, no model is loaded — and
 * names its file and line. They are line-based and deliberately narrow: a
 * finding is a lead for the take-over's inventory, never a gate verdict.
 */
export type UnfinishedKind = "no_handler" | "missing_import" | "no_migration";

export interface UnfinishedFinding {
  /** Repository-relative. */
  file: string;
  /** 1-based. */
  line: number;
  kind: UnfinishedKind;
  text: string;
  /** What is missing, in words: the handler, the module, the table. */
  detail: string;
  tool: "text";
}

const JS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function readText(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return undefined;
  }
}

function occurrences(text: string, name: string): number {
  const escaped = name.replace(/\$/g, "\\$");
  return (text.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "g")) ?? []).length;
}

const ROUTE =
  /\b[A-Za-z_$][\w$]*\.(?:get|post|put|patch|delete|all|options|head)\(\s*(["'`])(\/[^"'`]*)\1\s*(?:,\s*([^)]*?))?\s*\)\s*;?\s*$/;
const JSX_HANDLER = /\bon[A-Z]\w*=\{\s*([A-Za-z_$][\w$]*)\s*\}/g;
const JSX_EMPTY = /\bon[A-Z]\w*=\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/;
const IDENT = /^[A-Za-z_$][\w$]*$/;

function noHandler(root: string, file: string): UnfinishedFinding[] {
  const text = readText(root, file);
  if (text === undefined) return [];
  const out: UnfinishedFinding[] = [];
  text.split("\n").forEach((raw, i) => {
    if (isComment("ts", raw)) return;
    const line = raw.trim();
    const route = ROUTE.exec(line);
    if (route) {
      const handler = (route[3] ?? "").trim();
      if (!handler) {
        out.push(unfinished(file, i, "no_handler", line, `route ${route[2]} has no handler`));
      } else if (IDENT.test(handler) && occurrences(text, handler) <= 1) {
        out.push(
          unfinished(file, i, "no_handler", line, `route ${route[2]}: ${handler} is never defined`),
        );
      }
      return;
    }
    if (JSX_EMPTY.test(line)) {
      out.push(unfinished(file, i, "no_handler", line, "a control whose handler does nothing"));
      return;
    }
    for (const m of line.matchAll(JSX_HANDLER)) {
      const name = m[1] as string;
      if (name !== "undefined" && occurrences(text, name) > 1) continue;
      out.push(unfinished(file, i, "no_handler", line, `${name} is never defined`));
      break;
    }
  });
  return out;
}

function unfinished(
  file: string,
  index: number,
  kind: UnfinishedKind,
  text: string,
  detail: string,
): UnfinishedFinding {
  return { file, line: index + 1, kind, text, detail, tool: "text" };
}

function resolvesJs(root: string, fromFile: string, spec: string): boolean {
  const base = join(root, fromFile, "..", spec);
  const stems = [base];
  const ext = extname(base);
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) stems.push(base.slice(0, -ext.length));
  const candidates = stems.flatMap((s) => [
    s,
    ...JS_EXT.map((e) => `${s}${e}`),
    ...JS_EXT.map((e) => join(s, `index${e}`)),
  ]);
  return candidates.some((c) => existsSync(c) && (c !== base || !isDirectory(c)));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The names a repository declares or holds: every package.json's dependencies and names, and node_modules. */
function knownPackages(root: string, files: readonly string[]): Set<string> | undefined {
  const manifests = files.filter((f) => f === "package.json" || f.endsWith("/package.json"));
  if (!existsSync(join(root, "package.json"))) return undefined;
  if (!manifests.includes("package.json")) manifests.push("package.json");
  const known = new Set<string>();
  for (const m of manifests) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, m), "utf8")) as Record<string, unknown>;
      if (typeof pkg.name === "string") known.add(pkg.name);
      for (const key of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const deps = pkg[key];
        if (deps && typeof deps === "object") for (const d of Object.keys(deps)) known.add(d);
      }
    } catch {
      // An unreadable manifest declares nothing.
    }
  }
  return known;
}

/** Path aliases (`compilerOptions.paths` keys) as prefixes: an aliased import is not a package. */
function aliasPrefixes(root: string): string[] {
  const out: string[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const text = readText(root, name);
    const paths = text ? /"paths"\s*:\s*\{([^}]*)\}/s.exec(text)?.[1] : undefined;
    for (const m of paths?.matchAll(/"([^"]+)"\s*:/g) ?? []) {
      out.push((m[1] as string).replace(/\*.*$/, ""));
    }
  }
  return out.filter(Boolean);
}

function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
}

function missingImports(
  root: string,
  file: string,
  packages: Set<string> | undefined,
  aliases: readonly string[],
): UnfinishedFinding[] {
  const text = readText(root, file);
  if (text === undefined) return [];
  const lang = langOf(file);
  const out: UnfinishedFinding[] = [];
  const lines = text.split("\n");
  if (lang === "py") {
    // Python has no index adapter yet: a relative `from .mod import x` is read by tokens.
    lines.forEach((raw, i) => {
      if (isComment(lang, raw)) return;
      const line = raw.trim();
      const [from, target, keyword] = line.split(/\s+/);
      if (from !== "from" || keyword !== "import" || !target?.startsWith(".")) return;
      const dots = target.length - target.replace(/^\.+/, "").length;
      const name = target.slice(dots);
      if (!/^[\w.]+$/.test(name)) return;
      let dir = join(root, file, "..");
      for (let d = 1; d < dots; d++) dir = join(dir, "..");
      const mod = join(dir, ...name.split("."));
      if (!existsSync(`${mod}.py`) && !existsSync(mod)) {
        out.push(unfinished(file, i, "missing_import", line, `${target} does not exist`));
      }
    });
    return out;
  }
  if (lang !== "ts") return out;
  // GT-T2-3: specifiers come from the one source index, never a regular expression.
  const facts = factsOfText(file, text);
  const specifiers = [...facts.imports, ...facts.reExports]
    .map((f) => ({ spec: f.specifier, line: f.line }))
    .sort((a, b) => a.line - b.line);
  const reported = new Set<number>();
  for (const { spec, line } of specifiers) {
    if (reported.has(line)) continue;
    let missing = false;
    if (spec.startsWith("./") || spec.startsWith("../")) {
      missing = !resolvesJs(root, file, spec);
    } else if (
      packages &&
      !spec.startsWith("node:") &&
      !spec.includes(":") &&
      !builtinModules.includes(packageOf(spec)) &&
      !aliases.some((a) => spec.startsWith(a))
    ) {
      const name = packageOf(spec);
      missing = !packages.has(name) && !existsSync(join(root, "node_modules", name));
    }
    if (missing) {
      reported.add(line);
      const at = line - 1;
      out.push(
        unfinished(file, at, "missing_import", (lines[at] ?? "").trim(), `${spec} does not exist`),
      );
    }
  }
  return out;
}

/** Table declarations of the ORMs a take-over meets most: Prisma, Drizzle, TypeORM, Sequelize, SQLAlchemy. */
function schemaTables(root: string, file: string): { table: string; line: number; text: string }[] {
  const text = readText(root, file);
  if (text === undefined) return [];
  const lines = text.split("\n");
  const out: { table: string; line: number; text: string }[] = [];
  if (file.endsWith(".prisma")) {
    lines.forEach((l, i) => {
      const m = /^\s*model\s+(\w+)\s*\{/.exec(l);
      if (!m) return;
      const end = lines.findIndex((x, j) => j > i && /^\s*\}/.test(x));
      const body = lines.slice(i, end === -1 ? undefined : end).join("\n");
      const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1];
      out.push({ table: mapped ?? (m[1] as string), line: i + 1, text: l.trim() });
    });
    return out;
  }
  const lang = langOf(file);
  if (!lang) return [];
  const patterns =
    lang === "py"
      ? [/__tablename__\s*=\s*["'](\w+)["']/]
      : [
          /\b(?:pg|sqlite|mysql)Table\(\s*["'`](\w+)["'`]/,
          /@Entity\(\s*(?:\{\s*name:\s*)?["'](\w+)["']/,
          /\bsequelize\.define\(\s*["'](\w+)["']/,
        ];
  lines.forEach((l, i) => {
    if (isComment(lang, l)) return;
    for (const re of patterns) {
      const m = re.exec(l);
      if (m) out.push({ table: m[1] as string, line: i + 1, text: l.trim() });
    }
  });
  return out;
}

const MIGRATION_PATH =
  /(^|\/)(migrations?|migrate|drizzle|alembic\/versions|db\/migrate|supabase\/migrations)\/|\.sql$/i;

function createsTable(migrations: string, table: string): boolean {
  const t = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const q = "[\"'`\\[]?";
  const qe = "[\"'`\\]]?";
  return [
    new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:${q}\\w+${qe}\\.)?${q}${t}${qe}(?![\\w])`,
      "i",
    ),
    new RegExp(`createTable\\(\\s*["'\`]${t}["'\`]`),
    new RegExp(`create_table\\(\\s*["']${t}["']`),
    new RegExp(`create_table\\s+(?::${t}\\b|["']${t}["'])`),
  ].some((re) => re.test(migrations));
}

function noMigration(root: string, files: readonly string[]): UnfinishedFinding[] {
  const declared = files
    .filter((f) => !MIGRATION_PATH.test(f))
    .flatMap((file) => schemaTables(root, file).map((t) => ({ file, ...t })));
  if (declared.length === 0) return [];
  const migrations = files
    .filter((f) => MIGRATION_PATH.test(f))
    .map((f) => readText(root, f) ?? "")
    .join("\n");
  return declared
    .filter((d) => !createsTable(migrations, d.table))
    .map((d) =>
      unfinished(d.file, d.line - 1, "no_migration", d.text, `no migration creates ${d.table}`),
    );
}

/**
 * The unfinished-wiring findings in `files` (repository-relative; the
 * take-over passes every file it read), sorted by file and line.
 */
export function scanUnfinished(root: string, files: readonly string[]): UnfinishedFinding[] {
  const packages = knownPackages(root, files);
  const aliases = aliasPrefixes(root);
  const out: UnfinishedFinding[] = [];
  for (const file of files) {
    const lang = langOf(file);
    if (lang === "ts") out.push(...noHandler(root, file));
    if (lang) out.push(...missingImports(root, file, packages, aliases));
  }
  out.push(...noMigration(root, files));
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
