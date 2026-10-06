import { afterEach, describe, expect, it } from "vitest";
import { HttpInferenceAdapter } from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

/**
 * The Reviewer's reply is constrained to its JSON schema (owner, 2026-10-05):
 * small models wrote malformed JSON well under the answer cap, and a
 * malformed reply fails the review (RG-P8-16), so a bake-off measured
 * formatting luck. A request that names a `responseSchema` (and offers no
 * tools) asks the server to decode against it: `response_format` json_schema
 * on an OpenAI-compatible server (llama-server), `format` on Ollama. No model
 * is loaded: a fake server records what was sent.
 */
const SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["met", "unmet"] } },
  required: ["verdict"],
  additionalProperties: false,
} as const;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
});

const adapter = (baseUrl: string, apiFormat: "openai" | "ollama") =>
  new HttpInferenceAdapter({
    modelId: "m",
    baseUrl,
    apiFormat,
    disableReasoning: true,
    telemetry: false,
    memoryAware: false,
  });

describe("a request's reply schema (Reviewer JSON constraint)", () => {
  it("is sent as response_format json_schema to an OpenAI-compatible server", async () => {
    const srv = await fakeServer(() => ({
      json: { choices: [{ message: { content: '{"verdict":"met"}' }, finish_reason: "stop" }] },
    }));
    closers.push(srv.close);
    const a = adapter(srv.url, "openai");
    await a.generate({ prompt: "p", toolArm: "arm_b_json", responseSchema: SCHEMA });
    await a.generate({ prompt: "p", toolArm: "arm_b_json" });
    const posts = srv.seen.filter((s) => s.url === "/v1/chat/completions").map((s) => s.body);
    expect(posts[0]).toMatchObject({
      response_format: {
        type: "json_schema",
        json_schema: { name: "reply", strict: true, schema: SCHEMA },
      },
    });
    expect(posts[1]).not.toHaveProperty("response_format");
  });

  it("is sent as format to Ollama", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/chat"
        ? {
            json: {
              message: { content: '{"verdict":"met"}' },
              done: true,
              done_reason: "stop",
              eval_count: 5,
              prompt_eval_count: 5,
            },
          }
        : { json: { models: [] } },
    );
    closers.push(srv.close);
    const a = adapter(srv.url, "ollama");
    await a.generate({ prompt: "p", toolArm: "arm_b_json", responseSchema: SCHEMA });
    await a.generate({ prompt: "p", toolArm: "arm_b_json" });
    const posts = srv.seen
      .filter((s) => s.url === "/api/chat")
      .map((s) => s.body as Record<string, unknown>);
    expect(posts[0]?.format).toEqual(SCHEMA);
    expect(posts[1]).not.toHaveProperty("format");
  });
});
