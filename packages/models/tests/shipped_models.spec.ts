import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MODEL_SOURCES, tableSource } from "../src/hf_lookup.js";
import {
  GENERIC_ROLE_WINDOWS,
  createCyberTielWorker,
  genericManagedPort,
} from "../src/llama_server.js";
import { ModelRegistry } from "../src/registry.js";
import { ModelRoster } from "../src/roster.js";
import {
  MEASUREMENT_BASELINE,
  SHIPPED_ENGINE_FLOOR,
  SHIPPED_MODELS,
  SHIPPED_REVIEW_PORT,
  SHIPPED_ROLE_PORTS,
  SUPPORTED_HARDWARE,
  codingModelWindowTokens,
  recommendedSetPlan,
  shippedAdapter,
  shippedModel,
  shippedRoleOf,
  supportedTierFor,
} from "../src/shipped_models.js";

// models rules 3, 4 and 8a, NEW-models-22 (DEC-47 O-5): the shipped set is
// one table; every filled row was verified (the hub's tree API and model
// card, cross-checked against the reference host's copy); the Review role is
// unfilled and says why; the download sources are derived from it.

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("the shipped set (rule 3, DEC-47 O-5)", () => {
  it("is nail-mtp for Coding, Qwen3.8-27B GSQ-RCO for Planning, Apodex mini for Research, Review unfilled", () => {
    expect(SHIPPED_MODELS.map((m) => [m.role, m.id])).toEqual([
      ["coding", "nail-mtp"],
      ["planning", "qwen3.8-27b-gsq-rco"],
      ["research", "apodex-1.1-mini"],
      ["review", undefined],
    ]);
    const review = shippedModel("review");
    expect(review.source).toBeUndefined();
    expect(review.note).toMatch(/RG-P8-13/);
    expect(review.candidates).toEqual(["gpt-oss-20b", "glm-4.7-flash", "gemma-4-26b-a4b"]);
    expect(review.candidates).not.toContain("mistral-small3.2");
  });

  it("carries, for every filled row, the verified repository, file, SHA-256, size, SPDX licence, family and engine floor (MD-N22-1)", () => {
    expect(shippedModel("coding").source).toEqual({
      repo: "peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP",
      file: "Nail-Qwen3.6-35B-A3B-MTP-UD-IQ3_XXS.gguf",
      sha256: "6275d06c6e1b0d0a4e07a69a5fbdc719dbaeaae87bc48e6c8377f4cd58ec369c",
      sizeBytes: 14_069_275_872,
      license: "Apache-2.0",
    });
    expect(shippedModel("planning").source).toEqual({
      repo: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
      file: "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
      sha256: "58fd826723939933dc86f45b7fe04545cbc2de1c70f6fe2cdd3858c87a98c12f",
      sizeBytes: 12_120_016_960,
      license: "Apache-2.0",
    });
    expect(shippedModel("research").source).toEqual({
      repo: "abenzerps/Apodex-1.1-mini-GGUF",
      file: "Apodex-1.1-mini-IQ3_M.gguf",
      sha256: "8620c43276492c59be49269b0cce52ca4f6698c73154751274fa73eb831fb38a",
      sizeBytes: 16_022_990_656,
      license: "Apache-2.0",
    });
    for (const m of SHIPPED_MODELS.filter((r) => r.id)) {
      expect(m.family).toBe("qwen");
      expect(m.source?.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The engine floor: the build each qualification recorded; unset, and said, for one not yet qualified.
    expect(shippedModel("coding").minLlamaBuild).toBe(10809);
    expect(shippedModel("planning").minLlamaBuild).toBe(10809);
    expect(shippedModel("research").minLlamaBuild).toBeUndefined();
    expect(shippedModel("research").qualified).toBe(false);
    expect(shippedModel("research").note).toMatch(/Not yet verified/);
    expect(SHIPPED_ENGINE_FLOOR).toBe(10809);
  });

  it("keeps Cyber-Tiel as the measurement baseline, not a shipped role (DEC-04)", () => {
    expect(MEASUREMENT_BASELINE.map((m) => m.id)).toEqual([createCyberTielWorker().modelId]);
    expect(SHIPPED_MODELS.map((m) => m.id)).not.toContain(createCyberTielWorker().modelId);
    expect(MEASUREMENT_BASELINE[0]?.source?.license).toBe("MIT");
  });

  it("derives the download sources from that table: every filled row and the baseline, nothing else (rule 4)", () => {
    const expected = [...SHIPPED_MODELS, ...MEASUREMENT_BASELINE].filter((m) => m.source);
    expect(Object.keys(MODEL_SOURCES).sort()).toEqual(expected.map((m) => m.id).sort());
    for (const m of expected) {
      expect(MODEL_SOURCES[m.id as string]).toEqual({
        repo: m.source?.repo,
        file: m.source?.file,
        sha256: m.source?.sha256,
        sizeBytes: m.source?.sizeBytes,
      });
      expect(tableSource(m.id as string)?.url).toBe(
        `https://huggingface.co/${m.source?.repo}/resolve/main/${m.source?.file}`,
      );
    }
  });

  it("reads a role in the product's words or the roster's", () => {
    expect(shippedRoleOf("coding")).toBe("coding");
    expect(shippedRoleOf("Worker")).toBe("coding");
    expect(shippedRoleOf("planner")).toBe("planning");
    expect(shippedRoleOf("researcher")).toBe("research");
    expect(shippedRoleOf("review")).toBe("review");
    expect(shippedRoleOf("vision")).toBeUndefined();
  });
});

describe("supported hardware (rule 8a, MD-N22-2)", () => {
  it("supports 24 GB and above, the same set on every supported tier, and nothing below", () => {
    expect(SUPPORTED_HARDWARE.map((t) => [t.tier, t.supported])).toEqual([
      ["S", false],
      ["M", true],
      ["L", true],
      ["XL", true],
    ]);
    expect(SUPPORTED_HARDWARE.find((t) => t.tier === "S")?.set).toEqual([]);
    for (const t of SUPPORTED_HARDWARE.filter((x) => x.supported))
      expect(t.set).toEqual(["coding", "planning", "research"]);
    const gib = 1024 ** 3;
    expect(supportedTierFor(16 * gib).tier).toBe("S");
    expect(supportedTierFor(24 * gib).tier).toBe("M");
    // Linux reports MemTotal below the installed size (memory the kernel and
    // firmware keep): a 24 GB machine reads about 23.4 GiB and is still M.
    expect(supportedTierFor(23.4 * gib).tier).toBe("M");
    expect(supportedTierFor(22 * gib).tier).toBe("S");
    expect(supportedTierFor(36 * gib).tier).toBe("M");
    expect(supportedTierFor(64 * gib).tier).toBe("L");
    expect(supportedTierFor(128 * gib).tier).toBe("XL");
    expect(supportedTierFor(512 * gib).tier).toBe("XL");
  });
});

describe("recommendedSetPlan (MD-N18-3, MD-N22-3)", () => {
  it("gives each filled role's file, size and licence, the total, and the unfilled role with its reason", () => {
    const plan = recommendedSetPlan({
      registry: new ModelRegistry(join(mkdtempSync(join(tmpdir(), "sek-plan-")), "m.json")),
    });
    expect(plan.models.map((m) => [m.role, m.id, m.license, m.present])).toEqual([
      ["coding", "nail-mtp", "Apache-2.0", false],
      ["planning", "qwen3.8-27b-gsq-rco", "Apache-2.0", false],
      ["research", "apodex-1.1-mini", "Apache-2.0", false],
    ]);
    expect(plan.totalBytes).toBe(14_069_275_872 + 12_120_016_960 + 16_022_990_656);
    expect(plan.licenses).toEqual(["Apache-2.0"]);
    expect(plan.unfilled).toEqual([{ role: "review", reason: shippedModel("review").note }]);
  });

  it("counts only what is not already here, and the size of the source the download will use", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-plan-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "m.json"));
    const have = join(dir, "nail.gguf");
    writeFileSync(have, "x");
    registry.recordWeights("nail-mtp", { path: have, volume: "internal", sha256: "a".repeat(64) });
    registry.recordSource("apodex-1.1-mini", {
      url: "http://127.0.0.1:1/o/r/resolve/main/a.gguf",
      host: "127.0.0.1",
      sha256: "b".repeat(64),
      sizeBytes: 1234,
    });
    const plan = recommendedSetPlan({ registry });
    expect(plan.models.find((m) => m.role === "coding")?.present).toBe(true);
    expect(plan.models.find((m) => m.role === "research")?.sizeBytes).toBe(1234);
    expect(plan.totalBytes).toBe(12_120_016_960 + 1234);
  });
});

