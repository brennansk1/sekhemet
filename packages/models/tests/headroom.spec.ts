import { platform } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeHeadroomProbe,
  GPU_CEILING_SEED,
  HEADROOM_DEFAULTS,
  type MemoryReading,
  admitLoad,
  checkTransitions,
  coResidentMinBytes,
  createDarwinHeadroomProbe,
  gpuCeilingsFrom,
  isLargeModel,
  measureHeadroom,
  metalTimeoutCeiling,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const GiB = 1024 ** 3;
const GB = 1e9;
const MiB = 1024 ** 2;

/** The reference host at rest: 24 GiB, a 20,480 MB GPU wired limit, nothing loaded. */
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

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

describe("MD-N14-30: headroom is the lower of the GPU and system measures", () => {
  it("uses the GPU measure when it is the lower", () => {
    const r = reading({ metalInUseBytes: 8 * GiB });
    const h = measureHeadroom(r, { computeBufferBytes: 0.5 * GiB });
    // GPU: 20 GiB − 8 GiB − 1 GiB − 0.5 GiB = 10.5 GiB.
    expect(h.gpuBytes).toBe(10.5 * GiB);
    // System: 24 − (2 + 3 + 0.5) − 3 GB reserve − the harness peak.
    expect(h.systemBytes).toBe(
      24 * GiB -
        5.5 * GiB -
        HEADROOM_DEFAULTS.macosReserveBytes -
        HEADROOM_DEFAULTS.harnessPeakBytes,
    );
    expect(h.binding).toBe("gpu");
    expect(h.bytes).toBe(h.gpuBytes);
  });

  it("uses the system measure when it is the lower", () => {
    const h = measureHeadroom(reading({ anonymousBytes: 14 * GiB }), { computeBufferBytes: 0 });
    expect(h.binding).toBe("system");
    expect(h.bytes).toBe(h.systemBytes);
  });

  it("counts our servers by phys_footprint, whose mapped weights hide as file-backed", () => {
    const r = reading({
      processes: [
        { pid: 10, name: "llama-server", port: 8098, footprintBytes: 14 * GiB, ours: true },
      ],
    });
    const h = measureHeadroom(r, { computeBufferBytes: 0 });
    // wired + anonymous + compressor = 5.5 GiB, but our server alone holds 14 GiB.
    expect(h.systemUsedBytes).toBe(14 * GiB);
  });
});

describe("MD-N14-31: admission by footprint, both ratios and swap", () => {
  it("refuses naming the GPU measure when it projects 0.82 and the system 0.60", () => {
    const limit = 20480 * MiB;
    const footprint = 4 * GiB;
    const metal = 0.82 * limit - footprint;
    const total = 24 * GiB;
    // System projection (used + footprint) / total = 0.60.
    const used = 0.6 * total - footprint;
    const r = reading({
      gpuWiredLimitBytes: limit,
      metalInUseBytes: metal,
      wiredBytes: used / 2,
      anonymousBytes: used / 2,
      compressorBytes: 0,
    });
    const a = admitLoad({
      reading: r,
      candidate: { weights: "quick", footprintBytes: footprint, computeBufferBytes: 0 },
      resident: [],
      now: 0,
    });
    expect(a.verdict).toBe("refuse");
    if (a.verdict !== "refuse") return;
    expect(a.measure).toBe("gpu");
    expect(a.reason).toMatch(/GPU/);
    expect(a.reason).toMatch(/0\.82/);
  });

  it("admits a footprint that fits both measures under 0.80", () => {
    const a = admitLoad({
      reading: reading(),
      candidate: { weights: "worker", footprintBytes: 12 * GiB, computeBufferBytes: 0.5 * GiB },
      resident: [],
      now: 0,
    });
    expect(a.verdict).toBe("admit");
  });

  it("refuses while swap grew between the last two samples", () => {
    const a = admitLoad({
      reading: reading({ swapUsedBytes: 2 * GiB, previousSwapUsedBytes: 1 * GiB }),
      candidate: { weights: "w", footprintBytes: 2 * GiB },
      resident: [],
      now: 0,
    });
    expect(a.verdict === "refuse" && a.measure).toBe("swap");
  });

  it("refuses an unknown footprint", () => {
    const a = admitLoad({
      reading: reading(),
      candidate: { weights: "w", footprintBytes: undefined },
      resident: [],
      now: 0,
    });
    expect(a.verdict === "refuse" && a.measure).toBe("unknown_footprint");
  });
});

