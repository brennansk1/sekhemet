import { afterEach, describe, expect, it } from "vitest";
import {
  HttpInferenceAdapter,
  ManagedLlamaServerAdapter,
  apodexContextTokens,
  createApodexResearcher,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const GB = 1024 ** 3;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

describe("per-request server slots (id_slot)", () => {
  it("sends id_slot when a request names a slot, and nothing otherwise", async () => {
    const srv = await fakeServer(() => ({ json: { choices: [{ message: { content: "ok" } }] } }));
    closers.push(srv.close);
    const a = new HttpInferenceAdapter({ modelId: "m", baseUrl: srv.url, apiFormat: "openai" });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat", slot: 1 });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
    const posts = srv.seen.filter((s) => s.method === "POST");
    expect((posts[0]?.body as { id_slot?: number }).id_slot).toBe(1);
    expect(posts[1]?.body).not.toHaveProperty("id_slot");
  });

  it("the Ollama path ignores the slot", async () => {
    const srv = await fakeServer(() => ({ json: { message: { content: "ok" } } }));
    closers.push(srv.close);
    const a = new HttpInferenceAdapter({ modelId: "o", baseUrl: srv.url });
    await a.generate({ prompt: "p", toolArm: "arm_a_flat", slot: 1 });
    const chat = srv.seen.find((s) => s.url === "/api/chat");
    expect(chat?.body).not.toHaveProperty("id_slot");
  });
});

describe("parallelSlots: every slot keeps the full window", () => {
  it("launches -np N -c ctx*N and reports the per-slot window", () => {
    const a = new ManagedLlamaServerAdapter({
      modelId: "x",
      modelPath: "/x.gguf",
      contextTokens: 16384,
      parallelSlots: 2,
      maxTokens: 1000,
    });
    const args = a.launchArgs();
    expect(args[args.indexOf("-np") + 1]).toBe("2");
    expect(args[args.indexOf("-c") + 1]).toBe("32768");
    expect(a.contextWindow).toEqual({ contextTokens: 16384, maxTokens: 1000 });
  });

  it("Apodex runs two slots, and SEKHEMET_RESEARCHER_CTX overrides the per-slot context", () => {
    const small = createApodexResearcher("/a.gguf", undefined, 24 * GB);
    const args = small.launchArgs();
    expect(args[args.indexOf("-np") + 1]).toBe("2");
    expect(args[args.indexOf("-c") + 1]).toBe(String(2 * 16384));
    expect(small.contextWindow?.contextTokens).toBe(16384);
    expect(apodexContextTokens(24 * GB, { SEKHEMET_RESEARCHER_CTX: "65536" })).toBe(65536);
    expect(apodexContextTokens(24 * GB, { SEKHEMET_RESEARCHER_CTX: "junk" })).toBe(16384);
  });
});
