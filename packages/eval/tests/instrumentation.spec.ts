import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { InstrumentedAdapter } from "../src/instrumentation.js";

// MS-M9-2: a wrapped adapter is the same adapter to the session: every
// property it reads passes through, and cached prompt tokens are metered.

describe("InstrumentedAdapter (MS-M9-2)", () => {
  const inner = {
    modelId: "w",
    supportedArms: ["arm_a_flat", "arm_b_json"],
    contextWindow: { contextTokens: 16_384, maxTokens: 4_096 },
    nativeTools: true,
    preferredToolArm: "arm_b_json",
    healthCheck: async () => ({
      ok: true,
      modelId: "w",
      reachable: true,
      loaded: true,
      latencyMs: 1,
    }),
    unload: async () => undefined,
    async generate(_req: InferenceRequest) {
      return {
        text: "",
        toolCalls: [],
        usage: { promptTokens: 100, completionTokens: 10, durationMs: 5, cachedPromptTokens: 80 },
      };
    },
  } as unknown as LocalInferenceAdapter & { unload: () => Promise<void> };

  it("exposes contextWindow, nativeTools and preferredToolArm unchanged", () => {
    const a = new InstrumentedAdapter(inner);
    expect(a.contextWindow).toEqual({ contextTokens: 16_384, maxTokens: 4_096 });
    expect(a.nativeTools).toBe(true);
    expect(a.preferredToolArm).toBe("arm_b_json");
    expect(a.supportedArms).toEqual(["arm_a_flat", "arm_b_json"]);
  });

  it("forwards the health check and unload", async () => {
    const a = new InstrumentedAdapter(inner) as InstrumentedAdapter & {
      unload?: () => Promise<void>;
    };
    expect((await a.healthCheck?.())?.ok).toBe(true);
    expect(typeof a.unload).toBe("function");
  });

  it("meters cached prompt tokens", async () => {
    const a = new InstrumentedAdapter(inner);
    await a.generate({ prompt: "x", toolArm: "arm_a_flat" });
    await a.generate({ prompt: "y", toolArm: "arm_a_flat" });
    expect(a.promptTokens).toBe(200);
    expect(a.cachedPromptTokens).toBe(160);
  });

  it("leaves a property the inner adapter lacks undefined", () => {
    const bare = {
      modelId: "b",
      supportedArms: ["arm_a_flat"],
      generate: inner.generate,
    } as unknown as LocalInferenceAdapter;
    const a = new InstrumentedAdapter(bare);
    expect(a.contextWindow).toBeUndefined();
    expect(a.nativeTools).toBeUndefined();
  });
});
