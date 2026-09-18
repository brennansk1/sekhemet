import { describe, expect, it } from "vitest";
import { ModelRouter, type UnloadableAdapter } from "../src/router.js";

function fake(id: string, log: string[]): UnloadableAdapter {
  return {
    modelId: id,
    supportedArms: ["arm_a_flat"],
    generate: async () => ({
      text: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    }),
    unload: async () => {
      log.push(`unload:${id}`);
    },
  };
}

describe("@sekhemet/models ModelRouter", () => {
  it("unloads the resident model before handing out another role", async () => {
    const log: string[] = [];
    const router = new ModelRouter({ worker: () => fake("w", log), manager: () => fake("m", log) });

    expect((await router.use("worker")).modelId).toBe("w");
    expect(log).toEqual([]);

    expect((await router.use("manager")).modelId).toBe("m");
    // Both resident at once is what exhausts a 24GB machine.
    expect(log).toEqual(["unload:w"]);
    expect(router.swapCount).toBe(1);
  });

  it("does not unload when the same role is requested again", async () => {
    const log: string[] = [];
    const router = new ModelRouter({ worker: () => fake("w", log) });
    await router.use("worker");
    await router.use("worker");
    expect(log).toEqual([]);
    expect(router.swapCount).toBe(0);
  });

  it("reuses one adapter per role across swaps", async () => {
    const log: string[] = [];
    const router = new ModelRouter({ worker: () => fake("w", log), manager: () => fake("m", log) });
    const first = await router.use("worker");
    await router.use("manager");
    const again = await router.use("worker");
    expect(again).toBe(first);
    expect(log).toEqual(["unload:w", "unload:m"]);
  });

  it("rejects an unconfigured role and releases everything on demand", async () => {
    const log: string[] = [];
    const router = new ModelRouter({ worker: () => fake("w", log) });
    expect(router.has("manager")).toBe(false);
    await expect(router.use("manager")).rejects.toThrow("No model configured");
    await router.use("worker");
    await router.releaseAll();
    expect(log).toEqual(["unload:w"]);
    expect(router.activeRole).toBeUndefined();
  });
});
