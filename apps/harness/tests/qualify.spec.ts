import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { FALLBACK_CHARS_PER_TOKEN, computeContextVersion, workerCopy } from "@sekhemet/context";
import { gateCopy } from "@sekhemet/gates";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { TOOL_CATALOG } from "@sekhemet/loop";
import {
  HttpInferenceAdapter,
  ManagedLlamaServerAdapter,
  MockInferenceAdapter,
  ModelRegistry,
  QUALIFICATION_SUITE_VERSION,
  candidateSettings,
  createCyberTielWorker,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { speculativeProbes } from "../src/calibrate_cmd.js";
import {
  type CombinationDeps,
  applyWorkerOverride,
  copyText,
  gateWorker,
  qualificationCombination,
  qualificationRefusal,
  speculativeProbe,
  workerContextVersion,
  workerOverrideFor,
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
        templates: [
          copyText(workerCopy),
          copyText(gateCopy),
          "inventory",
          `chars per token ${FALLBACK_CHARS_PER_TOKEN}`,
        ],
      }).version,
    );
    // The estimator's ratio is an input: changing it invalidates qualification.
    expect(workerContextVersion("inventory", 3.0)).not.toBe(workerContextVersion("inventory"));
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

// The live finding of 2026-09-25: the engine build comes from the running
// server's own report when the adapter has read it, in the same form as
// `llama-server --version` gives, so the two sources key one combination.
describe("the engine build in the combination", () => {
  it("prefers the build the running server reported on /props, in --version's form", async () => {
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/props" ? 200 : 404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model_path: "/models/cyber.gguf",
          build_info: "b10809-5266f24da",
          default_generation_settings: { n_ctx: 16_384 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const reg = new ModelRegistry(join(tmp(), "models.json"));
      const a = managed(reg, { port });
      expect(qualificationCombination(a, deps).engine).toBe("llama.cpp b7000 (abc1234)");
      expect((await a.serverProps())?.build).toBe("b10809-5266f24da");
      expect(qualificationCombination(a, deps).engine).toBe("llama.cpp b10809 (5266f24da)");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// The owner's decision of 2026-09-25 (models rule 27, MD-N4-4): Cyber-Tiel
// failed one check (multi_step 50%) and a person records an override for the
// exact combination that failed. The failure and the bar stay as they are.
describe("sekhemet qualify --override (rule 27, MD-N4-4)", () => {
  function kernel(): Kernel {
    const repoPath = tmp();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoPath });
    const db = new DatabaseSync(":memory:");
    initSchema(db);
    const log = new EventLog(db);
    return { repoPath, log, cardStore: new CardStore(db, log) };
  }
  const setup = () => {
    const k = kernel();
    process.env.SEKHEMET_MODEL_REGISTRY = join(k.repoPath, "models.json");
    const out: string[] = [];
    const io = {
      print: (l: string) => out.push(l),
      model: (n: string) => new MockInferenceAdapter(n, [], { exhaustion: "default" as const }),
      combinationDeps: deps,
    };
    return { k, out, io };
  };
  const override = (by: string) => [
    "--override",
    "silent",
    "--by",
    by,
    "--reason",
    "re-reads the file instead of editing; accepted for the frozen suite",
  ];

  it("refuses to override what was not measured on this combination", async () => {
    const { k, out, io } = setup();
    expect(await runWave2Command("qualify", override("person: Brennan Kelley"), k, io)).toBe(1);
    expect(out.at(-1)).toMatch(/no failed qualification of silent for this combination/);
    expect(await k.log.getEventsByTypes(["models/override"])).toHaveLength(0);
  });

  it("refuses a labeller that is a model, or none", async () => {
    const { k, out, io } = setup();
    await runWave2Command("qualify", ["--models", "silent"], k, io);
    for (const by of ["claude-opus-5-5", "person: cyber-tiel", "silent"]) {
      expect(await runWave2Command("qualify", override(by), k, io)).toBe(1);
      expect(out.at(-1)).toMatch(/names a model, not a person/);
    }
    expect(await runWave2Command("qualify", ["--override", "silent", "--reason", "x"], k, io)).toBe(
      1,
    );
    expect(out.at(-1)).toMatch(/Usage: sekhemet qualify --override/);
    expect(await k.log.getEventsByTypes(["models/override"])).toHaveLength(0);
  });

  it("records the override for the exact failed combination; the check then accepts it and still shows the failure", async () => {
    const { k, out, io } = setup();
    await runWave2Command("qualify", ["--models", "silent"], k, io);
    expect(await runWave2Command("qualify", override("person: Brennan Kelley"), k, io)).toBe(0);
    const [event] = await k.log.getEventsByTypes(["models/override"]);
    const combination = qualificationCombination(io.model("silent"), deps);
    expect(event?.payload).toMatchObject({
      worker: "silent",
      by: "person: Brennan Kelley",
      reason: "re-reads the file instead of editing; accepted for the frozen suite",
      combination,
    });
    const failedChecks = (event?.payload as { failedChecks: string[] }).failedChecks;
    expect(failedChecks.length).toBeGreaterThan(0);

    const reg = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    const a = io.model("silent");
    expect(qualificationRefusal(reg, a, combination, "silent")).toBeUndefined();
    expect(reg.lookupQualification("silent", combination).record?.status).toBe("failed");
    const o = workerOverrideFor(reg, a, combination);
    expect(o).toMatchObject({ by: "person: Brennan Kelley", failedChecks });

    expect(await runWave2Command("qualify", ["--check", "--models", "silent"], k, io)).toBe(0);
    const line = out.at(-1) as string;
    expect(line).toContain(
      `qualified by override: person: Brennan Kelley, ${o?.date.slice(0, 10)}: failed ${failedChecks.join(", ")}`,
    );
    expect(line).toMatch(/the qualification itself failed/);

    // Any change to the combination invalidates it, naming the element.
    // (A scripted adapter has no engine build, so the host stands in for it.)
    const changed = { ...deps, host: () => "host-b" };
    const why = qualificationRefusal(reg, a, qualificationCombination(a, changed), "silent");
    expect(why).toMatch(/invalidated .*host changed since the override by person: Brennan Kelley/);
  });

  it("stores a bare name as a person, as asset labels are (review low 6)", async () => {
    const { k, io } = setup();
    await runWave2Command("qualify", ["--models", "silent"], k, io);
    expect(await runWave2Command("qualify", override("Brennan Kelley"), k, io)).toBe(0);
    const [event] = await k.log.getEventsByTypes(["models/override"]);
    expect((event?.payload as { by: string }).by).toBe("person: Brennan Kelley");
    const reg = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    const a = io.model("silent");
    expect(workerOverrideFor(reg, a, qualificationCombination(a, deps))?.by).toBe(
      "person: Brennan Kelley",
    );
  });

  it("--check --json reports each model's state and override in one structured shape (review medium 3)", async () => {
    const { k, out, io } = setup();
    const json = async () => {
      const code = await runWave2Command(
        "qualify",
        ["--check", "--json", "--models", "silent"],
        k,
        io,
      );
      return { code, rows: JSON.parse(out.at(-1) as string) as Record<string, unknown>[] };
    };
    let r = await json();
    expect(r.code).toBe(1);
    expect(r.rows).toEqual([
      expect.objectContaining({
        model: "silent",
        modelId: "silent",
        status: "missing",
        runnable: false,
      }),
    ]);
    await runWave2Command("qualify", ["--models", "silent"], k, io);
    await runWave2Command("qualify", override("person: Brennan Kelley"), k, io);
    r = await json();
    expect(r.code).toBe(0);
    const reg = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    const a = io.model("silent");
    const o = workerOverrideFor(reg, a, qualificationCombination(a, deps));
    expect(r.rows).toEqual([
      expect.objectContaining({
        model: "silent",
        status: "overridden",
        runnable: true,
        workerOverride: o,
        failure: expect.any(String),
      }),
    ]);
    // Exactly the WorkerOverride shape the evidence and card/repro carry.
    expect(Object.keys(r.rows[0]?.workerOverride as object).sort()).toEqual([
      "by",
      "date",
      "failedChecks",
      "reason",
    ]);
  });
});

describe("one gate for every path that runs the Worker (review medium 2)", () => {
  const o = {
    by: "person: Brennan Kelley",
    reason: "accepted",
    failedChecks: ["multi_step 50%"],
  };
  const failedRecord = {
    suiteVersion: "v1",
    passRate: 0.967,
    status: "failed" as const,
    byCategory: { multi_step: 0.5 },
  };

  it("refuses an unqualified Worker and marks nothing", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const g = gateWorker(reg, a, "cyber-tiel", deps);
    expect(g.refusal).toMatch(/Refusing cyber-tiel-mtp as the Worker: not qualified/);
    expect(g.override).toBeUndefined();
    expect(candidateSettings(a)).not.toHaveProperty("workerOverride");
  });

  it("lets an overridden Worker run, marked, so its evidence says so", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const combination = qualificationCombination(a, deps);
    reg.recordCombinationQualification(a.modelId, combination, failedRecord);
    reg.recordQualificationOverride(a.modelId, combination, o, 0.9);
    const g = gateWorker(reg, a, "cyber-tiel", deps);
    expect(g.refusal).toBeUndefined();
    expect(g.override).toMatchObject(o);
    expect(candidateSettings(a).workerOverride).toEqual(g.override);
    // The queue marks the adapter its router builds with the probe's override.
    const worker = managed(reg);
    applyWorkerOverride(worker, g.override as NonNullable<typeof g.override>);
    expect(candidateSettings(worker).workerOverride).toEqual(g.override);
  });

  it("passes a qualified Worker unmarked", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const combination = qualificationCombination(a, deps);
    reg.recordCombinationQualification(a.modelId, combination, {
      ...failedRecord,
      status: "qualified",
    });
    const g = gateWorker(reg, a, "cyber-tiel", deps);
    expect(g.refusal).toBeUndefined();
    expect(g.override).toBeUndefined();
    expect(candidateSettings(a)).not.toHaveProperty("workerOverride");
  });
});

