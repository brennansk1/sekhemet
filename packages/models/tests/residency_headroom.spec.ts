import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeHeadroomProbe,
  type LoadOptions,
  type MemoryReading,
  ResidencyScheduler,
  SWAP_EVENTS,
  type UnloadableAdapter,
  VolumeProber,
} from "../src/index.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function reading(over: Partial<MemoryReading> = {}): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 20480 * MiB,
    metalInUseBytes: 0.2 * GiB,
    totalBytes: 24 * GiB,
    wiredBytes: 2 * GiB,
    anonymousBytes: 3 * GiB,
    compressorBytes: 0.5 * GiB,
    swapUsedBytes: 0,
    processes: [],
    ...over,
  };
}

/** A fake llama.cpp model that loads on request, recording the options it was given. */
function model(path: string, seen: (LoadOptions | undefined)[]) {
  return (contextTokens: number): UnloadableAdapter => ({
    modelId: "worker",
    engine: "llama.cpp",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens, maxTokens: 1024 },
    load: async (_signal, options) => {
      seen.push(options);
      return "loaded";
    },
    weightsSource: async () => ({ path, bytes: 1000 }),
    generate: async () => ({
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    unload: async () => undefined,
    confirmUnloaded: async () => true,
  });
}

function weightsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "res-headroom-"));
  const path = join(dir, "w.gguf");
  writeFileSync(path, Buffer.alloc(1000));
  return path;
}

describe("the residency scheduler wires the headroom probe and the load options", () => {
  it("MD-N14-31: refuses a load the probe does not admit, keeping the work queued and naming the measure", async () => {
    const seen: (LoadOptions | undefined)[] = [];
    const probe = new FakeHeadroomProbe(
      reading({
        metalInUseBytes: 9 * GiB,
        processes: [{ pid: 7, name: "Hermes", port: 8080, footprintBytes: 9e9, ours: false }],
      }),
    );
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "worker", contextTokens: 8192 }],
      weights: { worker: { build: model(weightsFile(), seen), footprintBytes: 13 * GiB } },
      usableBytes: 64 * GiB,
      headroom: probe,
    });
    let settled = false;
    const done = () => {
      settled = true;
    };
    void s.submit("worker", async () => "ran").then(done, done);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(s.waiting("worker")).toBe(1);
    expect(seen).toHaveLength(0);
    const refusal = s.refusals().worker;
    expect(refusal?.message).toMatch(/GPU/);
    expect(refusal?.message).toContain("Hermes on 8080 holds 9.0 GB");
    await s.releaseAll();
  });

  it("MD-N14-35, MD-N14-1: passes the load options with --cache-ram from the headroom, and records engine and load mode", async () => {
    const seen: (LoadOptions | undefined)[] = [];
    const recorded: { type: string; payload: Record<string, unknown> }[] = [];
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "worker", contextTokens: 8192 }],
      weights: { worker: { build: model(weightsFile(), seen), footprintBytes: 12 * GiB } },
      usableBytes: 64 * GiB,
      headroom: new FakeHeadroomProbe(reading()),
      loadOptions: () => ({ loadMode: "no_mmap" }),
      swapCost: {
        record: (e) => {
          recorded.push(e as { type: string; payload: Record<string, unknown> });
        },
        volumeOf: () => "internal",
      },
    });
    expect(await s.submit("worker", async () => "ran")).toBe("ran");
    expect(seen[0]?.loadMode).toBe("no_mmap");
    // GPU headroom 20 − 0.2 − 1 − 0.5 = 18.3 GiB; system 24 − 5.5 − 3 GB − 2 GiB ≈ 13.7 GiB;
    // half of what is left after 12 GiB, in MiB.
    expect(seen[0]?.cacheRamMiB).toBeGreaterThan(700);
    expect(seen[0]?.cacheRamMiB).toBeLessThan(900);
    const loaded = recorded.find((e) => e.type === SWAP_EVENTS.loaded)?.payload;
    expect(loaded?.engine).toBe("llama.cpp");
    expect(loaded?.loadMode).toBe("no_mmap");
    await s.releaseAll();
  });

  it("MD-N14-35: a disconnected drive refuses the load and the work stays queued, saying why", async () => {
    const seen: (LoadOptions | undefined)[] = [];
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "worker", contextTokens: 8192 }],
      weights: {
        worker: {
          build: model("/Volumes/No Such Drive 9f3a/llm/w.gguf", seen),
          footprintBytes: 12 * GiB,
        },
      },
      usableBytes: 64 * GiB,
      volumeProbe: new VolumeProber(),
      swapCost: { volumeOf: () => "external" },
    });
    let rejected: unknown;
    void s
      .submit("worker", async () => "ran")
      .catch((err) => {
        rejected = err;
      });
    await new Promise((r) => setTimeout(r, 50));
    expect(rejected).toBeUndefined();
    expect(s.waiting("worker")).toBe(1);
    expect(seen).toHaveLength(0);
    expect(s.refusals().worker?.message).toMatch(/No Such Drive 9f3a.*not connected/);
    await s.releaseAll();
  });
});
