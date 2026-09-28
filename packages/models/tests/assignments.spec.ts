import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssignmentRefusal,
  type BakeOffEvidence,
  ModelRegistry,
  assignRole,
  currentAssignment,
  restoreRole,
} from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const registry = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-assign-"));
  dirs.push(d);
  return new ModelRegistry(join(d, "models.json"));
};

const HOST = "host-a";
const bakeOff = (over: Partial<BakeOffEvidence> = {}): BakeOffEvidence => ({
  id: "ev_1",
  host: HOST,
  role: "worker",
  model: "qwen-next",
  tier: "overnight",
  evaluationSet: "frozen-suite",
  date: "2026-09-25",
  ...over,
});

describe("NEW-models-10: the baseline and defaults change by measurement; a person's choice is theirs", () => {
  it("MD-N10-3: a person assigns a model qualified on this host, with no benchmark, leaving the baseline and defaults", () => {
    const reg = registry();
    assignRole(reg, {
      role: "worker",
      model: "cyber-tiel",
      scope: "default",
      by: "harness",
      host: HOST,
      qualification: "qualified",
      firstRun: true,
    });
    assignRole(reg, {
      role: "worker",
      model: "cyber-tiel",
      scope: "baseline",
      by: "harness",
      host: HOST,
      qualification: "qualified",
      firstRun: true,
    });
    const mine = assignRole(reg, {
      role: "worker",
      model: "qwen-next",
      scope: "personal",
      by: "person: Brennan",
      host: HOST,
      qualification: "qualified",
    });
    expect(mine.assignment).toMatchObject({ model: "qwen-next", by: "person: Brennan" });
    expect(currentAssignment(reg, HOST, "worker")?.model).toBe("qwen-next");
    expect(currentAssignment(reg, HOST, "worker", "baseline")?.model).toBe("cyber-tiel");
    expect(currentAssignment(reg, HOST, "worker", "default")?.model).toBe("cyber-tiel");
  });

  it("MD-N10-3: an unqualified model is refused, naming the missing qualification; a Worker override applies", () => {
    const reg = registry();
    expect(() =>
      assignRole(reg, {
        role: "reviewer",
        model: "gemma-x",
        scope: "personal",
        by: "person: Brennan",
        host: HOST,
        qualification: "missing",
      }),
    ).toThrow(
      /gemma-x is not verified on this machine for the Review model \(missing\).*sekhemet qualify/,
    );
    expect(() =>
      assignRole(reg, {
        role: "reviewer",
        model: "gemma-x",
        scope: "personal",
        by: "person: Brennan",
        host: HOST,
        qualification: "overridden",
      }),
    ).toThrow(AssignmentRefusal);
    expect(
      assignRole(reg, {
        role: "worker",
        model: "failed-but-overridden",
        scope: "personal",
        by: "person: Brennan",
        host: HOST,
        qualification: "overridden",
      }).assignment.model,
    ).toBe("failed-but-overridden");
  });

  it("MD-N10-1: the baseline or a shipped default changes only with a recorded bake-off on this host", () => {
    const reg = registry();
    const base = {
      role: "worker" as const,
      model: "qwen-next",
      by: "person: Brennan",
      host: HOST,
      qualification: "qualified" as const,
    };
    assignRole(reg, { ...base, model: "cyber-tiel", scope: "baseline", firstRun: true });
    expect(() => assignRole(reg, { ...base, scope: "baseline" })).toThrow(
      /requires a recorded bake-off on this host.*frozen-suite/,
    );
    expect(() =>
      assignRole(reg, { ...base, scope: "baseline", bakeOff: bakeOff({ tier: "quick" }) }),
    ).toThrow(/a quick-benchmark score does not satisfy it/);
    expect(() =>
      assignRole(reg, { ...base, scope: "baseline", bakeOff: bakeOff({ host: "host-b" }) }),
    ).toThrow(/on another host/);
    expect(() =>
      assignRole(reg, {
        ...base,
        scope: "baseline",
        bakeOff: bakeOff({ evaluationSet: "research-golden-set" }),
      }),
    ).toThrow(/frozen-suite/);
    expect(() =>
      assignRole(reg, { ...base, scope: "default", bakeOff: bakeOff({ model: "other" }) }),
    ).toThrow(/measured other/);
    const ok = assignRole(reg, { ...base, scope: "baseline", bakeOff: bakeOff() });
    expect(ok.assignment).toMatchObject({ model: "qwen-next", bakeOff: "ev_1" });
    expect(ok.previous?.model).toBe("cyber-tiel");
    // The Planner's full evaluation set is the planning measure.
    expect(() =>
      assignRole(reg, {
        ...base,
        role: "planner",
        scope: "default",
        bakeOff: bakeOff({ role: "planner", evaluationSet: "frozen-suite" }),
      }),
    ).toThrow(/planning-measure/);
  });

  it("MD-N10-2: a replaced assignment is restored in one step, and survives a restart", () => {
    const reg = registry();
    const input = {
      role: "researcher" as const,
      scope: "personal" as const,
      by: "person: Brennan",
      host: HOST,
      qualification: "qualified" as const,
    };
    assignRole(reg, { ...input, model: "apodex" });
    assignRole(reg, { ...input, model: "spark-x" });
    const again = new ModelRegistry(reg.path);
    const restored = restoreRole(again, HOST, "researcher", { by: "person: Brennan" });
    expect(restored.assignment.model).toBe("apodex");
    expect(restored.replaced?.model).toBe("spark-x");
    expect(currentAssignment(new ModelRegistry(reg.path), HOST, "researcher")?.model).toBe(
      "apodex",
    );
    expect(() => restoreRole(registry(), HOST, "planner", { by: "p" })).toThrow(
      /no earlier planner assignment/,
    );
  });
});