describe("the adapter mark", () => {
  it("marks the Worker adapter, so every evidence bundle's settings carry it", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = managed(reg);
    const o = {
      by: "person: Brennan Kelley",
      reason: "accepted",
      date: "2026-09-25T12:00:00.000Z",
      failedChecks: ["multi_step 50%"],
    };
    applyWorkerOverride(a, o);
    expect(a).toBeInstanceOf(ManagedLlamaServerAdapter);
    expect(candidateSettings(a).workerOverride).toEqual(o);
    // Not part of the adapter's serialised form or its launch.
    expect(Object.keys(a)).not.toContain("workerOverride");
  });
});

// Suite q1.2: the Worker qualifies at the sampling it runs cards at, and the
// sampling is part of the combination, so run, queue and the override
// compute the combination a q1.2 run records.
describe("the combination carries the role's sampling (q1.2)", () => {
  it("includes the Worker's card-model sampling", () => {
    const worker = createCyberTielWorker("/models/cyber.gguf");
    expect(qualificationCombination(worker, deps).settings.sampling).toEqual({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      minP: 0,
    });
  });

  it("leaves it out for an adapter that does not say", () => {
    const a = new MockInferenceAdapter("m", []);
    expect(qualificationCombination(a, deps).settings).not.toHaveProperty("sampling");
  });
});
