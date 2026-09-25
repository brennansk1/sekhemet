import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { WORKTREE_GIT_CONFIG, withGitConfig } from "./git_hardening.js";

/**
 * The worktree preflight (security item 21, S1): before the harness runs git
 * in a card's worktree, it checks nothing there can make git run a program or
 * point git somewhere else. A problem stops the card with
 * `git_metadata_tampered` (SEC-2) and names what was found (SEC-3, SEC-6a).
 */
export interface PreflightProblem {
  kind: "pointer" | "config" | "bare_repo" | "nested_git" | "gitmodules_cr" | "gitlink";
  detail: string;
}

export class GitMetadataError extends Error {
  public readonly reason = "git_metadata_tampered" as const;
  constructor(public readonly problems: PreflightProblem[]) {
    super(`git refused in this worktree: ${problems.map((p) => p.detail).join("; ")}`);
    this.name = "GitMetadataError";
  }
}

/** Config keys that make git run a program or reach elsewhere (item 21). */
const REFUSED_KEYS: readonly RegExp[] = [
  /^core\.(fsmonitor|hookspath|sshcommand|pager|editor|askpass|gitproxy)$/i,
  /^filter\./i,
  /^diff\..+\.(command|textconv)$/i,
  /^diff\.external$/i,
  /^merge\..+\.driver$/i,
  /^include/i,
  /^gpg\./i,
  /^credential\./i,
  /^remote\..+\.(uploadpack|receivepack)$/i,
];

/** Top-level directories never scanned: dependency trees are linked in, not the Worker's. */
const SKIP = new Set(["node_modules", ".venv", ".sekhemet"]);

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * The harness's own record of a worktree's gitdir (item 18): the entry under
 * `<main>/.git/worktrees/` whose `gitdir` file points back at this worktree.
 */
export function recordedGitDir(repoRoot: string, worktree: string): string | undefined {
  const base = join(repoRoot, ".git", "worktrees");
  if (!existsSync(base)) return undefined;
  const want = real(join(worktree, ".git"));
  for (const name of readdirSync(base)) {
    const pointer = join(base, name, "gitdir");
    if (!existsSync(pointer)) continue;
    if (real(readFileSync(pointer, "utf8").trim()) === want) return join(base, name);
  }
  return undefined;
}

function pointerProblem(repoRoot: string, worktree: string): PreflightProblem | undefined {
  const dotGit = join(worktree, ".git");
  const recorded = recordedGitDir(repoRoot, worktree);
  if (!recorded) return { kind: "pointer", detail: "no recorded gitdir for this worktree" };
  let named: string | undefined;
  try {
    if (lstatSync(dotGit).isFile()) {
      named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
    }
  } catch {
    named = undefined;
  }
  if (!named) return { kind: "pointer", detail: ".git is not a gitdir pointer" };
  const target = real(resolve(worktree, named));
  return target === real(recorded)
    ? undefined
    : { kind: "pointer", detail: `.git points at ${target}, not the recorded ${real(recorded)}` };
}

/** Program-running keys the repository's own config sets, as `key=value` (local and worktree scope). */
function refusedEntries(gitDir: string, worktree: string): string[] | undefined {
  let text: string;
  try {
    text = execFileSync("git", ["config", "--no-includes", "--list", "--show-scope", "--null"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_DIR: gitDir,
        GIT_WORK_TREE: worktree,
      },
    });
  } catch {
    return undefined;
  }
  const out: string[] = [];
  // --null: "scope\0key\nvalue\0" per entry.
  const parts = text.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const [key = "", ...value] = (parts[i + 1] ?? "").split("\n");
    if (scope !== "local" && scope !== "worktree") continue;
    if (REFUSED_KEYS.some((r) => r.test(key))) out.push(`${key}=${value.join("\n")}`);
  }
  return out.sort();
}

const BASELINE = "sekhemet-config-baseline";

/**
 * Record the program-running keys the repository already sets when a card's
 * worktree is created — Husky's `core.hooksPath`, Git LFS's `filter.lfs.*` —
 * in the harness's own gitdir entry, which the Worker cannot write. The
 * preflight then refuses only keys that differ from this record (security
 * §8 Q5): the pinned config already neutralises hooks, and the user's own
 * setup is not the attack.
 */
