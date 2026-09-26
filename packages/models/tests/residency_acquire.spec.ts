import { describe, expect, it } from "vitest";
import {
  FootprintRefusal,
  ModelUnavailableError,
  ResidencyScheduler,
  SwapHeadroomError,
  type UnloadableAdapter,
} from "../src/index.js";

// MD-N9-1..5: the scheduler hands out a queue's model now (`acquire`), with
// the swap safety the old per-role router had. Nothing loads a real model.

const GB = 1024 ** 3;

function weights(
  events: string[],
  opts: { unloads?: boolean; healthy?: boolean; footprint?: number | undefined } = {},
) {
  return (key: string) => ({
    build: (contextTokens: number): UnloadableAdapter => ({
      modelId: key,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens, maxTokens: 1024 },
      generate: async () => ({
        text: key,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
      unload: async () => {
        events.push(`unload ${key}`);
      },
      confirmUnloaded: async () => opts.unloads ?? true,
      healthCheck: async () => ({
        ok: opts.healthy ?? true,
        modelId: key,
        state: (opts.healthy ?? true) ? "ok" : "down",
        ...(opts.healthy === false ? { detail: "connection refused" } : {}),
      }),
      ...("footprint" in opts
        ? { footprintBytes: async () => opts.footprint }
        : { footprintBytes: async () => 10 * GB }),
    }),
  });
}

describe("ResidencyScheduler.acquire: a queue's model now, safely", () => {
  it("unloads, confirms, waits for normal pressure, and logs the swap", async () => {
    const events: string[] = [];
    const levels = [4, 2, 1];
    const logs: string[] = [];
    const w = weights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "chat", weights: "qwen", contextTokens: 8192 },
      ],
      weights: { cyber: w("cyber"), qwen: w("qwen") },
      usableBytes: 16 * GB,
      log: (l) => logs.push(l),
      headroomWaitMs: 10_000,
      pressureLevel: () => levels.shift() ?? 1,
      pollMs: 1,
    });
    await s.measureFootprints();
    (await s.acquire("worker")).release();
    expect(s.activeRole).toBe("worker");
    (await s.acquire("chat")).release();
    expect(events).toEqual(["unload cyber"]);
    expect(logs.some((l) => /swap cyber -> qwen: unload confirmed, pressure normal/.test(l))).toBe(
      true,
    );
    expect(s.swapCount).toBe(1);
    expect(s.isResident("chat")).toBe(true);
    expect(s.isResident("worker")).toBe(false);
    expect(s.residentRoles()).toEqual(["chat"]);
  });

  it("refuses to load the next model when the last one did not unload", async () => {
    const events: string[] = [];
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "chat", weights: "qwen", contextTokens: 8192 },
      ],
      weights: {
        cyber: weights(events, { unloads: false })("cyber"),
        qwen: weights(events)("qwen"),
      },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
    await s.measureFootprints();
    (await s.acquire("worker")).release();
    await expect(s.acquire("chat")).rejects.toBeInstanceOf(SwapHeadroomError);
    expect(s.isResident("chat")).toBe(false);
  });

  it("does not unload when two queues share weights", async () => {
    const events: string[] = [];
    const w = weights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "chat", weights: "qwen", contextTokens: 8192 },
        { role: "escalation", weights: "qwen", contextTokens: 12_288 },
      ],
      weights: { qwen: w("qwen") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
    await s.measureFootprints();
    const a = await s.acquire("chat");
    const b = await s.acquire("escalation");
    // Two holds on one weights: nothing to evict.
    expect(a.adapter).toBe(b.adapter);
    expect(a.adapter.contextWindow?.contextTokens).toBe(12_288);
    expect(events).toEqual([]);
    expect(s.swapCount).toBe(0);
  });

  it("fails fast on a model whose health check fails", async () => {
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "cyber", contextTokens: 16_384 }],
      weights: { cyber: weights([], { healthy: false })("cyber") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
    await s.measureFootprints();
    await expect(s.acquire("worker")).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("keeps one model at a time when the tier does not co-load, even if both would fit", async () => {
    const events: string[] = [];
    const w = weights(events);
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "a", contextTokens: 8192 },
        { role: "chat", weights: "b", contextTokens: 8192 },
      ],
      weights: { a: w("a"), b: w("b") },
      usableBytes: 64 * GB,
      coResident: false,
      pressureLevel: () => 1,
    });
    await s.measureFootprints();
    (await s.acquire("worker")).release();
    (await s.acquire("chat")).release();
    expect(events).toEqual(["unload a"]);
  });

  it("refuses a model whose footprint is unknown, and one that cannot evict a pinned model", async () => {
    const events: string[] = [];
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "a", contextTokens: 8192 },
        { role: "chat", weights: "b", contextTokens: 8192 },
        { role: "research", weights: "c", contextTokens: 8192 },
      ],
      weights: {
        a: weights(events)("a"),
        b: weights(events)("b"),
        c: weights(events, { footprint: undefined })("c"),
      },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      pinned: ["worker"],
    });
    const plan = await s.measureFootprints();
    expect(plan.unknown).toEqual(["c"]);
    await expect(s.acquire("research")).rejects.toThrow(/footprint of c is unknown/);
    (await s.acquire("worker")).release();
    await expect(s.acquire("chat")).rejects.toBeInstanceOf(FootprintRefusal);
    expect(events).toEqual([]);
    expect(s.has("chat")).toBe(true);
    expect(s.has("reviewer")).toBe(false);
  });
});

