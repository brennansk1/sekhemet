import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * One interface per package ecosystem for installed dependencies
 * (design-stage DS-N9-1): the version in use, where its source is, the API
 * surface for a symbol and its local docs at that version. Everything here
 * is local and offline; an adapter that has to import or execute a
 * dependency (Python's `inspect`, `go doc`) runs it through the sandbox with
 * no network and no worktree write.
 */
export type Ecosystem = "npm" | "python" | "go" | "rust";

export const ECOSYSTEMS: readonly Ecosystem[] = ["npm", "python", "go", "rust"];

/** One version a project's lockfile pins (DS-N9-7). */
export interface Pin {
  eco: Ecosystem;
  /** As the lockfile writes it (a module path for Go). */
  name: string;
  version: string;
  /** The lockfile it was read from, relative to the repository. */
  source: string;
  /** Cargo.lock's `source` (registry, git or absent for a path crate). */
  origin?: string;
  /** Go: go.sum carries this module at this version. */
  verified?: boolean;
}

/** A dependency the project's manifest declares. */
export interface DeclaredDependency {
  eco: Ecosystem;
  name: string;
  /** The declared range or requirement, when the manifest gives one. */
  spec?: string;
  /** Where it is declared: `dependencies`, `devDependencies`, `pyproject.toml`, `go.mod`… */
  field: string;
  /** Shorter names a person or a query uses for it (a Go module's last element). */
  aliases: string[];
}

/** A dependency resolved for this project (DS-N9-1). */
export interface InstalledDependency {
  eco: Ecosystem;
  name: string;
  /** The version in use: the installed copy's, else the lockfile pin. */
  version: string;
  /** The installed copy's version; absent when nothing is installed. */
  installedVersion?: string;
  /** The lockfile's pin (several joined by ", " when the lockfile holds more than one). */
  pinnedVersion?: string;
  installed: boolean;
  /** The source root, canonical; absent when nothing is installed. */
  root?: string;
  /**
   * The first path elements under `root` this package owns (a Python
   * distribution shares site-packages with others). Absent: all of `root`.
   */
  owned?: string[];
  /** Declared entry points (npm `main`, `types`, `exports`). */
  entries: string[];
  /** Go: go.sum carries the selected version. */
  verified?: boolean;
}

/** One declaration of a symbol, read from the package's own files. */
export interface ApiDeclaration {
  /** Relative to the package root (or the command that answered). */
  file: string;
  line: number;
  signature: string;
  doc?: string;
}

/** The API surface of a package for one symbol, at the version in use. */
export interface ApiSurface {
  eco: Ecosystem;
  name: string;
  version: string;
  symbol: string;
  /** The symbol, and its member when one is named, are declared. */
  found: boolean;
  /** The package's top-level public names. */
  exports: string[];
  declarations: ApiDeclaration[];
  /** The public members of the symbol's type, when it is one. */
  members: string[];
  /** How it was read. */
  method: "static" | "inspect" | "go doc";
  /** Text a command printed (`go doc`), when one answered. */
  docText?: string;
}

/** What a probe of this ecosystem runs and reads (for the claim gate's sandbox). */
export interface DependencyRuntime {
  interpreter?: string;
  /** The dependency roots: read, and first on a Python probe's path. */
  readRoots: string[];
  /**
   * The environment the interpreter needs to start, read and never on the
   * path (a Python virtual environment's directory, with its `pyvenv.cfg`).
   */
  envRoots?: string[];
}

export interface EcosystemAdapter {
  readonly eco: Ecosystem;
  declared(repo: string): DeclaredDependency[];
  resolve(repo: string, name: string): InstalledDependency | undefined;
  /** Interface and documentation files, in reading order, relative to the root. */
  files(dep: InstalledDependency, limit?: number): string[];
  apiSurface(repo: string, dep: InstalledDependency, symbol: string): Promise<ApiSurface>;
  /**
   * Every declaration the package's own files make, read statically, and its
   * top-level public names: the one scan `apiSurface` and the research packet
   * share (DS-N9-1, DS-N9-15). Nothing is imported or run.
   */
  declarations(dep: InstalledDependency): { decls: ScannedDecl[]; exports: string[] };
  runtime(repo: string): DependencyRuntime;
}

export type ReadResult =
  | { ok: true; file: string; text: string; truncated: boolean }
  | { ok: false; reason: "not_installed" | "invalid" | "missing" | "unreadable" };

/** A path's canonical form, or the path itself when it does not exist. */
export function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A package-relative path as an absolute one, only when it stays inside the
 * package (DS-N9-6): no `..` element, not absolute, inside an owned element,
 * and its real path (symlinks followed) still inside the root.
 */
export function insidePackage(dep: InstalledDependency, rel: string): string | undefined {
  if (!dep.root || !rel || isAbsolute(rel)) return undefined;
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== ".");
  if (parts.length === 0 || parts.includes("..")) return undefined;
  if (dep.owned && !dep.owned.includes(parts[0] as string)) return undefined;
  const full = join(dep.root, ...parts);
  if (!within(dep.root, full)) return undefined;
  try {
    if (!within(dep.root, realpathSync(full))) return undefined;
  } catch {
    // Missing: the caller says so.
  }
  return full;
}

