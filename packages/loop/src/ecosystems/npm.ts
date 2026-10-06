import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { factsOfText } from "@sekhemet/gates";
import { pinsOf } from "./pins.js";
import {
  type ApiSurface,
  type DeclaredDependency,
  type EcosystemAdapter,
  type InstalledDependency,
  type ScannedDecl,
  canonical,
  dependencyOf,
  jsDocAbove,
  linesOf,
  pinnedFor,
  readInside,
  surfaceFrom,
  symbolParts,
  walkPackage,
} from "./types.js";

/**
 * npm (DS-N9-1): the installed copy under the nearest `node_modules`
 * (pnpm's symlinks resolved to the store), its `package.json` version,
 * README and type declarations; the API surface is read from the
 * declarations through the source index, as `api_surface.ts` reads a
 * type's members.
 */

const NAME = /^(@[\w.-]+\/)?[\w.-]+$/;

function packageDir(repo: string, name: string): string | undefined {
  let here = resolve(repo);
  for (;;) {
    const candidate = join(here, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return canonical(candidate);
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
  const walk = (v: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof v === "string") return void out.add(v);
    if (v && typeof v === "object")
      for (const inner of Object.values(v as Record<string, unknown>)) walk(inner, depth + 1);
  };
  walk(pkg.exports);
  return [...out];
}

function manifest(repo: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

const DECL = /\.d\.[mc]?ts$/;

function sameName(a: string, b: string): boolean {
  return a === b;
}

export const npmAdapter: EcosystemAdapter = {
  eco: "npm",

  declared(repo) {
    const pkg = manifest(repo);
    if (!pkg) return [];
    const out: DeclaredDependency[] = [];
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field];
      if (!deps || typeof deps !== "object") continue;
      for (const [name, spec] of Object.entries(deps as Record<string, unknown>))
        out.push({
          eco: "npm",
          name,
          ...(typeof spec === "string" ? { spec } : {}),
          field,
          aliases: [],
        });
    }
    return out;
  },

  resolve(repo, name) {
    if (!NAME.test(name)) return undefined;
    const dir = packageDir(repo, name);
    let installedVersion: string | undefined;
    let entries: string[] = [];
    if (dir) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
          string,
          unknown
        >;
        installedVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
        entries = entryPoints(pkg);
      } catch {
        installedVersion = undefined;
      }
    }
    const pinned = pinnedFor(
      pinsOf(repo),
      (p) => p.eco === "npm" && sameName(p.name, name),
      installedVersion,
    );
    return dependencyOf(
      { eco: "npm", name, entries, ...(installedVersion && dir ? { root: dir } : {}) },
      installedVersion,
      pinned,
    );
  },

  files(dep, limit = 400) {
    const docs: string[] = [];
    const decls: string[] = [];
    walkPackage(
      dep,
      (rel) => {
        const base = rel.split("/").at(-1) ?? rel;
        if (!rel.includes("/") && /^(readme|changelog)/i.test(base)) docs.push(rel);
        else if (DECL.test(rel)) decls.push(rel);
        return docs.length + decls.length < limit;
      },
      5,
    );
    const typed = dep.entries.map((e) => e.replace(/^\.\//, "")).filter((e) => DECL.test(e));
    decls.sort((a, b) => Number(typed.includes(b)) - Number(typed.includes(a)));
    return [...docs, ...decls];
  },

  declarations(dep) {
    return npmScan(dep);
  },

  async apiSurface(_repo, dep, symbol) {
    const { decls, exports } = npmScan(dep);
    return surfaceFrom(
      { eco: "npm", name: dep.name, version: dep.version, symbol, exports },
      decls,
      symbolParts(symbol, [dep.name, dep.name.split("/").at(-1) ?? dep.name]),
    );
  },

  runtime(repo) {
    const nm = join(repo, "node_modules");
    return { interpreter: "node", readRoots: existsSync(nm) ? [canonical(nm)] : [] };
  },
};

/**
 * Members at depth 0 of a class or interface body (properties and methods),
 * each with its index among the body's lines (0: the line of the `{`).
 */
function bodyMembers(body: string): { name: string; at: number }[] {
  const out: { name: string; at: number }[] = [];
  let depth = 0;
  body.split("\n").forEach((line, at) => {
    if (depth === 0) {
      const m =
        /^\s*(?:readonly\s+|static\s+|get\s+|set\s+|public\s+|protected\s+|abstract\s+)*([A-Za-z_$][\w$]*)\s*[?]?\s*[(<:]/.exec(
          line,
        );
      if (m?.[1] && m[1] !== "constructor" && !/^\s*private\b/.test(line))
        out.push({ name: m[1], at });
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  });
  return out;
}

/** The type declarations' top-level and member declarations, and the package's exports. */
function npmScan(dep: InstalledDependency): { decls: ScannedDecl[]; exports: string[] } {
  const decls: ScannedDecl[] = [];
  const exports = new Set<string>();
  const typed = new Set(dep.entries.map((e) => e.replace(/^\.\//, "")));
  for (const file of npmAdapter.files(dep, 200).filter((f) => DECL.test(f))) {
    const read = readInside(dep, file, 400_000);
    if (!read.ok) continue;
    const lines = linesOf(read.text);
    const facts = factsOfText(file, read.text);
    for (const d of facts.declarations) {
      const signature = lines[d.line - 1] ?? d.name;
      const doc = jsDocAbove(lines, d.line - 1);
      if (d.topLevel) {
        decls.push({ name: d.name, file, line: d.line, signature, ...(doc ? { doc } : {}) });
        // Exported under its own name: a declaration listed as `stringType
        // as string` is exported as `string` (below), never as `stringType`.
        const ownName = d.exportedAtDeclaration || facts.exports.some((e) => e.name === d.name);
        if (d.exported && ownName && (typed.size === 0 || typed.has(file) || exports.size < 80))
          exports.add(d.name);
        if ((d.kind === "class" || d.kind === "interface") && d.bodyOpen < d.bodyClose) {
          // Each member at its own line, its signature that line.
          const openLine = read.text.slice(0, d.bodyOpen).split("\n").length;
          for (const m of bodyMembers(read.text.slice(d.bodyOpen + 1, d.bodyClose))) {
            const line = openLine + m.at;
            decls.push({
              name: m.name,
              container: d.name,
              file,
              line,
              signature: lines[line - 1] ?? m.name,
            });
          }
        }
      } else if (d.container && d.kind === "method") {
        decls.push({ name: d.name, container: d.container, file, line: d.line, signature });
      }
    }
    // `export { stringType as string }` and `export { z }`: the names a
    // module exports through a list, an alias declared at its local's line.
    for (const e of facts.exports) {
      if (e.name === "default") continue;
      if (typed.size === 0 || typed.has(file) || exports.size < 80) exports.add(e.name);
      if (!e.local || e.local === e.name) continue;
      const local = facts.declarations.find((d) => d.topLevel && d.name === e.local);
      if (local)
        decls.push({
          name: e.name,
          file,
          line: local.line,
          signature: lines[local.line - 1] ?? e.name,
        });
    }
    for (const r of facts.reExports)
      for (const n of r.names ?? []) if (n.exported) exports.add(n.exported);
  }
  return { decls: dedupe(decls), exports: [...exports].sort() };
}

function dedupe(decls: ScannedDecl[]): ScannedDecl[] {
  const seen = new Set<string>();
  return decls.filter((d) => {
    const key = `${d.container ?? ""}\0${d.name}\0${d.file}\0${d.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
