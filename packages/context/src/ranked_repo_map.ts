import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  type DeclarationFact,
  type SourceFacts,
  type SourceIndex,
  TYPESCRIPT_PARSER_VERSION,
  type WorkspacePackageFact,
  createSourceIndex,
  factsOfText,
} from "@sekhemet/gates";
import { estimatePromptTokens } from "./allocator.js";

/**
 * The repo map (C1, design "Pipeline stages" and "Hierarchical
 * localization"): an outline of each source file from the source index's
 * facts (gates T2; context rule 13b), a
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
  /** The parser that produced the outlines (CX-IX-3). */
  producedBy: { parser: string; parserVersion: string };
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

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A declaration's signature: its text up to the body, or up to `=` for a value (bodies are never shown). */
function signatureOf(d: DeclarationFact, source: string): string {
  const full = collapse(source.slice(d.start, d.end));
  if (d.kind === "const" || d.kind === "let" || d.kind === "var") {
    return full.split("=")[0]?.trim() ?? full;
  }
  if (d.kind === "interface" || d.kind === "enum" || d.kind === "class") {
    return full.split("{")[0]?.trim() ?? full;
  }
  if (d.kind === "type") return full.length > 140 ? `${full.slice(0, 137)}...` : full;
  if (d.bodyOpen !== -1) return collapse(source.slice(d.start, d.bodyOpen));
  return full;
}

const OUTLINED = new Set(["function", "class", "interface", "type", "enum", "const", "let", "var"]);

/**
 * One file's outline from the source index's facts (gates T2, context rule
 * 13b): the signatures of the declarations it exports where it declares
 * them, with an exported class's non-private methods; the modules it
 * imports and re-exports from; and every name it declares or uses.
 */
export function outlineFile(path: string, source: string): FileOutline {
  return outlineOfFacts(factsOfText(path, source), source);
}

function outlineOfFacts(facts: SourceFacts, source: string): FileOutline {
  const lines: string[] = [];
  const exports: string[] = [];
  const decls = [...facts.declarations].sort((a, b) => a.start - b.start);
  for (const d of decls) {
    if (!d.topLevel || !d.exportedAtDeclaration || !OUTLINED.has(d.kind)) continue;
    exports.push(d.name);
    // A statement declaring several names is one line, written at its first.
    if (source.startsWith("export", d.start)) lines.push(`  ${signatureOf(d, source)}`);
    if (d.kind !== "class") continue;
    for (const m of decls) {
      if (
        m.kind === "method" &&
        m.container === d.name &&
        m.containerKind === "class" &&
        m.start > d.start &&
        m.end <= d.end &&
        !m.accessor &&
        m.visibility !== "private"
      ) {
        lines.push(`    ${signatureOf(m, source)}`);
      }
    }
  }
  const imports = [
    ...facts.imports
      .filter((i) => i.kind !== "dynamic" && i.kind !== "require")
      .map((i) => ({ line: i.line, specifier: i.specifier })),
    ...facts.reExports.map((r) => ({ line: r.line, specifier: r.specifier })),
  ]
    .sort((a, b) => a.line - b.line)
    .map((i) => i.specifier);
  const identifiers = new Set([
    ...facts.references.map((r) => r.name),
    ...facts.declarations.filter((d) => d.name !== "constructor").map((d) => d.name),
  ]);
  return { path: facts.file, lines, exports, imports, identifiers };
}

/**
 * A file's one-line role, from the source index (CX-IX-2): the first line of
 * its first documentation comment, and the names it exports. Never a model.
 */
export function roleLine(facts: SourceFacts): string {
  const names = [
    ...new Set([
      ...facts.exports
        .filter((e) => e.name !== "export=")
        .map((e) => (e.name === "default" ? (e.local ?? "default") : e.name)),
      ...facts.reExports.flatMap((r) =>
        r.kind === "named" ? r.names.map((n) => n.exported) : r.namespace ? [r.namespace] : [],
      ),
    ]),
  ];
  const listed =
    names.length === 0
      ? "No exports."
      : `Exports ${names.slice(0, 6).join(", ")}${names.length > 6 ? `, and ${names.length - 6} more` : ""}.`;
  if (!facts.doc) return listed;
  const doc = /[.!?]$/.test(facts.doc) ? facts.doc : `${facts.doc}.`;
  return `${doc} ${listed}`;
}

