import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseToml } from "@sekhemet/kernel";
import { runConfined } from "@sekhemet/sandbox";
import { pythonImports } from "./imports.js";
import { pinsOf } from "./pins.js";
import {
  type ApiSurface,
  type DeclaredDependency,
  type EcosystemAdapter,
  type InstalledDependency,
  type ScannedDecl,
  canonical,
  docAbove,
  linesOf,
  oneVersion,
  pinnedFor,
  readInside,
  surfaceFrom,
  symbolParts,
  walkPackage,
} from "./types.js";

/**
 * Python (DS-N9-2): the project's virtual environment's site-packages, each
 * distribution read from its `.dist-info` (METADATA for the name, version
 * and long description; RECORD for the files it owns; top_level.txt for its
 * import names). The API surface is read statically, stubs (`.pyi`) before
 * sources; only when static reading has nothing to read (a C extension, a
 * sourceless module) is the standard `inspect` run, through the sandbox
 * with no network and no worktree write. Nothing is installed.
 */

const VENVS = [".venv", "venv", "env"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** PEP 503's normal form of a distribution name. */
export const normalizePython = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The project's virtual environment directory, when it has one. */
function venvOf(repo: string): string | undefined {
  return VENVS.map((v) => join(repo, v)).find((v) => existsSync(join(v, "pyvenv.cfg")));
}

/** The venv's site-packages (posix `lib/python3.x/`, Windows `Lib/`). */
export function sitePackages(repo: string): string | undefined {
  const venv = venvOf(repo);
  if (!venv) return undefined;
  const win = join(venv, "Lib", "site-packages");
  if (existsSync(win)) return canonical(win);
  try {
    const versions = readdirSync(join(venv, "lib"))
      .filter((d) => d.startsWith("python"))
      .sort()
      .reverse();
    for (const v of versions) {
      const site = join(venv, "lib", v, "site-packages");
      if (existsSync(site)) return canonical(site);
    }
  } catch {
    // No lib directory: no site-packages.
  }
  return undefined;
}

function interpreterOf(repo: string): string {
  const venv = venvOf(repo);
  for (const exe of venv ? [join(venv, "bin", "python3"), join(venv, "Scripts", "python.exe")] : [])
    if (existsSync(exe)) return exe;
  return "python3";
}

interface Dist {
  name: string;
  version: string;
  info: string;
  owned: string[];
  imports: string[];
}

function headers(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) break;
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m && !((m[1] as string) in out)) out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

const MODULE_SUFFIX = /\.(py|pyi|pyc)$|\.[\w-]*\.(so|pyd)$|\.(so|pyd)$/;

const distMemo = new Map<string, { stamp: string; dists: Dist[] }>();

/**
 * The installed distributions: a `.dist-info` without METADATA is not one.
 * Read again only when site-packages' own entry list changes (an install or
 * an uninstall rewrites it).
 */
function distributions(site: string): Dist[] {
  let stamp: string;
  try {
    const st = statSync(site, { bigint: true });
    stamp = `${st.mtimeNs}:${st.ctimeNs}`;
  } catch {
    return [];
  }
  const hit = distMemo.get(site);
  if (hit && hit.stamp === stamp) return hit.dists;
  const dists = readDistributions(site);
  distMemo.set(site, { stamp, dists });
  return dists;
}

