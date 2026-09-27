import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  KvPolicyError,
  ManagedLlamaServerAdapter,
  ModelUnavailableError,
  ResidencyScheduler,
  assertKvPolicy,
  constrainedToolSchema,
  modelTelemetry,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

/** A server that answers every POST with `chunks`, written one by one. */
async function streamingServer(
  contentType: string,
  chunks: string[],
): Promise<{ url: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", async () => {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      bodies.push(raw ? JSON.parse(raw) : undefined);
      res.writeHead(200, { "content-type": contentType });
      for (const chunk of chunks) {
        res.write(chunk);
        await new Promise((r) => setTimeout(r, 2));
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe("M2: token streaming", () => {
  it("streams OpenAI-compatible SSE deltas, assembling text, tool calls and timings", async () => {
    const { url, bodies } = await streamingServer("text/event-stream", [
      sse({ choices: [{ delta: { reasoning_content: "hmm" } }] }),
      sse({ choices: [{ delta: { content: "Hel" } }] }),
      sse({ choices: [{ delta: { content: "lo" } }] }),
      sse({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "c1", function: { name: "read_file", arguments: '{"pa' } },
              ],
            },
          },
        ],
      }),
      sse({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
        ],
      }),
      sse({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 100, completion_tokens: 7 },
        timings: { cache_n: 90, prompt_n: 10, prompt_ms: 100, predicted_n: 7, predicted_ms: 700 },
      }),
      "data: [DONE]\n\n",
    ]);
    const adapter = new HttpInferenceAdapter({ modelId: "m", baseUrl: url, apiFormat: "openai" });
    const deltas: string[] = [];
    const res = await adapter.generate({
      prompt: "hi",
      toolArm: "arm_a_flat",
      tools: [{ name: "read_file", description: "read", parameters: {} }],
      onToken: (d) => deltas.push(d),
    });
    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(res.text).toBe("Hello");
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toMatchObject({
      id: "c1",
      name: "read_file",
      arguments: { path: "a.ts" },
    });
    expect(res.usage.cacheHitRate).toBeCloseTo(0.9);
    expect(res.usage.completionTokens).toBe(7);
  });

  it("streams Ollama NDJSON, including a tool call and final counts", async () => {
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const { url, bodies } = await streamingServer("application/x-ndjson", [
      line({ message: { role: "assistant", content: "Wor" }, done: false }),
      line({ message: { role: "assistant", content: "ld" }, done: false }),
      line({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "check", arguments: { gate: "test" } } }],
        },
        done: false,
      }),
      line({
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 50,
        prompt_eval_duration: 5e8,
        eval_count: 4,
        eval_duration: 2e8,
      }),
    ]);
    const adapter = new HttpInferenceAdapter({ modelId: "o", baseUrl: url, apiFormat: "ollama" });
    const deltas: string[] = [];
    const res = await adapter.generate({
      prompt: "hi",
      toolArm: "arm_a_flat",
      onToken: (d) => deltas.push(d),
    });
    expect((bodies[0] as { stream: boolean }).stream).toBe(true);
    expect(deltas.join("")).toBe("World");
    expect(res.text).toBe("World");
    expect(res.toolCalls[0]).toMatchObject({ name: "check", arguments: { gate: "test" } });
    expect(res.usage.promptTokens).toBe(50);
    expect(res.usage.decodeTokensPerSecond).toBe(20);
  });

  it("does not stream when no onToken is given", async () => {
    const srv = await fakeServer(() => ({
      json: { choices: [{ message: { content: "x" } }] },
    }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "openai",
    });
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect((srv.seen[0]?.body as { stream: boolean }).stream).toBe(false);
  });
});

