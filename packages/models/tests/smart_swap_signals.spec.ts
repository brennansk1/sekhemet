import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeHeadroomProbe,
  GPU_CEILING_EVENT,
  HttpInferenceAdapter,
  ManagedLlamaServerAdapter,
  type MemoryReading,
  type ModelSignal,
  REQUANTISED_EVENT,
  ResidencyScheduler,
  SWAP_EVENTS,
  type SwapEvent,
  type UnloadableAdapter,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const GiB = 1024 ** 3;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "swap-signals-"));
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

/** The scheduler's sink and history over a real ledger, as model_access wires them. */
function wire(log: EventLog) {
  return {
    record: (e: { type: string; payload: object }) => {
      log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
    },
    history: async (): Promise<SwapEvent[]> =>
      (await log.getEventsByTypes(Object.values(SWAP_EVENTS))).map((e) => ({
        type: e.type,
        payload: e.payload as SwapEvent["payload"],
        at: Date.parse(e.createdAt),
      })),
  };
}

function roomy(): MemoryReading {
  return {
    at: 0,
    gpuWiredLimitBytes: 64 * GiB,
    metalInUseBytes: 0,
    totalBytes: 96 * GiB,
    wiredBytes: 2 * GiB,
    anonymousBytes: 2 * GiB,
    compressorBytes: 0,
    swapUsedBytes: 0,
    processes: [],
  };
}

/** A fake model that loads on request and can raise a signal, as a managed server would. */
function signalling(name: string) {
  const listeners: ((s: ModelSignal) => void)[] = [];
  const build = (contextTokens: number): UnloadableAdapter => ({
    modelId: name,
    engine: "llama.cpp",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens, maxTokens: 1024 },
    load: async () => "loaded",
    onSignal: (l) => {
      listeners.push(l);
    },
    generate: async () => ({
      text: name,
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    unload: async () => undefined,
    confirmUnloaded: async () => true,
  });
  return {
    build,
    emit: (s: ModelSignal) => {
      for (const l of listeners) l(s);
    },
  };
}

describe("MD-N14-33: a Metal command-buffer timeout records the host's GPU ceiling", () => {
  it("records model/gpu_ceiling with the combined footprint, and a later process refuses that co-residence", async () => {
    const log = ledger();
    const target = signalling("target");
    const draft = signalling("draft");
    const weights = () => ({
      target: { build: target.build, footprintBytes: 11.8e9 },
      draft: { build: draft.build, footprintBytes: 3.85e9 },
    });
    const roles = () => [
      { role: "worker", weights: "target", contextTokens: 8192 },
      { role: "quick", weights: "draft", contextTokens: 8192 },
    ];
    const first = new ResidencyScheduler({
      roles: roles(),
      weights: weights(),
      usableBytes: 96 * GiB,
      headroom: new FakeHeadroomProbe(roomy()),
      gpuCeilings: [{ basis: "calibrated", bytes: 20e9 }],
      swapCost: wire(log),
    });
    await first.submit("worker", async () => "ok");
    await first.submit("quick", async () => "ok");
    expect(first.residentWeights().sort()).toEqual(["draft", "target"]);
    target.emit({ kind: "metal_timeout", detail: "kIOGPUCommandBufferCallbackErrorTimeout" });
    await new Promise((r) => setTimeout(r, 20));
    const recorded = await log.getEventsByTypes([GPU_CEILING_EVENT]);
    expect(recorded.map((e) => e.payload)).toEqual([
      { basis: "metal_timeout", bytes: 15_650_000_000, models: ["target", "draft"] },
    ]);
    await first.releaseAll();

    // A new process: the ceiling comes back from the ledger.
    const second = new ResidencyScheduler({
      roles: roles(),
      weights: weights(),
      usableBytes: 96 * GiB,
      headroom: new FakeHeadroomProbe(roomy()),
      gpuCeilings: [{ basis: "calibrated", bytes: 20e9 }],
      swapCost: wire(log),
    });
    await second.submit("worker", async () => "ok");
    // The Worker is held (a card's step): only a co-residence could serve the
    // quick model, and the policy's memory — the headroom read through the
    // probe, with the ceilings — refuses it rather than evicting the Worker.
    const worker = await second.acquire("worker");
    void second.submit("quick", async () => "ok").catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(second.residentWeights()).toEqual(["target"]);
    const refusal = second.refusals().quick?.message ?? "";
    expect(refusal).toContain("timed out in Metal");
    expect(refusal).toContain("target + draft");
    worker.release();
    await second.releaseAll();
  });
});

describe("rule 20h: an Ollama model served requantised is flagged when it loads", () => {
  it("checks the served quantisation on load, signals, and the scheduler records it", async () => {
    const srv = await fakeServer((req) => {
      if (req.url === "/api/ps") return { json: { models: [] } };
      if (req.url === "/api/show") return { json: { details: { quantization_level: "Q4_K_M" } } };
      if (req.url === "/api/tags")
        return { json: { models: [{ name: "cyber:latest", size: 13e9 }] } };
      return { json: { done: true } };
    });
    closers.push(srv.close);
    const log = ledger();
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "cyber", contextTokens: 8192 }],
      weights: {
        cyber: {
          build: (contextTokens) =>
            new HttpInferenceAdapter({
              modelId: "cyber:latest",
              baseUrl: srv.url,
              contextTokens,
              sourceQuant: "IQ3_XXS",
              memoryAware: false,
            }),
          footprintBytes: 14 * GiB,
        },
      },
      usableBytes: 96 * GiB,
      healthCheck: false,
      swapCost: wire(log),
    });
    await s.submit("worker", async () => "ok");
    await new Promise((r) => setTimeout(r, 20));
    const flagged = await log.getEventsByTypes([REQUANTISED_EVENT]);
    expect(flagged.map((e) => e.payload)).toEqual([
      { model: "cyber", servedQuant: "Q4_K_M", fileQuant: "IQ3_XXS", hashDiffers: false },
    ]);
    await s.releaseAll();
  });

  it("does not check or flag when the served quantisation matches", async () => {
    const srv = await fakeServer((req) => {
      if (req.url === "/api/ps") return { json: { models: [] } };
      if (req.url === "/api/show") return { json: { details: { quantization_level: "IQ3_XXS" } } };
      return { json: { done: true } };
    });
    closers.push(srv.close);
    const a = new HttpInferenceAdapter({
      modelId: "cyber:latest",
      baseUrl: srv.url,
      sourceQuant: "IQ3_XXS",
      memoryAware: false,
    });
    const seen: ModelSignal[] = [];
    a.onSignal((sig) => seen.push(sig));
    expect(await a.load()).toBe("loaded");
    expect(seen).toEqual([]);
  });
});

