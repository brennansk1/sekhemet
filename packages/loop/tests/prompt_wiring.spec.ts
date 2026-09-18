import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_INTERFACE_HEADER } from "@sekhemet/context";
import type { GateResult, GateRunner } from "@sekhemet/gates";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardExecutionSessionImpl } from "../src/session.js";

/** Records every request; replies with the scripted calls, then with `read_file`. */
function recorder(
  script: { name: string; arguments: Record<string, unknown> }[][],
  opts: { nativeTools?: boolean } = {},
) {
  const seen: InferenceRequest[] = [];
  let i = 0;
  const adapter: LocalInferenceAdapter = {
    modelId: "rec",
    supportedArms: ["arm_a_flat"],
    ...(opts.nativeTools !== undefined ? { nativeTools: opts.nativeTools } : {}),
    contextWindow: { contextTokens: 32768, maxTokens: 2048 },
    generate: async (req) => {
      seen.push(req);
      const calls = script[i++] ?? [{ name: "read_file", arguments: { path: "src/a.ts" } }];
      return {
        text: "",
        toolCalls: calls.map((c, n) => ({ id: `c${i}-${n}`, ...c })),
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  };
  return { adapter, seen };
}

const failingGate = (lines = 1): GateRunner => ({
  runGates: async (): Promise<GateResult> => ({
    passed: false,
    durationMs: 1,
    failures: Array.from({ length: lines }, (_, k) => ({
      rung: "typecheck" as const,
      gate: "typecheck",
      exitCode: 2,
      errorExcerpt: `src/a.ts:1:1 TS2304: Cannot find name 'x${k}'.`,
      suggestedFixFiles: ["src/a.ts"],
      location: { file: "src/a.ts", line: 1 },
    })),
  }),
});

describe("the session builds its prompt with buildWorkerPrompt (C4, C7, M6, C8)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "promptwire-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const session = (adapter: LocalInferenceAdapter, gateRunner: GateRunner = failingGate()) =>
    new CardExecutionSessionImpl({
      cardId: "card_w",
      stepBudget: 10,
      worktreePath: root,
      modelAdapter: adapter,
      gateRunner,
      scopeFiles: ["src/a.ts"],
    });

  it("describes the tools once: natively when the adapter sends schemas, as text otherwise", async () => {
    const native = recorder([], { nativeTools: true });
    await session(native.adapter).executeTurn();
    expect(native.seen[0]?.systemPrompt).not.toContain(TOOL_INTERFACE_HEADER);
    expect(native.seen[0]?.systemPrompt).toContain("function-calling interface");
    expect(native.seen[0]?.tools?.length).toBeGreaterThan(0);

    const text = recorder([]);
    await session(text.adapter).executeTurn();
    expect(text.seen[0]?.systemPrompt).toContain(TOOL_INTERFACE_HEADER);
  });

  it("keeps the system prompt byte-stable across turns, even when a gate fails", async () => {
    const { adapter, seen } = recorder([[{ name: "check", arguments: {} }]]);
    const s = session(adapter);
    await s.executeTurn();
    await s.executeTurn();
    await s.executeTurn();
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((r) => r.systemPrompt)).size).toBe(1);
    // The failure rides in the volatile tail, the goal last.
    const last = seen[2]?.prompt ?? "";
    expect(last).toContain("=== LAST GATE FAILURE ===");
    expect(last.lastIndexOf("=== GOAL (RE-INJECTED) ===")).toBeGreaterThan(
      last.indexOf("=== LAST GATE FAILURE ==="),
    );
    expect(s.getLastPromptReport()?.tier).toBe("nominal");
  });

  it("asks for no reasoning on ordinary steps (M6 reasoningForStep)", async () => {
    const { adapter, seen } = recorder([]);
    await session(adapter).executeTurn();
    expect(seen[0]?.reasoning).toBe("off");
    expect(seen[0]?.reasoningBudgetTokens).toBe(0);
  });

  it("turns reasoning on once the ladder reaches fresh_context", async () => {
    // Two failed finish_card verifications climb past direct repair.
    const finish = [{ name: "finish_card", arguments: {} }];
    const { adapter, seen } = recorder([finish, finish, finish, finish]);
    const s = session(adapter);
    for (let t = 0; t < 4; t++) await s.executeTurn();
    const levels = seen.map((r) => r.reasoning);
    expect(levels[0]).toBe("off");
    expect(levels.some((l) => l !== "off")).toBe(true);
    const on = seen.find((r) => r.reasoning !== "off");
    expect(on?.reasoningBudgetTokens).toBeGreaterThan(0);
  });

  it("condenses long check output with a recall footer", async () => {
    const { adapter } = recorder([[{ name: "check", arguments: {} }]]);
    const s = session(adapter, failingGate(200));
    const turn = await s.executeTurn();
    const content = turn.observations[0]?.content ?? "";
    expect(content).toContain("Gates failing");
    expect(content).toMatch(/recall\(ref="[^"]+"\)/);
  });
});
