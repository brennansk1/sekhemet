import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parseToml } from "@sekhemet/kernel";
import { packageTables, pinsOf } from "./pins.js";
import {
  type DeclaredDependency,
  type EcosystemAdapter,
  type InstalledDependency,
  type ScannedDecl,
  canonical,
  compareVersions,
  docAbove,
  linesOf,
  pinnedFor,
  readInside,
  surfaceFrom,
  symbolParts,
  walkPackage,
} from "./types.js";

/**
 * Rust (DS-N9-4): Cargo.lock's `[[package]]` name, version and source; a
 * registry crate's source is unpacked under
 * `$CARGO_HOME/registry/src/<index>/<name>-<version>` (any index
 * directory); of several versions in the lock, the one the project uses
 * (`selectVersion`). The API surface is a static scan of `pub` items with
 * their `///` docs, `//!` crate docs and the README, and `#[macro_export]`
 * macros, exported at the crate root. Nothing is compiled or fetched.
 */

const NAME = /^[A-Za-z0-9_-]+$/;

/** Cargo treats `-` and `_` in a crate name alike. */
const crateKey = (name: string): string => name.toLowerCase().replace(/-/g, "_");

export function cargoHome(): string {
  return process.env.CARGO_HOME || join(homedir(), ".cargo");
}

function registryDir(name: string, version: string): string | undefined {
  const src = join(cargoHome(), "registry", "src");
  let indexes: string[];
  try {
    indexes = readdirSync(src).sort();
  } catch {
    return undefined;
  }
  for (const index of indexes) {
    const dir = join(src, index, `${name}-${version}`);
    if (existsSync(join(dir, "Cargo.toml")) || existsSync(join(dir, "src"))) return dir;
  }
  return undefined;
}

const fromRegistry = (origin: string | undefined): boolean =>
  origin !== undefined && /^(registry|sparse)\+/.test(origin);

function onPath(exe: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((d) => existsSync(join(d, exe)));
}

export const rustAdapter: EcosystemAdapter = {
  eco: "rust",

  declared(repo) {
    let toml: Record<string, unknown>;
    try {
      toml = parseToml(readFileSync(join(repo, "Cargo.toml"), "utf8")) as Record<string, unknown>;
    } catch {
      return [];
    }
    const out: DeclaredDependency[] = [];
    for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      const table = toml[field];
      if (!table || typeof table !== "object") continue;
      for (const [name, spec] of Object.entries(table as Record<string, unknown>)) {
        const version =
          typeof spec === "string"
            ? spec
            : typeof (spec as { version?: unknown })?.version === "string"
              ? ((spec as { version: string }).version as string)
              : undefined;
        out.push({
          eco: "rust",
          name,
          ...(version ? { spec: version } : {}),
          field,
          aliases: name.includes("-") ? [name.replace(/-/g, "_")] : [],
        });
      }
    }
    return out;
  },

  resolve(repo, name) {
    if (!NAME.test(name)) return undefined;
    const all = pinsOf(repo).filter((p) => p.eco === "rust" && crateKey(p.name) === crateKey(name));
    if (all.length === 0) return undefined;
    // DS-N9-4: of several versions, the one the project itself uses.
    const chosen = selectVersion(repo, name, [...new Set(all.map((p) => p.version))]);
    const pins = all.filter((p) => p.version === chosen);
    const found = pins
      .filter((p) => fromRegistry(p.origin))
      .map((p) => ({ pin: p, dir: registryDir(p.name, p.version) }))
      .find((c) => c.dir !== undefined);
    const installedVersion = found?.pin.version;
    const pinned = pinnedFor(all, () => true, chosen);
    const pin = found?.pin ?? (pins[0] as (typeof pins)[number]);
    const dep: InstalledDependency = {
      eco: "rust",
      name: pin.name,
      version: chosen,
      ...(installedVersion ? { installedVersion } : {}),
      ...(pinned ? { pinnedVersion: pinned } : {}),
      installed: installedVersion !== undefined,
      ...(found?.dir ? { root: canonical(found.dir) } : {}),
      entries: [crateKey(pin.name)],
    };
    return dep;
  },

  files(dep, limit = 400) {
    const docs: string[] = [];
    const sources: string[] = [];
    walkPackage(
      dep,
      (rel) => {
        if (!rel.includes("/") && /^readme/i.test(rel)) docs.push(rel);
        else if (rel.startsWith("src/") && rel.endsWith(".rs")) sources.push(rel);
        return docs.length + sources.length < limit;
      },
      6,
    );
    sources.sort((a, b) => Number(b === "src/lib.rs") - Number(a === "src/lib.rs"));
    return [...docs, ...sources];
  },

  declarations(dep) {
    return rustScan(dep);
  },

  async apiSurface(_repo, dep, symbol) {
    const { decls, exports } = rustScan(dep);
    return surfaceFrom(
      { eco: "rust", name: dep.name, version: dep.version, symbol, exports },
      decls,
      symbolParts(symbol, [dep.name, crateKey(dep.name)]),
    );
  },

  runtime() {
    const src = join(cargoHome(), "registry", "src");
    return {
      ...(onPath("cargo") ? { interpreter: "cargo" } : {}),
      readRoots: existsSync(src) ? [canonical(src)] : [],
    };
  },
};