describe("the shipped profile and the Coding model's window (MD-N4-10)", () => {
  it("builds each filled role's launch from its row, with the weights where they are named", () => {
    const coding = shippedAdapter(shippedModel("coding"), { modelPath: "/models/n.gguf" });
    expect(coding.launchProfile.modelId).toBe("nail-mtp");
    expect(coding.launchArgs().slice(0, 2)).toEqual(["-m", "/models/n.gguf"]);
    expect(coding.totalContextTokens()).toBe(GENERIC_ROLE_WINDOWS.worker.contextTokens);
    const research = shippedAdapter(shippedModel("research"), {
      modelPath: "/models/a.gguf",
      totalBytes: 64 * 1024 ** 3,
    });
    expect(research.launchProfile.modelId).toBe("apodex-1.1-mini");
    expect(research.slotCount()).toBe(2);
    expect(() => shippedAdapter(shippedModel("review"), { modelPath: "/x" })).toThrow(/unfilled/);
  });

  it("gives each shipped role its own port: the generic hash puts the Coding and Planning models on one", () => {
    // The defect this avoids: co-resident roles cannot share a port (rule 26a).
    expect(genericManagedPort("nail-mtp")).toBe(genericManagedPort("qwen3.8-27b-gsq-rco"));
    const ports = SHIPPED_MODELS.filter((m) => m.id).map(
      (m) => shippedAdapter(m, { modelPath: `/models/${m.source?.file}` }).launchProfile.port,
    );
    expect(ports).toEqual([
      SHIPPED_ROLE_PORTS.coding,
      SHIPPED_ROLE_PORTS.planning,
      SHIPPED_ROLE_PORTS.research,
    ]);
    expect(new Set(ports).size).toBe(3);
  });

  it("reads the window of the Coding model this host assigned, else the shipped Coding model's", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-win-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "m.json"));
    expect(codingModelWindowTokens({ registry, host: "h1" })).toBe(16_384);
    registry.upsert("small-coder", { header: { contextLength: 8192 } });
    registry.recordRoleAssignment("h1", {
      role: "worker",
      model: "small-coder",
      scope: "personal",
      by: "p",
      date: "2026-10-04T00:00:00Z",
    });
    expect(codingModelWindowTokens({ registry, host: "h1" })).toBe(8192);
    registry.upsert("small-coder", { contextWindow: 12_000 });
    expect(codingModelWindowTokens({ registry, host: "h1" })).toBe(12_000);
    // Another host's assignment is not this one's.
    expect(codingModelWindowTokens({ registry, host: "h2" })).toBe(16_384);
  });
});

