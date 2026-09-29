import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFingerprintHash, mtpStepAB } from "../src/calibration.js";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";
import { MockInferenceAdapter } from "../src/mock_adapter.js";
import {
  QUALIFICATION_CASES,
  QUALIFICATION_SUITE_VERSION,
  qualifyModel,
  runQualification,
  toolCallChecksPass,
} from "../src/qualification.js";
import {
  type QualificationCombination,
  changedCombinationElements,
  combinationKey,
} from "../src/qualification_key.js";
import { ModelRegistry, type SpeculativeDecision } from "../src/registry.js";
import type { InferenceRequest, InferenceResponse, ToolCall } from "../src/types.js";

// models.md rule 27a and NEW-models-8 (MD-N8-1, -2, -4, -5). Nothing here
// loads a model: every adapter is scripted.

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sekhemet-qual-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const combo = (
  over: Partial<QualificationCombination["settings"]> = {},
): QualificationCombination => ({
  engine: "llama.cpp b7000 (abc1234)",
  modelBuild: "sampled-sha256:1111",
  host: "host-a",
  settings: {
    contextTokens: 16_384,
    kvType: "q8_0",
    speculative: "off",
    prefixCaching: true,
    parallelSlots: 1,
    chatTemplate: "tmpl-1",
    contextVersion: "ctx-1",
    ...over,
  },
});

describe("the qualification combination (rule 27a, MD-N8-1, MD-N8-4)", () => {
  it("keys a combination by every element, independent of key order", () => {
    const a = combo();
    const reordered: QualificationCombination = {
      settings: { ...a.settings },
      host: a.host,
      modelBuild: a.modelBuild,
      engine: a.engine,
    };
    expect(combinationKey(reordered)).toBe(combinationKey(a));
    expect(combinationKey(combo({ kvType: "f16" }))).not.toBe(combinationKey(a));
  });

  it("keys the role a qualification is for; the Coding model's keys as before roles were keyed (F24)", () => {
    const a = combo();
    // A record made before roles were keyed is the Coding model's, and keeps its key.
    expect(combinationKey(combo({ role: "worker" }))).toBe(combinationKey(a));
    expect(combinationKey(combo({ role: "reviewer" }))).not.toBe(combinationKey(a));
    expect(changedCombinationElements(a, combo({ role: "reviewer" }))).toEqual(["role"]);
    expect(changedCombinationElements(a, combo({ role: "worker" }))).toEqual([]);
  });

  it("names every element that differs", () => {
    const a = combo();
    expect(changedCombinationElements(a, a)).toEqual([]);
    expect(
      changedCombinationElements(a, {
        ...combo({ speculative: "mtp", contextVersion: "ctx-2" }),
        engine: "llama.cpp b7100 (def5678)",
      }),
    ).toEqual(["engine", "speculative decoding", "context version"]);
    expect(changedCombinationElements(a, combo({ speculative: { draft: "qwen3-0.6b" } }))).toEqual([
      "speculative decoding",
    ]);
  });
});

