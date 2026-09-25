import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GGUFValueType, serializeGgufMetadata } from "@huggingface/gguf";
import { afterEach, describe, expect, it } from "vitest";
import { hostFingerprintHash } from "../src/calibration.js";
import { ManagedLlamaServerAdapter } from "../src/llama_server.js";
import { ModelRegistry } from "../src/registry.js";
import { fakeServer } from "./support/fake_server.js";
import { qualifyMtp } from "./support/qualify_mtp.js";

/** B2.2: server identity (MD-M4-1) and MTP decided by measurement (MD-M7-1/2). */
const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-b22-"));
  dirs.push(d);
  return d;
};
const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

/** A server answering /health and /props the way llama-server does. */
async function serving(props: unknown) {
  const srv = await fakeServer((req) =>
    req.url === "/props" ? { json: props } : { json: { status: "ok" } },
  );
  closers.push(srv.close);
  return srv;
}

const props = (over: { modelPath?: string; nCtx?: number; speculative?: boolean } = {}) => ({
  model_path: over.modelPath ?? "/models/worker.gguf",
  build_info: "b10809-5266f24da",
  default_generation_settings: {
    n_ctx: over.nCtx ?? 16384,
    ...(over.speculative !== undefined ? { speculative: over.speculative } : {}),
  },
});

describe("MD-M4-1: a server on a managed port is adopted only when it is ours", () => {
  it("refuses a server with another model loaded, and names it", async () => {
    const srv = await serving(props({ modelPath: "/models/someone-else.gguf" }));
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
    });
    await expect(a.ensureRunning()).rejects.toThrow(/someone-else\.gguf/);
  });

  it("refuses the right model with a different context size or MTP state", async () => {
    const small = await serving(props({ nCtx: 8192 }));
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: small.port,
      contextTokens: 16384,
    });
    await expect(a.ensureRunning()).rejects.toThrow(/context 8192/);
    // No decision recorded, so this launch would run without MTP.
    const spec = await serving(props({ speculative: true }));
    const b = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: spec.port,
      contextTokens: 16384,
    });
    await expect(b.ensureRunning()).rejects.toThrow(/MTP/);
  });

  it("adopts a matching server and reports what it runs", async () => {
    const srv = await serving(props({ speculative: false }));
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
    });
    await a.ensureRunning();
    expect(await a.serverProps()).toMatchObject({
      modelPath: "/models/worker.gguf",
      contextTokens: 16384,
      mtp: false,
      build: "b10809-5266f24da",
    });
  });

  it("refuses, for a speculative probe, a server whose MTP state it cannot read (M11)", async () => {
    const srv = await serving(props({}));
    const probe = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
      speculativeOverride: true,
    });
    await expect(probe.ensureRunning()).rejects.toThrow(/does not report its MTP state/);
    // Without an override the launch's own state is not in question: it adopts.
    const plain = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
    });
    await plain.ensureRunning();
  });

  it("refuses a server whose /props names no model", async () => {
    const srv = await serving({});
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
    });
    await expect(a.ensureRunning()).rejects.toThrow(/does not report its model/);
  });
});