/** Whether `version` satisfies one Cargo requirement (`2`, `^0.8`, `~1.2`, `=1.0.109`); others say yes. */
function satisfies(version: string, requirement: string): boolean {
  const req = requirement.trim();
  const m = /^([=^~]?)\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(req);
  if (!m) return true;
  const [, op, major, minor, patch] = m as unknown as [string, string, string, string?, string?];
  const v = version.split(".");
  if (op === "=")
    return [major, minor ?? v[1], patch ?? v[2]].join(".") === v.slice(0, 3).join(".");
  if (v[0] !== major) return false;
  if (op === "~" || major === "0") return minor === undefined || v[1] === minor;
  return true;
}

/**
 * The version of a crate the project uses when Cargo.lock holds several
 * (DS-N9-4): the one the project's own packages (the lock's tables with no
 * `source`) name in their `dependencies` (`syn 2.0.50`), else the one
 * Cargo.toml's requirement selects, else the highest. Always one version.
 */
function selectVersion(repo: string, name: string, versions: string[]): string {
  const sorted = [...versions].sort(compareVersions);
  if (sorted.length === 1) return sorted[0] as string;
  let lock = "";
  try {
    lock = readFileSync(join(repo, "Cargo.lock"), "utf8");
  } catch {
    // No lockfile text: the highest.
  }
  const named = new Set<string>();
  for (const t of packageTables(lock).filter((t) => t.source === undefined))
    for (const d of t.dependencies ?? []) {
      const [n, v] = d.split(/\s+/);
      if (n && v && crateKey(n) === crateKey(name) && sorted.includes(v)) named.add(v);
    }
  if (named.size === 1) return [...named][0] as string;
  const declared = rustAdapter
    .declared(repo)
    .filter((d) => crateKey(d.name) === crateKey(name) && d.spec !== undefined);
  const wanted = sorted.filter((v) =>
    declared.some((d) => (d.spec as string).split(",").every((r) => satisfies(v, r))),
  );
  return (wanted.at(-1) ?? sorted.at(-1)) as string;
}

type Context = {
  kind: "impl" | "trait" | "struct" | "enum" | "mod" | "body";
  name: string;
  depth: number;
  forTrait?: boolean;
};

const ITEM =
  /^\s*pub\s+(?:(?:async|const|unsafe|extern\s+"[^"]*")\s+)*(fn|struct|enum|trait|type|const|static|mod|union)\s+([A-Za-z_]\w*)/;

/** A line without its comment, string and char literals, for counting braces. */
const code = (line: string): string =>
  line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])'/g, "' '")
    .replace(/\/\/.*$/, "");