/** One file from inside a package, confined to it (DS-N9-6). */
export function readInside(dep: InstalledDependency, rel: string, maxBytes = 60_000): ReadResult {
  if (!dep.root) return { ok: false, reason: "not_installed" };
  const full = insidePackage(dep, rel);
  if (!full) return { ok: false, reason: "invalid" };
  try {
    if (!statSync(full).isFile()) return { ok: false, reason: "missing" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const text = readFileSync(full, "utf8");
    const file = relative(dep.root, full).split(sep).join("/");
    return text.length > maxBytes
      ? { ok: true, file, text: text.slice(0, maxBytes), truncated: true }
      : { ok: true, file, text, truncated: false };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

const SKIP = new Set(["node_modules", ".git", "test", "tests", "__tests__", "testdata", "target"]);

/**
 * Walk a package's files, relative to its root, depth-first in name order.
 * Symlinked directories are never followed and a symlinked file is listed
 * only when its target is inside the root (DS-N9-6). `visit` returns false
 * to stop.
 */
export function walkPackage(
  dep: InstalledDependency,
  visit: (rel: string) => boolean,
  maxDepth = 6,
): void {
  const root = dep.root;
  if (!root) return;
  let going = true;
  const walk = (dir: string, depth: number): void => {
    if (!going || depth > maxDepth) return;
    let items: string[];
    try {
      items = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (!going) return;
      if (SKIP.has(item) || item.startsWith(".")) continue;
      const full = join(dir, item);
      const rel = relative(root, full).split(sep).join("/");
      if (depth === 0 && dep.owned && !dep.owned.includes(item)) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        if (insidePackage(dep, rel) === undefined) continue;
        try {
          if (statSync(full).isFile()) going = visit(rel);
        } catch {
          // A dangling link: nothing to read.
        }
        continue;
      }
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) going = visit(rel);
    }
  };
  walk(root, 0);
}

/** Lines of `text`, for line-based scanners. */
export const linesOf = (text: string): string[] => text.split(/\r?\n/);

/**
 * The comment block directly above line `index`, its prefix stripped
 * (`///`, `//`, `#`, or a `/** … *\/` block), first sentence-sized line kept.
 */
export function docAbove(
  lines: readonly string[],
  index: number,
  prefix: RegExp,
): string | undefined {
  const out: string[] = [];
  for (let i = index - 1; i >= 0 && out.length < 8; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("#[") || line.startsWith("@")) continue;
    const m = prefix.exec(line);
    if (!m) break;
    out.unshift((m[1] ?? "").trim());
  }
  const text = out.filter(Boolean).join(" ").trim();
  return text ? text.slice(0, 300) : undefined;
}

