import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_EVENT,
  type CalibrationProtocol,
  DEFAULT_SWAP_POLICY,
  ResidencyScheduler,
  SWAP_OVERHEAD_EVENT,
  type UnloadableAdapter,
  dec42HostCheck,
  flattenSwapPolicy,
  runCalibrationNight,
  withMeasurementRun,
} from "../src/index.js";

// Measurement MS-NM14-3 (rule 16d): calibration nights run the policy as
// designed, declare their protocol first, check DEC-42's host limits before
// every load, never run during a suite or measurement run, and unload
// everything at their end; a measurement run unloads its models. Real
// SQLite ledgers, fake adapters; no model is loaded.

const GB = 1024 ** 3;

function ledger(): EventLog {
  const db = new DatabaseSync(join(mkdtempSync(join(tmpdir(), "calibration-")), "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

function scheduler(events: string[]) {
  const build =
    (key: string) =>
    (contextTokens: number): UnloadableAdapter => {
      let loaded = false;
      return {
        modelId: key,
        supportedArms: ["arm_a_flat"],
        contextWindow: { contextTokens, maxTokens: 64 },
        generate: async () => ({
          text: key,
          toolCalls: [],
          usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
        }),
        load: async () => {
          if (loaded) return "adopted";
          loaded = true;
          events.push(`load ${key}`);
          return "loaded";
        },
        unload: async () => {
          loaded = false;
          events.push(`unload ${key}`);
        },
        confirmUnloaded: async () => true,
      };
    };
  return new ResidencyScheduler({
    roles: [
      { role: "worker", weights: "cyber", contextTokens: 8192 },
      { role: "chat", weights: "qwen", contextTokens: 8192 },
    ],
    weights: {
      cyber: { build: build("cyber"), footprintBytes: 13 * GB },
      qwen: { build: build("qwen"), footprintBytes: 12 * GB },
    },
    usableBytes: 16 * GB,
    pressureLevel: () => 1,
    healthCheck: false,
  });
}

const protocol: CalibrationProtocol = {
  policy: DEFAULT_SWAP_POLICY,
  models: ["cyber", "qwen"],
  volumes: ["external", "internal"],
  loadModes: ["mmap", "no_mmap", "preread_mmap"],
  abOrder: ["mmap", "no_mmap", "preread_mmap"],
  loadsPerMode: 3,
  probes: ["read_probe", "drive_check", "headroom"],
  equivalenceCheck: false,
};

describe("MS-NM14-3: a calibration night", () => {
  it("records its protocol in one measure/calibration event before the first load, runs decide() as designed, and unloads everything at its end", async () => {
    const log = ledger();
    const order: string[] = [];
    const s = scheduler(order);
    const result = await runCalibrationNight({
      protocol,
      record: (e) => {
        order.push(`record ${e.type}`);
        log.appendNow({ actor: "harness", type: e.type, payload: e.payload });
      },
      runnerHolder: () => undefined,
      host: () => ({ swapUsedBytes: 0, freeRatio: 0.7 }),
      scheduler: s,
      night: async () => {
        await s.submit("worker", async () => order.push("step"));
        await s.submit("chat", async () => order.push("answer"));
      },
    });
    expect(result).toMatchObject({ ran: true, hostRefusals: [] });
    expect(order[0]).toBe(`record ${CALIBRATION_EVENT}`);
    expect(order).toEqual([
      `record ${CALIBRATION_EVENT}`,
      "load cyber",
      "step",
      "unload cyber",
      "load qwen",
      "answer",
      "unload qwen",
    ]);
    expect(s.residentWeights()).toEqual([]);
    const [event] = await log.getEventsByTypes([CALIBRATION_EVENT]);
    expect(event?.payload).toMatchObject({
      policyVersion: "smart-swap/1",
      params: flattenSwapPolicy(DEFAULT_SWAP_POLICY),
      abOrder: ["mmap", "no_mmap", "preread_mmap"],
      equivalenceCheck: false,
    });
  });

  it("never starts while a suite or measurement run holds the runner", async () => {
    for (const holder of ["suite", "measurement"] as const) {
      const order: string[] = [];
      const s = scheduler(order);
      const result = await runCalibrationNight({
        protocol,
        record: (e) => {
          order.push(`record ${e.type}`);
        },
        runnerHolder: () => holder,
        host: () => ({ swapUsedBytes: 0, freeRatio: 0.9 }),
        scheduler: s,
        night: async () => {
          order.push("night ran");
        },
      });
      expect(result.ran).toBe(false);
      expect(result.refused).toMatch(new RegExp(holder));
      expect(order).toEqual([]);
    }
  });

  it("checks DEC-42's host limits before each load: a load past them is refused and its work stays queued", async () => {
    const order: string[] = [];
    const s = scheduler(order);
    let swap = 0;
    let queued = 0;
    const result = await runCalibrationNight({
      protocol,
      record: () => undefined,
      runnerHolder: () => undefined,
      host: () => ({ swapUsedBytes: swap, freeRatio: 0.7 }),
      scheduler: s,
      night: async () => {
        await s.submit("worker", async () => order.push("step"));
        swap = 5 * GB;
        void s.submit("chat", async () => order.push("answer"));
        await new Promise((r) => setTimeout(r, 30));
        queued = s.waiting("chat");
      },
    });
    expect(queued).toBe(1);
    expect(order).not.toContain("answer");
    // Each attempt is checked (a boundary may try again); none spins.
    expect(result.hostRefusals.length).toBeGreaterThanOrEqual(1);
    expect(result.hostRefusals.length).toBeLessThanOrEqual(3);
    for (const r of result.hostRefusals) expect(r).toMatch(/not loading qwen: swap is 5\.0 GB/);
    expect(s.residentWeights()).toEqual([]);
  });

  it("refuses a protocol whose load-mode A/B has fewer than three loads per mode", async () => {
    const result = await runCalibrationNight({
      protocol: { ...protocol, loadsPerMode: 2 },
      record: () => undefined,
      runnerHolder: () => undefined,
      host: () => ({ swapUsedBytes: 0, freeRatio: 0.9 }),
      scheduler: scheduler([]),
      night: async () => undefined,
    });
    expect(result).toMatchObject({ ran: false });
    expect(result.refused).toMatch(/three loads per mode/);
  });

  it("DEC-42's host check: swap under 4 GB and at least 60% free", () => {
    expect(dec42HostCheck({ swapUsedBytes: 3 * GB, freeRatio: 0.6 })).toEqual({ ok: true });
    expect(dec42HostCheck({ swapUsedBytes: 4 * GB, freeRatio: 0.9 })).toMatchObject({ ok: false });
    expect(dec42HostCheck({ swapUsedBytes: 0, freeRatio: 0.59 })).toMatchObject({ ok: false });
  });
});

describe("MS-NM14-3: a measurement run unloads its models when it ends", () => {
  it("unloads even when the run throws", async () => {
    const order: string[] = [];
    const s = scheduler(order);
    await expect(
      withMeasurementRun(s, async () => {
        await s.submit("worker", async () => order.push("card"));
        throw new Error("the suite stopped");
      }),
    ).rejects.toThrow(/suite stopped/);
    expect(order).toEqual(["load cyber", "card", "unload cyber"]);
  });
});

describe("MD-N14-40a: the θ record is structural only", () => {
  it("accepts its payload and refuses a free-text field", () => {
    const log = ledger();
    const payload = {
      theta: 0.1,
      windowMs: 3_600_000,
      swapMs: 360_000,
      swaps: 2,
      placementNotice: false,
      policyVersion: "smart-swap/1",
      params: flattenSwapPolicy(DEFAULT_SWAP_POLICY),
    };
    expect(() =>
      log.appendNow({ actor: "harness", type: SWAP_OVERHEAD_EVENT, payload }),
    ).not.toThrow();
    expect(() =>
      log.appendNow({
        actor: "harness",
        type: SWAP_OVERHEAD_EVENT,
        payload: { ...payload, note: "free text here" },
      }),
    ).toThrow(/note/);
  });
});
