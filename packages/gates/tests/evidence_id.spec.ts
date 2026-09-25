import { describe, expect, it } from "vitest";
import { type CompileEvidenceParams, compileEvidence } from "../src/evidence.js";

// security.md SEC-51 (the part B3.1 builds): the evidence bundle id covers the
// bundle's structural record — gate outcomes, stop reason, settings, the
// gates.toml hash — not only card, attempt and diff; the excerpts, which are
// erasable, are outside it, so erasing one leaves the id unchanged.

const base = (): CompileEvidenceParams => ({
  cardId: "c",
  attempt: 1,
  diff: "diff --git a/a.ts b/a.ts\n+x\n",
  filesTouched: ["a.ts"],
  linesAdded: 1,
  linesRemoved: 0,
  gateResult: {
    passed: true,
    failures: [],
    durationMs: 5,
    rungResults: [
      { gate: "test", rung: 2, layer: "unit", passed: true, exitCode: 0, durationMs: 5 },
    ] as never,
  },
  turnsUsed: 3,
  stopReason: "gate_passed",
  checkpointShas: ["abc"],
  tokens: { promptTokens: 1, completionTokens: 1 },
  durationMs: 10,
  settings: { modelId: "m", toolArm: "A" },
  gatesConfigSha256: "g1",
});

describe("the evidence bundle id (SEC-51)", () => {
  it("is deterministic for the same record", () => {
    expect(compileEvidence(base()).id).toBe(compileEvidence(base()).id);
    expect(compileEvidence(base()).id).toMatch(/^ev_[0-9a-f]+$/);
  });

  it("covers the gate outcomes, the stop reason, the settings and the gates.toml hash", () => {
    const id = compileEvidence(base()).id;
    const failed = base();
    failed.gateResult = {
      ...failed.gateResult,
      passed: false,
      rungResults: [
        { gate: "test", rung: 2, layer: "unit", passed: false, exitCode: 1, durationMs: 5 },
      ] as never,
    };
    expect(compileEvidence(failed).id).not.toBe(id);
    expect(compileEvidence({ ...base(), stopReason: "repair_exhausted" }).id).not.toBe(id);
    expect(
      compileEvidence({ ...base(), settings: { modelId: "other", toolArm: "A" } }).id,
    ).not.toBe(id);
    expect(compileEvidence({ ...base(), gatesConfigSha256: "g2" }).id).not.toBe(id);
  });

  it("leaves the excerpts out, so erasing one leaves the id unchanged", () => {
    const withExcerpt = base();
    withExcerpt.gateResult = {
      ...withExcerpt.gateResult,
      failures: [{ gate: "test", message: "AWS_SECRET=abc123 leaked in output" }] as never,
    };
    const erased = base();
    erased.gateResult = {
      ...erased.gateResult,
      failures: [{ gate: "test", message: "[erased]" }] as never,
    };
    expect(compileEvidence(withExcerpt).id).toBe(compileEvidence(erased).id);
  });
});
