import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BenchmarkHarness } from "../src/benchmark.js";
import type { SyntheticTask } from "../src/types.js";

/**
 * These run against a real git repository and real subprocesses.
 *
 * The defect this suite replaced scored Pass@1 from "the model emitted a tool
 * call", so every model scored 1.0. A benchmark that cannot report failure is
 * worse than no benchmark, so the central case here is that a model which
 * changes nothing scores zero.
 */
describe("@sekhemet/eval BenchmarkHarness", () => {
  let repo: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "sekhemet-eval-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "eval@sekhemet.local");
    git("config", "user.name", "Eval");

    // add() is wrong on purpose; test.js is the oracle.
    writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a - b;\n");
    writeFileSync(
      join(repo, "test.js"),
      "const add = require('./add');\nif (add(2, 3) !== 5) { console.error('FAIL add'); process.exit(1); }\nconsole.log('ok');\n",
    );
    writeFileSync(
      join(repo, "smoke.js"),
      "if (1 + 1 !== 2) { process.exit(1); }\nconsole.log('smoke ok');\n",
    );
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const task = (): SyntheticTask => ({
    id: "task_add",
    repoPath: repo,
    repoCommit: "HEAD",
    issueDescription: "add() subtracts instead of adding. Fix add.js.",
    failToPassTests: ["node test.js"],
    passToPassTests: ["node smoke.js"],
    scopeFiles: ["add.js"],
  });

  const respond = (toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[]) =>
    new MockInferenceAdapter("mock-eval", [
      { text: "", toolCalls, usage: { promptTokens: 120, completionTokens: 40, durationMs: 1 } },
    ]);

  it("scores 0 when the agent changes nothing but claims completion", async () => {
    // This is exactly what the previous implementation scored as 1.0.
    const model = respond([
      { id: "1", name: "note", arguments: { message: "looks fine to me" } },
      { id: "2", name: "finish_card", arguments: {} },
    ]);

    const result = await new BenchmarkHarness().runBenchmark([task()], model, {
      passAtK: 1,
      stepBudget: 3,
    });

    expect(result.passAt1).toBe(0);
    expect(result.tasks[0]?.passed).toBe(false);
    expect(result.taskCount).toBe(1);
  });

  it("scores 1 only when the fail-to-pass test genuinely flips", async () => {
    const model = respond([
      {
        id: "1",
        name: "write_file",
        arguments: { path: "add.js", content: "module.exports = (a, b) => a + b;\n" },
      },
      { id: "2", name: "finish_card", arguments: {} },
    ]);

    const result = await new BenchmarkHarness().runBenchmark([task()], model, {
      passAtK: 1,
      stepBudget: 3,
    });

    expect(result.passAt1).toBe(1);
    expect(result.tasks[0]?.passedFirstAttempt).toBe(true);
  });

  it("fails a change that fixes the target test but regresses another", async () => {
    // add.js is in scope, and this "fix" breaks the pass-to-pass oracle by
    // throwing at require time. Passing the target test is not sufficient.
    const model = respond([
      {
        id: "1",
        name: "write_file",
        arguments: {
          path: "add.js",
          content: "module.exports = (a, b) => a + b;\nprocess.exit(1);\n",
        },
      },
      { id: "2", name: "finish_card", arguments: {} },
    ]);

    const result = await new BenchmarkHarness().runBenchmark([task()], model, {
      passAtK: 1,
      stepBudget: 3,
    });

    expect(result.passAt1).toBe(0);
  });

  it("runs the attempt through the product's card execution when given one, and counts its valid tool calls (MS-M9-1)", async () => {
    // A model with no replies: the in-process session must not be used.
    const model = new MockInferenceAdapter("mock-eval", []);
    const seen: { workspacePath: string; stepBudget: number }[] = [];
    const result = await new BenchmarkHarness().runBenchmark([task()], model, {
      passAtK: 1,
      stepBudget: 7,
      runCard: async ({ workspacePath, stepBudget }) => {
        seen.push({ workspacePath, stepBudget });
        writeFileSync(join(workspacePath, "add.js"), "module.exports = (a, b) => a + b;\n");
        return {
          stopReason: "gates_passed",
          turnsUsed: 3,
          promptTokens: 300,
          completionTokens: 30,
          steps: [
            { formatErrors: 0, proseOnly: 0 },
            { formatErrors: 1, proseOnly: 0 },
            { formatErrors: 0, proseOnly: 1 },
          ],
        };
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.stepBudget).toBe(7);
    expect(result.passAt1).toBe(1);
    const attempt = result.tasks[0]?.attempts[0];
    expect(attempt?.toolCallSteps).toEqual({ steps: 3, valid: 1 });
    expect(attempt?.totalTokens).toBe(330);
    expect(attempt?.inferenceCalls).toBe(0);
  });

  it("records the settings a number was produced under", async () => {
    const model = respond([{ id: "1", name: "finish_card", arguments: {} }]);
    const result = await new BenchmarkHarness().runBenchmark([task()], model, {
      passAtK: 1,
      stepBudget: 2,
    });

    // A number without its settings is not admissible, so this field is required.
    expect(result.settings).toBeTruthy();
    expect(result.settings.modelId).toBe("mock-eval");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.attempts.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects a pass@k sampling plan outside the specified ranges", async () => {
    const model = respond([{ id: "1", name: "finish_card", arguments: {} }]);

    // k must be 1 or within [2,4]; temperature within [0.4,0.7] when k > 1.
    await expect(
      new BenchmarkHarness().runBenchmark([task()], model, { passAtK: 9, stepBudget: 2 }),
    ).rejects.toThrow(RangeError);
    await expect(
      new BenchmarkHarness().runBenchmark([task()], model, {
        passAtK: 2,
        stepBudget: 2,
        temperature: 0.1,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("does not leak git worktrees between attempts", async () => {
    const model = respond([{ id: "1", name: "finish_card", arguments: {} }]);
    await new BenchmarkHarness().runBenchmark([task()], model, { passAtK: 1, stepBudget: 2 });

    const worktrees = git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    // Only the original checkout should remain registered.
    expect(worktrees).toHaveLength(1);
  });
});