describe("MD-N14-32: the owner's processes are named, never unloaded; Ollama is waited out", () => {
  it("names Hermes on 8080 and its size in a refusal", () => {
    const r = reading({
      metalInUseBytes: 9 * GiB,
      anonymousBytes: 11 * GiB,
      processes: [{ pid: 77, name: "Hermes", port: 8080, footprintBytes: 9 * GB, ours: false }],
    });
    const a = admitLoad({
      reading: r,
      candidate: { weights: "worker", footprintBytes: 13 * GiB },
      resident: [],
      now: 0,
    });
    expect(a.verdict).toBe("refuse");
    if (a.verdict === "refuse") expect(a.reason).toContain("Hermes on 8080 holds 9.0 GB");
  });

  it("waits for Ollama's keep-alive expiry when that would free enough", () => {
    const r = reading({
      metalInUseBytes: 9 * GiB,
      anonymousBytes: 11 * GiB,
      processes: [
        {
          pid: 88,
          name: "Ollama (qwen3:8b)",
          port: 11434,
          footprintBytes: 9 * GiB,
          ours: false,
          expiresAt: 120_000,
        },
      ],
    });
    const a = admitLoad({
      reading: r,
      candidate: { weights: "worker", footprintBytes: 10 * GiB },
      resident: [],
      now: 60_000,
    });
    expect(a.verdict).toBe("wait");
    if (a.verdict === "wait") {
      expect(a.untilMs).toBe(120_000);
      expect(a.reason).toContain("Ollama");
    }
  });
});

describe("MD-N14-33: no two large models; small ones through admission", () => {
  it("a model is large at a quarter of the GPU wired limit", () => {
    expect(isLargeModel(5 * GiB, 20 * GiB)).toBe(true);
    expect(isLargeModel(4.9 * GiB, 20 * GiB)).toBe(false);
  });

  it("always refuses a second large model, whatever the headroom shows", () => {
    const roomy = reading({
      gpuWiredLimitBytes: 64 * GiB,
      totalBytes: 96 * GiB,
    });
    const a = admitLoad({
      reading: roomy,
      candidate: { weights: "seshat", footprintBytes: 20 * GiB },
      resident: [{ weights: "worker", footprintBytes: 16 * GiB }],
      now: 0,
      ceilings: [],
    });
    expect(a.verdict === "refuse" && a.measure).toBe("large_model");
  });

  it("admits a small model beside a large one when admission admits it", () => {
    const a = admitLoad({
      reading: reading({ metalInUseBytes: 9 * GiB }),
      candidate: { weights: "quick", footprintBytes: 2 * GiB, computeBufferBytes: 0.2 * GiB },
      resident: [{ weights: "worker", footprintBytes: 9 * GiB }],
      now: 0,
    });
    expect(a.verdict).toBe("admit");
  });

  it("replays the recorded Metal timeout: 11.8 GB + 3.85 GB becomes the ceiling", () => {
    const recorded = metalTimeoutCeiling([
      { weights: "target", footprintBytes: 11.8 * GB },
      { weights: "draft", footprintBytes: 3.85 * GB },
    ]);
    expect(recorded).toEqual({
      basis: "metal_timeout",
      bytes: 15.65 * GB,
      models: ["target", "draft"],
    });
    const ceilings = gpuCeilingsFrom([recorded]);
    const a = admitLoad({
      reading: reading({ gpuWiredLimitBytes: 64 * GiB, totalBytes: 96 * GiB }),
      candidate: { weights: "draft", footprintBytes: 3.85 * GB },
      resident: [{ weights: "target", footprintBytes: 11.8 * GB }],
      now: 0,
      ceilings,
    });
    expect(a.verdict === "refuse" && a.measure).toBe("gpu_ceiling");
    if (a.verdict === "refuse") {
      expect(a.reason).toContain("target");
      expect(a.reason).toContain("draft");
      expect(a.reason).toMatch(/15\.65 GB/);
    }
  });

  it("derives CO_RESIDENT_MIN_BYTES from measured footprints", () => {
    // Two largest footprints, projected at the 0.80 admission ratio, plus the reserves.
    const min = coResidentMinBytes([14.5 * GB, 9 * GB, 2 * GB]);
    expect(min).toBeCloseTo(
      (14.5 * GB + 9 * GB) / HEADROOM_DEFAULTS.admissionRatio +
        HEADROOM_DEFAULTS.macosReserveBytes +
        HEADROOM_DEFAULTS.harnessPeakBytes,
      -3,
    );
  });
});

