import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { InMemoryEvidenceStore } from "../src/evidence.js";
import type { ToolInterfaceSpec } from "../src/tool_interface.js";
import {
  CONTEXT_VERSION_INPUTS,
  budgetPolicyText,
  computeContextVersion,
  guidanceList,
} from "../src/versioning.js";
import { type WorkerPromptInput, buildWorkerPrompt } from "../src/worker_prompt.js";

/**
 * CX-N6-3: the context version covers the harness's own assets only; the
 * project's guidance — rules, skills, exemplars, conventions files — is
 * listed on the pack beside it and never changes it (context rule 27).
 */
const card: CardRecord = {
  id: "card_v",
  tier: "task",
  title: "Ledger store",
  status: "in_progress",
  scopeFiles: ["src/ledger.ts"],
  stepBudget: 40,
  stepsUsed: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
};
const tools: ToolInterfaceSpec[] = [
  { name: "finish_card", summary: "Submit the card for verification.", parameters: [] },
];
const input = (over: Partial<WorkerPromptInput> = {}): WorkerPromptInput => ({
  card,
  tools,
  evidenceStore: new InMemoryEvidenceStore(),
  goal: "Store rows.",
  ...over,
});

describe("CX-N6-3: guidance is listed, never versioned", () => {
  it("a rule, a skill, an exemplar or a conventions file leaves the context version unchanged and is listed with its hash", () => {
    const bare = buildWorkerPrompt(input());
    const guided = buildWorkerPrompt(
      input({
        rules: [{ id: "rule_a", pattern: "Ledger", instruction: "Use node:sqlite." }],
        skills: [
          { name: "sqlite", description: "SQLite patterns", triggers: ["ledger"], content: "WAL." },
        ],
        exemplars: [
          {
            cardId: "card_x",
            cardClass: "implement:ts",
            title: "Add rows",
            trajectory: ["write src/a.ts -> ok"],
            steps: 1,
            tokens: 10,
            date: "2026-09-01",
          },
        ],
        conventions: "Named exports only.",
      }),
    );
    expect(guided.pack.version).toBe(bare.pack.version);
    expect(bare.pack.guidance).toEqual([]);
    expect(guided.pack.guidance.map((g) => [g.kind, g.id])).toEqual([
      ["rule", "rule_a"],
      ["skill", "sqlite"],
      ["exemplar", "card_x"],
      ["conventions", "conventions"],
    ]);
    for (const g of guided.pack.guidance) expect(g.hash).toMatch(/^[0-9a-f]{16}$/);
    // A changed rule is a new list item hash, not a new version.
    const edited = buildWorkerPrompt(
      input({ rules: [{ id: "rule_a", pattern: "Ledger", instruction: "Use WAL mode." }] }),
    );
    expect(edited.pack.version).toBe(bare.pack.version);
    expect(edited.pack.guidance[0]?.hash).not.toBe(guided.pack.guidance[0]?.hash);
  });

  it("computeContextVersion takes no guidance: its inputs are the harness's, and it reads nothing else", () => {
    expect([...CONTEXT_VERSION_INPUTS].sort()).toEqual(["templates", "tools"]);
    const plain = computeContextVersion({ tools });
    expect(
      computeContextVersion({
        tools,
        rules: [{ id: "r", pattern: "x", instruction: "y" }],
      } as never).version,
    ).toBe(plain.version);
    expect(computeContextVersion({ tools, templates: ["harness template"] }).version).not.toBe(
      plain.version,
    );
    expect(guidanceList({ conventions: "" })).toEqual([]);
  });

  it("the budget policies are part of the version: zone caps, the estimator's ratio and the Worker's priorities", () => {
    const policy = budgetPolicyText();
    expect(policy).toContain("chars per token 3.2");
    expect(policy).toMatch(/zone budgets .*system/);
    expect(policy).toMatch(/worker priorities .*tests/);
  });
});
