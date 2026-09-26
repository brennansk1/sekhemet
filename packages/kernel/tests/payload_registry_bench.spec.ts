import { describe, expect, it } from "vitest";
import { checkEventPayload } from "../src/payload_registry.js";

// B4.1 part (c): a benchmark run's start, stop and kept items are registered
// structural events (measurement MS-N5-6, MS-N5-10, MS-N5-12; models
// MD-N3-4/5), so a stopped overnight run resumes from the ledger; and a
// `measure/benchmarked` event names its host (MD-N10-1).

const SHA = "c".repeat(64);

describe("the benchmark run's events (kernel rule 33)", () => {
  it("accepts a queued overnight run with its combinations and the build it will run under", () => {
    expect(() =>
      checkEventPayload(
        "measure/benchmark_started",
        {
          runId: "bench_1",
          tier: "overnight",
          state: "queued",
          combinations: [{ id: "cmb_1", models: { worker: "wa", planner: "p" } }],
          host: "h1",
          benchmarkFirst: false,
          estimateSeconds: 18_000,
        },
        undefined,
      ),
    ).not.toThrow();
    expect(() =>
      checkEventPayload(
        "measure/benchmark_started",
        {
          runId: "bench_1",
          tier: "overnight",
          state: "running",
          combinations: [],
          host: "h1",
          build: "b2",
          contextVersion: "c1",
          qualification: "q1",
          restartRun: 1,
          reason: "build_changed",
        },
        undefined,
      ),
    ).not.toThrow();
  });

  it("keeps a stop's error message out of the payload", () => {
    const stop = {
      runId: "bench_1",
      tier: "quick",
      reason: "failed",
      partial: true,
      completed: 3,
      total: 10,
    };
    expect(() => checkEventPayload("measure/benchmark_stopped", stop, undefined)).not.toThrow();
    expect(() =>
      checkEventPayload("measure/benchmark_stopped", { ...stop, error: "boom" }, undefined),
    ).toThrow(/private part/);
    expect(() =>
      checkEventPayload("measure/benchmark_stopped", { ...stop, reason: "bored" }, undefined),
    ).toThrow(/reason/);
  });

  it("records an overnight item by ids, score and seconds only", () => {
    const item = {
      runId: "bench_1",
      run: 1,
      block: 0,
      combinationId: "cmb_1",
      role: "worker",
      item: "s1",
      score: 1,
      seconds: 600,
      seed: 1,
    };
    expect(() => checkEventPayload("measure/benchmark_item", item, undefined)).not.toThrow();
    expect(() =>
      checkEventPayload("measure/benchmark_item", { ...item, output: "text" }, undefined),
    ).toThrow();
  });

  it("names the host on a measure/benchmarked event", () => {
    expect(() =>
      checkEventPayload(
        "measure/benchmarked",
        {
          tier: "overnight",
          profileHash: SHA,
          host: "h1",
          partial: false,
          roles: [],
          comparisons: [],
        },
        undefined,
      ),
    ).not.toThrow();
  });
});