describe("M4: adapter healthCheck contract", () => {
  it("Ollama: reachable, available and loaded come from /api/tags and /api/ps", async () => {
    const srv = await fakeServer((req) => ({
      json:
        req.url === "/api/tags"
          ? { models: [{ name: "nail:latest" }] }
          : req.url === "/api/ps"
            ? { models: [] }
            : {},
    }));
    closers.push(srv.close);
    const ok = await new HttpInferenceAdapter({ modelId: "nail", baseUrl: srv.url }).healthCheck();
    expect(ok).toMatchObject({ ok: true, reachable: true, loaded: false, modelId: "nail" });
    const missing = await new HttpInferenceAdapter({
      modelId: "absent",
      baseUrl: srv.url,
    }).healthCheck();
    expect(missing.ok).toBe(false);
    expect(missing.detail).toMatch(/not available/);
  });

  it("OpenAI-compatible: /health answers", async () => {
    const srv = await fakeServer(() => ({ json: { status: "ok" } }));
    closers.push(srv.close);
    const h = await new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "openai",
    }).healthCheck();
    expect(h).toMatchObject({ ok: true, reachable: true, loaded: true });
  });

  it("an unreachable server is not ok", async () => {
    const h = await new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: "http://127.0.0.1:9",
      apiFormat: "openai",
    }).healthCheck();
    expect(h).toMatchObject({ ok: false, reachable: false });
  });

  it("a managed server that is down is ok only when it can be started", async () => {
    const missing = new ManagedLlamaServerAdapter({
      modelId: "x",
      modelPath: "/nonexistent/model.gguf",
      port: 9,
    });
    const h = await missing.healthCheck();
    expect(h).toMatchObject({ ok: false, reachable: false, loaded: false });
    expect(h.detail).toMatch(/model file/);
  });

  it("the scheduler refuses a role whose model is unavailable, with a typed error", async () => {
    const router = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
      usableBytes: 16 * 1024 ** 3,
      weights: {
        w: {
          footprintBytes: 1,
          build: () => ({
            modelId: "w",
            supportedArms: ["arm_a_flat"],
            generate: async () => ({ text: "", toolCalls: [], usage: {} as never }),
            healthCheck: async () => ({
              ok: false,
              modelId: "w",
              reachable: true,
              loaded: false,
              latencyMs: 1,
              detail: "model w is not available on the server",
            }),
          }),
        },
      },
    });
    await expect(router.acquire("worker")).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});

describe("M16: 4-bit KV is refused for tool-calling models", () => {
  it("rejects q4 KV in launch args, including via extraArgs", () => {
    expect(() => assertKvPolicy(["-ctk", "q4_0", "-ctv", "q8_0"])).toThrow(KvPolicyError);
    expect(() => assertKvPolicy(["--cache-type-v", "q4_1"])).toThrow(KvPolicyError);
    expect(() => assertKvPolicy(["-ctk", "q8_0", "-ctv", "f16"])).not.toThrow();
    // Lower than 8-bit but above 4-bit needs a qualification pass with it.
    expect(() => assertKvPolicy(["-ctk", "q5_1"])).toThrow(/qualif/);
    expect(() => assertKvPolicy(["-ctk", "q5_1"], { qualifiedBelow8Bit: true })).not.toThrow();
    // A model that never calls tools may use 4-bit.
    expect(() => assertKvPolicy(["-ctk", "q4_0"], { toolCalling: false })).not.toThrow();
  });

  it("the managed adapter's launch args enforce it", () => {
    const a = new ManagedLlamaServerAdapter({
      modelId: "x",
      modelPath: "/m.gguf",
      extraArgs: ["-ctk", "q4_0"],
    });
    expect(() => a.launchArgs()).toThrow(KvPolicyError);
  });

  it("the Ollama path refuses tool requests when the server's KV is 4-bit", async () => {
    const srv = await fakeServer(() => ({ json: { message: { content: "x" } } }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "o",
      baseUrl: srv.url,
      ollamaKvCacheType: "q4_0",
    });
    await expect(
      adapter.generate({
        prompt: "p",
        toolArm: "arm_a_flat",
        tools: [{ name: "t", description: "", parameters: {} }],
      }),
    ).rejects.toBeInstanceOf(KvPolicyError);
    expect(srv.seen.filter((s) => s.method === "POST")).toHaveLength(0);
  });
});

