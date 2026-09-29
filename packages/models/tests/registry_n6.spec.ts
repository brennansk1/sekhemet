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

const combo = (
  contextVersion: string,
  host = "h1",
  role?: QualificationCombination["settings"]["role"],
): QualificationCombination => ({
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
    ...(role ? { role } : {}),
  },
});
const pass = { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" as const };

describe("CX-N6-1: qualifications are kept per context version; a new version owes a re-qualification", () => {
  it("F23: a build with another version never invalidates the qualifications a running build uses", () => {
    const path = join(tmp(), "models.json");
    // Two builds share one registry file, each with its own instance.
    const older = new ModelRegistry(path);
    const newer = new ModelRegistry(path);
    older.recordCombinationQualification("worker", combo("v1"), pass);
    older.recordCombinationQualification("planner", combo("v1"), pass);
    older.recordCombinationQualification("failed-one", combo("v1"), {
      ...pass,
      status: "failed",
    });
    expect(older.observeContextVersion("v1")).toEqual([]);

    // The newer build runs: both qualified models owe a re-qualification
    // under its version, naming both versions; the failed one owes none.
    const owed = newer.observeContextVersion("v2");
    expect(owed.map((i) => i.modelId).sort()).toEqual(["planner", "worker"]);
    expect(owed[0]).toMatchObject({ version: "v2", role: "worker" });
    expect(owed[0]?.reason).toBe("context version changed (v1 -> v2)");

    // The older build, still running, keeps its qualification.
    expect(older.observeContextVersion("v1")).toEqual([]);
    expect(older.lookupQualification("worker", combo("v1")).status).toBe("qualified");
    expect(new ModelRegistry(path).lookupQualification("worker", combo("v1")).status).toBe(
      "qualified",
    );
    expect(older.pendingRequalifications({ version: "v1" })).toEqual([]);

    // The newer build has none: it is refused, naming both versions.
    const look = newer.lookupQualification("worker", combo("v2"));
    expect(look.status).toBe("invalidated");
    expect(look.changed).toEqual(["context version"]);
    expect(look.reason).toMatch(/context version v1 -> v2/);

    // Scheduled for the newer version, and the schedule survives a restart.
    const again = new ModelRegistry(path);
    expect(
      again
        .pendingRequalifications({ version: "v2" })
        .map((p) => p.modelId)
        .sort(),
    ).toEqual(["planner", "worker"]);
    // Observing the same version again schedules nothing twice.
    expect(again.observeContextVersion("v2")).toEqual([]);
    expect(again.pendingRequalifications({ version: "v2" })).toHaveLength(2);

    // Re-qualifying under the new version clears that model's entry.
    again.recordCombinationQualification("worker", combo("v2"), pass);
    expect(again.pendingRequalifications({ version: "v2" }).map((p) => p.modelId)).toEqual([
      "planner",
    ]);
    // Both builds now run: each version's record decides for its own build.
    expect(again.lookupQualification("worker", combo("v1")).status).toBe("qualified");
    expect(again.lookupQualification("worker", combo("v2")).status).toBe("qualified");
    // An upgrade back to v1 owes nothing: v1's qualification was never touched.
    expect(again.observeContextVersion("v1")).toEqual([]);
  });

  it("the owed list is read without writing, and matches what observing schedules", () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    reg.recordCombinationQualification("worker", combo("v1"), pass);
    const before = readFileSync(path, "utf8");
    expect(reg.requalificationsOwed("v2").map((o) => o.modelId)).toEqual(["worker"]);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(reg.observeContextVersion("v2").map((o) => o.modelId)).toEqual(["worker"]);
  });

  it("names the version of the newest qualified record, not the first key recorded", () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    reg.recordCombinationQualification("worker", combo("v1"), pass);
    reg.recordCombinationQualification("worker", combo("v0"), pass);
    // v1 qualified again, last: the owed entry names v1, the newest.
    reg.recordCombinationQualification("worker", combo("v1"), pass);
    expect(reg.requalificationsOwed("v2")[0]?.reason).toBe("context version changed (v1 -> v2)");
  });

  it("F24: each role's qualification depends on its own version, and only its own", () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    reg.recordCombinationQualification("coder", combo("w1"), pass);
    reg.recordCombinationQualification("critic", combo("r1", "h1", "reviewer"), pass);

    // A new Review model version owes the Review model's qualification only.
    expect(reg.observeContextVersion("r2", "reviewer").map((o) => o.modelId)).toEqual(["critic"]);
    expect(reg.observeContextVersion("w1", "worker")).toEqual([]);
    expect(reg.lookupQualification("coder", combo("w1")).status).toBe("qualified");
    expect(reg.pendingRequalifications({ role: "worker", version: "w1" })).toEqual([]);
    expect(reg.pendingRequalifications({ role: "reviewer", version: "r2" })).toEqual([
      expect.objectContaining({ modelId: "critic", role: "reviewer" }),
    ]);

    // A model verified only as the Coding model is missing for another role,
    // not "changed": the nearest record is looked for within the role.
    const other = reg.lookupQualification("coder", combo("r2", "h1", "reviewer"));
    expect(other.status).toBe("missing");
    // A Coding model qualification in another role's version is not scheduled for it.
    expect(reg.requalificationsOwed("r2", "reviewer").map((o) => o.modelId)).toEqual(["critic"]);

    // Qualifying the Review model under its new version clears its entry only.
    reg.recordCombinationQualification("critic", combo("r2", "h1", "reviewer"), pass);
    expect(reg.pendingRequalifications({ role: "reviewer", version: "r2" })).toEqual([]);
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
