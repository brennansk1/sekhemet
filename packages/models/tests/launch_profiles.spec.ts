import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostFingerprintHash } from "../src/calibration.js";
import {
  ManagedLlamaServerAdapter,
  cacheProfileForHost,
  chronicleLlamaServerProfile,
  createCyberTielWorker,
  createQwen38Managed,
} from "../src/llama_server.js";
import { ModelRegistry } from "../src/registry.js";
import { ModelRoster } from "../src/roster.js";
import { ModelRouter } from "../src/router.js";
import { fakeServer } from "./support/fake_server.js";
import { qualifyMtp } from "./support/qualify_mtp.js";

const GB = 1024 ** 3;
const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

describe("M17: prompt-cache flags sized to the host", () => {
  it("picks 2 GiB / 6 checkpoints on a 24 GB host and more on larger ones", () => {
    expect(cacheProfileForHost(24 * GB)).toEqual({
      cacheRamMiB: 2048,
      ctxCheckpoints: 6,
      slotPromptSimilarity: 0.5,
    });
    expect(cacheProfileForHost(64 * GB).cacheRamMiB).toBe(4096);
    expect(cacheProfileForHost(128 * GB)).toEqual({
      cacheRamMiB: 8192,
      ctxCheckpoints: 16,
      slotPromptSimilarity: 0.5,
    });
  });

  it("launches every managed server with --cache-ram and --ctx-checkpoints", () => {
    const args = createCyberTielWorker("/m.gguf").launchArgs();
    const host = cacheProfileForHost();
    expect(flag(args, "--cache-ram")).toBe(String(host.cacheRamMiB));
    expect(flag(args, "--ctx-checkpoints")).toBe(String(host.ctxCheckpoints));
    // One slot: similarity routing is meaningless, so it is not passed.
    expect(args).not.toContain("-sps");
  });

  it("passes -sps with several slots, honours overrides, and can defer to the server", () => {
    const multi = new ManagedLlamaServerAdapter({
      modelId: "m",
      modelPath: "/m.gguf",
      parallel: 2,
      cache: { cacheRamMiB: 1024, slotPromptSimilarity: 0.7 },
    }).launchArgs();
    expect(flag(multi, "-sps")).toBe("0.7");
    expect(flag(multi, "--cache-ram")).toBe("1024");
    const none = new ManagedLlamaServerAdapter({
      modelId: "m",
      modelPath: "/m.gguf",
      cache: false,
    });
    expect(none.launchArgs()).not.toContain("--cache-ram");
    expect(none.launchArgs()).not.toContain("--ctx-checkpoints");
  });
});

describe("X29: the CHRONICLE §2 launch profile", () => {
  it("reproduces the §2 command line flag for flag", () => {
    const adapter = new ManagedLlamaServerAdapter(
      chronicleLlamaServerProfile({ modelPath: "/q.gguf", binary: "llama-server" }),
    );
    const args = adapter.launchArgs();
    const pairs: [string, string][] = [
      ["-m", "/q.gguf"],
      ["--host", "127.0.0.1"],
      ["--port", "8099"],
      ["-t", "2"],
      ["-ngl", "999"],
      ["-fa", "on"],
      ["-ctk", "q8_0"],
      ["-ctv", "q8_0"],
      ["-np", "2"],
      ["-c", "49152"],
      ["--ctx-checkpoints", "6"],
      ["--cache-ram", "2048"],
      ["--reasoning", "off"],
    ];
    for (const [name, value] of pairs) expect(flag(args, name), name).toBe(value);
    for (const bare of ["--jinja", "--metrics", "--no-webui"]) expect(args).toContain(bare);
    // MTP is disabled in §2 (21% slower on M4 Metal); §2 sets no -sps.
    expect(args).not.toContain("--spec-type");
    expect(args).not.toContain("-sps");
    // Nothing beyond §2 except nothing: 13 pairs + 3 bare flags.
    expect(args).toHaveLength(13 * 2 + 3);
    // -c is shared by two slots: each request gets half.
    expect(adapter.contextWindow).toEqual({ contextTokens: 24576, maxTokens: 2048 });
  });

  it("the managed Qwen3.8 adapter omits --reasoning off so requests can think", () => {
    const args = createQwen38Managed({ modelPath: "/q.gguf", slotCacheDir: "/tmp/s" }).launchArgs();
    expect(args).not.toContain("--reasoning");
    expect(flag(args, "--port")).toBe("8099");
    expect(flag(args, "--slot-save-path")).toBe("/tmp/s");
  });
});

