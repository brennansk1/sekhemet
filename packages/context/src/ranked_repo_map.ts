import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { estimatePromptTokens } from "./allocator.js";

/**
 * The repo map (C1, design "Pipeline stages" and "Hierarchical
 * localization"): a TypeScript-compiler outline of each source file, a
 * graph of reference edges between files (imports, and uses of another
 * file's exported names), personalised PageRank seeded on the card's scope
 * files, and a binary search over how many ranked files fit the token
 * budget. Files defining an identifier the card's spec names are weighted
 * up (CX-N5-1). The output is byte-stable for the same tree, scope, spec and
 * budget, and cached by a key over file paths and content hashes, so a
 * change that keeps a file's size and mtime still rebuilds it (CX-N5-2).
 */
export interface RepoMapOptions {
  scopeFiles?: string[];
  /** Token budget for the map. Default 1,200. */
  budgetTokens?: number;
  /** Most files scanned. Default 400. */
  maxFiles?: number;
  /** PageRank damping. Default 0.85. */
  damping?: number;
  /**
   * The card's spec: a file defining an identifier it names is ranked above
   * an otherwise equal file (CX-N5-1).
   */
  specText?: string;
}

/** Teleport weight added to a file defining a spec-named identifier (per scope seed: 1). */
export const SPEC_TELEPORT_WEIGHT = 0.5;

const SPEC_STOP = new Set(
  "the and for with from that this into when then than not use make return value should must".split(
    " ",
  ),
);

/** The identifiers a spec names: code-like words of three characters or more, unique, sorted. */
export function specIdentifiers(spec: string): string[] {
  const out = new Set<string>();
  for (const m of spec.matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
    const w = m[0];
    if (!SPEC_STOP.has(w.toLowerCase())) out.add(w);
  }
  return [...out].sort();
}

export interface FileOutline {
  path: string;
  /** Rendered declaration lines (signatures, no bodies). */
  lines: string[];
  exports: string[];
  imports: string[];
  /** Identifiers referenced in the file. */
  identifiers: Set<string>;
}

export interface RankedRepoMap {
  text: string;
  files: { path: string; rank: number }[];
  /** Files in the tree that were considered. */
  considered: number;
  usedTokens: number;
  cacheKey: string;
  fromCache: boolean;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".sekhemet",
  "coverage",
  ".next",
  "build",
]);
const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mts|cts)$/;
const MAX_FILE_BYTES = 256 * 1024;

function listSources(root: string, maxFiles: number): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue;
      const abs = join(dir, name);
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(abs);
      } catch {
        continue;
      }
      if (info.isDirectory()) stack.push(abs);
      else if (
        info.isFile() &&
        SOURCE_EXT.test(name) &&
        !name.endsWith(".d.ts") &&
        info.size <= MAX_FILE_BYTES
      ) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function text(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, " ").trim();
}

function signatureOf(node: ts.Node, sf: ts.SourceFile): string {
  const full = text(node, sf);
  // Cut at the body: the first `{` that opens a block after the parameters, or `=` for values.
  if (ts.isVariableStatement(node)) {
    return full.split("=")[0]?.trim() ?? full;
  }
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isClassDeclaration(node)
  ) {
    return full.split("{")[0]?.trim() ?? full;
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return full.length > 140 ? `${full.slice(0, 137)}...` : full;
  }
  const body = (node as ts.FunctionLikeDeclaration).body;
  if (body) return full.slice(0, full.length - text(body, sf).length).trim();
  return full;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/** Parse one file into its outline with the TypeScript compiler (no type check). */
export function outlineFile(path: string, source: string): FileOutline {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false);
  const lines: string[] = [];
  const exports: string[] = [];
  const imports: string[] = [];
  const identifiers = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      imports.push(stmt.moduleSpecifier.text);
      continue;
    }
    if (
      ts.isExportDeclaration(stmt) &&
      stmt.moduleSpecifier &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      imports.push(stmt.moduleSpecifier.text);
      continue;
    }
    const exported = isExported(stmt);
    const names: string[] = [];
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name) names.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.push(d.name.text);
      }
    } else continue;
    if (!exported) continue;
    exports.push(...names);
    lines.push(`  ${signatureOf(stmt, sf)}`);
    if (ts.isClassDeclaration(stmt)) {
      for (const m of stmt.members) {
        const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
        if (mods?.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) continue;
        if (ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m)) {
          lines.push(`    ${signatureOf(m, sf)}`);
        }
      }
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) identifiers.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { path, lines, exports, imports, identifiers };
}

function resolveImport(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = join(dirname(from), spec).replace(/\\/g, "/");
  const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
    `${stem}/index.js`,
  ];
  return candidates.find((c) => known.has(c));
}

/**
 * Personalised PageRank over a directed graph (edges from referencing file
 * to referenced file). The teleport vector is concentrated on `seeds`
 * (uniform when there are none). Deterministic: fixed iteration count.
 */
