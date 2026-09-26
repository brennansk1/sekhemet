import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { GPU_CEILING_EVENT, LOAD_MODE_AB_EVENT } from "../src/index.js";

function ledger(): EventLog {
  const dir = mkdtempSync(join(tmpdir(), "swap-events-"));
  const db = new DatabaseSync(join(dir, "ledger.db"));
  initSchema(db);
  return new EventLog(db);
}

const valid: Record<string, Record<string, unknown>> = {
  "model/loaded": {
    model: "w",
    roles: ["worker"],
    volume: "external",
    bytes: 1,
    cache: "cold",
    loadMs: 1,
    medianMs: 1,
    p90Ms: 1,
    basis: "estimate",
    engine: "llama.cpp",
    loadMode: "preread_mmap",
  },
  [LOAD_MODE_AB_EVENT]: {
    model: "w",
    volume: "external",
    engine: "llama.cpp",
    modes: [{ mode: "mmap", loads: 3, medianLoadMs: 3, medianFirstTokenMs: 1, medianTotalMs: 4 }],
    decided: false,
    chosen: "mmap",
  },
  [GPU_CEILING_EVENT]: { basis: "metal_timeout", bytes: 15_650_000_000, models: ["t", "d"] },
  "model/requantised": {
    model: "w",
    servedQuant: "Q4_K_M",
    fileQuant: "IQ3_XXS",
    hashDiffers: false,
  },
  "measure/calibration": {
    policyVersion: "smart-swap/1",
    params: { thetaMax: 0.2, admissionRatio: 0.8 },
    models: ["worker", "seshat"],
    volumes: ["internal", "external"],
    loadModes: ["mmap", "no_mmap", "preread_mmap"],
    abOrder: ["mmap", "no_mmap", "preread_mmap"],
    probes: ["read_probe", "drive_check", "headroom"],
    equivalenceCheck: false,
  },
};

describe("MD-N14-40a: Smart Swap's events are registered structural only", () => {
  for (const [type, payload] of Object.entries(valid)) {
    it(`${type} accepts its structural payload and refuses a free-text field`, () => {
      const log = ledger();
      expect(() => log.appendNow({ actor: "harness", type, payload })).not.toThrow();
      expect(() =>
        log.appendNow({ actor: "harness", type, payload: { ...payload, note: "free text here" } }),
      ).toThrow(/note/);
    });
  }

  it("model/loaded refuses a load mode it does not know", () => {
    const log = ledger();
    expect(() =>
      log.appendNow({
        actor: "harness",
        type: "model/loaded",
        payload: { ...valid["model/loaded"], loadMode: "mlock" },
      }),
    ).toThrow(/loadMode/);
  });
});
