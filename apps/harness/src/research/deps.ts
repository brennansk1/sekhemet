import { execFileSync } from "node:child_process";
import {
  type Ecosystem,
  type InstalledDependency,
  declaredDependencies,
  dependencyFile,
  dependencyFiles,
  dependencyGrep,
  resolveDependency,
} from "@sekhemet/loop";

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
 *
 * Every ecosystem the loop's adapters read is served (design-stage
 * DS-N9-1..6): npm under node_modules, Python from the venv's .dist-info,
 * Go under the module cache, Rust under Cargo's registry sources.
 */

export interface InstalledPackage {
  name: string;
  version: string;
  dir: string;
  /** What `main`, `module`, `exports` and `types` point at, as declared (npm); import names (Python). */
  entries: string[];
  /** The ecosystem it was found in (design-stage DS-N9-1). */
  ecosystem: Ecosystem;
  /** The lockfile's pin, when it differs from the installed version. */
  pinnedVersion?: string;
}

/** Where a dependency is installed for this project, in any ecosystem. */
export function packageDir(repoPath: string, name: string): string | undefined {
  return installed(repoPath, name)?.dir;
}

/**
 * The installed package: version, directory, declared entry points. A name
 * may carry an ecosystem prefix (`python:requests`, `go:cobra`,
 * `rust:serde`); without one, npm, Python, Go and Rust are tried in turn.
 */
export function installed(repoPath: string, name: string): InstalledPackage | undefined {
  const dep = resolveDependency(repoPath, name);
  if (!dep?.installed || !dep.root) return undefined;
  return {
    name: dep.name,
    version: dep.version,
    dir: dep.root,
    entries: dep.entries,
    ecosystem: dep.eco,
    ...(dep.pinnedVersion && dep.pinnedVersion !== dep.version
      ? { pinnedVersion: dep.pinnedVersion }
      : {}),
  };
}

function installedDep(repoPath: string, name: string): InstalledDependency | undefined {
  const dep = resolveDependency(repoPath, name);
  return dep?.installed ? dep : undefined;
}

/** One file from inside an installed package, confined to it (DS-N9-6). */
export function depsFile(repoPath: string, name: string, path: string, maxBytes = 60_000): string {
  const dep = installedDep(repoPath, name);
  if (!dep) return `${name} is not installed in this project.`;
  const read = dependencyFile(dep, path, maxBytes);
  if (read.ok) return read.truncated ? `${read.text}\n[truncated at ${maxBytes} bytes]` : read.text;
  // A traversal or a link out of the package is a bad request, not a missing file.
  if (read.reason === "invalid") return "Invalid path.";
  if (read.reason === "missing") return `No ${path} in ${dep.name}@${dep.version}.`;
  return `Cannot read ${path} in ${dep.name}@${dep.version}.`;
}

/** The files that carry the interface: entry points, declarations, stubs, sources, README. */
export function depsOutline(repoPath: string, name: string, limit = 60): string {
  const dep = installedDep(repoPath, name);
  if (!dep?.root) return `${name} is not installed in this project.`;
  const found = dependencyFiles(dep, limit);
  const isDoc = (f: string) => /(^|\/)(readme|changelog)[^/]*$|METADATA$|(^|\/)doc\.go$/i.test(f);
  const docs = found.filter(isDoc);
  const decls = found.filter((f) => !isDoc(f));
  const eco = dep.eco === "npm" ? "" : ` (${dep.eco})`;
  return [
    `${dep.name}@${dep.version}${eco} at ${dep.root}`,
    dep.pinnedVersion && dep.pinnedVersion !== dep.version
      ? `lockfile pins ${dep.pinnedVersion}`
      : "",
    dep.eco === "npm" && dep.entries.length ? `entry points: ${dep.entries.join(", ")}` : "",
    docs.length ? `docs: ${docs.join(", ")}` : "",
    decls.length ? `declarations:\n${decls.slice(0, 40).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Search inside an installed package: ripgrep over the package's own paths
 * when present (it follows no symlink), else the confined walk.
 */
export function depsGrep(repoPath: string, name: string, pattern: string, limit = 40): string {
  const dep = installedDep(repoPath, name);
  if (!dep?.root) return `${name} is not installed in this project.`;
  const p = pattern.slice(0, 200);
  if (!p) return "Empty pattern.";
  const label = `${dep.name}@${dep.version}`;
  try {
    const out = execFileSync(
      "rg",
      [
        "--no-heading",
        "--line-number",
        "--max-count",
        "3",
        "-m",
        String(limit),
        "-e",
        p,
        "--",
        ...(dep.owned ?? ["."]),
      ],
      { cwd: dep.root, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
    ).trim();
    return out
      ? `${label}:\n${out.split("\n").slice(0, limit).join("\n")}`
      : `No match for "${p}" in ${label}.`;
  } catch (err) {
    const e = err as { status?: number; code?: string };
    if (e.status === 1) return `No match for "${p}" in ${label}.`;
    if (e.code !== "ENOENT") return `Search failed in ${label}.`;
  }
  const hits = dependencyGrep(dep, p, limit);
  return hits.length
    ? `${label}:\n${hits.map((h) => `${h.file}:${h.line}:${h.text}`).join("\n")}`
    : `No match for "${p}" in ${label}.`;
}

/** Every dependency this project declares, in every ecosystem, with the version actually installed. */
export function manifestVersions(repoPath: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const d of declaredDependencies(repoPath)) {
    const dep = resolveDependency(repoPath, `${d.eco}:${d.name}`);
    if (dep?.installed && !out.some((o) => o.name === d.name))
      out.push({ name: d.name, version: dep.version });
  }
  return out;
}
