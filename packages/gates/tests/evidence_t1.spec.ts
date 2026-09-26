import { describe, expect, it } from "vitest";
import { NO_GATES_CONFIG } from "../src/config.js";
import { type CompileEvidenceParams, compileEvidence, summarizeEvidence } from "../src/evidence.js";

// GT-T1-8: every field of rule 35, including unavailable gates with reasons,
// artifacts and abandoned hypotheses (possibly empty lists). GT-T1-10: no
// gates.toml is said so.

const base: CompileEvidenceParams = {
  cardId: "c1",
  attempt: 1,
  diff: "",
  filesTouched: [],
  linesAdded: 0,
  linesRemoved: 0,
  gateResult: {
    passed: false,
    durationMs: 1,
    failures: [],
    rungResults: [
      { gate: "unit", rung: "test", layer: "functional", passed: true, exitCode: 0, durationMs: 1 },
      {
        gate: "osv",
        rung: "security",
        layer: "security",
        passed: false,
        exitCode: -1,
        durationMs: 1,
        unavailable: true,
        reason: "osv-scanner exited 0 with no report",
      },
      {
        gate: "semgrep",
        rung: "security",
        layer: "security",
        passed: false,
        exitCode: -1,
        durationMs: 0,
        skipped: true,
        reason: "semgrep is not installed",
      },
    ],
  },
  turnsUsed: 1,
  stopReason: "done_pending_gates",
  checkpointShas: [],
  tokens: { promptTokens: 0, completionTokens: 0 },
  durationMs: 1,
  settings: { modelId: "m", toolArm: "a" },
  gatesConfigSha256: "abc",
};

describe("the evidence bundle under one pipeline (T1)", () => {
  it("GT-T1-8: lists unavailable gates with reasons, and always carries artifacts and abandoned hypotheses", () => {
    const e = compileEvidence(base);
    expect(e.unavailable).toEqual([{ gate: "osv", reason: "osv-scanner exited 0 with no report" }]);
    expect(e.skipped).toEqual([{ gate: "semgrep", reason: "semgrep is not installed" }]);
    expect(e.artifacts).toEqual([]);
    expect(e.abandoned).toEqual([]);
    expect(e.advisories).toEqual([]);
  });

  it("GT-T1-8: keeps the artifacts and abandoned hypotheses it is given", () => {
    const e = compileEvidence({
      ...base,
      artifacts: [{ kind: "test-output", ref: "blob:1" }],
      abandoned: ["tried a Map; the test wants insertion order"],
    });
    expect(e.artifacts).toEqual([{ kind: "test-output", ref: "blob:1" }]);
    expect(e.abandoned).toEqual(["tried a Map; the test wants insertion order"]);
  });

  it("GT-T1-8: the summary shows an unavailable gate as not run, never as passed", () => {
    const text = summarizeEvidence(compileEvidence(base));
    expect(text).toMatch(/UNAVAILABLE osv/);
    expect(text).not.toMatch(/PASS osv/);
  });

  it("GT-T1-10: a run on the defaults says 'no gates.toml'", () => {
    const e = compileEvidence({ ...base, gatesConfigSha256: NO_GATES_CONFIG });
    expect(e.gatesConfigSha256).toBe("no gates.toml");
    expect(summarizeEvidence(e)).toContain("gates.toml: none (defaults ran)");
  });
});
