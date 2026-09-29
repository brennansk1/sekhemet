import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedLlamaServerAdapter, ModelRegistry } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type CombinationDeps, gateWorker, qualificationCombination } from "../src/qualify.js";

// CX-N6-1: the context version gates qualification. Nothing here loads a model.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const deps = (version: string, others = "other-1"): CombinationDeps => ({
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b7000 (abc1234)",
  host: () => "host-a",
  // Each role's own prompt version (CX-N6-4): the Coding model's is `version`.
  contextVersion: (role) => (role === "worker" ? version : `${role}-${others}`),
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sek-qual-n6-"));
  dirs.push(dir);
  const path = join(dir, "models.json");
  const worker = (reg: ModelRegistry) =>
    new ManagedLlamaServerAdapter({
      modelId: "cyber-tiel-mtp",
      modelPath: "/models/cyber.gguf",
      contextTokens: 16_384,
      registry: reg,
      thinkingPolicy: "off",
    });
  return { path, worker };
}

describe("CX-N6-1: qualifications per context version, seen where the Worker is gated", () => {
  it("F23: a build with a new version is refused and owes a re-qualification; a build running the old one keeps running", () => {
    const { path, worker } = setup();
    // Two builds on one host share the registry file.
    const olderReg = new ModelRegistry(path);
    const newerReg = new ModelRegistry(path);
    const older = worker(olderReg);
    const newer = worker(newerReg);
    olderReg.recordCombinationQualification(
      older.modelId,
      qualificationCombination(older, { ...deps("ctx-1"), registry: olderReg }),
      { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
    );
    expect(gateWorker(olderReg, older, "cyber-tiel", deps("ctx-1")).refusal).toBeUndefined();

    // The newer build is refused, naming both versions and how to verify it.
    const refused = gateWorker(newerReg, newer, "cyber-tiel", deps("ctx-2"));
    expect(refused.refusal).toMatch(/context version ctx-1 -> ctx-2/);
    expect(refused.refusal).toMatch(/sekhemet qualify --models cyber-tiel$/);
    expect(newerReg.pendingRequalifications({ version: "ctx-2", role: "worker" })).toEqual([
      expect.objectContaining({
        modelId: "cyber-tiel-mtp",
        reason: "context version changed (ctx-1 -> ctx-2)",
      }),
    ]);

    // The older build, mid-run, is still allowed: nothing was invalidated.
    expect(gateWorker(olderReg, older, "cyber-tiel", deps("ctx-1")).refusal).toBeUndefined();
    expect(
      new ModelRegistry(path).lookupQualification(
        older.modelId,
        qualificationCombination(older, { ...deps("ctx-1"), registry: olderReg }),
      ).status,
    ).toBe("qualified");
    expect(olderReg.pendingRequalifications({ version: "ctx-1" })).toEqual([]);
  });

  it("F24: another role's new prompt version leaves the Coding model qualified", () => {
    const { path, worker } = setup();
    const reg = new ModelRegistry(path);
    const a = worker(reg);
    reg.recordCombinationQualification(
      a.modelId,
      qualificationCombination(a, { ...deps("ctx-1", "1"), registry: reg }),
      { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
    );
    // Seshat's and the Review model's prompts changed; the Coding model's did not.
    expect(gateWorker(reg, a, "cyber-tiel", deps("ctx-1", "2")).refusal).toBeUndefined();
    expect(reg.pendingRequalifications()).toEqual([]);

    // A combination for another role carries that role and its own version.
    const review = qualificationCombination(a, {
      ...deps("ctx-1", "2"),
      registry: reg,
      role: "reviewer",
    });
    expect(review.settings).toMatchObject({ role: "reviewer", contextVersion: "reviewer-2" });
    expect(qualificationCombination(a, { ...deps("ctx-1"), registry: reg }).settings.role).toBe(
      undefined,
    );
    expect(reg.lookupQualification(a.modelId, review).status).toBe("missing");
  });
});
