import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type {
  CheckpointCommitParams,
  DiffStats,
  GitSyncAdapter,
  RebaseResult,
  StructuralDiff,
  WorktreeRecord,
} from "./types.js";

/** Default co-author for a model's work (Y2). */
export function modelCoAuthor(agentModel: string): string {
  const slug =
    agentModel
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model";
  return `${agentModel} <${slug}@models.sekhemet.local>`;
}

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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

export class NodeGitSyncAdapter implements GitSyncAdapter {
  private projectName: string;

  constructor(
    private repoRoot: string,
    projectName?: string,
  ) {
    // Default to the repository's own directory name. A fixed "sekhemet"
    // produced branches like sekhemet/sekhemet/<card>, which says nothing about
    // which project the work belongs to.
    this.projectName = projectName ?? (basename(repoRoot) || "sekhemet");
  }

  private getWorktreePath(cardId: string): string {
    return join(this.repoRoot, ".sekhemet", "worktrees", cardId);
  }

  /**
   * Run git with an argument vector.
   *
   * `execFileSync` is required rather than preferred: commit messages and branch
   * names originate from model output, and passing them through a shell string
   * makes backticks or $(...) in generated text arbitrary code execution.
   */
  private runGit(args: string[], cwd = this.repoRoot, tolerant = false): string {
    try {
      return execFileSync("git", args, {
        cwd,
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
    for (const name of ["node_modules", ".venv"]) {
      const source = join(this.repoRoot, name);
      const target = join(worktreePath, name);
      if (!existsSync(source) || existsSync(target)) continue;
      try {
        symlinkSync(source, target, "dir");
      } catch {
        // A pre-existing entry or an unsupported filesystem: the gate will
        // report the real consequence rather than failing silently here.
      }
    }
  }

  public async getHeadSha(cwd = this.repoRoot): Promise<string> {
    return this.runGit(["rev-parse", "HEAD"], cwd);
  }

  /**
   * A stable fingerprint of the working tree, including untracked files.
   *
   * Stall detection compares this across turns: without it, a legitimate retry
   * that follows a successful edit is indistinguishable from a true no-op loop.
   */
  public async getRepoStateHash(cardId: string): Promise<string> {
    const worktreePath = this.getWorktreePath(cardId);
    const cwd = existsSync(worktreePath) ? worktreePath : this.repoRoot;
    // `status --porcelain` reflects staged, unstaged and untracked changes.
    const status = this.runGit(["status", "--porcelain=v1", "-z"], cwd);
    const head = this.runGit(["rev-parse", "HEAD"], cwd);
    return `${head}:${Buffer.from(status).toString("base64").slice(0, 64)}`;
  }

  /** Unified diff for the card's worktree against its merge base. */
  public async generateDiff(cardId: string, baseBranch = "main"): Promise<string> {
    const worktreePath = this.getWorktreePath(cardId);
    const cwd = existsSync(worktreePath) ? worktreePath : this.repoRoot;
    this.runGit(["add", "-A"], cwd);
    // `--staged <ref>` compares the index against that ref. Combining it with a
    // `a...b` range is not valid git and aborts the whole run at evidence time,
    // after all the work is done.
    try {
      return this.runGit(["diff", "--staged", baseBranch], cwd);
    } catch {
      // A worktree with no merge base to compare against still has a diff.
      return this.runGit(["diff", "--staged"], cwd);
    }
  }

  /**
   * Files touched and lines added/removed for the card's changes.
   *
   * This is what makes the bounds gate (<=3 files, <200 diff lines) executable;
   * previously nothing computed a diff, so the check could never run.
   */
  public async getDiffStats(cardId: string, baseBranch = "main"): Promise<DiffStats> {
    const worktreePath = this.getWorktreePath(cardId);
    const cwd = existsSync(worktreePath) ? worktreePath : this.repoRoot;
    this.runGit(["add", "-A"], cwd);

    let numstat: string;
    try {
      numstat = this.runGit(["diff", "--numstat", "--staged", baseBranch], cwd);
    } catch {
      numstat = this.runGit(["diff", "--numstat", "--staged"], cwd);
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

    this.runGit(["add", "-A"], worktreePath);
    // Y3: a checkpoint with no change since the last checkpoint is free. It
    // re-points the refs at the existing commit instead of stacking empty
    // commits, so checkpointing on every passing check costs nothing.
    const nothingStaged = this.runGit(["diff", "--cached", "--name-only"], worktreePath) === "";
    const lastMessage = this.runGit(["log", "-1", "--format=%B"], worktreePath);
    if (nothingStaged && lastMessage.includes(`Card: ${params.cardId}`)) {
      const head = this.runGit(["rev-parse", "HEAD"], worktreePath);
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
    this.runGit(["commit", "--allow-empty", "-m", fullMessage], worktreePath);

    const sha = this.runGit(["rev-parse", "HEAD"], worktreePath);

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
  ): Promise<string> {
    const branch = this.branchNameFor(cardId, title);
    const files = this.runGit(["diff", "--name-only", `${targetBranch}...${branch}`])
      .split("\n")
      .filter(Boolean);
    // Attribution from the branch's own checkpoints (Y2): every model that
    // contributed is a co-author of the squashed commit.
    const coAuthors = new Set<string>();
    for (const line of this.runGit(["log", "--format=%B", `${targetBranch}..${branch}`]).split(
      "\n",
    )) {
      const m = /^Co-authored-by:\s*(.+)$/.exec(line.trim());
      if (m?.[1]) coAuthors.add(m[1].trim());
    }

    this.runGit(["checkout", targetBranch]);
    this.runGit(["merge", "--squash", branch]);

    const message = conventionalSquashMessage(cardId, commitMsg, files, title);
    const trailerLines = [`Card: ${cardId}`];
    for (const [key, value] of Object.entries(trailers)) {
      trailerLines.push(`${key}: ${value}`);
      if (key.toLowerCase() === "co-authored-by") coAuthors.delete(value);
    }
    for (const a of [...coAuthors].sort()) trailerLines.push(`Co-authored-by: ${a}`);

    this.runGit(["commit", "-m", `${message}\n\n${trailerLines.join("\n")}`]);
    return this.runGit(["rev-parse", "HEAD"]);
  }

  /**
   * Rebase a card onto the integration branch before Verify (Y6). Uncommitted
   * work is checkpointed first. A conflict aborts the rebase cleanly and is
   * returned as a typed failure naming the files and the conflict hunks.
   */
  public async rebaseOntoIntegration(cardId: string, targetBranch = "main"): Promise<RebaseResult> {
    const cwd = this.getWorktreePath(cardId);
    if (!existsSync(cwd)) throw new Error(`Worktree for card ${cardId} not found at ${cwd}`);
    this.runGit(["add", "-A"], cwd);
    if (this.runGit(["diff", "--cached", "--name-only"], cwd) !== "") {
      this.runGit(
        ["commit", "-m", `checkpoint: before rebase onto ${targetBranch}\n\nCard: ${cardId}`],
        cwd,
      );
    }
    const before = this.runGit(["rev-parse", "HEAD"], cwd);
    const onto = this.runGit(["rev-parse", targetBranch], cwd);
    if (this.runGit(["merge-base", "HEAD", targetBranch], cwd) === onto) {
      return { ok: true, rebased: false, before, after: before };
    }
    try {
      this.runGit(["rebase", targetBranch], cwd);
    } catch {
      const files = this.runGit(["diff", "--name-only", "--diff-filter=U"], cwd)
        .split("\n")
        .filter(Boolean);
      const hunks: string[] = [];
      for (const f of files.slice(0, 5)) {
        try {
          const text = readFileSync(join(cwd, f), "utf8");
          const m = /<<<<<<<[\s\S]*?>>>>>>>[^\n]*/.exec(text);
          if (m) hunks.push(`${f}:\n${m[0].slice(0, 600)}`);
        } catch {
          // Deleted on one side: the name is enough.
        }
      }
      try {
        this.runGit(["rebase", "--abort"], cwd);
      } catch {
        // Already aborted.
      }
      return {
        ok: false,
        before,
        failure: {
          kind: "rebase_conflict",
          onto: targetBranch,
          files,
          excerpt: hunks.join("\n\n"),
          message: `Rebasing ${cardId} onto ${targetBranch} conflicts in ${files.join(", ") || "unknown files"}.`,
        },
      };
    }
    return { ok: true, rebased: true, before, after: this.runGit(["rev-parse", "HEAD"], cwd) };
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
      const cwd = worktree ?? this.repoRoot;
      try {
        if (worktree) this.runGit(["rebase", "--onto", target, oldBase], cwd);
        else this.runGit(["rebase", "--onto", target, oldBase, child], cwd);
        this.runGit(["config", `branch.${child}.sekhemetBase`, target]);
        this.runGit([
          "config",
          `branch.${child}.sekhemetBaseSha`,
          this.runGit(["rev-parse", target]),
        ]);
        results.push({ cardBranch: child, ok: true });
      } catch {
        const files = this.runGit(["diff", "--name-only", "--diff-filter=U"], cwd, true)
          .split("\n")
          .filter(Boolean);
        this.runGit(["rebase", "--abort"], cwd, true);
        results.push({ cardBranch: child, ok: false, files });
      }
      if (!worktree) this.runGit(["checkout", target], this.repoRoot, true);
    }
    return results;
  }

  /**
   * The review diff (Y8): difftastic's syntax-aware diff when `difft` is on
   * PATH, else git's line diff, with the changed files grouped by intent.
   */
  public async structuralDiff(cardId: string, baseBranch = "main"): Promise<StructuralDiff> {
    const worktreePath = this.getWorktreePath(cardId);
    const cwd = existsSync(worktreePath) ? worktreePath : this.repoRoot;
    this.runGit(["add", "-A"], cwd);
    const files = this.runGit(["diff", "--staged", "--name-only", baseBranch], cwd, true)
      .split("\n")
      .filter(Boolean);
    const groups = groupByIntent(files);
    let engine: StructuralDiff["engine"] = "git";
    let text: string;
    if (hasBinary("difft")) {
      try {
        text = execFileSync(
          "git",
          ["-c", "diff.external=difft", "diff", "--staged", "--ext-diff", baseBranch],
          {
            cwd,
            encoding: "utf8",
            env: { ...process.env, DFT_COLOR: "never", DFT_DISPLAY: "inline" },
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        engine = "difftastic";
      } catch {
        text = this.runGit(["diff", "--staged", baseBranch], cwd, true);
      }
    } else {
      text = this.runGit(["diff", "--staged", "--ignore-all-space", baseBranch], cwd, true);
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
