import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { matchesScope } from "@sekhemet/kernel";
import { processStartTime, sameProcess } from "@sekhemet/sandbox";
import { hardenGitForProcess } from "./git_hardening.js";
import {
  GitMetadataError,
  gitEnvFor,
  guardedGitEnv,
  resolvedPath,
  stagedGitlinks,
  writeConfigBaseline,
} from "./git_preflight.js";
import { difftasticDiff, resolveReviewProgram } from "./review_diff.js";
import type {
  CheckpointCommitParams,
  DiffStats,
  GitSyncAdapter,
  RebaseConflictFailure,
  RebaseResult,
  StructuralDiff,
  WorktreeRecord,
} from "./types.js";

/**
 * The commit-trailer contract (X26, AGENTS.md): every commit the harness
 * makes carries these; a checkpoint also carries Step and GateStatus.
 */
export const REQUIRED_TRAILERS = [
  "Card",
  "Agent-Model",
  "Agent-Harness",
  "Agent-Role",
  "Co-authored-by",
] as const;
export const CHECKPOINT_TRAILERS = ["Step", "GateStatus"] as const;

/** Trailers of a message: `Key: value` lines of its last paragraph (as git reads them). */
export function parseTrailers(message: string): { key: string; value: string }[] {
  const paragraphs = message.trim().split(/\n\s*\n/);
  const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? "") : "";
  const out: { key: string; value: string }[] = [];
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line.trim());
    if (m) out.push({ key: m[1] as string, value: (m[2] as string).trim() });
  }
  return out;
}

/** The required trailers a message lacks, in contract order. */
export function missingTrailers(message: string, opts: { checkpoint?: boolean } = {}): string[] {
  const have = new Set(parseTrailers(message).map((t) => t.key.toLowerCase()));
  const need = [...REQUIRED_TRAILERS, ...(opts.checkpoint ? CHECKPOINT_TRAILERS : [])];
  return need.filter((k) => !have.has(k.toLowerCase()));
}

/** A squash or revert that conflicts: nothing was written (RG-S5-4). */
export class MergeConflictError extends Error {
  constructor(
    public readonly cardId: string,
    public readonly onto: string,
    public readonly files: string[],
  ) {
    super(
      `${cardId} conflicts with ${onto} in ${files.join(", ") || "unknown files"}; nothing was written and the card stays in Review`,
    );
    this.name = "MergeConflictError";
  }
}

/** Default co-author for a model's work (Y2). */
export function modelCoAuthor(agentModel: string): string {
  const slug =
    agentModel
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model";
  return `${agentModel} <${slug}@models.sekhemet.local>`;
}

export type IntentGroup = "tests" | "source" | "config" | "docs";

const TEST_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:spec|test)\.[\w]+$/;
const DOC_RE = /\.(?:md|mdx|txt|rst)$|(?:^|\/)docs\//;
const CONFIG_RE =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|tsconfig[^/]*\.json|biome\.json|\.[\w-]+rc(?:\.\w+)?|[\w-]+\.(?:toml|ya?ml|ini|cfg))$/;

/** Group changed files by intent: tests, source, config, docs (Y4, Y8). */
export function groupByIntent(files: readonly string[]): Record<IntentGroup, string[]> {
  const out: Record<IntentGroup, string[]> = { source: [], tests: [], config: [], docs: [] };
  for (const f of [...files].sort()) {
    if (TEST_RE.test(f)) out.tests.push(f);
    else if (DOC_RE.test(f)) out.docs.push(f);
    else if (CONFIG_RE.test(f)) out.config.push(f);
    else out.source.push(f);
  }
  return out;
}

/** The scope of a change: the package or app it lives in, when there is one. */
export function scopeOf(files: readonly string[]): string | undefined {
  const scopes = new Set(
    files.map((f) => {
      const parts = f.split("/");
      if ((parts[0] === "packages" || parts[0] === "apps") && parts[1]) return parts[1];
      return parts.length > 1 ? (parts[0] as string) : "";
    }),
  );
  scopes.delete("");
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

/**
 * The squashed commit's Conventional Commits message (Y4). A message in
 * the harness's placeholder form (`type(<card-id>): title`) is rewritten:
 * the type comes from what changed and what the title says, the scope from
 * the package, and the body groups the files by intent. Any other message
 * is the caller's and is kept.
 */
export function conventionalSquashMessage(
  cardId: string,
  commitMsg: string,
  files: readonly string[],
  title?: string,
): string {
  const m = /^(\w+)\(([^)]*)\)!?:\s*(.*)$/.exec(commitMsg.split("\n")[0] ?? "");
  if (!m || m[2] !== cardId) return commitMsg;
  const subject = (title ?? m[3] ?? "").trim();
  const g = groupByIntent(files);
  let type = "feat";
  if (files.length > 0 && g.source.length === 0) {
    type =
      g.tests.length > 0 && g.docs.length === 0
        ? "test"
        : g.docs.length > 0 && g.tests.length === 0 && g.config.length === 0
          ? "docs"
          : "chore";
  } else if (/\b(fix|bug|repair|regression|broken|crash)/i.test(subject)) type = "fix";
  else if (/\b(refactor|rename|extract|move|clean ?up)\b/i.test(subject)) type = "refactor";
  const scope = scopeOf(files);
  const header = `${type}${scope ? `(${scope})` : ""}: ${subject.charAt(0).toLowerCase()}${subject.slice(1)}`;
  const labels: Record<IntentGroup, string> = {
    source: "Source",
    tests: "Tests",
    config: "Config",
    docs: "Docs",
  };
  const body = (Object.keys(labels) as IntentGroup[])
    .filter((k) => g[k].length > 0)
    .map((k) => `${labels[k]}: ${g[k].join(", ")}`)
    .join("\n");
  return body ? `${header}\n\n${body}` : header;
}

/** Convert a card title into a branch-safe slug. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The package managers' dot-entries a worktree's `node_modules` links to (item 24). */
const LINKED_DOT_ENTRIES = [
  ".bin",
  ".pnpm",
  ".modules.yaml",
  ".package-lock.json",
  ".yarn-state.yml",
  ".pnpm-workspace-state",
];

