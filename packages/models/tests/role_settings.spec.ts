import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";
import {
  type QualificationCombination,
  applyRoleSettings,
  changedCombinationElements,
  combinationKey,
} from "../src/qualification_key.js";
import {
  ModelRegistry,
  ROLE_SETTINGS_FORMAT,
  ROLE_SETTING_FIELDS,
  SETTINGS_PRESETS,
  parseRoleSettingsFile,
  roleSettingsFile,
} from "../src/registry.js";
import { ModelRoster, checkRoleSettings, resolveRoleSettings } from "../src/roster.js";

// models NEW-models-21 (MD-N21-1..4, -6, -12): a person's settings per
// (model, role), graded, applied by the roster and keyed into the qualified
// combination. Nothing here loads a model; every registry is a temp file.

const dirs: string[] = [];
const registry = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-role-settings-"));
  dirs.push(d);
  return new ModelRegistry(join(d, "models.json"), () => new Date("2026-10-04T12:00:00Z"));
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const combo = (
  over: Partial<QualificationCombination["settings"]> = {},
): QualificationCombination => ({
  engine: "llama.cpp b10809",
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
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
    ...over,
  },
});

const byKey = (r: ReturnType<typeof resolveRoleSettings>) =>
  Object.fromEntries(r.map((v) => [v.key, v]));

describe("MD-N21-1: every value resolved with its grade and source", () => {
  it("grades model-card sampling, the family's defaults, measurements and the harness's defaults", () => {
    const reg = registry();
    reg.upsert("m-card", {
      family: "qwen",
      sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
      toolArm: "arm_b_json",
      reasoning: { supported: true, defaultBudget: 1024, stripTraces: true, floor: "low" },
      speculativeByPolicy: {
        off: {
          enabled: true,
          speedup: 1.3,
          reason: "1.3x faster per step",
          fingerprint: "h",
          date: "2026-10-01T00:00:00Z",
          thinking: "off",
        },
      },
    });
    const v = byKey(resolveRoleSettings(reg.get("m-card"), "worker"));
    expect(v.temperature).toMatchObject({ value: 0.6, grade: "card" });
    expect(v.temperature?.source).toMatch(/makers. published values/);
    expect(v.toolArm).toMatchObject({ value: "arm_b_json", grade: "measured" });
    expect(v.mtp).toMatchObject({ value: "auto", grade: "measured" });
    expect(v.mtp?.source).toMatch(/1\.3x faster/);
    expect(v.reasoningFloor).toMatchObject({ value: "low", grade: "card" });
    expect(v.reasoningCapTokens).toMatchObject({ value: 1024, grade: "card" });
    expect(v.contextTokens).toMatchObject({ value: 16384, grade: "default" });
    expect(v.kvType).toMatchObject({ value: "q8_0", grade: "default" });
    expect(v.repeatPenalty).toMatchObject({ value: 1, grade: "default" });

    // No recorded sampling: the family's published defaults, from the model card.
    reg.upsert("m-family", { family: "gemma" });
    const g = byKey(resolveRoleSettings(reg.get("m-family"), "reviewer"));
    expect(g.temperature).toMatchObject({ value: 1, grade: "card" });
    expect(g.temperature?.source).toMatch(/family/);
    expect(g.contextTokens).toMatchObject({ value: 12288, grade: "default" });
    // No family: the harness's own code sampling.
    const u = byKey(resolveRoleSettings(undefined, "planner"));
    expect(u.temperature).toMatchObject({ value: 0.2, grade: "default" });
  });

  it("caps the context at this machine's tier as an estimate, and at the trained context", () => {
    const reg = registry();
    reg.upsert("short", { header: { contextLength: 8192 } });
    expect(byKey(resolveRoleSettings(reg.get("short"), "worker")).contextTokens).toMatchObject({
      value: 8192,
      grade: "card",
    });
    const tier = byKey(resolveRoleSettings(undefined, "worker", { tierContextTokens: 12288 }));
    expect(tier.contextTokens).toMatchObject({ value: 12288, grade: "estimated" });
  });

  it("keeps a person's values per (model, role), graded Set by them, and Reset returns the graded value", () => {
    const reg = registry();
    reg.upsert("m", { family: "qwen" });
    reg.setRoleSettings("m", "reviewer", { temperature: 0, reasoningLevel: "medium" }, "p_mo");
    const review = byKey(resolveRoleSettings(reg.get("m"), "reviewer"));
    expect(review.temperature).toMatchObject({
      value: 0,
      grade: "set",
      by: "p_mo",
      at: "2026-10-04T12:00:00.000Z",
    });
    expect(review.reasoningLevel).toMatchObject({ value: "medium", grade: "set" });
    // The same weights in another role keep their own values.
    expect(byKey(resolveRoleSettings(reg.get("m"), "worker")).temperature?.grade).toBe("card");
    reg.resetRoleSettings("m", "reviewer", ["temperature"]);
    const after = byKey(resolveRoleSettings(reg.get("m"), "reviewer"));
    expect(after.temperature?.grade).toBe("card");
    expect(after.reasoningLevel?.grade).toBe("set");
    reg.resetRoleSettings("m", "reviewer");
    expect(reg.roleSettings("m", "reviewer")).toBeUndefined();
  });

  it("names every field in one of the five tabs, the floor read-only", () => {
    const tabs = new Set(ROLE_SETTING_FIELDS.map((f) => f.tab));
    expect([...tabs]).toEqual(["basics", "sampling", "reasoning", "engine", "harness"]);
    expect(ROLE_SETTING_FIELDS.map((f) => f.key)).toEqual([
      "contextTokens",
      "temperature",
      "topP",
      "topK",
      "minP",
      "repeatPenalty",
      "presencePenalty",
      "seed",
      "reasoningPolicy",
      "reasoningLevel",
      "reasoningCapTokens",
      "reasoningFloor",
      "kvType",
      "flashAttention",
      "gpuLayers",
      "slots",
      "mtp",
      "loadMode",
      "toolArm",
      "method",
      "evidenceGate",
      "stepBudget",
    ]);
    expect(ROLE_SETTING_FIELDS.find((f) => f.key === "reasoningFloor")?.readOnly).toBe(true);
  });
});

