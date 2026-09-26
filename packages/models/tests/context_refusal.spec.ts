import { describe, expect, it } from "vitest";
import {
  ContextOverflowError,
  HttpInferenceAdapter,
  PROMPT_CHARS_PER_TOKEN,
  countPromptTokens,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const ok = {
  json: {
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1 },
  },
};

describe("CX-N3-3: no request over the context the adapter set", () => {
  it("counts the prompt with the one estimate: 3.2 characters a token", () => {
    expect(PROMPT_CHARS_PER_TOKEN).toBe(3.2);
    expect(countPromptTokens([{ role: "user", content: "x".repeat(320) }])).toBe(100);
  });

  it("refuses to send a prompt over the window, naming the role and both numbers", async () => {
    const server = await fakeServer(() => ok);
    try {
      const adapter = new HttpInferenceAdapter({
        modelId: "planner-model",
        baseUrl: server.url,
        apiFormat: "openai",
        contextTokens: 1000,
        telemetry: false,
        role: "planner",
      });
      await expect(
        adapter.generate({ prompt: "y".repeat(4000), toolArm: "arm_b_json" }),
      ).rejects.toThrow(ContextOverflowError);
      const err = await adapter
        .generate({ prompt: "y".repeat(4000), toolArm: "arm_b_json", role: "seshat" })
        .catch((e: unknown) => e as ContextOverflowError);
      expect(err).toBeInstanceOf(ContextOverflowError);
      expect((err as ContextOverflowError).message).toMatch(/seshat/);
      expect((err as ContextOverflowError).message).toMatch(/1250 tokens/);
      expect((err as ContextOverflowError).message).toMatch(/1000-token context/);
      expect((err as ContextOverflowError).promptTokens).toBe(1250);
      expect((err as ContextOverflowError).contextTokens).toBe(1000);
      expect(server.seen.filter((s) => s.method === "POST")).toHaveLength(0);
      // A prompt that fits is sent.
      const res = await adapter.generate({ prompt: "fits", toolArm: "arm_b_json" });
      expect(res.text).toBe("ok");
    } finally {
      await server.close();
    }
  });
});
