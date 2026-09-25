import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunProfile, runProfileHash } from "@sekhemet/eval";
import { ManagedLlamaServerAdapter, ModelRegistry } from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  buildReproRecord,
  llamaRuntime,
  parseLlamaBuild,
  quantFromFile,
  reproDiff,
  sampledDigest,
} from "../src/repro.js";

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

  it("records the seven fields and what the server itself reports (MD-M4-3, MD-M4-5, MD-M4-2)", () => {
    const repo = mkdtempSync(join(tmpdir(), "repro-repo-"));
    const registry = new ModelRegistry(join(repo, "models.json"));
    registry.upsert("worker", {
      quant: "IQ3_XXS",
      template: { checksum: "tmpl-sha", pinnedAt: "2026-09-25" },
    });
    const model = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: join(repo, "Worker-UD-IQ3_XXS.gguf"),
      contextTokens: 16384,
      kvType: "q8_0",
      registry,
    });
    const r = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: repo,
      gatesSha: "g",
      promptSha: "p",
      server: { modelPath: "/m/w.gguf", contextTokens: 16384, mtp: false, build: "b10809" },
    });
    // The header's quantisation from the registry, not the file name's label.
    expect(r.model.quant).toBe("IQ3_XXS");
    expect(r.templateChecksum).toBe("tmpl-sha");
    expect(r.engine).toMatchObject({ contextTokens: 16384, kvType: "q8_0", mtp: false });
    expect(r.server).toEqual({
      modelPath: "/m/w.gguf",
      contextTokens: 16384,
      mtp: false,
      build: "b10809",
    });
    expect(r.harness.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.harness.distSha).toMatch(/^[0-9a-f]{16}$/);
    // A changed engine setting shows up between two attempts.
    const b = { ...r, attempt: 2, engine: { ...r.engine, mtp: true } };
    expect(reproDiff(r, b)).toEqual(["engine"]);
  });
  it("records the run's one RunProfile with its hash, and diffs it between attempts (MS-M9-4)", () => {
    const repo = mkdtempSync(join(tmpdir(), "repro-profile-"));
    const model = {
      modelId: "m",
      supportedArms: ["arm_a_flat" as const],
      generate: async () => ({
        text: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      }),
    };
    const profile = resolveRunProfile({
      env: { SEKHEMET_THINKING: "surgical" },
      argv: ["--max-turns", "20"],
    });
    const a = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: repo,
      gatesSha: "g",
      runProfile: profile,
    });
    expect(a.runProfile).toMatchObject({
      switches: { thinking: "surgical", workerMethod: "baseline" },
      policies: { stepCap: 20 },
      hash: runProfileHash(profile),
    });
    const other = resolveRunProfile({ env: {}, argv: [] });
    const b = buildReproRecord({
      cardId: "c",
      attempt: 2,
      model,
      repoPath: repo,
      gatesSha: "g",
      runProfile: other,
    });
    expect(reproDiff(a, { ...b, recordedAt: a.recordedAt, attempt: 1 })).toContain("run profile");
  });
});

// The live finding of 2026-09-25: qualification recorded "llama.cpp unknown
// build" because `llama-server --version` prints to stderr, and b10809's
// format is new. One form for every source, so a combination recorded from
// /props matches one read later from --version.
const B10809_VERSION = [
  "version: 0.4.0 (build 10809, commit 5266f24da)",
  "built with AppleClang 17.0.0.17000013 for Darwin arm64",
].join("\n");

describe("the llama.cpp build, one form from every source", () => {
  it("parses b10809's --version, the older form and /props build_info alike", () => {
    expect(parseLlamaBuild(B10809_VERSION)).toBe("b10809 (5266f24da)");
    expect(parseLlamaBuild("version: 0.4.0 (build 10809, commit 5266f24da)")).toBe(
      "b10809 (5266f24da)",
    );
    expect(parseLlamaBuild("version: 5266 (abc1234)\nbuilt with clang")).toBe("b5266 (abc1234)");
    expect(parseLlamaBuild("b10809-5266f24da")).toBe("b10809 (5266f24da)");
    expect(parseLlamaBuild("b10809 (5266f24da)")).toBe("b10809 (5266f24da)");
    expect(parseLlamaBuild("")).toBeUndefined();
    expect(parseLlamaBuild("error: unknown argument --version")).toBeUndefined();
  });

  it("reads a --version printed on stderr, as b10809 prints it", () => {
    const dir = mkdtempSync(join(tmpdir(), "llama-version-"));
    const bin = join(dir, "llama-server");
    writeFileSync(bin, `#!/bin/sh\ncat >&2 <<'EOF'\n${B10809_VERSION}\nEOF\nexit 0\n`);
    chmodSync(bin, 0o755);
    expect(llamaRuntime(bin)).toBe("b10809 (5266f24da)");
  });

  it("prefers the running server's build_info in the record", () => {
    const repo = mkdtempSync(join(tmpdir(), "repro-repo-"));
    const model = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: join(repo, "Worker-UD-IQ3_XXS.gguf"),
      contextTokens: 16384,
      registry: new ModelRegistry(join(repo, "models.json")),
      binary: join(repo, "no-such-llama-server"),
    });
    const r = buildReproRecord({
      cardId: "c",
      attempt: 1,
      model,
      repoPath: repo,
      gatesSha: "g",
      server: { build: "b10809-5266f24da" },
    });
    expect(r.model.runtime).toBe("b10809 (5266f24da)");
  });
});

describe("a Worker under a recorded override (rule 27, MD-N4-4)", () => {
  it("says so in card/repro", () => {
    const repo = mkdtempSync(join(tmpdir(), "repro-repo-"));
    const model = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: join(repo, "Worker-UD-IQ3_XXS.gguf"),
      contextTokens: 16384,
      registry: new ModelRegistry(join(repo, "models.json")),
    });
    const base = { cardId: "c", attempt: 1, model, repoPath: repo, gatesSha: "g" };
    expect(buildReproRecord(base)).not.toHaveProperty("workerOverride");
    const o = {
      by: "person: Brennan Kelley",
      reason: "accepted",
      date: "2026-09-25T12:00:00.000Z",
      failedChecks: ["multi_step 50%"],
    };
    Object.defineProperty(model, "workerOverride", { value: o, enumerable: false });
    expect(buildReproRecord(base).workerOverride).toEqual(o);
  });
});
