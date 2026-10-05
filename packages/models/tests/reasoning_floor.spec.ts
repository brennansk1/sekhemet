import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  ModelRegistry,
  REASONING_BUDGET_TOKENS,
  reasoningFromArchitecture,
  registerModelFile,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";
import { writeGguf } from "./support/gguf_fixture.js";

/**
 * Live-test F25 (MD-N4-2, worker-loop rule 22): gpt-oss cannot turn its
 * reasoning off — its harmony format takes low, medium or high — so a
 * request that asked for none thought anyway, spent 1,072 of its 1,200
 * tokens thinking and was cut off. A model whose template cannot disable
 * reasoning records that and its lowest level; "off" resolves to that floor,
 * whose thinking allowance is added to max_tokens. A reply that thinks on
 * a request resolved to off is recorded, so the next request budgets for it.
 * No model is loaded: an OpenAI-compatible fake server answers.
 */

let dir: string;
let registry: ModelRegistry;
const closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-f25-"));
  registry = new ModelRegistry(join(dir, "models.json"));
});
afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  rmSync(dir, { recursive: true, force: true });
});

/** An OpenAI-compatible server answering every chat request with `usage`. */
async function openAi(reasoningTokens: number) {
  const srv = await fakeServer((req) =>
    req.url === "/v1/chat/completions"
      ? {
          json: {
            choices: [
              {
                message: { content: '{"ok":true}', reasoning_content: "t ".repeat(40) },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: reasoningTokens + 10,
              completion_tokens_details: { reasoning_tokens: reasoningTokens },
            },
          },
        }
      : { status: 404, json: {} },
  );
  closers.push(srv.close);
  const posts = () =>
    srv.seen
      .filter((s) => s.url === "/v1/chat/completions")
      .map((s) => s.body as Record<string, unknown>);
  return { srv, posts };
}

const adapterFor = (url: string, modelId: string, reg?: ModelRegistry) =>
  new HttpInferenceAdapter({
    modelId,
    baseUrl: url,
    apiFormat: "openai",
    disableReasoning: true,
    telemetry: false,
    memoryAware: false,
    ...(reg ? { registry: reg } : {}),
  });

describe("a template that cannot turn reasoning off (F25, MD-N4-2)", () => {
  it("is a rule by architecture, not a model name: gpt-oss's floor is low", () => {
    expect(reasoningFromArchitecture("gpt-oss")).toMatchObject({
      supported: true,
      cannotDisable: true,
      floor: "low",
    });
    expect(reasoningFromArchitecture("qwen3moe")).toBeUndefined();
    expect(reasoningFromArchitecture(undefined)).toBeUndefined();
  });

  it("`models add` records it from the GGUF header's architecture", async () => {
    const oss = writeGguf(join(dir, "gpt-oss-20b-Q4_K_M.gguf"), {
      architecture: "gpt-oss",
      name: "gpt-oss-20b",
    });
    const r = await registerModelFile(registry, oss);
    expect(registry.get(r.id)?.reasoning).toMatchObject({ cannotDisable: true, floor: "low" });
    const qwen = writeGguf(join(dir, "q.gguf"), { architecture: "qwen3moe", name: "Q" });
    const q = await registerModelFile(registry, qwen);
    expect(registry.get(q.id)?.reasoning).toBeUndefined();
  });

  // The R3b run (2026-10-04): gpt-oss-20b was registered before F25, so its
  // record has the header's architecture but no `reasoning`. Every review then
  // asked for "none", which gpt-oss ignores, and thought until its answer
  // allowance was gone: 0 answer tokens, every review failed.
  it("applies the floor to a model registered before F25, from its recorded architecture", async () => {
    const file = join(dir, "old.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        models: [{ id: "gpt-oss-20b", header: { architecture: "gpt-oss", contextLength: 131072 } }],
      }),
    );
    const old = new ModelRegistry(file);
    expect(old.get("gpt-oss-20b")?.reasoning).toMatchObject({ cannotDisable: true, floor: "low" });
    const { srv, posts } = await openAi(300);
    const a = adapterFor(srv.url, "gpt-oss-20b", old);
    expect(a.reasoningFor({ reasoning: "off" })).toBe("low");
    await a.generate({
      prompt: "review",
      toolArm: "arm_b_json",
      maxTokens: 1200,
      reasoning: "off",
      reasoningBudgetTokens: 2048,
    });
    expect(posts()[0]).toMatchObject({
      reasoning_effort: "low",
      max_tokens: 1200 + 2048,
      thinking_budget_tokens: 2048,
    });
  });

  it("resolves a request for no reasoning to the floor, and budgets its thinking", async () => {
    const { srv, posts } = await openAi(300);
    registry.upsert("gpt-oss-20b", {
      header: { architecture: "gpt-oss" },
      reasoning: reasoningFromArchitecture("gpt-oss"),
    });
    const a = adapterFor(srv.url, "gpt-oss-20b", registry);
    expect(a.reasoningFor({})).toBe("low");
    expect(a.reasoningFor({ reasoning: "off" })).toBe("low");
    expect(a.reasoningFor({ reasoning: "high" })).toBe("high");

    // The Reviewer's shape: an answer cap and an explicit thinking cap.
    await a.generate({
      prompt: "review",
      toolArm: "arm_b_json",
      maxTokens: 1200,
      reasoning: "off",
      reasoningBudgetTokens: 2048,
    });
    // A Worker step with reasoning off states a zero allowance: the floor's default applies.
    await a.generate({ prompt: "step", toolArm: "arm_a_flat", maxTokens: 1200 });
    const [review, step] = posts();
    expect(review).toMatchObject({
      reasoning_effort: "low",
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
      max_tokens: 1200 + 2048,
      thinking_budget_tokens: 2048,
    });
    expect(step?.max_tokens).toBe(1200 + REASONING_BUDGET_TOKENS.low);
    expect(JSON.stringify(posts())).not.toContain('"none"');
  });

  it("a zero stated allowance on a model forced to its floor still leaves room to think", async () => {
    const { srv, posts } = await openAi(300);
    registry.upsert("oss", { reasoning: reasoningFromArchitecture("gpt-oss") });
    const a = adapterFor(srv.url, "oss", registry);
    await a.generate({
      prompt: "step",
      toolArm: "arm_a_flat",
      maxTokens: 1000,
      reasoning: "off",
      reasoningBudgetTokens: 0,
    });
    expect(posts()[0]?.max_tokens).toBe(1000 + REASONING_BUDGET_TOKENS.low);
  });
});