describe("qualifications per combination in the registry (MD-N8-1, MD-N8-4)", () => {
  const passed = {
    suiteVersion: QUALIFICATION_SUITE_VERSION,
    passRate: 0.95,
    status: "qualified" as const,
  };

  it("finds the exact combination qualified, and a missing one as missing", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordCombinationQualification("w", combo(), passed);
    expect(reg.lookupQualification("w", combo())).toMatchObject({ status: "qualified" });
    const other = reg.lookupQualification("v", combo());
    expect(other.status).toBe("missing");
    expect(other.reason).toMatch(/never qualified/);
  });

  it("reports a changed element as the reason the qualification is invalidated", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordCombinationQualification("w", combo(), passed);
    const look = reg.lookupQualification("w", combo({ speculative: "mtp" }));
    expect(look.status).toBe("invalidated");
    expect(look.changed).toEqual(["speculative decoding"]);
    expect(look.reason).toMatch(/speculative decoding changed/);
    const tmpl = reg.lookupQualification("w", combo({ chatTemplate: "tmpl-2", parallelSlots: 2 }));
    expect(tmpl.changed).toEqual(["parallel slots", "chat template"]);
  });

  it("reports a failed combination as failed, with its record", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordCombinationQualification("w", combo(), {
      ...passed,
      passRate: 0.4,
      status: "failed",
      reason: "recall 0%",
    });
    const look = reg.lookupQualification("w", combo());
    expect(look.status).toBe("failed");
    expect(look.reason).toMatch(/failed qualification.*recall 0%/);
  });

  it("keeps a registry written before combinations readable; a per-model record is not a combination", () => {
    const path = join(tmp(), "models.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        models: [
          {
            id: "w",
            qualification: {
              suiteVersion: "q1.0",
              passRate: 0.9,
              date: "2026-09-01",
              status: "qualified",
            },
          },
        ],
      }),
    );
    const reg = new ModelRegistry(path);
    expect(reg.get("w")?.qualification?.passRate).toBe(0.9);
    expect(reg.isQualified("w", 0.8)).toBe(true);
    const look = reg.lookupQualification("w", combo());
    expect(look.status).toBe("missing");
    expect(look.reason).toMatch(/per model, before combinations were recorded/);
    // A new record keeps the old one and adds the combination.
    reg.recordCombinationQualification("w", combo(), passed);
    const again = new ModelRegistry(path);
    expect(again.get("w")?.qualification?.passRate).toBe(0.95);
    expect(again.lookupQualification("w", combo()).status).toBe("qualified");
  });
});

// A scripted Worker that answers every suite case correctly, except where told.
const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: "q",
  name,
  arguments: args,
});
function answer(req: InferenceRequest, wrong: Set<string>): InferenceResponse {
  const last = [req.prompt, ...(req.messages ?? []).map((m) => m.content)].join("\n");
  const usage = { promptTokens: 100, completionTokens: 20, durationMs: 200 };
  const reply = (c?: ToolCall) => ({ text: "", toolCalls: c ? [c] : [], usage });
  const kase = QUALIFICATION_CASES.find((c) =>
    c.prompt ? c.prompt === req.prompt : c.messages?.[0]?.content === req.messages?.[0]?.content,
  );
  if (!kase || wrong.has(kase.category)) return reply(call("done", { summary: "nothing" }));
  return reply(CORRECT[kase.id]?.(last));
}
const CORRECT: Record<string, (text: string) => ToolCall> = {
  "select-read": () => call("read_file", { path: "src/app.ts" }),
  "select-check": () => call("check", { gate: "test" }),
  "select-done": () => call("done", { summary: "added a login form" }),
  "args-read": () => call("read_file", { path: "packages/core/src/index.ts" }),
  "args-edit": () =>
    call("edit", { path: "src/math.ts", search: "return a - b;", replace: "return a + b;" }),
  "args-check-enum": () => call("check", { gate: "lint" }),
  "args-run": () => call("run_cmd", { command: "ls scripts" }),
  "recover-path": () => call("read_file", { path: "src/server.ts" }),
  "recover-lint": () => call("read_file", { path: "src/util.ts" }),
  "refuse-rm": () => call("done", { summary: "refused" }),
  "refuse-exfiltrate": () => call("done", { summary: "refused" }),
  "multi-step-fix": () =>
    call("edit", {
      path: "src/ledger.ts",
      search: "return rows.length - 1;",
      replace: "return rows.length;",
    }),
  "multi-step-verify": () => call("check", { gate: "test" }),
  "recall-column": () => call("done", { summary: "amounts live in amount_cents" }),
  "recall-port": () => call("run_cmd", { command: "curl -s http://127.0.0.1:47831/health" }),
};
const scripted = (id: string, wrong: string[] = []) => {
  const w = new Set(wrong);
  return new MockInferenceAdapter(id, [], {
    exhaustion: "default",
    rules: [{ match: () => true, response: (req) => answer(req, w) }],
  });
};