/** Caches a toolchain writes under `node_modules`, created in each worktree (item 24). */
export const WORKTREE_CACHES = [".vite", ".vite-temp", ".cache", ".tmp"] as const;

/** Each repository's name as the person gave it (`--repo`), by its resolved path. */
const GIVEN_NAMES = new Map<string, string>();

/**
 * Remember the name a person gave a repository before its path is resolved
 * (live-test F18 resolves `--repo` to its real path; a symlink's own name
 * stays the project's name, so its card branches keep their names).
 */
export function rememberRepoAsGiven(given: string): void {
  const name = basename(resolve(given));
  if (name) GIVEN_NAMES.set(resolvedPath(given), name);
}

export class NodeGitSyncAdapter implements GitSyncAdapter {
  private projectName: string;

  private readonly repoRoot: string;

  constructor(repoRoot: string, projectName?: string) {
    // Live-test F18: one spelling of the repository, absolute and real, so a
    // worktree git creates (resolving against the repository) and the one the
    // preflight checks (resolving against the process) are the same path.
    this.repoRoot = resolvedPath(repoRoot);
    // S1 defence in depth: never honour repository config that runs programs.
    hardenGitForProcess();
    // Default to the repository's own directory name. A fixed "sekhemet"
    // produced branches like sekhemet/sekhemet/<card>, which says nothing about
    // which project the work belongs to.
    // The name as given (a symlink's own name), so branch names do not move:
    // the command line remembers it before resolving `--repo` (F18 review, minor 2).
    this.projectName =
      projectName ?? GIVEN_NAMES.get(this.repoRoot) ?? (basename(resolve(repoRoot)) || "sekhemet");
  }

  private getWorktreePath(cardId: string): string {
    return join(this.repoRoot, ".sekhemet", "worktrees", cardId);
  }

  /**
   * The worktree preflight (security item 21) and the pinned environment for
   * git in a card's worktree (item 18): `GIT_DIR` and `GIT_WORK_TREE` come
   * from the harness's own record, so a rewritten `.git` pointer changes
   * nothing. Throws `GitMetadataError` (stop reason `git_metadata_tampered`).
   */
  private guard(worktreePath: string): NodeJS.ProcessEnv {
    return guardedGitEnv(this.repoRoot, worktreePath);
  }

  /** Git in a card's worktree, preflighted and pinned; the main checkout otherwise. */
  private worktreeGit(cardId: string): {
    cwd: string;
    git: (args: string[], tolerant?: boolean) => string;
  } {
    const worktreePath = this.getWorktreePath(cardId);
    if (!existsSync(worktreePath)) {
      return {
        cwd: this.repoRoot,
        git: (args, tolerant) => this.runGit(args, this.repoRoot, tolerant),
      };
    }
    const env = this.guard(worktreePath);
    return {
      cwd: worktreePath,
      git: (args, tolerant) => this.runGit(args, worktreePath, tolerant, env),
    };
  }

  /**
   * Run git with an argument vector.
   *
   * `execFileSync` is required rather than preferred: commit messages and branch
   * names originate from model output, and passing them through a shell string
   * makes backticks or $(...) in generated text arbitrary code execution.
   */
  private runGit(
    args: string[],
    cwd = this.repoRoot,
    tolerant = false,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    try {
      return execFileSync("git", args, {
        cwd,
        env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      }).trim();
    } catch (err) {
      if (tolerant) return "";
      throw err;
    }
  }

  /** Branch name for a card: `sekhemet/<project>/<card-id>-<slug>`. */
  public branchNameFor(cardId: string, title?: string): string {
    const slug = title ? slugify(title) : "";
    const suffix = slug ? `${cardId}-${slug}` : cardId;
    return `sekhemet/${this.projectName}/${suffix}`;
  }

  /**
   * The branch a card's worktree starts from (Y1, Y7): the parent card's
   * branch when it exists (a stacked card builds on its parent's unmerged
   * work), else `fallback`.
   */
  public resolveBaseBranch(parentCardId: string | null | undefined, fallback = "main"): string {
    if (!parentCardId) return fallback;
    const prefix = `refs/heads/sekhemet/${this.projectName}/${parentCardId}`;
    const refs = this.runGit([
      "for-each-ref",
      "--format=%(refname:short)",
      `${prefix}`,
      `${prefix}-*`,
    ])
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
    return refs[0] ?? fallback;
  }

  public async createWorktree(
    cardId: string,
    requestedBase = "main",
    title?: string,
    parentCardId?: string | null,
  ): Promise<string> {
    const baseBranch = this.resolveBaseBranch(parentCardId, requestedBase);
    const worktreePath = this.getWorktreePath(cardId);
    const parentDir = join(this.repoRoot, ".sekhemet", "worktrees");
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

    const branchName = this.branchNameFor(cardId, title);

    // Re-attach to an existing worktree rather than failing. A card is retried
    // on repair, resumed after a quota handoff, and re-run after a crash; a
    // create that only works once makes all three impossible.
    if (existsSync(worktreePath)) {
      // Compare real paths: git reports the resolved path (/private/var/...)
      // while callers may hold a symlinked one (/var/..., /tmp/...). A plain
      // string match missed every such worktree and deleted it as an orphan,
      // discarding the work a retry was meant to resume.
      const real = realpathSync(worktreePath);
      const registered = this.runGit(["worktree", "list", "--porcelain"])
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .some((line) => {
          const listed = line.slice("worktree ".length).trim();
          try {
            return realpathSync(listed) === real;
          } catch {
            return listed === worktreePath;
          }
        });
      if (registered) {
        this.linkDependencies(worktreePath);
        return worktreePath;
      }
      // A leftover directory with no registration: git refuses to reuse it.
      rmSync(worktreePath, { recursive: true, force: true });
      this.runGit(["worktree", "prune"]);
    }

    this.ensureHarnessExcludes();
    this.runGit(["worktree", "add", "-B", branchName, worktreePath, baseBranch]);
    // Security §8 Q5: the repository's own program-running keys, before the Worker runs.
    writeConfigBaseline(this.repoRoot, worktreePath);
    // Remember what the branch was cut from, so it can be restacked (Y7).
    this.runGit(["config", `branch.${branchName}.sekhemetBase`, baseBranch]);
    this.runGit([
      "config",
      `branch.${branchName}.sekhemetBaseSha`,
      this.runGit(["rev-parse", baseBranch]),
    ]);
    this.linkDependencies(worktreePath);
    return worktreePath;
  }

