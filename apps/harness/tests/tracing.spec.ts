import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InferenceRequest, LocalInferenceAdapter } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import { Tracer, toOtlp, traced, tracesCommand } from "../src/tracing.js";

describe("OpenTelemetry spans in SQLite (H22)", () => {
  it("records parent and child spans and model calls with GenAI attributes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trace-"));
    const tracer = Tracer.forRepo(repo);
    const card = tracer.start("card.run", { "sekhemet.card.id": "c1" });
    const model: LocalInferenceAdapter = {
      modelId: "cyber-tiel",
      supportedArms: ["arm_a_flat"],
      async generate(_req: InferenceRequest) {
        return {
          text: "",
          toolCalls: [],
          usage: {
            promptTokens: 1200,
            completionTokens: 80,
            durationMs: 900,
            prefillTokensPerSecond: 410.4,
            decodeTokensPerSecond: 27.26,
            cacheHitRate: 0.934,
          },
        };
      },
    };
    const m = traced(model, tracer, () => card.context);
    expect(m.modelId).toBe("cyber-tiel"); // everything but generate passes through
    await m.generate({ prompt: "x", toolArm: "arm_a_flat", maxTokens: 500, tools: [] });
    card.set({ "sekhemet.passed": true }).end("ok");
    const spans = tracer.spans({ traceId: card.context.traceId });
    expect(spans.map((s) => s.name)).toEqual(["card.run", "gen_ai.chat"]);
    const call = spans[1];
    expect(call?.parentSpanId).toBe(card.context.spanId);
    expect(call?.attributes).toMatchObject({
      "gen_ai.request.model": "cyber-tiel",
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 80,
      "sekhemet.prefill_tps": 410,
      "sekhemet.decode_tps": 27.3,
      "sekhemet.cache_hit_rate": 0.93,
    });
    tracer.close();

    const out = join(repo, "otlp.json");
    const lines: string[] = [];
    expect(await tracesCommand(repo, ["--out", out], { say: (l) => lines.push(l) })).toBe(0);
    const otlp = JSON.parse(readFileSync(out, "utf8"));
    const exported = otlp.resourceSpans[0].scopeSpans[0].spans;
    expect(exported).toHaveLength(2);
    expect(exported[1].kind).toBe(3); // client
    expect(exported[0].status.code).toBe(1);
    expect(exported[0].attributes).toContainEqual({
      key: "sekhemet.passed",
      value: { boolValue: true },
    });

    let posted = "";
    const code = await tracesCommand(repo, ["--otlp", "http://127.0.0.1:4318"], {
      say: () => {},
      fetch: (async (url: string, init?: RequestInit) => {
        posted = `${url} ${String(init?.body).length}`;
        return new Response("{}");
      }) as typeof fetch,
    });
    expect(code).toBe(0);
    expect(posted).toMatch(/^http:\/\/127\.0\.0\.1:4318\/v1\/traces \d+/);
  });

  it("marks a failed model call as an error span and rethrows", async () => {
    const tracer = new Tracer(":memory:");
    const bad = traced(
      {
        modelId: "m",
        supportedArms: ["arm_a_flat"],
        generate: async () => {
          throw new Error("server gone");
        },
      },
      tracer,
      () => undefined,
    );
    await expect(bad.generate({ prompt: "x", toolArm: "arm_a_flat" })).rejects.toThrow(
      "server gone",
    );
    const [span] = tracer.spans();
    expect(span?.status).toBe("error");
    expect(span?.attributes["error.message"]).toBe("server gone");
    expect(JSON.stringify(toOtlp(tracer.spans()))).toContain('"code":2');
  });
});
