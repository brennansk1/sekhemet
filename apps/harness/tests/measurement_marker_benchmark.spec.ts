import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measurementHolder,
  readMeasurementMarker,
  resolveRunProfile,
  writeMeasurementMarker,
} from "@sekhemet/eval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCardRepo } from "../src/benchmark_runner.js";
import { rescoreSuiteResult } from "../src/rescore.js";

// B4.1 wiring, the measurement marker (measurement NEW-measurement-5): a
// benchmark's card repositories carry their own purpose, `benchmark`, never
// `frozen suite`, so what reads a suite run — its evidence, SUITE_RUNS'
// rescore, the calibration night's runner check — never counts a benchmark
// card as a frozen-suite card, while independent mode and the board's
// measurement setup still accept it as a measured repository.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("SEKHEMET_USER_CONFIG", "/nonexistent/sekhemet-test-user-config.toml");
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sek-marker-"));
  dirs.push(d);
  return d;
};

describe("the benchmark's measurement marker", () => {
  it("is written and read back as `benchmark`, a measurement but not the frozen suite", () => {
    const dir = tmp();
    writeMeasurementMarker(dir, "benchmark", "benchmark_runner.ts");
    const marker = readMeasurementMarker(dir);
    expect(marker?.purpose).toBe("benchmark");
    expect(measurementHolder(marker)).toBe("measurement");
    const suite = tmp();
    writeMeasurementMarker(suite, "frozen suite", "scripts/run_suite.mjs");
    expect(measurementHolder(readMeasurementMarker(suite))).toBe("suite");
    expect(measurementHolder(undefined)).toBeUndefined();
  });

  it("marks a benchmark card's repository `benchmark`, and independent mode still prepares it", async () => {
    const dir = join(tmp(), "chronicle__card_chron_hasher");
    await prepareCardRepo(ROOT, "chronicle", "card_chron_hasher", dir);
    expect(readMeasurementMarker(dir)?.purpose).toBe("benchmark");
  }, 120_000);

  it("SUITE_RUNS' rescore reads the suite's fixture repositories and never a benchmark's", () => {
    const work = tmp();
    const profile = resolveRunProfile({ env: {}, argv: ["--worker", "cyber-tiel"] });
    const repo = (name: string, purpose: "frozen suite" | "benchmark", card: string) => {
      const dir = join(work, name);
      mkdirSync(join(dir, ".sekhemet", "evidence"), { recursive: true });
      writeMeasurementMarker(dir, purpose, "test");
      writeFileSync(
        join(dir, ".sekhemet", "evidence", `latest-${card}.json`),
        JSON.stringify({ reproducibility: { runProfile: profile, measurement: { purpose } } }),
      );
    };
    repo("chronicle__card_a", "frozen suite", "card_a");
    repo("chronicle__card_b", "benchmark", "card_b");
    const result = join(work, "result.json");
    writeFileSync(
      result,
      JSON.stringify({
        runProfile: profile,
        outcomes: [{ task: { suite: "chronicle", cardId: "card_a" } }],
      }),
    );
    const r = rescoreSuiteResult(result, work);
    const cards = Object.keys(
      (JSON.parse(readFileSync(r.out, "utf8")) as { cardProfiles: Record<string, unknown> })
        .cardProfiles,
    );
    expect(cards).toEqual(["chronicle/card_a"]);
  });
});
