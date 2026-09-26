import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRegistry, type QualificationCombination } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "sek-reg-n6-"));
  dirs.push(d);
  return d;
}

const combo = (contextVersion: string, host = "h1"): QualificationCombination => ({
  engine: "llama.cpp b1",
  modelBuild: "digest",
  host,
  settings: {
    contextTokens: 16_384,
    kvType: "q8_0",
    speculative: "off",
    prefixCaching: true,
    parallelSlots: 1,
    chatTemplate: "t",
    contextVersion,
  },
});
const pass = { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" as const };

describe("CX-N6-1: a new context version invalidates qualifications and schedules re-qualification", () => {
  it("marks every model qualified under the old version invalidated, naming both versions", () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    reg.recordCombinationQualification("worker", combo("v1"), pass);
    reg.recordCombinationQualification("planner", combo("v1"), pass);
    reg.recordCombinationQualification("failed-one", combo("v1"), {
      ...pass,
      status: "failed",
    });
    // The first version seen is recorded; nothing is invalidated by it.
    expect(reg.observeContextVersion("v1")).toEqual([]);
    expect(reg.lookupQualification("worker", combo("v1")).status).toBe("qualified");

    const invalidated = reg.observeContextVersion("v2");
    expect(invalidated.map((i) => i.modelId).sort()).toEqual(["planner", "worker"]);
    const look = reg.lookupQualification("worker", combo("v1"));
    expect(look.status).toBe("invalidated");
    expect(look.reason).toMatch(/context version changed \(v1 -> v2\)/);
    expect(reg.get("worker")?.qualification?.status).toBe("invalidated");
    // Scheduled, and the schedule survives a restart.
    const again = new ModelRegistry(path);
    expect(
      again
        .pendingRequalifications()
        .map((p) => p.modelId)
        .sort(),
    ).toEqual(["planner", "worker"]);
    expect(again.pendingRequalifications()[0]?.reason).toMatch(/v1 -> v2/);
    // Observing the same version again changes nothing.
    expect(again.observeContextVersion("v2")).toEqual([]);

    // Re-qualifying under the new version clears that model's entry.
    again.recordCombinationQualification("worker", combo("v2"), pass);
    expect(again.pendingRequalifications().map((p) => p.modelId)).toEqual(["planner"]);
  });

  it("MD-N4-5: a write keeps entries another process wrote since this one read", () => {
    const path = join(tmp(), "models.json");
    const a = new ModelRegistry(path);
    const b = new ModelRegistry(path);
    a.upsert("from-a", { family: "qwen" });
    b.upsert("from-b", { family: "gemma" });
    a.upsert("from-a", { quant: "IQ3_XXS" });
    const saved = JSON.parse(readFileSync(path, "utf8")) as { models: { id: string }[] };
    expect(saved.models.map((m) => m.id).sort()).toEqual(["from-a", "from-b"]);
    expect(new ModelRegistry(path).get("from-a")).toMatchObject({
      family: "qwen",
      quant: "IQ3_XXS",
    });
  });
});
