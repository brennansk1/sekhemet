import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { ModelRegistry, type ModelRole, type UnloadableAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { defaultBenchmarkEnv } from "../src/benchmark_cmd.js";
import { dashboardQualify } from "../src/dashboard_models.js";
import { ModelAccess } from "../src/model_access.js";

// B4.1 half-B review: a benchmark's models load through the one residency
// scheduler (models rule 20a), and while it runs no other role loads —
// Seshat's queued request waits for it, an immediate hold is refused in
// words — and when it ends only what it loaded is unloaded. Fake adapters:
// nothing loads.

const GB = 1024 ** 3;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function fakes(events: string[]) {
  const resolve = (name: string, _role: ModelRole): UnloadableAdapter => ({
    modelId: name,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 1024 },
    generate: async () => ({
      text: name,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    load: async () => {
      events.push(`load ${name}`);
      return "loaded";
    },
    unload: async () => {
      events.push(`unload ${name}`);
    },
    confirmUnloaded: async () => true,
    footprintBytes: async () => 4 * GB,
  });
  return resolve;
}

function access(events: string[]) {
  return ModelAccess.forQueues([{ queue: "pm", role: "planner", name: "seshat" }], {
    resolve: fakes(events),
    usableBytes: 64 * GB,
    coResident: true,
    healthCheck: false,
    pollMs: 5,
  });
}

describe("a benchmark through the one residency scheduler", () => {
  it("loads its models through the scheduler; meanwhile no other role loads — a queued request waits, a hold is refused in words", async () => {
    const events: string[] = [];
    const a = access(events);
    await a.measure();
    let pmServed = false;
    let queued: Promise<unknown> | undefined;
    await a.benchmarkRun(async (lease) => {
      const w = await lease.load("worker", "bench-w");
      expect(w.modelId).toBe("bench-w");
      expect(events).toEqual(["load bench-w"]);
      queued = a.submitHold("pm").then((h) => {
        pmServed = true;
        h.release();
      });
      await expect(a.hold("pm")).rejects.toThrow(/benchmark is running/);
      await tick(60);
      expect(pmServed).toBe(false);
      expect(events).not.toContain("load seshat");
    });
    await queued;
    expect(pmServed).toBe(true);
    expect(events).toEqual(["load bench-w", "unload bench-w", "load seshat"]);
  });

  it("releases only what it loaded: a model resident before it stays", async () => {
    const events: string[] = [];
    const a = access(events);
    await a.measure();
    await a.use("pm");
    await a.benchmarkRun(async (lease) => {
      await lease.load("worker", "bench-w");
      // The same weights as a resident model: not the benchmark's to unload.
      await lease.load("planner", "seshat");
    });
    expect(events).toEqual(["load seshat", "load bench-w", "unload bench-w"]);
    expect(a.isResident("pm")).toBe(true);
    expect(a.residentWeights()).toEqual(["seshat"]);
  });

  it("exclusive(): before a load the scheduler cannot see (llama-bench, a qualification), idle residents unload and one in use refuses", async () => {
    const events: string[] = [];
    const a = access(events);
    await a.measure();
    await a.use("pm");
    await a.benchmarkRun(async (lease) => {
      await lease.exclusive();
      expect(a.residentWeights()).toEqual([]);
    });
    expect(events).toEqual(["load seshat", "unload seshat"]);

    const held = await a.hold("pm");
    try {
      await a.benchmarkRun(async (lease) => {
        await expect(lease.exclusive()).rejects.toThrow(/seshat is in use/);
      });
      expect(a.isResident("pm")).toBe(true);
    } finally {
      held.release();
    }
  });

  it("the page's Qualify runs alone in memory: with another model in use it refuses before loading anything", async () => {
    const events: string[] = [];
    const a = access(events);
    await a.measure();
    await a.use("pm");
    const dir = mkdtempSync(join(tmpdir(), "bench-q-"));
    dirs.push(dir);
    const qualify = dashboardQualify({
      repoPath: dir,
      registry: new ModelRegistry(join(dir, "models.json")),
      adapterFor: (m, r) => fakes(events)(m, r),
      access: () => a,
    });
    const held = await a.hold("pm");
    try {
      const r = await qualify("worker", "candidate");
      expect(r.qualified).toBe(false);
      expect(r.reason).toMatch(/seshat is in use/);
      expect(events).toEqual(["load seshat"]);
    } finally {
      held.release();
    }
  });

  it("the benchmark's default runner gets its models only inside the run, through the scheduler", async () => {
    const events: string[] = [];
    const a = access(events);
    const dir = mkdtempSync(join(tmpdir(), "bench-res-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "events.db"));
    initSchema(db);
    try {
      const env = defaultBenchmarkEnv({ repoPath: dir, log: new EventLog(db), modelAccess: a });
      const runner = env.screenRunner();
      await expect(runner.load("worker", "bench-w")).rejects.toThrow(/only inside its run/);
      expect(events).toEqual([]);
      await env.measurementRun(async () => {
        await runner.load("worker", "bench-w");
        expect(events).toEqual(["load bench-w"]);
        await runner.release?.();
        expect(events).toEqual(["load bench-w", "unload bench-w"]);
        await runner.load("worker", "bench-w");
      });
      expect(events).toEqual(["load bench-w", "unload bench-w", "load bench-w", "unload bench-w"]);
    } finally {
      db.close();
    }
  });
});
