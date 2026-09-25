import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { HttpInferenceAdapter } from "../src/http_adapter.js";

/** One canned JSON reply per request, on a real local socket. */
async function serve(reply: unknown): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

describe("finish_reason and the thinking/answer split (WL-M3-2, WL-M3-4)", () => {
  it("reads an OpenAI-format finish_reason and the server's reasoning-token count", async () => {
    const s = await serve({
      choices: [
        { message: { content: "", reasoning_content: "hmm ".repeat(50) }, finish_reason: "length" },
      ],
      usage: {
        prompt_tokens: 900,
        completion_tokens: 2048,
        completion_tokens_details: { reasoning_tokens: 2048 },
      },
    });
    const adapter = new HttpInferenceAdapter({ modelId: "m", baseUrl: s.url, apiFormat: "openai" });
    const res = await adapter.generate({ prompt: "hi", toolArm: "arm_a_flat", reasoning: "high" });
    s.close();
    expect(res.finishReason).toBe("length");
    expect(res.usage.promptTokens).toBe(900);
    expect(res.usage.thinkingTokens).toBe(2048);
    expect(res.usage.answerTokens).toBe(0);
  });

  it("reads Ollama's done_reason and estimates thinking from the thinking text", async () => {
    const s = await serve({
      message: { content: "done", thinking: "x".repeat(400) },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 50,
      eval_count: 104,
    });
    const adapter = new HttpInferenceAdapter({ modelId: "o", baseUrl: s.url, apiFormat: "ollama" });
    const res = await adapter.generate({ prompt: "hi", toolArm: "arm_a_flat", reasoning: "low" });
    s.close();
    expect(res.finishReason).toBe("stop");
    expect(res.usage.thinkingTokens).toBe(100);
    expect(res.usage.answerTokens).toBe(4);
  });
});
