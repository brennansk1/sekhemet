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

// S1B-B45 (wave 1): zero spans is explained — why, and where to look.
describe("S1B-B45: `traces` with no span in the window says why and where to look", () => {
  const run = async (repo: string, argv: string[]) => {
    const lines: string[] = [];
    const code = await tracesCommand(repo, argv, { say: (l) => lines.push(l) });
    return { code, text: lines.join("\n") };
  };

  it("no span ever: no issue has run in this project; names the file and how to start one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trace-none-"));
    const r = await run(repo, []);
    expect(r.code).toBe(0);
    expect(r.text).toBe(
      [
        "Last 24 h: 0 spans.",
        "No issue has run in this project yet, so nothing is recorded. Spans are written to .sekhemet/traces.db while an issue runs: sekhemet run starts one.",
      ].join("\n"),
    );
    const out = await run(repo, ["--out", join(repo, "t.json")]);
    expect(out.text).toMatch(
      /^Wrote 0 spans as OTLP\/JSON to .*t\.json\.\nNo issue has run in this project yet/,
    );
  });

  it("older spans only: no issue ran in the window; names how many are older and how to widen it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trace-old-"));
    const tracer = Tracer.forRepo(repo);
    const old = BigInt(Date.now() - 72 * 3_600_000) * 1_000_000n;
    for (const id of ["a", "b"])
      tracer.write({
        traceId: `t${id}`,
        spanId: `s${id}`,
        name: "card.run",
        startNs: old,
        endNs: old + 1_000_000n,
        attributes: {},
        status: "ok",
      });
    tracer.close();
    const r = await run(repo, ["--since-hours", "24"]);
    expect(r.code).toBe(0);
    expect(r.text).toBe(
      [
        "Last 24 h: 0 spans.",
        "No issue ran in the last 24 h. 2 older spans are recorded: sekhemet traces --since-hours <n> looks further back.",
      ].join("\n"),
    );
    // A window that reaches them finds them.
    expect((await run(repo, ["--since-hours", "96"])).text).toMatch(/^Last 96 h: 2 spans\./);
  });
});
