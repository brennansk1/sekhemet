import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { HttpInferenceAdapter, usageFromOllama } from "../src/http_adapter.js";
import { fakeServer } from "./support/fake_server.js";

// Measurement MS-T7-1 (the model's load time reported apart from the cards)
// and rule 10 (fixed seeds): the adapters report what the server says a load
// cost, and send a fixed sampling seed only when one is set.

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

describe("the model's load time, as the server reports it (MS-T7-1)", () => {
  it("reads Ollama's load_duration (nanoseconds) into loadMs", () => {
    expect(
      usageFromOllama({ load_duration: 2_500_000_000, eval_count: 3, eval_duration: 1e9 }),
    ).toMatchObject({
      loadMs: 2500,
    });
    expect(usageFromOllama({ eval_count: 3 }).loadMs).toBeUndefined();
    // A warm request reports a few milliseconds of "load": not a load (review M3).
    expect(usageFromOllama({ load_duration: 4_500_000, eval_count: 3 }).loadMs).toBeUndefined();
    expect(usageFromOllama({ load_duration: 999_000_000, eval_count: 3 }).loadMs).toBeUndefined();
    expect(usageFromOllama({ load_duration: 1_000_000_000, eval_count: 3 }).loadMs).toBe(1000);
  });

  it("carries it on the generate() usage", async () => {
    const srv = await fakeServer(() => ({
      json: { message: { content: "ok" }, done: true, load_duration: 1_200_000_000, eval_count: 1 },
    }));
    closers.push(srv.close);
    const a = new HttpInferenceAdapter({ modelId: "m", baseUrl: srv.url, apiFormat: "ollama" });
    const r = await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(r.usage.loadMs).toBe(1200);
  });
});

describe("a fixed sampling seed, only when set (rule 10)", () => {
  it("sends Ollama's options.seed and llama-server's seed, and nothing by default", async () => {
    const ollama = await fakeServer(() => ({ json: { message: { content: "ok" }, done: true } }));
    const llama = await fakeServer(() => ({ json: { choices: [{ message: { content: "ok" } }] } }));
    closers.push(ollama.close, llama.close);
    const o = new HttpInferenceAdapter({ modelId: "m", baseUrl: ollama.url, apiFormat: "ollama" });
    const l = new HttpInferenceAdapter({ modelId: "m", baseUrl: llama.url, apiFormat: "openai" });
    const chats = (srv: typeof ollama) => srv.seen.filter((x) => /chat/.test(x.url));
    await o.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await l.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect(
      (chats(ollama)[0]?.body as { options: Record<string, unknown> }).options.seed,
    ).toBeUndefined();
    expect((chats(llama)[0]?.body as Record<string, unknown>).seed).toBeUndefined();
    o.setSeed(42);
    l.setSeed(42);
    expect(o.seed).toBe(42);
    await o.generate({ prompt: "p", toolArm: "arm_a_flat" });
    await l.generate({ prompt: "p", toolArm: "arm_a_flat" });
    expect((chats(ollama)[1]?.body as { options: Record<string, unknown> }).options.seed).toBe(42);
    expect((chats(llama)[1]?.body as Record<string, unknown>).seed).toBe(42);
  });
});

