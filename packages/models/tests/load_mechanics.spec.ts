import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  AB_MIN_LOADS_PER_MODE,
  ContextShrinkError,
  DriveUnavailableError,
  LOAD_MODE_AB_EVENT,
  LOAD_OVERHEAD_MS,
  ManagedLlamaServerAdapter,
  SWAP_EVENTS,
  SwapCostBook,
  SwapCostTracker,
  VolumeProber,
  abOrder,
  assertLaunchFlags,
  assertServedContext,
  cacheRamMiBFromHeadroom,
  checkDrive,
  checkOllamaQuantisation,
  chooseLoadMode,
  classifyCacheByReadRate,
  loadModeArgs,
  loadModeFor,
  predictWithProbe,
  prereadSequential,
  readProbe,
  runLoadModeAb,
} from "../src/index.js";
import { fakeServer } from "./support/fake_server.js";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "load-mech-"));
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

function tempFile(bytes: number): string {
  const dir = mkdtempSync(join(tmpdir(), "weights-"));
  const path = join(dir, "m.gguf");
  writeFileSync(path, Buffer.alloc(bytes, 7));
  return path;
}

describe("MD-N14-34: the load-mode A/B", () => {
  it("maps each mode to its launch: mmap and pre-read pass nothing, --no-mmap passes it", () => {
    expect(loadModeArgs("mmap")).toEqual([]);
    expect(loadModeArgs("preread_mmap")).toEqual([]);
    expect(loadModeArgs("no_mmap")).toEqual(["--no-mmap"]);
  });

  it("alternates the modes, three loads each", () => {
    expect(abOrder()).toEqual([
      "mmap",
      "no_mmap",
      "preread_mmap",
      "mmap",
      "no_mmap",
      "preread_mmap",
      "mmap",
      "no_mmap",
      "preread_mmap",
    ]);
    expect(AB_MIN_LOADS_PER_MODE).toBe(3);
  });

  it("an A/B with fewer than three loads of a mode decides nothing", () => {
    const r = chooseLoadMode([
      { mode: "mmap", loadMs: 300_000, firstTokenMs: 1000 },
      { mode: "no_mmap", loadMs: 150_000, firstTokenMs: 1000 },
      { mode: "no_mmap", loadMs: 150_000, firstTokenMs: 1000 },
      { mode: "no_mmap", loadMs: 150_000, firstTokenMs: 1000 },
    ]);
    expect(r.decided).toBe(false);
    expect(r.mode).toBe("mmap");
  });

  it("chooses the lowest median load plus first token", () => {
    const loads = abOrder().map((mode, i) => ({
      mode,
      loadMs: mode === "mmap" ? 300_000 : mode === "no_mmap" ? 140_000 + i : 150_000,
      firstTokenMs: mode === "no_mmap" ? 20_000 : 1000,
    }));
    const r = chooseLoadMode(loads);
    expect(r.decided).toBe(true);
    // no_mmap 160 s against pre-read 151 s.
    expect(r.mode).toBe("preread_mmap");
  });

  it("uses mmap until an A/B is recorded for the volume and engine", () => {
    expect(loadModeFor([], "external", "llama.cpp")).toBe("mmap");
    const rec = {
      model: "w",
      volume: "external" as const,
      engine: "llama.cpp" as const,
      modes: [],
      decided: true,
      chosen: "no_mmap" as const,
      cache: "cold" as const,
    };
    expect(loadModeFor([rec], "external", "llama.cpp")).toBe("no_mmap");
    expect(loadModeFor([rec], "internal", "llama.cpp")).toBe("mmap");
    expect(loadModeFor([{ ...rec, decided: false }], "external", "llama.cpp")).toBe("mmap");
    // Live-test F13: a comparison of warm (or mixed) loads decides nothing for cold ones.
    expect(loadModeFor([{ ...rec, cache: "warm" }], "external", "llama.cpp")).toBe("mmap");
    expect(loadModeFor([{ ...rec, cache: "mixed" }], "external", "llama.cpp")).toBe("mmap");
  });

  it("F13: times only the unload, records confirmed from the check, a true first token or the reply time, and the cache state compared", async () => {
    const log = ledger();
    let t = Date.now();
    const tracker = new SwapCostTracker({
      now: () => t,
      cacheBytes: 8 * GiB,
      record: (e) => {
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
    });
    let n = 0;
    const result = await runLoadModeAb({
      model: "worker",
      roles: ["worker"],
      volume: "internal",
      engine: "llama.cpp",
      bytes: 13.6e9,
      coldBytesPerSecond: 1.5e9,
      tracker,
      now: () => t,
      // The first load cold (10 s), every later one from the page cache (2 s).
      load: async () => {
        t += n++ === 0 ? 10_000 : 2000;
      },
      // Streamed on odd loads: a true first token of 300 ms in a 1 s reply.
      firstToken: async () => {
        t += 1000;
        return n % 2 === 1 ? 300 : undefined;
      },
      unload: async () => {
        t += 150;
      },
      // The check takes 5 s and proves the unload only on some loads.
      confirmUnloaded: async () => {
        t += 5000;
        return n % 3 !== 0;
      },
      record: (e) => {
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
    });
    const unloaded = (await log.getEventsByTypes([SWAP_EVENTS.unloaded])).map(
      (e) => e.payload as { unloadMs: number; confirmed: boolean },
    );
    expect(unloaded).toHaveLength(9);
    expect(unloaded.every((u) => u.unloadMs === 150)).toBe(true);
    expect(unloaded.map((u) => u.confirmed)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => i % 3 !== 0),
    );
    const first = (await log.getEventsByTypes([SWAP_EVENTS.firstToken])).map(
      (e) => e.payload as { firstTokenMs?: number; replyMs?: number },
    );
    expect(first[0]).toEqual(expect.objectContaining({ firstTokenMs: 300 }));
    expect(first[0]).not.toHaveProperty("replyMs");
    expect(first[1]).toEqual(expect.objectContaining({ replyMs: 1000 }));
    expect(first[1]).not.toHaveProperty("firstTokenMs");
    expect(result.cache).toBe("mixed");
    expect(loadModeFor([result], "internal", "llama.cpp")).toBe("mmap");
  });

  it("F13: compares cold loads when it can empty the page cache before each load", async () => {
    let t = Date.now();
    const tracker = new SwapCostTracker({ now: () => t, cacheBytes: 8 * GiB });
    let cached = false;
    const result = await runLoadModeAb({
      model: "worker",
      roles: ["worker"],
      volume: "internal",
      engine: "llama.cpp",
      bytes: 13.6e9,
      coldBytesPerSecond: 1.5e9,
      tracker,
      now: () => t,
      evictCache: async () => {
        cached = false;
      },
      load: async () => {
        t += cached ? 2000 : 10_000;
        cached = true;
      },
      firstToken: async () => 300,
      unload: async () => undefined,
      confirmUnloaded: async () => true,
      record: () => undefined,
    });
    expect(result.cache).toBe("cold");
    expect(result.decided).toBe(true);
  });

  it("runs the A/B on a fake adapter and records every load with its mode, then the A/B", async () => {
    const log = ledger();
    let t = Date.now();
    const scripted: Record<string, number> = {
      mmap: 300_000,
      no_mmap: 160_000,
      preread_mmap: 140_000,
    };
    const loadsSeen: string[] = [];
    const tracker = new SwapCostTracker({
      now: () => t,
      cacheBytes: 8 * GiB,
      record: (e) => {
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
    });
    const result = await runLoadModeAb({
      model: "worker",
      roles: ["worker"],
      volume: "external",
      engine: "llama.cpp",
      bytes: 13.6e9,
      coldBytesPerSecond: 105e6,
      tracker,
      now: () => t,
      load: async (mode) => {
        loadsSeen.push(mode);
        t += scripted[mode] as number;
      },
      firstToken: async () => {
        t += 1000;
      },
      unload: async () => {
        t += 2000;
      },
      record: (e) => {
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
    });
    expect(loadsSeen).toEqual(abOrder());
    expect(result.chosen).toBe("preread_mmap");
    const loaded = (await log.getEventsByTypes([SWAP_EVENTS.loaded])).map(
      (e) => e.payload as { loadMode: string; engine: string; cache: string },
    );
    expect(loaded).toHaveLength(9);
    expect(loaded.map((l) => l.loadMode)).toEqual(abOrder());
    expect(loaded.every((l) => l.engine === "llama.cpp" && l.cache === "cold")).toBe(true);
    const ab = await log.getEventsByTypes([LOAD_MODE_AB_EVENT]);
    expect(ab).toHaveLength(1);
    expect((ab[0]?.payload as { chosen: string }).chosen).toBe("preread_mmap");
  });
});

describe("the pre-read and the 256 MB read probe (MD-N14-9)", () => {
  it("pre-reads a file sequentially", async () => {
    const path = tempFile(3 * MiB + 17);
    const r = await prereadSequential(path, { chunkBytes: MiB });
    expect(r.bytes).toBe(3 * MiB + 17);
  });

  it("probes a volume's sequential read rate from up to 256 MB of the file", async () => {
    const path = tempFile(4 * MiB);
    let t = 0;
    const r = await readProbe(path, {
      now: () => {
        const v = t;
        t += 100;
        return v;
      },
    });
    expect(r.bytesRead).toBe(4 * MiB);
    // 4 MiB over the scripted 100 ms.
    expect(r.bytesPerSecond).toBe(4 * MiB * 10);
  });

  it("replaces the default rate with the probe, plus the spin-up, as a ±50% estimate", () => {
    const book = new SwapCostBook();
    const base = book.predict({ model: "w", volume: "external", cache: "cold", bytes: 13.6e9 });
    const p = predictWithProbe(base, book, { bytesPerSecond: 105e6, spinUpMs: 4000 });
    const expected = Math.round(LOAD_OVERHEAD_MS + (13.6e9 / 105e6) * 1000 + 4000);
    expect(p.medianMs).toBe(expected);
    expect(p.basis).toBe("estimate");
    expect(p.spread).toBe(0.5);
    expect(p.spinUpMs).toBe(4000);
    expect(p.rateBasis).toBe("probe");
  });

  it("keeps a measured prediction, adding only the spin-up", () => {
    const book = new SwapCostBook(
      [60_000, 61_000, 62_000].map((loadMs) => ({
        model: "w",
        volume: "external" as const,
        cache: "cold" as const,
        bytes: 1e9,
        loadMs,
      })),
    );
    const base = book.predict({ model: "w", volume: "external", cache: "cold", bytes: 1e9 });
    const p = predictWithProbe(base, book, { bytesPerSecond: 105e6, spinUpMs: 3000 });
    expect(p.basis).toBe("measured");
    expect(p.medianMs).toBe(base.medianMs + 3000);
  });

  it("falls back to the stated rates when no probe can run", () => {
    const book = new SwapCostBook();
    const base = book.predict({ model: "w", volume: "external", cache: "cold", bytes: 1e9 });
    expect(predictWithProbe(base, book, undefined)).toMatchObject({
      medianMs: base.medianMs,
      rateBasis: "default",
    });
  });
});

describe("MD-N14-10: cold or warm by the load's effective read rate", () => {
  it("classifies against the volume's cold rate", () => {
    expect(
      classifyCacheByReadRate({ bytes: 13.6e9, loadMs: 300_000, coldBytesPerSecond: 105e6 }),
    ).toBe("cold");
    expect(
      classifyCacheByReadRate({ bytes: 13.6e9, loadMs: 10_000, coldBytesPerSecond: 105e6 }),
    ).toBe("warm");
  });
});

describe("MD-N14-35: the guards", () => {
  it("refuses --mlock and direct I/O", () => {
    expect(() => assertLaunchFlags(["-m", "x", "--mlock"])).toThrow(/mlock/);
    expect(() => assertLaunchFlags(["-m", "x", "--direct-io"])).toThrow(/direct I\/O/);
    expect(() => assertLaunchFlags(["-m", "x", "-dio"])).toThrow(/direct I\/O/);
    expect(() => assertLaunchFlags(["-m", "x", "--no-mmap"])).not.toThrow();
  });

  it("sizes --cache-ram from the headroom, never the 8 GiB default", () => {
    expect(cacheRamMiBFromHeadroom(16 * GiB, 14 * GiB)).toBe(1024);
    expect(cacheRamMiBFromHeadroom(10 * GiB, 14 * GiB)).toBe(0);
    expect(cacheRamMiBFromHeadroom(64 * GiB, 14 * GiB)).toBe(4096);
  });

  it("refuses a server whose served context is smaller than requested (--fit's silent shrink)", () => {
    expect(() => assertServedContext(16384, 8192)).toThrow(ContextShrinkError);
    expect(() => assertServedContext(16384, 16384)).not.toThrow();
  });

  it("an adapter launch refuses --mlock in extra arguments and passes the load mode", () => {
    const a = new ManagedLlamaServerAdapter({
      modelId: "x",
      modelPath: "/x.gguf",
      extraArgs: ["--mlock"],
    });
    expect(() => a.launchArgs()).toThrow(/mlock/);
    const b = new ManagedLlamaServerAdapter({ modelId: "x", modelPath: "/x.gguf" });
    expect(b.launchArgs({ loadMode: "no_mmap", cacheRamMiB: 512 })).toContain("--no-mmap");
    const args = b.launchArgs({ cacheRamMiB: 512 });
    expect(args[args.indexOf("--cache-ram") + 1]).toBe("512");
    expect(b.launchArgs()).not.toContain("--no-mmap");
  });

  it("detects a disconnected drive before a load", async () => {
    const d = await checkDrive("/Volumes/No Such Drive 9f3a/llm/m.gguf");
    expect(d.state).toBe("disconnected");
    expect(d.reason).toMatch(/No Such Drive 9f3a/);
    expect(new DriveUnavailableError(d.reason ?? "")).toBeInstanceOf(Error);
  });

  it("names a missing file on a present volume as missing, not disconnected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-"));
    expect((await checkDrive(join(dir, "gone.gguf"))).state).toBe("missing");
  });

  it("detects a spun-down drive by a small timed read, and measures the spin-up", async () => {
    const path = tempFile(64 * 1024);
    const times = [0, 3500];
    const d = await checkDrive(path, { now: () => times.shift() ?? 3500 });
    expect(d.state).toBe("spun_down");
    expect(d.spinUpMs).toBe(3500);
    const fast = [0, 5];
    expect((await checkDrive(path, { now: () => fast.shift() ?? 5 })).state).toBe("ready");
  });

  it("flags a model Ollama serves requantised", async () => {
    const srv = await fakeServer((req) =>
      req.url === "/api/show"
        ? { json: { details: { quantization_level: "Q4_K_M" } } }
        : { json: { models: [{ name: "cyber:latest", digest: "a".repeat(64) }] } },
    );
    closers.push(srv.close);
    const flagged = await checkOllamaQuantisation(srv.url, "cyber:latest", { quant: "IQ3_XXS" });
    expect(flagged.requantised).toBe(true);
    expect(flagged.reason).toMatch(/IQ3_XXS/);
    const same = await checkOllamaQuantisation(srv.url, "cyber:latest", {
      quant: "q4_k_m",
      sha256: "a".repeat(64),
    });
    expect(same.requantised).toBe(false);
    const otherHash = await checkOllamaQuantisation(srv.url, "cyber:latest", {
      quant: "Q4_K_M",
      sha256: "b".repeat(64),
    });
    expect(otherHash.requantised).toBe(true);
  });
});

describe("the volume prober: the drive every load, the 256 MB probe once per volume", () => {
  it("probes a volume once, checks the drive each time, and reports a disconnected drive", async () => {
    let probes = 0;
    const prober = new VolumeProber({
      readProbe: async () => {
        probes++;
        return { bytesRead: 1, ms: 1, bytesPerSecond: 105e6 };
      },
    });
    const path = tempFile(8192);
    const a = await prober.probe(path, "external");
    const b = await prober.probe(path, "external");
    expect(a.bytesPerSecond).toBe(105e6);
    expect(b.bytesPerSecond).toBe(105e6);
    expect(probes).toBe(1);
    const gone = await prober.probe("/Volumes/No Such Drive 9f3a/m.gguf", "external");
    expect(gone.state).toBe("disconnected");
    expect(gone.bytesPerSecond).toBeUndefined();
  });
});
