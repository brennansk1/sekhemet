import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  ManagedLlamaServerAdapter,
  MockInferenceAdapter,
  ModelRegistry,
  ModelRoster,
  THROUGHPUT_FLOORS,
  ThroughputFloorError,
  UnsupportedHardwareError,
  assertModelRunnable,
  assertThroughputFloor,
  calibrateHardware,
  calibrateModel,
  calibrateSpeculative,
  decideSpeculative,
  hostFingerprintHash,
  loadMachineProfile,
  needsRecalibration,
  selectArm,
  selectEngine,
  templateChecksum,
  throughputClass,
  tierForBudget,
} from "../src/index.js";
import type { InferenceRequest, InferenceResponse, TokenUsage } from "../src/types.js";
import { fakeServer } from "./support/fake_server.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-reg-"));
  dirs.push(d);
  return d;
}

describe("M11/M12: model registry and template pinning", () => {
  it("persists entries atomically and reloads them", () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    reg.upsert("m1", { family: "qwen", quant: "IQ3_S", contextWindow: 16384, roles: ["executor"] });
    const again = new ModelRegistry(path);
    expect(again.get("m1")).toMatchObject({ family: "qwen", quant: "IQ3_S" });
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("pins the first template and invalidates qualification when it changes", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const first = reg.pinTemplate("m", "{{ messages }}");
    expect(first).toMatchObject({ pinned: true, changed: false });
    expect(first.checksum).toBe(templateChecksum("{{ messages }}"));
    reg.recordQualification("m", { suiteVersion: "q1.0", passRate: 0.9, status: "qualified" });
    reg.recordArmMeasurement("m", "arm_a_flat", 0.9, 10);
    expect(reg.isQualified("m", 0.8)).toBe(true);
    expect(reg.pinTemplate("m", "{{ messages }}")).toMatchObject({ pinned: false, changed: false });

    const changed = reg.pinTemplate("m", "{{ messages }}{# patched #}");
    expect(changed.changed).toBe(true);
    expect(reg.isQualified("m", 0.8)).toBe(false);
    expect(reg.get("m")?.qualification?.status).toBe("invalidated");
    expect(reg.get("m")?.qualification?.reason).toMatch(/template changed/);
    expect(reg.armFor("m")).toBeUndefined();
    expect(reg.get("m")?.qualificationHistory).toHaveLength(1);
  });

  it("the adapter pins the llama-server template on its first request", async () => {
    let template = "tmpl-A";
    const srv = await fakeServer((req) =>
      req.url === "/props"
        ? { json: { chat_template: template } }
        : { json: { choices: [{ message: { content: "ok" } }] } },
    );
    closers.push(srv.close);
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordQualification("srv", { suiteVersion: "q1.0", passRate: 1, status: "qualified" });
    const pins: boolean[] = [];
    const a = new HttpInferenceAdapter({
      modelId: "srv",
      baseUrl: srv.url,
      apiFormat: "openai",
      registry: reg,
      onTemplatePin: (_id, r) => pins.push(r.changed),
    });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(srv.seen.filter((s) => s.url === "/props")).toHaveLength(1);
    expect(reg.get("srv")?.template?.checksum).toBe(templateChecksum("tmpl-A"));

    // The server is restarted with another template: a new adapter sees it.
    template = "tmpl-B";
    const b = new HttpInferenceAdapter({
      modelId: "srv",
      baseUrl: srv.url,
      apiFormat: "openai",
      registry: reg,
      onTemplatePin: (_id, r) => pins.push(r.changed),
    });
    await b.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(pins).toEqual([false, true]);
    expect(reg.isQualified("srv", 0.5)).toBe(false);
  });

  it("the Ollama path reads the template from /api/show", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/show"
        ? { json: { template: "ollama-tmpl" } }
        : req.url === "/api/ps"
          ? { json: { models: [{ name: "o" }] } }
          : { json: { message: { content: "ok" } } },
    );
    closers.push(srv.close);
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = new HttpInferenceAdapter({ modelId: "o", baseUrl: srv.url, registry: reg });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(reg.get("o")?.template?.checksum).toBe(templateChecksum("ollama-tmpl"));
  });

  it("the roster attaches the registry to the adapters it builds", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordArmMeasurement("some-ollama-model", "arm_b_json", 0.95, 10);
    const roster = new ModelRoster({ registry: reg });
    const a = roster.resolve("some-ollama-model", "worker") as HttpInferenceAdapter;
    expect(a.registry).toBe(reg);
    expect(a.preferredToolArm).toBe("arm_b_json");
  });
});

