import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlaybookRegistry } from "@sekhemet/context";
import {
  type GateFailure,
  type GateResult,
  type GateRunner,
  missingFailureFields,
} from "@sekhemet/gates";
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
              location: { file: "src/a.ts" },
              expected: "the gate to pass",
              actual: "it failed",
              minimalRepro: "pnpm test",
              suggestedAction: "Fix the failure shown.",
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

describe("the cap is applied once, after every gate (F14, gates rule 20)", () => {
  const lint = (n: number): GateFailure => ({
    rung: "lint",
    gate: "lint",
    layer: "static",
    exitCode: 1,
    errorExcerpt: `src/a.ts:${n}:1 lint/style/useTemplate`,
    suggestedFixFiles: ["src/a.ts"],
    location: { file: "src/a.ts", line: n },
    expected: "no lint/style/useTemplate violations",
    actual: "use a template literal",
    minimalRepro: "pnpm lint",
    suggestedAction: "Replace string concatenation with a template literal.",
  });
  const threeLint: GateRunner = {
    runGates: async () => ({
      passed: false,
      failures: [lint(1), lint(2), lint(3)],
      durationMs: 1,
      rungResults: [],
    }),
  };
  const card = {
    id: "c",
    tier: "task" as const,
    title: "t",
    status: "in_progress" as const,
    scopeFiles: [],
    stepBudget: 5,
    stepsUsed: 0,
    createdAt: "",
    updatedAt: "",
  };

  it("ranks a bounds failure with the declared gates' failures and still shows three", async () => {
    for (const n of [1, 2, 3, 4])
      writeFileSync(join(root, "src", `f${n}.ts`), `export const f${n} = 1;\n`);
    const result = await new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter([[]]),
      gateRunner: threeLint,
      bounds: { maxFiles: 3, maxLines: 200 },
      card,
    }).runVerification();
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures.map((f) => f.gate)).toEqual(["bounds", "lint", "lint"]);
    for (const f of result.failures) expect(missingFailureFields(f)).toEqual([]);
  });

  it("gives a pre-gate hook's stop all six fields", async () => {
    const result = await new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter([[]]),
      gateRunner: passing,
      hooks: {
        emit: async () => ({ blocked: true, reason: "the policy hook refused", messages: [] }),
      } as never,
      card,
    }).runVerification();
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.errorExcerpt).toContain("the policy hook refused");
    expect(result.failures[0]?.notRun).toBe(true);
    expect(missingFailureFields(result.failures[0] ?? ({} as never))).toEqual([]);
  });

  it("reports integrity, bounds and the diff-based built-in layers as not run when git cannot diff", async () => {
    // A worktree whose base does not exist: git cannot produce the diff.
    const result = await new CardExecutionSessionImpl({
      cardId: "c",
      stepBudget: 5,
      worktreePath: root,
      modelAdapter: adapter([[]]),
      gateRunner: passing,
      baseBranch: "no-such-branch",
      bounds: { maxFiles: 3, maxLines: 200 },
      builtinGates: {
        protected: [],
        maxFiles: 3,
        maxDiffLines: 200,
        builtin: ["secrets"],
      },
      card,
    }).runVerification();
    expect(result.passed).toBe(false);
    const notRun = result.failures.filter((f) => f.notRun).map((f) => f.gate);
    expect(notRun.sort()).toEqual(["bounds", "integrity", "secrets"]);
    expect(result.failures.every((f) => f.notRun)).toBe(true);
  });
});
