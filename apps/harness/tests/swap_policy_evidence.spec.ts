import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SWAP_POLICY, swapPolicyParams } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { buildReproRecord } from "../src/repro.js";

// Models MD-N14-40: every card's evidence records the swap policy's version
// and every parameter of `SwapPolicyParams`, with or without a RunProfile.

const model = {
  modelId: "fake",
  supportedArms: ["arm_a_flat" as const],
  generate: async () => ({
    text: "",
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
  }),
};

describe("MD-N14-40: the swap policy in a card's evidence", () => {
  it("records the default policy when the run resolved no RunProfile", () => {
    const r = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: mkdtempSync(join(tmpdir(), "swap-evidence-")),
      gatesSha: "g",
    });
    expect(r.swapPolicy).toEqual(DEFAULT_SWAP_POLICY);
  });

  it("records the policy the scheduler ran under", () => {
    const policy = swapPolicyParams({ maxWaitS: 900 });
    const r = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: mkdtempSync(join(tmpdir(), "swap-evidence-")),
      gatesSha: "g",
      swapPolicy: policy,
    });
    expect(r.swapPolicy).toMatchObject({ version: "smart-swap/1", capsMs: { worker: 900_000 } });
  });
});