/** The package map's line for one workspace package: name, role and dependencies (CX-IX-1). */
function packageLine(index: SourceIndex, pkg: WorkspacePackageFact): string {
  const entry = pkg.entryPoints.find((e) => e.file)?.file;
  const facts = entry ? index.facts(entry) : undefined;
  const role = facts ? roleLine(facts) : "No entry point found.";
  return `${pkg.name}: ${role}${pkg.deps.length ? ` Depends on ${pkg.deps.join(", ")}.` : ""}`;
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
  const index = createSourceIndex(absRoot);
  // CX-IX-1: a workspace with more packages than a tenth of the budget holds
  // gets a package map, and files are ranked only in the scope's packages.
  const ws = existsSync(absRoot) ? index.workspace() : undefined;
  let packageMap = "";
  let inScopePackages: ((rel: string) => boolean) | undefined;
  if (ws && ws.packages.length > 0) {
    const text = `PACKAGES (name: role):\n${ws.packages.map((p) => packageLine(index, p)).join("\n")}`;
    if (estimatePromptTokens(text) > budget / 10) {
      packageMap = text;
      const touched = ws.packages.filter((p) =>
        scope.some((f) => f === p.dir || f.startsWith(`${p.dir}/`)),
      );
      if (touched.length > 0) {
        inScopePackages = (rel) => touched.some((p) => rel.startsWith(`${p.dir}/`));
      }
    }
  }
  const fileBudget = packageMap ? budget - estimatePromptTokens(`${packageMap}\n\n`) : budget;
  const abs = existsSync(absRoot) ? listSources(absRoot, options.maxFiles ?? 400) : [];
  // CX-N5-2: the key hashes each file's content, not its size and mtime.
  const sources = new Map<string, string>();
  for (const p of abs) {
    const rel = relative(absRoot, p).replace(/\\/g, "/");
    if (inScopePackages && !inScopePackages(rel)) continue;
    try {
      sources.set(rel, readFileSync(p, "utf8"));
    } catch {
      // Unreadable: omit.
    }
  }
  const stamp = [...sources]
    .map(([rel, source]) => `${rel}:${createHash("sha256").update(source).digest("hex")}`)
    .join("|");
  const specIds = options.specText ? specIdentifiers(options.specText) : [];
  const cacheKey = createHash("sha256")
    .update(
      `${stamp}#${scope.join(",")}#${budget}#${options.damping ?? 0.85}#${specIds.join(",")}#${packageMap}`,
    )
    .digest("hex")
    .slice(0, 16);
  const hit = cache.get(cacheKey);
  if (hit) return { ...hit, fromCache: true };

  const outlines = new Map<string, FileOutline>();
  let producedBy = { parser: "typescript", parserVersion: TYPESCRIPT_PARSER_VERSION };
  for (const [rel, source] of sources) {
    const facts = factsOfText(rel, source);
    if (facts.parseStatus === "unsupported") continue;
    producedBy = { parser: facts.parser, parserVersion: facts.parserVersion };
    outlines.set(rel, outlineOfFacts(facts, source));
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
      if (!spec.startsWith(".")) continue;
      // IX-2: the adapter's resolver, and only files the map considered.
      const target = index.resolve(path, spec);
      if (target.kind === "file" && known.has(target.path)) addEdge(path, target.path, 1);
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
    if (estimatePromptTokens(render(outlineList.slice(0, mid))) <= fileBudget) lo = mid;
    else hi = mid - 1;
  }
  const chosen = outlineList.slice(0, lo);
  const fileMap = render(chosen);
  const textOut = packageMap ? (fileMap ? `${packageMap}\n\n${fileMap}` : packageMap) : fileMap;
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
    producedBy,
  };
  if (cache.size > 32) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, result);
  return result;
}