describe("M20 actions on a managed server", () => {
  it("suspending MTP drops --spec-type from the next launch", () => {
    // MTP is on only by a measured decision for this host and policy (MD-M7).
    const probe = createCyberTielWorker("/m.gguf");
    const registry = new ModelRegistry(
      join(mkdtempSync(join(tmpdir(), "sek-mtp-")), "models.json"),
    );
    registry.recordSpeculative(probe.modelId, {
      enabled: true,
      speedup: 1.3,
      reason: "measured",
      fingerprint: hostFingerprintHash(),
      date: "2026-09-25",
      thinking: "off",
    });
    const a = new ManagedLlamaServerAdapter({
      ...probe.launchProfile,
      registry,
      thinkingPolicy: "off",
    });
    qualifyMtp(registry, a);
    expect(flag(a.launchArgs(), "--spec-type")).toBe("draft-mtp");
    a.setMtpSuspended(true);
    expect(a.launchArgs()).not.toContain("--spec-type");
    a.setMtpSuspended(false);
    expect(flag(a.launchArgs(), "--spec-type")).toBe("draft-mtp");
  });

  it("trimCache erases every slot on a healthy server", async () => {
    const srv = await fakeServer(() => ({ json: {} }));
    closers.push(srv.close);
    const a = new ManagedLlamaServerAdapter({
      modelId: "m",
      modelPath: "/m.gguf",
      port: srv.port,
      parallel: 2,
    });
    expect(await a.trimCache()).toBe(2);
    expect(srv.seen.filter((s) => s.method === "POST").map((s) => s.url)).toEqual([
      "/slots/0?action=erase",
      "/slots/1?action=erase",
    ]);
  });
});

describe("M5: the model roster makes Qwen3.8-27B (Dirk) reachable", () => {
  it("resolves qwen3.8-27b and dirk to one shared managed adapter", () => {
    const roster = new ModelRoster({ qwen38: { modelPath: "/q.gguf" } });
    const manager = roster.resolve("qwen3.8-27b", "manager");
    const escalation = roster.resolve("dirk", "escalation");
    expect(manager).toBe(escalation);
    expect(manager).toBeInstanceOf(ManagedLlamaServerAdapter);
    expect(manager.modelId).toBe("qwen3.8-27b");
  });

  it("falls back to Ollama with the role's profile for any other name", () => {
    const roster = new ModelRoster({ totalBytes: 24 * GB });
    const esc = roster.resolve("dirk-27b:latest", "escalation");
    const rev = roster.resolve("gemma:12b", "reviewer");
    expect(esc).not.toBeInstanceOf(ManagedLlamaServerAdapter);
    expect(esc.contextWindow).toEqual({ contextTokens: 12288, maxTokens: 3072 });
    expect(rev.contextWindow).toEqual({ contextTokens: 12288, maxTokens: 900 });
    expect(roster.resolve("dirk-27b:latest", "escalation")).not.toBe(esc);
  });

  it("two roles on the shared Qwen3.8 adapter never swap in the router", async () => {
    const unloads: string[] = [];
    const fake = {
      modelId: "qwen3.8-27b",
      supportedArms: [],
      generate: async () => ({
        text: "",
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, durationMs: 0 },
      }),
      unload: async () => {
        unloads.push("q");
      },
    };
    const roster = new ModelRoster({ managed: { "qwen3.8-27b": () => fake } });
    const router = new ModelRouter(
      {
        manager: roster.factory("qwen3.8-27b", "manager"),
        escalation: roster.factory("dirk", "escalation"),
      },
      { pressureLevel: () => 1, headroomWaitMs: 0 },
    );
    await router.use("manager");
    await router.use("escalation");
    await router.use("manager");
    expect(router.swapCount).toBe(0);
    expect(unloads).toEqual([]);
  });
});
