import { MockInferenceAdapter, type ToolDefinition } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { plannerToolsWithinBudget, sketchWithModel } from "../src/index.js";
import type { PlannedStory } from "../src/types.js";

/**
 * EXT-20 (extensibility item 23): when an approved MCP server offers tools,
 * the Planner is offered them while it plans a card, each tool's description
 * counted against the prompt budget.
 */
const story = {
  card: {
    id: "card_t",
    tier: "story",
    title: "Round money to cents",
    status: "ready",
    scopeFiles: ["src/money.ts"],
    stepBudget: 20,
    stepsUsed: 0,
    createdAt: "",
    updatedAt: "",
  },
  slice: "path",
  rationale: "Money must round.",
  keywords: ["money"],
  acceptanceTests: [{ filePath: "t.spec.ts", assertion: "rounds", initiallyFailing: true }],
  advances: [],
  difficulty: { value: 5, factors: [] },
  routing: "edit_sketch",
  dependsOn: [],
  estimatedPackTokens: 2000,
  splitDepth: 0,
} as unknown as PlannedStory;

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };
const tool = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  parameters: { type: "object", properties: { q: { type: "string" } } },
});
const SKETCH =
  '{"targetSymbols":[{"filePath":"src/money.ts","symbol":"money","change":"add"}],"diffSketch":"Round with Math.round."}';

describe("EXT-20: the Planner is offered an approved MCP server's tools", () => {
  it("offers the tools, runs a call and plans from its result", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const model = new MockInferenceAdapter("planner", [
      {
        text: "",
        toolCalls: [{ id: "c1", name: "mcp__docs__lookup", arguments: { q: "round" } }],
        usage,
      },
      { text: SKETCH, toolCalls: [], usage },
    ]);
    const r = await sketchWithModel(model, story, {
      tools: {
        definitions: [tool("mcp__docs__lookup", "[docs] Look up a library's documentation")],
        call: async (name, args) => {
          calls.push({ name, args });
          return "Math.round rounds half up";
        },
      },
    });
    expect(model.callHistory[0]?.tools?.map((t) => t.name)).toEqual(["mcp__docs__lookup"]);
    expect(calls).toEqual([{ name: "mcp__docs__lookup", args: { q: "round" } }]);
    const second = model.callHistory[1];
    expect(second?.messages?.find((m) => m.role === "tool")?.content).toBe(
      "Math.round rounds half up",
    );
    expect(r.source).toBe("model");
    expect(r.sketch.diffSketch).toBe("Round with Math.round.");
  });

  it("offers only the tools whose descriptions fit the budget, in order", () => {
    const small = tool("mcp__a__small", "short");
    const big = tool("mcp__b__big", "x".repeat(4000));
    const also = tool("mcp__c__also", "short too");
    const kept = plannerToolsWithinBudget([small, big, also], 200);
    expect(kept.map((t) => t.name)).toEqual(["mcp__a__small", "mcp__c__also"]);
    expect(plannerToolsWithinBudget([small], 1)).toEqual([]);
  });

  it("with no tools the request is unchanged: no tools, one call", async () => {
    const model = new MockInferenceAdapter("planner", [{ text: SKETCH, toolCalls: [], usage }]);
    await sketchWithModel(model, story);
    expect(model.callHistory).toHaveLength(1);
    expect(model.callHistory[0]?.tools).toBeUndefined();
    expect(model.callHistory[0]?.messages).toBeUndefined();
  });
});