  /**
   * Keep generated artifacts out of every card's diff, whatever the project's
   * .gitignore says.
   *
   * Gates run builds inside the worktree (`tsc -b` writes dist/ and
   * .tsbuildinfo), and the diff is taken with `git add -A`. Without this, a
   * one-file card measured as fourteen files, the bounds gate failed on every
   * card, and acceptance would have squash-merged build output into main.
   * `info/exclude` lives in the shared git dir, so it covers all worktrees.
   */
  private ensureHarnessExcludes(): void {
    try {
      const gitDir = this.runGit(["rev-parse", "--git-common-dir"]);
      const absGitDir = isAbsolute(gitDir) ? gitDir : join(this.repoRoot, gitDir);
      const excludePath = join(absGitDir, "info", "exclude");
      const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
      const marker = "# sekhemet: generated artifacts";
      if (existing.includes(marker)) return;
      mkdirSync(dirname(excludePath), { recursive: true });
      appendFileSync(
        excludePath,
        `\n${marker}\nnode_modules\n.venv\ndist/\n*.tsbuildinfo\ncoverage/\n.sekhemet/\n`,
      );
    } catch {
      // Not fatal: the project's own .gitignore still applies.
    }
  }

  /**
   * Symlink installed dependencies into a fresh worktree.
   *
   * A worktree checks out tracked files only, so `node_modules` is absent and
   * every gate fails on a missing toolchain rather than on the card's actual
   * work. Linking is what makes per-card worktrees affordable: copying a
   * dependency tree per card would cost more than the card itself.
   */
  private linkDependencies(worktreePath: string): void {
    // S2 (security item 24): the worktree's own `node_modules` directory,
    // whose entries link into the main checkout's, and its own caches — so a
    // bundler's `.vite/deps` lands in the worktree and dies with it, and the
    // shared tree is never a write target. A whole-tree link from an older
    // worktree is replaced.
    const modules = join(this.repoRoot, "node_modules");
    const target = join(worktreePath, "node_modules");
    const present = (p: string): boolean => {
      try {
        lstatSync(p);
        return true;
      } catch {
        return false;
      }
    };
    if (existsSync(modules)) {
      try {
        if (present(target) && lstatSync(target).isSymbolicLink()) rmSync(target);
        mkdirSync(target, { recursive: true });
      } catch {
        // An unsupported filesystem: the gate reports the real consequence.
      }
      // Package entries and the package managers' own dot-entries are linked;
      // any other dot-directory is a tool's cache from the user's own runs
      // (`.vitest`, `.astro`, `.prisma`…) and is not shared (B1 review).
      for (const entry of readdirSync(modules)) {
        if (
          entry.startsWith(".") &&
          !LINKED_DOT_ENTRIES.includes(entry) &&
          !entry.startsWith(".pnpm-workspace-state")
        ) {
          continue;
        }
        const link = join(target, entry);
        try {
          if (!present(link)) symlinkSync(join(modules, entry), link);
        } catch {
          // One entry that cannot be linked does not stop the others.
        }
      }
      for (const cache of WORKTREE_CACHES) {
        try {
          mkdirSync(join(target, cache), { recursive: true });
        } catch {
          // As above.
        }
      }
    }
    // A `.venv` is linked whole; the sandbox grants no write outside the
    // worktree, so it is read-only to the card (SEC-8a).
    const venv = join(this.repoRoot, ".venv");
    const venvTarget = join(worktreePath, ".venv");
    if (existsSync(venv) && !present(venvTarget)) {
      try {
        symlinkSync(venv, venvTarget, "dir");
      } catch {
        // As above.
      }
    }
  }

  public async getHeadSha(cwd = this.repoRoot): Promise<string> {
    return this.runGit(["rev-parse", "HEAD"], cwd, false, gitEnvFor(cwd));
  }

  /**
   * A stable fingerprint of the working tree, including untracked files.
   *
   * Stall detection compares this across turns: without it, a legitimate retry
   * that follows a successful edit is indistinguishable from a true no-op loop.
   */
  /**
   * A fingerprint of the working tree's CONTENT, for the stall detector.
   *
   * The first version was HEAD plus `git status --porcelain`, which prints
   * " M src/a.ts" however many times that file changes: a check → edit →
   * check on an already-modified file looked like "nothing changed" and drew
   * a false stall warning (Phase A review, 2026-09-22). Now every tracked and
   * untracked, non-ignored file is staged into a throwaway index and hashed
   * as a tree; the real index — and so the Worker's staging — is untouched.
   */
  public async getRepoStateHash(cardId: string): Promise<string> {
    const { cwd, git: guarded } = this.worktreeGit(cardId);
    const pinned = cwd === this.repoRoot ? process.env : this.guard(cwd);
    const head = guarded(["rev-parse", "HEAD"], true);
    const scratch = join(mkdtempSync(join(tmpdir(), "sek-fp-")), "index");
    try {
      const env = { ...pinned, GIT_INDEX_FILE: scratch };
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      git(["read-tree", "HEAD"]);
      git(["add", "-A"]);
      return `${head}:${git(["write-tree"])}`;
    } catch {
      // Not a repository, or no HEAD yet: fall back to what status can say.
      return `${head}:${Buffer.from(guarded(["status", "--porcelain=v1", "-z"], true)).toString("base64")}`;
    } finally {
      rmSync(dirname(scratch), { recursive: true, force: true });
    }
  }

