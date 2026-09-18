import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeGitSyncAdapter } from "../src/git_adapter.js";

describe("@sekhemet/sync NodeGitSyncAdapter", () => {
  let testRepoDir: string;
  let adapter: NodeGitSyncAdapter;

  beforeEach(() => {
    testRepoDir = mkdtempSync(join(tmpdir(), "sekhemet-sync-test-"));
    // Initialize test repository
    execSync("git init -b main", { cwd: testRepoDir });
    execSync('git config user.name "Test Runner"', { cwd: testRepoDir });
    execSync('git config user.email "test@sekhemet.dev"', { cwd: testRepoDir });

    writeFileSync(join(testRepoDir, "README.md"), "# Test Repo\n");
    execSync("git add .", { cwd: testRepoDir });
    execSync('git commit -m "chore: initial test commit"', { cwd: testRepoDir });

    adapter = new NodeGitSyncAdapter(testRepoDir);
  });

  afterEach(() => {
    try {
      rmSync(testRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("counts only source changes in a card's diff, never build output", async () => {
    // No project .gitignore here on purpose: the harness must not depend on one.
    const worktree = await adapter.createWorktree("card_bounds", "main");
    mkdirSync(join(worktree, "src"), { recursive: true });
    mkdirSync(join(worktree, "dist", "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(worktree, "dist", "src", "a.js"), "export const a = 1;\n");
    writeFileSync(join(worktree, "tsconfig.tsbuildinfo"), "{}");

    const stats = await adapter.getDiffStats("card_bounds", "main");
    expect(stats.filesTouched).toEqual(["src/a.ts"]);
    expect(stats.linesAdded).toBe(2);

    const diff = await adapter.generateDiff("card_bounds", "main");
    expect(diff).toContain("src/a.ts");
    expect(diff).not.toContain("dist/");
  });

  it("can re-attach to an existing worktree instead of failing", async () => {
    const first = await adapter.createWorktree("card_again", "main");
    writeFileSync(join(first, "work.txt"), "in progress\n");
    const second = await adapter.createWorktree("card_again", "main");
    expect(second).toBe(first);
    // Re-attaching must not discard the work already in the worktree.
    expect(readFileSync(join(second, "work.txt"), "utf8")).toBe("in progress\n");
  });

  it("creates an isolated worktree for a card", async () => {
    const worktreePath = await adapter.createWorktree("card_test1", "main");
    expect(worktreePath).toContain("card_test1");

    const worktrees = await adapter.listWorktrees();
    expect(worktrees.some((w) => w.cardId === "card_test1")).toBe(true);
  });

  it("creates a checkpoint commit and updates refs/sekhemet/checkpoints", async () => {
    const worktreePath = await adapter.createWorktree("card_check1", "main");

    // Modify a file in the worktree
    writeFileSync(join(worktreePath, "feature.ts"), "export const a = 1;\n");

    const sha = await adapter.commitCheckpoint({
      cardId: "card_check1",
      step: 1,
      totalSteps: 5,
      gateStatus: "pass",
      agentModel: "gemini-2.5-pro",
      agentHarness: "antigravity-cli",
      agentRole: "implementer",
      coAuthors: ["Claude <claude@anthropic.com>"],
    });

    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // Verify checkpoint ref exists and points to this SHA
    // The relay protocol reads the singular card ref; step history is namespaced
    // separately under refs/sekhemet/steps/ to avoid a git D/F ref conflict.
    const stepSha = execSync("git rev-parse refs/sekhemet/steps/card_check1/step_1", {
      cwd: testRepoDir,
      encoding: "utf8",
    }).trim();
    expect(stepSha).toBe(sha);

    const refSha = execSync("git rev-parse refs/sekhemet/checkpoints/card_check1", {
      cwd: testRepoDir,
    })
      .toString()
      .trim();

    expect(refSha).toBe(sha);

    // Verify commit message contains structured trailers
    const commitMsg = execSync(`git log -n 1 --format=%B ${sha}`, { cwd: testRepoDir }).toString();

    expect(commitMsg).toContain("Card: card_check1");
    expect(commitMsg).toContain("Step: 1/5");
    expect(commitMsg).toContain("Agent-Model: gemini-2.5-pro");
    expect(commitMsg).toContain("Co-authored-by: Claude <claude@anthropic.com>");
  });

  it("squashes and merges a card branch into the target branch", async () => {
    const worktreePath = await adapter.createWorktree("card_merge1", "main");

    writeFileSync(join(worktreePath, "merged.ts"), "export const merged = true;\n");
    await adapter.commitCheckpoint({
      cardId: "card_merge1",
      step: 1,
      gateStatus: "pass",
      agentModel: "gemini-2.5-pro",
      agentHarness: "antigravity-cli",
      agentRole: "implementer",
    });

    const mergeSha = await adapter.squashAndMerge("card_merge1", "main", "feat: add merged file", {
      "Agent-Model": "gemini-2.5-pro",
      "Agent-Harness": "antigravity-cli",
      "Agent-Role": "implementer",
      "Co-authored-by": "Claude <claude@anthropic.com>",
    });

    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);

    const log = execSync("git log main -n 1 --format=%B", { cwd: testRepoDir }).toString();
    expect(log).toContain("feat: add merged file");
    expect(log).toContain("Agent-Model: gemini-2.5-pro");
  });

  it("removes a worktree cleanly", async () => {
    await adapter.createWorktree("card_rem1", "main");
    await adapter.removeWorktree("card_rem1");

    const worktrees = await adapter.listWorktrees();
    expect(worktrees.some((w) => w.cardId === "card_rem1")).toBe(false);
  });
});