/**
 * B1-C3 review: the roster resolves a registered shipped id at the window
 * its caller asks for, as it did when every registered GGUF went through the
 * generic profile. ModelAccess resolves the Planning model's weights once, at
 * the largest window its queues need — escalation's, for a card sized for
 * the Coding model's window.
 */
describe("a shipped id resolved with a wanted window (ResolveOptions)", () => {
  it("honours the window for the Planning model, on its role's port", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-want-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "m.json"));
    const weights = join(dir, "q.gguf");
    writeFileSync(weights, "x");
    registry.recordWeights("qwen3.8-27b-gsq-rco", {
      path: weights,
      volume: "internal",
      sha256: "c".repeat(64),
    });
    const roster = new ModelRoster({ registry });
    const a = roster.resolve("qwen3.8-27b-gsq-rco", "planner", {
      contextTokens: 12_288,
      maxTokens: 3072,
    }) as unknown as { launchProfile: { contextTokens: number; maxTokens: number; port: number } };
    expect(a.launchProfile.contextTokens).toBe(12_288);
    expect(a.launchProfile.maxTokens).toBe(3072);
    expect(a.launchProfile.port).toBe(SHIPPED_ROLE_PORTS.planning);
  });

  it("without a wanted window, the role's own", () => {
    const a = shippedAdapter(shippedModel("planning"), { modelPath: "/models/q.gguf" });
    expect(a.launchProfile.contextTokens).toBe(GENERIC_ROLE_WINDOWS.planner.contextTokens);
  });
});