describe("MD-N21-4: refusals stand; every other concern is a hint", () => {
  it("refuses an unknown key, an out-of-range value, a choice not offered and 4-bit KV", () => {
    expect(checkRoleSettings({ warmth: 3 } as never, { role: "worker" }).refusal).toMatchObject({
      key: "warmth",
      refused: "unknown",
    });
    expect(checkRoleSettings({ temperature: 3 }, { role: "worker" }).refusal).toMatchObject({
      key: "temperature",
      refused: "range",
    });
    expect(
      checkRoleSettings({ loadMode: "fast" as never }, { role: "worker" }).refusal,
    ).toMatchObject({ key: "loadMode", refused: "range" });
    const kv = checkRoleSettings({ kvType: "q4_0" }, { role: "reviewer" }).refusal;
    expect(kv).toMatchObject({ key: "kvType", refused: "kv" });
    expect(kv?.error).toMatch(/4-bit/);
    expect(checkRoleSettings({ reasoningFloor: "none" }, { role: "worker" }).refusal).toMatchObject(
      { key: "reasoningFloor", refused: "readonly" },
    );
  });

  it("gives role-aware hints that never refuse", () => {
    const hot = checkRoleSettings({ temperature: 1.4, repeatPenalty: 1.1 }, { role: "worker" });
    expect(hot.refusal).toBeUndefined();
    expect(hot.hints.map((h) => h.key)).toEqual(["temperature", "repeatPenalty"]);
    expect(hot.hints[0]?.text).toMatch(/tool call/);
    const kv5 = checkRoleSettings({ kvType: "q5_1" }, { role: "worker" });
    expect(kv5.refusal).toBeUndefined();
    expect(kv5.hints[0]?.text).toMatch(/below 8 bits/);
    const small = checkRoleSettings({ contextTokens: 8192 }, { role: "worker" });
    expect(small.hints[0]?.text).toMatch(/Small/);
    const floor = checkRoleSettings(
      { reasoningLevel: "off" },
      { role: "reviewer", floor: "low" },
    ).hints;
    expect(floor[0]?.text).toMatch(/thinks at its floor/);
  });
});