/** A `/** … *\/` block ending just above line `index` (TypeScript declarations). */
export function jsDocAbove(lines: readonly string[], index: number): string | undefined {
  let i = index - 1;
  if (!(lines[i] ?? "").trim().endsWith("*/")) return undefined;
  const out: string[] = [];
  for (; i >= 0 && out.length < 12; i--) {
    const line = (lines[i] ?? "").trim();
    out.unshift(line.replace(/^\/\*\*?|\*\/$|^\*/g, "").trim());
    if (line.startsWith("/**") || line.startsWith("/*")) break;
  }
  const text = out
    .filter((l) => l && !l.startsWith("@"))
    .join(" ")
    .trim();
  return text ? text.slice(0, 300) : undefined;
}

/**
 * A symbol as its parts: `a.b`, `a::b` or `a.b.c`. A leading part that names
 * the package itself (`requests.get`, `serde_json::Value`) is dropped.
 */
export function symbolParts(symbol: string, packageNames: readonly string[]): string[] {
  const parts = symbol
    .trim()
    .replace(/\(\)$/, "")
    .split(/::|\./)
    .map((p) => p.trim())
    .filter(Boolean);
  const heads = new Set(packageNames.map((n) => n.toLowerCase().replace(/-/g, "_")));
  if (parts.length > 1 && heads.has((parts[0] as string).toLowerCase().replace(/-/g, "_")))
    parts.shift();
  return parts;
}

/** The versions a lockfile pins for one name, and the one in use. */
export function pinnedFor(
  pins: readonly Pin[],
  same: (pin: Pin) => boolean,
  installedVersion?: string,
): string | undefined {
  const versions = [...new Set(pins.filter(same).map((p) => p.version))];
  if (versions.length === 0) return undefined;
  if (installedVersion && versions.includes(installedVersion)) return installedVersion;
  return versions.sort().join(", ");
}

/** Version strings in numeric order (`1.0.109` before `2.0.50`, `0.10` after `0.9`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/** One version from `pinnedFor`'s list: the highest when it holds several (DS-N9-7). */
export function oneVersion(pinned: string): string {
  return pinned.split(", ").sort(compareVersions).at(-1) as string;
}

/** A dependency's record from its two versions: installed first, else the pin. */
export function dependencyOf(
  base: Omit<InstalledDependency, "version" | "installed" | "installedVersion" | "pinnedVersion">,
  installedVersion: string | undefined,
  pinnedVersion: string | undefined,
): InstalledDependency | undefined {
  const version = installedVersion ?? (pinnedVersion ? oneVersion(pinnedVersion) : undefined);
  if (!version) return undefined;
  return {
    ...base,
    version,
    installed: installedVersion !== undefined,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    ...(pinnedVersion !== undefined ? { pinnedVersion } : {}),
  };
}

/** An exported-name scan's result: what the surface needs from a scanner. */
export interface ScannedDecl {
  name: string;
  /** The enclosing type, for a member. */
  container?: string;
  file: string;
  line: number;
  signature: string;
  doc?: string;
}

/** The surface from scanned declarations: found, declarations of the head, members. */
export function surfaceFrom(
  base: Pick<ApiSurface, "eco" | "name" | "version" | "symbol" | "exports">,
  decls: readonly ScannedDecl[],
  parts: readonly string[],
  method: ApiSurface["method"] = "static",
): ApiSurface {
  const [head, member] = parts.length >= 2 ? parts.slice(-2) : [parts[0], undefined];
  const top = decls.filter((d) => d.name === head && !d.container);
  const asMember = decls.filter((d) => d.name === head && d.container !== undefined);
  const own = top.length > 0 ? top : parts.length === 1 ? asMember : [];
  const members = [...new Set(decls.filter((d) => d.container === head).map((d) => d.name))].sort();
  const memberDecls = member ? decls.filter((d) => d.container === head && d.name === member) : [];
  const found = member ? memberDecls.length > 0 : own.length > 0;
  const shown = member ? [...memberDecls, ...own] : own;
  return {
    ...base,
    found,
    declarations: shown.slice(0, 6).map((d) => ({
      file: d.file,
      line: d.line,
      signature: d.signature.trim().slice(0, 240),
      ...(d.doc ? { doc: d.doc } : {}),
    })),
    members,
    method,
  };
}
