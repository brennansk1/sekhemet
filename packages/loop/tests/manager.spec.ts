import type { CardRecord } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { planRepair } from "../src/manager.js";

function recordingManager(reply: string): {
  adapter: LocalInferenceAdapter;
  seen: InferenceRequest[];
} {
  const seen: InferenceRequest[] = [];
  return {
    seen,
    adapter: {
      modelId: "manager-mock",
      supportedArms: ["arm_b_json"],
      generate: async (req) => {
        seen.push(req);
        return {
          text: `  ${reply}  `,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    },
  };
}

const now = new Date().toISOString();
const card: CardRecord = {
  id: "card_db",
  tier: "story",
  title: "Init db",
  status: "verify",
  scopeFiles: ["src/db.ts"],
  stepBudget: 32,
  stepsUsed: 32,
  createdAt: now,
  updatedAt: now,
  spec: "Implement openDatabase(path) using node:sqlite.",
  acceptanceCriteria: ["WAL mode", "UNIQUE id"],
};

describe("@sekhemet/loop manager repair planning", () => {
  it("gives the manager the spec, criteria, typed failures and the worker's files", async () => {
    const { adapter, seen } = recordingManager("1. Rewrite the whole file.");
    const plan = await planRepair(adapter, {
      card,
      stopReason: "budget_exhausted",
      failures: [
        {
          rung: "typecheck",
          gate: "typecheck",
          exitCode: 2,
          errorExcerpt: "src/db.ts:9:1 TS1128: Declaration or statement expected.",
          suggestedFixFiles: ["src/db.ts"],
          minimalRepro: "pnpm typecheck",
        },
      ],
      files: [{ path: "src/db.ts", content: "export function openDatabase() {\n  }\n}\n" }],
    });

    expect(plan).toBe("1. Rewrite the whole file.");
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("Implement openDatabase(path) using node:sqlite.");
    expect(prompt).toContain("1. WAL mode");
    expect(prompt).toContain("TS1128");
    expect(prompt).toContain("reproduce: pnpm typecheck");
    expect(prompt).toContain("--- src/db.ts ---");
    expect(prompt).toContain("budget_exhausted");
    // The manager plans; it must be told it may not change tests.
    expect(seen[0]?.systemPrompt).toContain("Never change a test");
  });

  it("says so when no gate ran rather than presenting an empty failure list", async () => {
    const { adapter, seen } = recordingManager("plan");
    await planRepair(adapter, { card, stopReason: "no_progress", failures: [], files: [] });
    expect(seen[0]?.prompt).toContain("no gate ran");
  });

  it("forwards at most three failures, the cap a repair attempt can use", async () => {
    const { adapter, seen } = recordingManager("plan");
    const failure = (n: number) => ({
      rung: "test" as const,
      exitCode: 1,
      errorExcerpt: `failure number ${n}`,
      suggestedFixFiles: [],
    });
    await planRepair(adapter, {
      card,
      stopReason: "repair_exhausted",
      failures: [1, 2, 3, 4, 5].map(failure),
      files: [],
    });
    expect(seen[0]?.prompt).toContain("failure number 3");
    expect(seen[0]?.prompt).not.toContain("failure number 4");
  });
});