describe("MD-N21-3: a person's values key into the combination", () => {
  it("leaves every earlier key as it was when nobody set anything", () => {
    const c = combo();
    expect(combinationKey(applyRoleSettings(c, undefined))).toBe(combinationKey(c));
    expect(combinationKey(applyRoleSettings(c, {}))).toBe(combinationKey(c));
    // Values that change only speed or the loop are not elements.
    expect(
      combinationKey(
        applyRoleSettings(c, { seed: 4, gpuLayers: 20, loadMode: "no_mmap", stepBudget: 30 }),
      ),
    ).toBe(combinationKey(c));
  });

  it("names each changed element", () => {
    const c = combo();
    const changed = applyRoleSettings(c, {
      contextTokens: 8192,
      temperature: 0.2,
      presencePenalty: 1.5,
      reasoningLevel: "medium",
      reasoningCapTokens: 4096,
      flashAttention: false,
      toolArm: "arm_b_json",
      mtp: "off",
      slots: 2,
      kvType: "f16",
    });
    expect(changedCombinationElements(c, changed)).toEqual([
      "context size",
      "KV type",
      "parallel slots",
      "sampling",
      "repeat and presence penalties",
      "reasoning",
      "flash attention",
      "tool arm",
    ]);
    // MTP off where the combination ran MTP is a change of speculative decoding.
    expect(
      changedCombinationElements(
        combo({ speculative: "mtp" }),
        applyRoleSettings(combo({ speculative: "mtp" }), { mtp: "off" }),
      ),
    ).toEqual(["speculative decoding"]);
  });

  it("marks the role Needs verifying until the combination with the values qualifies, and Reset restores it", () => {
    const reg = registry();
    const c = combo();
    reg.recordCombinationQualification("m", c, {
      suiteVersion: "q1.2",
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    });
    expect(reg.roleVerification("m", "worker", "ctx-1")).toMatchObject({ state: "verified" });
    reg.setRoleSettings("m", "worker", { presencePenalty: 1.5, temperature: 0.3 }, "p_mo");
    const v = reg.roleVerification("m", "worker", "ctx-1");
    expect(v.state).toBe("needs_verifying");
    expect(v.changed).toEqual(["sampling", "repeat and presence penalties"]);
    // The adapter reports the sampling the roster applied; the penalties are folded in here.
    const running = combo({ sampling: { temperature: 0.3, topP: 0.95, topK: 20, minP: 0 } });
    expect(reg.lookupQualification("m", running)).toMatchObject({
      status: "invalidated",
      changed: ["sampling", "repeat and presence penalties"],
    });
    // Verify now: the run records the combination as the settings make it.
    reg.recordCombinationQualification("m", running, {
      suiteVersion: "q1.2",
      passRate: 1,
      status: "qualified",
      toolCallChecks: true,
    });
    expect(reg.lookupQualification("m", running).status).toBe("qualified");
    expect(reg.roleVerification("m", "worker", "ctx-1").state).toBe("verified");
    // A value that is not an element leaves the verification as it was.
    reg.setRoleSettings("m", "worker", { seed: 9, gpuLayers: 40 }, "p_mo");
    expect(reg.roleVerification("m", "worker", "ctx-1").state).toBe("verified");
    // Reset: the first combination is the one that applies again, and it qualified.
    reg.resetRoleSettings("m", "worker");
    expect(reg.lookupQualification("m", c).status).toBe("qualified");
  });

  it("a model never verified for the role is Not verified, not Needs verifying", () => {
    const reg = registry();
    expect(reg.roleVerification("x", "reviewer", "ctx-1").state).toBe("not_verified");
  });
});

