import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWAP_POLICY,
  ResidencyScheduler,
  SWAP_OVERHEAD_EVENT,
  type SwapMemory,
  type UnloadableAdapter,
} from "../src/index.js";

// The residency scheduler behind `decide()` (models rule 20e, MD-N14-13,
// -16, -24, -25, -26, -12): the pump applies the one decision at every step
// boundary. Fake adapters and a fake clock; no model is loaded.

const GB = 1024 ** 3;
const MIN = 60_000;

function clock(start = 1_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Fakes that load on request, log every load and unload, and optionally hold a load open. */
function fakes(events: string[], opts: { loadGate?: Promise<void>; bytes?: number } = {}) {
  return (key: string) =>
    (contextTokens: number): UnloadableAdapter => {
      let loaded = false;
      return {
        modelId: key,
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens, maxTokens: 64 },
        generate: async () => ({
          text: key,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        }),
        load: async () => {
          if (loaded) return "adopted";
          if (opts.loadGate) await opts.loadGate;
          loaded = true;
          events.push(`load ${key}`);
          return "loaded";
        },
        unload: async () => {
          loaded = false;
          events.push(`unload ${key}`);
        },
        confirmUnloaded: async () => true,
        ...(opts.bytes !== undefined
          ? {
              weightsSource: async () => ({
                path: `/models/${key}.gguf`,
                bytes: opts.bytes as number,
              }),
            }
          : {}),
      };
    };
}

function scheduler(
  events: string[],
  extra: Partial<ConstructorParameters<typeof ResidencyScheduler>[0]> = {},
  build = fakes(events),
) {
  return new ResidencyScheduler({
    roles: [
      { role: "worker", weights: "cyber", contextTokens: 16_384 },
      { role: "planner", weights: "qwen", contextTokens: 8192 },
      { role: "chat", weights: "qwen", contextTokens: 8192 },
      { role: "reviewer", weights: "gemma", contextTokens: 8192 },
      { role: "researcher", weights: "apodex", contextTokens: 8192 },
    ],
    weights: {
      cyber: { build: build("cyber"), footprintBytes: 13 * GB },
      qwen: { build: build("qwen"), footprintBytes: 12 * GB },
      gemma: { build: build("gemma"), footprintBytes: 12 * GB },
      apodex: { build: build("apodex"), footprintBytes: 12 * GB },
    },
    usableBytes: 16 * GB,
    pressureLevel: () => 1,
    healthCheck: false,
    ...extra,
  });
}

describe("MD-N14-13, -16: the pump applies decide(), and one absence serves every queue past half its cap", () => {
  it("a Planner question at 60% and a review at 55% of their caps: one Worker absence, one reload", async () => {
    const events: string[] = [];
    const t = clock();
    const s = scheduler(events, { now: t.now });
    const card = deferred();
    const running = s.submit("worker", async () => {
      events.push("worker step");
      await card.promise;
    });
    await flush();
    const served: Promise<unknown>[] = [];
    served.push(s.submit("reviewer", async () => events.push("review")));
    t.advance(6.75 * MIN);
    served.push(s.submit("planner", async () => events.push("plan")));
    t.advance(18 * MIN);
    card.resolve();
    await running;
    await Promise.all(served);
    await s.submit("worker", async () => events.push("next worker step"));
    expect(events).toEqual([
      "load cyber",
      "worker step",
      "unload cyber",
      "load qwen",
      "plan",
      "unload qwen",
      "load gemma",
      "review",
      "unload gemma",
      "load cyber",
      "next worker step",
    ]);
    expect(s.lastDecision?.rule).toBeDefined();
  });
});

