import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RERUN_GATES, gateCopy } from "./copy.js";
import type { SourceFacts } from "./index/facts.js";
import { createSourceIndex, factsOfText } from "./index/source_index.js";
import { ts } from "./index/typescript.js";
import type { CompleteGateFailure, FailureLocation, GateDefinition } from "./types.js";

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

export type FailureParser = (ctx: ParseContext) => CompleteGateFailure[];

const NOISE = /^(?:\s*$|>|\$ |npm |pnpm |yarn |Progress|\[\d+\/\d+\])/;

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

// Ranking moved to rank.ts (rule 20); re-exported so existing imports keep working.
export { rankFailures } from "./rank.js";

/**
 * The module and the member in a missing-export message. tsc writes TS2305
 * as `Module '"./x.js"' has no exported member 'A'` and TS2724 as
 * `'"./x.js"' has no exported member named 'A'. Did you mean 'B'?`.
 */
const MODULE_IN_MESSAGE = /'"([^"]+)"'/;
const MEMBER_IN_MESSAGE = /exported member (?:named )?'([^']+)'/;

/**
 * Concrete remedies for the diagnostics local models loop on.
 *
 * "Resolve TS18048" names the problem, not the idiom. Chronicle's verifier card
 * burned its whole repair ladder alternating between an index access that may
 * be undefined and the `!` assertion lint forbids; one sentence with the
 * narrowing pattern is the difference between a pass and repair_exhausted.
 * The words live in the gates copy module (copy.ts).
 */
export function remedyFor(code: string, message: string): string | undefined {
  switch (code) {
    case "TS18048":
    case "TS18047":
    case "TS2532":
    case "TS2533":
    case "lint/style/noNonNullAssertion":
      return gateCopy.narrow;
    case "TS2339":
    case "TS2345":
    case "TS2322":
      return /\| undefined\b|undefined'/.test(message) ? gateCopy.narrow : undefined;
    case "TS2375":
    case "TS2379":
    case "TS2412":
      return gateCopy.exactOptional;
    case "TS2304":
      return gateCopy.unknownNameGeneric;
    case "TS2307":
      return gateCopy.unresolvedImport;
    case "TS2353":
    case "TS2561":
      return gateCopy.unknownPropertyGeneric;
    case "TS2352":
      return /SQLOutputValue|Record<string, unknown>/.test(message)
        ? gateCopy.rowsCast
        : gateCopy.unrelatedCast;
    case "TS2741":
    case "TS2739":
      return gateCopy.missingProperties;
    case "TS2305":
    case "TS2724": {
      const module = MODULE_IN_MESSAGE.exec(message)?.[1] ?? "the module";
      const name = MEMBER_IN_MESSAGE.exec(message)?.[1] ?? "that name";
      return gateCopy.missingExportUnresolved(module, name);
    }
    case "lint/style/noUnusedTemplateLiteral":
      return gateCopy.noUnusedTemplateLiteral;
    case "lint/suspicious/noExplicitAny":
      return gateCopy.noExplicitAny;
    case "lint/style/useTemplate":
      return gateCopy.useTemplate;
    default:
      return undefined;
  }
}

/**
 * The names a TypeScript module exports, from the source index (T2).
 *
 * `export *` is followed through the index's resolver, so a barrel's names
 * are listed too (GT-M6-3). Returns undefined when the file cannot be read or
 * a star target cannot be resolved inside `root` (by default the file's own
 * directory), so the caller falls back to words rather than to a wrong list.
 */
export function moduleExports(file: string, root: string = dirname(file)): string[] | undefined {
  const index = createSourceIndex(root);
  const { names, complete } = index.exportedNames(relative(root, file));
  if (!complete) return undefined;
  // A default export is named by its local name, what a model would import it as.
  const local = index.facts(relative(root, file))?.exports.find((e) => e.name === "default")?.local;
  return [...new Set(names.flatMap((n) => (n !== "default" ? [n] : local ? [local] : [])))].sort();
}

/**
 * The names a module's own facts list: its exports (a default one by its
 * local name) and its named and namespace re-exports. Undefined for a module
 * with an `export *` when `stars` is "refuse".
 */
function listedExports(fx: SourceFacts, stars: "refuse" | "ignore"): string[] | undefined {
  if (stars === "refuse" && fx.reExports.some((r) => r.kind === "star")) return undefined;
  const names = new Set<string>();
  for (const e of fx.exports) {
    if (e.name === "default") {
      if (e.local) names.add(e.local);
    } else if (e.name !== "export=") names.add(e.name);
  }
  for (const r of fx.reExports) {
    if (r.kind === "named") for (const n of r.names) names.add(n.exported);
    else if (r.kind === "namespace" && r.namespace) names.add(r.namespace);
  }
  return [...names].sort();
}

