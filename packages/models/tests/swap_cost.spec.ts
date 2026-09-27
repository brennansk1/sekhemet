import { mkdtempSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  COLD_LOAD_BOUND_MS,
  HttpInferenceAdapter,
  type LoadSample,
  ManagedLlamaServerAdapter,
  ResidencyScheduler,
  SWAP_EVENTS,
  SwapCostBook,
  SwapCostTracker,
  type SwapEvent,
  type UnloadableAdapter,
  volumeOf,
} from "../src/index.js";

const GB = 1024 ** 3;
const MIN = 60_000;

/**
 * A clock tests move by hand. It starts at the wall clock because the
 * ledger stamps events with it, and a new process reads unload times back
 * from those stamps; it only ever moves ahead.
 */
function fakeClock(start = Date.now()) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** A real SQLite ledger in a temporary file. */
function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "smart-swap-"));
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

async function events(log: EventLog, type?: string) {
  const all = await log.getEventsByTypes(Object.values(SWAP_EVENTS));
  return all
    .filter((e) => type === undefined || e.type === type)
    .map((e) => ({ type: e.type, ...(e.payload as Record<string, unknown>) }));
}

/**
 * A fake model whose load takes a scripted time on the fake clock. Its
 * weights file is on the named path with the given bytes.
 */
function scripted(
  clock: ReturnType<typeof fakeClock>,
  spec: {
    path: string;
    bytes: number;
    /** Load milliseconds, one per load in order; the last repeats. */
    loads: number[];
    unloadMs?: number;
    firstTokenMs?: number;
    /** A streamed reply's time after its first token. */
    restMs?: number;
    /** Already served by a running server: adopted, not loaded. */
    adopted?: boolean;
    failLoad?: string;
  },
) {
  let n = 0;
  let loaded = spec.adopted === true;
  const calls: string[] = [];
  return {
    calls,
    build: (contextTokens: number): UnloadableAdapter => ({
      modelId: spec.path,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens, maxTokens: 64 },
      generate: async (req) => {
        calls.push("generate");
        clock.advance(spec.firstTokenMs ?? 0);
        // Streamed: the first token now, the rest of the reply after it.
        if (req.onToken) {
          req.onToken("o");
          clock.advance(spec.restMs ?? 0);
        }
        return {
          text: "ok",
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        };
      },
      load: async () => {
        if (spec.failLoad) throw new Error(spec.failLoad);
        if (loaded) return "adopted";
        clock.advance(spec.loads[Math.min(n, spec.loads.length - 1)] as number);
        n++;
        loaded = true;
        calls.push("load");
        return "loaded";
      },
      unload: async () => {
        clock.advance(spec.unloadMs ?? 0);
        loaded = false;
        calls.push("unload");
      },
      confirmUnloaded: async () => true,
      weightsSource: async () => ({ path: spec.path, bytes: spec.bytes }),
    }),
  };
}

const volumes = (path: string) => (path.startsWith("/Volumes/") ? "external" : "internal");