function readDistributions(site: string): Dist[] {
  let entries: string[];
  try {
    entries = readdirSync(site);
  } catch {
    return [];
  }
  const out: Dist[] = [];
  for (const info of entries.filter((e) => e.endsWith(".dist-info")).sort()) {
    const meta = readText(join(site, info, "METADATA"));
    if (meta === undefined) continue;
    const h = headers(meta);
    const name = h.Name;
    const version = h.Version;
    if (!name || !version) continue;
    const record = readText(join(site, info, "RECORD"));
    const tops = new Set<string>();
    if (record !== undefined) {
      for (const line of record.split(/\r?\n/)) {
        const path =
          (line.startsWith('"') ? line.slice(1).split('"')[0] : line.split(",")[0]) ?? "";
        const first = path.split("/")[0] ?? "";
        if (!first || first === ".." || first === "__pycache__" || first.endsWith(".data"))
          continue;
        tops.add(first);
      }
    }
    const listed = (readText(join(site, info, "top_level.txt")) ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^[A-Za-z_][\w]*$/.test(l));
    if (record === undefined)
      for (const t of listed)
        for (const e of entries) if (e === t || e.replace(MODULE_SUFFIX, "") === t) tops.add(e);
    tops.add(info);
    const imports = listed.length
      ? listed
      : [...tops]
          .filter((t) => t !== info && !t.endsWith(".dist-info"))
          .map((t) => t.replace(MODULE_SUFFIX, ""))
          .filter((t) => /^[A-Za-z_]\w*$/.test(t));
    out.push({ name, version, info, owned: [...tops], imports: [...new Set(imports)] });
  }
  return out;
}

function requirementName(req: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req);
  return m?.[1];
}

