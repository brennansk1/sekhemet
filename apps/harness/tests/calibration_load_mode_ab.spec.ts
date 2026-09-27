import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import {
  AB_MIN_LOADS_PER_MODE,
  LOAD_MODE_AB_EVENT,
  type LoadOptions,
  SWAP_EVENTS,
  type UnloadableAdapter,
  abOrder,
} from "@sekhemet/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelAccess } from "../src/model_access.js";
import { beginCalibrationNight } from "../src/smart_swap.js";

/**
 * Live-test F13: the load-mode A/B (`runLoadModeAb`) had no product caller.
 * A calibration night (`overnight --calibration-night --permit-loads`) now
 * runs it for each llama.cpp model before the night's work, at least three
 * loads per mode, each load checked against DEC-42 first; `confirmed` comes
 * from the adapter's own check, and only the unload is timed. Fake adapters
 * on a real ledger; no model is loaded.
 */
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
let dir: string;
let db: DatabaseSync;
let log: EventLog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sek-cal-ab-"));
  db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  log = new EventLog(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function llamaFake(name: string, file: string, events: string[]): UnloadableAdapter {
  let loaded = false;
  let unloads = 0;
  return {
    modelId: name,
    engine: "llama.cpp",
    supportedArms: ["arm_a_flat"],
    contextWindow: { contextTokens: 8192, maxTokens: 512 },
    load: async (_signal?: AbortSignal, opts: LoadOptions = {}) => {
      events.push(`load ${name} ${opts.loadMode ?? "default"}`);
      loaded = true;
      return "loaded";
    },
    unload: async () => {
      events.push(`unload ${name}`);
      loaded = false;
      unloads++;
    },
    // The server's own check; this one fails to prove every third unload.
    confirmUnloaded: async () => {
      events.push(`confirm ${name}`);
      return unloads % 3 !== 0;
    },
    footprintBytes: async () => 12 * GiB,
    weightsSource: async () => ({ path: file, bytes: 1 * MiB }),
    generate: async (req) => {
      events.push(`gen ${name}${loaded ? "" : " (not loaded)"}`);
      req.onToken?.("O");
      return {
        text: "OK",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      };
    },
  } as UnloadableAdapter;
}

describe("a calibration night runs the load-mode A/B (live-test F13)", () => {
  it("runs at least three loads per mode per llama.cpp model before the night's work, DEC-42 checked before each", async () => {
    const file = join(dir, "w.gguf");
    writeFileSync(file, Buffer.alloc(1 * MiB));
    const events: string[] = [];
    const made = new Map<string, UnloadableAdapter>();
    const access = ModelAccess.forQueues(
      [
        { queue: "worker", role: "worker", name: "w" },
        { queue: "manager", role: "planner", name: "m" },
      ],
      {
        resolve: (name) => {
          const a = made.get(name) ?? llamaFake(name, file, events);
          made.set(name, a);
          return a;
        },
        usableBytes: 20 * GiB,
        coResident: false,
        healthCheck: false,
        pressureLevel: () => 1,
        ledger: log,
      },
    );
    let hostReads = 0;
    const night = await beginCalibrationNight(access, {
      record: (e) => log.appendNow({ actor: "harness", type: e.type, payload: e.payload }),
      runnerHolder: () => undefined,
      host: () => {
        hostReads++;
        events.push("host check");
        return { swapUsedBytes: 0, freeRatio: 0.7 };
      },
      models: ["w", "m"],
    });
    expect("end" in night).toBe(true);
    const abs = await log.getEventsByTypes([LOAD_MODE_AB_EVENT]);
    expect(abs.map((e) => (e.payload as { model: string }).model).sort()).toEqual(["m", "w"]);
    for (const e of abs) {
      const p = e.payload as { modes: { loads: number }[]; cache: string };
      expect(p.modes).toHaveLength(3);
      expect(p.modes.every((m) => m.loads >= AB_MIN_LOADS_PER_MODE)).toBe(true);
      expect(["cold", "warm", "mixed"]).toContain(p.cache);
    }
    const loads = events.filter((e) => e.startsWith("load w "));
    expect(loads.map((l) => l.split(" ")[2])).toEqual(abOrder());
    // DEC-42 before every A/B load: a host check right before each load.
    events.forEach((e, i) => {
      if (e.startsWith("load ")) expect(events[i - 1]).toBe("host check");
    });
    expect(hostReads).toBeGreaterThanOrEqual(2 * abOrder().length);
    // Confirmed from the check, never assumed.
    const unloaded = (await log.getEventsByTypes([SWAP_EVENTS.unloaded])).map(
      (e) => e.payload as { model: string; confirmed: boolean },
    );
    expect(unloaded.filter((u) => u.model === "w").map((u) => u.confirmed)).toEqual(
      abOrder().map((_, i) => (i + 1) % 3 !== 0),
    );
    // Every first reply streamed: a true first token, no reply time.
    const first = await log.getEventsByTypes([SWAP_EVENTS.firstToken]);
    expect(
      first.every((e) => (e.payload as { firstTokenMs?: number }).firstTokenMs !== undefined),
    ).toBe(true);
    // Each A/B load was unloaded before the night's work: nothing resident.
    expect(access.residentRoles()).toEqual([]);
    if ("end" in night) await night.end();
  });

  it("stops a model's A/B when DEC-42 refuses a load, and the night still begins", async () => {
    const file = join(dir, "w.gguf");
    writeFileSync(file, Buffer.alloc(1 * MiB));
    const events: string[] = [];
    const made = new Map<string, UnloadableAdapter>();
    const access = ModelAccess.forQueues([{ queue: "worker", role: "worker", name: "w" }], {
      resolve: (name) => {
        const a = made.get(name) ?? llamaFake(name, file, events);
        made.set(name, a);
        return a;
      },
      usableBytes: 20 * GiB,
      coResident: false,
      healthCheck: false,
      pressureLevel: () => 1,
      ledger: log,
    });
    let reads = 0;
    const night = await beginCalibrationNight(access, {
      record: (e) => log.appendNow({ actor: "harness", type: e.type, payload: e.payload }),
      runnerHolder: () => undefined,
      // Swap crosses the limit after the fourth load.
      host: () => ({ swapUsedBytes: ++reads > 4 ? 8 * GiB : 0, freeRatio: 0.7 }),
      models: ["w"],
    });
    expect("end" in night).toBe(true);
    expect(await log.getEventsByTypes([LOAD_MODE_AB_EVENT])).toHaveLength(0);
    expect(events.filter((e) => e.startsWith("load w"))).toHaveLength(4);
    expect(events.at(-1)).toMatch(/^(unload|confirm) w$/);
    expect(access.residentRoles()).toEqual([]);
    if ("end" in night) await night.end();
  });
});
