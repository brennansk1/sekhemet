import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Ecosystem, Pin } from "./types.js";

/**
 * The one reader of a project's pinned versions (design-stage DS-N9-7):
 * pnpm-lock.yaml, package-lock.json, requirements.txt (`==` only),
 * poetry.lock, uv.lock, Cargo.lock and go.mod's `require` lines checked
 * against go.sum. The ecosystem adapters, research notes and the air-gap
 * kit's mirror allowlist all read pins here, so a version means the same
 * thing everywhere. A lockfile that cannot be read pins nothing; a truncated
 * one pins only its complete entries.
 */

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "Cargo.lock",
  "go.mod",
  "go.sum",
] as const;

function read(repo: string, file: string): string | undefined {
  try {
    return readFileSync(join(repo, file), "utf8");
  } catch {
    return undefined;
  }
}

function pnpmPins(text: string): Pin[] {
  const out: Pin[] = [];
  // v9 keys: `  name@1.2.3:` / `  '@scope/name@1.2.3':` under packages:/snapshots:
  for (const m of text.matchAll(/^ {2}'?(@?[^@'\s][^@'\s]*)@(\d[^:'\s(]*)[^:]*'?:\s*$/gm)) {
    out.push({
      eco: "npm",
      name: m[1] as string,
      version: m[2] as string,
      source: "pnpm-lock.yaml",
    });
  }
  return out;
}

function npmLockPins(text: string): Pin[] {
  let lock: { packages?: Record<string, { version?: string }> };
  try {
    lock = JSON.parse(text);
  } catch {
    return [];
  }
  const out: Pin[] = [];
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    const name = path.split("node_modules/").at(-1);
    if (name && p && typeof p.version === "string")
      out.push({ eco: "npm", name, version: p.version, source: "package-lock.json" });
  }
  return out;
}