describe("MD-N14-33a: the seeded GPU ceiling until calibration", () => {
  it("is the known-good maximum plus 0.5 GB: 15.0 GB", () => {
    expect(GPU_CEILING_SEED.bytes).toBe(15.0 * GB);
  });

  it("admits a 14.8 GB combination and refuses one at 15.2 GB, naming the seed", () => {
    const roomy = reading({ gpuWiredLimitBytes: 64 * GiB, totalBytes: 96 * GiB });
    const ok = admitLoad({
      reading: roomy,
      candidate: { weights: "quick", footprintBytes: 2.8 * GB },
      resident: [{ weights: "worker", footprintBytes: 12 * GB }],
      now: 0,
    });
    expect(ok.verdict).toBe("admit");
    const no = admitLoad({
      reading: roomy,
      candidate: { weights: "quick", footprintBytes: 3.2 * GB },
      resident: [{ weights: "worker", footprintBytes: 12 * GB }],
      now: 0,
    });
    expect(no.verdict === "refuse" && no.measure).toBe("gpu_ceiling");
    if (no.verdict === "refuse") expect(no.reason).toMatch(/seed/);
  });

  it("bounds a co-residence only: one model alone is bounded by the headroom", () => {
    const a = admitLoad({
      reading: reading({ gpuWiredLimitBytes: 64 * GiB, totalBytes: 96 * GiB }),
      candidate: { weights: "worker", footprintBytes: 16 * GB },
      resident: [],
      now: 0,
    });
    expect(a.verdict).toBe("admit");
  });

  it("a calibrated ceiling replaces the seed", () => {
    const ceilings = gpuCeilingsFrom([{ basis: "calibrated", bytes: 16 * GB }]);
    expect(ceilings.some((c) => c.basis === "seed")).toBe(false);
    const a = admitLoad({
      reading: reading({ gpuWiredLimitBytes: 64 * GiB, totalBytes: 96 * GiB }),
      candidate: { weights: "quick", footprintBytes: 3.2 * GB },
      resident: [{ weights: "worker", footprintBytes: 12 * GB }],
      now: 0,
      ceilings,
    });
    expect(a.verdict).toBe("admit");
  });
});

describe("MD-N14-31a: every transition of a tour is checked", () => {
  it("rejects a tour whose second load would sit beside the first model's unreleased KV", () => {
    const limit = 14 * GiB;
    const worker = { weights: 8 * GiB, kv: 3 * GiB, engine: 1 * GiB, promptCache: 0 };
    const seshat = { weights: 9 * GiB, kv: 2 * GiB, engine: 1 * GiB, promptCache: 0 };
    const result = checkTransitions({
      limitBytes: limit,
      resident: [{ id: "worker", ...worker }],
      steps: [
        // The Worker's weights go, but its KV is held until its slot save ends.
        { kind: "unload", id: "worker", keep: ["kv"] },
        { kind: "load", id: "seshat", ...seshat },
        { kind: "release", id: "worker" },
      ],
    });
    expect(result.feasible).toBe(false);
    expect(result.failedAt).toBe(1);
    // The end state alone (Seshat, 12 GiB) would have fitted.
    expect(result.endBytes).toBe(12 * GiB);
  });

  it("accepts the same tour when the KV is released first", () => {
    const result = checkTransitions({
      limitBytes: 16 * GiB,
      resident: [{ id: "worker", weights: 8 * GiB, kv: 3 * GiB, engine: 1 * GiB, promptCache: 0 }],
      steps: [
        { kind: "unload", id: "worker" },
        {
          kind: "load",
          id: "seshat",
          weights: 9 * GiB,
          kv: 2 * GiB,
          engine: 1 * GiB,
          promptCache: 0,
        },
        { kind: "restore", id: "seshat", kv: 1 * GiB },
      ],
    });
    expect(result.feasible).toBe(true);
    expect(result.peakBytes).toBe(13 * GiB);
  });
});

