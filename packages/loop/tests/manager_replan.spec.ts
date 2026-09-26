import { estimatePromptTokens } from "@sekhemet/context";
import type { CardRecord } from "@sekhemet/kernel";
import {
  type InferenceRequest,
  type LocalInferenceAdapter,
  reasoningForStep,
} from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { planRepair } from "../src/manager.js";

/** CX-N3-8: the re-plan prompt fits the Planner's window by the allocator, the spec intact. */
describe("CX-N3-8: the re-plan prompt is fitted by the allocator", () => {
  const card: CardRecord = {
    id: "card_rp",
    tier: "task",
    title: "Ledger",
    spec: `Store ledger rows in node:sqlite. ${"Keep the order of rows stable. ".repeat(20)}`,
    status: "in_progress",
    scopeFiles: ["src/ledger.ts"],
    acceptanceCriteria: ["rows come back in insertion order"],
    stepBudget: 40,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
  };
  const manager = (contextTokens: number) => {
    const seen: InferenceRequest[] = [];
    const adapter: LocalInferenceAdapter = {
      modelId: "planner",
      supportedArms: ["arm_b_json"],
      contextWindow: { contextTokens, maxTokens: 1800 },
      generate: async (req) => {
        seen.push(req);
        return {
          text: "PLAN",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    return { adapter, seen };
  };
  const big = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n");

  it("fits an 8,192-token window with files far over 8,000 characters, the spec at the start intact", async () => {
    const { adapter, seen } = manager(8192);
    await planRepair(adapter, {
      card,
      stopReason: "repair_exhausted",
      failures: [],
      files: [
        { path: "tests/ledger.test.ts", content: big("t", 2000) },
        { path: "src/ledger.ts", content: big("s", 2000) },
      ],
    });
    const req = seen[0] as InferenceRequest;
    const thinking = reasoningForStep({ purpose: "planning" }).reasoningBudgetTokens;
    const sent = estimatePromptTokens(req.systemPrompt ?? "") + estimatePromptTokens(req.prompt);
    expect(sent).toBeLessThanOrEqual(8192 - 1800 - thinking);
    expect(req.prompt.startsWith(`CARD card_rp: ${card.spec}`)).toBe(true);
    expect(req.prompt).toContain("--- tests/ledger.test.ts ---");
    expect(req.prompt).toContain("--- src/ledger.ts ---");
    expect(req.prompt.trimEnd().endsWith("Write the repair plan now.")).toBe(true);
  });

  it("sends a file longer than 8,000 characters whole when the window has room", async () => {
    const { adapter, seen } = manager(65_536);
    const content = big("w", 600);
    expect(content.length).toBeGreaterThan(8000);
    await planRepair(adapter, {
      card,
      stopReason: "repair_exhausted",
      failures: [],
      files: [{ path: "src/ledger.ts", content }],
    });
    expect(seen[0]?.prompt).toContain(content);
  });
});
