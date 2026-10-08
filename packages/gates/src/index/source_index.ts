import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitEnvFor } from "@sekhemet/sync";
import { gateCopy } from "../copy.js";
import { readWorkspace } from "../workspace.js";
import type {
  EntryPointFact,
  LanguageAdapter,
  ResolvedModule,
  SourceFacts,
  WorkspaceFacts,
} from "./facts.js";
import { typescriptAdapter } from "./typescript.js";

/**
 * The source index (gates rule 28, T2, IX-1): every consumer that needs a
 * file's imports, exports, re-exports, declarations or references asks this
 * one interface, which asks the language's adapter. The facts are a derived
 * cache keyed by the file, its content hash and the parser's version (IX-3):
 * clearing it changes no answer, only the time the answer takes.
 */
export interface SourceIndex {
  /** The repository the index reads; every path it takes and gives is relative to it. */
  readonly root: string;
  /** A file's facts; undefined when it cannot be read. A language with no adapter is `unsupported`. */
  facts(file: string): SourceFacts | undefined;
  /** The facts of `text` as the file `file` (a file at another commit, a buffer being edited). */
  factsOfText(file: string, text: string): SourceFacts;
  /** Resolve a specifier as written in `importer` (IX-2). */
  resolve(importer: string, specifier: string): ResolvedModule;
  /**
   * The source files an adapter reads, sorted, outside `node_modules`,
   * `dist`, `.git`, `.sekhemet` and `coverage`; in a git repository, only
   * those git does not ignore.
   */
  files(): string[];
  /**
   * The names a module exports (`default` for a default export), `export *`
   * followed through the resolver.
   * `complete` is false when a star target cannot be resolved or read, so a
   * caller never presents a partial list as the whole.
   */
  exportedNames(file: string): { names: string[]; complete: boolean };
  /** Each file's direct project imports (every kind, re-exports included), from `files` outward. */
  importGraph(files: readonly string[], maxFiles?: number): Map<string, Set<string>>;
  /** Of `tests`, those that import a `changed` file directly or through others, or are changed themselves (GT-N3-2). */
  reachableTests(changed: readonly string[], tests: readonly string[]): string[];
  /**
   * The workspace the repository is (IX-5): its packages, their dependencies
   * (from the workspace reader, `workspace.ts`) and their declared entry
   * points resolved to source files. Undefined when the root is no workspace.
   */
  workspace(): WorkspaceFacts | undefined;
}

const ADAPTERS: readonly LanguageAdapter[] = [typescriptAdapter];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".sekhemet", "coverage"]);
/** The cache is bounded: past this many entries it starts again. */
const MAX_CACHE_ENTRIES = 20_000;

const cache = new Map<string, SourceFacts>();
let hits = 0;
let misses = 0;

/** Drop every cached fact (IX-3: deleting the cache changes no verdict). */
export function clearSourceIndexCache(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}

/** How the cache has been used since it was last cleared. */
export function sourceIndexCacheStats(): { hits: number; misses: number; entries: number } {
  return { hits, misses, entries: cache.size };
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
};

/** The facts of a file that exists and could not be read: empty, and saying why. */
function unreadableFacts(file: string, reason: string): SourceFacts {
  return {
    ...unsupported(file, ""),
    contentHash: "",
    parseStatus: "unreadable",
    parseReason: reason,
  };
}

/** The facts of a file no adapter reads: empty, and saying so. */
function unsupported(file: string, text: string): SourceFacts {
  const ext = extname(file).toLowerCase();
  return {
    file,
    contentHash: createHash("sha256").update(text).digest("hex"),
    language: LANGUAGE_BY_EXT[ext] ?? (ext ? ext.slice(1) : "unknown"),
    parser: "none",
    parserVersion: "",
    parseStatus: "unsupported",
    parseReason: `no adapter reads ${ext || "this file"} files yet`,
    imports: [],
    exports: [],
    reExports: [],
    declarations: [],
    references: [],
    operators: [],
    testBlocks: [],
    ambientModules: [],
  };
}

