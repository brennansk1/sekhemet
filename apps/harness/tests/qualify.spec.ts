import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { computeContextVersion, workerCopy } from "@sekhemet/context";
import { gateCopy } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { TOOL_CATALOG } from "@sekhemet/loop";
import {
  HttpInferenceAdapter,
  ManagedLlamaServerAdapter,
  MockInferenceAdapter,
  ModelRegistry,
  QUALIFICATION_SUITE_VERSION,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { speculativeProbes } from "../src/calibrate_cmd.js";
import {
  type CombinationDeps,
  copyText,
  qualificationCombination,
  qualificationRefusal,
  speculativeProbe,
  workerContextVersion,
} from "../src/qualify.js";
import { type Kernel, queuePrelude, runWave2Command } from "../src/wave2.js";

// models.md rule 27a, MD-N8-1, MD-N8-4: a Worker is used for cards only once
// its exact combination has qualified on this host. Nothing here loads a model.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sekhemet-qualify-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
});

const deps: CombinationDeps = {
  digest: () => "sampled-sha256:abc",
  engineBuild: () => "b7000 (abc1234)",
  host: () => "host-a",
  contextVersion: () => "ctx-1",
};

const managed = (registry: ModelRegistry, extra: Record<string, unknown> = {}) =>
  new ManagedLlamaServerAdapter({
    modelId: "cyber-tiel-mtp",
    modelPath: "/models/cyber.gguf",
    contextTokens: 16_384,
    registry,
    thinkingPolicy: "off",
    ...extra,
  });

describe("the Worker's qualification combination (rule 27a)", () => {
  it("is built from the launch, the weights' sampled digest, the engine build, the host, the template and the context version", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.pinTemplate("cyber-tiel-mtp", "{{ messages }}");
    const c = qualificationCombination(managed(reg), deps);
    expect(c).toEqual({
      engine: "llama.cpp b7000 (abc1234)",
      modelBuild: "sampled-sha256:abc",
      host: "host-a",
      settings: {
        contextTokens: 16_384,
        kvType: "q8_0",
        speculative: "off",
        prefixCaching: true,
        parallelSlots: 1,
        chatTemplate: reg.get("cyber-tiel-mtp")?.template?.checksum,
        contextVersion: "ctx-1",
      },
    });
  });

  it("names an Ollama model by its tag and an unpinned template as unpinned", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = new HttpInferenceAdapter({
      modelId: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434",
      apiFormat: "ollama",
      contextTokens: 8192,
      registry: reg,
    });
    const c = qualificationCombination(a, deps);
    expect(c.engine).toBe("ollama");
    expect(c.modelBuild).toBe("ollama:qwen3:8b");
    expect(c.settings.chatTemplate).toBe("unpinned");
    expect(c.settings.contextTokens).toBe(8192);
  });

  it("uses the Worker's prompt, copy modules, tool schemas and literal inventory as the context version", () => {
    expect(workerContextVersion("inventory")).toBe(
      computeContextVersion({
        tools: TOOL_CATALOG,
        templates: [copyText(workerCopy), copyText(gateCopy), "inventory"],
      }).version,
    );
    // Editing a Worker literal outside the copy modules changes the recorded
    // inventory, and with it the version (B2.2 confirmation).
    expect(workerContextVersion("inventory a")).not.toBe(workerContextVersion("inventory b"));
    // Not the playbook: it is per project and card.
    expect(workerContextVersion()).not.toBe(computeContextVersion({ tools: TOOL_CATALOG }).version);
  });

  it("probes speculation with the method forced on, as the combination names it (MD-N8-2)", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const probe = speculativeProbe(managed(reg));
    expect(probe.mtpEnabled()).toBe(true);
    expect(qualificationCombination(probe, deps).settings.speculative).toBe("mtp");
    const draft = speculativeProbe(managed(reg, { draftModelPath: "/models/draft-0.6b.gguf" }));
    // The draft is keyed by its file's sampled digest, not only its id.
    expect(qualificationCombination(draft, deps).settings.speculative).toEqual({
      draft: "draft-0.6b sampled-sha256:abc",
    });
  });
});

