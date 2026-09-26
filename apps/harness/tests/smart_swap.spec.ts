import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, type EventRecord, initSchema } from "@sekhemet/kernel";
import { type ModelRole, SWAP_EVENTS, type UnloadableAdapter } from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import { ModelAccess } from "../src/model_access.js";
import { noticeFor } from "../src/notify.js";

// NEW-models-14 (Smart Swap) through the product's one path to a model:
// `ModelAccess` records every load and unload on the repository's ledger and
// predicts from what that ledger recorded before. No model is loaded.

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "smart-swap-access-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

/** Fakes that load on request; each weights file lives at `path`. */
function fakes(paths: Record<string, string>) {
  const resolve = (name: string, _role: ModelRole): UnloadableAdapter => {
    let loaded = false;
    return {
      modelId: name,
      supportedArms: ["arm_a_flat"],
      contextWindow: { contextTokens: 8192, maxTokens: 64 },
      generate: async () => ({
        text: name,
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
      }),
      load: async () => {
        const was = loaded;
        loaded = true;
        return was ? "adopted" : "loaded";
      },
      unload: async () => {
        loaded = false;
      },
      confirmUnloaded: async () => true,
      footprintBytes: async () => 13 * GB,
      weightsSource: async () => ({ path: paths[name] as string, bytes: 12 * GB }),
    };
  };
  return resolve;
}

const types = async (log: EventLog) =>
  (await log.getEventsByTypes(Object.values(SWAP_EVENTS))).map((e) => e.type);

describe("Smart Swap through ModelAccess (NEW-models-14)", () => {
  it("MD-N14-1, -2: a swap between two queues is recorded on the ledger the caller passes", async () => {
    const log = ledger();
    const access = ModelAccess.forQueues(
      [
        { queue: "worker", role: "worker", name: "cyber" },
        { queue: "chat", role: "planner", name: "qwen" },
      ],
      {
        resolve: fakes({ cyber: "/Volumes/USB/cyber.gguf", qwen: "/Volumes/USB/qwen.gguf" }),
        usableBytes: 16 * GB,
        healthCheck: false,
        pressureLevel: () => 1,
        ledger: log,
        // The volume is judged by device; these paths are fakes, so it is given.
        volumeOf: (path) => (path.startsWith("/Volumes/USB/") ? "external" : "internal"),
      },
    );
    await access.measure();
    const w = await access.hold("worker");
    await w.adapter.generate({ prompt: "p", toolArm: "arm_a_flat" });
    w.release();
    (await access.hold("chat")).release();
    expect(await types(log)).toEqual([
      "model/loaded",
      "model/first_token",
      "model/unloaded",
      "model/loaded",
    ]);
    const [loaded] = await log.getEventsByTypes([SWAP_EVENTS.loaded]);
    expect(loaded?.payload).toMatchObject({
      model: "cyber",
      roles: ["worker"],
      volume: "external",
      bytes: 12 * GB,
      cache: "cold",
      basis: "estimate",
    });
  });

  it("MD-N14-4: a later ModelAccess on the same ledger predicts from the loads recorded there", async () => {
    const log = ledger();
    const make = () =>
      ModelAccess.forQueues([{ queue: "worker", role: "worker", name: "cyber" }], {
        resolve: fakes({ cyber: "/Users/o/cyber.gguf" }),
        usableBytes: 16 * GB,
        healthCheck: false,
        pressureLevel: () => 1,
        ledger: log,
      });
    // Three recorded loads, written as a scheduler writes them.
    for (const loadMs of [30_000, 32_000, 34_000]) {
      log.appendNow({
        actor: "harness",
        type: SWAP_EVENTS.loaded,
        payload: {
          model: "cyber",
          roles: ["worker"],
          volume: "internal",
          bytes: 12 * GB,
          cache: "cold",
          loadMs,
          medianMs: 1,
          p90Ms: 1,
          basis: "estimate",
        },
      });
    }
    const access = make();
    expect(await access.predictLoad("worker")).toMatchObject({
      basis: "measured",
      samples: 3,
      medianMs: 32_000,
      p90Ms: 34_000,
    });
  });

  it("a scheduler created without a ledger records on the one a later caller attaches", async () => {
    const log = ledger();
    const access = ModelAccess.forQueues([{ queue: "chat", role: "planner", name: "qwen" }], {
      resolve: fakes({ qwen: "/Users/o/qwen.gguf" }),
      usableBytes: 16 * GB,
      healthCheck: false,
      pressureLevel: () => 1,
    });
    access.recordSwapsOn(log);
    await access.measure();
    (await access.hold("chat")).release();
    expect(await types(log)).toEqual(["model/loaded"]);
  });

  it("MD-N14-5: a slow load becomes one low-priority notice naming its causes and fixes", () => {
    const e = {
      seq: 1,
      id: "evt_1",
      actor: "harness",
      type: SWAP_EVENTS.slowLoad,
      payload: {
        model: "cyber-tiel",
        roles: ["worker"],
        volume: "external",
        bytes: 13 * GB,
        cache: "cold",
        loadMs: 312_000,
        boundMs: 120_000,
        causes: ["external_volume", "cold_cache"],
        fixes: ["copy_to_internal", "prewarm_overnight"],
      },
      payloadHash: "",
      hash: "",
      prevHash: "",
      createdAt: new Date().toISOString(),
    } as EventRecord;
    const n = noticeFor(e);
    expect(n).toMatchObject({ event: "slow_load", key: "slow_load:cyber-tiel", priority: 2 });
    expect(n?.message).toContain("5.2 min");
    expect(n?.message).toContain("external drive");
    expect(n?.message).toContain("copy the weights to internal storage");
    expect(n?.message).toContain("pre-warm overnight");
  });
});
