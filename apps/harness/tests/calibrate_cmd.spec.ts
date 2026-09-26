import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InferenceRequest, ModelRegistry, type UnloadableAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { parseModelList, runCalibrate } from "../src/calibrate_cmd.js";

describe("sekhemet calibrate (H3)", () => {
  it("parses name=role lists and rejects unknown roles", () => {
    expect(parseModelList(undefined)).toEqual([{ name: "cyber-tiel", role: "worker" }]);
    expect(parseModelList("cyber-tiel=worker, apodex=researcher")).toEqual([
      { name: "cyber-tiel", role: "worker" },
      { name: "apodex", role: "researcher" },
    ]);
    expect(() => parseModelList("x=chef")).toThrow(/Unknown role/);
  });

  it("measures models one at a time, unloading each before the next, and saves the profile", async () => {
    const events: string[] = [];
    const fake = (id: string): UnloadableAdapter => ({
      modelId: id,
      supportedArms: ["arm_a_flat"],
      async generate(_req: InferenceRequest) {
        events.push(`gen ${id}`);
        return {
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 64,
            durationMs: 1000,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: 30,
          },
        };
      },
      async unload() {
        events.push(`unload ${id}`);
      },
    });
    const path = join(mkdtempSync(join(tmpdir(), "cal-")), "machine.json");
    const lines: string[] = [];
    const profile = await runCalibrate({
      models: parseModelList("a=worker,b=researcher"),
      buckets: [2048],
      decodeTokens: 16,
      force: true,
      resolve: (name) => fake(name),
      path,
      registry: null,
      say: (l) => lines.push(l),
    });
    const firstUnloadA = events.indexOf("unload a");
    const firstGenB = events.indexOf("gen b");
    expect(firstUnloadA).toBeGreaterThan(-1);
    expect(firstGenB).toBeGreaterThan(firstUnloadA); // never two models at once
    expect(Object.keys(profile?.models ?? {})).toEqual(["a", "b"]);
    expect(lines.some((l) => /a \(.+\): 2k: prefill \d+ tok\/s, decode \d+/.test(l))).toBe(true);
    // A second run on the same hardware reuses the saved profile.
    const again = await runCalibrate({
      models: parseModelList("a=worker"),
      path,
      resolve: () => fake("z"),
      say: (l) => lines.push(l),
    });
    expect(again?.date).toBe(profile?.date);
    expect(lines.at(-1)).toMatch(/use --force/);
  });

  it("measures the speculative head with and against itself and records the verdict (M19)", async () => {
    const events: string[] = [];
    const probe = (id: string, decode: number): UnloadableAdapter => ({
      modelId: id,
      supportedArms: ["arm_a_flat"],
      async generate(_req: InferenceRequest) {
        events.push(`gen ${id}`);
        return {
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 64,
            durationMs: 1000,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: decode,
          },
        };
      },
      async unload() {
        events.push(`unload ${id}`);
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "cal-spec-"));
    const registry = new ModelRegistry(join(dir, "models.json"));
    const lines: string[] = [];
    const profile = await runCalibrate({
      models: parseModelList("a=worker"),
      buckets: [2048],
      decodeTokens: 16,
      force: true,
      resolve: () => probe("a", 30),
      // The 21%-slower case CHRONICLE measured on the M4.
      speculative: () => ({ plain: probe("a-plain", 30), speculative: probe("a-mtp", 23.7) }),
      path: join(dir, "machine.json"),
      registry,
      say: (l) => lines.push(l),
    });
    expect(profile?.speculative?.a).toMatchObject({ enabled: false, speedup: 0.79 });
    // The launch reads the registry, so that is where the decision has to land.
    expect(registry.get("a")?.speculative?.enabled).toBe(false);
    // One server at a time: the head is measured after the plain run is gone.
    expect(events.filter((e) => e.includes("a-"))).toEqual([
      "gen a-plain",
      "unload a-plain",
      "gen a-mtp",
      "unload a-mtp",
    ]);
    expect(lines.some((l) => /speculative decoding: off/.test(l))).toBe(true);
  });

  it("A1: a decode-only win never turns MTP on, and never overwrites the --mtp-ab decision (models rule 13)", async () => {
    const probe = (id: string, decode: number): UnloadableAdapter => ({
      modelId: id,
      supportedArms: ["arm_a_flat"],
      async generate(_req: InferenceRequest) {
        return {
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 64,
            durationMs: 1000,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: decode,
          },
        };
      },
      async unload() {},
    });
    const dir = mkdtempSync(join(tmpdir(), "cal-spec-"));
    const registry = new ModelRegistry(join(dir, "models.json"));
    // The per-step A/B already decided MTP off for this policy.
    const abDecision = {
      enabled: false,
      speedup: 0.9,
      reason: "not faster per step",
      fingerprint: "this-host",
      date: "2026-09-25",
      thinking: "off" as const,
    };
    registry.recordSpeculative("a", abDecision);
    const lines: string[] = [];
    await runCalibrate({
      models: parseModelList("a=worker"),
      buckets: [2048],
      decodeTokens: 16,
      force: true,
      resolve: () => probe("a", 30),
      // Decode 33% faster: the case rule 13 says never justifies MTP alone.
      speculative: () => ({ plain: probe("a-plain", 30), speculative: probe("a-mtp", 40) }),
      path: join(dir, "machine.json"),
      registry,
      say: (l) => lines.push(l),
    });
    expect(registry.get("a")?.speculativeByPolicy?.off).toEqual(abDecision);
    expect(registry.get("a")?.speculative?.thinking).toBeUndefined();
    expect(lines.some((l) => /sekhemet calibrate --mtp-ab/.test(l))).toBe(true);
  });

  it("does not load a head the host has no room for (24 GB reference machine)", async () => {
    const loaded: string[] = [];
    const probe = (id: string): UnloadableAdapter => ({
      modelId: id,
      supportedArms: ["arm_a_flat"],
      async generate() {
        loaded.push(id);
        return {
          text: "ok",
          toolCalls: [],
          usage: { promptTokens: 2048, completionTokens: 64, durationMs: 1000 },
        };
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "cal-head-"));
    const registry = new ModelRegistry(join(dir, "models.json"));
    const worker: UnloadableAdapter = {
      ...probe("a"),
      // The 24 GB reference machine's practical ceiling: 16 GB of weights.
      footprintBytes: async () => 16 * 1024 ** 3,
    };
    const profile = await runCalibrate({
      models: parseModelList("a=worker"),
      buckets: [2048],
      force: true,
      // What a 24 GB M4 really offers the GPU, not what it advertises.
      usableBytes: 17 * 1024 ** 3,
      resolve: () => worker,
      speculative: () => ({ plain: probe("a-plain"), speculative: probe("a-mtp") }),
      path: join(dir, "machine.json"),
      registry,
      say: () => undefined,
    });
    expect(loaded).not.toContain("a-mtp");
    expect(profile?.speculative?.a).toMatchObject({ enabled: false });
    expect(registry.get("a")?.speculative?.reason).toMatch(/headroom/);
  });
});