function requirementsPins(text: string): Pin[] {
  return [...text.matchAll(/^([A-Za-z0-9_.-]+)==([^\s;#]+)/gm)].map((m) => ({
    eco: "python" as const,
    name: m[1] as string,
    version: m[2] as string,
    source: "requirements.txt",
  }));
}

/** One `[[package]]` table of a TOML lockfile. */
export interface PackageTable {
  name: string;
  version: string;
  source?: string;
  /** Cargo.lock's `dependencies` entries as written (`syn`, `syn 2.0.50`). */
  dependencies?: string[];
}

/**
 * `[[package]]` tables of a TOML lockfile (Cargo.lock, poetry.lock, uv.lock):
 * only keys between a `[[package]]` header and the next header count, and an
 * entry needs both a complete `name` and a complete `version`. A
 * `dependencies` array of strings (Cargo.lock's) is kept, on one line or many.
 */
export function packageTables(text: string): PackageTable[] {
  const out: PackageTable[] = [];
  let entry: Record<string, string> | undefined;
  let deps: string[] | undefined;
  let inDeps = false;
  const flush = () => {
    if (entry?.name && entry.version)
      out.push({
        name: entry.name,
        version: entry.version,
        ...(entry.source ? { source: entry.source } : {}),
        ...(deps ? { dependencies: deps } : {}),
      });
    entry = undefined;
    deps = undefined;
    inDeps = false;
  };
  const strings = (line: string) => [...line.matchAll(/"([^"\\]*)"/g)].map((m) => m[1] as string);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inDeps) {
      deps?.push(...strings(line.replace(/#.*$/, "")));
      if (line.includes("]")) inDeps = false;
      continue;
    }
    if (line.startsWith("[")) {
      flush();
      if (line === "[[package]]") entry = {};
      continue;
    }
    if (!entry) continue;
    const d = /^dependencies\s*=\s*\[(.*)$/.exec(line);
    if (d) {
      const rest = (d[1] as string).replace(/#.*$/, "");
      deps = strings(rest);
      inDeps = !rest.includes("]");
      continue;
    }
    const m = /^(name|version|source)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line);
    if (m) entry[m[1] as string] = m[2] as string;
  }
  flush();
  return out;
}

function tablePins(text: string, eco: Ecosystem, source: string): Pin[] {
  return packageTables(text).map((t) => ({
    eco,
    name: t.name,
    version: t.version,
    source,
    ...(eco === "rust" && t.source ? { origin: t.source } : {}),
  }));
}

/** A Go module path as go.mod may write it: no `!`, no `..` element, not absolute. */
export function isModulePath(path: string): boolean {
  if (!/^[A-Za-z0-9.~_+-]+(\/[A-Za-z0-9.~_+-]+)*$/.test(path)) return false;
  return !path.split("/").some((p) => p === "." || p === "..");
}

/** go.mod's `require` lines (single and block), each a complete `path version`. */
export function goRequires(text: string): { path: string; version: string; indirect: boolean }[] {
  const out: { path: string; version: string; indirect: boolean }[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (inBlock) {
      if (line.startsWith(")")) {
        inBlock = false;
        continue;
      }
    } else if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    } else if (!line.startsWith("require ")) continue;
    const body = inBlock ? line : line.slice("require ".length).trim();
    const m = /^(\S+)\s+(v[0-9][^\s/]*)\s*(\/\/.*)?$/.exec(body);
    if (!m || !isModulePath(m[1] as string)) continue;
    out.push({
      path: m[1] as string,
      version: m[2] as string,
      indirect: /\/\/\s*indirect\b/.test(m[3] ?? ""),
    });
  }
  return out;
}

function goPins(mod: string, sum: string | undefined): Pin[] {
  const sums = new Set(
    (sum ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 3)
      .map((p) => `${p[0]} ${(p[1] as string).replace(/\/go\.mod$/, "")}`),
  );
  return goRequires(mod).map((r) => ({
    eco: "go" as const,
    name: r.path,
    version: r.version,
    source: "go.mod",
    verified: sums.has(`${r.path} ${r.version}`),
  }));
}

const memo = new Map<string, { stamp: string; pins: Pin[] }>();

/** The lockfiles' sizes and times: the pins are re-read only when one changes. */
function stampOf(repo: string): string {
  return LOCKFILES.map((f) => {
    try {
      const s = statSync(join(repo, f), { bigint: true });
      return `${f}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.ino}`;
    } catch {
      return `${f}:-`;
    }
  }).join("|");
}

/** Every version the project's lockfiles pin, each once per lockfile (DS-N9-7). */
export function pinsOf(repo: string): Pin[] {
  const stamp = stampOf(repo);
  const hit = memo.get(repo);
  if (hit && hit.stamp === stamp) return hit.pins;
  const all: Pin[] = [];
  const pnpm = read(repo, "pnpm-lock.yaml");
  if (pnpm !== undefined) all.push(...pnpmPins(pnpm));
  const npmLock = read(repo, "package-lock.json");
  if (npmLock !== undefined) all.push(...npmLockPins(npmLock));
  const req = read(repo, "requirements.txt");
  if (req !== undefined) all.push(...requirementsPins(req));
  for (const lock of ["poetry.lock", "uv.lock"]) {
    const text = read(repo, lock);
    if (text !== undefined) all.push(...tablePins(text, "python", lock));
  }
  const cargo = read(repo, "Cargo.lock");
  if (cargo !== undefined) all.push(...tablePins(cargo, "rust", "Cargo.lock"));
  const mod = read(repo, "go.mod");
  if (mod !== undefined) all.push(...goPins(mod, read(repo, "go.sum")));
  const seen = new Set<string>();
  const pins = all.filter((p) => {
    const key = `${p.eco}\0${p.name}\0${p.version}\0${p.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  memo.set(repo, { stamp, pins });
  return pins;
}

/** One hash over the pins, independent of order: changes exactly when a pin does. */
export function pinsDigest(pins: readonly Pin[]): string {
  const lines = pins.map((p) => `${p.eco} ${p.name} ${p.version} ${p.source}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}
