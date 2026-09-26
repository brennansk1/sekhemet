import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpInferenceAdapter, ManagedLlamaServerAdapter, ModelRegistry } from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

// MD-N4-2: sampling, window and reasoning set in a model's registry entry
// are what its requests use, over the factory's defaults.

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await (closers.pop() as () => Promise<void>)();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const registry = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-n4-2-"));
  dirs.push(d);
  return new ModelRegistry(join(d, "models.json"));
};

describe("MD-N4-2: the registry's settings reach the request", () => {
  it("changes the registry and observes the request (Ollama)", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/chat"
        ? {
            json: {
              message: { role: "assistant", content: "ok" },
              done: true,
              prompt_eval_count: 1,
              eval_count: 1,
            },
          }
        : { json: {} },
    );
    closers.push(srv.close);
    const reg = registry();
    const adapter = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "ollama",
      contextTokens: 8192,
      sampling: { temperature: 0.6, topP: 0.95, topK: 20 },
      disableReasoning: false,
      telemetry: false,
      memoryAware: false,
    });
    const send = async () => {
      await adapter.generate({ prompt: "hi", toolArm: "arm_a_flat" });
      const posts = srv.seen.filter((s) => s.url === "/api/chat");
      return posts.at(-1)?.body as {
        options: Record<string, number>;
        think?: boolean;
      };
    };
    const before = await send();
    expect(before.options).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      num_ctx: 8192,
    });
    reg.upsert("m", {
      sampling: { temperature: 0.1, topP: 0.5, topK: 7, minP: 0.05 },
      contextWindow: 4096,
      reasoning: { supported: false, defaultBudget: 0, stripTraces: true },
    });
    adapter.attachRegistry(reg);
    const after = await send();
    expect(after.options).toMatchObject({
      temperature: 0.1,
      top_p: 0.5,
      top_k: 7,
      min_p: 0.05,
      num_ctx: 4096,
    });
    expect(adapter.contextWindow?.contextTokens).toBe(4096);
    expect(adapter.reasoningFor({})).toBe("off");
    expect(adapter.reasoningFor({ reasoning: "high" })).toBe("off");
  });

  it("a managed server launches with the registry's window", () => {
    const reg = registry();
    reg.upsert("w", { contextWindow: 12_288 });
    const a = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/w.gguf",
      contextTokens: 16_384,
      registry: reg,
    });
    const args = a.launchArgs();
    expect(args[args.indexOf("-c") + 1]).toBe("12288");
  });
});
