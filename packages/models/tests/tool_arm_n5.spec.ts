import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  MIN_ARM_TRIALS,
  MockInferenceAdapter,
  ModelRegistry,
  armLeadInterval,
  candidateSettings,
  qualifyModel,
  selectArm,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-arm-"));
  dirs.push(d);
  return d;
};
const d = "2026-09-25";
const m = (validCalls: number, trials: number) => ({
  passRate: validCalls / trials,
  trials,
  toolCallValidity: validCalls / trials,
  validCalls,
  date: d,
});

describe("NEW-models-5: tool-arm qualification", () => {
  it("MD-N5-1: pins the winner only with enough trials on all three arms and a 5-point lead whose interval excludes zero", () => {
    expect(MIN_ARM_TRIALS).toBe(5);
    // A clear lead on many trials: pinned.
    expect(
      selectArm({ arm_a_flat: m(95, 100), arm_b_json: m(70, 100), arm_c_sketch: m(60, 100) }),
    ).toBe("arm_a_flat");
    // A 5-point lead whose interval includes zero: not pinned.
    expect(
      selectArm({ arm_a_flat: m(9, 10), arm_b_json: m(8, 10), arm_c_sketch: m(1, 10) }),
    ).toBeUndefined();
    // A lead under 5 points, however many trials: not pinned.
    expect(
      selectArm({ arm_a_flat: m(960, 1000), arm_b_json: m(930, 1000), arm_c_sketch: m(0, 1000) }),
    ).toBeUndefined();
    // Too few trials on one arm: not pinned.
    expect(
      selectArm({ arm_a_flat: m(95, 100), arm_b_json: m(1, 4), arm_c_sketch: m(60, 100) }),
    ).toBeUndefined();
    // An arm not measured at all: not pinned.
    expect(selectArm({ arm_a_flat: m(95, 100), arm_b_json: m(10, 100) })).toBeUndefined();
    const lead = armLeadInterval(m(95, 100), m(70, 100));
    expect(lead.difference).toBeCloseTo(0.25, 5);
    expect(lead.low).toBeGreaterThan(0);
    expect(armLeadInterval(m(9, 10), m(8, 10)).low).toBeLessThan(0);
  });

  it("MD-N5-1: qualify scores arms A, B and C on the same tasks and records each arm's validity, pass rate and trials", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const seen = new Map<string, string[]>();
    const model = new MockInferenceAdapter("m", [], { exhaustion: "default" });
    const original = model.generate.bind(model);
    model.generate = async (req) => {
      seen.set(req.toolArm, [...(seen.get(req.toolArm) ?? []), req.prompt]);
      return original(req);
    };
    const { results } = await qualifyModel(model, { registry: reg });
    expect(results.map((r) => r.arm)).toEqual(["arm_a_flat", "arm_b_json", "arm_c_sketch"]);
    expect(seen.get("arm_b_json")).toEqual(seen.get("arm_a_flat"));
    expect(seen.get("arm_c_sketch")).toEqual(seen.get("arm_a_flat"));
    const recorded = reg.get("m")?.armMeasurements;
    for (const arm of ["arm_a_flat", "arm_b_json", "arm_c_sketch"] as const) {
      expect(recorded?.[arm]?.trials).toBe(results[0]?.cases.length);
      expect(recorded?.[arm]?.toolCallValidity).toBeTypeOf("number");
      expect(recorded?.[arm]?.passRate).toBeTypeOf("number");
    }
    // Nothing leads: nothing pinned, and a card says the arm was not measured.
    expect(reg.armFor("m")).toBeUndefined();
  });

  it("MD-N5-2: a card run with an unmeasured arm records it so in the evidence settings", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = new HttpInferenceAdapter({ modelId: "x", registry: reg });
    expect(candidateSettings(a)).toMatchObject({ toolArm: "arm_a_flat", toolArmMeasured: false });
    reg.recordArmMeasurement("x", "arm_a_flat", 0.95, 100, 95);
    reg.recordArmMeasurement("x", "arm_b_json", 0.6, 100, 60);
    reg.recordArmMeasurement("x", "arm_c_sketch", 0.5, 100, 50);
    expect(candidateSettings(a)).toMatchObject({ toolArm: "arm_a_flat", toolArmMeasured: true });
  });
});