/**
 * A fake llama-server binary: healthy at once, reports its model, answers
 * chat with prefill timings, writes and reads slot files in its
 * --slot-save-path, and on a prompt of "trip-metal" prints llama.cpp's Metal
 * timeout to stderr and fails the request. Every request is logged.
 */
function fakeLlamaBinary(dir: string, model: string) {
  const bin = join(dir, "fake-llama-server.mjs");
  const logFile = join(dir, "requests.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
const port = Number(arg("--port"));
const slots = arg("--slot-save-path");
const ctx = Number(arg("-c"));
createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ url: req.url, body }) + "\\n");
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end("{}"); return; }
    if (req.url === "/props") {
      res.end(JSON.stringify({ model_path: ${JSON.stringify(model)}, build_info: "b10809",
        chat_template: "{{ messages }}", default_generation_settings: { n_ctx: ctx } }));
      return;
    }
    if (req.url.startsWith("/slots/")) {
      const file = join(slots, JSON.parse(body).filename);
      if (req.url.endsWith("action=save")) { writeFileSync(file, "kv"); res.end(JSON.stringify({ n_written: 1048576 })); return; }
      if (!existsSync(file)) { res.statusCode = 400; res.end("{}"); return; }
      res.end(JSON.stringify({ n_read: 1048576 })); return;
    }
    if (body.includes("trip-metal")) {
      process.stderr.write("ggml_metal_graph_compute: command buffer 0 failed with status 5\\nerror: Caused GPU Timeout Error (00000002:kIOGPUCommandBufferCallbackErrorTimeout)\\n");
      res.statusCode = 400; res.end(JSON.stringify({ error: "compute failed" })); return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 4000, completion_tokens: 1 },
      timings: { prompt_n: 4000, prompt_ms: 40000, prompt_per_second: 100, predicted_n: 1, predicted_ms: 10 } }));
  });
}).listen(port, "127.0.0.1");
`,
  );
  chmodSync(bin, 0o755);
  const requests = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as { url: string; body: string })
      : [];
  return { bin, requests };
}

describe("MD-N14-36: every live slot is saved on swap-out and restored on return", () => {
  it("saves Seshat's thread and a card's slot by owner, restores the thread, re-prefills the card", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-slots-"));
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");
    const { bin, requests } = fakeLlamaBinary(dir, model);
    const a = new ManagedLlamaServerAdapter({
      modelId: "planner",
      modelPath: model,
      binary: bin,
      port: 18993,
      contextTokens: 8192,
      parallelSlots: 2,
      slotCacheDir: join(dir, "slots"),
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    try {
      await a.ensureRunning();
      await a.generate({
        prompt: "q",
        toolArm: "arm_a_flat",
        slot: 1,
        session: { owner: "thread-7", kind: "thread", sources: ["ev-1"] },
      });
      await a.generate({
        prompt: "step",
        toolArm: "arm_a_flat",
        slot: 0,
        session: { owner: "card-3", kind: "live_card" },
      });
      await a.unload();
      const saves = requests().filter((r) => r.url.includes("action=save"));
      expect(saves.map((r) => r.url).sort()).toEqual([
        "/slots/0?action=save",
        "/slots/1?action=save",
      ]);
      const names = saves.map((r) => (JSON.parse(r.body) as { filename: string }).filename).sort();
      expect(names[0]).toMatch(/^card-3\.live_card\.[0-9a-f]{16}\.bin$/);
      expect(names[1]).toMatch(/^thread-7\.thread\.[0-9a-f]{16}\.bin$/);

      // The return: the thread's slot is restored into slot 1; the card's is re-prefilled.
      await a.ensureRunning();
      const restores = requests().filter((r) => r.url.includes("action=restore"));
      expect(restores.map((r) => r.url)).toEqual(["/slots/1?action=restore"]);
      expect(a.restoredSessions()).toEqual([
        { owner: "card-3", slot: 0, action: "reprefill", reason: "live_card_unverified" },
        { owner: "thread-7", slot: 1, action: "restored" },
      ]);
    } finally {
      await a.unload();
    }
  }, 30_000);

  it("RUN-35: two concurrent cards on their own slots save their own files and each is restored to its own slot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "two-cards-"));
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");
    const { bin, requests } = fakeLlamaBinary(dir, model);
    const a = new ManagedLlamaServerAdapter({
      modelId: "worker",
      modelPath: model,
      binary: bin,
      port: 18995,
      contextTokens: 8192,
      parallelSlots: 2,
      slotCacheDir: join(dir, "slots"),
      // The equivalence check has passed: live card slots restore.
      slotEquivalencePassed: true,
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    try {
      await a.ensureRunning();
      await Promise.all([
        a.generate({
          prompt: "a",
          toolArm: "arm_a_flat",
          slot: 0,
          session: { owner: "card_a", kind: "live_card" },
        }),
        a.generate({
          prompt: "b",
          toolArm: "arm_a_flat",
          slot: 1,
          session: { owner: "card_b", kind: "live_card" },
        }),
      ]);
      await a.unload();
      const saves = requests()
        .filter((r) => r.url.includes("action=save"))
        .map((r) => [r.url, (JSON.parse(r.body) as { filename: string }).filename] as const)
        .sort();
      expect(saves.map(([u]) => u)).toEqual(["/slots/0?action=save", "/slots/1?action=save"]);
      expect(saves[0]?.[1]).toMatch(/^card_a\.live_card\./);
      expect(saves[1]?.[1]).toMatch(/^card_b\.live_card\./);
      await a.ensureRunning();
      const restores = requests()
        .filter((r) => r.url.includes("action=restore"))
        .map((r) => [r.url, (JSON.parse(r.body) as { filename: string }).filename] as const);
      expect(restores).toEqual([
        ["/slots/0?action=restore", saves[0]?.[1]],
        ["/slots/1?action=restore", saves[1]?.[1]],
      ]);
      expect(a.restoredSessions().map((r) => [r.owner, r.slot, r.action])).toEqual([
        ["card_a", 0, "restored"],
        ["card_b", 1, "restored"],
      ]);
    } finally {
      await a.unload();
    }
  }, 30_000);

  it("MD-N14-33: a Metal timeout in the server's stderr and in a failed request raises the signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metal-"));
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");
    const { bin } = fakeLlamaBinary(dir, model);
    const a = new ManagedLlamaServerAdapter({
      modelId: "target",
      modelPath: model,
      binary: bin,
      port: 18994,
      contextTokens: 8192,
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    const seen: ModelSignal[] = [];
    a.onSignal((s) => seen.push(s));
    try {
      await a.ensureRunning();
      await expect(a.generate({ prompt: "trip-metal", toolArm: "arm_a_flat" })).rejects.toThrow();
      await new Promise((r) => setTimeout(r, 200));
      // One timeout, reported once however many paths saw it.
      expect(seen.filter((s) => s.kind === "metal_timeout")).toHaveLength(1);
    } finally {
      await a.unload();
    }
  }, 30_000);
});

describe("the adapter's error path alone", () => {
  it("signals a Metal timeout named in a failed request's error", async () => {
    const srv = await fakeServer((req) => {
      if (req.url === "/props")
        return { json: { model_path: "/w.gguf", default_generation_settings: { n_ctx: 8192 } } };
      if (req.url === "/health") return { json: {} };
      return {
        status: 400,
        json: { error: "GPU Timeout Error (kIOGPUCommandBufferCallbackErrorTimeout)" },
      };
    });
    closers.push(srv.close);
    const a = new ManagedLlamaServerAdapter({
      modelId: "w",
      modelPath: "/w.gguf",
      port: srv.port,
      contextTokens: 8192,
    });
    const seen: ModelSignal[] = [];
    a.onSignal((s) => seen.push(s));
    await expect(a.generate({ prompt: "x", toolArm: "arm_a_flat" })).rejects.toThrow();
    expect(seen.map((s) => s.kind)).toEqual(["metal_timeout"]);
  });
});
