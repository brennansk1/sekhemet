import { describe, expect, it } from "vitest";
import { ResidencyScheduler, type UnloadableAdapter } from "../src/index.js";

// A load holds no lock (MD-N9-4, review of b4.0a): the loading model's
// footprint is reserved while it loads, so no second model is admitted
// against that space, and `releaseAll` (the watchdog's critical unload)
// aborts the load at once instead of waiting minutes behind it.

const GB = 1024 ** 3;

function slowWeights(events: string[], loadMs: number) {
  return (key: string) => ({
    footprintBytes: 13 * GB,
    build: (contextTokens: number): UnloadableAdapter => ({
      modelId: key,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens, maxTokens: 1024 },
      generate: async () => ({
        text: key,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
      load: (signal?: AbortSignal) =>
        new Promise<"loaded">((resolve, reject) => {
          events.push(`load ${key}`);
          const t = setTimeout(() => {
            events.push(`loaded ${key}`);
            resolve("loaded");
          }, loadMs);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            events.push(`aborted ${key}`);
            reject(new Error(`load of ${key} aborted`));
          });
        }),
      unload: async () => {
        events.push(`unload ${key}`);
      },
      confirmUnloaded: async () => true,
    }),
  });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a load in flight reserves its footprint and can be aborted", () => {
  it("releaseAll aborts a slow load promptly, and no second large model is admitted during it", async () => {
    const events: string[] = [];
    const w = slowWeights(events, 30_000);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 8192 },
        { role: "planner", weights: "qwen", contextTokens: 8192 },
      ],
      weights: { cyber: w("cyber"), qwen: w("qwen") },
      usableBytes: 16 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    const worker = s.acquire("worker");
    worker.catch(() => undefined);
    await tick(50);
    expect(events).toEqual(["load cyber"]);
    expect(s.loadingWeights()).toEqual(["cyber"]);
    expect(s.residentWeights()).toEqual([]);
    // A second 13 GB model does not start loading beside the reserved 13 GB.
    const planner = s.acquire("planner");
    planner.catch(() => undefined);
    await tick(100);
    expect(events).toEqual(["load cyber"]);

    const start = Date.now();
    await s.releaseAll();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(events.slice(0, 2)).toEqual(["load cyber", "aborted cyber"]);
    expect(s.loadingWeights()).not.toContain("cyber");
    await expect(worker).rejects.toThrow(/aborted/);
    expect(s.residentWeights()).not.toContain("cyber");
    // The reservation is freed: the waiting acquire may now load its model.
    await tick(50);
    expect(events).toContain("load qwen");
    await s.releaseAll();
    await expect(planner).rejects.toThrow(/aborted/);
  });

  it("a load that completes becomes resident, and the lock is free while it loads", async () => {
    const events: string[] = [];
    const w = slowWeights(events, 300);
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "cyber", contextTokens: 8192 }],
      weights: { cyber: w("cyber") },
      usableBytes: 16 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    const hold = s.acquire("worker");
    await tick(50);
    // Releasing a queue whose model is still loading does not wait for the load.
    const start = Date.now();
    await s.release("worker");
    expect(Date.now() - start).toBeLessThan(100);
    const h = await hold;
    expect(s.residentWeights()).toEqual(["cyber"]);
    expect(s.loadingWeights()).toEqual([]);
    h.release();
    expect(events).toEqual(["load cyber", "loaded cyber"]);
  });

  it("queued work waiting on an aborted load stays queued rather than failing", async () => {
    const events: string[] = [];
    const w = slowWeights(events, 30_000);
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "cyber", contextTokens: 8192 }],
      weights: { cyber: w("cyber") },
      usableBytes: 16 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    let settled = false;
    void s
      .submit("worker", async () => "done")
      .finally(() => {
        settled = true;
      });
    await tick(50);
    expect(events).toEqual(["load cyber"]);
    await s.releaseAll();
    await tick(50);
    expect(settled).toBe(false);
    expect(s.waiting("worker")).toBe(1);
  });
});
