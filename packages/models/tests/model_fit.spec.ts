import { describe, expect, it } from "vitest";
import type { FoundModel } from "../src/library_types.js";
import {
  ROLE_SETTINGS,
  applyFits,
  fitFor,
  kvBytes,
  kvBytesPerElement,
  memoryBreakdown,
} from "../src/model_fit.js";

// MD-N12-3, models rule 4b, DB-NM14-2: weights + KV at the role's context and
// KV type + the engine's buffers, against the live headroom; nothing loaded.

const GB = 1e9;
const shape = { layers: 40, kvHeads: 8, keyLength: 128, valueLength: 128 };

function model(name: string, sizeBytes: number, extra: Partial<FoundModel> = {}): FoundModel {
  return {
    id: name,
    name,
    file: `${name}.gguf`,
    folder: "/models",
    sizeBytes,
    quantisation: "Q4_K_M",
    contextLength: 131072,
    fits: {},
    fitReason: {},
    path: `/models/${name}.gguf`,
    format: "gguf",
    hash: "pending",
    metadata: { shape },
    ...extra,
  };
}

const host = (headroom: number, extra = {}) => ({
  headroom: { value: headroom, grade: "measured" as const },
  ...extra,
});

describe("KV bytes (rule 10)", () => {
  it("scales with context and the KV type", () => {
    expect(kvBytesPerElement("f16")).toBe(2);
    expect(kvBytesPerElement("q8_0")).toBeCloseTo(34 / 32);
    expect(kvBytesPerElement("q4_0")).toBeCloseTo(18 / 32);
    // 40 layers × 8 heads × (128 + 128) × 2 bytes × 16384 tokens.
    expect(kvBytes(shape, 16384, "f16")).toBe(40 * 8 * 256 * 2 * 16384);
    expect(kvBytes(shape, 32768, "f16")).toBe(2 * kvBytes(shape, 16384, "f16"));
    expect(kvBytes(shape, 16384, "q8_0")).toBeLessThan(kvBytes(shape, 16384, "f16"));
  });
});

describe("fitFor (MD-N12-3)", () => {
  it("labels a model that fits with its numbers in words", () => {
    const v = fitFor(model("small", 4 * GB), "worker", host(16 * GB));
    expect(v.fits).toBe("yes");
    expect(v.reason).toMatch(/GB of 16\.0 GB usable/);
    expect(v.requiredBytes.grade).toBe("estimated");
    expect(v.breakdown?.weightsBytes).toBe(4 * GB);
    expect(v.breakdown?.contextTokens).toBe(ROLE_SETTINGS.worker.contextTokens);
    expect(v.breakdown?.kvType).toBe("q8_0");
    expect(v.headroomBytes.value).toBeGreaterThan(0);
  });

  it("labels a model too large as Needs N GB, with the shortfall", () => {
    const v = fitFor(model("huge", 30 * GB), "worker", host(16 * GB));
    expect(v.fits).toBe("no");
    expect(v.headroomBytes.value).toBeLessThan(0);
    expect(v.reason).toMatch(/^Needs \d+(\.\d)? GB more/);
  });

  it("labels a model that fits alone but not beside the resident roles as swaps, with the swap time", () => {
    const v = fitFor(
      model("mid", 10 * GB),
      "reviewer",
      host(4 * GB, {
        resident: [{ name: "the Worker", footprintBytes: 13 * GB, ours: true }],
        swapSeconds: () => ({ value: 312, grade: "measured" as const }),
      }),
    );
    expect(v.fits).toBe("swaps");
    expect(v.reason).toMatch(/swaps with the Worker/);
    expect(v.swapSeconds).toEqual({ value: 312, grade: "measured" });
  });

  it("refuses above the GPU ceiling even when the headroom reads larger (rule 20g)", () => {
    const v = fitFor(
      model("dense", 15.5 * GB),
      "planner",
      host(40 * GB, { gpuCeilingBytes: 15e9 }),
    );
    expect(v.fits).toBe("no");
    expect(v.reason).toMatch(/GPU ceiling/);
  });

  it("a second large model always swaps, whatever the headroom (rule 22)", () => {
    const v = fitFor(
      model("large", 8 * GB),
      "planner",
      host(40 * GB, {
        gpuWiredLimitBytes: 16 * GB,
        resident: [{ name: "the Worker", footprintBytes: 13 * GB, ours: true }],
      }),
    );
    expect(v.fits).toBe("swaps");
  });
});

describe("memoryBreakdown's what-if (DB-NM14-2)", () => {
  it("recomputes KV for another context and KV type, and loads nothing", () => {
    const m = model("m", 5 * GB);
    const a = memoryBreakdown(m, { contextTokens: 8192, kvType: "q8_0" });
    const b = memoryBreakdown(m, { contextTokens: 32768, kvType: "q8_0" });
    const c = memoryBreakdown(m, { contextTokens: 32768, kvType: "f16" });
    expect(b.kvBytes.value).toBeCloseTo(4 * a.kvBytes.value, -2);
    expect(c.kvBytes.value).toBeGreaterThan(b.kvBytes.value);
    expect(a.weightsBytes).toEqual({ value: 5 * GB, grade: "file" });
    expect(a.kvBytes.grade).toBe("estimated");
    expect(a.computeBufferBytes.grade).toBe("design");
    expect(a.totalBytes.value).toBe(
      a.weightsBytes.value +
        a.kvBytes.value +
        a.computeBufferBytes.value +
        a.promptCacheBytes.value,
    );
  });

  it("marks the KV unknown when the header has no attention shape", () => {
    const m = model("no-shape", 5 * GB, { metadata: {} });
    const a = memoryBreakdown(m, { contextTokens: 8192, kvType: "q8_0" });
    expect(a.kvBytes.grade).toBe("design");
    expect(a.kvBytes.value).toBeGreaterThan(0);
  });
});

describe("applyFits", () => {
  it("fills fits and fitReason for every role, a model that does not fit included", () => {
    const [a, b] = applyFits([model("a", 4 * GB), model("b", 40 * GB)], host(16 * GB));
    expect(Object.keys(a?.fits ?? {}).sort()).toEqual(
      ["planner", "researcher", "reviewer", "vision", "worker"].sort(),
    );
    expect(a?.fits.worker).toBe("yes");
    expect(b?.fits.worker).toBe("no");
    expect(b?.fitReason.worker).toMatch(/Needs/);
    expect(b?.fit?.worker?.fits).toBe("no");
  });
});