describe("MD-M7: MTP is off until measured on this host, per thinking policy", () => {
  const decision = (enabled: boolean, thinking?: "off" | "surgical" | "all") => ({
    enabled,
    speedup: enabled ? 1.3 : 0.9,
    reason: "measured",
    fingerprint: hostFingerprintHash(),
    date: "2026-09-25",
    ...(thinking ? { thinking } : {}),
  });

  it("launches without MTP when nothing is recorded, whatever the profile says", () => {
    const a = new ManagedLlamaServerAdapter({ modelId: "w", modelPath: "/m.gguf", mtp: true });
    expect(a.launchArgs()).not.toContain("--spec-type");
  });

  it("launches with MTP and two draft tokens when this host and policy measured a gain", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision(true, "off"));
    const a = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m.gguf",
      registry: reg,
      thinkingPolicy: "off",
    });
    qualifyMtp(reg, a);
    expect(flag(a.launchArgs(), "--spec-type")).toBe("draft-mtp");
    expect(flag(a.launchArgs(), "--spec-draft-n-max")).toBe("2");
  });

  it("keeps MTP off on a speed decision alone, without a qualification with MTP and prefix caching on (MD-N8-2)", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision(true, "off"));
    const a = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m.gguf",
      registry: reg,
      thinkingPolicy: "off",
    });
    expect(a.launchArgs()).not.toContain("--spec-type");
    expect(a.speculativeStatus().reason).toMatch(/not qualified with MTP on and prefix caching on/);
    qualifyMtp(reg, a);
    expect(flag(a.launchArgs(), "--spec-type")).toBe("draft-mtp");
  });

  it("applies the decision for the current thinking policy only", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", decision(true, "off"));
    const surgical = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m.gguf",
      registry: reg,
      thinkingPolicy: "surgical",
    });
    qualifyMtp(reg, surgical);
    expect(surgical.launchArgs()).not.toContain("--spec-type");
    reg.recordSpeculative("w", decision(true, "surgical"));
    expect(flag(surgical.launchArgs(), "--spec-type")).toBe("draft-mtp");
    // Both policies' decisions are kept.
    const off = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/m.gguf",
      registry: reg,
      thinkingPolicy: "off",
    });
    expect(flag(off.launchArgs(), "--spec-type")).toBe("draft-mtp");
  });

  it("ignores a decision measured on another host or without a policy", () => {
    const reg = new ModelRegistry(join(tmp(), "models.json"));
    reg.recordSpeculative("w", { ...decision(true, "off"), fingerprint: "another-host" });
    reg.recordSpeculative("v", decision(true));
    for (const id of ["w", "v"]) {
      const a = new ManagedLlamaServerAdapter({
        modelId: id,
        modelPath: "/m.gguf",
        registry: reg,
        thinkingPolicy: "off",
      });
      expect(a.launchArgs()).not.toContain("--spec-type");
    }
  });
});

describe("MD-M4-5: the quantisation is recorded from the model the server runs", () => {
  it("records it in the registry when the server is adopted", async () => {
    const dir = tmp();
    const modelPath = join(dir, "worker.gguf");
    writeFileSync(
      modelPath,
      serializeGgufMetadata({
        version: { value: 3, type: GGUFValueType.UINT32 },
        tensor_count: { value: 0n, type: GGUFValueType.UINT64 },
        kv_count: { value: 1n, type: GGUFValueType.UINT64 },
        "general.file_type": { value: 23, type: GGUFValueType.UINT32 },
      } as Parameters<typeof serializeGgufMetadata>[0]),
    );
    const srv = await serving({ ...props({ speculative: false }), model_path: modelPath });
    const registry = new ModelRegistry(join(dir, "models.json"));
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath,
      port: srv.port,
      contextTokens: 16384,
      registry,
    });
    await a.ensureRunning();
    expect(registry.get("worker")?.quant).toBe("IQ3_XXS");
  });
});

describe("MD-M4-4: speculative decoding's drafted and accepted tokens per step", () => {
  it("reads them from llama-server's timings", async () => {
    const { usageFromLlamaServer } = await import("../src/http_adapter.js");
    const u = usageFromLlamaServer(
      { prompt_n: 100, cache_n: 900, predicted_n: 60, draft_n: 40, draft_n_accepted: 30 },
      { prompt_tokens: 1000, completion_tokens: 60 },
    );
    expect(u).toMatchObject({
      cachedPromptTokens: 900,
      evaluatedPromptTokens: 100,
      draftTokens: 40,
      draftAcceptedTokens: 30,
    });
    // Without speculation there is nothing to report, not zero.
    const plain = usageFromLlamaServer({ prompt_n: 10, predicted_n: 5 }, undefined);
    expect(plain.draftTokens).toBeUndefined();
  });
});