export const pythonAdapter: EcosystemAdapter = {
  eco: "python",

  declared(repo) {
    const out: DeclaredDependency[] = [];
    const seen = new Set<string>();
    const add = (name: string | undefined, spec: string, field: string) => {
      if (!name || seen.has(normalizePython(name)) || normalizePython(name) === "python") return;
      seen.add(normalizePython(name));
      out.push({ eco: "python", name, ...(spec ? { spec } : {}), field, aliases: [] });
    };
    const py = readText(join(repo, "pyproject.toml"));
    if (py !== undefined) {
      try {
        const toml = parseToml(py) as Record<string, unknown>;
        const project = toml.project as { dependencies?: unknown } | undefined;
        for (const req of Array.isArray(project?.dependencies) ? project.dependencies : [])
          if (typeof req === "string") {
            const name = requirementName(req);
            add(name, req.slice(name?.length ?? 0).trim(), "pyproject.toml");
          }
        const poetry = (toml.tool as { poetry?: { dependencies?: Record<string, unknown> } })
          ?.poetry?.dependencies;
        for (const [name, spec] of Object.entries(poetry ?? {}))
          add(name, typeof spec === "string" ? spec : "", "pyproject.toml");
      } catch {
        // An unreadable pyproject declares nothing.
      }
    }
    const req = readText(join(repo, "requirements.txt"));
    for (const line of (req ?? "").split(/\r?\n/)) {
      const body = line.replace(/#.*/, "").trim();
      if (!body || body.startsWith("-")) continue;
      const name = requirementName(body);
      add(name, body.slice(name?.length ?? 0).trim(), "requirements.txt");
    }
    return out;
  },

  resolve(repo, name) {
    if (!NAME.test(name)) return undefined;
    const site = sitePackages(repo);
    const wanted = normalizePython(name);
    const dist = site
      ? (distributions(site).find((d) => normalizePython(d.name) === wanted) ??
        distributions(site).find((d) => d.imports.includes(name)))
      : undefined;
    const pins = pinsOf(repo).filter((p) => p.eco === "python");
    const key = normalizePython(dist?.name ?? name);
    const pinned = pinnedFor(pins, (p) => normalizePython(p.name) === key, dist?.version);
    if (dist && site)
      return {
        eco: "python",
        name: dist.name,
        version: dist.version,
        installedVersion: dist.version,
        ...(pinned ? { pinnedVersion: pinned } : {}),
        installed: true,
        root: site,
        owned: dist.owned,
        entries: dist.imports,
      };
    if (!pinned) return undefined;
    const pin = pins.find((p) => normalizePython(p.name) === key);
    return {
      eco: "python",
      name: pin?.name ?? name,
      version: oneVersion(pinned),
      pinnedVersion: pinned,
      installed: false,
      entries: [],
    };
  },

  files(dep, limit = 400) {
    const meta: string[] = [];
    const stubs: string[] = [];
    const sources: string[] = [];
    walkPackage(dep, (rel) => {
      if (rel.endsWith(".dist-info/METADATA")) meta.push(rel);
      else if (rel.endsWith(".pyi")) stubs.push(rel);
      else if (rel.endsWith(".py")) sources.push(rel);
      return meta.length + stubs.length + sources.length < limit;
    });
    return [...meta, ...stubs, ...sources];
  },

  declarations(dep) {
    const files = pythonAdapter.files(dep, 300).filter((f) => !f.endsWith("METADATA"));
    return files.length > 0 ? staticSurface(dep, files) : { decls: [], exports: [] };
  },

  async apiSurface(repo, dep, symbol) {
    const parts = symbolParts(symbol, [dep.name, ...dep.entries]);
    const files = pythonAdapter.files(dep, 300).filter((f) => !f.endsWith("METADATA"));
    const base = {
      eco: "python" as const,
      name: dep.name,
      version: dep.version,
      symbol,
    };
    const statics = files.length > 0 ? staticSurface(dep, files) : undefined;
    const surface = statics
      ? surfaceFrom({ ...base, exports: statics.exports }, statics.decls, parts)
      : undefined;
    if (surface?.found || (surface && !hasCompiled(dep))) return surface;
    const inspected = await inspectSurface(repo, dep, parts, base);
    return inspected ?? surface ?? surfaceFrom({ ...base, exports: [] }, [], parts);
  },

  runtime(repo) {
    const site = sitePackages(repo);
    const venv = venvOf(repo);
    return {
      interpreter: interpreterOf(repo),
      readRoots: site ? [site] : [],
      ...(venv ? { envRoots: [canonical(venv)] } : {}),
    };
  },
};

function hasCompiled(dep: InstalledDependency): boolean {
  let found = false;
  walkPackage(dep, (rel) => {
    found = /\.(so|pyd|pyc)$/.test(rel) && !rel.includes("__pycache__/");
    return !found;
  });
  return found;
}

/** Top-level and class-member declarations of Python source or stubs, in file order. */
function staticSurface(
  dep: InstalledDependency,
  files: readonly string[],
): { decls: ScannedDecl[]; exports: string[] } {
  const decls: ScannedDecl[] = [];
  const exports = new Set<string>();
  const inits = new Set(
    (dep.entries ?? []).flatMap((t) => [
      `${t}/__init__.pyi`,
      `${t}/__init__.py`,
      `${t}.pyi`,
      `${t}.py`,
    ]),
  );
  const initRead = new Set<string>();
  for (const file of files) {
    const read = readInside(dep, file, 400_000);
    if (!read.ok) continue;
    const lines = linesOf(read.text);
    const isInit = inits.has(file);
    // `__init__.pyi` speaks for the package; its `.py` twin is not read for exports.
    const pkgKey = file.replace(/\.pyi?$/, "");
    const useExports = isInit && !initRead.has(pkgKey);
    if (isInit) initRead.add(pkgKey);
    // `from .x import a, b as c` in `__init__` re-exports what it binds.
    if (useExports)
      for (const b of pythonImports(read.text))
        if (b.kind === "from" && b.topLevel && /^[A-Za-z]/.test(b.local)) exports.add(b.local);
    let cls: { name: string; indent?: number } | undefined;
    let all: string[] | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.length - line.trimStart().length;
      if (indent === 0) cls = undefined;
      const doc = () => pyDoc(lines, i);
      if (indent === 0) {
        const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
        const klass = /^class\s+([A-Za-z_]\w*)\b/.exec(line);
        const assign =
          /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(line) ?? /^([A-Za-z_]\w*)\s*:\s*\S/.exec(line);
        const name = def?.[1] ?? klass?.[1] ?? assign?.[1];
        if (klass) cls = { name: klass[1] as string };
        if (name === "__all__") {
          all = [...line.matchAll(/["']([A-Za-z_]\w*)["']/g)].map((m) => m[1] as string);
          continue;
        }
        if (name && !name.startsWith("_")) {
          const d = doc();
          decls.push({ name, file, line: i + 1, signature: line, ...(d ? { doc: d } : {}) });
          if (useExports) exports.add(name);
        }
        continue;
      }
      if (!cls) continue;
      cls.indent ??= indent;
      if (indent !== cls.indent) continue;
      const def = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      const attr =
        /^\s*([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)/.exec(line) ??
        /^\s*([A-Za-z_]\w*)\s*:\s*\S/.exec(line);
      const name = def?.[1] ?? attr?.[1];
      if (name && !name.startsWith("_")) {
        const d = doc();
        decls.push({
          name,
          container: cls.name,
          file,
          line: i + 1,
          signature: line,
          ...(d ? { doc: d } : {}),
        });
      }
    }
    if (all && useExports) for (const n of all) exports.add(n);
  }
  return { decls, exports: [...exports].sort() };
}

/** A docstring's first line below a `def`/`class`, else `#` comments above it. */
function pyDoc(lines: readonly string[], i: number): string | undefined {
  const next = (lines[i + 1] ?? "").trim();
  const m = /^[rRuU]?("""|''')(.*)$/.exec(next);
  if (m) {
    const text = (m[2] as string).replace(/("""|''')\s*$/, "").trim();
    if (text) return text.slice(0, 300);
  }
  return docAbove(lines, i, /^#\s?(.*)$/);
}

/**
 * The standard `inspect`, run confined with no network and no worktree
 * write (security item 4): imports the distribution's modules from
 * site-packages and names what the symbol's object holds. The arguments are
 * passed as argv, never interpolated into the script.
 */
const INSPECT = `
import sys, json, importlib, inspect
site, tops, parts = sys.argv[1], json.loads(sys.argv[2]), json.loads(sys.argv[3])
sys.path.insert(0, site)
mods = []
for t in tops:
    try:
        mods.append(importlib.import_module(t))
    except Exception:
        pass
def find(ps):
    for m in mods:
        obj, ok = m, True
        for p in ps:
            if not hasattr(obj, p):
                ok = False
                break
            obj = getattr(obj, p)
        if ok:
            return obj
    return None
exports = []
for m in mods:
    names = getattr(m, "__all__", None) or [n for n in dir(m) if not n.startswith("_")]
    exports += [n for n in names if isinstance(n, str)]
target = find(parts)
holder = find(parts[:-1]) if len(parts) > 1 else target
members = []
if holder is not None and (inspect.isclass(holder) or inspect.ismodule(holder)) and holder not in mods:
    members = [n for n in dir(holder) if not n.startswith("_")]
sig = ""
doc = ""
if target is not None:
    try:
        sig = parts[-1] + str(inspect.signature(target))
    except Exception:
        sig = parts[-1]
    doc = (inspect.getdoc(target) or "").split("\\n")[0]
print(json.dumps({"loaded": len(mods), "found": target is not None, "exports": sorted(set(exports)), "members": sorted(set(members)), "sig": sig, "doc": doc}))
`;

async function inspectSurface(
  repo: string,
  dep: InstalledDependency,
  parts: readonly string[],
  base: Pick<ApiSurface, "eco" | "name" | "version" | "symbol">,
): Promise<ApiSurface | undefined> {
  if (!dep.root || dep.entries.length === 0 || parts.length === 0) return undefined;
  const scratch = mkdtempSync(join(tmpdir(), "sekhemet-inspect-"));
  try {
    const r = await runConfined(
      interpreterOf(repo),
      [
        "-I",
        "-S",
        "-B",
        "-c",
        INSPECT,
        dep.root,
        JSON.stringify(dep.entries),
        JSON.stringify(parts),
      ],
      {
        root: scratch,
        timeoutMs: 20_000,
        maxMemoryBytes: 512 * 1024 * 1024,
      },
    );
    if (r.exitCode !== 0) return undefined;
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
      loaded?: number;
      found?: boolean;
      exports?: string[];
      members?: string[];
      sig?: string;
      doc?: string;
    };
    if (!out.loaded) return undefined;
    return {
      ...base,
      found: out.found === true,
      exports: out.exports ?? [],
      members: out.members ?? [],
      declarations: out.found
        ? [
            {
              file: "inspect",
              line: 0,
              signature: out.sig ?? "",
              ...(out.doc ? { doc: out.doc } : {}),
            },
          ]
        : [],
      method: "inspect",
    };
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