describe("the qualification suite includes tool calls, a multi-step conversation and recall (rule 27a)", () => {
  it("has the categories rule 27a names, deterministically scored", async () => {
    expect(QUALIFICATION_SUITE_VERSION).toBe("q1.2");
    const categories = new Set(QUALIFICATION_CASES.map((c) => c.category));
    expect(categories).toContain("multi_step");
    expect(categories).toContain("recall");
    const r = await runQualification(scripted("w"));
    expect(r.byCategory.schema_validity).toBe(1);
    expect(r.byCategory.multi_step).toBe(1);
    expect(r.byCategory.recall).toBe(1);
    expect(r.qualified).toBe(true);
    expect(toolCallChecksPass(r)).toBe(true);
    // Speed is measured too: 20 tokens in 200 ms per case.
    expect(r.speed.decodeTokensPerSecond).toBe(100);
  });

  it("states the recalled fact once, early, in a long context", () => {
    for (const c of QUALIFICATION_CASES.filter((x) => x.category === "recall")) {
      const text = (c.messages ?? []).map((m) => m.content).join("\n");
      expect(text.length, c.id).toBeGreaterThan(12_000);
    }
  });

  it("fails the tool-call checks when recall fails, whatever the pass rate", async () => {
    const r = await runQualification(scripted("w", ["recall"]));
    expect(r.byCategory.recall).toBe(0);
    expect(toolCallChecksPass(r)).toBe(false);
  });
});

describe("qualifyModel records the combination (MD-N8-1) and disables speculation that breaks tool calls (MD-N8-2)", () => {
  it("records a passing combination as qualified", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    await qualifyModel(scripted("w"), {
      registry: reg,
      arms: ["arm_a_flat"],
      combination: combo(),
    });
    const look = reg.lookupQualification("w", combo());
    expect(look.status).toBe("qualified");
    expect(look.record?.speed?.decodeTokensPerSecond).toBe(100);
    expect(look.record?.toolCallChecks).toBe(true);
  });

  it("keeps each check's exact interval and the samples it ran (q1.2)", async () => {
    const path = join(tmp(), "models.json");
    const reg = new ModelRegistry(path);
    const { best } = await qualifyModel(scripted("w"), {
      registry: reg,
      arms: ["arm_a_flat"],
      combination: combo(),
    });
    const record = new ModelRegistry(path).lookupQualification("w", combo()).record;
    expect(record?.samples).toBe(best.samples);
    expect(record?.intervals).toEqual(best.intervals);
    expect(record?.intervals?.multi_step?.high).toBeLessThanOrEqual(1);
  });

  it("with speculation on, a failed tool-call check fails the combination and turns speculation off, saying why", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const mtp = combo({ speculative: "mtp" });
    await qualifyModel(scripted("w", ["recall", "multi_step"]), {
      registry: reg,
      arms: ["arm_a_flat"],
      combination: mtp,
      thinking: "off",
    });
    const look = reg.lookupQualification("w", mtp);
    expect(look.status).toBe("failed");
    expect(look.reason).toMatch(/tool-call checks failed with speculative decoding on/);
    const d = reg.get("w")?.speculativeByPolicy?.off;
    expect(d?.enabled).toBe(false);
    expect(d?.reason).toMatch(/tool-call checks failed.*multi_step 0%.*recall 0%/);
  });
});

const decision = (over: Partial<SpeculativeDecision> = {}): SpeculativeDecision => ({
  enabled: true,
  speedup: 1.2,
  reason: "faster per step",
  fingerprint: hostFingerprintHash(),
  date: "2026-09-25",
  thinking: "off",
  ...over,
});
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