// M1 (review of B4.0a part 2): `acquire` hands out a hold that pins the
// model until it is released, and one mutex serialises every load and
// eviction, so no caller's model is evicted mid-answer.
describe("ResidencyScheduler.acquire: holds and one lock", () => {
  const two = (
    events: string[],
    extra: Partial<ConstructorParameters<typeof ResidencyScheduler>[0]> = {},
  ) => {
    const w = weights(events);
    return new ResidencyScheduler({
      roles: [
        { role: "chat", weights: "a", contextTokens: 8192 },
        { role: "research", weights: "b", contextTokens: 8192 },
      ],
      weights: { a: w("a"), b: w("b") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      ...extra,
    });
  };

  it("two concurrent acquires that do not both fit: exactly one loads, the other is refused", async () => {
    const events: string[] = [];
    const slow = (key: string) => ({
      build: (contextTokens: number): UnloadableAdapter => ({
        ...weights(events)(key).build(contextTokens),
        healthCheck: async () => {
          await new Promise((r) => setTimeout(r, 20));
          return { ok: true, modelId: key, state: "ok" } as never;
        },
      }),
      footprintBytes: 10 * GB,
    });
    const s = new ResidencyScheduler({
      roles: [
        { role: "chat", weights: "a", contextTokens: 8192 },
        { role: "research", weights: "b", contextTokens: 8192 },
      ],
      weights: { a: slow("a"), b: slow("b") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
    const got = await Promise.allSettled([s.acquire("chat"), s.acquire("research")]);
    expect(got.filter((g) => g.status === "fulfilled")).toHaveLength(1);
    const refused = got.find((g) => g.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(FootprintRefusal);
    expect(s.loadCount).toBe(1);
    expect(events).toEqual([]);
  });

  it("a held model is not evicted by a research acquire; once released it is", async () => {
    const events: string[] = [];
    const s = two(events);
    await s.measureFootprints();
    const hold = await s.acquire("chat");
    await expect(s.acquire("research")).rejects.toBeInstanceOf(FootprintRefusal);
    await s.release("chat");
    expect(events).toEqual([]);
    expect(s.isResident("chat")).toBe(true);
    hold.release();
    hold.release(); // idempotent
    const research = await s.acquire("research");
    expect(research.adapter.modelId).toBe("b");
    expect(events).toEqual(["unload a"]);
  });

  it("queued work holds its model while it runs", async () => {
    const events: string[] = [];
    const s = two(events);
    await s.measureFootprints();
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    let finish!: () => void;
    const job = s.submit("chat", async () => {
      started();
      await new Promise<void>((r) => {
        finish = r;
      });
      return "done";
    });
    await running;
    await expect(s.acquire("research")).rejects.toBeInstanceOf(FootprintRefusal);
    finish();
    expect(await job).toBe("done");
    expect(events).toEqual([]);
  });

  it("an Ollama-style reload beside another model cannot happen", async () => {
    // Ollama loads a model on any request: an adapter evicted mid-answer
    // reloads itself beside whatever replaced it. This fake tracks residency.
    const loaded = new Set<string>();
    let most = 0;
    const ollama = (key: string) => ({
      build: (contextTokens: number): UnloadableAdapter => ({
        modelId: key,
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens, maxTokens: 1024 },
        generate: async () => {
          loaded.add(key);
          most = Math.max(most, loaded.size);
          await new Promise((r) => setTimeout(r, 5));
          return {
            text: key,
            toolCalls: [],
            usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
          };
        },
        unload: async () => {
          loaded.delete(key);
        },
        confirmUnloaded: async () => !loaded.has(key),
      }),
      footprintBytes: 10 * GB,
    });
    const s = new ResidencyScheduler({
      roles: [
        { role: "chat", weights: "a", contextTokens: 8192 },
        { role: "research", weights: "b", contextTokens: 8192 },
      ],
      weights: { a: ollama("a"), b: ollama("b") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      healthCheck: false,
    });
    const ask = { messages: [], prompt: "", toolArm: "arm_a_flat" } as never;
    const seshat = (async () => {
      const hold = await s.acquire("chat");
      try {
        await hold.adapter.generate(ask);
        await new Promise((r) => setTimeout(r, 10));
        await hold.adapter.generate(ask); // the second turn of one answer
      } finally {
        hold.release();
      }
    })();
    await new Promise((r) => setTimeout(r, 2));
    const research = s
      .acquire("research")
      .then(async (h) => {
        await h.adapter.generate(ask);
        h.release();
      })
      .catch((err: unknown) => err);
    await seshat;
    expect(await research).toBeInstanceOf(FootprintRefusal);
    expect(most).toBe(1);
  });
});

// The per-role router's assertions, kept for the scheduler that replaced it.
describe("ResidencyScheduler: what the old router held", () => {
  const build = (events: string[]) => {
    const w = weights(events);
    return new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "a", contextTokens: 8192 },
        { role: "chat", weights: "b", contextTokens: 8192 },
      ],
      weights: { a: w("a"), b: w("b") },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
  };

  it("refuses an unconfigured role", async () => {
    const s = build([]);
    await s.measureFootprints();
    expect(s.has("manager")).toBe(false);
    await expect(s.acquire("manager")).rejects.toThrow(/No model is assigned to the manager role/);
  });

  it("releaseAll unloads everything and clears the active role", async () => {
    const events: string[] = [];
    const s = build(events);
    await s.measureFootprints();
    (await s.acquire("worker")).release();
    expect(s.activeRole).toBe("worker");
    await s.releaseAll();
    expect(events).toEqual(["unload a"]);
    expect(s.activeRole).toBeUndefined();
  });

  it("reuses one adapter per weights across swaps", async () => {
    const events: string[] = [];
    const s = build(events);
    await s.measureFootprints();
    const first = await s.acquire("worker");
    first.release();
    (await s.acquire("chat")).release();
    const again = await s.acquire("worker");
    expect(again.adapter).toBe(first.adapter);
    expect(events).toEqual(["unload a", "unload b"]);
  });
});