  /** Unified diff for the card's worktree against its merge base. */
  public async generateDiff(cardId: string, baseBranch = "main"): Promise<string> {
    const { git } = this.worktreeGit(cardId);
    git(["add", "-A"]);
    // `--staged <ref>` compares the index against that ref. Combining it with a
    // `a...b` range is not valid git and aborts the whole run at evidence time,
    // after all the work is done.
    try {
      return git(["diff", "--staged", "--no-ext-diff", "--no-textconv", baseBranch]);
    } catch {
      // A worktree with no merge base to compare against still has a diff.
      return git(["diff", "--staged", "--no-ext-diff", "--no-textconv"]);
    }
  }

  /**
   * Files touched and lines added/removed for the card's changes.
   *
   * This is what makes the bounds gate (<=3 files, <200 diff lines) executable;
   * previously nothing computed a diff, so the check could never run.
   */
  public async getDiffStats(cardId: string, baseBranch = "main"): Promise<DiffStats> {
    const { git } = this.worktreeGit(cardId);
    git(["add", "-A"]);

    let numstat: string;
    try {
      numstat = git([
        "diff",
        "--numstat",
        "--staged",
        "--no-ext-diff",
        "--no-textconv",
        baseBranch,
      ]);
    } catch {
      numstat = git(["diff", "--numstat", "--staged", "--no-ext-diff", "--no-textconv"]);
    }

    const filesTouched: string[] = [];
    const perFile: { file: string; added: number; removed: number }[] = [];
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, file] = line.split("\t");
      if (!file) continue;
      filesTouched.push(file);
      // Binary files report "-" rather than a count.
      const a = added === "-" ? 0 : Number.parseInt(added ?? "0", 10) || 0;
      const r = removed === "-" ? 0 : Number.parseInt(removed ?? "0", 10) || 0;
      perFile.push({ file, added: a, removed: r });
      linesAdded += a;
      linesRemoved += r;
    }

    return { filesTouched, linesAdded, linesRemoved, perFile };
  }

  public async commitCheckpoint(params: CheckpointCommitParams): Promise<string> {
    const worktreePath = this.getWorktreePath(params.cardId);
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree for card ${params.cardId} not found at ${worktreePath}`);
    }
    const { git } = this.worktreeGit(params.cardId);

    git(["add", "-A"]);
    // SEC-6: a gitlink in the staged diff is a nested repository; the card fails.
    const gitlinks = stagedGitlinks((args) => git(args));
    if (gitlinks.length > 0) throw new GitMetadataError(gitlinks);
    // Y3: a checkpoint with no change since the last checkpoint is free. It
    // re-points the refs at the existing commit instead of stacking empty
    // commits, so checkpointing on every passing check costs nothing.
    const nothingStaged = git(["diff", "--cached", "--name-only", "--no-ext-diff"]) === "";
    const lastMessage = git(["log", "-1", "--format=%B", "--no-show-signature"]);
    if (nothingStaged && lastMessage.includes(`Card: ${params.cardId}`)) {
      const head = git(["rev-parse", "HEAD"]);
      this.runGit(["update-ref", `refs/sekhemet/steps/${params.cardId}/step_${params.step}`, head]);
      this.runGit(["update-ref", `refs/sekhemet/checkpoints/${params.cardId}`, head]);
      return head;
    }

    const stepLabel = params.totalSteps ? `${params.step}/${params.totalSteps}` : `${params.step}`;
    const header = params.message ?? `checkpoint: step ${params.step} ${params.gateStatus}`;

    const trailers = [
      `Card: ${params.cardId}`,
      `Step: ${stepLabel}`,
      `Agent-Model: ${params.agentModel}`,
      `Agent-Harness: ${params.agentHarness}`,
      `Agent-Role: ${params.agentRole}`,
      `GateStatus: ${params.gateStatus}`,
    ];

    // Y2: every harness commit is attributed. Without explicit co-authors the
    // model that did the work is the co-author.
    for (const author of params.coAuthors ?? [modelCoAuthor(params.agentModel)]) {
      trailers.push(`Co-authored-by: ${author}`);
    }

    const fullMessage = `${header}\n\n${trailers.join("\n")}`;
    // Passed as a single argv element: no quoting, no shell, no injection.
    git(["commit", "--no-verify", "--allow-empty", "-m", fullMessage]);

    const sha = git(["rev-parse", "HEAD"]);

    // Step history lives under its own namespace: git refuses a ref that is both
    // a file and a directory, and the relay protocol (AGENTS.md) reads the singular
    // refs/sekhemet/checkpoints/<card-id>, so the two cannot be nested.
    this.runGit(["update-ref", `refs/sekhemet/steps/${params.cardId}/step_${params.step}`, sha]);
    this.runGit(["update-ref", `refs/sekhemet/checkpoints/${params.cardId}`, sha]);

    return sha;
  }

  public async squashAndMerge(
    cardId: string,
    targetBranch: string,
    commitMsg: string,
    trailers: Record<string, string> = {},
    title?: string,
    options: {
      /** The integration branch's head the preview saw; a moved branch refuses (RG-S5-5). */
      expectedOld?: string;
      /** The squash body (the evidence summary, review-git §2.5.7). */
      body?: string;
    } = {},
  ): Promise<string> {
    const branch = this.branchNameFor(cardId, title);
    const files = this.runGit(["diff", "--name-only", `${targetBranch}...${branch}`])
      .split("\n")
      .filter(Boolean);
    // Attribution from the branch's own checkpoints (Y2): every model that
    // contributed is a co-author of the squashed commit, and the latest
    // checkpoint's model, harness and role fill what the caller left out (X26).
    const coAuthors = new Set<string>();
    const inherited = new Map<string, string>();
    const bodies = this.runGit(["log", "--format=%B%x00", `${targetBranch}..${branch}`])
      .split("\0")
      .filter((b) => b.trim());
    for (const body of bodies) {
      for (const t of parseTrailers(body)) {
        const key = t.key.toLowerCase();
        if (key === "co-authored-by") coAuthors.add(t.value);
        else if (
          ["agent-model", "agent-harness", "agent-role"].includes(key) &&
          !inherited.has(key)
        )
          inherited.set(key, t.value);
      }
    }
    const provided = new Map(Object.entries(trailers).map(([k, v]) => [k.toLowerCase(), v]));
    const trailerLines = [`Card: ${cardId}`];
    for (const [key, value] of Object.entries(trailers)) {
      trailerLines.push(`${key}: ${value}`);
      if (key.toLowerCase() === "co-authored-by") coAuthors.delete(value);
    }
    for (const key of ["Agent-Model", "Agent-Harness", "Agent-Role"]) {
      const value = inherited.get(key.toLowerCase());
      if (!provided.has(key.toLowerCase()) && value) trailerLines.push(`${key}: ${value}`);
    }
    const model = provided.get("agent-model") ?? inherited.get("agent-model");
    if (coAuthors.size === 0 && !provided.has("co-authored-by") && model)
      coAuthors.add(modelCoAuthor(model));
    for (const a of [...coAuthors].sort()) trailerLines.push(`Co-authored-by: ${a}`);

    const message = conventionalSquashMessage(cardId, commitMsg, files, title);
    const body = options.body?.trim();
    const full = `${message}${body ? `\n\n${body}` : ""}\n\n${trailerLines.join("\n")}`;
    // Refused before anything moves: main never receives an unattributed commit.
    const missing = missingTrailers(full);
    if (missing.length > 0)
      throw new Error(`squash of ${cardId} refused: missing trailer(s): ${missing.join(", ")}`);

    // review-git §2.5.2 (RG-S5-1, -2, -4, -5): plumbing, never the person's
    // working copy — the merged tree is computed from the two refs, the
    // squash is a commit object on the integration branch's head, and the
    // ref moves only by compare-and-set from the head the preview saw.
    const old = this.runGit(["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`]);
    if (options.expectedOld && options.expectedOld !== old) {
      throw new Error(
        `${targetBranch} moved since the preview (${options.expectedOld.slice(0, 10)} → ${old.slice(0, 10)}); nothing was written. Review the card against the new ${targetBranch}.`,
      );
    }
    const tree = this.mergeTree(old, branch, cardId, targetBranch);
    const sha = this.runGit(["commit-tree", tree, "-p", old, "-m", full]);
    this.casRef(targetBranch, sha, old, `sekhemet accept ${cardId}`);
    return sha;
  }

  /**
   * `git merge-tree --write-tree` of two commits (git ≥ 2.38): the merged
   * tree's id, or a `MergeConflictError` naming the conflicting files. Writes
   * objects only — no ref, no index, no working-tree file.
   */
  private mergeTree(
    ours: string,
    theirs: string,
    cardId: string,
    onto: string,
    base?: string,
  ): string {
    const args = [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      ...(base ? [`--merge-base=${base}`] : []),
      ours,
      theirs,
    ];
    try {
      return this.runGit(args).split("\n")[0]?.trim() ?? "";
    } catch (err) {
      const e = err as { status?: number; stdout?: string | Buffer };
      if (e.status !== 1) throw err;
      const lines = String(e.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const files = [...new Set(lines.slice(1))].sort();
      throw new MergeConflictError(cardId, onto, files);
    }
  }

  /** `update-ref` with the expected old value: another writer's move is never overwritten. */
  private casRef(branch: string, next: string, expected: string, why: string): void {
    try {
      this.runGit(["update-ref", "-m", why, `refs/heads/${branch}`, next, expected]);
    } catch {
      throw new Error(
        `${branch} moved while this accept ran (expected ${expected.slice(0, 10)}); nothing was written`,
      );
    }
  }

  /**
   * Put the integration branch back where it was (RG-S5-3), only while it
   * still holds `current` — the squash this accept wrote. Never touches the
   * person's checkout.
   */
  public async restoreRef(branch: string, previous: string, current: string): Promise<void> {
    this.casRef(branch, previous, current, "sekhemet accept refused: restore");
  }

  /**
   * Revert an accepted squash on the integration branch (RG-S5-10): the
   * inverse change as a commit of its own on the branch's head, merged with
   * plumbing (`merge-tree --merge-base=<sha> <head> <sha>^`), the ref moved
   * by compare-and-set. Returns the revert commit.
   */
  public async revertSquash(
    branch: string,
    sha: string,
    trailers: Record<string, string>,
  ): Promise<string> {
    const head = this.runGit(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const subject = this.runGit(["log", "-1", "--format=%s", sha]);
    const tree = this.mergeTree(head, `${sha}^`, trailers.Card ?? sha, branch, sha);
    const lines = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
    const message = `Revert "${subject}"\n\nThis reverts commit ${sha}.${lines.length ? `\n\n${lines.join("\n")}` : ""}`;
    const revert = this.runGit(["commit-tree", tree, "-p", head, "-m", message]);
    this.casRef(branch, revert, head, `sekhemet revert ${sha.slice(0, 10)}`);
    return revert;
  }

  /**
   * One accept at a time per repository (review-git §2.5.1, RG-S5-5): an
   * exclusive lock file in the shared git directory, taken over only from a
   * process that no longer exists. The compare-and-set on the ref is the
   * second line: even without the lock, no update is lost.
   */
  public async withAcceptLock<T>(fn: () => Promise<T>): Promise<T> {
    const gitDir = this.runGit(["rev-parse", "--git-common-dir"]);
    const lock = join(
      isAbsolute(gitDir) ? gitDir : join(this.repoRoot, gitDir),
      "sekhemet-accept.lock",
    );
    const take = (): boolean => {
      try {
        // RG-N8-4: pid and process start time, so a recycled pid is not taken for the holder.
        const processStart = processStartTime(process.pid);
        writeFileSync(
          lock,
          JSON.stringify({
            pid: process.pid,
            ...(processStart ? { processStart } : {}),
            at: new Date().toISOString(),
          }),
          { flag: "wx" },
        );
        return true;
      } catch {
        return false;
      }
    };
    const busy = () =>
      new Error("Another accept for this project is in progress; try again when it finishes");
    // A lock whose holder no longer exists is taken over — under a short
    // takeover lock (itself exclusive), and only if it is still the stale lock
    // read, so two processes that both find it stale cannot both remove it
    // (the runner lease's pattern, runtime item 3).
    for (let tries = 0; !take(); tries++) {
      let stale: string;
      try {
        stale = readFileSync(lock, "utf8");
      } catch {
        if (tries < 3) continue; // released meanwhile
        throw busy();
      }
      const holder = lockHolder(stale);
      if (
        holder === undefined ||
        holder.pid === process.pid ||
        sameProcess(holder.pid, holder.processStart) ||
        tries >= 3
      ) {
        throw busy();
      }
      const takeover = `${lock}.takeover`;
      let fd: number;
      try {
        fd = openSync(takeover, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // A takeover lock left by a process killed mid-takeover is stale after 10 s.
        let age = 0;
        try {
          age = Date.now() - statSync(takeover).mtimeMs;
        } catch {
          continue; // its holder finished meanwhile
        }
        if (age <= 10_000) throw busy();
        rmSync(takeover, { force: true });
        continue;
      }
      try {
        let current: string | undefined;
        try {
          current = readFileSync(lock, "utf8");
        } catch {
          current = undefined;
        }
        if (current === stale) rmSync(lock, { force: true });
      } finally {
        closeSync(fd);
        rmSync(takeover, { force: true });
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  /** `git rev-parse --verify <ref>` in the repository (read only). */
  public revParse(ref: string): string {
    return this.runGit(["rev-parse", "--verify", ref]);
  }

  /**
   * Whether `sha` is a commit some branch of this repository reaches (read
   * only): a moved project's folder must hold every merge its accepted cards
   * made (kernel rule 38a, K-N12-7).
   */
  public reachesCommit(sha: string): boolean {
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
    if (
      !this.runGit(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], this.repoRoot, true)
    ) {
      return false;
    }
    return (
      this.runGit(
        ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", sha, "refs/heads"],
        this.repoRoot,
        true,
      ) !== ""
    );
  }

  /**
   * `git init` a new project's folder on `branch` (teams TEAM-54): the folder
   * New project creates on a plan's approval. The process's git is hardened
   * by the constructor, so no repository configuration runs a program.
   */
  public static initRepository(
    folder: string,
    options: { branch?: string; subject: string; card: string },
  ): NodeGitSyncAdapter {
    const adapter = new NodeGitSyncAdapter(folder);
    adapter.runGit(["init", "-q", "-b", options.branch ?? "main"], folder);
    // Its first commit, empty, so a card's worktree has a base to start from;
    // attributed as every harness commit is (X26). Git's identity is the
    // person's; with none configured, the harness names itself.
    const identity = adapter.gitConfig("user.email")
      ? []
      : ["-c", "user.name=Sekhemet", "-c", "user.email=sekhemet@localhost"];
    const message = [
      options.subject,
      "",
      `Card: ${options.card}`,
      "Agent-Model: none",
      "Agent-Harness: sekhemet",
      "Agent-Role: setup",
      `Co-authored-by: ${modelCoAuthor("none")}`,
    ].join("\n");
    adapter.runGit(
      [...identity, "commit", "--no-verify", "--allow-empty", "-q", "-m", message],
      folder,
    );
    return adapter;
  }

  /** A git config value of the repository, or "" (read only). */
  public gitConfig(key: string): string {
    return this.runGit(["config", key], this.repoRoot, true);
  }

  /** The card's branch, found by its card id (any slug), or undefined. */
  public cardBranch(cardId: string): string | undefined {
    return this.runGit(
      [
        "for-each-ref",
        "--format=%(refname:short)",
        `refs/heads/sekhemet/${this.projectName}/${cardId}`,
        `refs/heads/sekhemet/${this.projectName}/${cardId}-*`,
      ],
      this.repoRoot,
      true,
    )
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0];
  }

  /**
   * Run `fn` in a scratch, detached checkout of `ref` under
   * `.sekhemet/worktrees/`, removed afterwards: gates and rebases that need
   * a working tree never use the person's (review-git §2.5.2, NEW-review-git-2).
   */
  public async withScratchCheckout<T>(
    ref: string,
    fn: (path: string) => Promise<T>,
    options: { linkDependencies?: boolean } = {},
  ): Promise<T> {
    const parentDir = join(this.repoRoot, ".sekhemet", "worktrees");
    mkdirSync(parentDir, { recursive: true });
    this.ensureHarnessExcludes();
    const path = mkdtempSync(join(parentDir, "_scratch-"));
    rmSync(path, { recursive: true, force: true });
    this.runGit(["worktree", "add", "--detach", path, ref]);
    try {
      if (options.linkDependencies !== false) this.linkDependencies(path);
      return await fn(path);
    } finally {
      this.runGit(["worktree", "remove", "--force", path], this.repoRoot, true);
      rmSync(path, { recursive: true, force: true });
      this.runGit(["worktree", "prune"], this.repoRoot, true);
    }
  }

  /**
   * Rebase a card onto the integration branch before Verify (Y6). Uncommitted
   * work is checkpointed first. A conflict aborts the rebase cleanly and is
   * returned as typed `GateFailure`-shaped hunks, one per conflicting file,
   * so the next attempt repairs a conflict the way it repairs any other gate
   * failure instead of being told only that something went wrong.
   *
   * `scopeFiles` is the card's declared scope: conflicts outside it are
   * reported separately, because they are not the card's to resolve.
   */
  public async rebaseOntoIntegration(
    cardId: string,
    targetBranch = "main",
    scopeFiles: string[] = [],
  ): Promise<RebaseResult> {
    const cwd = this.getWorktreePath(cardId);
    if (!existsSync(cwd)) throw new Error(`Worktree for card ${cardId} not found at ${cwd}`);
    const env = this.guard(cwd);
    const run = (args: string[], tolerant = false) => this.runGit(args, cwd, tolerant, env);
    run(["add", "-A"]);
    if (run(["diff", "--cached", "--name-only", "--no-ext-diff"]) !== "") {
      // Attributed like any checkpoint (X26): model, role and co-authors
      // carry over from the branch's last commit.
      const last = parseTrailers(run(["log", "-1", "--format=%B"]));
      const get = (k: string) => last.find((t) => t.key.toLowerCase() === k)?.value;
      const model = get("agent-model") ?? "unknown";
      const coAuthors = last.filter((t) => t.key.toLowerCase() === "co-authored-by");
      const lines = [
        `Card: ${cardId}`,
        "Step: rebase",
        `Agent-Model: ${model}`,
        `Agent-Harness: ${get("agent-harness") ?? "sekhemet"}`,
        `Agent-Role: ${get("agent-role") ?? "implementer"}`,
        "GateStatus: partial",
        ...(coAuthors.length
          ? coAuthors.map((t) => `Co-authored-by: ${t.value}`)
          : [`Co-authored-by: ${modelCoAuthor(model)}`]),
      ];
      run([
        "commit",
        "--no-verify",
        "-m",
        `checkpoint: before rebase onto ${targetBranch}\n\n${lines.join("\n")}`,
      ]);
    }
    const before = run(["rev-parse", "HEAD"]);
    const onto = run(["rev-parse", targetBranch]);
    if (run(["merge-base", "HEAD", targetBranch]) === onto) {
      return { ok: true, rebased: false, before, after: before };
    }
    try {
      run(["rebase", targetBranch]);
    } catch {
      const files = run(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      const hunks: string[] = [];
      const failures: RebaseConflictFailure[] = [];
      // Read before the abort: aborting restores the pre-rebase tree and the
      // markers go with it, so this is the only moment the hunks exist.
      for (const f of files) {
        let hunk = "";
        try {
          const text = readFileSync(join(cwd, f), "utf8");
          const m = /<<<<<<<[\s\S]*?>>>>>>>[^\n]*/.exec(text);
          if (m) hunk = m[0].slice(0, 600);
        } catch {
          // Deleted on one side: the name is all there is to report.
        }
        if (hunk && hunks.length < 5) hunks.push(`${f}:\n${hunk}`);
        failures.push({
          rung: "parse",
          layer: "static",
          gate: "rebase",
          exitCode: 1,
          errorExcerpt:
            hunk || `${f} was changed on ${targetBranch} and deleted or moved on this card.`,
          suggestedFixFiles: [f],
          location: { file: f },
          minimalRepro: `git rebase ${targetBranch}`,
          suggestedAction: `Reapply this card's change to ${f} on top of ${targetBranch}: keep what ${targetBranch} added and re-express the card's edit against it.`,
        });
      }
      try {
        run(["rebase", "--abort"]);
      } catch {
        // Already aborted.
      }
      const outOfScope =
        scopeFiles.length === 0
          ? []
          : files.filter((f) => !scopeFiles.some((pattern) => matchesScope(f, pattern)));
      // RG-N1-3: the cards whose accepted changes the conflict is against,
      // from the `Card:` trailers of the integration commits touching the files.
      const otherCards = files.length
        ? [
            ...new Set(
              run(
                [
                  "log",
                  "--format=%(trailers:key=Card,valueonly)",
                  `${before}..${onto}`,
                  "--",
                  ...files,
                ],
                true,
              )
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => /^[\w.:-]+$/.test(l) && l !== cardId),
            ),
          ]
        : [];
      return {
        ok: false,
        before,
        failure: {
          kind: "rebase_conflict",
          onto: targetBranch,
          files,
          excerpt: hunks.join("\n\n"),
          failures,
          outOfScope,
          otherCards,
          message: outOfScope.length
            ? `Rebasing ${cardId} onto ${targetBranch} conflicts in ${outOfScope.join(", ")}, outside this card's declared scope.`
            : `Rebasing ${cardId} onto ${targetBranch} conflicts in ${files.join(", ") || "unknown files"}.`,
        },
      };
    }
    return { ok: true, rebased: true, before, after: run(["rev-parse", "HEAD"]) };
  }

  /**
   * Put an in-scope rebase conflict in front of the Worker (RG-N1-1): the
   * card's branch is kept under `refs/sekhemet/rebase/<card>/<ms>`, moved to
   * the integration branch's tip, and the card's whole change is applied on
   * it as one squash merge — clean files staged, conflicting files left with
   * their markers for the Worker to resolve. Its next checkpoint is then a
   * commit on top of the integration branch, so the next rebase is a no-op.
   */
  public stageRebaseConflict(
    cardId: string,
    targetBranch = "main",
  ): { preservedRef: string; files: string[] } {
    const cwd = this.getWorktreePath(cardId);
    if (!existsSync(cwd)) throw new Error(`Worktree for card ${cardId} not found at ${cwd}`);
    const env = this.guard(cwd);
    const run = (args: string[], tolerant = false) => this.runGit(args, cwd, tolerant, env);
    const before = run(["rev-parse", "HEAD"]);
    const onto = run(["rev-parse", targetBranch]);
    const preservedRef = `refs/sekhemet/rebase/${cardId}/${Date.now()}`;
    run(["update-ref", preservedRef, before]);
    run(["reset", "-q", "--hard", onto]);
    // Exits non-zero on the conflicts it leaves; that is the point.
    run(["merge", "--squash", "--no-commit", before], true);
    const files = run(["diff", "--name-only", "--diff-filter=U"], true).split("\n").filter(Boolean);
    return { preservedRef, files };
  }

  /**
   * Restack the cards built on a parent after the parent was accepted (Y7):
   * each child branch is rebased from the parent's old tip onto `target`,
   * so its diff stays its own. Children with conflicts are reported, not
   * forced.
   */
  public async restackChildren(
    parentCardId: string,
    target = "main",
  ): Promise<{ cardBranch: string; ok: boolean; files?: string[] }[]> {
    const parentBranches = this.runGit([
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/sekhemet/${this.projectName}/${parentCardId}`,
      `refs/heads/sekhemet/${this.projectName}/${parentCardId}-*`,
    ])
      .split("\n")
      .filter(Boolean);
    const results: { cardBranch: string; ok: boolean; files?: string[] }[] = [];
    for (const line of this.runGit(
      ["config", "--get-regexp", "^branch\\..*\\.sekhemetbase$"],
      this.repoRoot,
      true,
    ).split("\n")) {
      const m = /^branch\.(.+)\.sekhemetbase\s+(.+)$/i.exec(line.trim());
      if (!m?.[1] || !m[2] || !parentBranches.includes(m[2])) continue;
      const child = m[1];
      const oldBase = this.runGit(["config", `branch.${child}.sekhemetBaseSha`]);
      const worktree = (await this.listWorktrees()).find(
        (w) => w.branch === `refs/heads/${child}`,
      )?.path;
      // A child with no worktree is rebased in a scratch checkout, never in
      // the person's (review-git §2.5.2): the branch moves by compare-and-set.
      const rebaseIn = (cwd: string, env: NodeJS.ProcessEnv): string[] | undefined => {
        try {
          this.runGit(["rebase", "--onto", target, oldBase], cwd, false, env);
          return undefined;
        } catch {
          const files = this.runGit(["diff", "--name-only", "--diff-filter=U"], cwd, true, env)
            .split("\n")
            .filter(Boolean);
          this.runGit(["rebase", "--abort"], cwd, true, env);
          return files;
        }
      };
      let conflicts: string[] | undefined;
      if (worktree) conflicts = rebaseIn(worktree, this.guard(worktree));
      else {
        const before = this.runGit(["rev-parse", `refs/heads/${child}`]);
        conflicts = await this.withScratchCheckout(
          before,
          async (path) => {
            const files = rebaseIn(path, process.env);
            if (!files)
              this.casRef(
                child,
                this.runGit(["rev-parse", "HEAD"], path),
                before,
                "sekhemet restack",
              );
            return files;
          },
          { linkDependencies: false },
        );
      }
      if (conflicts) {
        results.push({ cardBranch: child, ok: false, files: conflicts });
        continue;
      }
      this.runGit(["config", `branch.${child}.sekhemetBase`, target]);
      this.runGit([
        "config",
        `branch.${child}.sekhemetBaseSha`,
        this.runGit(["rev-parse", target]),
      ]);
      results.push({ cardBranch: child, ok: true });
    }
    return results;
  }

  /**
   * The review diff (Y8): difftastic's syntax-aware diff when `difft` is
   * installed at an allowlisted absolute path, else git's line diff, with the
   * changed files grouped by intent. Git (hardened) reads both sides; difft
   * runs confined over copies of them (item 20b, SEC-19a), never by PATH.
   */
  public async structuralDiff(
    cardId: string,
    baseBranch = "main",
    options: { programs?: Readonly<Record<string, readonly string[]>> } = {},
  ): Promise<StructuralDiff> {
    // RG-S5-19: with the worktree gone, both sides come from refs — the
    // merge base and the card's branch — and nothing is staged or checked
    // out in the person's repository.
    const live = existsSync(this.getWorktreePath(cardId));
    const branch = live ? undefined : this.cardBranch(cardId);
    if (!live && !branch) return { engine: "git", groups: groupByIntent([]), text: "" };
    const { git } = live
      ? this.worktreeGit(cardId)
      : { git: (args: string[], tolerant?: boolean) => this.runGit(args, this.repoRoot, tolerant) };
    // FINDINGS_C1 CLI-08: a live worktree is diffed against where its branch
    // started (the merge base), not the integration branch's head, so work
    // that landed there since is never shown as deleted by this change.
    const liveBase = live
      ? git(["merge-base", baseBranch, "HEAD"], true).trim() || baseBranch
      : undefined;
    const range = live ? ["--staged", liveBase as string] : [`${baseBranch}...${branch}`];
    if (live) git(["add", "-A"]);
    const files = git(["diff", "--name-only", "--no-ext-diff", ...range], true)
      .split("\n")
      .filter(Boolean);
    const groups = groupByIntent(files);
    let engine: StructuralDiff["engine"] = "git";
    let text: string | undefined;
    const difft = resolveReviewProgram("difft", options.programs);
    if (difft) {
      const base = live
        ? (liveBase as string)
        : git(["merge-base", baseBranch, branch as string], true);
      const sides = files.map((path) => ({
        path,
        before: git(["show", `${base}:${path}`], true),
        after: git(["show", live ? `:${path}` : `${branch}:${path}`], true),
      }));
      text = await difftasticDiff(difft, sides);
      if (text !== undefined) engine = "difftastic";
    }
    if (text === undefined && difft) {
      text = git(["diff", "--no-ext-diff", "--no-textconv", ...range], true);
    } else if (text === undefined) {
      text = git(["diff", "--ignore-all-space", "--no-ext-diff", "--no-textconv", ...range], true);
    }
    return { engine, groups, text };
  }

  public async removeWorktree(cardId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(cardId);
    if (existsSync(worktreePath)) {
      try {
        this.runGit(["worktree", "remove", "--force", worktreePath]);
      } catch {
        // Worktree may already be gone; prune below reconciles the metadata.
      }
    }
    this.runGit(["worktree", "prune"]);
  }

  public async listWorktrees(): Promise<WorktreeRecord[]> {
    const output = this.runGit(["worktree", "list", "--porcelain"]);
    const results: WorktreeRecord[] = [];

    for (const block of output.split("\n\n")) {
      let path = "";
      let branch = "";

      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) path = line.slice(9).trim();
        else if (line.startsWith("branch ")) branch = line.slice(7).trim();
      }

      if (path.includes(".sekhemet/worktrees/")) {
        const cardId = path.split(".sekhemet/worktrees/")[1]?.split("/")[0] ?? "";
        if (cardId) results.push({ cardId, path, branch });
      }
    }

    return results;
  }
}

/** The holder recorded in an accept lock — pid and, when written, start time — or undefined. */
function lockHolder(content: string): { pid: number; processStart?: string } | undefined {
  try {
    const { pid, processStart } = JSON.parse(content) as { pid?: unknown; processStart?: unknown };
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
    return { pid, ...(typeof processStart === "string" ? { processStart } : {}) };
  } catch {
    return undefined;
  }
}