export function personalizedPageRank(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlyMap<string, number>>,
  seeds: readonly string[],
  damping = 0.85,
  iterations = 40,
  /** Extra teleport weight per node (a spec-named definition, CX-N5-1). */
  boost: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const seedSet = new Set(seeds.filter((s) => nodes.includes(s)));
  const teleport = new Map<string, number>();
  let mass = 0;
  for (const v of nodes) {
    const w = (seedSet.size > 0 ? (seedSet.has(v) ? 1 : 0) : 1) + (boost.get(v) ?? 0);
    teleport.set(v, w);
    mass += w;
  }
  for (const v of nodes) teleport.set(v, mass > 0 ? (teleport.get(v) ?? 0) / mass : 0);
  let rank = new Map(teleport);
  const outWeight = new Map<string, number>();
  for (const v of nodes) {
    let w = 0;
    for (const x of edges.get(v)?.values() ?? []) w += x;
    outWeight.set(v, w);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    for (const v of nodes) next.set(v, (1 - damping) * (teleport.get(v) ?? 0));
    let dangling = 0;
    for (const v of nodes) {
      const r = rank.get(v) ?? 0;
      const total = outWeight.get(v) ?? 0;
      if (total === 0) {
        dangling += r;
        continue;
      }
      for (const [to, w] of edges.get(v) ?? []) {
        next.set(to, (next.get(to) ?? 0) + (damping * r * w) / total);
      }
    }
    // Dangling mass returns through the teleport vector.
    for (const v of nodes)
      next.set(v, (next.get(v) ?? 0) + damping * dangling * (teleport.get(v) ?? 0));
    rank = next;
  }
  return rank;
}

const cache = new Map<string, RankedRepoMap>();

function render(files: FileOutline[]): string {
  return files
    .map((f) =>
      f.lines.length > 0 ? `${f.path}:\n${f.lines.join("\n")}` : `${f.path}: (no exports)`,
    )
    .join("\n\n");
}

/** Build the ranked, budgeted repo map for `root`. */
export function buildRankedRepoMap(root: string, options: RepoMapOptions = {}): RankedRepoMap {
  const absRoot = resolve(root);
  const budget = options.budgetTokens ?? 1200;
  const scope = (options.scopeFiles ?? []).map((f) => f.replace(/^\.\//, ""));
  const abs = existsSync(absRoot) ? listSources(absRoot, options.maxFiles ?? 400) : [];
  // CX-N5-2: the key hashes each file's content, not its size and mtime.
  const sources = new Map<string, string>();
  for (const p of abs) {
    try {
      sources.set(relative(absRoot, p).replace(/\\/g, "/"), readFileSync(p, "utf8"));
    } catch {
      // Unreadable: omit.
    }
  }
  const stamp = [...sources]
    .map(([rel, source]) => `${rel}:${createHash("sha256").update(source).digest("hex")}`)
    .join("|");
  const specIds = options.specText ? specIdentifiers(options.specText) : [];
  const cacheKey = createHash("sha256")
    .update(`${stamp}#${scope.join(",")}#${budget}#${options.damping ?? 0.85}#${specIds.join(",")}`)
    .digest("hex")
    .slice(0, 16);
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const outlines = new Map<string, FileOutline>();
  for (const [rel, source] of sources) {
    try {
      outlines.set(rel, outlineFile(rel, source));
    } catch {
      // Unparseable: omit.
    }
  }
  const nodes = [...outlines.keys()].sort();
  const known = new Set(nodes);
  // Who exports each name (a name exported by many files gives each a share).
  const exporters = new Map<string, string[]>();
  for (const [path, o] of outlines) {
    for (const name of o.exports) exporters.set(name, [...(exporters.get(name) ?? []), path]);
  }
  const edges = new Map<string, Map<string, number>>();
  const addEdge = (from: string, to: string, w: number) => {
    if (from === to) return;
    const m = edges.get(from) ?? new Map<string, number>();
    m.set(to, (m.get(to) ?? 0) + w);
    edges.set(from, m);
  };
  for (const [path, o] of outlines) {
    for (const spec of o.imports) {
      const target = resolveImport(path, spec, known);
      if (target) addEdge(path, target, 1);
    }
    for (const id of o.identifiers) {
      const owners = exporters.get(id);
      if (!owners || owners.length > 5) continue;
      for (const owner of owners) addEdge(path, owner, 1 / owners.length);
    }
  }
  // Scope files also rank the files that use them (reverse edges, half weight):
  // a change there must keep its callers compiling.
  const scopeSet = new Set(scope);
  for (const [from, m] of [...edges]) {
    for (const to of m.keys()) if (scopeSet.has(to)) addEdge(to, from, 0.5);
  }
  // CX-N5-1: files defining an identifier the spec names are weighted up.
  const boost = new Map<string, number>();
  for (const id of specIds) {
    for (const owner of exporters.get(id) ?? []) boost.set(owner, SPEC_TELEPORT_WEIGHT);
  }
  const rank = personalizedPageRank(nodes, edges, scope, options.damping ?? 0.85, 40, boost);
  const ordered = [...nodes].sort((a, b) => {
    const sa = scopeSet.has(a) ? 1 : 0;
    const sb = scopeSet.has(b) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    const d = (rank.get(b) ?? 0) - (rank.get(a) ?? 0);
    return Math.abs(d) > 1e-12 ? d : a.localeCompare(b);
  });

  // Binary search the largest prefix of the ranking that fits the budget.
  const outlineList = ordered.map((p) => outlines.get(p) as FileOutline);
  let lo = 0;
  let hi = outlineList.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimatePromptTokens(render(outlineList.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const chosen = outlineList.slice(0, lo);
  const textOut = render(chosen);
  const result: RankedRepoMap = {
    text: textOut,
    files: chosen.map((f) => ({
      path: f.path,
      rank: Math.round((rank.get(f.path) ?? 0) * 1e6) / 1e6,
    })),
    considered: nodes.length,
    usedTokens: estimatePromptTokens(textOut),
    cacheKey,
    fromCache: false,
  };
  if (cache.size > 32) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, result);
  return result;
}