export function writeConfigBaseline(repoRoot: string, worktree: string): void {
  const gitDir = recordedGitDir(repoRoot, worktree);
  if (!gitDir) return;
  const entries = refusedEntries(gitDir, worktree) ?? [];
  writeFileSync(join(gitDir, BASELINE), JSON.stringify(entries), { mode: 0o600 });
}

function configProblems(gitDir: string, worktree: string): PreflightProblem[] {
  const entries = refusedEntries(gitDir, worktree);
  if (!entries) return [{ kind: "config", detail: "the repository config could not be read" }];
  let baseline: string[] = [];
  try {
    baseline = JSON.parse(readFileSync(join(gitDir, BASELINE), "utf8")) as string[];
  } catch {
    baseline = [];
  }
  const known = new Set(baseline);
  return entries
    .filter((e) => !known.has(e))
    .map((e) => ({ kind: "config" as const, detail: `repository config sets ${e.split("=")[0]}` }));
}

function scanProblems(worktree: string): PreflightProblem[] {
  const out: PreflightProblem[] = [];
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    if (dir !== worktree && names.has("HEAD") && names.has("objects")) {
      out.push({
        kind: "bare_repo",
        detail: `embedded bare repository at ${relative(worktree, dir)}`,
      });
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.name === ".git") {
        if (dir !== worktree)
          out.push({
            kind: "nested_git",
            detail: `${relative(worktree, path)} below the worktree root`,
          });
        continue;
      }
      if (e.name === ".gitmodules" && e.isFile() && readFileSync(path, "utf8").includes("\r")) {
        out.push({
          kind: "gitmodules_cr",
          detail: `${relative(worktree, path) || ".gitmodules"} contains a carriage return`,
        });
      }
      if (e.isDirectory() && !e.isSymbolicLink() && !(dir === worktree && SKIP.has(e.name))) {
        walk(path);
      }
    }
  };
  walk(worktree);
  return out;
}

/** Every problem the preflight finds; empty when git may run here. */
export function preflightWorktree(repoRoot: string, worktree: string): PreflightProblem[] {
  const pointer = pointerProblem(repoRoot, worktree);
  // SEC-2: with a rewritten pointer, run no git at all.
  if (pointer) return [pointer];
  const gitDir = recordedGitDir(repoRoot, worktree) as string;
  return [...configProblems(gitDir, worktree), ...scanProblems(worktree)];
}

/** Gitlinks (mode 160000) the staged diff adds: a nested repository by the back door (SEC-6). */
export function stagedGitlinks(run: (args: string[]) => string): PreflightProblem[] {
  // `diff.ignoreSubmodules=all` (item 19) would hide exactly what this looks for.
  return run([
    "diff",
    "--cached",
    "--raw",
    "--ignore-submodules=none",
    "--no-ext-diff",
    "--no-textconv",
    "-z",
  ])
    .split(":")
    .filter(Boolean)
    .flatMap((entry) => {
      const [meta, path] = entry.split("\0");
      const newMode = meta?.split(" ")[1];
      return newMode === "160000" && path
        ? [{ kind: "gitlink" as const, detail: `the staged diff adds a gitlink at ${path}` }]
        : [];
    });
}

/**
 * The environment for git in a card's worktree (items 18–21): the preflight
 * passes, `GIT_DIR` and `GIT_WORK_TREE` come from the harness's record, the
 * ceiling stops discovery above the repository, and the worktree-only pins
 * apply. Throws `GitMetadataError` otherwise.
 */
export function guardedGitEnv(repoRoot: string, worktree: string): NodeJS.ProcessEnv {
  const problems = preflightWorktree(repoRoot, worktree);
  if (problems.length > 0) throw new GitMetadataError(problems);
  return withGitConfig(
    {
      ...process.env,
      GIT_DIR: recordedGitDir(repoRoot, worktree) as string,
      GIT_WORK_TREE: worktree,
      GIT_CEILING_DIRECTORIES: dirname(repoRoot),
    },
    WORKTREE_GIT_CONFIG,
  );
}

/**
 * The environment for git in `dir`: guarded when `dir` is a card's worktree
 * (`<repo>/.sekhemet/worktrees/<card>`), the process's hardened one otherwise.
 */
export function gitEnvFor(dir: string): NodeJS.ProcessEnv {
  const parent = dirname(resolve(dir));
  if (basename(parent) === "worktrees" && basename(dirname(parent)) === ".sekhemet") {
    return guardedGitEnv(dirname(dirname(parent)), resolve(dir));
  }
  return process.env;
}
