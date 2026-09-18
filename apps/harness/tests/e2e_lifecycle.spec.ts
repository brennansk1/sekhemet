import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { SpidrFeaturePlanner } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initLocalKernel } from "../src/index.js";

describe("@sekhemet/harness E2E Lifecycle", () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), "sekhemet-e2e-"));
    // Initialize real git repo
    execSync("git init -b main", { cwd: tempRepo });
    execSync('git config user.name "E2E Tester"', { cwd: tempRepo });
    execSync('git config user.email "tester@sekhemet.dev"', { cwd: tempRepo });

    writeFileSync(join(tempRepo, "package.json"), '{"name":"test-repo","type":"module"}\n');
    execSync("git add .", { cwd: tempRepo });
    execSync('git commit -m "chore: initial commit"', { cwd: tempRepo });
  });

  afterEach(() => {
    try {
      rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("plans a feature into SPIDR cards, saves them to SQLite WAL, and verifies state", async () => {
    const { cardStore, log, boardService } = initLocalKernel(tempRepo);
    const planner = new SpidrFeaturePlanner();

    const epic = await cardStore.createCard({
      id: "epic_e2e_user",
      tier: "epic",
      title: "User Profile Management System",
      status: "in_progress",
    });

    const decomp = await planner.decomposeFeature(
      epic.id,
      "User profile management with avatars, bio, and settings.",
    );
    expect(decomp.stories.length).toBeGreaterThanOrEqual(3);

    // Save decomposed cards to cardStore
    for (const story of decomp.stories) {
      await cardStore.createCard({
        id: story.id,
        tier: story.tier,
        parentId: story.parentId,
        title: story.title,
        status: story.status,
        scopeFiles: story.scopeFiles,
        stepBudget: story.stepBudget,
      });
    }

    const state = await boardService.getBoardState();
    expect(state.cards.length).toBe(1 + decomp.stories.length);

    // Verify hash chain is unbroken
    const verification = await log.verifyHashChain();
    expect(verification.valid).toBe(true);
    expect(verification.totalEvents).toBe(1 + decomp.stories.length);
  });

  it("executes worktree checkout, writes checkpoint, and verifies gates", async () => {
    const { cardStore } = initLocalKernel(tempRepo);
    const gitAdapter = new NodeGitSyncAdapter(tempRepo);
    const sandbox = new ProcessSandbox();
    const gateRunner = new DeterministicGateRunner(sandbox);

    const card = await cardStore.createCard({
      id: "card_worktree_e2e",
      tier: "task",
      title: "E2E Worktree Execution",
      status: "ready",
      scopeFiles: ["src/hello.js"],
    });

    // 1. Create worktree
    const worktreePath = await gitAdapter.createWorktree(card.id, "main");
    expect(worktreePath).toContain(".sekhemet/worktrees/card_worktree_e2e");

    // 2. Perform file modification in worktree
    writeFileSync(join(worktreePath, "hello.js"), "console.log('e2e passed');\n");

    // 3. Commit checkpoint with trailers
    const sha = await gitAdapter.commitCheckpoint({
      cardId: card.id,
      step: 1,
      totalSteps: 2,
      gateStatus: "pass",
      agentModel: "gemini-2.5-pro",
      agentHarness: "antigravity-cli",
      agentRole: "implementer",
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // 4. Run gate runner on worktree
    const gateResult = await gateRunner.runCustomCommandGate(
      "test",
      "node",
      ["hello.js"],
      worktreePath,
    );
    expect(gateResult.passed).toBe(true);

    // 5. Squash merge into main
    const mergeSha = await gitAdapter.squashAndMerge(
      card.id,
      "main",
      "feat: add hello.js from e2e test",
      {
        "Agent-Model": "gemini-2.5-pro",
        "Agent-Harness": "antigravity-cli",
      },
    );
    expect(mergeSha).toMatch(/^[0-9a-f]{40}$/);

    // 6. Clean up worktree
    await gitAdapter.removeWorktree(card.id);
    const activeWorktrees = await gitAdapter.listWorktrees();
    expect(activeWorktrees.some((w) => w.cardId === card.id)).toBe(false);
  });
});