describe("the chat template comes from the registry the caller passes (B2.2 confirmation)", () => {
  it("gives equivalent adapters the same combination, whether or not they carry the registry", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.pinTemplate("qwen3:8b", "{{ messages }}");
    const profile = {
      modelId: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434",
      apiFormat: "ollama" as const,
      contextTokens: 8192,
    };
    const withReg = new HttpInferenceAdapter({ ...profile, registry: reg });
    const bare = new HttpInferenceAdapter(profile);
    const a = qualificationCombination(withReg, { ...deps, registry: reg });
    const b = qualificationCombination(bare, { ...deps, registry: reg });
    expect(b).toEqual(a);
    expect(b.settings.chatTemplate).toBe(reg.get("qwen3:8b")?.template?.checksum);
  });

  it("pins the template for a speculative probe through the passed registry", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.pinTemplate("cyber-tiel-mtp", "{{ messages }}");
    const probe = speculativeProbe(managed(reg), reg);
    expect(qualificationCombination(probe, { ...deps, registry: reg }).settings.chatTemplate).toBe(
      reg.get("cyber-tiel-mtp")?.template?.checksum,
    );
  });

  it("reports a stored invalidated record as invalidated, not failed", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const combo = qualificationCombination(a, deps);
    reg.recordCombinationQualification(a.modelId, combo, {
      suiteVersion: QUALIFICATION_SUITE_VERSION,
      passRate: 0.95,
      status: "invalidated",
      toolCallChecks: true,
      reason: "the chat template changed",
    });
    const msg = qualificationRefusal(reg, a, combo, "cyber-tiel");
    expect(msg).toMatch(/invalidated/);
    expect(msg).not.toMatch(/failed qualification/);
  });
});

describe("the speculative A/B probes a draft model too (MD-N8-5)", () => {
  it("builds plain and speculative launches for a draft model, keyed by it", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const probes = speculativeProbes(managed(reg, { draftModelPath: "/models/draft-0.6b.gguf" }));
    expect(probes?.draft).toBe("draft-0.6b");
    expect(probes?.plain.launchArgs()).not.toContain("-md");
    expect(probes?.speculative.launchArgs()).toContain("-md");
    // Neither a draft model nor an MTP head: nothing to measure.
    expect(speculativeProbes(managed(reg))).toBeUndefined();
    expect(speculativeProbes(managed(reg, { mtp: true }))?.draft).toBeUndefined();
  });
});

describe("a Worker is refused until its exact combination has qualified (MD-N8-1, MD-N8-4)", () => {
  it("refuses a model never qualified here, in one line naming the command that qualifies it", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const msg = qualificationRefusal(reg, a, qualificationCombination(a, deps), "cyber-tiel");
    expect(msg).toBeDefined();
    expect(msg?.split("\n")).toHaveLength(1);
    expect(msg).toMatch(/cyber-tiel-mtp/);
    expect(msg).toMatch(/never qualified on this host/);
    expect(msg).toMatch(/sekhemet qualify --models cyber-tiel$/);
  });

  it("accepts the qualified combination and names what changed when it no longer matches", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const combo = qualificationCombination(a, deps);
    reg.recordCombinationQualification(a.modelId, combo, {
      suiteVersion: QUALIFICATION_SUITE_VERSION,
      passRate: 0.95,
      status: "qualified",
      toolCallChecks: true,
    });
    expect(qualificationRefusal(reg, a, combo, "cyber-tiel")).toBeUndefined();
    const f16 = managed(reg, { kvType: "f16" });
    const msg = qualificationRefusal(reg, f16, qualificationCombination(f16, deps), "cyber-tiel");
    expect(msg).toMatch(/invalidated.*KV type changed/);
  });

  it("the queue prelude refuses to start the pass", async () => {
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    const k: Kernel = { repoPath: tmp(), log, cardStore: new CardStore(db, log) };
    await expect(
      queuePrelude(k, [], {
        print: () => undefined,
        workerRefusal: "Refusing w as the Worker: never qualified",
      }),
    ).rejects.toThrow("Refusing w as the Worker: never qualified");
  });
});

describe("sekhemet qualify records the combination (MD-N8-1)", () => {
  function kernel(): Kernel {
    const repoPath = tmp();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    return { repoPath, log, cardStore: new CardStore(db, log) };
  }

  it("records the run under the model's combination, and --check reports it", async () => {
    const k = kernel();
    process.env.SEKHEMET_MODEL_REGISTRY = join(k.repoPath, "models.json");
    const out: string[] = [];
    const io = {
      print: (l: string) => out.push(l),
      model: (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const }),
      combinationDeps: deps,
    };
    expect(await runWave2Command("qualify", ["--check", "--models", "silent"], k, io)).toBe(1);
    expect(out.at(-1)).toMatch(/Refusing silent as the Worker: not qualified .*never qualified/);
    expect(await runWave2Command("qualify", ["--models", "silent"], k, io)).toBe(1);
    const reg = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    const combo = qualificationCombination(io.model("silent"), deps);
    const look = reg.lookupQualification("silent", combo);
    expect(look.status).toBe("failed");
    expect(look.record?.suiteVersion).toBe(QUALIFICATION_SUITE_VERSION);
    expect(await runWave2Command("qualify", ["--check", "--models", "silent"], k, io)).toBe(1);
    expect(out.at(-1)).toMatch(/failed/);
  });
});