describe("M8: grammar-constrained tool calls on llama-server", () => {
  const tools = [
    {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    { name: "done", description: "finish", parameters: { type: "object", properties: {} } },
  ];

  it("builds a json_schema that admits only known tools or a message", () => {
    const schema = constrainedToolSchema(tools) as {
      properties: { tool_calls: { items: { anyOf: unknown[] } } };
    };
    expect(schema.properties.tool_calls.items.anyOf).toHaveLength(2);
    expect(JSON.stringify(schema)).toContain('"const":"read_file"');
  });

  it("sends response_format json_schema and parses the constrained reply", async () => {
    const srv = await fakeServer(() => ({
      json: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                message: "reading",
                tool_calls: [{ name: "read_file", arguments: { path: "a.ts" } }],
              }),
            },
          },
        ],
      },
    }));
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "openai",
      constrainedToolCalls: true,
    });
    const res = await adapter.generate({ prompt: "p", toolArm: "arm_a_flat", tools });
    const body = srv.seen[0]?.body as { response_format?: { type: string }; tools?: unknown };
    expect(body.response_format?.type).toBe("json_schema");
    expect(body.tools).toBeUndefined();
    expect(res.toolCalls[0]).toMatchObject({ name: "read_file", arguments: { path: "a.ts" } });
    expect(res.text).toBe("reading");
  });

  it("falls back to native tools when the server rejects json_schema", async () => {
    let calls = 0;
    const srv = await fakeServer((_req, body) => {
      calls++;
      if ((body as { response_format?: unknown }).response_format) {
        return { status: 400, json: { error: "json_schema not supported" } };
      }
      return {
        json: {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [{ id: "1", function: { name: "done", arguments: "{}" } }],
              },
            },
          ],
        },
      };
    });
    closers.push(srv.close);
    const adapter = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "openai",
      constrainedToolCalls: true,
      maxRetries: 0,
    });
    const res = await adapter.generate({ prompt: "p", toolArm: "arm_a_flat", tools });
    expect(res.toolCalls[0]?.name).toBe("done");
    expect(calls).toBe(2);
    // Remembered: the next request goes straight to native tools.
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat", tools });
    expect(calls).toBe(3);
  });
});

describe("M3/M18 in production: every adapter feeds the shared telemetry", () => {
  it("records throughput and cache hit rate per request, alerting on tool-result steps", async () => {
    const srv = await fakeServer(() => ({
      json: {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1000, completion_tokens: 10 },
        timings: {
          cache_n: 500,
          prompt_n: 500,
          prompt_ms: 1000,
          predicted_n: 10,
          predicted_ms: 1000,
        },
      },
    }));
    closers.push(srv.close);
    modelTelemetry.reset();
    const alerts: number[] = [];
    const adapter = new HttpInferenceAdapter({
      modelId: "tele",
      baseUrl: srv.url,
      apiFormat: "openai",
      onCacheAlert: (r) => alerts.push(r.step),
    });
    await adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await adapter.generate({
      prompt: "",
      toolArm: "arm_a_flat",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: {} }] },
        { role: "tool", content: "result", toolCallId: "1" },
      ],
    });
    const snap = modelTelemetry.snapshot();
    const t = snap.throughput.find((s) => s.modelId === "tele");
    expect(t?.requests).toBe(2);
    expect(t?.prefillTokensPerSecond).toBe(500);
    expect(t?.decodeTokensPerSecond).toBe(10);
    expect(snap.cache.tele?.steps).toBe(2);
    expect(alerts).toEqual([2]);
  });
});

describe("an adapter says whether its server is on this machine", () => {
  it("is remote only for a base URL that is not a loopback address", async () => {
    const { HttpInferenceAdapter } = await import("../src/http_adapter.js");
    expect(new HttpInferenceAdapter({ modelId: "m" }).remote).toBe(false);
    expect(
      new HttpInferenceAdapter({ modelId: "m", baseUrl: "http://localhost:8098" }).remote,
    ).toBe(false);
    expect(new HttpInferenceAdapter({ modelId: "m", baseUrl: "http://[::1]:8098" }).remote).toBe(
      false,
    );
    expect(
      new HttpInferenceAdapter({ modelId: "m", baseUrl: "https://gpu.example.com/v1" }).remote,
    ).toBe(true);
  });
});
