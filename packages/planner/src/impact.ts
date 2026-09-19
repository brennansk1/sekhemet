import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { type LspPool, outlineFile } from "@sekhemet/context";

/**
 * Impact analysis (P24): which files a change to a card's scope can break.
 * The default engine is the TypeScript compiler's parse (through the
 * context package's outline): the reverse import graph from the scope
 * files, and for every exported symbol the scope defines, the files that
 * reference it. With an LSP pool, references come from the language server
 * instead (real resolution through re-exports and aliases). The planner
 * uses it for INVEST independence (scope overlap by impact, not by name),
 * for the edit sketch's blast radius and for `inferDependencies`.
 */
export interface ImpactReport {
  scope: string[];
  /** Files that import a scope file, transitively (depth-limited). */
  importers: string[];
  /** Files that reference an exported symbol of a scope file. */
  referencers: { file: string; symbols: string[] }[];
  /** Union of both, sorted: what the change can break. */
  blastRadius: string[];
  /** Tests in the blast radius: what to run. */
  tests: string[];
  engine: "typescript" | "lsp";
}

const SKIP = new Set(["node_modules", "dist", ".git", ".sekhemet", "coverage", "build"]);
const SRC = /\.(ts|tsx|js|jsx|mts|cts)$/;

function sources(root: string, max = 2000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (SKIP.has(n) || n.startsWith(".")) continue;
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (SRC.test(n) && !n.endsWith(".d.ts")) out.push(relative(root, p).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

function resolveSpec(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = join(dirname(from), spec).replace(/\\/g, "/");
  const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
  return [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}/index.ts`,
    `${stem}/index.js`,
  ].find((c) => known.has(c));
}

const isTest = (f: string) => /(\.|_)(spec|test)\.[jt]sx?$/.test(f) || /(^|\/)tests?\//.test(f);

export async function analyzeImpact(
  root: string,
  scopeFiles: readonly string[],
  options: { depth?: number; lsp?: LspPool } = {},
): Promise<ImpactReport> {
  const abs = resolve(root);
  const files = sources(abs);
  const known = new Set(files);
  const scope = scopeFiles
    .map((f) => f.replace(/^\.\//, ""))
    .filter((f) => known.has(f) || existsSync(join(abs, f)));
  const outlines = new Map(
    files.map((f) => [f, outlineFile(f, readFileSync(join(abs, f), "utf8"))] as const),
  );

  // Reverse import graph.
  const importedBy = new Map<string, Set<string>>();
  for (const [f, o] of outlines) {
    for (const spec of o.imports) {
      const t = resolveSpec(f, spec, known);
      if (!t) continue;
      const set = importedBy.get(t) ?? new Set<string>();
      set.add(f);
      importedBy.set(t, set);
    }
  }
  const importers = new Set<string>();
  let frontier = [...scope];
  for (let d = 0; d < (options.depth ?? 3) && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const imp of importedBy.get(f) ?? []) {
        if (!importers.has(imp) && !scope.includes(imp)) {
          importers.add(imp);
          next.push(imp);
        }
      }
    }
    frontier = next;
  }

  // Symbol references.
  const refs = new Map<string, Set<string>>();
  let engine: ImpactReport["engine"] = "typescript";
  for (const f of scope) {
    const o = outlines.get(f);
    if (!o) continue;
    const client = options.lsp?.clientFor(abs, f);
    if (client) {
      try {
        const text = readFileSync(join(abs, f), "utf8").split("\n");
        for (const sym of o.exports) {
          const line = text.findIndex(
            (l) => new RegExp(`\\b${sym}\\b`).test(l) && /\bexport\b/.test(l),
          );
          if (line < 0) continue;
          const col = (text[line] as string).search(new RegExp(`\\b${sym}\\b`));
          for (const loc of await client.references(f, line + 1, col + 1)) {
            const rel = relative(abs, loc.path).replace(/\\/g, "/");
            if (rel === f) continue;
            refs.set(rel, (refs.get(rel) ?? new Set()).add(sym));
          }
        }
        engine = "lsp";
        continue;
      } catch {
        // No server: fall back to the compiler parse below.
      }
    }
    for (const [other, oo] of outlines) {
      if (other === f) continue;
      for (const sym of o.exports)
        if (oo.identifiers.has(sym)) refs.set(other, (refs.get(other) ?? new Set()).add(sym));
    }
  }
  const referencers = [...refs.entries()]
    .filter(([f]) => !scope.includes(f))
    .map(([file, s]) => ({ file, symbols: [...s].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const blastRadius = [...new Set([...importers, ...referencers.map((r) => r.file)])].sort();
  return {
    scope,
    importers: [...importers].sort(),
    referencers,
    blastRadius,
    tests: blastRadius.filter(isTest),
    engine,
  };
}

/**
 * Dependencies by impact: card B depends on card A when B's scope is in
 * A's blast radius (A's change can break what B builds on), for cards
 * whose scopes do not already overlap.
 */
export async function inferDependenciesByImpact(
  root: string,
  cards: readonly { id: string; scopeFiles: string[] }[],
  options: { lsp?: LspPool } = {},
): Promise<{ cardId: string; dependsOn: string; via: string[] }[]> {
  const out: { cardId: string; dependsOn: string; via: string[] }[] = [];
  const reports = new Map<string, ImpactReport>();
  for (const c of cards) reports.set(c.id, await analyzeImpact(root, c.scopeFiles, options));
  for (let i = 0; i < cards.length; i++) {
    for (let j = 0; j < cards.length; j++) {
      if (i === j) continue;
      const a = cards[i] as { id: string; scopeFiles: string[] };
      const b = cards[j] as { id: string; scopeFiles: string[] };
      const via = b.scopeFiles.filter((f) => reports.get(a.id)?.blastRadius.includes(f));
      // Only the earlier card leads, so a mutual reference never makes a cycle.
      if (via.length > 0 && i < j) out.push({ cardId: b.id, dependsOn: a.id, via });
    }
  }
  return out;
}

/**
 * The planner's codebase map from the repository (P1): every source file,
 * its exported symbols (TypeScript compiler parse) and its token size, plus
 * the source and test roots. `sekhemet plan` passes this so slices claim
 * real files and symbols instead of invented ones.
 */
export function codebaseMapFromRepo(root: string): import("./types.js").CodebaseMap {
  const abs = resolve(root);
  const files = sources(abs);
  const symbols: Record<string, string[]> = {};
  const fileTokens: Record<string, number> = {};
  for (const f of files) {
    const text = readFileSync(join(abs, f), "utf8");
    fileTokens[f] = Math.ceil(text.length / 4);
    const exp = outlineFile(f, text).exports;
    if (exp.length) symbols[f] = exp;
  }
  const top = (pred: (f: string) => boolean) => {
    const counts = new Map<string, number>();
    for (const f of files.filter(pred)) {
      const d = f
        .split("/")
        .slice(0, f.startsWith("packages/") ? 3 : 1)
        .join("/");
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  };
  const sourceDir = top((f) => !isTest(f));
  const testDir = top(isTest);
  return {
    files,
    symbols,
    fileTokens,
    ...(sourceDir ? { sourceDir } : {}),
    ...(testDir ? { testDir } : {}),
  };
}
