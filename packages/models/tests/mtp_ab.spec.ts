import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mtpStepAB, signTestP } from "../src/calibration.js";
import { ModelRegistry } from "../src/registry.js";
import type { InferenceRequest, LocalInferenceAdapter } from "../src/types.js";

/** MD-M11-1/2: MTP decided on paired seconds per replayed Worker step. */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** Every request both servers saw, in the order they saw them: "plain step 1", ... */
let order: string[] = [];

/** A server whose per-step prefill and decode milliseconds are scripted. */
function timed(
  steps: { prefillMs: number; decodeMs: number; draft?: [number, number] }[],
  label = "server",
): LocalInferenceAdapter & { seen: InferenceRequest[] } {
  const seen: InferenceRequest[] = [];
  return {
    modelId: "w",
    seen,
    async generate(req: InferenceRequest) {
      const s = steps[seen.length % steps.length] as (typeof steps)[number];
      seen.push(req);
      order.push(`${label} ${req.prompt}`);
      return {
        text: "",
        toolCalls: [],
        usage: {
          promptTokens: 1000,
          completionTokens: 50,
          durationMs: s.prefillMs + s.decodeMs,
          prefillMs: s.prefillMs,
          decodeMs: s.decodeMs,
          ...(s.draft ? { draftTokens: s.draft[0], draftAcceptedTokens: s.draft[1] } : {}),
        },
      };
    },
  } as unknown as LocalInferenceAdapter & { seen: InferenceRequest[] };
}

/** Thirty recorded steps: the default minimum the A/B decides on (A6). */
const recorded: InferenceRequest[] = Array.from({ length: 30 }, (_, i) => ({
  systemPrompt: "sys",
  prompt: `step ${i + 1}`,
  tools: [],
}));
const prompts = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `step ${from + i}`);

describe("mtpStepAB", () => {
  it("replays every recorded step on both servers and reports per-step seconds", async () => {
    const plain = timed([{ prefillMs: 1000, decodeMs: 3000 }]);
    const spec = timed([{ prefillMs: 1000, decodeMs: 2000, draft: [40, 30] }]);
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain,
      speculative: spec,
      thinking: "off",
    });
    // Each timed block opens with a discarded warm-up of its first step.
    expect(plain.seen.map((q) => q.prompt)).toEqual([
      "step 1",
      ...prompts(1, 15),
      "step 16",
      ...prompts(16, 30),
    ]);
    expect(spec.seen.map((q) => q.prompt)).toEqual([
      "step 1",
      ...prompts(1, 15),
      "step 16",
      ...prompts(16, 30),
    ]);
    expect(r.steps[0]).toMatchObject({
      plain: { prefillSeconds: 1, decodeSeconds: 3, totalSeconds: 4 },
      speculative: { prefillSeconds: 1, decodeSeconds: 2, totalSeconds: 3, draftAcceptance: 0.75 },
    });
    expect(r.enabled).toBe(true);
    expect(r.speedup).toBeCloseTo(4 / 3, 5);
    // Tokens per verify step: 50 tokens, 30 of them accepted drafts, so 20 verify steps.
    expect(r.steps[0]?.speculative.tokensPerVerifyStep).toBeCloseTo(2.5, 5);
  });

  it("A6: orders the replay ABBA, so drift over the run cancels", async () => {
    order = [];
    const plain = timed([{ prefillMs: 1000, decodeMs: 3000 }], "plain");
    const spec = timed([{ prefillMs: 1000, decodeMs: 2000 }], "spec");
    await mtpStepAB({ modelId: "w", steps: recorded, plain, speculative: spec, thinking: "off" });
    const block = (who: string, from: number, to: number) =>
      prompts(from, to).map((p) => `${who} ${p}`);
    // Every block opens with an untimed warm-up of its first step, on both
    // sides, so neither pays a cold cache the other does not (M11).
    expect(order).toEqual([
      "plain step 1",
      ...block("plain", 1, 15),
      "spec step 1",
      ...block("spec", 1, 15),
      "spec step 16",
      ...block("spec", 16, 30),
      "plain step 16",
      ...block("plain", 16, 30),
    ]);
  });

  it("A6: needs 30 steps by default", async () => {
    await expect(
      mtpStepAB({
        modelId: "w",
        steps: recorded.slice(0, 12),
        plain: timed([{ prefillMs: 1, decodeMs: 1 }]),
        speculative: timed([{ prefillMs: 1, decodeMs: 1 }]),
        thinking: "off",
      }),
    ).rejects.toThrow(/12 recorded steps; the A\/B needs at least 30/);
  });

  it("A6: stays off when the sign test cannot tell the servers apart", async () => {
    // Faster on 16 steps, slower on 14: a coin could do that.
    const plain = timed([{ prefillMs: 1000, decodeMs: 3000 }]);
    const spec = timed(
      Array.from({ length: 30 }, (_, i) => ({ prefillMs: 1000, decodeMs: i < 16 ? 2000 : 4000 })),
    );
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain,
      speculative: spec,
      thinking: "off",
    });
    expect(r.enabled).toBe(false);
    expect(r.signTestP).toBeGreaterThan(0.05);
    expect(r.reason).toMatch(/sign test p = 0\.\d+/);
  });

  it("A6: stays off when every step is faster but by less than the 2% margin", async () => {
    const plain = timed([{ prefillMs: 1000, decodeMs: 3000 }]);
    const spec = timed([{ prefillMs: 1000, decodeMs: 2960 }]);
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain,
      speculative: spec,
      thinking: "off",
    });
    expect(r.signTestP).toBeLessThan(0.05);
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/under the 2% margin/);
  });

  it("A6: writes every step's timings to an evidence file and returns its path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-ab-ev-"));
    dirs.push(dir);
    const reg = new ModelRegistry(join(dir, "models.json"));
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain: timed([{ prefillMs: 1000, decodeMs: 3000 }]),
      speculative: timed([{ prefillMs: 1000, decodeMs: 2000 }]),
      thinking: "off",
      registry: reg,
    });
    expect(r.evidencePath).toMatch(/evidence\/mtp-ab-w-off-\d{4}-\d{2}-\d{2}/);
    expect(existsSync(r.evidencePath as string)).toBe(true);
    const saved = JSON.parse(readFileSync(r.evidencePath as string, "utf8"));
    expect(saved.steps).toHaveLength(30);
    expect(saved).toMatchObject({ modelId: "w", thinking: "off", enabled: true });
  });

  it("keeps MTP off, with the speed-up and reason, when steps are not faster (MD-M11-2)", async () => {
    const reg = new ModelRegistry(join(mkdtempSync(join(tmpdir(), "sek-ab-")), "models.json"));
    const plain = timed([{ prefillMs: 1000, decodeMs: 2000 }]);
    // Faster decode but a slower prefill: slower per step overall.
    const spec = timed([{ prefillMs: 1600, decodeMs: 1600, draft: [40, 10] }]);
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain,
      speculative: spec,
      thinking: "surgical",
      registry: reg,
    });
    expect(r.enabled).toBe(false);
    expect(r.reason).toMatch(/not faster per step/);
    const d = reg.get("w")?.speculativeByPolicy?.surgical;
    expect(d).toMatchObject({ enabled: false, thinking: "surgical" });
    expect(d?.speedup).toBeCloseTo(3 / 3.2, 5);
  });

  it("measures nothing without recorded steps", async () => {
    await expect(
      mtpStepAB({
        modelId: "w",
        steps: [],
        plain: timed([]),
        speculative: timed([]),
        thinking: "off",
      }),
    ).rejects.toThrow(/no recorded Worker steps/);
  });
});

