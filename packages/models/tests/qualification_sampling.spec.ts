import { describe, expect, it } from "vitest";
import { HttpInferenceAdapter } from "../src/http_adapter.js";
import {
  QUALIFICATION_SAMPLES,
  QUALIFICATION_SUITE_VERSION,
  type QualificationCase,
  exactInterval,
  qualifyModel,
  runQualification,
  samplingSettingsOf,
} from "../src/qualification.js";
import {
  type QualificationCombination,
  changedCombinationElements,
  combinationKey,
  describeCombination,
} from "../src/qualification_key.js";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "../src/types.js";

// Models rule 27a, MD-N8-1: the combination qualified is the one that runs,
// so the suite runs at the role's own sampling, k samples a case, and the
// sampling is part of the combination.

const usage = { promptTokens: 1, completionTokens: 1, durationMs: 1 };

/** One case: passes when the reply calls `read_file`. */
const CASE: QualificationCase = {
  id: "reads",
  category: "multi_step",
  prompt: "Read src/a.ts.",
  score: (calls: ToolCall[]) => (calls[0]?.name === "read_file" ? undefined : "no read"),
};

/** A fake adapter whose n-th reply passes when `passes(n)`, recording each request. */
function scripted(passes: (n: number) => boolean) {
  const seen: InferenceRequest[] = [];
  const adapter: LocalInferenceAdapter = {
    modelId: "worker",
    supportedArms: ["arm_a_flat"],
    generate: async (req) => {
      seen.push(req);
      const n = seen.length;
      return {
        text: "",
        toolCalls: passes(n)
          ? [{ id: `c${n}`, name: "read_file", arguments: { path: "src/a.ts" } }]
          : [],
        usage,
      };
    },
  };
  return { adapter, seen };
}

describe("qualification at the role's own sampling (MD-N8-1)", () => {
  it("sends no temperature of its own, so the adapter's sampling applies", async () => {
    const { adapter, seen } = scripted(() => true);
    await runQualification(adapter, { cases: [CASE] });
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) expect(req.temperature).toBeUndefined();
  });

  it("uses an explicit sampling only when a measurement arm passes one", async () => {
    const { adapter, seen } = scripted(() => true);
    await runQualification(adapter, { cases: [CASE], sampling: { temperature: 0 } });
    for (const req of seen) expect(req.temperature).toBe(0);
  });

  it("reads the Worker's sampling from its adapter", () => {
    const adapter = new HttpInferenceAdapter({
      modelId: "cyber-tiel",
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0, repeatPenalty: 1 },
    });
    expect(samplingSettingsOf(adapter)).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
    });
    expect(samplingSettingsOf(scripted(() => true).adapter)).toBeUndefined();
  });
});

describe("k samples a case, and the interval beside the rate", () => {
  it("runs each case QUALIFICATION_SAMPLES times, fixed at 5", async () => {
    expect(QUALIFICATION_SAMPLES).toBe(5);
    const { adapter, seen } = scripted(() => true);
    const r = await runQualification(adapter, { cases: [CASE, { ...CASE, id: "reads2" }] });
    expect(seen).toHaveLength(2 * 5);
    expect(r.cases).toHaveLength(2 * 5);
    expect(r.samples).toBe(5);
  });

  it("scores a check as its pass rate over every sample, with the exact interval", async () => {
    // Four of five samples pass: 80%, at the bar on the point rate.
    const { adapter } = scripted((n) => n !== 3);
    const r = await runQualification(adapter, { cases: [CASE] });
    expect(r.byCategory.multi_step).toBe(0.8);
    const ci = r.intervals.multi_step;
    expect(ci?.low).toBeCloseTo(0.2836, 3);
    expect(ci?.high).toBeCloseTo(0.9949, 3);
  });

  it("computes the exact Clopper–Pearson interval", () => {
    expect(exactInterval(0, 10).low).toBe(0);
    expect(exactInterval(0, 10).high).toBeCloseTo(0.3085, 3);
    expect(exactInterval(10, 10).high).toBe(1);
    expect(exactInterval(10, 10).low).toBeCloseTo(0.6915, 3);
    expect(exactInterval(5, 10).low).toBeCloseTo(0.1871, 3);
    expect(exactInterval(5, 10).high).toBeCloseTo(0.8129, 3);
  });

  it("bumps the suite version: q1.2 qualifies at the role's sampling, k = 5", () => {
    expect(QUALIFICATION_SUITE_VERSION).toBe("q1.2");
  });
});

describe("sampling in the combination (MD-N8-4)", () => {
  const combo = (sampling?: QualificationCombination["settings"]["sampling"]) =>
    ({
      engine: "llama.cpp b7000",
      modelBuild: "sha:abc",
      host: "host",
      settings: {
        contextTokens: 32_768,
        kvType: "q8_0",
        speculative: "off",
        prefixCaching: true,
        parallelSlots: 1,
        chatTemplate: "unpinned",
        contextVersion: "v1",
        ...(sampling ? { sampling } : {}),
      },
    }) as QualificationCombination;
  const agentic = { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 };

  it("keys on the sampling and names it when it changes", () => {
    expect(combinationKey(combo(agentic))).not.toBe(combinationKey(combo()));
    expect(combinationKey(combo({ ...agentic, temperature: 0 }))).not.toBe(
      combinationKey(combo(agentic)),
    );
    expect(changedCombinationElements(combo(agentic), combo({ ...agentic, topK: 40 }))).toEqual([
      "sampling",
    ]);
    // A record made greedy, before sampling was keyed, is not the sampled one.
    expect(changedCombinationElements(combo(), combo(agentic))).toEqual(["sampling"]);
    expect(describeCombination(combo(agentic))).toContain(
      "temperature 0.6, top_p 0.95, top_k 20, min_p 0",
    );
  });

  it("records the sampling the run used in the qualified combination when the caller left it out", async () => {
    const recorded: QualificationCombination[] = [];
    const registry = {
      recordArmMeasurement: () => undefined,
      recordCombinationQualification: (_id: string, c: QualificationCombination) => {
        recorded.push(c);
      },
      recordSpeculative: () => undefined,
    };
    const adapter = new HttpInferenceAdapter({ modelId: "cyber-tiel", sampling: agentic });
    (adapter as { generate: LocalInferenceAdapter["generate"] }).generate = async () => ({
      text: "",
      toolCalls: [{ id: "c", name: "read_file", arguments: { path: "src/a.ts" } }],
      usage,
    });
    await qualifyModel(adapter, {
      arms: ["arm_a_flat"],
      cases: [CASE],
      combination: combo(),
      registry: registry as unknown as Parameters<typeof qualifyModel>[1]["registry"],
    });
    expect(recorded[0]?.settings.sampling).toEqual(agentic);
  });
});
