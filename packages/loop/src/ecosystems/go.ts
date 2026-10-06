import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { runConfined } from "@sekhemet/sandbox";
import { goRequires, isModulePath, pinsOf } from "./pins.js";
import {
  type EcosystemAdapter,
  type InstalledDependency,
  type ScannedDecl,
  canonical,
  docAbove,
  linesOf,
  readInside,
  surfaceFrom,
  symbolParts,
  walkPackage,
} from "./types.js";

/**
 * Go (DS-N9-3): go.mod's `require` lines are the selected versions, checked
 * against go.sum; a module's source is under the module cache (GOMODCACHE,
 * else the first GOPATH's pkg/mod, else ~/go/pkg/mod) at its case-escaped
 * path. The API surface is a static scan of exported names; when `go` is
 * installed, `go doc` answers too, run in the sandbox with GOPROXY=off,
 * GOFLAGS=-mod=mod and GOTOOLCHAIN=local, so it reads only the cache.
 */

/**
 * A module path (or version) as the module cache spells it: each upper-case
 * letter becomes `!` and its lower case. A path that already holds `!`, or is
 * not a module path, has no spelling.
 */
export function escapeModulePath(path: string): string | undefined {
  if (path.includes("!") || !isModulePath(path)) return undefined;
  return path.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

/** The module cache directory. */
export function goModCache(): string {
  if (process.env.GOMODCACHE) return process.env.GOMODCACHE;
  const gopath = process.env.GOPATH?.split(delimiter).find(Boolean);
  return join(gopath ?? join(homedir(), "go"), "pkg", "mod");
}

/** The name a module is called by: its last element, a major-version suffix dropped. */
export function goAlias(path: string): string {
  const parts = path.split("/");
  let last = parts.at(-1) ?? path;
  if (/^v\d+$/.test(last) && parts.length > 1) last = parts.at(-2) as string;
  return last.replace(/\.v\d+$/, "");
}

function goOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const exe = join(dir, process.platform === "win32" ? "go.exe" : "go");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}

function goMod(repo: string): string | undefined {
  try {
    return readFileSync(join(repo, "go.mod"), "utf8");
  } catch {
    return undefined;
  }
}

export const goAdapter: EcosystemAdapter = {
  eco: "go",

  declared(repo) {
    const mod = goMod(repo);
    return mod === undefined
      ? []
      : goRequires(mod).map((r) => ({
          eco: "go" as const,
          name: r.path,
          spec: r.version,
          field: r.indirect ? "go.mod (indirect)" : "go.mod",
          aliases: [goAlias(r.path)],
        }));
  },

  resolve(repo, name) {
    const mod = goMod(repo);
    if (mod === undefined) return undefined;
    const requires = goRequires(mod);
    const exact = requires.find((r) => r.path === name);
    const byAlias = requires.filter((r) => goAlias(r.path) === name);
    const req = exact ?? (byAlias.length === 1 ? byAlias[0] : undefined);
    if (!req) return undefined;
    const pin = pinsOf(repo).find(
      (p) => p.eco === "go" && p.name === req.path && p.version === req.version,
    );
    const path = escapeModulePath(req.path);
    const version = escapeModulePath(req.version);
    const dir = path && version ? join(goModCache(), `${path}@${version}`) : undefined;
    const installed = dir !== undefined && existsSync(dir);
    return {
      eco: "go",
      name: req.path,
      version: req.version,
      ...(installed ? { installedVersion: req.version } : {}),
      pinnedVersion: req.version,
      installed,
      ...(installed && dir ? { root: canonical(dir) } : {}),
      entries: [goAlias(req.path)],
      verified: pin?.verified === true,
    };
  },

  files(dep, limit = 400) {
    const docs: string[] = [];
    const sources: string[] = [];
    walkPackage(
      dep,
      (rel) => {
        const parts = rel.split("/");
        if (parts.includes("vendor")) return true;
        const base = parts.at(-1) ?? rel;
        if (parts.length === 1 && /^readme/i.test(base)) docs.push(rel);
        else if (base === "doc.go") docs.push(rel);
        else if (base.endsWith(".go") && !base.endsWith("_test.go")) sources.push(rel);
        return docs.length + sources.length < limit;
      },
      4,
    );
    return [...docs, ...sources];
  },

  declarations(dep) {
    return goScan(dep);
  },

  async apiSurface(repo, dep, symbol) {
    const parts = symbolParts(symbol, [dep.name, ...dep.entries]);
    const { decls, exports } = goScan(dep);
    const surface = surfaceFrom(
      { eco: "go", name: dep.name, version: dep.version, symbol, exports },
      decls,
      parts,
    );
    const go = goOnPath();
    if (!go || parts.length === 0) return surface;
    const where = surface.declarations[0]?.file;
    const sub = where?.includes("/") ? where.slice(0, where.lastIndexOf("/")) : "";
    const doc = await goDoc(repo, go, sub ? `${dep.name}/${sub}` : dep.name, parts.join("."));
    if (doc === undefined) return surface;
    return { ...surface, found: surface.found || doc.length > 0, method: "go doc", docText: doc };
  },

  runtime() {
    const cache = goModCache();
    return {
      ...(goOnPath() ? { interpreter: "go" } : {}),
      readRoots: existsSync(cache) ? [canonical(cache)] : [],
    };
  },
};

