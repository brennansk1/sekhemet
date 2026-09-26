import { describe, expect, it } from "vitest";
import {
  ResidencyScheduler,
  type SwapMemory,
  type UnloadableAdapter,
  type WatchdogLevel,
} from "../src/index.js";

// Review fixes to the residency scheduler behind `decide()` (models rules
// 19, 20e; MD-N14-13, -24): the watchdog's emergency and critical levels,
// the drain barrier, and the DEC-42 guard's place. Fake adapters and a fake
// clock; no model is loaded.

const GB = 1024 ** 3;

const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakes(events: string[]) {
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
          loaded = true;
          events.push(`load ${key}`);
          return "loaded";
        },
        unload: async () => {
          loaded = false;
          events.push(`unload ${key}`);
        },
        confirmUnloaded: async () => true,
      };
    };
}

function scheduler(
  events: string[],
  extra: Partial<ConstructorParameters<typeof ResidencyScheduler>[0]> = {},
) {
  const build = fakes(events);
  return new ResidencyScheduler({
    roles: [
      { role: "worker", weights: "cyber", contextTokens: 16_384 },
      { role: "planner", weights: "qwen", contextTokens: 8192 },
      { role: "escalation", weights: "qwen", contextTokens: 8192 },
      { role: "chat", weights: "qwen", contextTokens: 8192 },
      { role: "researcher", weights: "apodex", contextTokens: 8192 },
    ],
    weights: {
      cyber: { build: build("cyber"), footprintBytes: 13 * GB },
      qwen: { build: build("qwen"), footprintBytes: 12 * GB },
      apodex: { build: build("apodex"), footprintBytes: 12 * GB },
    },
    usableBytes: 16 * GB,
    pressureLevel: () => 1,
    healthCheck: false,
    pollMs: 5,
    ...extra,
  });
}

describe("rule 19 at emergency: an escalation's hold is a pin only the policy respects", () => {
  it("decide() unloads an escalation-held 12 GB model with no running step", async () => {
    const events: string[] = [];
    let level: WatchdogLevel = "normal";
    const s = scheduler(events, { watchdogLevel: () => level });
    const hold = await s.acquire("escalation", { yieldsToWatchdog: true });
    expect(events).toEqual(["load qwen"]);
    level = "emergency";
    s.boundary();
    await flush();
    expect(events).toContain("unload qwen");
    expect(s.residentWeights()).toEqual([]);
    hold.release();
  });

  it("releaseAll (the watchdog's unload) does too; a running step or a person's hold keeps the model", async () => {
    const events: string[] = [];
    let level: WatchdogLevel = "normal";
    const s = scheduler(events, { watchdogLevel: () => level });
    const soft = await s.acquire("escalation", { yieldsToWatchdog: true });
    level = "emergency";
    const end = await s.beginStep("escalation");
    await s.releaseAll();
    expect(events).not.toContain("unload qwen");
    end();
    await s.releaseAll();
    expect(events).toContain("unload qwen");
    soft.release();

    const kept: string[] = [];
    let personLevel: WatchdogLevel = "normal";
    const t = scheduler(kept, { watchdogLevel: () => personLevel });
    const person = await t.acquire("chat");
    personLevel = "emergency";
    await t.releaseAll();
    t.boundary();
    await flush();
    expect(kept).not.toContain("unload qwen");
    person.release();
  });
});

describe("rule 20e: a critical watchdog level starts no load, on any path", () => {
  it("an acquire waits at critical and loads once the level falls", async () => {
    const events: string[] = [];
    let level: WatchdogLevel = "critical";
    const s = scheduler(events, { watchdogLevel: () => level });
    let got = false;
    const hold = s.acquire("chat").then((h) => {
      got = true;
      return h;
    });
    await sleep(30);
    expect(got).toBe(false);
    expect(events).toEqual([]);
    level = "normal";
    (await hold).release();
    expect(events).toEqual(["load qwen"]);
  });

  it("queued work waits at critical, and the pump looks again by itself once the level falls", async () => {
    const events: string[] = [];
    let level: WatchdogLevel = "critical";
    const s = scheduler(events, { watchdogLevel: () => level });
    const done = s.submit("researcher", async () => events.push("research"));
    await sleep(30);
    expect(events).toEqual([]);
    level = "normal";
    await done;
    expect(events).toEqual(["load apodex", "research"]);
  });
});

describe("C8: the drain barrier is lowered after any action that is not a barrier swap", () => {
  it("a swap the headroom refuses once the steps drained: steps resume, nothing stalls", async () => {
    const events: string[] = [];
    let allow = true;
    const memory: SwapMemory = {
      admit: ({ load, evict, resident }) => {
        const left = resident.filter((r) => r !== load && !evict.includes(r));
        return allow && left.length === 0 ? { ok: true } : { ok: false, reason: "no headroom" };
      },
    };
    const s = scheduler(events, { policyMemory: { read: async () => memory } });
    (await s.acquire("worker")).release();
    const endA = await s.beginStep("worker");
    const endB = await s.beginStep("worker");
    void s.submit("chat", async () => events.push("answer")).catch(() => undefined);
    await flush();
    let third = false;
    const next = s.beginStep("worker").then((end) => {
      third = true;
      return end;
    });
    await flush();
    expect(third).toBe(false);
    allow = false;
    endA();
    endB();
    await flush();
    (await next)();
    expect(third).toBe(true);
    expect(events).not.toContain("unload cyber");
  });
});

describe("DEC-42's load guard runs after the evictions", () => {
  it("the guard sees the memory with the evicted model gone", async () => {
    const events: string[] = [];
    const s = scheduler(events);
    (await s.acquire("worker")).release();
    const seen: string[][] = [];
    s.setLoadGuard(() => {
      seen.push(s.residentWeights());
    });
    (await s.acquire("chat")).release();
    expect(seen).toEqual([[]]);
    expect(events).toEqual(["load cyber", "unload cyber", "load qwen"]);
  });
});