describe("a managed server's startup, from spawn to healthy (MS-T7-1)", () => {
  it("times spawn to the first healthy /health, and reports it once, on the next reply", async () => {
    const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ManagedLlamaServerAdapter } = await import("../src/llama_server.js");
    const dir = mkdtempSync(join(tmpdir(), "llama-startup-"));
    const bin = join(dir, "fake-llama-server.mjs");
    // Healthy 400 ms after it starts; answers chat completions.
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const up = Date.now() + 400;
createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.statusCode = Date.now() < up ? 503 : 200; res.end("{}"); return; }
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
}).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");
    const a = new ManagedLlamaServerAdapter({
      modelId: "fake",
      modelPath: model,
      binary: bin,
      port: 18991,
      startupTimeoutMs: 20_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    try {
      await a.ensureRunning();
      expect(a.startup?.spawnToHealthyMs).toBeGreaterThanOrEqual(300);
      const first = await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
      expect(first.usage.spawnToHealthyMs).toBe(a.startup?.spawnToHealthyMs);
      const second = await a.generate({ prompt: "p", toolArm: "arm_a_flat" });
      expect(second.usage.spawnToHealthyMs).toBeUndefined();
    } finally {
      await a.unload();
    }
  }, 30_000);

  it("an aborted load stops the server process it started, and rejects at once", async () => {
    const { chmodSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ManagedLlamaServerAdapter } = await import("../src/llama_server.js");
    const dir = mkdtempSync(join(tmpdir(), "llama-abort-"));
    const bin = join(dir, "fake-llama-server.mjs");
    const pidFile = join(dir, "pid");
    // Never healthy: a five-minute load from USB, cut short.
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((req, res) => { res.statusCode = 503; res.end("{}"); }).listen(port, "127.0.0.1");
`,
    );
    chmodSync(bin, 0o755);
    const model = join(dir, "model.gguf");
    writeFileSync(model, "not a real model");
    const a = new ManagedLlamaServerAdapter({
      modelId: "fake",
      modelPath: model,
      binary: bin,
      port: 18992,
      startupTimeoutMs: 60_000,
      ollamaBaseUrl: "http://127.0.0.1:1",
    });
    const controller = new AbortController();
    const load = a.load(controller.signal);
    load.catch(() => undefined);
    for (let i = 0; i < 50 && !existsSync(pidFile); i++)
      await new Promise((r) => setTimeout(r, 100));
    const pid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    controller.abort();
    await expect(load).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);

  it("the throughput meter keeps every load of each model apart from its requests, reloads included (review M3)", async () => {
    const { ThroughputMeter } = await import("../src/telemetry.js");
    const m = new ThroughputMeter();
    m.record("w", { promptTokens: 1, completionTokens: 1, durationMs: 5, spawnToHealthyMs: 9000 });
    m.record("w", { promptTokens: 1, completionTokens: 1, durationMs: 5 });
    // Swapped out and started again.
    m.record("w", { promptTokens: 1, completionTokens: 1, durationMs: 5, spawnToHealthyMs: 7000 });
    m.record("o", { promptTokens: 1, completionTokens: 1, durationMs: 5, loadMs: 1200 });
    expect(m.loads()).toEqual([
      { modelId: "w", spawnToHealthyMs: { count: 2, totalMs: 16000, firstMs: 9000 } },
      { modelId: "o", loadMs: { count: 1, totalMs: 1200, firstMs: 1200 } },
    ]);
  });
});

describe("an eager Ollama load is a cold load (models rule 20c, MD-N14-1)", () => {
  async function slowOllama(delayMs: number) {
    const { createServer } = await import("node:http");
    let generates = 0;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/ps") {
          res.end(JSON.stringify({ models: [] }));
          return;
        }
        generates++;
        const t = setTimeout(() => res.end(JSON.stringify({ done: true })), delayMs);
        res.on("close", () => clearTimeout(t));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as import("node:net").AddressInfo;
    closers.push(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    );
    return { url: `http://127.0.0.1:${port}`, generates: () => generates };
  }

  it("waits out a slow load under the cold-load timeout, with no retry", async () => {
    const srv = await slowOllama(500);
    const a = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "ollama",
      requestTimeoutMs: 100,
      coldLoadTimeoutMs: 3000,
      maxRetries: 2,
    });
    expect(await a.load()).toBe("loaded");
    expect(srv.generates()).toBe(1);
  });

  it("a load past the cold-load timeout fails once, naming that timeout, and is not retried", async () => {
    const srv = await slowOllama(10_000);
    const a = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "ollama",
      requestTimeoutMs: 50,
      coldLoadTimeoutMs: 300,
      maxRetries: 2,
    });
    await expect(a.load()).rejects.toThrow(/300ms/);
    expect(srv.generates()).toBe(1);
  });

  it("an aborted load stops at once and is not retried", async () => {
    const srv = await slowOllama(10_000);
    const a = new HttpInferenceAdapter({
      modelId: "m",
      baseUrl: srv.url,
      apiFormat: "ollama",
      coldLoadTimeoutMs: 5000,
    });
    const controller = new AbortController();
    const started = Date.now();
    const load = a.load(controller.signal);
    setTimeout(() => controller.abort(), 100);
    await expect(load).rejects.toThrow(/aborted/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(srv.generates()).toBe(1);
  });
});
