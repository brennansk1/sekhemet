import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildRankedRepoMap } from "@sekhemet/context";
import { onPath } from "@sekhemet/gates";
import { runConfined } from "@sekhemet/sandbox";
import { hardenedGitEnv } from "@sekhemet/sync";
import { type CiStep, deriveGates } from "./init.js";

/**
 * Recon without a model (design-stage §2.10 step 2, DS-TO-5): deterministic
 * readers of a taken-over repository's files and git objects. Nothing here
 * runs repository code or loads a model, so it runs before trust:
 *
 * - manifests and lockfiles, and their dependencies;
 * - each dependency's age: *not checked: offline* when research is off
 *   (the registry lookup is research's, design-stage §2.6);
 * - known vulnerabilities from osv-scanner's offline database when both are
 *   present, otherwise *not checked* with the reason;
 * - scripts and CI steps with the gates they would become (surface 9b);
 * - the ranked repo map;
 * - the last commits, the branches not merged into HEAD with their last
 *   commit, and the churn hotspots;
 * - TODO and FIXME locations, docs and ADRs, agent transcripts found.
 *
 * All repository text is untrusted (security item 42): recon records where
 * it is, and the take-over keeps its free text in the private part.
 */
export interface Recon {
  manifests: string[];
  dependencies: { name: string; version: string; manifest: string }[];
  dependencyAge: string;
  vulnerabilities: string;
  scripts: Record<string, string>;
  ciSteps: CiStep[];
  repoMap: { files: number; tokens: number; top: string[] };
  commits: { commit: string; date: string; subject: string }[];
  branches: { name: string; commit: string; date: string }[];
  hotspots: { path: string; commits: number }[];
  todos: { path: string; line: number }[];
  docs: string[];
  transcripts: string[];
  /** The connected tracker's open issues: read by integrations (B4.4); none connected here. */
  issues: string;
}

export interface ReconOptions {
  /** Research allowed (design-stage §2.6); off by default, so dependency age is not checked. */
  researchAllowed?: boolean;
  /** The osv-scanner program; `false` means not installed. Default: on PATH. */
  osvScanner?: string | false;
  /** osv-scanner's offline database directory. Default: its cache directory. */
  osvDatabase?: string;
}

const MANIFESTS = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "setup.py",
  "Cargo.toml",
  "Cargo.lock",
  "go.mod",
  "go.sum",
  "Gemfile",
  "Gemfile.lock",
  "composer.json",
  "composer.lock",
]);

const SKIP = new Set([
  "node_modules",
  ".git",
  ".sekhemet",
  "dist",
  "build",
  "target",
  ".venv",
  "vendor",
]);

/** Every file under `root`, repository-relative, dependency trees and git metadata skipped. */
export function repoFiles(root: string, max = 20_000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (st.isDirectory()) stack.push(p);
        else if (st.isFile()) out.push(relative(root, p).split("\\").join("/"));
      } catch {
        // unreadable
      }
    }
  }
  return out.sort();
}

/**
 * Item 19's hardened environment with the search for a repository stopped
 * at `root`: a folder inside another repository reads none of the parent's
 * history as its own (git compares the ceiling with the real path).
 */
export function ownRepoGitEnv(root: string): NodeJS.ProcessEnv {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // a missing root: git finds nothing either way
  }
  return { ...hardenedGitEnv(process.env), GIT_CEILING_DIRECTORIES: dirname(real) };
}

/**
 * The harness's own read-only git on a taken-over repository, hardened
 * (item 19) and stopped at `root`; "" when git cannot answer. Recon and the
 * reconciliation of inherited issues (DS-TO-13) read commits through it.
 */
