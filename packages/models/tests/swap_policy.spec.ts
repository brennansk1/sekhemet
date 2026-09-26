import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWAP_POLICY,
  SWAP_POLICY_VERSION,
  SwapCostBook,
  cPair,
  capMs,
  capReport,
  decodeTokensPerSecond,
  serviceMs,
  swapPolicyParams,
  theta,
  workOf,
} from "../src/index.js";

// Smart Swap's cost model (models rule 20d, MD-N14-7, -8, -11, -12) and the
// aging caps (rule 20e C4, MD-N14-19, -20). Pure functions: no model, no clock.

const MIN = 60_000;
const GB = 1024 ** 3;

describe("MD-N14-7: C_pair, the round trip a visit costs", () => {
  it("sums both unloads and loads at p90, the first-token excess after each load, min(K, R) per live session and idle slot-seconds × N", () => {
    const worker = {
      load: { median: 200_000, p90: 300_000 },
      unload: { median: 3000, p90: 4000 },
      firstTokenExcessMs: 2500,
      // Two slots mid-card: one restores faster than it re-prefills, one does not.
      sessions: [
        { restoreMs: 800, reprefillMs: 12_000 },
        { restoreMs: 9000, reprefillMs: 7000 },
      ],
    };
    const seshat = {
      load: { median: 8000, p90: 9000 },
      unload: { median: 1000, p90: 1500 },
      firstTokenExcessMs: 700,
      sessions: [{ restoreMs: 400, reprefillMs: 5000 }],
    };
    const got = cPair(worker, seshat, { slots: 2, idleSlotMs: 40_000 });
    // unload W 4000 + load S 9000 + unload S 1500 + reload W 300000
    // + excess 700 + 2500 + sessions 800 + 7000 (re-prefill is faster) + 400
    // + idle 40000 × 2 slots
    expect(got).toBe(4000 + 9000 + 1500 + 300_000 + 700 + 2500 + 800 + 7000 + 400 + 80_000);
  });

  it("is unknown when either side's load is unknown, and uses medians when asked", () => {
    expect(cPair({ unload: { median: 1, p90: 2 } }, { load: { median: 5, p90: 9 } })).toBe(
      undefined,
    );
    const a = { load: { median: 100, p90: 150 }, unload: { median: 10, p90: 20 } };
    const b = { load: { median: 50, p90: 90 }, unload: { median: 5, p90: 7 } };
    expect(cPair(a, b, { basis: "median" })).toBe(10 + 50 + 5 + 100);
    // Nothing resident: the visit alone.
    expect(cPair(undefined, b)).toBe(90 + 7);
  });
});

describe("MD-N14-8: decisions use the p90, waits the median; three slow loads re-take the baseline", () => {
  it("ten loads at 60 s then three at 300 s: the next prediction's median is 300 s", () => {
    const book = new SwapCostBook();
    const sample = (loadMs: number) => ({
      model: "w",
      volume: "external" as const,
      cache: "cold" as const,
      bytes: 13 * GB,
      loadMs,
    });
    for (let i = 0; i < 10; i++) book.add(sample(60_000));
    for (let i = 0; i < 3; i++) book.add(sample(300_000));
    const p = book.predict({ model: "w", volume: "external", cache: "cold", bytes: 13 * GB });
    expect(p.medianMs).toBe(300_000);
    expect(p.p90Ms).toBe(300_000);
    expect(p.basis).toBe("measured");
  });

  it("two slow loads are not a new baseline", () => {
    const book = new SwapCostBook();
    const s = (loadMs: number) => ({
      model: "w",
      volume: "internal" as const,
      cache: "cold" as const,
      bytes: GB,
      loadMs,
    });
    for (let i = 0; i < 10; i++) book.add(s(60_000));
    book.add(s(300_000));
    book.add(s(300_000));
    book.add(s(60_000));
    const p = book.predict({ model: "w", volume: "internal", cache: "cold", bytes: GB });
    expect(p.medianMs).toBe(60_000);
  });

  it("keeps unloads and first tokens: medians and p90s, and the first-token excess over warm replies", () => {
    const book = new SwapCostBook();
    for (const ms of [1000, 2000, 3000, 4000]) book.addUnload("w", ms);
    expect(book.unloadCost("w")).toEqual({ median: 2000, p90: 4000 });
    expect(book.unloadCost("other")).toBeUndefined();
    for (const ms of [3000, 3500, 4000]) book.addFirstToken("w", ms, true);
    for (const ms of [500, 700, 900]) book.addFirstToken("w", ms, false);
    expect(book.firstTokenExcess("w")).toBe(3500 - 700);
  });
});