/**
 * The names a TypeScript source text exports. One definition, used for a
 * file on disk and for a file's text at an earlier commit, so the two sides
 * of any comparison can never disagree about syntax.
 */
export function exportsFromSource(src: string): string[] {
  return listedExports(factsOfText("module.ts", src), "ignore") ?? [];
}

/** Where Node's type declarations live: hoisted, or inside pnpm's store. */
function nodeTypesDir(cwd: string): string | undefined {
  const hoisted = join(cwd, "node_modules", "@types", "node");
  if (existsSync(hoisted)) return hoisted;
  try {
    const store = join(cwd, "node_modules", ".pnpm");
    const newest = readdirSync(store)
      .filter((d) => d.startsWith("@types+node@"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .pop();
    return newest ? join(store, newest, "node_modules", "@types", "node") : undefined;
  } catch {
    return undefined;
  }
}

/** The exports of `declare module "<name>"` blocks in a declaration file. */
function ambientModuleExports(file: string, moduleName: string): string[] | undefined {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  if (!src.includes(`"${moduleName}"`)) return undefined;
  const block = factsOfText(file, src).ambientModules.find((m) => m.name === moduleName);
  return block ? listedExports(block.facts, "refuse") : undefined;
}

/** The real path, symlinks resolved; undefined when it cannot be read. */
function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` lies inside `dir`: nothing outside the worktree or package is read. */
function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** A package's own declaration entry point, when it ships one. */
function packageTypesFile(cwd: string, specifier: string): string | undefined {
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  const sub = parts.slice(specifier.startsWith("@") ? 2 : 1).join("/");
  for (const dir of [
    join(cwd, "node_modules", name),
    join(cwd, "node_modules", "@types", name.replace(/^@/, "").replace("/", "__")),
  ]) {
    if (!existsSync(dir)) continue;
    if (sub) {
      for (const c of [`${sub}.d.ts`, join(sub, "index.d.ts")]) {
        if (inside(dir, join(dir, c)) && existsSync(join(dir, c))) return join(dir, c);
      }
      continue;
    }
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        types?: string;
        typings?: string;
      };
      const entry = pkg.types ?? pkg.typings;
      if (entry && inside(dir, join(dir, entry)) && existsSync(join(dir, entry))) {
        return join(dir, entry);
      }
    } catch {
      // No readable manifest: try the conventional entry point.
    }
    if (existsSync(join(dir, "index.d.ts"))) return join(dir, "index.d.ts");
  }
  return undefined;
}

/** What a package or Node built-in module exports, from its declarations. */
function packageExports(specifier: string, cwd: string): string[] | undefined {
  const nodeTypes = nodeTypesDir(cwd);
  const bare = specifier.replace(/^node:/, "");
  if (nodeTypes) {
    const direct = join(nodeTypes, `${bare}.d.ts`);
    for (const name of [specifier, `node:${bare}`, bare]) {
      const hit = ambientModuleExports(direct, name);
      if (hit) return hit;
    }
  }
  const file = packageTypesFile(cwd, specifier);
  if (!file) return undefined;
  try {
    return listedExports(factsOfText(file, readFileSync(file, "utf8")), "refuse");
  } catch {
    return undefined;
  }
}

/** `Module '"./tokens.js"' has no exported member 'X'` -> the module's source path. */
function moduleFileFor(importer: string, specifier: string, cwd: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(cwd, dirname(importer), specifier.replace(/\.(m|c)?js$/, ""));
  for (const ext of [".ts", ".tsx", ".mts", ".cts", "/index.ts"]) {
    const file = `${base}${ext}`;
    if (inside(cwd, file) && existsSync(file)) return file;
  }
  return undefined;
}

/**
 * A missing export, answered rather than described (GT-M6-3).
 *
 * The generic remedy said "Read the module and use its actual export", and
 * the first frozen-suite run showed where that leads: a Worker read the
 * module four times, learned nothing it could act on, and was stopped for
 * repeating itself. A suggested action has to be completable in one step, so
 * this one carries what the model was being sent to fetch, for a project
 * module and for a package alike.
 */
function missingExportRemedy(
  code: string,
  message: string,
  importer: string,
  cwd: string | undefined,
): string | undefined {
  if ((code !== "TS2305" && code !== "TS2724") || !cwd) return undefined;
  const specifier = MODULE_IN_MESSAGE.exec(message)?.[1];
  if (!specifier) return undefined;
  const missing = MEMBER_IN_MESSAGE.exec(message)?.[1] ?? "that name";
  const target = moduleFileFor(importer, specifier, cwd);
  const names = target ? moduleExports(target, cwd) : packageExports(specifier, cwd);
  if (!names) return gateCopy.missingExportUnresolved(specifier, missing);
  const label = target ? relative(cwd, target) : specifier;
  if (names.length === 0) return gateCopy.missingExportNothing(label, missing);
  return gateCopy.missingExport(label, missing, names.join(", "));
}

/** The project's own source files, repository-relative, in a stable order. */
function projectSources(cwd: string): string[] {
  const out: string[] = [];
  const root = realOrUndefined(cwd);
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      // A symlink out of the worktree is not the project's source.
      const real = realOrUndefined(full);
      if (!root || !real || !inside(root, real)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
      } else if (/\.[cm]?tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
    }
  };
  walk(join(cwd, "src"), 4);
  return out;
}

/**
 * An unknown name, answered with the module that exports it (GT-M6-3): the
 * import to add — `import type` for an interface or type — rather than an
 * instruction to go and find it. Only `src/` is searched, and the remedy says
 * so; a barrel whose names cannot be listed sends the model to a search.
 */
function unknownNameRemedy(
  code: string,
  message: string,
  importer: string,
  cwd: string | undefined,
): string | undefined {
  if (code !== "TS2304" || !cwd) return undefined;
  const name = /Cannot find name '([^']+)'/.exec(message)?.[1];
  if (!name) return undefined;
  const importerAbs = resolve(cwd, importer);
  const index = createSourceIndex(cwd);
  let unlisted = false;
  for (const file of projectSources(cwd)) {
    if (file === importerAbs) continue;
    const names = moduleExports(file, cwd);
    if (!names) unlisted = true;
    if (!names?.includes(name)) continue;
    let specifier = relative(dirname(importerAbs), file).replace(/\.(m|c)?tsx?$/, ".js");
    if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    const fx = index.facts(file);
    const exported = fx?.exports.find((e) => e.name === name);
    const typeOnly = Boolean(
      exported?.typeOnly ||
        fx?.declarations.some(
          (d) => d.topLevel && d.name === (exported?.local ?? name) && d.typeOnly,
        ),
    );
    return gateCopy.unknownName(name, relative(cwd, file), specifier, typeOnly);
  }
  return unlisted ? gateCopy.unknownNameSearch(name) : gateCopy.unknownNameNowhere(name);
}

/**
 * An unknown member, answered with the type's real members (GT-M6-3).
 *
 * Suite runs 4 and 5 lost cards on two different models the same way: the
 * model guessed a library API (`db.lastInsertRowId`, `{ create: true }`), the
 * error said the member does not exist, and the model went looking for the
 * declaration — Cyber-Tiel asked tool_search for it eight times — until it was
 * stopped. The failure carries what it was looking for, and says "exactly"
 * only when the list is complete and uncut.
 */
function unknownMemberRemedy(
  code: string,
  message: string,
  cache: DeclarationCache | undefined,
): string | undefined {
  if (!["TS2339", "TS2353", "TS2551"].includes(code)) return undefined;
  const m = /'([^']+)' does not exist (?:on|in) type '([A-Za-z_$][\w$]*)(?:<[^']*>)?'/.exec(
    message,
  );
  const member = m?.[1];
  const type = m?.[2];
  if (!member || !type) return undefined;
  const found = cache ? typeMembers(type, cache) : undefined;
  if (found && found.names.length > 0) {
    const list = found.names.slice(0, MAX_MEMBERS_SHOWN).join(", ");
    return found.complete && found.names.length <= MAX_MEMBERS_SHOWN
      ? gateCopy.unknownMember(type, member, list)
      : gateCopy.unknownMemberPartial(type, member, list);
  }
  if (code === "TS2339" && /\| undefined\b|undefined'/.test(message)) return gateCopy.narrow;
  return code === "TS2353"
    ? gateCopy.unknownPropertyNotFound(member, type)
    : gateCopy.unknownMemberNotFound(type, member);
}

/** The most members a remedy lists; a longer list is cut and says so. */
const MAX_MEMBERS_SHOWN = 40;
/** Declaration files larger than this are not read for members. */
const MAX_DECLARATION_BYTES = 2_000_000;
/** The most declaration files one parse reads. */
const MAX_DECLARATION_FILES = 3_000;

/**
 * What one parse has read: the files that may declare a type, their text and
 * their syntax trees. Built once per parse, so seven failures do not walk
 * `node_modules` seven times.
 */
interface DeclarationCache {
  cwd: string;
  files?: string[];
  texts: Map<string, string | undefined>;
  trees: Map<string, ts.SourceFile>;
}

function declarationCache(cwd: string | undefined): DeclarationCache | undefined {
  return cwd ? { cwd, texts: new Map(), trees: new Map() } : undefined;
}

/**
 * Files that may declare a type: the project's source, Node's own types and
 * the declarations of the packages the project depends on.
 */
function declarationFiles(cache: DeclarationCache): string[] {
  if (cache.files) return cache.files;
  const { cwd } = cache;
  const out: string[] = [];
  // Each walk stays inside the directory it starts from, symlinks resolved:
  // the worktree's src/, Node's types, a dependency's own directory.
  const walk = (dir: string, depth: number, suffix: RegExp, root = realOrUndefined(dir)) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_DECLARATION_FILES) return;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      const real = realOrUndefined(full);
      if (!root || !real || !inside(root, real)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth > 0) walk(full, depth - 1, suffix, root);
      } else if (suffix.test(name) && st.size <= MAX_DECLARATION_BYTES) out.push(full);
    }
  };
  walk(join(cwd, "src"), 4, /\.[cm]?tsx?$/);
  const nodeTypes = nodeTypesDir(cwd);
  if (nodeTypes) walk(nodeTypes, 1, /\.d\.ts$/);
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const file = packageTypesFile(cwd, dep);
      if (file) walk(dirname(file), 1, /\.d\.[cm]?ts$/);
    }
  } catch {
    // No manifest: the project's sources and Node's types are searched.
  }
  cache.files = out;
  return out;
}

function textOf(cache: DeclarationCache, file: string): string | undefined {
  if (!cache.texts.has(file)) {
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = undefined;
    }
    cache.texts.set(file, text);
  }
  return cache.texts.get(file);
}

function treeOf(cache: DeclarationCache, file: string, text: string): ts.SourceFile {
  let tree = cache.trees.get(file);
  if (!tree) {
    tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    cache.trees.set(file, tree);
  }
  return tree;
}

function memberName(member: ts.ClassElement | ts.TypeElement): string | undefined {
  if (ts.isConstructorDeclaration(member) || ts.isIndexSignatureDeclaration(member)) {
    return undefined;
  }
  // Statics are not members of the instance type; private and protected ones
  // cannot be used from outside.
  const hidden = (ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : []).some((m) =>
    [
      ts.SyntaxKind.StaticKeyword,
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
    ].includes(m.kind),
  );
  const name = member.name;
  if (hidden || !name || ts.isPrivateIdentifier(name)) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * The members of the interface, class or object type named `type`, from the
 * syntax tree: methods (async too), accessors, properties with or without an
 * initialiser, and the members it inherits through `extends`. `complete` is
 * false when a base type could not be read.
 */
function typeMembers(
  type: string,
  cache: DeclarationCache,
  seen: Set<string> = new Set(),
): { names: string[]; complete: boolean } | undefined {
  if (seen.has(type)) return { names: [], complete: true };
  seen.add(type);
  const names = new Set<string>();
  let found = false;
  let complete = true;
  const inherit = (clauses: ts.NodeArray<ts.HeritageClause> | undefined) => {
    for (const clause of clauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const t of clause.types) {
        const e = t.expression;
        const base = ts.isIdentifier(e)
          ? e.text
          : ts.isPropertyAccessExpression(e)
            ? e.name.text
            : undefined;
        const sub = base ? typeMembers(base, cache, seen) : undefined;
        if (!sub) complete = false;
        else {
          for (const n of sub.names) names.add(n);
          complete &&= sub.complete;
        }
      }
    }
  };
  const visit = (statements: ts.NodeArray<ts.Statement>) => {
    for (const s of statements) {
      if (ts.isModuleDeclaration(s) && s.body && ts.isModuleBlock(s.body)) {
        visit(s.body.statements);
      } else if (
        (ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s)) &&
        s.name?.text === type
      ) {
        found = true;
        for (const m of s.members as ts.NodeArray<ts.ClassElement | ts.TypeElement>) {
          const n = memberName(m);
          if (n) names.add(n);
        }
        inherit(s.heritageClauses);
      } else if (ts.isTypeAliasDeclaration(s) && s.name.text === type) {
        found = true;
        if (ts.isTypeLiteralNode(s.type)) {
          for (const m of s.type.members) {
            const n = memberName(m);
            if (n) names.add(n);
          }
        } else complete = false;
      }
    }
  };
  // A type declared in more than one file may be two types, or one merged
  // across files: either way the union is not "exactly" its members.
  let files = 0;
  for (const file of declarationFiles(cache)) {
    const text = textOf(cache, file);
    if (!text?.includes(type)) continue;
    const before: boolean = found;
    found = false;
    visit(treeOf(cache, file, text).statements);
    if (found) files++;
    found ||= before;
  }
  if (files > 1) complete = false;
  return found ? { names: [...names].sort(), complete } : undefined;
}

/** A repository-relative path for a path a tool printed. */
function repoPath(file: string, cwd: string | undefined): string {
  const plain = file.replace(/^\.\//, "");
  return cwd && isAbsolute(plain) ? relative(cwd, plain) : plain;
}

/** `src/a.ts(12,5): error TS2345: message` */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/;

const tscParser: FailureParser = (ctx) => {
  const failures: CompleteGateFailure[] = [];
  const cache = declarationCache(ctx.cwd);
  const lines = `${ctx.stdout}\n${ctx.stderr}`.split("\n");

  for (const line of lines) {
    const m = TSC_LINE.exec(line.trim());
    if (!m) continue;
    const [, rawFile, lineNo, col, code = "", message = ""] = m;
    if (!rawFile) continue;
    const file = repoPath(rawFile, ctx.cwd);

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
        missingExportRemedy(code, message, file, ctx.cwd) ??
        unknownNameRemedy(code, message, file, ctx.cwd) ??
        unknownMemberRemedy(code, message, cache) ??
        remedyFor(code, message) ??
        gateCopy.resolveCode(code, file, String(location.line)),
    });
  }

  return failures;
};

/** Quote one shell word. */
function shellQuote(word: string): string {
  return /^[\w./:=@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `-t` takes a pattern: match the test's full name exactly. */
function testNamePattern(fullName: string): string {
  return `^${fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

/** Expected and actual from an assertion message, when it states both. */
function assertionValues(message: string): { expected?: string; actual?: string } {
  const m =
    /expected (.+?) to (?:be|equal|deeply equal|strictly equal|be close to|have length|contain|be greater than|be less than) (.+?)(?:\s+\/\/.*)?$/.exec(
      message,
    );
  return m?.[1] && m[2] ? { actual: m[1], expected: m[2] } : {};
}

interface TestFailure {
  file: string;
  /** Describe blocks and the test's title, outermost first; empty for a file-level error. */
  names: string[];
  message: string;
  detail: string[];
  line?: number;
  column?: number;
  expected?: string;
  actual?: string;
}

/** One failing test (or one file that failed to load) as one failure (rule 22). */
function testFailure(ctx: ParseContext, t: TestFailure): CompleteGateFailure {
  const fullName = t.names.join(" ");
  const values = assertionValues(t.message);
  const expected = t.expected ?? values.expected ?? "the test to pass";
  const actual = t.actual ?? values.actual ?? (t.message || "the test failed");
  const where = [t.file, ...(t.line !== undefined ? [String(t.line)] : [])].join(":");
  return {
    rung: ctx.gate.rung,
    gate: ctx.gate.id,
    layer: ctx.gate.layer,
    exitCode: ctx.exitCode,
    errorExcerpt: [
      `${where} ${t.names.length ? t.names.join(" > ") : "(the file failed)"}`,
      t.message,
      ...t.detail,
    ]
      .filter(Boolean)
      .join("\n"),
    suggestedFixFiles: dedupe([t.file].filter((f) => /\.[cm]?[jt]sx?$/.test(f))),
    location: {
      file: t.file,
      ...(t.line !== undefined ? { line: t.line } : {}),
      ...(t.column !== undefined ? { column: t.column } : {}),
    },
    expected,
    actual,
    minimalRepro: [
      ctx.minimalRepro,
      shellQuote(t.file),
      ...(fullName ? ["-t", shellQuote(testNamePattern(fullName))] : []),
    ].join(" "),
    suggestedAction: gateCopy.testAssertion,
  };
}

/** `file:line:col` of the test file in a stack or a `❯` pointer. */
function testLocation(text: string, file: string): { line: number; column: number } | undefined {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(text);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : undefined;
}

/** Vitest's (and Jest's) `--reporter=json` report. */
function vitestJson(ctx: ParseContext): TestFailure[] | undefined {
  // Vitest opens with numTotalTestSuites, Jest with numFailedTestSuites.
  const at = ctx.stdout.search(/\{"num(?:Total|Failed|Passed|Pending)TestSuites"/);
  if (at < 0) return undefined;
  let report: {
    testResults?: {
      name: string;
      status?: string;
      message?: string;
      assertionResults?: {
        ancestorTitles?: string[];
        title?: string;
        status?: string;
        failureMessages?: string[];
        location?: { line?: number; column?: number } | null;
      }[];
    }[];
  };
  try {
    report = JSON.parse(ctx.stdout.slice(at));
  } catch {
    return undefined;
  }
  const out: TestFailure[] = [];
  for (const suite of report.testResults ?? []) {
    const file = repoPath(suite.name, ctx.cwd);
    const failed = (suite.assertionResults ?? []).filter((a) => a.status === "failed");
    for (const a of failed) {
      const text = (a.failureMessages ?? []).join("\n");
      const where =
        testLocation(text, suite.name) ??
        (a.location?.line ? { line: a.location.line, column: a.location.column ?? 0 } : undefined);
      out.push({
        file,
        names: [...(a.ancestorTitles ?? []), a.title ?? ""].filter(Boolean),
        message: text.split("\n")[0]?.replace(/^\w*Error:\s*/, "") ?? "",
        detail: [],
        ...(where ? { line: where.line, column: where.column } : {}),
      });
    }
    if (failed.length === 0 && suite.status === "failed") {
      out.push({
        file,
        names: [],
        message: (suite.message ?? "").split("\n").find((l) => l.trim()) ?? "",
        detail: [],
      });
    }
  }
  return out;
}

/** Vitest's default reporter: one `FAIL file > … > test` block per failing test. */
function vitestText(ctx: ParseContext): TestFailure[] {
  const lines = `${ctx.stdout}\n${ctx.stderr}`.split("\n");
  const out: TestFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^\s*FAIL\s+(\S+)(?:\s+>\s+(.+?))?(?:\s+\[.*\])?\s*$/.exec(lines[i] as string);
    if (!header?.[1]) continue;
    const file = repoPath(header[1], ctx.cwd);
    const names = (header[2] ?? "")
      .split(" > ")
      .map((n) => n.trim())
      .filter(Boolean);
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] as string;
      if (/^\s*FAIL\s/.test(next) || /^⎯{3,}/.test(next.trim())) break;
      block.push(next);
    }
    const message =
      block
        .map((l) => l.trim())
        .find((l) => l && !NOISE.test(l))
        ?.replace(/^\w*Error:\s*/, "") ?? "";
    // `- Expected` / `+ Received`, then the values as `- …` and `+ …` lines.
    const diffStart = block.findIndex((l) => /^\s*\+ Received\s*$/.test(l));
    const minus: string[] = [];
    const plus: string[] = [];
    if (diffStart >= 0) {
      for (const l of block.slice(diffStart + 1)) {
        if (/^\s*❯/.test(l)) break;
        if (/^- /.test(l)) minus.push(l.slice(2));
        else if (/^\+ /.test(l)) plus.push(l.slice(2));
      }
    }
    const where = testLocation(block.join("\n"), file);
    out.push({
      file,
      names,
      message,
      detail: block
        .map((l) => l.trimEnd())
        .filter((l) => /^[-+] /.test(l))
        .slice(0, 6),
      ...(where ? { line: where.line, column: where.column } : {}),
      ...(minus.length ? { expected: minus.join("\n") } : {}),
      ...(plus.length ? { actual: plus.join("\n") } : {}),
    });
  }
  // One failing test is one failure: the run listing (`×`) and the summary
  // (`FAIL`) name the same test.
  const seen = new Set<string>();
  return out.filter((t) => {
    const key = `${t.file}\u0000${t.names.join(" > ")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const vitestParser: FailureParser = (ctx) =>
  (vitestJson(ctx) ?? vitestText(ctx)).map((t) => testFailure(ctx, t));

/** `cargo test`: a `---- name stdout ----` block per failing test; compiler errors by `-->`. */
const cargoParser: FailureParser = (ctx) => {
  const lines = `${ctx.stdout}\n${ctx.stderr}`.split("\n");
  const failures: CompleteGateFailure[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const test = /^---- (\S+) stdout ----$/.exec(line.trim());
    if (test?.[1]) {
      const block: string[] = [];
      for (let j = i + 1; j < lines.length && !/^(----|failures:)/.test(lines[j] as string); j++) {
        block.push(lines[j] as string);
      }
      const panic = /panicked at ([^:]+):(\d+):(\d+):/.exec(block.join("\n"));
      const left = block.find((l) => /^\s*left:/.test(l))?.replace(/^\s*left:\s*/, "");
      const right = block.find((l) => /^\s*right:/.test(l))?.replace(/^\s*right:\s*/, "");
      const message =
        block.map((l) => l.trim()).find((l) => l && !l.startsWith("thread ")) ?? "the test failed";
      const file = panic?.[1] ?? ".";
      failures.push({
        rung: ctx.gate.rung,
        gate: ctx.gate.id,
        layer: ctx.gate.layer,
        exitCode: ctx.exitCode,
        errorExcerpt: [`${test[1]} failed`, ...block.map((l) => l.trim()).filter(Boolean)]
          .slice(0, 8)
          .join("\n"),
        suggestedFixFiles: panic?.[1] ? [panic[1]] : [],
        location: {
          file,
          ...(panic ? { line: Number(panic[2]), column: Number(panic[3]) } : {}),
        },
        expected: right ?? "the test to pass",
        actual: left ?? message,
        minimalRepro: `${ctx.minimalRepro} ${shellQuote(test[1])} -- --exact`,
        suggestedAction: gateCopy.testAssertion,
      });
      continue;
    }
    const error = /^error(\[E\d+\])?: (.+)$/.exec(line.trim());
    const at = /^\s*--> ([^:]+):(\d+):(\d+)/.exec(lines[i + 1] ?? "");
    if (error && at?.[1]) {
      failures.push({
        rung: ctx.gate.rung,
        gate: ctx.gate.id,
        layer: ctx.gate.layer,
        exitCode: ctx.exitCode,
        errorExcerpt: `${at[1]}:${at[2]}:${at[3]} ${error[1] ?? "error"}: ${error[2]}`,
        suggestedFixFiles: [at[1]],
        location: { file: at[1], line: Number(at[2]), column: Number(at[3]) },
        expected: "a program that compiles",
        actual: `${error[1] ? `${error[1].slice(1, -1)}: ` : ""}${error[2]}`,
        minimalRepro: ctx.minimalRepro,
        suggestedAction: gateCopy.resolveCode(
          error[1]?.slice(1, -1) ?? "the error",
          at[1],
          at[2] ?? "1",
        ),
      });
    }
  }
  return failures;
};

/**
 * Biome diagnostics: `path/file.ts:12:5 lint/rule ... × message`, and the
 * whole-file `path/file.ts format` and `organizeImports` diagnostics.
 */
const biomeParser: FailureParser = (ctx) => {
  const combined = `${ctx.stdout}\n${ctx.stderr}`;
  const failures: CompleteGateFailure[] = [];
  const header = /^(.+?):(\d+):(\d+)\s+(\S+)/;
  const wholeFile = /^(\S+?)\s+(format|organizeImports)\s+━/;
  const lines = combined.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    const m = header.exec(trimmed);
    const w = m ? undefined : wholeFile.exec(trimmed);
    if (!m && !w) continue;
    const rawFile = (m?.[1] ?? w?.[1]) as string;
    const rule = (m?.[4] ?? w?.[2]) as string;
    const file = repoPath(rawFile, ctx.cwd);
    const lineNo = m ? Number.parseInt(m[2] ?? "1", 10) : 1;
    const col = m ? Number.parseInt(m[3] ?? "1", 10) : 1;

    const following = lines.slice(i + 1, i + 16).map((l) => l.trim());
    const message: string =
      following.find((l) => l.startsWith("×"))?.replace(/^×\s*/, "") ?? rule ?? "lint violation";
    const changes = w ? following.filter((l) => /│ [-+] /.test(l)).slice(0, 8) : [];

    failures.push({
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: [`${file}:${lineNo}:${col} ${rule}: ${message}`, ...changes].join("\n"),
      suggestedFixFiles: [file],
      location: { file, line: lineNo, column: col },
      expected: `no ${rule} violations`,
      actual: message,
      minimalRepro: ctx.minimalRepro,
      suggestedAction: w
        ? gateCopy.formatFile(file)
        : (remedyFor(rule, message) ?? gateCopy.lintRule(rule, file, String(lineNo))),
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
  const first = [...files][0];

  return [
    {
      rung: ctx.gate.rung,
      gate: ctx.gate.id,
      layer: ctx.gate.layer,
      exitCode: ctx.exitCode,
      errorExcerpt: excerpt || `Gate ${ctx.gate.id} failed with exit code ${ctx.exitCode}`,
      suggestedFixFiles: [...files],
      location: { file: first ?? "." },
      expected: `${ctx.gate.id} to exit 0`,
      actual: `exit code ${ctx.exitCode}`,
      minimalRepro: ctx.minimalRepro || RERUN_GATES,
      suggestedAction: gateCopy.rerun(ctx.minimalRepro || RERUN_GATES),
    },
  ];
};

/** The sandbox's mark on output it cut at its buffer cap (`sandbox/src/executor.ts`). */
const TRUNCATED = /\[output truncated at \d+ bytes\]/;
/** An error the runner reported outside any one test: an unhandled error or rejection. */
const UNHANDLED = /Unhandled (?:Errors?|Rejection)|^\s*Errors\s+\d+ errors?\b/m;

/**
 * Whether every failure in a non-zero exit's output was read (review M1): a
 * JSON or JUnit report, or a summary whose counts equal the failures parsed,
 * with nothing cut by the output cap and no error outside a test. Only a
 * run read in full may have its failures forgiven into a pass (the
 * baseline, a supersession, a quarantine); otherwise `gap` says what was not
 * read.
 */
export function readInFull(
  ctx: ParseContext,
  failures: readonly CompleteGateFailure[],
): { inFull: true } | { inFull: false; gap: string } {
  const text = `${ctx.stdout}\n${ctx.stderr}`;
  if (TRUNCATED.test(text)) {
    return { inFull: false, gap: "its output was cut at the sandbox's output cap" };
  }
  const named = failures.filter((f) => f.location.file !== "." && !f.notRun);
  if (named.length < failures.length) {
    return { inFull: false, gap: "part of its output names no file or test" };
  }
  const args = ctx.gate.args.join(" ");
  switch (ctx.gate.parser) {
    case "vitest":
    case "jest": {
      if (UNHANDLED.test(text)) {
        return { inFull: false, gap: "the runner reported an error outside any test" };
      }
      if (/--reporter[= ]junit/.test(args)) return { inFull: true };
      if (/\{"num(?:Total|Failed|Passed|Pending)TestSuites"/.test(ctx.stdout))
        return { inFull: true };
      const tests = /^\s*Tests\s+(\d+) failed/m.exec(text);
      // A file that failed to load is read as its own failure, not a test.
      const perTest = named.filter((f) => !/\(the file failed\)/.test(f.errorExcerpt)).length;
      if (!tests) return { inFull: false, gap: "its summary names no count of failed tests" };
      if (Number(tests[1]) !== perTest) {
        return {
          inFull: false,
          gap: `its summary counts ${tests[1]} failed tests, and ${perTest} were read`,
        };
      }
      return { inFull: true };
    }
    case "tsc":
    case "typescript": {
      const lines = text.split("\n").filter((l) => /\berror TS\d+:/.test(l)).length;
      const found = /Found (\d+) errors?/.exec(text);
      if (found && Number(found[1]) !== named.length) {
        return {
          inFull: false,
          gap: `its summary counts ${found[1]} errors, and ${named.length} were read`,
        };
      }
      if (lines === 0 || lines !== named.length) {
        return {
          inFull: false,
          gap: `it printed ${lines} error lines, and ${named.length} were read`,
        };
      }
      return { inFull: true };
    }
    case "biome":
    case "eslint": {
      if (/--reporter[= ]json/.test(args) || /--format[= ]json/.test(args)) return { inFull: true };
      const found = /Found (\d+) errors?/.exec(text);
      if (found && Number(found[1]) === named.length) return { inFull: true };
      return { inFull: false, gap: "its summary does not match the findings read" };
    }
    default:
      return {
        inFull: false,
        gap: `the ${ctx.gate.parser} parser cannot tell whether it read every failure`,
      };
  }
}

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
    ["cargo", cargoParser],
    ["generic", genericParser],
  ]);

  public register(name: string, parser: FailureParser): void {
    this.parsers.set(name, parser);
  }

  public parse(ctx: ParseContext): CompleteGateFailure[] {
    const parser = this.parsers.get(ctx.gate.parser) ?? genericParser;
    const failures = parser(ctx);
    // A parser that matched nothing must still report the failure.
    return failures.length > 0 ? failures : genericParser(ctx);
  }
}

export const defaultParserRegistry = new FailureParserRegistry();
