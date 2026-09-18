import { describe, expect, it } from "vitest";
import { ManagedLlamaServerAdapter, createCyberTielWorker } from "../src/llama_server.js";

describe("@sekhemet/models managed llama-server", () => {
  it("launches with the MTP head, jinja templates and 8-bit KV", () => {
    const args = createCyberTielWorker("/models/x.gguf").launchArgs();
    const flag = (name: string) => args[args.indexOf(name) + 1];

    expect(flag("-m")).toBe("/models/x.gguf");
    expect(args).toContain("--jinja");
    // Without draft-mtp the grafted head is dead weight.
    expect(flag("--spec-type")).toBe("draft-mtp");
    // 4-bit KV is prohibited for tool-calling models. 16k: this hybrid-attention
    // MoE's KV cache is small enough that the larger window costs ~0.16GB.
    expect(flag("-ctk")).toBe("q8_0");
    expect(flag("-ctv")).toBe("q8_0");
    expect(flag("-c")).toBe("16384");
    expect(flag("--host")).toBe("127.0.0.1");
  });

  it("omits speculative decoding when the profile has no MTP head", () => {
    const adapter = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/m.gguf" });
    expect(adapter.launchArgs()).not.toContain("--spec-type");
  });

  it("refuses to start when the model file does not exist, before evicting anything", async () => {
    const adapter = new ManagedLlamaServerAdapter({
      modelId: "missing",
      modelPath: "/nonexistent/model.gguf",
      port: 18_998,
    });
    await expect(adapter.ensureRunning()).rejects.toThrow("Model file not found");
  });

  it("treats unload of a never-started server as a no-op", async () => {
    const adapter = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/m.gguf" });
    await expect(adapter.unload()).resolves.toBeUndefined();
  });
});
