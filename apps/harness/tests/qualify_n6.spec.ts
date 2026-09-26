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

const deps = (version: string): CombinationDeps => ({
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b7000 (abc1234)",
  host: () => "host-a",
  contextVersion: () => version,
});

describe("CX-N6-1: a new context version, seen where the Worker is gated", () => {
  it("invalidates the qualification with both versions and schedules its re-qualification", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-qual-n6-"));
    dirs.push(dir);
    const reg = new ModelRegistry(join(dir, "models.json"));
    const worker = new ManagedLlamaServerAdapter({
      modelId: "cyber-tiel-mtp",
      modelPath: "/models/cyber.gguf",
      contextTokens: 16_384,
      registry: reg,
      thinkingPolicy: "off",
    });
    reg.recordCombinationQualification(
      worker.modelId,
      qualificationCombination(worker, { ...deps("ctx-1"), registry: reg }),
      { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
    );
    expect(gateWorker(reg, worker, "cyber-tiel", deps("ctx-1")).refusal).toBeUndefined();

    const refused = gateWorker(reg, worker, "cyber-tiel", deps("ctx-2"));
    expect(refused.refusal).toMatch(/context version/);
    expect(reg.pendingRequalifications()).toEqual([
      expect.objectContaining({
        modelId: "cyber-tiel-mtp",
        reason: "context version changed (ctx-1 -> ctx-2)",
      }),
    ]);
    // The old combination is invalidated too, not only unmatched.
    expect(
      reg.lookupQualification(
        worker.modelId,
        qualificationCombination(worker, { ...deps("ctx-1"), registry: reg }),
      ).status,
    ).toBe("invalidated");
  });
});
