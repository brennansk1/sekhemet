import { MockInferenceAdapter, type ToolDefinition } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { sketchWithModel } from "../src/index.js";
import type { PlannedStory } from "../src/types.js";

/**
 * WL-N8-1 (worker-loop rule 11a): more than ten tools reach the Planner as a
 * one-line index; a schema is loaded by tool_search and appended as a message.
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

describe("WL-N8-1: the Planner offered more than ten tools sees an index", () => {
  it("loads a schema by tool_search as a message; the tools array and earlier messages stay byte-identical", async () => {
    const defs = Array.from({ length: 12 }, (_, i) =>
      tool(`mcp__docs__t${i}`, `[docs] Tool ${i}. Looks up topic ${i}.`),
    );
    const calls: string[] = [];
    const model = new MockInferenceAdapter("planner", [
      {
        text: "",
        toolCalls: [{ id: "s1", name: "tool_search", arguments: { query: "mcp__docs__t5" } }],
        usage,
      },
      {
        text: "",
        toolCalls: [{ id: "c1", name: "mcp__docs__t5", arguments: { q: "round" } }],
        usage,
      },
      { text: SKETCH, toolCalls: [], usage },
    ]);
    const r = await sketchWithModel(model, story, {
      tools: {
        definitions: defs,
        call: async (name) => {
          calls.push(name);
          return "Math.round rounds half up";
        },
      },
    });
    const history = model.callHistory;
    expect(history).toHaveLength(3);
    // One tool in the array, the same bytes on every request.
    const arrays = history.map((h) => JSON.stringify(h.tools));
    expect(history[0]?.tools?.map((t) => t.name)).toEqual(["tool_search"]);
    expect(new Set(arrays).size).toBe(1);
    // The index is in the first message; no schema is.
    const first = history[0]?.messages?.[0]?.content ?? "";
    expect(first).toContain("TOOLS (12)");
    expect(first).toContain("- mcp__docs__t5: [docs] Tool 5.");
    expect(first).not.toContain('"properties"');
    // Every request extends the one before it, byte for byte.
    for (let i = 1; i < history.length; i++) {
      const before = JSON.stringify(history[i - 1]?.messages);
      const now = JSON.stringify(history[i]?.messages?.slice(0, history[i - 1]?.messages?.length));
      expect(now).toBe(before);
    }
    // The loaded schema arrived as a tool message, and the loaded tool ran.
    expect(history[1]?.messages?.at(-1)?.content).toContain('"name":"mcp__docs__t5"');
    expect(calls).toEqual(["mcp__docs__t5"]);
    expect(r.source).toBe("model");
  });

  it("refuses a call to a tool it has not loaded", async () => {
    const defs = Array.from({ length: 11 }, (_, i) => tool(`mcp__docs__t${i}`, `Tool ${i}.`));
    const calls: string[] = [];
    const model = new MockInferenceAdapter("planner", [
      { text: "", toolCalls: [{ id: "c1", name: "mcp__docs__t1", arguments: {} }], usage },
      { text: SKETCH, toolCalls: [], usage },
    ]);
    await sketchWithModel(model, story, {
      tools: {
        definitions: defs,
        call: async (n) => {
          calls.push(n);
          return "x";
        },
      },
    });
    expect(calls).toEqual([]);
    expect(model.callHistory[1]?.messages?.at(-1)?.content).toMatch(/load it with tool_search/);
  });
});
