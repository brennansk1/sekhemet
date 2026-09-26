import { describe, expect, it } from "vitest";
import {
  TOOL_INDEX_THRESHOLD,
  TOOL_SEARCH_TOOL,
  type ToolDefinition,
  ToolIndex,
} from "../src/index.js";

const tool = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  parameters: { type: "object", properties: { q: { type: "string" } } },
});
const many = Array.from({ length: 14 }, (_, i) =>
  tool(`mcp__docs__t${i}`, `Tool number ${i}. It does thing ${i} and more.`),
);

describe("WL-N8-1: many tools without their prefill cost", () => {
  it("offers ten tools or fewer as they are", () => {
    const few = many.slice(0, TOOL_INDEX_THRESHOLD);
    const index = new ToolIndex(few);
    expect(index.indexed).toBe(false);
    expect(index.tools).toEqual(few);
    expect(index.indexText()).toBe("");
  });

  it("sends a one-line index and tool_search; a loaded schema is a message, the tools array never changes", () => {
    const index = new ToolIndex(many);
    expect(index.indexed).toBe(true);
    const toolsBefore = JSON.stringify(index.tools);
    expect(index.tools).toEqual([TOOL_SEARCH_TOOL]);
    const lines = index.indexText().split("\n");
    expect(lines[0]).toMatch(/TOOLS \(14\)/);
    expect(lines).toContain("- mcp__docs__t3: Tool number 3.");
    expect(index.indexText()).not.toContain('"properties"');
    expect(index.callable("mcp__docs__t3")).toBe(false);

    const loaded = index.search("mcp__docs__t3 mcp__docs__t4");
    expect(loaded.names).toEqual(["mcp__docs__t3", "mcp__docs__t4"]);
    expect(loaded.content).toContain('"name":"mcp__docs__t3"');
    expect(loaded.content).toContain('"properties"');
    expect(index.callable("mcp__docs__t3")).toBe(true);
    expect(JSON.stringify(index.tools)).toBe(toolsBefore);
    // Keywords match names and descriptions; an unknown query says so.
    expect(index.search("thing 7").names).toEqual(["mcp__docs__t7"]);
    expect(index.search("nothing-like-this").content).toMatch(/No tool matches/);
  });
});
