import { goAdapter } from "./go.js";
import { npmAdapter } from "./npm.js";
import { pythonAdapter } from "./python.js";
import { rustAdapter } from "./rust.js";
import {
  type ApiSurface,
  type DeclaredDependency,
  type DependencyRuntime,
  type Ecosystem,
  type EcosystemAdapter,
  type InstalledDependency,
  type ReadResult,
  type ScannedDecl,
  readInside,
  walkPackage,
} from "./types.js";

export {
  type ApiDeclaration,
  type ApiSurface,
  type DeclaredDependency,
  type DependencyRuntime,
  ECOSYSTEMS,
  type Ecosystem,
  type EcosystemAdapter,
  type InstalledDependency,
  type Pin,
  type ReadResult,
  type ScannedDecl,
} from "./types.js";
export { goRequires, isModulePath, packageTables, pinsDigest, pinsOf } from "./pins.js";
export { type GoImport, type PythonImport, goImports, pythonImports } from "./imports.js";
export { npmAdapter } from "./npm.js";
export { normalizePython, pythonAdapter, sitePackages } from "./python.js";
export { escapeModulePath, goAdapter, goAlias, goModCache } from "./go.js";
export { cargoHome, rustAdapter } from "./rust.js";

/**
 * The installed-dependency adapters, one per ecosystem (design-stage
 * DS-N9-1..6), behind one lookup: the Worker's `docs` and `dependencies`
 * tools and the Researcher's `deps_*` tools resolve a name here. A name may
 * carry an ecosystem prefix (`python:requests`, `go:cobra`, `rust:serde`);
 * without one, the first ecosystem with an installed copy answers, else the
 * first with a pin.
 */
export const ECOSYSTEM_ADAPTERS: readonly EcosystemAdapter[] = [
  npmAdapter,
  pythonAdapter,
  goAdapter,
  rustAdapter,
];

const PREFIXES: Readonly<Record<string, Ecosystem>> = {
  npm: "npm",
  node: "npm",
  python: "python",
  pypi: "python",
  py: "python",
  go: "go",
  golang: "go",
  rust: "rust",
  cargo: "rust",
  crates: "rust",
};

export function adapterFor(eco: Ecosystem): EcosystemAdapter {
  return ECOSYSTEM_ADAPTERS.find((a) => a.eco === eco) as EcosystemAdapter;
}

/** `eco:name` as its parts; a prefix that names no ecosystem is part of the name. */
export function parseDependencySpec(spec: string): { eco?: Ecosystem; name: string } {
  const m = /^([a-z]+):(.+)$/.exec(spec.trim());
  const eco = m ? PREFIXES[m[1] as string] : undefined;
  return eco ? { eco, name: (m?.[2] as string).trim() } : { name: spec.trim() };
}

/** The dependency a name means in this project: installed first, else pinned. */
export function resolveDependency(repo: string, spec: string): InstalledDependency | undefined {
  const { eco, name } = parseDependencySpec(spec);
  if (!name) return undefined;
  let pinnedOnly: InstalledDependency | undefined;
  for (const adapter of eco ? [adapterFor(eco)] : ECOSYSTEM_ADAPTERS) {
    const dep = adapter.resolve(repo, name);
    if (dep?.installed) return dep;
    pinnedOnly ??= dep;
  }
  return pinnedOnly;
}

/** Every dependency the project's manifests declare, in every ecosystem. */
export function declaredDependencies(repo: string): DeclaredDependency[] {
  return ECOSYSTEM_ADAPTERS.flatMap((a) => a.declared(repo));
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The declared dependencies a query names, as `eco:name` specs with the word
 * that named each: by name or by alias, as a whole word (`requests` in
 * "requests Session", not in "prerequests").
 */
export function dependenciesNamedIn(repo: string, query: string): { spec: string; word: string }[] {
  const out: { spec: string; word: string }[] = [];
  for (const d of declaredDependencies(repo)) {
    const word = [d.name, ...d.aliases].find((n) =>
      new RegExp(`(?<![\\w@/.-])${escapeRegExp(n)}(?![\\w/-])`, "i").test(query),
    );
    const spec = `${d.eco}:${d.name}`;
    if (word && !out.some((o) => o.spec === spec)) out.push({ spec, word });
  }
  return out;
}

/** Interface and documentation files of an installed dependency, in reading order. */
export function dependencyFiles(dep: InstalledDependency, limit?: number): string[] {
  return dep.installed ? adapterFor(dep.eco).files(dep, limit) : [];
}

/** One file of an installed dependency, confined to it (DS-N9-6). */
export function dependencyFile(
  dep: InstalledDependency,
  path: string,
  maxBytes?: number,
): ReadResult {
  return readInside(dep, path, maxBytes);
}

/** The API surface for a symbol at the version in use; undefined when nothing is installed. */
export async function dependencyApi(
  repo: string,
  spec: string,
  symbol: string,
): Promise<ApiSurface | undefined> {
  const dep = resolveDependency(repo, spec);
  if (!dep?.installed) return undefined;
  return adapterFor(dep.eco).apiSurface(repo, dep, symbol);
}

/** Every declaration of an installed dependency, read statically (DS-N9-1, -15); none when not installed. */
export function dependencyDeclarations(dep: InstalledDependency): ScannedDecl[] {
  return dep.installed ? adapterFor(dep.eco).declarations(dep).decls : [];
}

/** What a probe of `eco` runs and reads (the claim gate's sandbox, DS-N9-1). */
export function dependencyRuntime(repo: string, eco: Ecosystem): DependencyRuntime {
  return adapterFor(eco).runtime(repo);
}

/**
 * Lines matching `pattern` in an installed dependency's files, confined to
 * it: the walk follows no symlink out of the package (DS-N9-6). An invalid
 * regular expression is searched as plain text.
 */
export function dependencyGrep(
  dep: InstalledDependency,
  pattern: string,
  limit = 40,
): { file: string; line: number; text: string }[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    re = new RegExp(escapeRegExp(pattern));
  }
  const out: { file: string; line: number; text: string }[] = [];
  walkPackage(dep, (rel) => {
    const read = readInside(dep, rel, 1_000_000);
    if (!read.ok || read.text.includes("\u0000")) return true;
    let perFile = 0;
    const lines = read.text.split(/\r?\n/);
    for (let i = 0; i < lines.length && perFile < 3 && out.length < limit; i++) {
      if (re.test(lines[i] as string)) {
        out.push({ file: read.file, line: i + 1, text: (lines[i] as string).slice(0, 300) });
        perFile++;
      }
    }
    return out.length < limit;
  });
  return out;
}
