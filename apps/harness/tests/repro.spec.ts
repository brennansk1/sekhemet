import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildReproRecord, quantFromFile, reproDiff, sampledDigest } from "../src/repro.js";

describe("per-attempt reproducibility record (H24)", () => {
  it("reads the quantization from a GGUF file name", () => {
    expect(quantFromFile("/m/Apodex-1.1-mini-IQ3_M.gguf")).toBe("IQ3_M");
    expect(quantFromFile("/m/Qwen3.8-27B-Q8_0.gguf")).toBe("Q8_0");
    expect(quantFromFile("/m/model-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantFromFile("/m/model-BF16.gguf")).toBe("BF16");
    expect(quantFromFile("/m/model.gguf")).toBeUndefined();
  });

  it("digests a large file by sampling, and the digest follows the content", () => {
    const dir = mkdtempSync(join(tmpdir(), "repro-"));
    const f = join(dir, "w-Q8_0.gguf");
    writeFileSync(f, Buffer.alloc(3 * 1024 * 1024, 1));
    const a = sampledDigest(f);
    expect(a).toMatch(/^sampled-sha256:[0-9a-f]{32}$/);
    const buf = Buffer.alloc(3 * 1024 * 1024, 1);
    buf[buf.length - 5] = 7; // a change in the tail
    writeFileSync(f, buf);
    expect(sampledDigest(f)).not.toBe(a);
    expect(sampledDigest(join(dir, "missing.gguf"))).toBeUndefined();
  });

  it("records model file, quant, prompt, schema, playbook, rules, gates, harness and host; diffs attempts", () => {
    const repo = mkdtempSync(join(tmpdir(), "repro-repo-"));
    const weights = join(repo, "Apodex-1.1-mini-IQ3_M.gguf");
    writeFileSync(weights, "weights");
    const model = {
      modelId: "apodex-1.1-mini",
      supportedArms: ["arm_a_flat" as const],
      profile: { modelPath: weights },
      generate: async () => ({
        text: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      }),
    };
    const a = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: repo,
      gatesSha: "g1",
      activeRules: ["r2", "r1"],
    });
    expect(a.model).toMatchObject({
      id: "apodex-1.1-mini",
      file: weights,
      bytes: 7,
      quant: "IQ3_M",
    });
    expect(a.model.digest).toMatch(/^sampled-sha256:/);
    expect(a.activeRules).toEqual(["r1", "r2"]);
    expect(a.playbookSha).toBeNull();
    expect(a.host.node).toBe(process.version);
    expect(a.harness.version).toMatch(/^\d+\.\d+\.\d+/);
    const b = { ...a, attempt: 2, gatesSha: "g2", activeRules: ["r1"] };
    expect(reproDiff(a, b)).toEqual(["active rules", "gates"]);
  });
});
