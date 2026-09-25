import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateSettings } from "../src/bakeoff.js";
import { MockInferenceAdapter } from "../src/mock_adapter.js";
import { QUALIFICATION_BAR } from "../src/qualification.js";
import type { QualificationCombination } from "../src/qualification_key.js";
import { ModelRegistry } from "../src/registry.js";

// models.md rule 27 / 27a, MD-N4-4, NEW-models-10: a person's recorded
// override lets a Worker that failed qualification run, for the exact
// combination that failed, and says so; the failure and the bar stay as
// they were. Nothing here loads a model.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sekhemet-override-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const combo = (engine = "llama.cpp b10809 (5266f24da)"): QualificationCombination => ({
  engine,
  modelBuild: "sampled-sha256:1111",
  host: "host-a",
  settings: {
    contextTokens: 16_384,
    kvType: "q8_0",
    speculative: "off",
    prefixCaching: true,
    parallelSlots: 1,
    chatTemplate: "tmpl-1",
    contextVersion: "ctx-1",
  },
});

const failed = {
  suiteVersion: "v1",
  passRate: 0.967,
  status: "failed" as const,
  reason: "tool-call checks failed (multi_step 50%)",
  byCategory: { schema_validity: 1, multi_step: 0.5, recall: 1 },
  toolCallChecks: false,
};
const by = { by: "person: Brennan Kelley", reason: "re-reads instead of editing; accepted" };
const at = () => new Date("2026-09-25T12:00:00.000Z");

describe("a recorded override of a failed qualification", () => {
  it("is refused when this combination was never measured, or did not fail", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"), at);
    expect(() => reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR)).toThrow(
      /no failed qualification of w for this combination/,
    );
    reg.recordCombinationQualification("w", combo(), { ...failed, status: "qualified" });
    expect(() => reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR)).toThrow(
      /qualified for this combination: nothing to override/,
    );
    // A failure on another combination is not this one's.
    reg.recordCombinationQualification("w", combo("llama.cpp unknown build"), failed);
    expect(() =>
      reg.recordQualificationOverride("v", combo("llama.cpp unknown build"), by, 0.9),
    ).toThrow(/no failed qualification of v/);
  });

  it("lets the exact failed combination run, naming who, when and what failed, and keeps the failure", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"), at);
    reg.recordCombinationQualification("w", combo(), failed);
    const o = reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR);
    expect(o).toMatchObject({
      by: "person: Brennan Kelley",
      reason: by.reason,
      date: "2026-09-25T12:00:00.000Z",
      failedChecks: ["multi_step 50%"],
    });
    const again = new ModelRegistry(join(dirs[0] as string, "models.json"), at);
    const look = again.lookupQualification("w", combo());
    expect(look.status).toBe("overridden");
    expect(look.reason).toBe(
      "qualified by override: person: Brennan Kelley, 2026-09-25: failed multi_step 50%",
    );
    expect(look.override).toMatchObject({
      by: "person: Brennan Kelley",
      failedChecks: ["multi_step 50%"],
    });
    // The recorded failure and the bar are untouched.
    expect(look.record).toMatchObject({ status: "failed", passRate: 0.967 });
    expect(again.isQualified("w", QUALIFICATION_BAR)).toBe(false);
  });

  it("is invalidated by any change to the combination, naming the element", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"), at);
    reg.recordCombinationQualification("w", combo(), failed);
    reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR);
    const look = reg.lookupQualification("w", combo("llama.cpp b10900 (0000000)"));
    expect(look.status).toBe("invalidated");
    expect(look.changed).toEqual(["engine"]);
    expect(look.reason).toMatch(/engine changed since the override by person: Brennan Kelley/);
  });

  it("does not come back for a later failure of the same combination (review major 1)", () => {
    let t = Date.parse("2026-09-25T12:00:00.000Z");
    const tick = () => {
      t += 1000;
      return new Date(t);
    };
    const reg = new ModelRegistry(join(tmp(), "models.json"), tick);
    reg.recordCombinationQualification("w", combo(), failed);
    reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR);
    expect(reg.lookupQualification("w", combo()).status).toBe("overridden");
    // Qualified again on the same combination, and failed again: the person
    // overrode the earlier failure, not this one.
    reg.recordCombinationQualification("w", combo(), failed);
    const look = reg.lookupQualification("w", combo());
    expect(look.status).toBe("failed");
    expect(look.override).toBeUndefined();
    // A pass in between, then a failure: still not the overridden failure.
    const reg2 = new ModelRegistry(join(tmp(), "models.json"), tick);
    reg2.recordCombinationQualification("w", combo(), failed);
    reg2.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR);
    reg2.recordCombinationQualification("w", combo(), { ...failed, status: "qualified" });
    reg2.recordCombinationQualification("w", combo(), failed);
    expect(reg2.lookupQualification("w", combo()).status).toBe("failed");
  });

  it("no longer applies once the combination qualifies on its own", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"), at);
    reg.recordCombinationQualification("w", combo(), failed);
    reg.recordQualificationOverride("w", combo(), by, QUALIFICATION_BAR);
    reg.recordCombinationQualification("w", combo(), {
      ...failed,
      status: "qualified",
      passRate: 1,
    });
    expect(reg.lookupQualification("w", combo()).status).toBe("qualified");
  });
});

describe("an adapter running under an override", () => {
  it("carries it into the candidate settings every evidence bundle records", () => {
    const a = new MockInferenceAdapter("w", []);
    expect(candidateSettings(a)).not.toHaveProperty("workerOverride");
    const override = {
      by: "person: Brennan Kelley",
      reason: "accepted",
      date: "2026-09-25T12:00:00.000Z",
      failedChecks: ["multi_step 50%"],
    };
    Object.assign(a, { workerOverride: override });
    expect(candidateSettings(a).workerOverride).toEqual(override);
  });
});
