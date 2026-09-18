import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CheckpointCommitParams, GitSyncAdapter, WorktreeRecord } from "./types.js";

export class NodeGitSyncAdapter implements GitSyncAdapter {
  constructor(private repoRoot: string) {}

  private getWorktreePath(cardId: string): string {
    return join(this.repoRoot, ".sekhemet", "worktrees", cardId);
  }

  private runGit(args: string[], cwd = this.repoRoot): string {
    return execSync(`git ${args.join(" ")}`, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  }

  public async createWorktree(cardId: string, baseBranch = "main"): Promise<string> {
    const worktreePath = this.getWorktreePath(cardId);
    const parentDir = join(this.repoRoot, ".sekhemet", "worktrees");
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    const branchName = `card/${cardId}`;
    this.runGit(["worktree", "add", "-B", branchName, `"${worktreePath}"`, baseBranch]);
    return worktreePath;
  }

  public async commitCheckpoint(params: CheckpointCommitParams): Promise<string> {
    const worktreePath = this.getWorktreePath(params.cardId);
    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree for card ${params.cardId} not found at ${worktreePath}`);
    }

    // Stage changes
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

    if (params.coAuthors) {
      for (const author of params.coAuthors) {
        trailers.push(`Co-authored-by: ${author}`);
      }
    }

    const fullMessage = `${header}\n\n${trailers.join("\n")}`;

    // Write commit
    this.runGit(
      ["commit", "--allow-empty", "-m", `"${fullMessage.replace(/"/g, '\\"')}"`],
      worktreePath,
    );

    const sha = this.runGit(["rev-parse", "HEAD"], worktreePath);

    // Update persistent checkpoint reference
    const refName = `refs/sekhemet/checkpoints/${params.cardId}/step_${params.step}`;
    this.runGit(["update-ref", refName, sha]);

    return sha;
  }

  public async squashAndMerge(
    cardId: string,
    targetBranch: string,
    commitMsg: string,
    trailers: Record<string, string> = {},
  ): Promise<string> {
    // 1. Checkout target branch in repoRoot
    this.runGit(["checkout", targetBranch]);

    const branchName = `card/${cardId}`;

    // 2. Squash merge
    this.runGit(["merge", "--squash", branchName]);

    // 3. Assemble final commit message with trailers
    const trailerLines = [`Card: ${cardId}`];
    for (const [key, value] of Object.entries(trailers)) {
      trailerLines.push(`${key}: ${value}`);
    }

    const fullMsg = `${commitMsg}\n\n${trailerLines.join("\n")}`;
    this.runGit(["commit", "-m", `"${fullMsg.replace(/"/g, '\\"')}"`]);

    return this.runGit(["rev-parse", "HEAD"]);
  }

  public async removeWorktree(cardId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(cardId);
    if (existsSync(worktreePath)) {
      try {
        this.runGit(["worktree", "remove", "--force", `"${worktreePath}"`]);
      } catch {
        // Fallback
      }
    }
    this.runGit(["worktree", "prune"]);
  }

  public async listWorktrees(): Promise<WorktreeRecord[]> {
    const output = this.runGit(["worktree", "list", "--porcelain"]);
    const blocks = output.split("\n\n");
    const results: WorktreeRecord[] = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      let path = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice(9).trim();
        } else if (line.startsWith("branch ")) {
          branch = line.slice(7).trim();
        }
      }

      if (path.includes(".sekhemet/worktrees/")) {
        const parts = path.split(".sekhemet/worktrees/");
        const cardId = parts[1]?.split("/")[0] ?? "";
        if (cardId) {
          results.push({ cardId, path, branch });
        }
      }
    }

    return results;
  }
}
