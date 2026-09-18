import { describe, expect, it } from "vitest";
import { ModelRouter, SwapHeadroomError, type UnloadableAdapter } from "../src/router.js";

const adapter = (id: string, events: string[], unloads = true): UnloadableAdapter =>
  ({
    modelId: id,
    generate: async () => ({
      text: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
    }),
    unload: async () => {
      events.push(`unload ${id}`);
    },
    confirmUnloaded: async () => unloads,
  }) as unknown as UnloadableAdapter;

describe("@sekhemet/models swap safety", () => {
  it("unloads, confirms, waits for normal pressure, and logs the swap", async () => {
    const events: string[] = [];
    const levels = [4, 2, 1];
    const logs: string[] = [];
    const router = new ModelRouter(
      { worker: () => adapter("w", events), manager: () => adapter("m", events) },
      {
        log: (l) => logs.push(l),
        headroomWaitMs: 10_000,
        pressureLevel: () => levels.shift() ?? 1,
        freeBytes: () => 8 * 1024 ** 3,
      },
    );
    await router.use("worker");
    await router.use("manager");
    expect(events).toEqual(["unload w"]);
    expect(logs[0]).toMatch(/swap worker -> manager: unload confirmed, .* pressure normal/);
    expect(router.swapCount).toBe(1);
  });

  it("refuses to load the next model when the last one did not unload", async () => {
    const router = new ModelRouter(
      { worker: () => adapter("w", [], false), manager: () => adapter("m", []) },
      { pressureLevel: () => 1, freeBytes: () => 0 },
    );
    await router.use("worker");
    await expect(router.use("manager")).rejects.toBeInstanceOf(SwapHeadroomError);
  });

  it("does not unload and reload when two roles share the same model", async () => {
    const events: string[] = [];
    const router = new ModelRouter(
      { manager: () => adapter("dirk", events), escalation: () => adapter("dirk", events) },
      { pressureLevel: () => 1, freeBytes: () => 0 },
    );
    await router.use("manager");
    await router.use("escalation");
    expect(events).toEqual([]);
    expect(router.swapCount).toBe(0);
  });
});