export function reconGit(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: ownRepoGitEnv(root),
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function dependencies(root: string, manifests: readonly string[]): Recon["dependencies"] {
  const out: Recon["dependencies"] = [];
  for (const m of manifests.filter((f) => f.endsWith("package.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, m), "utf8")) as Record<string, unknown>;
      for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
        const deps = pkg[key];
        if (!deps || typeof deps !== "object") continue;
        for (const [name, version] of Object.entries(deps as Record<string, unknown>)) {
          out.push({ name, version: String(version), manifest: m });
        }
      }
    } catch {
      // unreadable manifest
    }
  }
  for (const m of manifests.filter((f) => /(^|\/)requirements\.txt$/.test(f))) {
    for (const line of readFileSync(join(root, m), "utf8").split("\n")) {
      const hit = /^\s*([A-Za-z0-9_.-]+)\s*(?:[=<>!~]=?\s*([^\s;#]+))?/.exec(line);
      if (hit && !line.trim().startsWith("#")) {
        out.push({ name: hit[1] as string, version: hit[2] ?? "*", manifest: m });
      }
    }
  }
  return out;
}

/** osv-scanner's default offline database location (`OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`, else its cache). */
function osvDatabaseDir(explicit?: string): string {
  return (
    explicit ??
    process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY ??
    join(homedir(), process.platform === "darwin" ? "Library/Caches" : ".cache", "osv-scanner")
  );
}

async function vulnerabilities(root: string, options: ReconOptions): Promise<string> {
  const program =
    options.osvScanner === false
      ? undefined
      : (options.osvScanner ?? (onPath("osv-scanner") ? "osv-scanner" : undefined));
  if (!program) return "not checked: osv-scanner is not installed";
  const db = osvDatabaseDir(options.osvDatabase);
  if (!existsSync(db)) return "not checked: no offline vulnerability database";
  const r = await runConfined(
    program,
    ["scan", "source", "--recursive", "--offline-vulnerabilities", "--format", "json", root],
    {
      root,
      writable: [db],
      env: { OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: db },
      timeoutMs: 300_000,
    },
  );
  // 0: nothing found; 1: vulnerabilities found; anything else is no verdict.
  if (r.exitCode !== 0 && r.exitCode !== 1) {
    return `not checked: osv-scanner exited ${r.exitCode}`;
  }
  try {
    const report = JSON.parse(r.stdout) as {
      results?: { packages?: { vulnerabilities?: unknown[] }[] }[];
    };
    const count = (report.results ?? [])
      .flatMap((x) => x.packages ?? [])
      .reduce((n, p) => n + (p.vulnerabilities?.length ?? 0), 0);
    return `${count} known vulnerabilit${count === 1 ? "y" : "ies"} (osv-scanner, offline database)`;
  } catch {
    return "not checked: osv-scanner wrote no readable report";
  }
}

const TEXT_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|c|h|cpp|cs|php|sh|md|sql|ya?ml|toml)$/;
const TRANSCRIPTS = [
  /^\.aider\.chat\.history\.md$/,
  /^\.specstory\//,
  /^\.claude\/.*\.jsonl$/,
  /^\.cursor\/chats?\//,
  /(^|\/)transcripts?\//i,
];

/** Recon of `root` (DS-TO-5): reads files and git objects only; loads no model. */
export async function runRecon(root: string, options: ReconOptions = {}): Promise<Recon> {
  const files = repoFiles(root);
  const manifests = files.filter((f) => MANIFESTS.has(f.split("/").at(-1) as string));
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {};
  } catch {
    scripts = {};
  }
  const map = buildRankedRepoMap(root, { budgetTokens: 2000 });
  const commits = reconGit(root, ["log", "--all", "-n", "20", "--format=%H%x09%cI%x09%s"])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [commit = "", date = "", ...subject] = l.split("\t");
      return { commit, date, subject: subject.join("\t") };
    });
  const branches = reconGit(root, [
    "for-each-ref",
    "--no-merged=HEAD",
    "--format=%(refname:short)%09%(objectname)%09%(committerdate:iso-strict)",
    "refs/heads",
  ])
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name = "", commit = "", date = ""] = l.split("\t");
      return { name, commit, date };
    });
  const churn = new Map<string, number>();
  for (const f of reconGit(root, ["log", "--all", "-n", "1000", "--name-only", "--format="]).split(
    "\n",
  )) {
    if (f.trim()) churn.set(f.trim(), (churn.get(f.trim()) ?? 0) + 1);
  }
  const hotspots = [...churn]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([path, n]) => ({ path, commits: n }));
  const todos: Recon["todos"] = [];
  for (const f of files.filter((x) => TEXT_EXT.test(x))) {
    if (todos.length >= 500) break;
    let text: string;
    try {
      const st = statSync(join(root, f));
      if (st.size > 1024 * 1024) continue;
      text = readFileSync(join(root, f), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      if (/\b(TODO|FIXME)\b/.test(line)) todos.push({ path: f, line: i + 1 });
    });
  }
  const docs = files.filter(
    (f) =>
      /^README(\.[a-z]+)?$/i.test(f) ||
      /^(docs?|adr|decisions)\/.*\.(md|mdx|rst|txt)$/i.test(f) ||
      /(^|\/)(adr|decisions)\/[^/]+\.md$/i.test(f),
  );
  const hidden = files.filter((f) => f.startsWith("."));
  return {
    manifests,
    dependencies: dependencies(root, manifests),
    dependencyAge: options.researchAllowed
      ? "not checked: the registry lookup runs with research (design-stage §2.6)"
      : "not checked: offline",
    vulnerabilities: await vulnerabilities(root, options),
    scripts,
    ciSteps: deriveGates(root).ci,
    repoMap: {
      files: map.files.length,
      tokens: map.usedTokens,
      top: map.files.slice(0, 20).map((f) => f.path),
    },
    commits,
    branches,
    hotspots,
    todos,
    docs,
    transcripts: [...hidden, ...files].filter(
      (f, i, all) => all.indexOf(f) === i && TRANSCRIPTS.some((re) => re.test(f)),
    ),
    issues: "not read: no tracker connected",
  };
}

/** The submodules `.gitmodules` declares (DS-TO-4), read as text: none is cloned or initialised. */
export function declaredSubmodules(root: string): { name: string; path: string; url: string }[] {
  const file = join(root, ".gitmodules");
  if (!existsSync(file)) return [];
  const out: { name: string; path: string; url: string }[] = [];
  let current: { name: string; path: string; url: string } | undefined;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const section = /^\s*\[submodule\s+"([^"]*)"\s*\]/.exec(raw);
    if (section) {
      if (current) out.push(current);
      current = { name: section[1] as string, path: "", url: "" };
      continue;
    }
    const kv = /^\s*(path|url)\s*=\s*(.*?)\s*$/.exec(raw);
    if (kv && current) current[kv[1] as "path" | "url"] = kv[2] as string;
  }
  if (current) out.push(current);
  return out.filter((s) => s.path);
}
