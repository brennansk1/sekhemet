import { mkdtempSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  FootprintRefusal,
  ManagedLlamaServerAdapter,
  ResidencyScheduler,
  SWAP_EVENTS,
  type SwapEvent,
  UNLOAD_CONFIRM_MS,
  type UnloadableAdapter,
} from "../src/index.js";

/**
 * Live-test F3 (MD-N14-2, MD-N14-2a): `model/unloaded` recorded `confirmed:
 * false` on every unload. A managed llama-server's unload is confirmed only
 * once its process has exited and its port is closed, polled within a bound;
 * an unload not confirmed still counts as resident memory until it is.
 */
const GB = 1024 ** 3;

let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  servers = [];
});

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  servers.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

describe("a managed llama-server's unload is confirmed by polling (MD-N14-2a)", () => {
  it("is not confirmed while something still listens on its port, within the bound", async () => {
    const { port } = await listen();
    const a = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/x.gguf", port });
    const start = Date.now();
    expect(await a.confirmUnloaded(600)).toBe(false);
    expect(Date.now() - start).toBeGreaterThanOrEqual(550);
  });

  it("is confirmed once the port closes, before the bound", async () => {
    const { server, port } = await listen();
    servers = [];
    const a = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/x.gguf", port });
    setTimeout(() => {
      server.closeAllConnections();
      server.close();
    }, 300);
    const start = Date.now();
    expect(await a.confirmUnloaded(5000)).toBe(true);
    const took = Date.now() - start;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(5000);
  });

  it("is confirmed at once when nothing listens", async () => {
    const { server, port } = await listen();
    await new Promise<void>((r) => server.close(() => r()));
    servers = [];
    const a = new ManagedLlamaServerAdapter({ modelId: "m", modelPath: "/x.gguf", port });
    expect(await a.confirmUnloaded(0)).toBe(true);
  });
});

function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "unload-confirm-"));
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

function fake(path: string, confirm: () => boolean): (ctx: number) => UnloadableAdapter {
  return (contextTokens) => ({
    modelId: path,
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens, maxTokens: 64 },
    generate: async () => ({
      text: "ok",
      toolCalls: [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    }),
    load: async () => "loaded",
    unload: async () => undefined,
    confirmUnloaded: async () => confirm(),
    weightsSource: async () => ({ path, bytes: 10 * GB }),
  });
}

function scheduler(log: EventLog, confirmA: () => boolean) {
  return new ResidencyScheduler({
    roles: [
      { role: "a", weights: "wa", contextTokens: 8192 },
      { role: "b", weights: "wb", contextTokens: 8192 },
    ],
    weights: {
      wa: { build: fake("/Users/o/a.gguf", confirmA), footprintBytes: 10 * GB },
      wb: { build: fake("/Users/o/b.gguf", () => true), footprintBytes: 10 * GB },
    },
    usableBytes: 16 * GB,
    pressureLevel: () => 1,
    swapCost: {
      record: (e) => {
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
      history: async (): Promise<SwapEvent[]> =>
        (await log.getEventsByTypes(Object.values(SWAP_EVENTS))).map((e) => ({
          type: e.type,
          payload: e.payload as SwapEvent["payload"],
          at: Date.parse(e.createdAt),
        })),
      volumeOf: () => "internal",
      swapUsedBytes: () => 0,
    },
  });
}

const unloads = async (log: EventLog) =>
  (await log.getEventsByTypes(["model/unloaded"])).map(
    (e) => e.payload as { model: string; confirmed: boolean },
  );

describe("the scheduler confirms every unload it records (MD-N14-2)", () => {
  it("a release records confirmed: true when the adapter confirms it", async () => {
    const log = ledger();
    const s = scheduler(log, () => true);
    await (await s.acquire("a")).release();
    await s.release("a");
    expect(await unloads(log)).toEqual([expect.objectContaining({ model: "wa", confirmed: true })]);
  });

  it("releasing everything confirms each unload too", async () => {
    const log = ledger();
    const s = scheduler(log, () => true);
    await (await s.acquire("a")).release();
    await s.releaseAll();
    expect(await unloads(log)).toEqual([expect.objectContaining({ model: "wa", confirmed: true })]);
  });

  it("waits at most a short bound at the unload itself; a lingering server is re-checked later, never waited on for its adapter's default", async () => {
    // An Ollama server can list a model for seconds after keep_alive 0; the
    // adapter's own default is 20 s. B4.4 live-test gate: every release waited
    // it out, blocking swaps (cli_exit went from 11 s to 70 s).
    const log = ledger();
    const asked: (number | undefined)[] = [];
    const s = new ResidencyScheduler({
      roles: [{ role: "a", weights: "wa", contextTokens: 8192 }],
      weights: {
        wa: {
          build: (contextTokens) => ({
            ...fake("/Users/o/a.gguf", () => false)(contextTokens),
            confirmUnloaded: async (timeoutMs?: number) => {
              asked.push(timeoutMs);
              return false;
            },
          }),
          footprintBytes: 10 * GB,
        },
      },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
    });
    await (await s.acquire("a")).release();
    await s.release("a");
    expect(UNLOAD_CONFIRM_MS).toBeLessThanOrEqual(3000);
    expect(asked[0]).toBe(UNLOAD_CONFIRM_MS);
  });

  it("an unconfirmed unload stays counted as resident memory until it is confirmed", async () => {
    const log = ledger();
    let gone = false;
    const s = scheduler(log, () => gone);
    await (await s.acquire("a")).release();
    await s.release("a");
    expect(await unloads(log)).toEqual([
      expect.objectContaining({ model: "wa", confirmed: false }),
    ]);
    // 10 GB not yet shown to have left + 10 GB exceeds 16 GB usable.
    await expect(s.acquire("b")).rejects.toBeInstanceOf(FootprintRefusal);
    gone = true;
    const hold = await s.acquire("b");
    hold.release();
  });
});