/** `pub` items of a crate's `src/`, members of its types, and lib.rs's public names. */
function rustScan(dep: InstalledDependency): { decls: ScannedDecl[]; exports: string[] } {
  const decls: ScannedDecl[] = [];
  const exports = new Set<string>();
  for (const file of rustAdapter.files(dep, 300).filter((f) => f.endsWith(".rs"))) {
    const read = readInside(dep, file, 400_000);
    if (!read.ok) continue;
    const lines = linesOf(read.text);
    const isLib = file === "src/lib.rs";
    const stack: Context[] = [];
    let depth = 0;
    const add = (name: string, i: number, container?: string) => {
      const doc = docAbove(lines, i, /^\/\/\/\s?(.*)$/);
      decls.push({
        name,
        ...(container ? { container } : {}),
        file,
        line: i + 1,
        signature: lines[i] as string,
        ...(doc ? { doc } : {}),
      });
    };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] as string;
      const line = code(raw);
      const before = depth;
      const top = stack.at(-1);
      const direct = top !== undefined && top.depth + 1 === before;
      let opens: Context | undefined;
      if (top && top.kind !== "mod") {
        if (direct && top.kind !== "body") {
          const fn =
            /^\s*(pub\s+)?(?:(?:async|const|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z_]\w*)/.exec(
              line,
            );
          if (fn && (top.kind === "trait" || fn[1] || top.forTrait))
            add(fn[2] as string, i, top.name);
          else if (top.kind === "struct") {
            const field = /^\s*pub\s+([A-Za-z_]\w*)\s*:/.exec(line);
            if (field) add(field[1] as string, i, top.name);
          } else if (top.kind === "enum") {
            const variant = /^\s*([A-Z]\w*)\s*(?:[,({=]|$)/.exec(line);
            if (variant) add(variant[1] as string, i, top.name);
          } else if (top.kind === "trait" || top.kind === "impl") {
            const assoc = /^\s*(?:pub\s+)?(?:type|const)\s+([A-Za-z_]\w*)/.exec(line);
            if (assoc && (top.kind === "trait" || /^\s*pub\s/.test(line)))
              add(assoc[1] as string, i, top.name);
          }
        }
        if (fnOpens(line)) opens = { kind: "body", name: "", depth: before };
      } else {
        const item = ITEM.exec(line);
        const impl =
          /^\s*(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?:([\w:<>, &']+?)\s+for\s+)?&?(?:[\w]+::)*([A-Za-z_]\w*)/.exec(
            line,
          );
        const macro = MACRO.exec(line);
        if (macro) {
          // `#[macro_export]` puts the macro at the crate root, whatever its module.
          if (macroExported(lines, i)) {
            add(macro[1] as string, i);
            exports.add(macro[1] as string);
          }
          opens = { kind: "body", name: "", depth: before };
        } else if (item) {
          const [, kind, name] = item as unknown as [string, string, string];
          add(name, i);
          if (isLib) exports.add(name);
          if (kind === "struct" || kind === "enum" || kind === "trait" || kind === "mod")
            opens = { kind: kind as Context["kind"], name, depth: before };
          else if (kind === "fn") opens = { kind: "body", name, depth: before };
        } else if (impl) {
          opens = {
            kind: "impl",
            name: impl[2] as string,
            depth: before,
            forTrait: impl[1] !== undefined,
          };
        } else if (/^\s*pub\s+use\s/.test(line)) {
          for (const n of useNames(line)) {
            add(n, i);
            if (isLib) exports.add(n);
          }
        } else if (fnOpens(line)) opens = { kind: "body", name: "", depth: before };
      }
      for (const ch of line) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      if (opens && depth > before) stack.push(opens);
      while (stack.length > 0 && (stack.at(-1) as Context).depth >= depth) stack.pop();
    }
  }
  return { decls, exports: [...exports].sort() };
}

const fnOpens = (line: string): boolean => /\bfn\s+\w+/.test(line);

const MACRO = /^\s*macro_rules!\s*([A-Za-z_]\w*)/;

/** Whether the attributes directly above line `i` include `#[macro_export]`. */
function macroExported(lines: readonly string[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    const l = (lines[j] ?? "").trim();
    if (l.startsWith("#[macro_export")) return true;
    if (!(l.startsWith("#[") || l.startsWith("///") || l.startsWith("//"))) return false;
  }
  return false;
}

/** The names a `pub use` line brings in: last path elements and `as` aliases. */
function useNames(line: string): string[] {
  const body = line.replace(/^\s*pub\s+use\s+/, "").replace(/;.*$/, "");
  const inner = /\{([^}]*)\}/.exec(body)?.[1];
  const items = inner !== undefined ? inner.split(",") : [body];
  return items
    .map((it) => it.trim())
    .filter(Boolean)
    .map((it) => {
      const alias = /\bas\s+([A-Za-z_]\w*)$/.exec(it)?.[1];
      return alias ?? it.split("::").at(-1)?.trim() ?? "";
    })
    .filter((n) => /^[A-Za-z_]\w*$/.test(n) && n !== "self");
}
