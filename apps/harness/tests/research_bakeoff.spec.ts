import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type GoldenQuestion,
  MEASURE_BENCHMARKED,
  type ResearchGoldenSet,
  bakeOffEvidence,
  loadResearchGoldenSet,
  registerAsset,
} from "@sekhemet/eval";
import { CardStore, EventLog, checkEventPayload, initSchema } from "@sekhemet/kernel";
import {
  ModelRegistry,
  RESEARCHER_CANDIDATES,
  assignRole,
  currentAssignment,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { type CombinationDeps, qualificationCombination } from "../src/qualify.js";
import { RESEARCH_METHOD } from "../src/research/researcher.js";
import {
  type Contender,
  type ContenderResult,
  RESEARCH_GOLDEN_RUN,
  adoptResearcher,
  goldenAnswerOf,
  pipelineVerdicts,
  productContender,
  productPipeline,
  recordResearchBakeoff,
  researchDoctorLines,
  researchPipelineAdvice,
  researcherAdoption,
  runGoldenSet,
  runResearchBakeoffCommand,
} from "../src/research_bakeoff.js";
import { runWave2Command } from "../src/wave2.js";

// Design-stage DS-N2-9 and models NEW-models-11 (MD-N11-1..3): the research
// golden set run per pipeline and per model, compared by the exact paired
// test, recorded on the ledger with the set's hash, and the Researcher
// adopted only as MD-N11-2 allows, restorable in one command. No model is
// loaded: answers come from fake pipelines; the ledger is real SQLite.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  Reflect.deleteProperty(process.env, "SEKHEMET_MODEL_REGISTRY");
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

/** A harness root whose research golden set a person confirmed and registered. */
function readyRoot(): string {
  const d = tmp("rg-root-");
  cpSync(join(ROOT, "fixtures"), join(d, "fixtures"), { recursive: true });
  const dir = join(d, "fixtures", "research_golden");
  const drafts = JSON.parse(
    readFileSync(join(dir, "drafts", "items.json"), "utf8"),
  ) as GoldenQuestion[];
  const items = drafts.map(({ status: _s, ...q }) => ({
    ...q,
    labelledBy: { principal: "person: Test Owner", kind: "person" as const },
  }));
  writeFileSync(join(dir, "items.json"), JSON.stringify(items, null, 2));
  rmSync(join(dir, "drafts"), { recursive: true });
  registerAsset(
    d,
    {
      name: "research-golden-set",
      path: "fixtures/research_golden",
      labelledBy: "person: Test Owner",
    },
    { modelIds: [] },
  );
  return d;
}

function ledger() {
  const d = tmp("rg-ledger-");
  process.env.SEKHEMET_MODEL_REGISTRY = join(d, "models.json");
  const db = new DatabaseSync(join(d, "events.db"));
  dbs.push(db);
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath: d, log, cardStore: new CardStore(db, log) };
}

/** The right answer to an item, as a pipeline would write it, with one verified citation. */
function rightAnswer(q: GoldenQuestion): string {
  const said = q.parts.map((p) =>
    p.kind === "licence" && p.value === "public-domain"
      ? "public domain"
      : p.kind === "licence" && p.value === "PostgreSQL"
        ? "the PostgreSQL License"
        : p.value,
  );
  return `${said.join("; ")} [1]\n\nReferences:\n[1] ${q.source}`;
}

/** A fake pipeline answering right on the items `right` names, and recording what it was asked. */
function fake(
  model: string,
  pipeline: "native" | "tool-loop",
  set: ResearchGoldenSet,
  right: (i: number) => boolean,
  opts: { resident?: number[]; asked?: string[]; unverified?: number } = {},
): Contender {
  const resident = [...(opts.resident ?? [])];
  return {
    model,
    pipeline,
    ask: async (question) => {
      opts.asked?.push(question);
      const i = set.items.findIndex((q) => q.question === question);
      const q = set.items[i] as GoldenQuestion;
      return right(i)
        ? { text: rightAnswer(q), verifiedCitations: 1, unverifiedCitations: opts.unverified ?? 0 }
        : { text: "Not settled.", verifiedCitations: 0, unverifiedCitations: 1 };
    },
    ...(opts.resident ? { residentBytes: async () => resident.shift() ?? resident.at(-1) } : {}),
  };
}

