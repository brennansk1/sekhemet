import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicGateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";
import { CardExecutionSessionImpl } from "../src/session.js";

const now = new Date().toISOString();
const card = (over: Partial<CardRecord> = {}): CardRecord => ({
  id: "card_budget",
  tier: "story",
  title: "Budget card",
  status: "ready",
  scopeFiles: ["src/big.ts"],
  stepBudget: 12,
  stepsUsed: 0,
  createdAt: now,
  updatedAt: now,
  spec: "Edit src/big.ts.",
  ...over,
});

/** An adapter with a small window that records every request it is sent. */
function recorder(contextTokens: number, maxTokens: number) {
  const seen: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter = {
    modelId: "recorder",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens, maxTokens },
    generate: async (req) => {
      seen.push(req);
      return {
        text: "",
        toolCalls: [{ id: "r", name: "read_file", arguments: { path: "src/big.ts" } }],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

describe("@sekhemet/loop context budget and error containment", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "budget-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "t@t.t"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo });
    execFileSync("mkdir", ["-p", join(repo, "src")]);
    // A large scope file: pinned in full it alone would overflow the window.
    writeFileSync(
      join(repo, "src", "big.ts"),
      `${"export const x = 1; // padding\n".repeat(1800)}`,
    );
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repo });
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("keeps every request inside the model's window as history grows", async () => {
    const { adapter, seen } = recorder(16384, 4096);
    const session = new CardExecutionSessionImpl({
      cardId: "card_budget",
      card: card(),
      stepBudget: 8,
      worktreePath: repo,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox()),
      scopeFiles: ["src/big.ts"],
    });
    for (let i = 0; i < 6; i++) await session.executeTurn();

    const budget = 16384 - 4096 - 256;
    for (const req of seen) {
      const chars =
        (req.systemPrompt ?? "").length + req.prompt.length + JSON.stringify(req.tools).length;
      expect(Math.ceil(chars / 3.2)).toBeLessThanOrEqual(budget);
    }
    // The oversized scope file was dropped from the pinned context, not sent.
    expect(seen.at(-1)?.prompt).not.toContain("SCOPE FILE: src/big.ts");
  });

  it("sends the full pinned context when it fits", async () => {
    writeFileSync(join(repo, "src", "big.ts"), "export const x = 1;\n");
    const { adapter, seen } = recorder(16384, 4096);
    const session = new CardExecutionSessionImpl({
      cardId: "card_budget",
      card: card(),
      stepBudget: 2,
      worktreePath: repo,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox()),
      scopeFiles: ["src/big.ts"],
    });
    await session.executeTurn();
    expect(seen[0]?.prompt).toContain("SCOPE FILE: src/big.ts");
  });

  it("ends the card with reason 'error' when the model request fails, without throwing", async () => {
    const failing: LocalInferenceAdapter = {
      modelId: "failing",
      supportedArms: ["arm_a_flat"],
      generate: async () => {
        throw new Error("Inference HTTP 400: request exceeds the available context size");
      },
    };
    const runner = new CardRunner({
      card: card(),
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", "card_budget"),
      stepBudget: 4,
      modelAdapter: failing,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox()),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/big.ts"],
    });

    const result = await runner.run();
    expect(result.passed).toBe(false);
    expect(result.stopReason).toBe("error");
    expect(result.evidence.stopReason).toBe("error");
  });

  it("reports every completed turn to onTurn, and a failing recorder never fails the card", async () => {
    const { adapter } = recorder(16384, 4096);
    const seen: { cardId: string; turn: number; calls: string[] }[] = [];
    let calls = 0;
    const runner = new CardRunner({
      card: card({ stepBudget: 2 }),
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", "card_budget"),
      stepBudget: 2,
      modelAdapter: adapter,
      gateRunner: new DeterministicGateRunner(new ProcessSandbox()),
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/big.ts"],
      onTurn: (cardId, turn) => {
        calls++;
        seen.push({ cardId, turn: turn.turnIndex, calls: turn.toolCalls.map((c) => c.name) });
        if (calls === 1) throw new Error("ledger unavailable");
      },
    });

    const result = await runner.run();
    expect(seen.length).toBe(result.turns.length);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatchObject({ cardId: "card_budget", calls: ["read_file"] });
    expect(result.stopReason).not.toBe("error");
  });
});