/** The facts of `text` as `file`, from the cache when the text and parser are unchanged. */
export function factsOfText(file: string, text: string): SourceFacts {
  const adapter = ADAPTERS.find((a) => a.handles(file));
  if (!adapter) return unsupported(file, text);
  const hash = createHash("sha256").update(text).digest("hex");
  const key = `${adapter.parser}@${adapter.parserVersion}\0${file}\0${hash}`;
  const hit = cache.get(key);
  if (hit) {
    hits++;
    return hit;
  }
  misses++;
  const facts = adapter.facts(file, text);
  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  cache.set(key, facts);
  return facts;
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** An index over the repository at `root`. */
export function createSourceIndex(root: string): SourceIndex {
  const absRoot = resolve(root);
  const rel = (file: string): string =>
    toPosix(isAbsolute(file) ? relative(absRoot, file) : file).replace(/^\.\//, "");
  const byFile = new Map<string, SourceFacts | undefined>();
  let listed: string[] | undefined;

  const facts = (file: string): SourceFacts | undefined => {
    const r = rel(file);
    if (byFile.has(r)) return byFile.get(r);
    let text: string | undefined;
    let unreadable: string | undefined;
    try {
      text = readFileSync(join(absRoot, r), "utf8");
    } catch (err) {
      // A missing file has no facts; one that exists and cannot be read is
      // partial with the reason, never "no exports" (rules 9 and 28b).
      const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable = gateCopy.unreadableReason(code);
    }
    const result =
      text !== undefined
        ? factsOfText(r, text)
        : unreadable
          ? unreadableFacts(r, unreadable)
          : undefined;
    byFile.set(r, result);
    return result;
  };

  const resolveIn = (importer: string, specifier: string): ResolvedModule => {
    const adapter = ADAPTERS.find((a) => a.handles(importer)) ?? typescriptAdapter;
    return adapter.resolve(rel(importer), specifier, absRoot);
  };

  const files = (): string[] => {
    if (listed) return listed;
    const skipped = (f: string) => f.split("/").some((part) => SKIP_DIRS.has(part));
    // In a git repository, git's view: tracked and untracked files, ignored ones excluded.
    try {
      const out = execFileSync(
        "git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        {
          cwd: absRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 256 << 20,
          env: gitEnvFor(absRoot),
        },
      )
        .split("\0")
        .filter(
          (f) =>
            f && !skipped(f) && ADAPTERS.some((a) => a.handles(f)) && existsSync(join(absRoot, f)),
        );
      listed = [...new Set(out)].sort();
      return listed;
    } catch {
      // Not a git repository: walk the directory.
    }
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else if (ADAPTERS.some((a) => a.handles(name))) out.push(toPosix(relative(absRoot, full)));
      }
    };
    walk(absRoot);
    listed = out.sort();
    return listed;
  };

  const exportedNames = (file: string): { names: string[]; complete: boolean } => {
    const names = new Set<string>();
    let complete = true;
    const seen = new Set<string>();
    const visit = (f: string, viaStar: boolean): void => {
      if (seen.has(f)) return;
      seen.add(f);
      const fx = facts(f);
      if (!fx || fx.parseStatus === "unsupported" || fx.parseStatus === "unreadable") {
        complete = false;
        return;
      }
      for (const e of fx.exports) {
        // `export *` never re-exports a default; `export =` lists nothing by name.
        if (e.name === "export=") complete = false;
        else if (!(viaStar && e.name === "default")) names.add(e.name);
      }
      for (const r of fx.reExports) {
        if (r.kind === "named") {
          for (const n of r.names)
            if (!(viaStar && n.exported === "default")) names.add(n.exported);
        } else if (r.kind === "namespace") {
          if (r.namespace) names.add(r.namespace);
        } else {
          const target = resolveIn(f, r.specifier);
          if (target.kind === "file") visit(target.path, true);
          else complete = false;
        }
      }
    };
    visit(rel(file), false);
    return { names: [...names].sort(), complete };
  };

  const importGraph = (start: readonly string[], maxFiles = 500): Map<string, Set<string>> => {
    const graph = new Map<string, Set<string>>();
    const queue = [...new Set(start.map(rel))];
    while (queue.length > 0 && graph.size < maxFiles) {
      const file = queue.shift() as string;
      if (graph.has(file)) continue;
      const edges = new Set<string>();
      graph.set(file, edges);
      const fx = facts(file);
      if (!fx) continue;
      const specifiers = [
        ...fx.imports.map((i) => i.specifier),
        ...fx.reExports.map((r) => r.specifier),
      ];
      for (const specifier of specifiers) {
        if (!specifier.startsWith(".")) continue;
        const target = resolveIn(file, specifier);
        if (target.kind !== "file") continue;
        edges.add(target.path);
        if (!graph.has(target.path)) queue.push(target.path);
      }
    }
    return graph;
  };

  const reachableTests = (changed: readonly string[], tests: readonly string[]): string[] => {
    const changedSet = new Set(changed.map(rel));
    const graph = importGraph(tests, 5_000);
    return tests.filter((t) => {
      const seen = new Set<string>();
      const stack = [rel(t)];
      while (stack.length > 0) {
        const f = stack.pop() as string;
        if (seen.has(f)) continue;
        seen.add(f);
        if (changedSet.has(f)) return true;
        for (const next of graph.get(f) ?? []) stack.push(next);
      }
      return false;
    });
  };

  let workspaceFacts: WorkspaceFacts | undefined | null = null;
  const workspace = (): WorkspaceFacts | undefined => {
    if (workspaceFacts !== null) return workspaceFacts;
    const ws = readWorkspace(absRoot);
    workspaceFacts = ws
      ? {
          tool: ws.tool,
          packages: ws.packages.map((p) => ({
            name: p.name,
            dir: p.dir,
            deps: p.deps,
            entryPoints: entryPoints(absRoot, p.dir),
          })),
        }
      : undefined;
    return workspaceFacts;
  };

  return {
    root: absRoot,
    workspace,
    facts,
    factsOfText,
    resolve: resolveIn,
    files,
    exportedNames,
    importGraph,
    reachableTests,
  };
}