describe("MD-M4-2: the harness's own provenance, never the target repository's", () => {
  it("reads the commit, dirty flag and built-output hash of the running harness", async () => {
    const { harnessProvenance } = await import("../src/bakeoff.js");
    const { execFileSync } = await import("node:child_process");
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const p = harnessProvenance();
    expect(p.commit).toBe(head);
    expect(typeof p.dirty).toBe("boolean");
    expect(p.distSha).toMatch(/^[0-9a-f]{16}$/);
    // Wherever the card runs: a target repository's HEAD is not the harness's.
    const other = tmp();
    execFileSync("git", ["init", "-q"], { cwd: other });
    expect(harnessProvenance().commit).toBe(head);
  });
});

describe("adopting a running server, review fixes (A7-A10)", () => {
  it("A7: accepts the per-slot context or the total across slots (a unified KV cache)", async () => {
    for (const nCtx of [16384, 32768]) {
      const srv = await serving(props({ nCtx, speculative: false }));
      const a = new ManagedLlamaServerAdapter({
        modelId: "worker",
        modelPath: "/models/worker.gguf",
        port: srv.port,
        contextTokens: 16384,
        parallelSlots: 2,
      });
      await expect(a.ensureRunning(), `n_ctx ${nCtx}`).resolves.toBeUndefined();
    }
  });

  it("A8: compares model paths after resolving symbolic links", async () => {
    const dir = tmp();
    const real = join(dir, "worker.gguf");
    writeFileSync(real, "gguf");
    const link = join(dir, "link.gguf");
    symlinkSync(real, link);
    const srv = await serving(props({ modelPath: link, speculative: false }));
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: real,
      port: srv.port,
      contextTokens: 16384,
    });
    await expect(a.ensureRunning()).resolves.toBeUndefined();
  });

  it("A9: forgets the adoption on unload, and re-reads /props once the last check is stale", async () => {
    let current = props({ speculative: false });
    const srv = await fakeServer((req) =>
      req.url === "/props" ? { json: current } : { json: { status: "ok" } },
    );
    closers.push(srv.close);
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
    });
    await a.ensureRunning();
    current = props({ modelPath: "/models/someone-else.gguf" });
    // Checked a moment ago: still adopted.
    await expect(a.ensureRunning()).resolves.toBeUndefined();
    await a.unload();
    await expect(a.ensureRunning()).rejects.toThrow(/someone-else/);
    // A stale check is repeated.
    const b = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
      propsRecheckMs: 0,
    });
    current = props({ speculative: false });
    await b.ensureRunning();
    current = props({ modelPath: "/models/someone-else.gguf" });
    await expect(b.ensureRunning()).rejects.toThrow(/someone-else/);
  });

  it("A10: waits for a server that is still loading instead of starting a second one", async () => {
    let healthChecks = 0;
    const srv = await fakeServer((req) => {
      if (req.url === "/props") return { json: props({ speculative: false }) };
      healthChecks++;
      return healthChecks <= 2
        ? { status: 503, json: { error: { message: "Loading model" } } }
        : { json: { status: "ok" } };
    });
    closers.push(srv.close);
    // The model file does not exist: a spawn attempt would throw "Model file not found".
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      contextTokens: 16384,
      startupTimeoutMs: 10_000,
    });
    await expect(a.ensureRunning()).resolves.toBeUndefined();
    expect(healthChecks).toBeGreaterThanOrEqual(3);
  });

  it("A10: gives up on a server that stays loading past the startup timeout", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/props"
        ? { json: props() }
        : { status: 503, json: { error: { message: "Loading model" } } },
    );
    closers.push(srv.close);
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: "/models/worker.gguf",
      port: srv.port,
      startupTimeoutMs: 600,
    });
    await expect(a.ensureRunning()).rejects.toThrow(/still loading/);
  });
});