describe("speculative decoding needs its combination qualified with prefix caching on (MD-N8-2)", () => {
  const profile = {
    modelId: "w",
    modelPath: "/m.gguf",
    thinkingPolicy: "off" as const,
    contextTokens: 16_384,
  };
  const qualifyOn = (
    reg: ModelRegistry,
    speculative: QualificationCombination["settings"]["speculative"],
    over: Partial<QualificationCombination["settings"]> = {},
    status: "qualified" | "failed" = "qualified",
  ) =>
    reg.recordCombinationQualification(
      "w",
      { ...combo({ speculative, ...over }), host: hostFingerprintHash() },
      {
        suiteVersion: QUALIFICATION_SUITE_VERSION,
        passRate: 0.95,
        status,
        toolCallChecks: status === "qualified",
      },
    );

  it("stays off when the speed decision allows it but no qualification does", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision());
    const a = new ManagedLlamaServerAdapter({ ...profile, registry: reg });
    expect(a.mtpEnabled()).toBe(false);
    expect(a.speculativeStatus().reason).toMatch(/not qualified with MTP on and prefix caching on/);
  });

  it("turns on only when both the decision and a qualification with prefix caching on allow it", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision());
    qualifyOn(reg, "mtp", { prefixCaching: false });
    const a = new ManagedLlamaServerAdapter({ ...profile, registry: reg });
    expect(a.mtpEnabled()).toBe(false);
    qualifyOn(reg, "mtp");
    expect(a.mtpEnabled()).toBe(true);
    expect(flag(a.launchArgs(), "--spec-type")).toBe("draft-mtp");
    // Without the decision the qualification alone does not turn it on.
    const reg2 = new ModelRegistry(join(tmp(), "models.json"));
    qualifyOn(reg2, "mtp");
    expect(new ManagedLlamaServerAdapter({ ...profile, registry: reg2 }).mtpEnabled()).toBe(false);
  });

  it("stays off when the speculative combination failed its tool-call checks", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision());
    qualifyOn(reg, "mtp", {}, "failed");
    expect(new ManagedLlamaServerAdapter({ ...profile, registry: reg }).mtpEnabled()).toBe(false);
  });
});

describe("draft-model speculative decoding (MD-N8-5)", () => {
  const profile = {
    modelId: "w",
    modelPath: "/m.gguf",
    thinkingPolicy: "off" as const,
    contextTokens: 16_384,
    draftModelPath: "/models/qwen3-0.6b-Q8_0.gguf",
  };

  it("launches with -md only when the decision keyed by that draft model and its qualification allow it", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const a = new ManagedLlamaServerAdapter({ ...profile, registry: reg });
    expect(a.draftModelId()).toBe("qwen3-0.6b-Q8_0");
    expect(a.launchArgs()).not.toContain("-md");
    // A decision for another draft model does not count.
    reg.recordSpeculative("w", decision({ draft: "other-draft" }));
    reg.recordCombinationQualification(
      "w",
      { ...combo({ speculative: { draft: "qwen3-0.6b-Q8_0" } }), host: hostFingerprintHash() },
      {
        suiteVersion: QUALIFICATION_SUITE_VERSION,
        passRate: 0.95,
        status: "qualified",
        toolCallChecks: true,
      },
    );
    expect(a.launchArgs()).not.toContain("-md");
    reg.recordSpeculative("w", decision({ draft: "qwen3-0.6b-Q8_0" }));
    expect(flag(a.launchArgs(), "-md")).toBe(profile.draftModelPath);
    // One speculative method per launch: a draft model, not the MTP head.
    expect(a.launchArgs()).not.toContain("--spec-type");
    expect(a.speculativeSetting()).toEqual({ draft: "qwen3-0.6b-Q8_0" });
  });

  it("mtpStepAB decides a draft model by the same A/B, keyed by the draft model", async () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    const timed = (ms: number) =>
      new MockInferenceAdapter("w", [], {
        exhaustion: "default",
        rules: [
          {
            match: () => true,
            response: {
              text: "",
              toolCalls: [],
              usage: {
                promptTokens: 1,
                completionTokens: 1,
                durationMs: ms,
                prefillMs: ms / 2,
                decodeMs: ms / 2,
              },
            },
          },
        ],
      });
    const steps: InferenceRequest[] = Array.from({ length: 30 }, (_, k) => ({
      prompt: `step ${k}`,
      toolArm: "arm_a_flat" as const,
    }));
    const r = await mtpStepAB({
      modelId: "w",
      steps,
      plain: timed(1000),
      speculative: timed(600),
      thinking: "off",
      registry: reg,
      draft: "qwen3-0.6b-Q8_0",
    });
    expect(r.enabled).toBe(true);
    const e = reg.get("w");
    expect(e?.speculativeByDraft?.["qwen3-0.6b-Q8_0"]?.off?.enabled).toBe(true);
    // The MTP head's decision is untouched by a draft model's A/B.
    expect(e?.speculativeByPolicy?.off).toBeUndefined();
  });
});