describe("the A/B's own checks (B2.2 confirmation, M11)", () => {
  it("refuses to start while a server already answers on the port", async () => {
    const plain = timed([{ prefillMs: 1000, decodeMs: 3000 }]);
    const spec = timed([{ prefillMs: 1000, decodeMs: 2000 }]);
    await expect(
      mtpStepAB({
        modelId: "w",
        steps: recorded,
        plain,
        speculative: spec,
        thinking: "off",
        portBusy: async () => "a server already answers /health on port 8098",
      }),
    ).rejects.toThrow(/already answers \/health on port 8098: stop it first/);
    expect(plain.seen).toHaveLength(0);
  });

  it("computes the sign test in log space for large samples", () => {
    expect(signTestP(0, 2000)).toBe(1);
    expect(signTestP(1000, 2000)).toBeGreaterThan(0.49);
    expect(signTestP(1000, 2000)).toBeLessThan(0.52);
    const all = signTestP(1100, 1100);
    expect(Number.isFinite(all)).toBe(true);
    expect(all).toBeLessThan(1e-300 * 10);
    // Small n agrees with the exact sum.
    expect(signTestP(9, 10)).toBeCloseTo(11 / 1024, 10);
  });

  it("uses wall time for a step that reports only one of prefill or decode", async () => {
    const half: LocalInferenceAdapter = {
      modelId: "w",
      async generate() {
        await new Promise((r) => setTimeout(r, 5));
        return {
          text: "",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1, prefillMs: 1 },
        };
      },
    } as unknown as LocalInferenceAdapter;
    const r = await mtpStepAB({
      modelId: "w",
      steps: recorded,
      plain: half,
      speculative: half,
      thinking: "off",
    });
    expect(r.steps[0]?.plain.totalSeconds).toBeGreaterThan(0.004);
  });
});