describe("M9: tool arm selected by measurement", () => {
  it("picks the highest pass rate with enough trials, ties to the simpler arm", () => {
    const d = "2026-01-01";
    expect(
      selectArm({
        arm_a_flat: { passRate: 0.8, trials: 10, date: d },
        arm_b_json: { passRate: 0.9, trials: 10, date: d },
        arm_c_sketch: { passRate: 1, trials: 2, date: d },
      }),
    ).toBe("arm_b_json");
    expect(
      selectArm({
        arm_a_flat: { passRate: 0.9, trials: 10, date: d },
        arm_b_json: { passRate: 0.9, trials: 10, date: d },
      }),
    ).toBe("arm_a_flat");
    expect(selectArm({ arm_c_sketch: { passRate: 1, trials: 1, date: d } })).toBeUndefined();
  });
});

describe("M14: tier profiles", () => {
  it("maps memory budgets onto the design's S/M/L/XL table", () => {
    expect(tierForBudget(16 * GB).tier).toBe("S");
    expect(tierForBudget(24 * GB).tier).toBe("M");
    expect(tierForBudget(32 * GB).tier).toBe("M");
    expect(tierForBudget(64 * GB).tier).toBe("L");
    expect(tierForBudget(128 * GB).tier).toBe("XL");
    expect(tierForBudget(128 * GB).parallelCards).toEqual([2, 4]);
    expect(tierForBudget(24 * GB).coLoaded).toBe("no");
    expect(() => tierForBudget(8 * GB)).toThrow(UnsupportedHardwareError);
  });
});

describe("M15: throughput floors", () => {
  it("classifies measured speed and refuses below the overnight floor", () => {
    expect(throughputClass({ prefillTokensPerSecond: 350, decodeTokensPerSecond: 45 })).toBe(
      "recommended",
    );
    expect(throughputClass({ prefillTokensPerSecond: 120, decodeTokensPerSecond: 25 })).toBe(
      "interactive",
    );
    expect(throughputClass({ prefillTokensPerSecond: 60, decodeTokensPerSecond: 12 })).toBe(
      "overnight",
    );
    expect(throughputClass({ prefillTokensPerSecond: 60, decodeTokensPerSecond: 7 })).toBe(
      "below_floor",
    );
    expect(THROUGHPUT_FLOORS.overnight).toMatchObject({ prefill: 40, decode: 10 });
    expect(() =>
      assertThroughputFloor("slow", { prefillTokensPerSecond: 30, decodeTokensPerSecond: 7 }),
    ).toThrow(ThroughputFloorError);
    expect(() =>
      assertThroughputFloor("slow", { prefillTokensPerSecond: 30, decodeTokensPerSecond: 7 }),
    ).toThrow(/prefill 30.0 tok\/s < 40, decode 7.0 tok\/s < 10/);
    expect(() =>
      assertThroughputFloor("fast", { prefillTokensPerSecond: 90, decodeTokensPerSecond: 11 }),
    ).not.toThrow();
  });
});

/** An adapter whose server-reported speed is fixed. */
function speedAdapter(modelId: string, prefill: number, decode: number, window?: number) {
  const seen: InferenceRequest[] = [];
  const usage = (req: InferenceRequest): TokenUsage => ({
    promptTokens: Math.round(req.prompt.length / 4),
    completionTokens: req.maxTokens ?? 64,
    durationMs: 1,
    prefillTokensPerSecond: prefill,
    decodeTokensPerSecond: decode,
  });
  return {
    seen,
    adapter: {
      modelId,
      supportedArms: ["arm_a_flat" as const],
      ...(window ? { contextWindow: { contextTokens: window, maxTokens: 512 } } : {}),
      generate: async (req: InferenceRequest): Promise<InferenceResponse> => {
        seen.push(req);
        return { text: "OK", toolCalls: [], usage: usage(req) };
      },
    },
  };
}

