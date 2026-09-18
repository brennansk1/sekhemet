import { afterEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  createQwen38_27BAdapter,
  usageFromLlamaServer,
  usageFromOllama,
} from "../src/http_adapter.js";
import { reasoningForStep } from "../src/reasoning.js";
import { PrefixCacheMonitor, ThroughputMeter, measureThroughput } from "../src/telemetry.js";
import { fakeServer } from "./support/fake_server.js";

/** A llama-server b10809 non-streaming chat completion, trimmed to what we read. */
const llamaBody = (content: string, timings: Record<string, number>) => ({
  choices: [{ message: { content, reasoning_content: "I should think about it." } }],
  usage: { prompt_tokens: 1536, completion_tokens: 42 },
  timings,
});

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

describe("M18/M3: usage from llama-server timings", () => {
  it("reads cache_n and prompt_n into a hit rate and prefill/decode speed", () => {
    const u = usageFromLlamaServer(
      {
        cache_n: 1515,
        prompt_n: 21,
        prompt_ms: 350,
        prompt_per_second: 60,
        predicted_n: 42,
        predicted_ms: 6000,
        predicted_per_second: 7,
      },
      { prompt_tokens: 1536, completion_tokens: 42 },
    );
    expect(u).toEqual({
      promptTokens: 1536,
      completionTokens: 42,
      cachedPromptTokens: 1515,
      evaluatedPromptTokens: 21,
      cacheHitRate: 1515 / 1536,
      prefillMs: 350,
      decodeMs: 6000,
      prefillTokensPerSecond: 60,
      decodeTokensPerSecond: 7,
    });
  });

  it("falls back to usage.prompt_tokens_details.cached_tokens and derives speed from ms", () => {
    const u = usageFromLlamaServer(
      { predicted_n: 100, predicted_ms: 4000 },
      {
        prompt_tokens: 2000,
        completion_tokens: 100,
        prompt_tokens_details: { cached_tokens: 1500 },
      },
    );
    expect(u.cacheHitRate).toBe(0.75);
    expect(u.cachedPromptTokens).toBe(1500);
    expect(u.evaluatedPromptTokens).toBe(500);
    expect(u.decodeTokensPerSecond).toBe(25);
    expect(u.prefillTokensPerSecond).toBeUndefined();
  });

  it("does not report a prefill speed for a fully cached prompt", () => {
    const u = usageFromLlamaServer(
      { cache_n: 900, prompt_n: 1, prompt_ms: 20, prompt_per_second: 50 },
      undefined,
    );
    expect(u.cacheHitRate).toBe(900 / 901);
    expect(u.promptTokens).toBe(901);
    expect(u.prefillTokensPerSecond).toBeUndefined();
  });

  it("derives Ollama throughput from nanosecond durations and leaves the hit rate unknown", () => {
    const u = usageFromOllama({
      prompt_eval_count: 1200,
      prompt_eval_duration: 2_000_000_000,
      eval_count: 300,
      eval_duration: 10_000_000_000,
    });
    expect(u).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      prefillMs: 2000,
      decodeMs: 10000,
      prefillTokensPerSecond: 600,
      decodeTokensPerSecond: 30,
    });
  });

  it("exposes cacheHitRate and tok/s in the adapter's usage over HTTP", async () => {
    const srv = await fakeServer(() => ({
      json: llamaBody("<think>plan</think>done", {
        cache_n: 1515,
        prompt_n: 21,
        prompt_ms: 350,
        prompt_per_second: 60,
        predicted_n: 42,
        predicted_ms: 6000,
        predicted_per_second: 7,
      }),
    }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "openai",
      maxRetries: 0,
    });
    const res = await adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(res.text).toBe("done");
    expect(res.usage.cacheHitRate).toBe(1515 / 1536);
    expect(res.usage.cachedPromptTokens).toBe(1515);
    expect(res.usage.prefillTokensPerSecond).toBe(60);
    expect(res.usage.decodeTokensPerSecond).toBe(7);
    expect((srv.seen[0]?.body as Record<string, unknown>).cache_prompt).toBe(true);
  });
});

