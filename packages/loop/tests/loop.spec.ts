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
    expect(detector.recordAndCheck(callA)).toBe("none");
    expect(detector.recordAndCheck(callB)).toBe("none");

    // Repeated 3 identical times
    const d2 = new OscillationDetector(3);
    expect(d2.recordAndCheck(callA)).toBe("none");
    expect(d2.recordAndCheck(callA)).toBe("none");
    expect(d2.recordAndCheck(callA)).toBe("warn"); // 3rd repeat is detected
  });

  it("L13: two identical turns on an unchanged tree are a stall", async () => {
    const detector = new OscillationDetector();
    const callA = [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }];

    expect(detector.recordAndCheck(callA, "tree1")).toBe("none");
    // Detected on the second identical turn — and the Worker is told before
    // it is stopped, because a stall it has not been warned about is one it
    // never had the chance to correct.
    expect(detector.recordAndCheck(callA, "tree1")).toBe("warn");
    expect(detector.recordAndCheck(callA, "tree1")).toBe("stop");

    // The same two calls with the tree changed between them are progress.
    const moved = new OscillationDetector();
    expect(moved.recordAndCheck(callA, "tree1")).toBe("none");
    expect(moved.recordAndCheck(callA, "tree2")).toBe("none");
  });

  it("warns afresh for each stall episode, not once per card", () => {
    // card_chron_verifier, second frozen-suite run: warned about repeating
    // one call, it moved on to something else and was ended on the first
    // repeat of that — with no warning about it.
    const detector = new OscillationDetector();
    const search = [{ id: "1", name: "tool_search", arguments: { q: "read" } }];
    const read = [{ id: "2", name: "read_file", arguments: { path: "a.ts" } }];
    expect(detector.recordAndCheck(search, "t1")).toBe("none");
    expect(detector.recordAndCheck(search, "t1")).toBe("warn");
    // It did something different: the episode is over.
    expect(detector.recordAndCheck(read, "t1")).toBe("none");
    // A new repeat is a new episode, and earns its own warning.
    expect(detector.recordAndCheck(read, "t1")).toBe("warn");
    expect(detector.recordAndCheck(read, "t1")).toBe("stop");
  });

  it("L13: A-B-A is an oscillation without waiting for the fourth turn", () => {
    const detector = new OscillationDetector();
    const callA = [{ id: "1", name: "read_file", arguments: { path: "a.ts" } }];
    const callB = [{ id: "2", name: "read_file", arguments: { path: "b.ts" } }];

    expect(detector.recordAndCheck(callA, "tree1")).toBe("none");
    expect(detector.recordAndCheck(callB, "tree1")).toBe("none");
    expect(detector.recordAndCheck(callA, "tree1")).toBe("warn");

    // A-B-C is three different actions, not a cycle.
    const walking = new OscillationDetector();
    const callC = [{ id: "3", name: "read_file", arguments: { path: "c.ts" } }];
    expect(walking.recordAndCheck(callA, "tree1")).toBe("none");
    expect(walking.recordAndCheck(callB, "tree1")).toBe("none");
    expect(walking.recordAndCheck(callC, "tree1")).toBe("none");
  });

  it("L13: the session warns on the second identical turn and stops on the third", async () => {
    const mockModel = new MockInferenceAdapter("mock-llama", [
      {
        text: "stuck",
        toolCalls: [{ id: "stuck_1", name: "read_file", arguments: { path: "index.ts" } }],
        usage: { promptTokens: 50, completionTokens: 10, durationMs: 5 },
      },
    ]);
    const session = new CardExecutionSessionImpl({
      cardId: "card_stall_at_two",
      stepBudget: 10,
      worktreePath: tempWorktree,
      modelAdapter: mockModel,
      gateRunner,
    });

    expect((await session.executeTurn()).stopReason).toBeUndefined();

    // The repeat is detected here, and the Worker is told rather than killed:
    // the first frozen-suite run lost most of its cards at step two of a
    // thirty-two step budget, several having read one file twice and written
    // nothing. A failure the Worker must act on arrives with the action
    // attached, as gate failures and scope denials do.
    const warned = await session.executeTurn();
    expect(warned.stopReason).toBeUndefined();
    const warning = warned.observations.find((o) => o.tool === "stall");
    // Each call's observation stays at its call's index (review item 11): the
    // warning never shifts them, so the step records pair them right.
    for (const [i, c] of warned.toolCalls.entries()) {
      expect(warned.observations[i]?.tool).toBe(c.name);
    }
    expect(warning?.content).toMatch(/made no progress/);
    expect(warning?.content).toMatch(/finish_card/);
    expect(warning?.content).toMatch(/end the card/);

    // Repeating it after being told is a genuine stall, and still ends the card.
    expect((await session.executeTurn()).stopReason).toBe("oscillation_detected");
  });

  it("halts execution with budget_exhausted when stepBudget is exceeded", async () => {
    // Two different reads: a budget stop, not a stall (L13 trips on the second
    // *identical* turn, which would otherwise end this card first).
    const mockModel = new MockInferenceAdapter("mock-llama", [
      {
        text: "doing step",
        toolCalls: [{ id: "1", name: "read_file", arguments: { path: "index.ts" } }],
        usage: { promptTokens: 50, completionTokens: 10, durationMs: 5 },
      },
      {
        text: "doing another step",
        toolCalls: [{ id: "2", name: "list_files", arguments: { path: "." } }],
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