describe("M13: hardware calibration", () => {
  it("measures each context bucket with a fresh prompt and skips buckets over the window", async () => {
    const { adapter, seen } = speedAdapter("w", 200, 30, 10_000);
    const cal = await calibrateModel(adapter, { buckets: [2048, 8192, 16384] });
    expect(Object.keys(cal.buckets)).toEqual(["2k", "8k"]);
    expect(cal.speed).toEqual({ prefillTokensPerSecond: 200, decodeTokensPerSecond: 30 });
    expect(cal.throughputClass).toBe("interactive");
    expect(seen[0]?.prompt).not.toBe(seen[1]?.prompt);
    expect(seen[1]?.prompt.length).toBeGreaterThan(8192 * 4 - 10);
  });

  it("writes the machine profile and registry throughput; the floor check reads it", async () => {
    const dir = tmp();
    const reg = new ModelRegistry(join(dir, "models.json"));
    const fast = speedAdapter("fast", 400, 45);
    const slow = speedAdapter("slow", 20, 4);
    let released = 0;
    const profile = await calibrateHardware({
      candidates: [
        { label: "fast", adapter: fast.adapter, release: async () => void released++ },
        { label: "slow", adapter: slow.adapter },
      ],
      usableBytes: 20 * GB,
      buckets: [2048],
      registry: reg,
      path: join(dir, "machine.json"),
    });
    expect(profile.tier).toBe("S");
    expect(profile.fingerprintHash).toBe(hostFingerprintHash());
    expect(released).toBe(1);
    expect(reg.get("fast")?.throughput?.["2k"]).toEqual({ prefill: 400, decode: 45 });
    const loaded = loadMachineProfile(join(dir, "machine.json"));
    expect(loaded?.models.slow?.throughputClass).toBe("below_floor");
    expect(needsRecalibration(loaded)).toBe(false);
    expect(needsRecalibration(undefined)).toBe(true);
    expect(() => assertModelRunnable(loaded, "slow")).toThrow(ThroughputFloorError);
    expect(() => assertModelRunnable(loaded, "fast")).not.toThrow();
    expect(() => assertModelRunnable(loaded, "never-measured")).not.toThrow();
  });
});

describe("M19: speculative decoding decided by measurement", () => {
  it("turns MTP off when it is slower (CHRONICLE: 21% slower on M4) and on when faster", () => {
    expect(
      decideSpeculative(
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 30 },
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 23.7 },
      ),
    ).toMatchObject({ enabled: false, speedup: 0.79 });
    expect(
      decideSpeculative(
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 20 },
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 36 },
      ),
    ).toMatchObject({ enabled: true, speedup: 1.8 });
    expect(
      decideSpeculative(
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 20 },
        { prefillTokensPerSecond: 100, decodeTokensPerSecond: 36 },
        { memoryHeadroomOk: false },
      ).enabled,
    ).toBe(false);
  });

  it("the managed adapter launches with the registry's decision for this host", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const verdict = await calibrateSpeculative({
      modelId: "mtp-model",
      plain: speedAdapter("mtp-model", 100, 30).adapter,
      speculative: speedAdapter("mtp-model", 100, 24).adapter,
      registry: reg,
    });
    expect(verdict.enabled).toBe(false);
    const a = new ManagedLlamaServerAdapter({
      modelId: "mtp-model",
      modelPath: "/m.gguf",
      mtp: true,
      registry: reg,
    });
    expect(a.launchArgs()).not.toContain("draft-mtp");
    // Without a measurement the profile decides.
    const b = new ManagedLlamaServerAdapter({ modelId: "other", modelPath: "/m.gguf", mtp: true });
    expect(b.launchArgs()).toContain("draft-mtp");
  });
});

describe("M24: engine selection by measurement", () => {
  it("weights cross-turn cache retention over raw decode speed", () => {
    const d = selectEngine([
      {
        engine: "mlx",
        speed: { prefillTokensPerSecond: 400, decodeTokensPerSecond: 45 },
        cacheRetention: 0.2,
      },
      {
        engine: "llama.cpp",
        speed: { prefillTokensPerSecond: 300, decodeTokensPerSecond: 35 },
        cacheRetention: 0.97,
      },
    ]);
    expect(d.engine).toBe("llama.cpp");
    expect(d.scores["llama.cpp"]).toBeLessThan(d.scores.mlx as number);
    expect(d.reason).toMatch(/per tool-result turn/);
  });

  it("disqualifies an engine under the qualification bar and defaults to llama.cpp", () => {
    const d = selectEngine(
      [
        {
          engine: "mlx",
          speed: { prefillTokensPerSecond: 900, decodeTokensPerSecond: 90 },
          cacheRetention: 0.99,
          qualificationPassRate: 0.5,
        },
      ],
      { promptTokens: 12000, replyTokens: 300, qualificationBar: 0.8 },
    );
    expect(d.engine).toBe("llama.cpp");
    expect(new MockInferenceAdapter("x")).toBeDefined();
  });
});