describe("M5/M6: planning sampling and per-request reasoning", () => {
  it("sends CHRONICLE code sampling by default and 0.7/0.8 for planning, reasoning off", async () => {
    const srv = await fakeServer(() => ({ json: llamaBody("ok", {}) }));
    closers.push(srv.close);
    const adapter = createQwen38_27BAdapter(srv.url);
    expect(adapter.contextWindow).toEqual({ contextTokens: 24576, maxTokens: 2048 });
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat", purpose: "planning" });
    const [code, plan] = srv.seen.map((s) => s.body as Record<string, unknown>);
    expect(code).toMatchObject({
      temperature: 0.2,
      top_p: 0.9,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.5,
      max_tokens: 2048,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(plan).toMatchObject({ temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5 });
    expect(code?.thinking_budget_tokens).toBeUndefined();
  });

  it("turns thinking on per request with a budget added to max_tokens, and strips it", async () => {
    const srv = await fakeServer(() => ({ json: llamaBody("answer", {}) }));
    closers.push(srv.close);
    const adapter = createQwen38_27BAdapter(srv.url);
    const res = await adapter.generate({
      prompt: "p",
      toolArm: "arm_a_flat",
      reasoning: "medium",
    });
    const body = srv.seen[0]?.body as Record<string, unknown>;
    expect(body.chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: "medium",
    });
    expect(body.reasoning_effort).toBe("medium");
    expect(body.thinking_budget_tokens).toBe(1024);
    expect(body.max_tokens).toBe(2048 + 1024);
    // reasoning_content never reaches the caller.
    expect(res.text).toBe("answer");
  });

  it("sends think:true to Ollama only when the request asks for reasoning", async () => {
    const srv = await fakeServer(() => ({
      json: { message: { content: "x", thinking: "hmm" }, prompt_eval_count: 10, eval_count: 2 },
    }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "dirk-27b:latest",
      baseUrl: srv.url,
      disableReasoning: true,
      maxRetries: 0,
    });
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await adapter.generate({
      prompt: "p",
      toolArm: "arm_a_flat",
      reasoning: "low",
      maxTokens: 100,
    });
    const chats = srv.seen
      .filter((s) => s.url === "/api/chat")
      .map((s) => s.body as { think: boolean; options: { num_predict: number } });
    expect(chats[0]?.think).toBe(false);
    expect(chats[1]?.think).toBe(true);
    expect(chats[1]?.options.num_predict).toBe(100 + 512);
  });

  it("reasoningForStep: off for mechanical steps and direct repair, on past rung 1 and for plans", () => {
    expect(reasoningForStep({ purpose: "mechanical" })).toEqual({
      reasoning: "off",
      reasoningBudgetTokens: 0,
    });
    expect(reasoningForStep({ purpose: "repair", rung: "direct_repair" }).reasoning).toBe("off");
    expect(reasoningForStep({ purpose: "repair", rung: "fresh_context" })).toEqual({
      reasoning: "low",
      reasoningBudgetTokens: 512,
    });
    expect(reasoningForStep({ purpose: "repair", rung: "edit_sketch" }).reasoning).toBe("medium");
    expect(reasoningForStep({ purpose: "repair", rung: "escalate" }).reasoning).toBe("medium");
    expect(reasoningForStep({ purpose: "planning" })).toEqual({
      reasoning: "medium",
      reasoningBudgetTokens: 1024,
    });
  });
});

describe("PrefixCacheMonitor and ThroughputMeter", () => {
  const usage = (cached: number, evaluated: number, extra = {}) => ({
    promptTokens: cached + evaluated,
    completionTokens: 50,
    durationMs: 1,
    cachedPromptTokens: cached,
    evaluatedPromptTokens: evaluated,
    cacheHitRate: cached / (cached + evaluated),
    ...extra,
  });

  it("alerts only on tool-result steps under 85% and weights the summary by tokens", () => {
    const alerts: number[] = [];
    const m = new PrefixCacheMonitor(undefined, (r) => alerts.push(r.step));
    m.record(1, "first", usage(0, 3000)); // cold: never an alert
    m.record(2, "tool_result", usage(2900, 100)); // 96.7%
    m.record(3, "tool_result", usage(1000, 2000)); // 33%: the prefix broke
    m.record(4, "tool_result", { promptTokens: 10, completionTokens: 1, durationMs: 1 });
    expect(alerts).toEqual([3]);
    expect(m.summary()).toEqual({
      steps: 3,
      hitRate: 3900 / 9000,
      toolResultHitRate: 3900 / 6000,
      alerts: 1,
      unmeasured: 1,
    });
  });

  it("aggregates token-weighted prefill/decode speed per model and predicts a request", () => {
    const meter = new ThroughputMeter();
    meter.record("dirk", {
      ...usage(0, 600),
      prefillMs: 10_000,
      prefillTokensPerSecond: 60,
      decodeMs: 10_000,
      decodeTokensPerSecond: 5,
    });
    meter.record("dirk", {
      ...usage(0, 1200),
      completionTokens: 150,
      prefillMs: 10_000,
      prefillTokensPerSecond: 120,
      decodeMs: 20_000,
      decodeTokensPerSecond: 7.5,
    });
    meter.record("dirk", { promptTokens: 5, completionTokens: 5, durationMs: 1 });
    expect(meter.get("dirk")).toEqual({
      modelId: "dirk",
      requests: 3,
      prefillTokens: 1800,
      prefillMs: 20_000,
      decodeTokens: 200,
      decodeMs: 30_000,
      prefillTokensPerSecond: 90,
      decodeTokensPerSecond: 6.67,
    });
    expect(meter.predictMs("dirk", 900, 20)).toBe(Math.round((900 / 90 + 20 / 6.67) * 1000));
    expect(meter.predictMs("other", 1, 1)).toBeUndefined();
  });

  it("measureThroughput wraps an adapter so each response feeds the meter and monitor", async () => {
    const srv = await fakeServer(() => ({
      json: llamaBody("ok", {
        cache_n: 900,
        prompt_n: 100,
        prompt_ms: 1000,
        predicted_n: 42,
        predicted_ms: 2000,
      }),
    }));
    closers.push(srv.close);
    const meter = new ThroughputMeter();
    const cache = new PrefixCacheMonitor();
    const adapter = measureThroughput(
      new HttpInferenceAdapter({ modelId: "w", baseUrl: srv.url, apiFormat: "openai" }),
      meter,
      cache,
    );
    await adapter.generate({ prompt: "a", toolArm: "arm_a_flat" });
    await adapter.generate({ prompt: "b", toolArm: "arm_a_flat" });
    expect(cache.steps().map((s) => s.kind)).toEqual(["first", "tool_result"]);
    expect(cache.summary().toolResultHitRate).toBe(0.9);
    expect(meter.get("w")?.prefillTokensPerSecond).toBe(100);
    expect(meter.get("w")?.decodeTokensPerSecond).toBe(21);
  });
});