describe("MD-N4-9: the Reviewer is of another family than the Worker", () => {
  it("records the managed defaults' families, and refuses a Reviewer of the Worker's family naming both", async () => {
    const { ModelRoster } = await import("../src/index.js");
    const reg = registry();
    const roster = new ModelRoster({ registry: reg, machineProfile: null });
    const worker = roster.resolve("cyber-tiel", "worker");
    const planner = roster.resolve("qwen3.8-27b", "planner");
    expect(reg.get(worker.modelId)?.family).toBe("qwen");
    expect(reg.get(planner.modelId)?.family).toBe("qwen");
    const input = {
      role: "reviewer" as const,
      scope: "personal" as const,
      by: "person: Brennan",
      host: HOST,
      qualification: "qualified" as const,
    };
    expect(() =>
      assignRole(reg, {
        ...input,
        model: "qwen-reviewer",
        families: { model: "qwen", worker: "qwen" },
      }),
    ).toThrow(/qwen-reviewer is of the qwen family, the Coding model's \(qwen\)/);
    expect(
      assignRole(reg, { ...input, model: "gemma-r", families: { model: "gemma", worker: "qwen" } })
        .assignment.model,
    ).toBe("gemma-r");
  });
});

describe("MD-N4-9: the Reviewer is recorded unfilled when no other family qualifies here", () => {
  const combo = (host: string) => ({
    engine: "ollama",
    modelBuild: "b",
    host,
    settings: {
      contextTokens: 8192,
      kvType: "q8_0",
      speculative: "off" as const,
      prefixCaching: true,
      parallelSlots: 1,
      chatTemplate: "t",
      contextVersion: "v",
    },
  });
  const pass = { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" as const };

  it("records unfilled, and fills it once a model of another family qualifies on this host", async () => {
    const { fillReviewerDefault, UNFILLED } = await import("../src/index.js");
    const reg = registry();
    reg.upsert("qwen-a", { family: "qwen" });
    reg.recordCombinationQualification("qwen-a", combo(HOST), pass);
    reg.upsert("gemma-elsewhere", { family: "gemma" });
    reg.recordCombinationQualification("gemma-elsewhere", combo("another-host"), pass);
    expect(fillReviewerDefault(reg, HOST, "qwen")).toMatchObject({ model: UNFILLED });
    expect(currentAssignment(reg, HOST, "reviewer")?.model).toBe(UNFILLED);
    reg.upsert("gemma-r", { family: "gemma" });
    reg.recordCombinationQualification("gemma-r", combo(HOST), pass);
    expect(fillReviewerDefault(reg, HOST, "qwen")).toMatchObject({
      model: "gemma-r",
      scope: "default",
    });
    // Once filled, nothing changes until it is replaced.
    expect(fillReviewerDefault(reg, HOST, "qwen")).toMatchObject({ model: "gemma-r" });
    expect(reg.roleAssignments(HOST).filter((a) => a.role === "reviewer")).toHaveLength(2);
  });
});