describe("MD-N14-11: queued work W, per engine, prefill included", () => {
  it("sums prefill at the measured prefill speed and decode at the measured decode speed", () => {
    const speed = { engine: "llama.cpp", prefillTokensPerSecond: 400, decodeTokensPerSecond: 20 };
    expect(serviceMs({ prefillTokens: 8000, decodeTokens: 200 }, speed)).toBe(20_000 + 10_000);
  });

  it("with no measured decode speed, estimates it as efficiency × bandwidth ÷ active bytes per token", () => {
    // 120 GB/s, 3 GB active (a mixture of experts): llama.cpp 0.6 → 24 tok/s; MLX 0.85 → 34 tok/s.
    const base = { bandwidthBytesPerSecond: 120e9, activeBytesPerToken: 3e9 };
    expect(decodeTokensPerSecond({ engine: "llama.cpp", ...base })).toBeCloseTo(24, 6);
    expect(decodeTokensPerSecond({ engine: "mlx", ...base })).toBeCloseTo(34, 6);
    expect(decodeTokensPerSecond({ engine: "llama.cpp" })).toBeUndefined();
    expect(
      serviceMs(
        { prefillTokens: 0, decodeTokens: 240 },
        { engine: "llama.cpp", ...base, prefillTokensPerSecond: 500 },
      ),
    ).toBe(10_000);
  });

  it("an escalated retry counts in the Planner's W: work is summed by weights", () => {
    const queues = [
      { queue: "planner", weights: "qwen", requests: [{ serviceMs: 30_000 }] },
      { queue: "escalation", weights: "qwen", requests: [{ serviceMs: 90_000 }] },
      { queue: "worker", weights: "cyber", requests: [{ serviceMs: 5000 }] },
    ];
    expect(workOf(queues, "qwen")).toBe(120_000);
    expect(workOf(queues, "cyber")).toBe(5000);
  });
});

describe("MD-N14-12: θ, swap time over wall time in the rolling hour", () => {
  it("12 minutes of swaps in an hour read θ = 0.2", () => {
    const now = 10 * 60 * MIN;
    const swaps = [
      { at: now - 50 * MIN, ms: 5 * MIN },
      { at: now - 30 * MIN, ms: 4 * MIN },
      { at: now - 10 * MIN, ms: 3 * MIN },
      // Outside the hour: not counted.
      { at: now - 90 * MIN, ms: 10 * MIN },
    ];
    expect(theta(swaps, now)).toBeCloseTo(0.2, 9);
  });

  it("counts only the part of a swap inside the hour", () => {
    const now = 120 * MIN;
    expect(theta([{ at: now - 62 * MIN, ms: 4 * MIN }], now)).toBeCloseTo(2 / 60, 9);
  });
});

describe("MD-N14-19, -20: one aging mechanism, its caps, feasibility and stretch", () => {
  it("interactive 2 min, Planner 30, Reviewer 45, Researcher 60 minutes, Worker steps max_wait_s", () => {
    const p = swapPolicyParams({ maxWaitS: 900 });
    expect(capMs("interactive", p, 0)).toBe(2 * MIN);
    expect(capMs("planner", p, 0)).toBe(30 * MIN);
    expect(capMs("reviewer", p, 0)).toBe(45 * MIN);
    expect(capMs("researcher", p, 0)).toBe(60 * MIN);
    expect(capMs("worker", p, 0)).toBe(900_000);
    expect(capMs("worker", DEFAULT_SWAP_POLICY, 0)).toBe(600_000);
  });

  it("past θ_max the non-interactive caps stretch by θ ÷ θ_max; the interactive one never does", () => {
    const p = DEFAULT_SWAP_POLICY;
    expect(capMs("planner", p, 0.3)).toBe(45 * MIN);
    expect(capMs("reviewer", p, 0.4)).toBe(90 * MIN);
    expect(capMs("interactive", p, 0.4)).toBe(2 * MIN);
    expect(capMs("planner", p, 0.2)).toBe(30 * MIN);
  });

  it("flags a cap below C_pair as infeasible with the predicted wait, and raises the placement notice past θ_max", () => {
    const report = capReport(DEFAULT_SWAP_POLICY, 0.25, {
      interactive: 10 * MIN,
      planner: 10 * MIN,
    });
    const interactive = report.caps.find((c) => c.cls === "interactive");
    expect(interactive).toMatchObject({
      feasible: false,
      capMs: 2 * MIN,
      predictedWaitMs: 10 * MIN,
    });
    expect(report.caps.find((c) => c.cls === "planner")).toMatchObject({
      feasible: true,
      capMs: 37.5 * MIN,
    });
    expect(report.placementNotice).toBe(true);
    expect(capReport(DEFAULT_SWAP_POLICY, 0.1, {}).placementNotice).toBe(false);
  });
});

describe("SwapPolicyParams: one recorded object (MD-N14-40)", () => {
  it("carries the version and every D value", () => {
    expect(DEFAULT_SWAP_POLICY).toMatchObject({
      version: SWAP_POLICY_VERSION,
      thetaMax: 0.2,
      windowMs: 60 * MIN,
      tourFraction: 0.5,
      horizon: 4,
      presenceWindowMs: 10 * MIN,
      hysteresisBoundaries: 2,
      engineEfficiency: { "llama.cpp": 0.6, mlx: 0.85 },
    });
    expect(SWAP_POLICY_VERSION).toBe("smart-swap/1");
    expect(DEFAULT_SWAP_POLICY.prefetchMarginBytes).toBe(2 * GB);
  });
});