describe("thinking on a request resolved to off is recorded (F25, unknown models)", () => {
  it("notes it in the registry, and the next request budgets for it", async () => {
    const { srv, posts } = await openAi(1072);
    const a = adapterFor(srv.url, "mystery", registry);
    await a.generate({ prompt: "one", toolArm: "arm_b_json", maxTokens: 1200 });
    expect(posts()[0]?.max_tokens).toBe(1200);
    expect(posts()[0]?.reasoning_effort).toBe("none");
    // Measured, apart from the reasoning record: an unmeasured model is not made `supported`.
    expect(registry.get("mystery")?.thinksWhenOff?.tokens).toBe(1072);
    expect(registry.get("mystery")?.reasoning).toBeUndefined();

    await a.generate({ prompt: "two", toolArm: "arm_b_json", maxTokens: 1200 });
    expect(posts()[1]?.max_tokens).toBe(1200 + 1072);
    // A stated cap larger than what was seen is the allowance.
    await a.generate({
      prompt: "three",
      toolArm: "arm_b_json",
      maxTokens: 1200,
      reasoning: "off",
      reasoningBudgetTokens: 2048,
    });
    expect(posts()[2]?.max_tokens).toBe(1200 + 2048);

    // A new adapter for the same model reads the note from the registry.
    const b = adapterFor(srv.url, "mystery", registry);
    await b.generate({ prompt: "four", toolArm: "arm_b_json", maxTokens: 1200 });
    expect(posts()[3]?.max_tokens).toBe(1200 + 1072);
  });

  it("remembers it without a registry, and ignores an empty think block", async () => {
    const { srv, posts } = await openAi(1072);
    const a = adapterFor(srv.url, "no-registry");
    await a.generate({ prompt: "one", toolArm: "arm_b_json", maxTokens: 500 });
    await a.generate({ prompt: "two", toolArm: "arm_b_json", maxTokens: 500 });
    expect(posts()[1]?.max_tokens).toBe(500 + 1072);

    const quiet = await openAi(2);
    const c = adapterFor(quiet.srv.url, "quiet", registry);
    await c.generate({ prompt: "one", toolArm: "arm_b_json", maxTokens: 500 });
    await c.generate({ prompt: "two", toolArm: "arm_b_json", maxTokens: 500 });
    expect(quiet.posts()[1]?.max_tokens).toBe(500);
    expect(registry.get("quiet")?.thinksWhenOff).toBeUndefined();
  });

  it("learns only from thinking the server reports, never from `</think>` in the answer", async () => {
    // Code that holds a think block, and a server that reports no thinking.
    const code = `const tag = "<think>${"x ".repeat(400)}</think>";\n{"ok":true}`;
    const srv = await fakeServer((req) =>
      req.url === "/v1/chat/completions"
        ? {
            json: {
              choices: [{ message: { content: code }, finish_reason: "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 300 },
            },
          }
        : { status: 404, json: {} },
    );
    closers.push(srv.close);
    const a = adapterFor(srv.url, "coder", registry);
    await a.generate({ prompt: "one", toolArm: "arm_b_json", maxTokens: 500 });
    await a.generate({ prompt: "two", toolArm: "arm_b_json", maxTokens: 500 });
    const sent = srv.seen
      .filter((x) => x.url === "/v1/chat/completions")
      .map((x) => (x.body as { max_tokens?: number }).max_tokens);
    expect(sent).toEqual([500, 500]);
    expect(registry.get("coder")?.thinksWhenOff).toBeUndefined();
  });
});

describe("an owner's own reasoning entry is kept (F25)", () => {
  it("`models add` does not override a manual supported:false or floor", async () => {
    const oss = writeGguf(join(dir, "gpt-oss-20b-Q4_K_M.gguf"), {
      architecture: "gpt-oss",
      name: "gpt-oss-20b",
    });
    registry.upsert("gpt-oss-20b", {
      reasoning: { supported: false, defaultBudget: 0, stripTraces: true },
    });
    await registerModelFile(registry, oss);
    expect(registry.get("gpt-oss-20b")?.reasoning?.supported).toBe(false);

    registry.upsert("oss-medium", {
      reasoning: { supported: true, defaultBudget: 0, stripTraces: true, floor: "medium" },
    });
    await registerModelFile(registry, oss, { id: "oss-medium" });
    expect(registry.get("oss-medium")?.reasoning).toMatchObject({
      cannotDisable: true,
      floor: "medium",
    });
  });
});

describe("the thinking a request would add, for a caller budgeting a window (F25)", () => {
  it("is nothing on a model that never thinks, and the stated cap on one forced to its floor", () => {
    registry.upsert("oss", { reasoning: reasoningFromArchitecture("gpt-oss") });
    const req = { reasoning: "off" as const, reasoningBudgetTokens: 2048 };
    expect(adapterFor("http://127.0.0.1:9", "plain", registry).thinkingAllowance(req)).toBe(0);
    expect(adapterFor("http://127.0.0.1:9", "oss", registry).thinkingAllowance(req)).toBe(2048);
  });
});

describe("Ollama takes a level from a model that cannot turn reasoning off (F25)", () => {
  it('sends `think: "low"` for gpt-oss asked for none, and `think: false` otherwise', async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/chat"
        ? {
            json: {
              message: { content: '{"ok":true}', thinking: "brief" },
              done: true,
              done_reason: "stop",
              eval_count: 20,
              prompt_eval_count: 10,
            },
          }
        : { status: 404, json: {} },
    );
    closers.push(srv.close);
    registry.upsert("gpt-oss:20b", { reasoning: reasoningFromArchitecture("gpt-oss") });
    const ollama = (modelId: string) =>
      new HttpInferenceAdapter({
        modelId,
        baseUrl: srv.url,
        apiFormat: "ollama",
        disableReasoning: true,
        telemetry: false,
        memoryAware: false,
        registry,
      });
    await ollama("gpt-oss:20b").generate({
      prompt: "review",
      toolArm: "arm_b_json",
      maxTokens: 1200,
      reasoning: "off",
      reasoningBudgetTokens: 2048,
    });
    await ollama("qwen3:8b").generate({ prompt: "step", toolArm: "arm_b_json", maxTokens: 1200 });
    const [oss, qwen] = srv.seen
      .filter((x) => x.url === "/api/chat")
      .map((x) => x.body as { think?: unknown; options?: { num_predict?: number } });
    expect(oss?.think).toBe("low");
    expect(oss?.options?.num_predict).toBe(1200 + 2048);
    expect(qwen?.think).toBe(false);
    expect(qwen?.options?.num_predict).toBe(1200);
  });
});
