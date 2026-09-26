import { describe, expect, it } from "vitest";
import { FootprintRefusal, ResidencyScheduler, type UnloadableAdapter } from "../src/index.js";

const GB = 1024 ** 3;

/** A fake model: records its constructions, loads (first request) and unloads. */
function fakeWeights(events: string[]) {
  const built: { key: string; contextTokens: number }[] = [];
  const build =
    (key: string) =>
    (contextTokens: number): UnloadableAdapter => {
      built.push({ key, contextTokens });
      let loaded = false;
      return {
        modelId: key,
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens, maxTokens: 1024 },
        generate: async () => {
          if (!loaded) events.push(`load ${key}`);
          loaded = true;
          return {
            text: key,
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          };
        },
        unload: async () => {
          loaded = false;
          events.push(`unload ${key}`);
        },
        confirmUnloaded: async () => true,
      };
    };
  return { built, build };
}

describe("NEW-models-9: one scheduler owns residency", () => {
  it("MD-N9-1: roles on the same weights share one adapter with the largest context either needs", async () => {
    const events: string[] = [];
    const { built, build } = fakeWeights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "planner", weights: "qwen", contextTokens: 8192 },
        { role: "seshat", weights: "qwen", contextTokens: 12_288 },
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
      ],
      weights: {
        qwen: { build: build("qwen"), footprintBytes: 12 * GB },
        cyber: { build: build("cyber"), footprintBytes: 13 * GB },
      },
      usableBytes: 16 * GB,
    });
    expect(s.adapterFor("planner")).toBe(s.adapterFor("seshat"));
    expect(s.adapterFor("planner").contextWindow?.contextTokens).toBe(12_288);
    await s.submit("planner", (a) => a.generate({ prompt: "p", toolArm: "arm_a_flat" }));
    await s.submit("seshat", (a) => a.generate({ prompt: "s", toolArm: "arm_a_flat" }));
    expect(built.filter((b) => b.key === "qwen")).toHaveLength(1);
    expect(events).toEqual(["load qwen"]);
    expect(s.loadCount).toBe(1);
  });

  it("MD-N9-2: interleaved questions are batched by weights, at most two loads for the batch", async () => {
    const events: string[] = [];
    const { build } = fakeWeights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "researcher", weights: "apodex", contextTokens: 16_384 },
        { role: "planner", weights: "qwen", contextTokens: 8192 },
      ],
      weights: {
        apodex: { build: build("apodex"), footprintBytes: 15 * GB },
        qwen: { build: build("qwen"), footprintBytes: 12 * GB },
      },
      usableBytes: 16 * GB,
      // The residency plan: the Researcher's batch, then the Planner's.
      order: ["researcher", "planner"],
    });
    const done: string[] = [];
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      for (const role of ["planner", "researcher"] as const) {
        jobs.push(
          s.submit(role, async (a) => {
            await a.generate({ prompt: `${role} ${i}`, toolArm: "arm_a_flat" });
            done.push(role);
          }),
        );
      }
    }
    await Promise.all(jobs);
    expect(done).toEqual([...Array(4).fill("researcher"), ...Array(4).fill("planner")]);
    expect(events.filter((e) => e.startsWith("load"))).toEqual(["load apodex", "load qwen"]);
    expect(s.loadCount).toBeLessThanOrEqual(2);
    expect(s.swapCount).toBe(1);
  });

  it("MD-N9-3: a load that would not fit, or of unknown size, is refused and the work stays queued", async () => {
    const events: string[] = [];
    const { build } = fakeWeights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "reviewer", weights: "big", contextTokens: 12_288 },
        { role: "researcher", weights: "mystery", contextTokens: 8192 },
      ],
      weights: {
        cyber: { build: build("cyber"), footprintBytes: 13 * GB },
        big: { build: build("big"), footprintBytes: 20 * GB },
        mystery: { build: build("mystery") },
      },
      usableBytes: 16 * GB,
    });
    const tooBig = s.submit("reviewer", (a) => a.generate({ prompt: "r", toolArm: "arm_a_flat" }));
    const unknown = s.submit("researcher", (a) =>
      a.generate({ prompt: "q", toolArm: "arm_a_flat" }),
    );
    let settled = false;
    void Promise.race([tooBig, unknown]).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(s.waiting("reviewer")).toBe(1);
    expect(s.waiting("researcher")).toBe(1);
    const refusals = s.refusals();
    expect(refusals.reviewer).toBeInstanceOf(FootprintRefusal);
    expect(refusals.reviewer?.message).toMatch(/20\.0 GB/);
    expect(refusals.reviewer?.message).toMatch(/16\.0 GB usable/);
    expect(refusals.researcher?.message).toMatch(/footprint of mystery is unknown/);
    expect(events).toEqual([]);
    // Once the size is known and fits, the queued work runs.
    s.setFootprint("mystery", 4 * GB);
    await unknown;
    expect(events).toEqual(["load mystery"]);
    expect(s.waiting("reviewer")).toBe(1);
  });

  it("MD-N9-3: names both footprints when the resident model and the new one do not fit together", async () => {
    const events: string[] = [];
    const { build } = fakeWeights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "planner", weights: "qwen", contextTokens: 8192 },
      ],
      weights: {
        cyber: { build: build("cyber"), footprintBytes: 13 * GB },
        qwen: { build: build("qwen"), footprintBytes: 12 * GB },
      },
      usableBytes: 16 * GB,
      // The Worker's step holds it resident: it may not be evicted.
      pinned: ["worker"],
    });
    await s.submit("worker", (a) => a.generate({ prompt: "w", toolArm: "arm_a_flat" }));
    void s.submit("planner", (a) => a.generate({ prompt: "p", toolArm: "arm_a_flat" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(s.refusals().planner?.message).toMatch(
      /13\.0 GB resident \(cyber\) \+ 12\.0 GB \(qwen\)/,
    );
    expect(s.waiting("planner")).toBe(1);
    s.unpin("worker");
    await new Promise((r) => setTimeout(r, 20));
    expect(s.waiting("planner")).toBe(0);
    expect(events).toEqual(["load cyber", "unload cyber", "load qwen"]);
  });

  it("MD-N9-5: when every model fits, all stay resident and every queue drains as work arrives", async () => {
    const events: string[] = [];
    const { build } = fakeWeights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "planner", weights: "qwen", contextTokens: 8192 },
        { role: "researcher", weights: "apodex", contextTokens: 16_384 },
      ],
      weights: {
        cyber: { build: build("cyber"), footprintBytes: 13 * GB },
        qwen: { build: build("qwen"), footprintBytes: 12 * GB },
        apodex: { build: build("apodex"), footprintBytes: 15 * GB },
      },
      usableBytes: 96 * GB,
    });
    for (const role of ["worker", "planner", "researcher", "worker", "planner"] as const) {
      await s.submit(role, (a) => a.generate({ prompt: role, toolArm: "arm_a_flat" }));
    }
    expect(events).toEqual(["load cyber", "load qwen", "load apodex"]);
    expect(s.swapCount).toBe(0);
    expect(s.residentWeights().sort()).toEqual(["apodex", "cyber", "qwen"]);
  });
});
