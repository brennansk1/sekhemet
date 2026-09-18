import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointCommitParams, DiffStats, GitSyncAdapter, WorktreeRecord } from "./types.js";

/** Convert a card title into a branch-safe slug. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export class NodeGitSyncAdapter implements GitSyncAdapter {
  constructor(
    private repoRoot: string,
    private projectName = "sekhemet",
  ) {}

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
  private runGit(args: string[], cwd = this.repoRoot): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  }

  /** Branch name for a card: `sekhemet/<project>/<card-id>-<slug>`. */
  public branchNameFor(cardId: string, title?: string): string {
    const slug = title ? slugify(title) : "";
    const suffix = slug ? `${cardId}-${slug}` : cardId;
    return `sekhemet/${this.projectName}/${suffix}`;
  }

  public async createWorktree(
    cardId: string,
    baseBranch = "main",
    title?: string,
  ): Promise<string> {
    const worktreePath = this.getWorktreePath(cardId);
    const parentDir = join(this.repoRoot, ".sekhemet", "worktrees");
    if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });

    const branchName = this.branchNameFor(cardId, title);
    this.runGit(["worktree", "add", "-B", branchName, worktreePath, baseBranch]);
    return worktreePath;
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
    return this.runGit(["diff", "--staged", `${baseBranch}...HEAD`, "--"], cwd);
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
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, file] = line.split("\t");
      if (!file) continue;
      filesTouched.push(file);
      // Binary files report "-" rather than a count.
      linesAdded += added === "-" ? 0 : Number.parseInt(added ?? "0", 10) || 0;
      linesRemoved += removed === "-" ? 0 : Number.parseInt(removed ?? "0", 10) || 0;
    }

    return { filesTouched, linesAdded, linesRemoved };
  }

  public async commitCheckpoint(params: CheckpointCommitParams): Promise<string> {
    const worktreePath = this.getWorktreePath(params.cardId);
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree for card ${params.cardId} not found at ${worktreePath}`);
    }

    this.runGit(["add", "-A"], worktreePath);

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

    for (const author of params.coAuthors ?? []) {
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
    this.runGit(["checkout", targetBranch]);
    this.runGit(["merge", "--squash", this.branchNameFor(cardId, title)]);

    const trailerLines = [`Card: ${cardId}`];
    for (const [key, value] of Object.entries(trailers)) {
      trailerLines.push(`${key}: ${value}`);
    }

    this.runGit(["commit", "-m", `${commitMsg}\n\n${trailerLines.join("\n")}`]);
    return this.runGit(["rev-parse", "HEAD"]);
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