describe("the fake probe", () => {
  it("replays readings in order and repeats the last", async () => {
    const probe = new FakeHeadroomProbe([reading({ at: 1 }), reading({ at: 2 })]);
    expect((await probe.read()).at).toBe(1);
    expect((await probe.read()).at).toBe(2);
    expect((await probe.read()).at).toBe(2);
  });
});

describe("the Darwin probe over sysctl, vm_stat, ioreg, lsof and footprint", () => {
  const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                   321252.
Pages wired down:                             131072.
Anonymous pages:                              262144.
Pages occupied by compressor:                  65536.
`;
  const IOREG = `+-o AGXAcceleratorG16X  <class AGXAcceleratorG16X>
    "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=1375715328,"In use system memory"=2147483648}`;

  function exec(outputs: Record<string, string>) {
    const calls: string[] = [];
    const fn = (cmd: string, args: string[]) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      for (const [k, v] of Object.entries(outputs)) if (key.startsWith(k)) return v;
      throw new Error(`no output for ${key}`);
    };
    return { fn, calls };
  }

  it("parses each source and measures watched servers by pid", async () => {
    const ollama = await fakeServer(() => ({
      json: {
        models: [
          {
            name: "qwen3:8b",
            size: 6 * GiB,
            size_vram: 6 * GiB,
            expires_at: "2026-09-26T10:05:00Z",
          },
        ],
      },
    }));
    closers.push(ollama.close);
    const { fn, calls } = exec({
      "sysctl -n iogpu.wired_limit_mb": "20480\n",
      "sysctl -n hw.memsize": `${24 * GiB}\n`,
      "sysctl -n vm.swapusage": "total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n",
      vm_stat: VM_STAT,
      ioreg: IOREG,
      "lsof -nP -iTCP:8080": "4242\n",
      "lsof -nP -iTCP:8098": "",
      [`lsof -nP -iTCP:${ollama.port}`]: "5151\n",
      "footprint -p 4242": "Hermes [4242]: 64-bit    Footprint: 9216 MB (16384 bytes per page)\n",
    });
    const probe = createDarwinHeadroomProbe({
      exec: fn,
      now: () => 1000,
      watch: [
        { port: 8080, name: "Hermes", ours: false },
        { port: 8098, name: "llama-server", ours: true },
      ],
      ollamaUrl: ollama.url,
    });
    const r = await probe.read();
    expect(r.gpuWiredLimitBytes).toBe(20480 * MiB);
    expect(r.totalBytes).toBe(24 * GiB);
    expect(r.wiredBytes).toBe(131072 * 16384);
    expect(r.anonymousBytes).toBe(262144 * 16384);
    expect(r.compressorBytes).toBe(65536 * 16384);
    expect(r.metalInUseBytes).toBe(2147483648);
    expect(r.swapUsedBytes).toBe(512 * MiB);
    expect(r.processes).toContainEqual({
      pid: 4242,
      name: "Hermes",
      port: 8080,
      footprintBytes: 9216 * MiB,
      ours: false,
    });
    expect(r.processes.find((p) => p.port === 8098)).toBeUndefined();
    const o = r.processes.find((p) => p.name.startsWith("Ollama"));
    expect(o?.pid).toBe(5151);
    expect(o?.footprintBytes).toBe(6 * GiB);
    expect(o?.expiresAt).toBe(Date.parse("2026-09-26T10:05:00Z"));
    expect(calls.some((c) => c.includes("mlock") || c.includes("kill"))).toBe(false);
    // The second reading carries the first one's swap.
    const r2 = await probe.read();
    expect(r2.previousSwapUsedBytes).toBe(512 * MiB);
  });

  it.runIf(platform() === "darwin")("reads this Mac read-only (smoke)", async () => {
    const r = await createDarwinHeadroomProbe({ watch: [] }).read();
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(r.gpuWiredLimitBytes).toBeGreaterThan(0);
    expect(r.wiredBytes).toBeGreaterThan(0);
    expect(r.metalInUseBytes).toBeGreaterThanOrEqual(0);
    const h = measureHeadroom(r, { computeBufferBytes: 0.5 * GiB });
    expect(Number.isFinite(h.bytes)).toBe(true);
  });
});