const GB = 1024 ** 3;

function clock(stepMs: number) {
  let t = 0;
  return () => {
    t += stepMs;
    return t;
  };
}

describe("the research golden set run per pipeline (DS-N2-9, MD-N11-1)", () => {
  it("records per model and pipeline the questions right, accuracy, citation precision, unverified citations, peak memory and seconds per question, with the set's hash", async () => {
    const set = loadResearchGoldenSet(readyRoot());
    expect(set.state).toBe("ready");
    const asked: string[] = [];
    const [r] = await runGoldenSet(
      set,
      [
        fake("apodex-1.1-mini", "native", set, (i) => i < 20, {
          asked,
          resident: [15 * GB, 16 * GB, 15.5 * GB],
          unverified: 1,
        }),
      ],
      { now: clock(2000) },
    );
    const res = r as ContenderResult;
    expect(res).toMatchObject({
      model: "apodex-1.1-mini",
      pipeline: "native",
      correct: 20,
      n: 25,
      accuracy: 0.8,
      setHash: set.hash,
      setVersion: "1",
      peakResidentBytes: 16 * GB,
      secondsPerQuestion: 2,
    });
    // 20 right answers cite one verified source and one unverified; 5 cite one unverified.
    expect(res.unverifiedCitations).toBe(25);
    expect(res.citationPrecision).toBeCloseTo(20 / 45, 6);
    expect(res.items).toHaveLength(25);
    expect(res.items[0]).toMatchObject({ id: "rg-01", grade: 1, correct: true });
    // Held out (MS-T11-3): each pipeline is asked the question and nothing of its answer.
    expect(asked).toEqual(set.items.map((q) => q.question));
  });

  it("refuses a set that is not built, and counts a pipeline that fails as a wrong answer, keeping the error", async () => {
    await expect(runGoldenSet(loadResearchGoldenSet(ROOT), [], { now: clock(1) })).rejects.toThrow(
      /a person/,
    );
    const set = loadResearchGoldenSet(readyRoot());
    const broken: Contender = {
      model: "neohorse-1-4b",
      pipeline: "tool-loop",
      ask: async () => {
        throw new Error("server refused the request");
      },
    };
    const [r] = await runGoldenSet(set, [broken], { now: clock(1000) });
    expect(r?.correct).toBe(0);
    expect(r?.items[0]).toMatchObject({ grade: 0, error: "server refused the request" });
    expect(r?.citationPrecision).toBeNull();
  });

  it("reads an answer's citations from the one reference checker's verdicts", () => {
    const a = goldenAnswerOf({
      answer: "MIT [1] [2]",
      sources: [],
      grounded: true,
      evidence: [],
      confidence: 0.5,
      badCitations: [2],
      claims: [],
      risk: { badCitations: 1, unreproduced: 0, uncovered: 0 } as never,
      references: [
        { n: 1, ref: "https://a", read: true, known: true },
        { n: 2, ref: "https://b", read: false, known: true },
      ],
    });
    expect(a).toEqual({ text: "MIT [1] [2]", verifiedCitations: 1, unverifiedCitations: 1 });
  });

  it("routes research to the better pipeline when the exact paired test rejects at 0.05, and marks the other not recommended", async () => {
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("spark-x2.5-4b", "native", set, (i) => i < 22),
        fake("spark-x2.5-4b", "tool-loop", set, (i) => i < 12),
        fake("neohorse-1-4b", "native", set, (i) => i < 20),
        fake("neohorse-1-4b", "tool-loop", set, (i) => i < 18),
      ],
      { now: clock(1) },
    );
    const [spark, horse] = pipelineVerdicts(results);
    // 10 discordant pairs, all one way: p = 2 / 1024.
    expect(spark).toMatchObject({
      model: "spark-x2.5-4b",
      recommended: "native",
      notRecommended: ["tool-loop"],
    });
    expect(spark?.tests[0]?.p).toBeCloseTo(2 / 1024, 6);
    // 2 discordant pairs: p = 0.5, inconclusive: nothing is routed or marked.
    expect(horse).toMatchObject({ model: "neohorse-1-4b", notRecommended: [] });
    expect(horse?.recommended).toBeUndefined();
    // The product's pipeline today: Apodex on its native tools, the rest on the tool loop.
    expect(productPipeline("apodex-1.1-mini")).toBe("native");
    expect(productPipeline("spark-x2.5-4b")).toBe("tool-loop");
  });

  it("never marks a pipeline not recommended on a run where one of the pair failed", async () => {
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("spark-x2.5-4b", "native", set, (i) => i < 22),
        {
          model: "spark-x2.5-4b",
          pipeline: "tool-loop",
          ask: async () => {
            throw new Error("the model server exited");
          },
        },
      ],
      { now: clock(1) },
    );
    const [spark] = pipelineVerdicts(results);
    expect(spark?.notRecommended).toEqual([]);
    expect(spark?.recommended).toBeUndefined();
  });
});

