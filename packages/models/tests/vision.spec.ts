import { describe, expect, it } from "vitest";
import { HttpInferenceAdapter } from "../src/http_adapter.js";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";
import { ModelRegistry } from "../src/registry.js";
import { fakeServer } from "./support/fake_server.js";

const PNG = { mime: "image/png", data: "iVBORw0KGgo=", name: "shot.png" };

describe("X3: images reach a vision model on both wire formats", () => {
  it("OpenAI (llama-server): the user message becomes text plus image_url parts", async () => {
    const srv = await fakeServer(() => ({
      json: {
        choices: [{ message: { content: "a login form", tool_calls: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    }));
    const a = new HttpInferenceAdapter({
      modelId: "qwen-vl",
      baseUrl: srv.url,
      apiFormat: "openai",
    });
    const r = await a.generate({ prompt: "Describe it", images: [PNG], toolArm: "arm_b_json" });
    await srv.close();
    expect(r.text).toBe("a login form");
    const body = srv.seen.at(-1)?.body as { messages: { role: string; content: unknown }[] };
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Describe it" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.data}` } },
      ],
    });
  });

  it("Ollama: the images ride on the user message as base64", async () => {
    const srv = await fakeServer(() => ({
      json: { message: { content: "a chart" }, done: true, prompt_eval_count: 1, eval_count: 1 },
    }));
    const a = new HttpInferenceAdapter({ modelId: "llava", baseUrl: srv.url });
    await a.generate({
      messages: [{ role: "user", content: "What is this?", images: [PNG] }],
      prompt: "",
      toolArm: "arm_b_json",
    });
    await srv.close();
    const body = srv.seen.find((s) => s.url === "/api/chat")?.body as {
      messages: { content: string; images?: string[] }[];
    };
    expect(body.messages.at(-1)).toMatchObject({ content: "What is this?", images: [PNG.data] });
  });

  it("the registry names vision models and llama-server loads the projector", () => {
    const reg = new ModelRegistry("/tmp/sek-vision-none/models.json");
    reg.upsert("qwen-vl", { roles: ["vision"] });
    reg.upsert("coder", { roles: ["executor"] });
    expect(reg.visionModels().map((m) => m.id)).toEqual(["qwen-vl"]);
    const llama = new ManagedLlamaServerAdapter({
      modelId: "vl",
      modelPath: "/x.gguf",
      mmprojPath: "/x-mmproj.gguf",
      port: 1,
    });
    expect(llama.launchArgs()).toEqual(expect.arrayContaining(["--mmproj", "/x-mmproj.gguf"]));
  });
});
