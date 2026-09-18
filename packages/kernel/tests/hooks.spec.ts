import { describe, expect, it } from "vitest";
import { LifecycleHookEngine } from "../src/hooks.js";

describe("@sekhemet/kernel LifecycleHookEngine", () => {
  it("registers, executes, and unregisters waterfall lifecycle hooks", async () => {
    const engine = new LifecycleHookEngine();
    const calls: string[] = [];

    const unregister = engine.register("pre-tool", async (ctx) => {
      calls.push(`pre-tool:${ctx.toolName}`);
    });

    engine.register("post-tool", async (ctx) => {
      calls.push(`post-tool:${ctx.toolName}`);
    });

    await engine.emit("pre-tool", { cardId: "card_1", toolName: "read_file" });
    await engine.emit("post-tool", { cardId: "card_1", toolName: "read_file" });

    expect(calls).toEqual(["pre-tool:read_file", "post-tool:read_file"]);

    // Test unregistering
    unregister();
    await engine.emit("pre-tool", { cardId: "card_1", toolName: "write_file" });
    expect(calls).toHaveLength(2); // no new pre-tool call
  });
});