describe("adopting a smaller Researcher (MD-N11-2)", () => {
  const set = { state: "ready", hash: "h", version: "1", items: [] } as ResearchGoldenSet;
  /** A result with `right` of 25 items right: items listed by index. */
  const result = (model: string, right: (i: number) => boolean, peak?: number): ContenderResult => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: `rg-${i}`,
      grade: (right(i) ? 1 : 0) as 0 | 1,
      correct: right(i),
      verified: right(i) ? 1 : 0,
      unverified: 0,
      seconds: 1,
    }));
    const correct = items.filter((x) => x.correct).length;
    return {
      model,
      pipeline: model.startsWith("apodex") ? "native" : "tool-loop",
      setHash: set.hash as string,
      setVersion: "1",
      items,
      correct,
      n: 25,
      accuracy: correct / 25,
      citationPrecision: 1,
      verifiedCitations: correct,
      unverifiedCitations: 0,
      secondsPerQuestion: 1,
      ...(peak !== undefined ? { peakResidentBytes: peak } : {}),
    };
  };
  const apodex = result("apodex-1.1-mini", (i) => i < 15, 16 * GB);

  it("allows a candidate that answers more questions correctly by a margin the paired test resolves", () => {
    const a = researcherAdoption([apodex, result("spark-x2.5-4b", (i) => i < 24, 20 * GB)]);
    expect(a.adopt).toBe("spark-x2.5-4b");
    expect(a.verdicts[0]).toMatchObject({
      model: "spark-x2.5-4b",
      allowed: true,
      quality: "better",
    });
  });

  it("allows an inconclusive candidate only with lower peak memory and no significant loss, quality not established", () => {
    const a = researcherAdoption([apodex, result("neohorse-1-4b", (i) => i < 14, 4.4 * GB)]);
    expect(a.adopt).toBe("neohorse-1-4b");
    expect(a.verdicts[0]).toMatchObject({ allowed: true, quality: "not established" });
  });

  it("keeps Apodex when an inconclusive candidate uses more memory, when its memory was not measured, or when it is significantly worse", () => {
    for (const cand of [
      result("spark-x2.5-4b", (i) => i < 16, 17 * GB),
      result("spark-x2.5-4b", (i) => i < 16),
      result("spark-x2.5-4b", (i) => i < 5, 4 * GB),
    ]) {
      const a = researcherAdoption([apodex, cand]);
      expect(a.adopt).toBeUndefined();
      expect(a.verdicts[0]?.allowed).toBe(false);
    }
  });

  it("keeps Apodex on a loss the one-sided test resolves though the two-sided one does not", () => {
    // Apodex alone right on 7 items, the candidate alone on 1: two-sided p ≈ 0.070, one-sided ≈ 0.035.
    const inc = result("apodex-1.1-mini", (i) => i < 15, 16 * GB);
    const cand = result("neohorse-1-4b", (i) => i < 8 || i === 20, 4 * GB);
    const a = researcherAdoption([inc, cand]);
    expect(a.verdicts[0]).toMatchObject({ allowed: false });
    expect(a.verdicts[0]?.p).toBeCloseTo(18 / 256, 6);
    expect(a.verdicts[0]?.pLoss).toBeCloseTo(9 / 256, 6);
  });

  it("adopts nothing from a run where a contender's pipeline failed: a failure is not a quality result", () => {
    // Apodex's server never came up: every question threw, so it scored 0/25.
    const down = result("apodex-1.1-mini", () => false, 16 * GB);
    down.items = down.items.map((i) => ({ ...i, error: "connect ECONNREFUSED 127.0.0.1:8098" }));
    const a = researcherAdoption([down, result("spark-x2.5-4b", (i) => i < 8, 5 * GB)]);
    expect(a.adopt).toBeUndefined();
    expect(a.verdicts[0]).toMatchObject({ model: "spark-x2.5-4b", allowed: false });
    expect(a.verdicts[0]?.reason).toMatch(/apodex-1\.1-mini .*failed on 25 question/);
    // A candidate whose own pipeline failed on one question is not adopted either.
    const partly = result("spark-x2.5-4b", (i) => i < 24, 5 * GB);
    partly.items[24] = { ...(partly.items[24] as (typeof partly.items)[number]), error: "timeout" };
    expect(researcherAdoption([apodex, partly]).adopt).toBeUndefined();
  });

  it("an errored run is not measured, never a loss: a candidate whose pipeline threw is not marked worse", () => {
    // The candidate's server died on every question: 0/25 is no quality result.
    const down = result("spark-x2.5-4b", () => false, 5 * GB);
    down.items = down.items.map((i) => ({ ...i, error: "the model server exited" }));
    const a = researcherAdoption([apodex, down]);
    expect(a.adopt).toBeUndefined();
    expect(a.verdicts[0]).toMatchObject({
      model: "spark-x2.5-4b",
      allowed: false,
      quality: "not measured",
    });
  });

  it("refuses a comparison without the incumbent", () => {
    expect(() => researcherAdoption([result("spark-x2.5-4b", () => true, GB)])).toThrow(
      /apodex-1\.1-mini/,
    );
  });
});