/** Exported declarations of a module's Go files (tests and vendor left out). */
function goScan(dep: InstalledDependency): { decls: ScannedDecl[]; exports: string[] } {
  const decls: ScannedDecl[] = [];
  const exports = new Set<string>();
  const exported = (n: string) => /^[A-Z]/.test(n);
  for (const file of goAdapter.files(dep, 300).filter((f) => f.endsWith(".go"))) {
    const read = readInside(dep, file, 400_000);
    if (!read.ok) continue;
    const lines = linesOf(read.text);
    const atRoot = !file.includes("/");
    let block: "type" | "var" | "const" | undefined;
    let body: { container: string; close: string } | undefined;
    const add = (name: string, i: number, container?: string) => {
      const doc = docAbove(lines, i, /^\/\/\s?(.*)$/);
      decls.push({
        name,
        ...(container ? { container } : {}),
        file,
        line: i + 1,
        signature: lines[i] as string,
        ...(doc ? { doc } : {}),
      });
      if (!container && atRoot) exports.add(name);
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (body) {
        if (line.startsWith(body.close)) {
          body = undefined;
          continue;
        }
        const m = /^\s+([A-Za-z_]\w*)(\s|\(|$)/.exec(line);
        if (m && exported(m[1] as string)) add(m[1] as string, i, body.container);
        continue;
      }
      if (block) {
        if (line.startsWith(")")) {
          block = undefined;
          continue;
        }
        const m = /^\t([A-Za-z_]\w*)\b(.*)$/.exec(line);
        if (!m || !exported(m[1] as string)) continue;
        add(m[1] as string, i);
        if (block === "type" && /\b(struct|interface)\s*\{\s*$/.test(m[2] as string))
          body = { container: m[1] as string, close: "\t}" };
        continue;
      }
      const fn = /^func\s+([A-Za-z_]\w*)\s*[[(]/.exec(line);
      if (fn) {
        if (exported(fn[1] as string)) add(fn[1] as string, i);
        continue;
      }
      const method =
        /^func\s+\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)\s*[[(]/.exec(
          line,
        );
      if (method) {
        if (exported(method[2] as string)) add(method[2] as string, i, method[1] as string);
        continue;
      }
      const opened = /^(type|var|const)\s*\(\s*$/.exec(line);
      if (opened) {
        block = opened[1] as "type" | "var" | "const";
        continue;
      }
      const single = /^(type|var|const)\s+([A-Za-z_]\w*)\b(.*)$/.exec(line);
      if (single && exported(single[2] as string)) {
        add(single[2] as string, i);
        if (single[1] === "type" && /\b(struct|interface)\s*\{\s*$/.test(single[3] as string))
          body = { container: single[2] as string, close: "}" };
      }
    }
  }
  return { decls, exports: [...exports].sort() };
}

/**
 * `go doc <package> <symbol>`, confined: no network (GOPROXY=off), the
 * toolchain on the machine only (GOTOOLCHAIN=local), in a scratch copy of
 * go.mod and go.sum so nothing in the worktree is written.
 */
async function goDoc(
  repo: string,
  go: string,
  pkg: string,
  symbol: string,
): Promise<string | undefined> {
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-godoc-"));
  try {
    for (const f of ["go.mod", "go.sum"])
      if (existsSync(join(repo, f))) copyFileSync(join(repo, f), join(scratch, f));
    mkdirSync(join(scratch, "cache"));
    const r = await runConfined(go, ["doc", pkg, symbol], {
      root: scratch,
      timeoutMs: 30_000,
      env: {
        GOPROXY: "off",
        GOFLAGS: "-mod=mod",
        GOTOOLCHAIN: "local",
        GOWORK: "off",
        GOMODCACHE: goModCache(),
        GOCACHE: join(scratch, "cache"),
        GOPATH: join(scratch, "gopath"),
        GOENV: "off",
      },
    });
    return r.exitCode === 0 ? r.stdout.trim().slice(0, 4000) : undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
