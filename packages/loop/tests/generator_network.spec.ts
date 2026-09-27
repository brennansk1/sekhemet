import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateRunner } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardRunner } from "../src/card_runner.js";

// design-stage DS-P2-1, -2: a person's Create project approved card zero's
// generator, so its declared steps — and only they, on that card only — reach
// the ecosystem's package registry, through a proxy of their own. Every other
// command stays offline. Nothing is fetched: the steps only report the proxy
// they were given. A real git repository and worktree.

const passing: GateRunner = {
  runGates: async () => ({ passed: true, failures: [], durationMs: 1, rungResults: [] }),
};
const SAY_PROXY = ["-e", 'console.log("proxy=" + (process.env.HTTPS_PROXY ?? "none"))'];
const OTHER = ["-e", 'console.log("other=" + (process.env.HTTPS_PROXY ?? "none"))'];

describe("card zero's generator network (DS-P2-1, -2)", () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" });
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "gen-net-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "T");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 0;\n");
    writeFileSync(join(repo, ".gitignore"), ".sekhemet/\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("gives a declared step the generator's proxy and leaves any other command offline", async () => {
    const outputs: string[] = [];
    let turn = 0;
    const adapter: LocalInferenceAdapter = {
      modelId: "m",
      supportedArms: ["arm_a_flat", "arm_b_json"],
      generate: async (req) => {
        outputs.push(JSON.stringify(req));
        turn++;
        return {
          text: "",
          toolCalls:
            turn === 1
              ? [
                  { id: "1", name: "run_cmd", arguments: { command: "node", args: SAY_PROXY } },
                  { id: "2", name: "run_cmd", arguments: { command: "node", args: OTHER } },
                ]
              : [{ id: "3", name: "finish_card", arguments: {} }],
          usage: { promptTokens: 5, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const card: CardRecord = {
      id: "card_zero_net",
      tier: "task",
      title: "Card zero",
      status: "in_progress",
      scopeFiles: ["src/a.ts"],
      stepBudget: 4,
      stepsUsed: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    await new CardRunner({
      card,
      repoRoot: repo,
      worktreePath: join(repo, ".sekhemet", "worktrees", card.id),
      stepBudget: 4,
      modelAdapter: adapter,
      gateRunner: passing,
      syncAdapter: new NodeGitSyncAdapter(repo),
      scopeFiles: ["src/a.ts"],
      declaredSteps: {
        tool: "generator",
        steps: [{ command: "node", args: SAY_PROXY }],
        registry: "npm",
      },
    }).run();
    const seen = outputs.join("\n");
    expect(seen).toMatch(/proxy=http:\/\/127\.0\.0\.1:\d+/);
    expect(seen).toContain("other=none");
  });
});
