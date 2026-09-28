import { describe, expect, it } from "vitest";
import { type QualificationCase, runQualification } from "../src/qualification.js";
import type { InferenceResponse, LocalInferenceAdapter, ToolCall } from "../src/types.js";

// Models rule 27 (compliance C6): a reply that is not a response — no usage,
// no tool-call list — fails its case like a request that failed; it never
// stops the whole check, so the model is still scored (the B4.7 sweep found
// Verify on this machine answering "could not run" instead of a score).

const CASE: QualificationCase = {
  id: "reads",
  category: "multi_step",
  prompt: "Read src/a.ts.",
  score: (calls: ToolCall[]) => (calls[0]?.name === "read_file" ? undefined : "no read"),
};

function answering(reply: unknown): LocalInferenceAdapter {
  return {
    modelId: "odd",
    supportedArms: ["arm_a_flat"],
    generate: async () => reply as InferenceResponse,
  };
}

describe("a malformed reply fails its case, never the whole qualification (rule 27)", () => {
  it("scores a bare-text reply as a failed case with its reason", async () => {
    const r = await runQualification(answering("I cannot help with that."), {
      cases: [CASE],
      samples: 2,
    });
    expect(r.passRate).toBe(0);
    expect(r.cases).toHaveLength(2);
    expect(r.cases.every((c) => !c.passed && !c.schemaValid)).toBe(true);
    expect(r.cases[0]?.detail).toMatch(/not a response/);
    expect(r.speed.decodeTokensPerSecond).toBe(0);
  });

  it("scores a reply without usage by its tool calls, leaving it out of the speed", async () => {
    const r = await runQualification(
      answering({
        text: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }],
      }),
      { cases: [CASE], samples: 1 },
    );
    expect(r.cases[0]?.passed).toBe(true);
    expect(r.speed.medianCaseMs).toBe(0);
  });
});
