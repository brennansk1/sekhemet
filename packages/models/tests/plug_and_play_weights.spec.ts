import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GENERIC_ROLE_WINDOWS,
  HttpInferenceAdapter,
  MANAGED_MODEL_FILES,
  ManagedLlamaServerAdapter,
  ModelRegistry,
  ModelRoster,
  genericManagedPort,
  managedModelWeights,
  registerModelFile,
  resolveWorkerModelId,
} from "../src/index.js";
import { writeGguf } from "./support/gguf_fixture.js";

/**
 * Plug-and-play GGUF weights (live-test F1, F7; MD-N12-9, MD-N12-10,
 * MD-N14-41a): a managed model loads the registry's preferred recorded copy,
 * and a registry model with recorded GGUF weights and no managed builder runs
 * under a managed llama-server with a generic profile derived from its header.
 */
let dir: string;
let registry: ModelRegistry;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-plug-"));
  registry = new ModelRegistry(join(dir, "models.json"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const roster = () => new ModelRoster({ registry, machineProfile: null });
const SHA = "a".repeat(64);

describe("a managed model loads the registry's preferred recorded copy (MD-N14-41a)", () => {
  it("loads the recorded copy of the Worker under another file name", () => {
    const file = join(dir, "Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf");
    writeFileSync(file, "weights");
    registry.recordWeights(resolveWorkerModelId("cyber-tiel"), {
      path: file,
      volume: "internal",
      sha256: SHA,
    });
    const a = roster().resolve("cyber-tiel", "worker") as ManagedLlamaServerAdapter;
    expect(a.launchProfile.modelPath).toBe(file);
    expect(a.modelId).toBe("cyber-tiel-coder-35b-a3b-mtp-iq3xxs");
  });

  it("loads the Planner stored under another file name", () => {
    const file = join(dir, "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf");
    writeFileSync(file, "weights");
    registry.recordWeights("qwen3.8-27b", { path: file, volume: "internal", sha256: SHA });
    const a = roster().resolve("dirk", "planner") as ManagedLlamaServerAdapter;
    expect(a.launchProfile.modelPath).toBe(file);
  });

  it("doctor's weights check looks for the recorded copy the launch will load", () => {
    const file = join(dir, "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf");
    writeFileSync(file, "weights");
    registry.recordWeights("qwen3.8-27b", { path: file, volume: "internal", sha256: SHA });
    const planner = managedModelWeights({ modelsDir: dir, registry }).find(
      (w) => w.modelId === "qwen3.8-27b",
    );
    expect(planner?.path).toBe(file);
  });

  it("keeps the shipped file name when no copy is recorded, or the recorded one is gone", () => {
    const plain = roster().resolve("cyber-tiel", "worker") as ManagedLlamaServerAdapter;
    expect(plain.launchProfile.modelPath.endsWith(MANAGED_MODEL_FILES.worker)).toBe(true);
    registry.recordWeights(resolveWorkerModelId("cyber-tiel"), {
      path: join(dir, "unplugged", "w.gguf"),
      volume: "external",
      sha256: SHA,
    });
    const gone = roster().resolve("cyber-tiel", "worker") as ManagedLlamaServerAdapter;
    expect(gone.launchProfile.modelPath.endsWith(MANAGED_MODEL_FILES.worker)).toBe(true);
  });
});

describe("a registry GGUF with no managed builder runs under a managed llama-server (MD-N12-10)", () => {
  const register = async (id: string, fixture: Parameters<typeof writeGguf>[1] = {}) => {
    const file = writeGguf(join(dir, `${id}.gguf`), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B A3B MTP",
      contextLength: 262144,
      fileType: 23,
      ...fixture,
    });
    await registerModelFile(registry, file, { id });
    return file;
  };

  it("builds a generic profile from the header, under its own model id", async () => {
    const file = await register("tiel-coder-mtp");
    const a = roster().resolve("tiel-coder-mtp", "worker");
    expect(a).toBeInstanceOf(ManagedLlamaServerAdapter);
    const m = a as ManagedLlamaServerAdapter;
    expect(m.modelId).toBe("tiel-coder-mtp");
    expect(m.launchProfile.modelPath).toBe(file);
    // The role's window, capped by the header's trained context; KV as the Worker's.
    expect(m.contextWindow?.contextTokens).toBe(GENERIC_ROLE_WINDOWS.worker.contextTokens);
    expect(m.launchProfile.kvType).toBe("q8_0");
    // The family's sampling (qwen), since the registry records none.
    expect(m.launchProfile.sampling).toMatchObject({ temperature: 0.7, topP: 0.8, topK: 20 });
    // Its own port, never the Worker's, the Planner's or the Researcher's.
    expect(m.launchProfile.port).toBe(genericManagedPort("tiel-coder-mtp"));
    expect([8098, 8099, 8101, 8080, 11434]).not.toContain(m.launchProfile.port);
    // No speculative decoding until measured and qualified (MD-N8-2).
    expect(m.speculativeSetting()).toBe("off");
    expect(registry.get("tiel-coder-mtp")?.engine).toBe("llama.cpp");
  });

  it("takes the registry's recorded sampling and caps the window at the header's", async () => {
    await register("small-ctx", { contextLength: 8192, architecture: "llama" });
    registry.upsert("small-ctx", { sampling: { temperature: 0.3, topP: 0.85 } });
    const m = roster().resolve("small-ctx", "researcher") as ManagedLlamaServerAdapter;
    expect(m.contextWindow?.contextTokens).toBe(8192);
    expect(m.launchProfile.sampling).toMatchObject({ temperature: 0.3, topP: 0.85 });
  });

  it("honours the window a queue asks for", async () => {
    await register("tiel-coder-mtp");
    const m = roster().resolve("tiel-coder-mtp", "worker", {
      contextTokens: 12288,
      maxTokens: 3072,
    }) as ManagedLlamaServerAdapter;
    expect(m.contextWindow?.contextTokens).toBe(12288);
    expect(m.contextWindow?.maxTokens).toBe(3072);
  });

  it("leaves a name with no recorded GGUF weights to Ollama", () => {
    registry.upsert("qwen3:8b", { family: "qwen" });
    expect(roster().resolve("qwen3:8b", "worker")).toBeInstanceOf(HttpInferenceAdapter);
    expect(roster().resolve("qwen3:8b", "worker")).not.toBeInstanceOf(ManagedLlamaServerAdapter);
  });
});

describe("registering a GGUF file (MD-N12-9)", () => {
  it("reads the header and records the weights, SHA-256, size and header", async () => {
    const file = writeGguf(join(dir, "Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf"), {
      architecture: "qwen3moe",
      name: "Tiel Coder 35B A3B MTP",
      contextLength: 262144,
      strings: {},
      padBytes: 1000,
    });
    const r = await registerModelFile(registry, file);
    expect(r.id).toBe("tiel-coder-35b-a3b-mtp");
    const e = registry.get(r.id);
    expect(e?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e?.sizeBytes).toBeGreaterThan(1000);
    expect(e?.family).toBe("qwen");
    expect(e?.header?.contextLength).toBe(262144);
    expect(e?.header?.architecture).toBe("qwen3moe");
    expect(registry.preferredWeights(r.id)).toBe(file);
  });

  it("refuses a file whose hash differs from the id's recorded weights, leaving the registry", async () => {
    const file = writeGguf(join(dir, "x.gguf"), { architecture: "llama", name: "X" });
    registry.upsert("x", { sha256: "b".repeat(64) });
    await expect(registerModelFile(registry, file, { id: "x" })).rejects.toThrow(/differs/);
    expect(registry.get("x")?.copies).toBeUndefined();
  });

  it("refuses a file that is not a readable GGUF", async () => {
    const file = join(dir, "notes.gguf");
    writeFileSync(file, "not a model");
    await expect(registerModelFile(registry, file, { id: "n" })).rejects.toThrow(/GGUF/);
    expect(registry.get("n")).toBeUndefined();
  });
});