describe("NEW-models-1: calibration keeps the window the Worker's prompts need (MD-N1-2)", () => {
  it("reads the p99 of recorded prompt sizes from run ledgers and holds the window up", async () => {
    const { mkdirSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");
    const { promptNeedFromLedgers } = await import("../src/calibrate_cmd.js");
    const repo = mkdtempSync(join(tmpdir(), "cal-need-"));
    mkdirSync(join(repo, ".sekhemet"));
    const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
    db.exec("CREATE TABLE steps (prompt_tokens INTEGER NOT NULL DEFAULT 0)");
    const insert = db.prepare("INSERT INTO steps (prompt_tokens) VALUES (?)");
    for (let i = 0; i < 99; i++) insert.run(8_000);
    insert.run(0); // a step with no usage recorded is not a size
    insert.run(13_500);
    insert.run(13_500);
    db.close();
    const need = promptNeedFromLedgers([repo], { answerTokens: 2048, thinkingTokens: 1024 });
    expect(need).toEqual({ p99PromptTokens: 13_500, answerTokens: 2048, thinkingTokens: 1024 });
    expect(promptNeedFromLedgers([join(repo, "none")])).toBeUndefined();

    const lines: string[] = [];
    const profile = await runCalibrate({
      models: parseModelList("a=worker"),
      buckets: [2048],
      force: true,
      sweep: false,
      usableBytes: 11 * 1024 ** 3,
      resolve: () => ({
        modelId: "a",
        supportedArms: ["arm_a_flat"],
        generate: async () => ({
          text: "ok",
          toolCalls: [],
          usage: {
            promptTokens: 2048,
            completionTokens: 8,
            durationMs: 100,
            prefillTokensPerSecond: 400,
            decodeTokensPerSecond: 30,
          },
        }),
      }),
      path: false,
      registry: null,
      ...(need ? { promptNeed: need } : {}),
      say: (l) => lines.push(l),
    });
    expect(profile?.settings?.workingContextTokens).toBeGreaterThanOrEqual(16_572);
    // 13,500 p99 + 2,048 answer + 1,024 thinking = 16,572, recorded on the profile.
    expect(profile?.settings?.promptNeedTokens).toBe(16_572);
    expect(lines.join("\n")).toMatch(/working context \d+ tokens/);
  });
});
