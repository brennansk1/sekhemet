import { ROLE_ANSWER_TOKENS, charsForTokens } from "@sekhemet/context";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { maskOldEvidence, researcherEvidenceChars } from "../src/research/researcher.js";

// CX-N3-3, context rule 10c: the Researcher's prompt has a budget from its
// own window, through the allocator's role budget, and never exceeds it.

const model = (contextTokens: number) =>
  ({ modelId: "r", contextWindow: { contextTokens, maxTokens: 1200 } }) as LocalInferenceAdapter;

describe("the Researcher's budget", () => {
  it("is the window less the Researcher's answer cap, the margin and the fixed prompt", () => {
    const fixed = "x".repeat(6400); // 2,000 tokens
    expect(researcherEvidenceChars(model(16_384), fixed)).toBe(
      charsForTokens(16_384 - ROLE_ANSWER_TOKENS.researcher - 256 - 2000),
    );
    // A window too small for the fixed prompt leaves nothing, not a negative budget.
    expect(researcherEvidenceChars(model(1000), fixed)).toBe(0);
  });

  it("cuts the newest round too when it alone is over the budget", () => {
    const rounds = ["a".repeat(5000), "b".repeat(50_000)];
    const out = maskOldEvidence(rounds, 10_000);
    expect(out.join("").length).toBeLessThanOrEqual(10_000);
    expect(out[1]).toMatch(/^b+/);
    expect(out[1]).toMatch(/cut to fit the Researcher's window/);
  });
});
