import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * The installed dependency's own source (tier 1 of the knowledge tiers).
 *
 * For an API question this beats every page on the web: it is the code that
 * will actually run, at the version actually resolved, and it costs nothing
 * — no model, no network, no rate limit. The Desk tries this before it tries
 * anything else, and most of the time it is the whole answer.
 *
 * pnpm stores packages behind symlinks in a content-addressed store, so the
 * directory is resolved and then realpath'd; reads are confined to the
 * resolved package directory so a traversal cannot walk out of it.
 */

const NAME = /^(@[\w.-]+\/)?[\w.-]+$/;

export interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
  /** What `main`, `module`, `exports` and `types` point at, as declared. */
  entries: string[];
}

/** Where a dependency is installed for this project, walking up node_modules. */
export function packageDir(repoPath: string, name: string): string | undefined {
  if (!NAME.test(name)) return undefined;
  let here = resolve(repoPath);
  for (;;) {
    const candidate = join(here, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const up = dirname(here);
    if (up === here) return undefined;
    here = up;
  }
}

function entryPoints(pkg: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const k of ["main", "module", "types", "typings"]) {
    const v = pkg[k];
    if (typeof v === "string") out.add(v);
  }
  const exp = pkg.exports;
  const walk = (v: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof v === "string") return void out.add(v);
    if (v && typeof v === "object")
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner, depth + 1);
  };
  walk(exp);
  return [...out];
}

/** The installed package: version, directory, declared entry points. */
export function installed(repoPath: string, name: string): InstalledPackage | undefined {
  const dir = packageDir(repoPath, name);
  if (!dir) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    return {
      name,
      version: typeof pkg.version === "string" ? pkg.version : "unknown",
      dir,
      entries: entryPoints(pkg),
    };
  } catch {
    return undefined;
  }
}

/** A path is only readable when it stays inside the package directory. */
function inside(dir: string, path: string): string | undefined {
  const full = resolve(dir, path);
  const rel = relative(dir, full);
  return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? full : undefined;
}

/** One file from inside an installed package. */
export function depsFile(repoPath: string, name: string, path: string, maxBytes = 60_000): string {
  const pkg = installed(repoPath, name);
  if (!pkg) return `${name} is not installed in this project.`;
  // Said plainly up front, and caught again by `inside`: a traversal is a
  // bad request, not a missing file, and the message should say so.
  if (path.split(/[\\/]/).includes("..")) return "Invalid path.";
  const full = inside(pkg.dir, path);
  if (!full || !existsSync(full)) return `No ${path} in ${name}@${pkg.version}.`;
  try {
    const text = readFileSync(full, "utf8");
    return text.length > maxBytes
      ? `${text.slice(0, maxBytes)}\n[truncated at ${maxBytes} bytes]`
      : text;
  } catch {
    return `Cannot read ${path} in ${name}@${pkg.version}.`;
  }
}

const SKIP = new Set(["node_modules", ".git", ".bin", "test", "tests", "__tests__"]);

/** The files that carry the interface: entry points, declarations, README. */
export function depsOutline(repoPath: string, name: string, limit = 60): string {
  const pkg = installed(repoPath, name);
  if (!pkg) return `${name} is not installed in this project.`;
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || found.length >= limit) return;
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }
    for (const item of items) {
      if (found.length >= limit) return;
      if (SKIP.has(item) || item.startsWith(".")) continue;
      const full = join(dir, item);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full, depth + 1);
      else if (/\.(d\.ts|d\.mts|d\.cts)$|^readme|^changelog|\.(mjs|cjs|js|ts)$/i.test(item))
        found.push(relative(pkg.dir, full));
    }
  };
  walk(pkg.dir, 0);
  const decls = found.filter((f) => /\.d\./.test(f));
  const docs = found.filter((f) => /^readme|^changelog/i.test(f));
  return [
    `${name}@${pkg.version} at ${pkg.dir}`,
    pkg.entries.length ? `entry points: ${pkg.entries.join(", ")}` : "",
    docs.length ? `docs: ${docs.join(", ")}` : "",
    decls.length ? `declarations:\n${decls.slice(0, 40).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Search inside an installed package. ripgrep when present, else a plain walk. */
export function depsGrep(repoPath: string, name: string, pattern: string, limit = 40): string {
  const pkg = installed(repoPath, name);
  if (!pkg) return `${name} is not installed in this project.`;
  const p = pattern.slice(0, 200);
  if (!p) return "Empty pattern.";
  try {
    const out = execFileSync(
      "rg",
      ["--no-heading", "--line-number", "--max-count", "3", "-m", String(limit), "-e", p, "."],
      { cwd: pkg.dir, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    ).trim();
    return out
      ? `${name}@${pkg.version}:\n${out.split("\n").slice(0, limit).join("\n")}`
      : `No match for "${p}" in ${name}@${pkg.version}.`;
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 1) return `No match for "${p}" in ${name}@${pkg.version}.`;
    return `Search failed in ${name}@${pkg.version}.`;
  }
}

/** Every dependency this project declares, with the version actually installed. */
export function manifestVersions(repoPath: string): { name: string; version: string }[] {
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return names
      .map((n) => ({ name: n, version: installed(repoPath, n)?.version ?? "" }))
      .filter((d) => d.version);
  } catch {
    return [];
  }
}
