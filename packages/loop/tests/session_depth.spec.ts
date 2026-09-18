import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybookRegistry } from "@sekhemet/context";
import type { GateResult, GateRunner } from "@sekhemet/gates";
import type { LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";

let root: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
const passing: GateRunner = {
  runGates: async (): Promise<GateResult> => ({
    passed: true,
    failures: [],
    durationMs: 1,
    rungResults: [],
  }),
};
const adapter = (calls: ToolCall[][]): LocalInferenceAdapter => {
  let i = 0;
  return {
    modelId: "m",
    supportedArms: ["arm_a_flat"],
    generate: async () => ({
      text: "",
      toolCalls: calls[Math.min(i++, calls.length - 1)] ?? [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
  };
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-depth-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 0;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("bounds gate at every verification (G10)", () => {
  const session = (acceptanceTests: string[] = []) =>
    new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter([[]]),
      gateRunner: passing,
      bounds: { maxFiles: 3, maxLines: 200 },
      card: {
        id: "c",
        tier: "task",
        title: "t",
        status: "in_progress",
        scopeFiles: [],
        stepBudget: 5,
        stepsUsed: 0,
        createdAt: "",
        updatedAt: "",
        acceptanceTests,
      },
    });

  it("fails a change that touches more files than the card may", async () => {
    for (const n of [1, 2, 3, 4])
      writeFileSync(join(root, "src", `f${n}.ts`), `export const f${n} = 1;\n`);
    const result = await session().runVerification();
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatchObject({
      gate: "bounds",
      layer: "hygiene",
      actual: "4 files changed",
      suggestedFixFiles: ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts"],
    });
    expect(result.rungResults?.at(-1)).toMatchObject({ gate: "bounds", passed: false });
  });

  it("fails a change over the line budget, counting removals", async () => {
    writeFileSync(join(root, "src", "a.ts"), `${"export const x = 1;\n".repeat(200)}`);
    const result = await session().runVerification();
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.actual).toBe("201 diff lines");
  });

  it("passes a change within bounds, and does not count staged acceptance tests", async () => {
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests", "big.spec.ts"), "test('x', () => {});\n".repeat(500));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    const result = await session(["big.spec.ts"]).runVerification();
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe("failure text reaches playbook matching (integration review item 3)", () => {
  it("passes the standing failure's text to matchRules once a check has failed", async () => {
    const seen: Record<string, unknown>[] = [];
    const registry = {
      matchRules: (opts: Record<string, unknown>) => {
        seen.push(opts);
        return [];
      },
      getAllRules: () => [],
    } as unknown as PlaybookRegistry;
    let calls = 0;
    const failing: GateRunner = {
      runGates: async () => {
        calls++;
        return {
          passed: false,
          durationMs: 1,
          failures: [
            {
              rung: "typecheck",
              gate: "typecheck",
              exitCode: 2,
              errorExcerpt: "src/a.ts:1:1 TS2375: exactOptionalPropertyTypes",
              suggestedFixFiles: ["src/a.ts"],
            },
          ],
        };
      },
    };
    const s = new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      gateRunner: failing,
      playbookRegistry: registry,
      modelAdapter: adapter([
        [{ id: "1", name: "check", arguments: {} }],
        [{ id: "2", name: "list_dir", arguments: {} }],
      ]),
    });
    await s.executeTurn();
    await s.executeTurn();
    expect(calls).toBe(1);
    expect(seen[0]?.failureText).toBeUndefined();
    const last = seen.at(-1);
    expect(last?.failureText).toBe("src/a.ts:1:1 TS2375: exactOptionalPropertyTypes");
    expect(last?.triggerGate).toBe("typecheck");
  });
});