describe("MD-N14-24: C8, the drain barrier over parallel slots", () => {
  it("two slots, one ending its step 40 s after the other: no new step starts, and the unload follows the second", async () => {
    const events: string[] = [];
    const t = clock();
    const s = scheduler(events, { now: t.now });
    (await s.acquire("worker")).release();
    const endA = await s.beginStep("worker");
    const endB = await s.beginStep("worker");
    const answered = s.submit("chat", async () => events.push("answer"));
    await flush();
    let thirdStarted = false;
    const third = s.beginStep("worker").then((end) => {
      events.push("third step admitted");
      thirdStarted = true;
      return end;
    });
    await flush();
    expect(events).toEqual(["load cyber"]);
    events.push("end A");
    endA();
    await flush();
    expect(thirdStarted).toBe(false);
    expect(events).not.toContain("unload cyber");
    t.advance(40_000);
    events.push("end B");
    endB();
    await answered;
    (await third)();
    expect(events.indexOf("unload cyber")).toBeGreaterThan(events.indexOf("end B"));
    expect(events.indexOf("third step admitted")).toBeGreaterThan(events.indexOf("unload cyber"));
    expect(events.filter((e) => !e.startsWith("third") && e !== "answer")).toEqual([
      "load cyber",
      "end A",
      "end B",
      "unload cyber",
      "load qwen",
    ]);
  });
});

describe("MD-N14-25: C9, CPU-side work runs while a model loads", () => {
  it("a scripted slow load: the queued card's gate runs inside it", async () => {
    const events: string[] = [];
    const gate = deferred();
    const s = scheduler(
      events,
      {
        overlap: async (loading: string) => {
          events.push(`gate ran while ${loading} loads`);
          gate.resolve();
        },
      },
      fakes(events, { loadGate: gate.promise }),
    );
    await s.submit("planner", async () => events.push("plan"));
    expect(events).toEqual(["gate ran while qwen loads", "load qwen", "plan"]);
  });
});

describe("MD-N14-26: C10, the successor is prefetched from free memory only", () => {
  it("warms the plan's next weights while memory allows, and not when it does not", async () => {
    const events: string[] = [];
    let free = 40 * GB;
    const memory = (): SwapMemory => ({
      freeBytes: free,
      admit: ({ load, evict, resident }) =>
        resident.filter((r) => r !== load && !evict.includes(r)).length === 0
          ? { ok: true }
          : { ok: false, reason: "one at a time" },
    });
    const s = scheduler(
      events,
      {
        policyMemory: { read: async () => memory() },
        prefetch: async (weights: string) => {
          events.push(`prefetch ${weights}`);
        },
        swapCost: { volumeOf: () => "internal" },
      },
      fakes(events, { bytes: 12 * GB }),
    );
    s.setPlan(["gemma"]);
    await s.submit("worker", async () => events.push("step"));
    await flush();
    // Warmed while the Worker serves: the successor is ready before the swap.
    expect(events).toEqual(["load cyber", "prefetch gemma", "step"]);
    free = 13 * GB;
    s.setPlan(["qwen"]);
    s.boundary();
    await flush();
    expect(events).not.toContain("prefetch qwen");
  });
});

describe("MD-N14-12: θ is recorded with the policy's parameters after each swap", () => {
  it("writes the θ record beside the swap records", async () => {
    const events: string[] = [];
    const records: { type: string; payload: unknown }[] = [];
    const s = scheduler(events, {
      swapCost: {
        record: (e) => {
          records.push(e);
        },
      },
    });
    await s.submit("worker", async () => undefined);
    await s.submit("planner", async () => undefined);
    const overhead = records.filter((r) => r.type === SWAP_OVERHEAD_EVENT);
    expect(overhead).toHaveLength(1);
    expect(overhead[0]?.payload).toMatchObject({
      swaps: 1,
      windowMs: 60 * MIN,
      policyVersion: DEFAULT_SWAP_POLICY.version,
      params: { thetaMax: 0.2, "capsMs.reviewer": 45 * MIN, horizon: 4 },
    });
  });
});

describe("predicted waits (the median) for a queued request", () => {
  it("says when a request on another model would start, and whether it takes the quick path", async () => {
    const events: string[] = [];
    const s = scheduler(events);
    (await s.acquire("worker")).release();
    const wait = await s.predictWait("chat");
    expect(wait).toMatchObject({ queue: "chat", quickPath: false });
    expect(wait.waitMs).toBeGreaterThanOrEqual(0);
  });
});
