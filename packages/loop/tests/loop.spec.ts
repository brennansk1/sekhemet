import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicGateRunner } from "@sekhemet/gates";
import { MockInferenceAdapter } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OscillationDetector } from "../src/detector.js";
import { CardExecutionSessionImpl } from "../src/session.js";

describe("@sekhemet/loop", () => {
  let tempWorktree: string;
  const sandbox = new ProcessSandbox();
  const gateRunner = new DeterministicGateRunner(sandbox);

  beforeEach(() => {
    tempWorktree = mkdtempSync(join(tmpdir(), "sekhemet-loop-test-"));
    writeFileSync(join(tempWorktree, "index.ts"), "export const x = 1;\n");
  });

  afterEach(() => {
    try {
      rmSync(tempWorktree, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("executes a turn and writes files via tool calls", async () => {
    const mockModel = new MockInferenceAdapter("mock-llama", [
      {
        text: "I will update index.ts",
        toolCalls: [
          {
            id: "tc_1",
            name: "write_file",
            arguments: {
              path: "index.ts",
              content: "export const x = 42;\n",
            },
          },
        ],
        usage: { promptTokens: 100, completionTokens: 20, durationMs: 15 },
      },
    ]);

    const session = new CardExecutionSessionImpl({
      cardId: "card_turn1",
      stepBudget: 10,
      worktreePath: tempWorktree,
      // Pinned in the prompt, so the agent has seen it (read-before-edit, L17).
      scopeFiles: ["index.ts"],
      modelAdapter: mockModel,
      gateRunner,
    });

    const turn = await session.executeTurn();
    expect(turn.turnIndex).toBe(1);
    expect(turn.toolCalls.length).toBe(1);
    expect(session.getStepsUsed()).toBe(1);

    // Verify file was written to disk
    const content = await session.readFile("index.ts");
    expect(content).toBe("export const x = 42;\n");
  });

  it("detects oscillation when identical tool calls are repeated 3 times", () => {
    const detector = new OscillationDetector(3);

    const callA = [{ id: "1", name: "write_file", arguments: { path: "a.ts", content: "1" } }];
    const callB = [{ id: "2", name: "write_file", arguments: { path: "a.ts", content: "2" } }];

    // Non-oscillating
    expect(detector.recordAndCheck(callA)).toBe(false);
    expect(detector.recordAndCheck(callB)).toBe(false);

    // Repeated 3 identical times
    const d2 = new OscillationDetector(3);
    expect(d2.recordAndCheck(callA)).toBe(false);
    expect(d2.recordAndCheck(callA)).toBe(false);
    expect(d2.recordAndCheck(callA)).toBe(true); // 3rd repeat triggers detector!
  });

  it("halts execution with budget_exhausted when stepBudget is exceeded", async () => {
    const mockModel = new MockInferenceAdapter("mock-llama", [
      {
        text: "doing step",
        toolCalls: [{ id: "1", name: "read_file", arguments: { path: "index.ts" } }],
        usage: { promptTokens: 50, completionTokens: 10, durationMs: 5 },
      },
    ]);

    const session = new CardExecutionSessionImpl({
      cardId: "card_budget",
      stepBudget: 2,
      worktreePath: tempWorktree,
      modelAdapter: mockModel,
      gateRunner,
    });

    const turn1 = await session.executeTurn();
    expect(turn1.stopReason).toBeUndefined();

    const turn2 = await session.executeTurn();
    expect(turn2.stopReason).toBe("budget_exhausted");
  });

  it("stops session with oscillation_detected if model repeats the same action 3 times", async () => {
    const repeatedCall = [
      {
        text: "stuck",
        toolCalls: [{ id: "stuck_1", name: "read_file", arguments: { path: "index.ts" } }],
        usage: { promptTokens: 50, completionTokens: 10, durationMs: 5 },
      },
    ];
    const mockModel = new MockInferenceAdapter("mock-llama", repeatedCall);

    const session = new CardExecutionSessionImpl({
      cardId: "card_stuck",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: mockModel,
      gateRunner,
    });

    await session.executeTurn();
    await session.executeTurn();
    const turn3 = await session.executeTurn();

    expect(turn3.stopReason).toBe("oscillation_detected");
  });
});