describe("presets, export and import (MD-N21-6)", () => {
  it("Careful raises reasoning and checks; Fast turns thinking off; Balanced sets nothing", () => {
    expect(SETTINGS_PRESETS.careful("worker")).toEqual({
      reasoningLevel: "medium",
      reasoningCapTokens: 4096,
      reasoningPolicy: "surgical",
      evidenceGate: "on",
      method: "strict",
    });
    expect(SETTINGS_PRESETS.fast("worker")).toEqual({
      reasoningLevel: "off",
      reasoningPolicy: "off",
      mtp: "auto",
    });
    expect(SETTINGS_PRESETS.balanced("worker")).toEqual({});
  });

  it("exports only a person's values and imports only its own format", () => {
    const reg = registry();
    reg.setRoleSettings("m", "reviewer", { reasoningLevel: "medium" }, "p_mo");
    const file = roleSettingsFile("m", "reviewer", reg.roleSettings("m", "reviewer"));
    expect(file).toEqual({
      format: ROLE_SETTINGS_FORMAT,
      model: "m",
      role: "reviewer",
      values: { reasoningLevel: "medium" },
    });
    expect(parseRoleSettingsFile(JSON.parse(JSON.stringify(file)))).toEqual({
      model: "m",
      role: "reviewer",
      values: { reasoningLevel: "medium" },
    });
    expect(() => parseRoleSettingsFile({ format: "lmstudio/1", values: {} })).toThrow(
      /sekhemet-role-settings\/1/,
    );
    expect(() => parseRoleSettingsFile({ format: ROLE_SETTINGS_FORMAT, values: [] })).toThrow(
      /values/,
    );
  });
});

describe("MD-N21-2: the roster applies a role's settings to the launch", () => {
  it("launches a registered GGUF with the person's context, sampling, seed, KV, flash attention, layers, slots and MTP", () => {
    const reg = registry();
    reg.recordWeights("my-model", {
      path: "/nowhere/my-model.gguf",
      volume: "internal",
      sha256: "a".repeat(64),
    });
    reg.upsert("my-model", { family: "qwen", header: { mtpHead: true, contextLength: 65536 } });
    reg.setRoleSettings(
      "my-model",
      "reviewer",
      {
        contextTokens: 20480,
        temperature: 0.1,
        presencePenalty: 0.5,
        seed: 7,
        kvType: "f16",
        flashAttention: false,
        gpuLayers: 40,
        slots: 2,
        mtp: "off",
        loadMode: "no_mmap",
      },
      "p_mo",
    );
    const roster = new ModelRoster({ registry: reg, machineProfile: null });
    const a = roster.resolve("my-model", "reviewer") as ManagedLlamaServerAdapter;
    expect(a).toBeInstanceOf(ManagedLlamaServerAdapter);
    const p = a.launchProfile;
    expect(p.contextTokens).toBe(20480);
    expect(p.kvType).toBe("f16");
    expect(p.gpuLayers).toBe(40);
    expect(p.parallelSlots).toBe(2);
    expect(p.mtp).toBe(false);
    expect(p.sampling).toMatchObject({ temperature: 0.1, presencePenalty: 0.5 });
    const args = a.launchArgs();
    expect(args.join(" ")).toMatch(/-fa off/);
    expect(args.join(" ")).toMatch(/-s 7/);
    expect(args).toContain("--no-mmap");

    // Another role on the same weights, with nothing set, launches as before.
    const plain = new ModelRoster({ registry: reg, machineProfile: null }).resolve(
      "my-model",
      "worker",
    ) as ManagedLlamaServerAdapter;
    expect(plain.launchProfile.kvType).toBe("q8_0");
    expect(plain.launchArgs().join(" ")).not.toMatch(/-fa off/);
  });

  it("MD-N21-12: the shipped Coding model with no recorded weights runs its managed profile at its 16,384-token window", () => {
    const reg = registry();
    const roster = new ModelRoster({ registry: reg, machineProfile: null });
    const a = roster.resolve("nail-mtp", "worker");
    expect(a).toBeInstanceOf(ManagedLlamaServerAdapter);
    expect(a.contextWindow?.contextTokens).toBe(16384);
    expect((a as ManagedLlamaServerAdapter).launchProfile.modelPath).toMatch(
      /Nail-Qwen3\.6-35B-A3B-MTP-UD-IQ3_XXS\.gguf$/,
    );
  });
});