describe("NEW-models-14: Smart Swap — the record, the prediction and the slow-load flag", () => {
  it("volumeOf: a file on the home directory's device is internal; one under another mount is external", () => {
    const dir = mkdtempSync(join(tmpdir(), "vol-"));
    const file = join(dir, "w.gguf");
    writeFileSync(file, "x");
    expect(volumeOf(file)).toBe("internal");
  });

  it("volumeOf judges by device, never by the path's prefix: injected stat results", () => {
    // The system volume is device 1, the home directory's device 2, a USB drive 7.
    const devices: Record<string, number> = {
      "/": 1,
      "/home/me": 2,
      "/home/me/models/w.gguf": 2,
      "/opt/models/w.gguf": 1,
      "/Volumes/Passport/w.gguf": 7,
      "/srv/usb/w.gguf": 7,
      "/Volumes": 1,
    };
    const deps = { home: "/home/me", dev: (p: string) => devices[p] };
    expect(volumeOf("/home/me/models/w.gguf", deps)).toBe("internal");
    expect(volumeOf("/opt/models/w.gguf", deps)).toBe("internal");
    expect(volumeOf("/Volumes/Passport/w.gguf", deps)).toBe("external");
    // A mount without a telltale prefix is external by its device alone.
    expect(volumeOf("/srv/usb/w.gguf", deps)).toBe("external");
    // A file that cannot be read is judged by its nearest readable directory.
    expect(volumeOf("/Volumes/Gone/w.gguf", deps)).toBe("internal");
  });

  it("MD-N14-4: before three loads the prediction is a stated estimate from the size and the volume's read rate", () => {
    const book = new SwapCostBook();
    const worker = book.predict({ model: "cyber", volume: "external", cache: "cold", bytes: 13e9 });
    expect(worker.basis).toBe("estimate");
    // 5 s of startup plus 13 GB at the stated 40 MB/s.
    expect(worker.medianMs).toBe(5000 + 325_000);
    expect(worker.p90Ms).toBe(worker.medianMs);
    const warm = book.predict({ model: "cyber", volume: "external", cache: "warm", bytes: 13e9 });
    expect(warm.medianMs).toBe(5000 + 3250);
    const internal = book.predict({ model: "q", volume: "internal", cache: "cold", bytes: 12e9 });
    expect(internal.medianMs).toBe(5000 + 6000);
  });

  it("MD-N14-4: the volume's read rate is measured from cold loads on it, any weights", () => {
    const book = new SwapCostBook([
      { model: "a", volume: "external", cache: "cold", bytes: 10e9, loadMs: 5000 + 100_000 },
    ]);
    // 100 MB/s measured; another model's estimate on that volume uses it.
    const b = book.predict({ model: "b", volume: "external", cache: "cold", bytes: 5e9 });
    expect(b).toMatchObject({ basis: "estimate", medianMs: 5000 + 50_000 });
    expect(book.readRate("external")).toEqual({ bytesPerSecond: 100e6, basis: "measured" });
    expect(book.readRate("internal").basis).toBe("default");
  });

  it("MD-N14-4: with three or more loads the prediction is the median and p90 of the last 20", () => {
    const loads = [100, 120, 110, 400, 105].map(
      (s): LoadSample => ({
        model: "m",
        volume: "internal",
        cache: "cold",
        bytes: 1e9,
        loadMs: s * 1000,
      }),
    );
    const book = new SwapCostBook(loads);
    const p = book.predict({ model: "m", volume: "internal", cache: "cold", bytes: 1e9 });
    expect(p).toMatchObject({ basis: "measured", samples: 5, medianMs: 110_000, p90Ms: 400_000 });
    // Only the last 20 count.
    const many = new SwapCostBook([
      ...Array.from({ length: 20 }, () => ({ ...loads[0], loadMs: 900_000 }) as LoadSample),
      ...Array.from({ length: 20 }, () => ({ ...loads[0], loadMs: 60_000 }) as LoadSample),
    ]);
    expect(many.predict({ model: "m", volume: "internal", cache: "cold", bytes: 1e9 }).p90Ms).toBe(
      60_000,
    );
  });

  it("MD-N14-1, -2, -5: a swap to Seshat and back is recorded on the ledger, and the first cold USB load is flagged", async () => {
    const clock = fakeClock();
    const log = ledger();
    const worker = scripted(clock, {
      path: "/Volumes/My Passport/AI-Models/llm/cyber.gguf",
      bytes: 13 * GB,
      loads: [300_000, 20_000],
      unloadMs: 4000,
      firstTokenMs: 2500,
    });
    const seshat = scripted(clock, {
      path: "/Users/o/models/qwen.gguf",
      bytes: 12 * GB,
      loads: [9000],
    });
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "cyber", contextTokens: 16_384 },
        { role: "seshat", weights: "qwen", contextTokens: 8192 },
      ],
      weights: {
        cyber: { build: worker.build, footprintBytes: 14 * GB },
        qwen: { build: seshat.build, footprintBytes: 13 * GB },
      },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      now: clock.now,
      swapCost: { ...wire(log), volumeOf: volumes, swapUsedBytes: () => 0 },
    });
    await s.submit("worker", (a) => a.generate({ prompt: "p", toolArm: "arm_a_flat" }));
    await s.submit("seshat", (a) => a.generate({ prompt: "q", toolArm: "arm_a_flat" }));
    await s.submit("worker", (a) => a.generate({ prompt: "p", toolArm: "arm_a_flat" }));

    const all = await events(log);
    expect(all.map((e) => e.type)).toEqual([
      "model/loaded",
      "model/slow_load",
      "model/first_token",
      "model/unloaded",
      "model/loaded",
      "model/first_token",
      "model/unloaded",
      "model/loaded",
      "model/first_token",
    ]);
    expect(all[0]).toMatchObject({
      model: "cyber",
      roles: ["worker"],
      volume: "external",
      bytes: 13 * GB,
      cache: "cold",
      loadMs: 300_000,
      basis: "estimate",
    });
    expect(all[1]).toMatchObject({
      model: "cyber",
      loadMs: 300_000,
      boundMs: COLD_LOAD_BOUND_MS,
      causes: ["external_volume", "cold_cache"],
      fixes: ["copy_to_internal", "prewarm_overnight"],
    });
    // Live-test F14: a reply that did not stream has no first token of its own;
    // its whole time is recorded as the reply time, never as a first token.
    expect(all[2]).toMatchObject({ model: "cyber", replyMs: 2500 });
    expect(all[2]).not.toHaveProperty("firstTokenMs");
    expect(all[3]).toMatchObject({
      model: "cyber",
      unloadMs: 4000,
      confirmed: true,
      volume: "external",
    });
    expect(all[4]).toMatchObject({
      model: "qwen",
      volume: "internal",
      cache: "cold",
      loadMs: 9000,
    });
    // Seshat's 12 GB went through the file cache after the Worker left: predicted cold again
    // (MD-N14-3 as amended: the prediction), at the drive's measured cold rate, 300 s.
    // MD-N14-10: the recorded state is measured: 13 GB in 20 s is far above that rate, so warm.
    expect(all[7]).toMatchObject({
      model: "cyber",
      cache: "warm",
      loadMs: 20_000,
      medianMs: 300_000,
    });
    // No flag: under the 120 s bound.
    expect(all.filter((e) => e.type === "model/slow_load")).toHaveLength(1);
  });

  it("F14: a streamed first reply records its true first token; a non-streamed one only its reply time, which never enters C_pair's first-token excess", async () => {
    const clock = fakeClock();
    const log = ledger();
    const worker = scripted(clock, {
      path: "/Users/o/w.gguf",
      bytes: 4 * GB,
      loads: [30_000],
      firstTokenMs: 800,
      restMs: 9200,
    });
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
      weights: { w: { build: worker.build, footprintBytes: 5 * GB } },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      now: clock.now,
      swapCost: { ...wire(log), volumeOf: volumes, swapUsedBytes: () => 0 },
    });
    await s.submit("worker", (a) =>
      a.generate({ prompt: "p", toolArm: "arm_a_flat", onToken: () => undefined }),
    );
    const [first] = await events(log, "model/first_token");
    expect(first).toMatchObject({ model: "w", firstTokenMs: 800 });
    expect(first).not.toHaveProperty("replyMs");

    // Non-streamed after a load: the 10 s reply is not a first token.
    const book = new SwapCostTracker({ now: clock.now, cacheBytes: 16 * GB });
    await book.firstToken({ model: "x", roles: ["worker"], replyMs: 10_000 });
    expect(book.book.firstTokenExcess("x")).toBeUndefined();
    await book.firstToken({ model: "x", roles: ["worker"], firstTokenMs: 900 });
    expect(book.book.firstTokenExcess("x")).toBe(900);
  });

  it("MD-N14-3: a reload within 15 minutes with nothing big in between is warm; after 15 minutes it is cold", async () => {
    const clock = fakeClock();
    const log = ledger();
    const worker = scripted(clock, {
      path: "/Users/o/w.gguf",
      bytes: 4 * GB,
      loads: [30_000, 3000, 30_000],
    });
    const small = scripted(clock, { path: "/Users/o/s.gguf", bytes: 2 * GB, loads: [2000] });
    const s = new ResidencyScheduler({
      roles: [
        { role: "worker", weights: "w", contextTokens: 8192 },
        { role: "small", weights: "s", contextTokens: 8192 },
      ],
      weights: {
        w: { build: worker.build, footprintBytes: 5 * GB },
        s: { build: small.build, footprintBytes: 3 * GB },
      },
      usableBytes: 16 * GB,
      coResident: false,
      pressureLevel: () => 1,
      now: clock.now,
      swapCost: { ...wire(log), volumeOf: volumes, swapUsedBytes: () => 0 },
    });
    await (await s.acquire("worker")).release();
    await (await s.acquire("small")).release();
    clock.advance(5 * MIN);
    await (await s.acquire("worker")).release();
    await s.release("worker");
    clock.advance(16 * MIN);
    await (await s.acquire("worker")).release();
    const loads = (await events(log, "model/loaded")).filter((e) => e.model === "w");
    expect(loads.map((e) => e.cache)).toEqual(["cold", "warm", "cold"]);
  });

  it("MD-N14-4: a new process predicts from the loads recorded on the ledger before it", async () => {
    const clock = fakeClock();
    const log = ledger();
    const make = () => {
      const w = scripted(clock, { path: "/Users/o/w.gguf", bytes: 4 * GB, loads: [40_000] });
      return new ResidencyScheduler({
        roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
        weights: { w: { build: w.build, footprintBytes: 5 * GB } },
        usableBytes: 16 * GB,
        pressureLevel: () => 1,
        now: clock.now,
        swapCost: { ...wire(log), volumeOf: volumes, swapUsedBytes: () => 0 },
      });
    };
    for (let i = 0; i < 3; i++) {
      const s = make();
      await (await s.acquire("worker")).release();
      await s.releaseAll();
      clock.advance(20 * MIN);
    }
    const fresh = make();
    expect(await fresh.predictLoad("worker")).toMatchObject({
      basis: "measured",
      samples: 3,
      medianMs: 40_000,
      cache: "cold",
      volume: "internal",
    });
  });

  it("MD-N14-5: past 1.5 x p90 with history is flagged, naming memory pressure and swap in use", async () => {
    const clock = fakeClock();
    const log = ledger();
    let pressure = 1;
    let swap = 0;
    const w = scripted(clock, {
      path: "/Users/o/w.gguf",
      bytes: 4 * GB,
      loads: [10_000, 11_000, 12_000, 12_000, 30_000],
    });
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
      weights: { w: { build: w.build, footprintBytes: 5 * GB } },
      usableBytes: 16 * GB,
      pressureLevel: () => pressure,
      now: clock.now,
      swapCost: { ...wire(log), volumeOf: volumes, swapUsedBytes: () => swap },
    });
    for (let i = 0; i < 5; i++) {
      if (i === 4) {
        pressure = 2;
        swap = 2 * GB;
      }
      await (await s.acquire("worker")).release();
      await s.releaseAll();
      clock.advance(20 * MIN);
    }
    const flags = await events(log, "model/slow_load");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      loadMs: 30_000,
      boundMs: 18_000,
      causes: ["memory_pressure", "swap_in_use", "cold_cache"],
      fixes: ["free_memory", "prewarm_overnight"],
    });
  });

  it("MD-N14-1: weights a running server already serves are adopted, and no load is recorded", async () => {
    const clock = fakeClock();
    const log = ledger();
    const w = scripted(clock, {
      path: "/Users/o/w.gguf",
      bytes: 4 * GB,
      loads: [10_000],
      adopted: true,
    });
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
      weights: { w: { build: w.build, footprintBytes: 5 * GB } },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      now: clock.now,
      swapCost: { ...wire(log), volumeOf: volumes },
    });
    await s.submit("worker", (a) => a.generate({ prompt: "p", toolArm: "arm_a_flat" }));
    expect(await events(log)).toEqual([]);
  });

  it("MD-N14-6: a load that fails for a reason other than memory rejects the queued work", async () => {
    const clock = fakeClock();
    const w = scripted(clock, {
      path: "/Users/o/w.gguf",
      bytes: 4 * GB,
      loads: [1],
      failLoad: "Model file not found",
    });
    const s = new ResidencyScheduler({
      roles: [{ role: "worker", weights: "w", contextTokens: 8192 }],
      weights: { w: { build: w.build, footprintBytes: 5 * GB } },
      usableBytes: 16 * GB,
      pressureLevel: () => 1,
      now: clock.now,
    });
    await expect(s.submit("worker", async () => "ran")).rejects.toThrow(/Model file not found/);
    expect(s.residentWeights()).toEqual([]);
    expect(s.waiting("worker")).toBe(0);
  });

  it("MD-N14-3: the ledger refuses a swap record with a field that is not registered", () => {
    const log = ledger();
    expect(() =>
      log.appendNow({
        actor: "harness",
        type: "model/loaded",
        payload: {
          model: "w",
          roles: ["worker"],
          volume: "internal",
          bytes: 1,
          cache: "cold",
          loadMs: 1,
          medianMs: 1,
          p90Ms: 1,
          basis: "estimate",
          path: "/Users/o/w.gguf",
        },
      }),
    ).toThrow(/path/);
  });

  it("MD-N14-1: an Ollama adapter loads at its own window when asked, and adopts a resident model", async () => {
    const posts: unknown[] = [];
    let resident = false;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/ps") {
          res.end(JSON.stringify({ models: resident ? [{ name: "m:7b" }] : [] }));
        } else if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "m:7b", size: 5 * GB }] }));
        } else {
          posts.push(JSON.parse(body));
          resident = true;
          res.end(JSON.stringify({ done: true }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const adapter = new HttpInferenceAdapter({
        modelId: "m:7b",
        baseUrl: url,
        apiFormat: "ollama",
        contextTokens: 12_288,
      });
      expect(await adapter.load()).toBe("loaded");
      expect(posts).toEqual([
        expect.objectContaining({ model: "m:7b", options: { num_ctx: 12_288 } }),
      ]);
      expect(await adapter.load()).toBe("adopted");
      expect(posts).toHaveLength(1);
      expect((await adapter.weightsSource())?.bytes).toBe(5 * GB);
    } finally {
      server.close();
    }
  });

  it("MD-N14-1: a managed llama-server names its weights file and bytes, and none when it is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "weights-"));
    const file = join(dir, "w.gguf");
    writeFileSync(file, Buffer.alloc(1234));
    const make = (modelPath: string) =>
      new ManagedLlamaServerAdapter({
        modelId: "w",
        modelPath,
        port: 1,
        contextTokens: 4096,
      });
    expect(await make(file).weightsSource()).toEqual({ path: file, bytes: 1234 });
    expect(await make(join(dir, "missing.gguf")).weightsSource()).toBeUndefined();
  });
});