describe("the record, the advice and the adoption on the ledger (DS-N2-9, MD-N11-3)", () => {
  const deps: CombinationDeps = {
    digest: () => "sampled-sha256:abc",
    engineBuild: () => "b10900 (abc1234)",
    host: () => "host-a",
    contextVersion: () => "ctx-1",
  };

  function qualifyAll(registry: ModelRegistry, build = deps) {
    for (const c of RESEARCHER_CANDIDATES) {
      const a = c.create(`/models/${c.modelId}.gguf`, "/bin/llama-server");
      registry.recordCombinationQualification(
        a.modelId,
        qualificationCombination(a, { ...build, registry }),
        { suiteVersion: "q1.2", passRate: 0.95, status: "qualified" },
      );
    }
  }

  it("records one overnight benchmark per model that counts as the Researcher's bake-off, and the run with its verdicts", async () => {
    const k = ledger();
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("apodex-1.1-mini", "native", set, (i) => i < 15, { resident: [16 * GB] }),
        fake("spark-x2.5-4b", "native", set, (i) => i < 24, { resident: [5 * GB] }),
        fake("spark-x2.5-4b", "tool-loop", set, (i) => i < 10, { resident: [5 * GB] }),
      ],
      { now: clock(1000) },
    );
    const rec = await recordResearchBakeoff(k.log, { host: "host-a", set, results });
    const benches = await k.log.getEventsByTypes([MEASURE_BENCHMARKED]);
    expect(benches).toHaveLength(2);
    for (const e of benches)
      expect(() => checkEventPayload(e.type, e.payload, undefined)).not.toThrow();
    const spark = benches.find((e) => bakeOffEvidence(e, "researcher")?.model === "spark-x2.5-4b");
    expect(bakeOffEvidence(spark as never, "researcher")).toMatchObject({
      host: "host-a",
      tier: "overnight",
      evaluationSet: "research-golden-set",
    });
    // The model's best pipeline stands for it; its score and items are recorded with the set's hash.
    const role = (spark?.payload as { roles: { score: number; setHash: string }[] }).roles[0];
    expect(role).toMatchObject({ score: 24 / 25, setHash: set.hash });

    const [run] = await k.log.getEventsByTypes([RESEARCH_GOLDEN_RUN]);
    expect(run?.payload).toMatchObject({
      setHash: set.hash,
      setVersion: "1",
      host: "host-a",
      adoption: { incumbent: "apodex-1.1-mini", adopt: "spark-x2.5-4b" },
    });
    expect(rec.adoption.adopt).toBe("spark-x2.5-4b");
    const advice = await researchPipelineAdvice(k.log);
    expect(advice.find((a) => a.model === "spark-x2.5-4b")).toMatchObject({
      recommended: "native",
      notRecommended: ["tool-loop"],
    });
    const lines = await researchDoctorLines(k.log);
    expect(lines.join("\n")).toMatch(/spark-x2\.5-4b.*tool-loop.*not recommended/);
    expect(lines.join("\n")).toMatch(/24\/25.*10\/25/);
  });

  it("records a contender whose pipeline threw as not measured: no score, no resolved loss", async () => {
    const k = ledger();
    const set = loadResearchGoldenSet(readyRoot());
    const dead: Contender = {
      model: "spark-x2.5-4b",
      pipeline: "tool-loop",
      ask: async () => {
        throw new Error("the model server exited");
      },
    };
    const results = await runGoldenSet(
      set,
      [fake("apodex-1.1-mini", "native", set, (i) => i < 15), dead],
      { now: clock(1000) },
    );
    const rec = await recordResearchBakeoff(k.log, { host: "host-a", set, results });
    const benches = await k.log.getEventsByTypes([MEASURE_BENCHMARKED]);
    for (const e of benches)
      expect(() => checkEventPayload(e.type, e.payload, undefined)).not.toThrow();
    const roleOf = (e: (typeof benches)[number]) =>
      (e.payload as { roles: Record<string, unknown>[] }).roles[0];
    const spark = benches.find((e) => roleOf(e)?.model === "spark-x2.5-4b");
    const role = spark ? roleOf(spark) : undefined;
    expect(role).toMatchObject({ state: "not_measured" });
    // A run that was not measured is no bake-off evidence for adopting it.
    expect(bakeOffEvidence(spark as never, "researcher")).toBeUndefined();
    expect(role?.score).toBeUndefined();
    expect(role?.items).toBeUndefined();
    // No comparison resolves a loss on a run that failed.
    for (const e of benches) {
      expect((e.payload as { resolved: unknown[] }).resolved).toEqual([]);
    }
    expect(rec.adoption.verdicts[0]).toMatchObject({ quality: "not measured", allowed: false });
    const [run] = await k.log.getEventsByTypes([RESEARCH_GOLDEN_RUN]);
    expect(() => checkEventPayload(run?.type as string, run?.payload, undefined)).not.toThrow();
    const contenders = (run?.payload as { contenders: Record<string, unknown>[] }).contenders;
    expect(contenders.find((c) => c.model === "spark-x2.5-4b")).toMatchObject({ errors: 25 });
    expect(contenders.find((c) => c.model === "apodex-1.1-mini")?.errors).toBeUndefined();
  });

  it("the tool-loop arm runs research's own loop, even on a model with native tools", async () => {
    const k = ledger();
    const systems: string[] = [];
    const adapter = {
      modelId: "apodex-1.1-mini",
      supportedArms: ["arm_a_flat"],
      nativeTools: true,
      generate: async (req: { systemPrompt?: string }) => {
        systems.push(req.systemPrompt ?? "");
        return {
          text: "Yes [1].\n\nReferences:\n[1] https://nodejs.org/api/sqlite.html",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
    };
    const contender = productContender(k.repoPath, k.log)(adapter as never, "tool-loop");
    await contender.ask("Does DatabaseSync have run()?").catch(() => undefined);
    expect(systems.length).toBeGreaterThan(0);
    expect(systems[0]).toContain(RESEARCH_METHOD.slice(0, 40));
  });

  it("MD-N11-3: adopts the allowed candidate as the default, keeps Apodex restorable in one command, and refuses what MD-N11-2 does not allow", async () => {
    const k = ledger();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    qualifyAll(registry);
    // Apodex is the shipped default, assigned at first run.
    assignRole(registry, {
      role: "researcher",
      model: "apodex-1.1-mini",
      scope: "default",
      by: "harness",
      host: "host-a",
      qualification: "qualified",
      firstRun: true,
    });
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("apodex-1.1-mini", "native", set, (i) => i < 15, { resident: [16 * GB] }),
        fake("spark-x2.5-4b", "tool-loop", set, (i) => i < 24, { resident: [5 * GB] }),
        fake("neohorse-1-4b", "tool-loop", set, (i) => i < 3, { resident: [4 * GB] }),
      ],
      { now: clock(1000) },
    );
    const rec = await recordResearchBakeoff(k.log, { host: "host-a", set, results });
    const principal = k.cardStore.localPrincipal();
    await expect(
      adoptResearcher(k.log, registry, rec, {
        model: "neohorse-1-4b",
        host: "host-a",
        principal,
        qualification: "qualified",
      }),
    ).rejects.toThrow(/MD-N11-2/);
    const done = await adoptResearcher(k.log, registry, rec, {
      model: "spark-x2.5-4b",
      host: "host-a",
      principal,
      qualification: "qualified",
    });
    expect(done.previous).toBe("apodex-1.1-mini");
    expect(currentAssignment(registry, "host-a", "researcher", "default")?.model).toBe(
      "spark-x2.5-4b",
    );
    const [assigned] = await k.log.getEventsByTypes(["models/assigned"]);
    expect(assigned?.payload).toMatchObject({
      role: "researcher",
      model: "spark-x2.5-4b",
      scope: "default",
      previous: "apodex-1.1-mini",
    });
    expect(() => checkEventPayload("models/assigned", assigned?.payload, undefined)).not.toThrow();
    // The Apodex profile is still there to restore to.
    expect(RESEARCHER_CANDIDATES[0]?.modelId).toBe("apodex-1.1-mini");
    const out: string[] = [];
    const code = await runWave2Command("models", ["restore", "researcher", "--default"], k, {
      print: (l: string) => out.push(l),
      combinationDeps: deps,
    });
    expect(code).toBe(0);
    expect(
      currentAssignment(
        new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY),
        "host-a",
        "researcher",
        "default",
      )?.model,
    ).toBe("apodex-1.1-mini");
  });

  it("the command refuses to run on a draft set, and before loading anything when a model is unqualified or its llama.cpp build is too old", async () => {
    const k = ledger();
    const out: string[] = [];
    const print = (l: string) => out.push(l);
    expect(await runResearchBakeoffCommand([], k, { print, harnessRoot: ROOT })).toBe(1);
    expect(out.join("\n")).toMatch(/draft/);

    const root = readyRoot();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    let asked = 0;
    const io = {
      print,
      harnessRoot: root,
      registry,
      combinationDeps: deps,
      adapterFor: (c: (typeof RESEARCHER_CANDIDATES)[number]) =>
        c.create(`/models/${c.modelId}.gguf`, "/bin/llama-server"),
      contenderFor: (): Contender => ({
        model: "x",
        pipeline: "native",
        ask: async () => {
          asked++;
          return { text: "", verifiedCitations: 0, unverifiedCitations: 0 };
        },
      }),
    };
    out.length = 0;
    expect(await runResearchBakeoffCommand([], k, io)).toBe(1);
    expect(out.join("\n")).toMatch(/apodex-1\.1-mini is not qualified/);
    expect(out.join("\n")).toMatch(/sekhemet qualify --models apodex-1\.1-mini/);

    // Qualified on an old build: Spark needs b10828.
    const old = { ...deps, engineBuild: () => "b7000 (abc1234)" };
    qualifyAll(registry, old);
    out.length = 0;
    expect(await runResearchBakeoffCommand([], k, { ...io, combinationDeps: old })).toBe(1);
    expect(out.join("\n")).toMatch(
      /spark-x2\.5-4b needs llama\.cpp b10828 or later; this engine is llama\.cpp b7000/,
    );
    expect(asked).toBe(0);
    expect(await k.log.getEventsByTypes([RESEARCH_GOLDEN_RUN])).toHaveLength(0);
  });

  it("the command runs every model qualified here, one at a time, records the run and adopts on --adopt", async () => {
    const k = ledger();
    const root = readyRoot();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    qualifyAll(registry);
    assignRole(registry, {
      role: "researcher",
      model: "apodex-1.1-mini",
      scope: "default",
      by: "harness",
      host: "host-a",
      qualification: "qualified",
      firstRun: true,
    });
    const set = loadResearchGoldenSet(root);
    const rightOn: Record<string, number> = {
      "apodex-1.1-mini": 15,
      "spark-x2.5-4b": 24,
      "neohorse-1-4b": 16,
    };
    const unloaded: string[] = [];
    const out: string[] = [];
    const io = {
      print: (l) => out.push(l),
      harnessRoot: root,
      registry,
      combinationDeps: deps,
      now: clock(3000),
      // The real profiles (nothing starts them: the fake pipelines never call the model).
      adapterFor: (c) =>
        Object.assign(c.create(`/models/${c.modelId}.gguf`, "/bin/llama-server"), {
          unload: async () => {
            unloaded.push(c.modelId);
          },
        }),
      contenderFor: (adapter, pipeline) =>
        fake(adapter.modelId, pipeline, set, (i) => i < (rightOn[adapter.modelId] ?? 0), {
          resident: [adapter.modelId.startsWith("apodex") ? 16 * GB : 5 * GB],
        }),
    } satisfies Parameters<typeof runResearchBakeoffCommand>[2];
    const code = await runResearchBakeoffCommand(["--adopt"], k, io);
    expect(out.join("\n")).toMatch(/apodex-1\.1-mini \(native\): 15\/25/);
    expect(code).toBe(0);
    // Each model's server released when its run ended (a measurement run).
    expect(unloaded).toEqual(["apodex-1.1-mini", "spark-x2.5-4b", "neohorse-1-4b"]);
    expect(await k.log.getEventsByTypes([MEASURE_BENCHMARKED])).toHaveLength(3);
    expect(out.join("\n")).toMatch(/spark-x2\.5-4b adopted as the Researcher default/);
    expect(out.join("\n")).toMatch(/sekhemet models restore researcher --default/);
    expect(currentAssignment(registry, "host-a", "researcher", "default")?.model).toBe(
      "spark-x2.5-4b",
    );
  });

  it("the command adopts nothing when a contender's pipeline failed, and says why", async () => {
    const k = ledger();
    const root = readyRoot();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    qualifyAll(registry);
    assignRole(registry, {
      role: "researcher",
      model: "apodex-1.1-mini",
      scope: "default",
      by: "harness",
      host: "host-a",
      qualification: "qualified",
      firstRun: true,
    });
    const set = loadResearchGoldenSet(root);
    const out: string[] = [];
    const code = await runResearchBakeoffCommand(
      ["--adopt", "--models", "apodex-1.1-mini,spark-x2.5-4b"],
      k,
      {
        print: (l) => out.push(l),
        harnessRoot: root,
        registry,
        combinationDeps: deps,
        now: clock(1000),
        adapterFor: (c) => c.create(`/models/${c.modelId}.gguf`, "/bin/llama-server"),
        contenderFor: (adapter, pipeline) =>
          adapter.modelId.startsWith("apodex")
            ? {
                model: adapter.modelId,
                pipeline,
                ask: async () => {
                  throw new Error("the model server exited");
                },
              }
            : fake(adapter.modelId, pipeline, set, (i) => i < 8, { resident: [5 * GB] }),
      },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/failed on 25 question/);
    expect(out.at(-1)).toMatch(/The Researcher stays apodex-1\.1-mini/);
    expect(currentAssignment(registry, "host-a", "researcher", "default")?.model).toBe(
      "apodex-1.1-mini",
    );
    expect(await k.log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });

  it("adopting from a recorded run looks the qualification up again, refusing a combination that no longer qualifies", async () => {
    const k = ledger();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    qualifyAll(registry);
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("apodex-1.1-mini", "native", set, (i) => i < 15, { resident: [16 * GB] }),
        fake("spark-x2.5-4b", "tool-loop", set, (i) => i < 24, { resident: [5 * GB] }),
      ],
      { now: clock(1000) },
    );
    const rec = await recordResearchBakeoff(k.log, { host: "host-a", set, results });
    expect(rec.adoption.adopt).toBe("spark-x2.5-4b");
    // llama.cpp was upgraded after the run: the new combination has not qualified.
    const upgraded = { ...deps, engineBuild: () => "b11000 (def5678)" };
    const out: string[] = [];
    const code = await runResearchBakeoffCommand(["--adopt-from", rec.runEventId], k, {
      print: (l) => out.push(l),
      registry,
      combinationDeps: upgraded,
      adapterFor: (c) => c.create(`/models/${c.modelId}.gguf`, "/bin/llama-server"),
    });
    expect(code).toBe(1);
    expect(out.at(-1)).toMatch(/spark-x2\.5-4b is not qualified .*\(invalidated\)/);
    expect(currentAssignment(registry, "host-a", "researcher", "default")).toBeUndefined();
    expect(await k.log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });

  it("adopts from a recorded run without running it again, and never on another host's run", async () => {
    const k = ledger();
    const registry = new ModelRegistry(process.env.SEKHEMET_MODEL_REGISTRY);
    qualifyAll(registry);
    assignRole(registry, {
      role: "researcher",
      model: "apodex-1.1-mini",
      scope: "default",
      by: "harness",
      host: "host-a",
      qualification: "qualified",
      firstRun: true,
    });
    const set = loadResearchGoldenSet(readyRoot());
    const results = await runGoldenSet(
      set,
      [
        fake("apodex-1.1-mini", "native", set, (i) => i < 15, { resident: [16 * GB] }),
        fake("neohorse-1-4b", "tool-loop", set, (i) => i < 15, { resident: [4 * GB] }),
      ],
      { now: clock(1000) },
    );
    const rec = await recordResearchBakeoff(k.log, { host: "host-a", set, results });
    const out: string[] = [];
    const io = { print: (l: string) => out.push(l), registry, combinationDeps: deps };
    expect(
      await runResearchBakeoffCommand(["--adopt-from", rec.runEventId], k, {
        ...io,
        combinationDeps: { ...deps, host: () => "host-b" },
      }),
    ).toBe(1);
    expect(out.at(-1)).toMatch(/another host/);
    expect(await runResearchBakeoffCommand(["--adopt-from", rec.runEventId], k, io)).toBe(0);
    // An inconclusive comparison with lower memory: allowed, quality not established.
    expect(out.at(-1)).toMatch(/neohorse-1-4b adopted as the Researcher default/);
    const [run] = await k.log.getEventsByTypes([RESEARCH_GOLDEN_RUN]);
    expect(run?.payload).toMatchObject({
      adoption: { verdicts: [{ model: "neohorse-1-4b", quality: "not established" }] },
    });
    expect(await runResearchBakeoffCommand(["--adopt-from", "e_missing"], k, io)).toBe(1);
  });
});