/** Conditions read for an entry point, in order; `types` names declarations, not code. */
const CONDITIONS = ["import", "default", "node", "module", "require"];

/** The file a manifest's `exports` value names: a string, or the first matching condition. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const c of CONDITIONS) {
    const t = exportTarget(record[c]);
    if (t) return t;
  }
  return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A package's declared entry points (its `exports` map, else `main` or
 * `module`), each resolved to the source file it is built from: through the
 * package's `tsconfig.json` (`outDir` back to `rootDir`) when the target is
 * built output, else the target itself when it is source. Otherwise no file:
 * never a guess.
 */
function entryPoints(root: string, dir: string): EntryPointFact[] {
  const manifest = readJson(join(root, dir, "package.json")) ?? {};
  const declared: { subpath: string; target: string }[] = [];
  const exp = manifest.exports;
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    const record = exp as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.some((k) => k.startsWith("."))) {
      for (const k of keys) {
        const t = exportTarget(record[k]);
        if (k.startsWith(".") && t) declared.push({ subpath: k, target: t });
      }
    } else {
      const t = exportTarget(record);
      if (t) declared.push({ subpath: ".", target: t });
    }
  } else if (typeof exp === "string") {
    declared.push({ subpath: ".", target: exp });
  } else {
    const main = [manifest.main, manifest.module].find((m) => typeof m === "string");
    if (typeof main === "string") declared.push({ subpath: ".", target: main });
  }
  const options = (readJson(join(root, dir, "tsconfig.json"))?.compilerOptions ?? {}) as Record<
    string,
    unknown
  >;
  const norm = (p: string) => toPosix(p).replace(/^\.\//, "").replace(/\/$/, "");
  const outDir = typeof options.outDir === "string" ? norm(options.outDir) : undefined;
  const rootDir = typeof options.rootDir === "string" ? norm(options.rootDir) : undefined;
  const manifestFile = `${dir}/package.json`;
  const resolveTo = (target: string): string | undefined => {
    const r = typescriptAdapter.resolve(
      manifestFile,
      target.startsWith(".") ? target : `./${target}`,
      root,
    );
    return r.kind === "file" && !r.path.split("/").some((part) => SKIP_DIRS.has(part))
      ? r.path
      : undefined;
  };
  return declared.map(({ subpath, target }) => {
    const rel = norm(target);
    let file: string | undefined;
    if (
      outDir !== undefined &&
      rootDir !== undefined &&
      (rel === outDir || rel.startsWith(`${outDir}/`))
    ) {
      file = resolveTo(`./${rootDir}${rel.slice(outDir.length)}`);
    }
    file ??= resolveTo(target);
    return { subpath, target, ...(file ? { file } : {}) };
  });
}