/**
 * C4 (C3's review minor): a shipped id assigned to another role runs at that
 * role's window and on that role's port, not its shipped role's: nail-mtp as
 * the Planning model had kept the Coding window (16,384) and port (8098).
 */
describe("a shipped id serving another role", () => {
  it("takes the role's window and port in the shipped profile", () => {
    const asPlanner = shippedAdapter(shippedModel("coding"), {
      modelPath: "/models/n.gguf",
      role: "planning",
    });
    expect(asPlanner.launchProfile.modelId).toBe("nail-mtp");
    expect(asPlanner.totalContextTokens()).toBe(GENERIC_ROLE_WINDOWS.planner.contextTokens);
    expect(asPlanner.launchProfile.port).toBe(SHIPPED_ROLE_PORTS.planning);
    // The Research model as the Coding model: the Coding window, not Apodex's profile.
    const asCoder = shippedAdapter(shippedModel("research"), {
      modelPath: "/models/a.gguf",
      role: "coding",
    });
    expect(asCoder.totalContextTokens()).toBe(GENERIC_ROLE_WINDOWS.worker.contextTokens);
    expect(asCoder.launchProfile.port).toBe(SHIPPED_ROLE_PORTS.coding);
    // Review has no shipped model, so it has its own port, clear of the others.
    const asReviewer = shippedAdapter(shippedModel("coding"), {
      modelPath: "/models/n.gguf",
      role: "review",
    });
    expect(asReviewer.totalContextTokens()).toBe(GENERIC_ROLE_WINDOWS.reviewer.contextTokens);
    expect(asReviewer.launchProfile.port).toBe(SHIPPED_REVIEW_PORT);
    expect(Object.values(SHIPPED_ROLE_PORTS)).not.toContain(SHIPPED_REVIEW_PORT);
  });

  it("through the roster: each role it serves gets its own window and port", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-other-role-"));
    dirs.push(dir);
    const registry = new ModelRegistry(join(dir, "m.json"));
    const weights = join(dir, "n.gguf");
    writeFileSync(weights, "x");
    registry.recordWeights("nail-mtp", {
      path: weights,
      volume: "internal",
      sha256: "d".repeat(64),
    });
    const roster = new ModelRoster({ registry });
    type Launch = { launchProfile: { contextTokens: number; port: number } };
    const planner = roster.resolve("nail-mtp", "planner") as unknown as Launch;
    expect(planner.launchProfile.contextTokens).toBe(GENERIC_ROLE_WINDOWS.planner.contextTokens);
    expect(planner.launchProfile.port).toBe(SHIPPED_ROLE_PORTS.planning);
    const worker = roster.resolve("nail-mtp", "worker") as unknown as Launch;
    expect(worker.launchProfile.contextTokens).toBe(GENERIC_ROLE_WINDOWS.worker.contextTokens);
    expect(worker.launchProfile.port).toBe(SHIPPED_ROLE_PORTS.coding);
  });
});
