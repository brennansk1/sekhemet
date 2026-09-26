import {
  DEFAULT_SWAP_POLICY,
  SWAP_POLICY_VERSION,
  type SimDay,
  swapPolicyParams,
} from "@sekhemet/models";
import { describe, expect, it } from "vitest";
import {
  type PairedDayResult,
  type SchedulingChange,
  admitSchedulingChange,
  replayPairedDays,
  resolveRunProfile,
  runProfileHash,
} from "../src/index.js";

// Measurement rule 16a's scheduling row (MS-NM14-1, -2): a Smart Swap
// parameter or policy change is admitted only by a paired closed-loop replay
// over at least five distinct recorded days, on a metric registered before
// the replay, by a one-sided exact sign test, with proof the cards' outputs
// are unchanged. And every RunProfile records the policy (MD-N14-40).

const REGISTERED = 1_000;
const STARTED = 2_000;
const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];

function change(
  results: PairedDayResult[],
  over: Partial<SchedulingChange> = {},
): SchedulingChange {
  return {
    registration: {
      metric: "waitP90:interactive",
      direction: "lower",
      days: [...new Set(results.map((r) => r.day))],
      registeredAt: REGISTERED,
    },
    replayStartedAt: STARTED,
    results,
    outputs: {
      firstRequestIdentical: true,
      changes: { sampling: false, context: false, prompt: false, combination: false },
    },
    ...over,
  };
}

const better = (day: string, seed = 1): PairedDayResult => ({
  day,
  seed,
  baseline: 300_000,
  candidate: 200_000,
});

describe("MS-NM14-1: the scheduling row's admission", () => {
  it("admits five distinct days, every one improved, with the metric registered first and outputs unchanged", () => {
    const v = admitSchedulingChange(change(days.map((d) => better(d))));
    expect(v).toMatchObject({ admitted: true, improvedDays: 5, distinctDays: 5, refusals: [] });
    expect(v.pValue).toBeCloseTo(1 / 32, 9);
  });

  it("refuses one day replayed with five seeds, naming the distinct days", () => {
    const v = admitSchedulingChange(change([1, 2, 3, 4, 5].map((s) => better("2026-09-01", s))));
    expect(v.admitted).toBe(false);
    expect(v.refusals.join(" ")).toMatch(/1 distinct recorded day/);
  });

  it("refuses four improved days and one tie: a tie counts as not improved", () => {
    const results = [
      ...days.slice(0, 4).map((d) => better(d)),
      { day: days[4] as string, seed: 1, baseline: 250_000, candidate: 250_000 },
    ];
    const v = admitSchedulingChange(change(results));
    expect(v.admitted).toBe(false);
    expect(v.improvedDays).toBe(4);
    expect(v.pValue).toBeCloseTo(6 / 32, 9);
    expect(v.refusals.join(" ")).toMatch(/sign test/);
  });

  it("refuses a metric registered after the replay started, or not at all, and replayed days that were not registered", () => {
    const results = days.map((d) => better(d));
    const late = change(results);
    late.registration = {
      ...(late.registration as NonNullable<SchedulingChange["registration"]>),
      registeredAt: STARTED + 1,
    };
    expect(admitSchedulingChange(late).refusals.join(" ")).toMatch(/before the replay/);
    const { registration: _r, ...none } = change(results);
    expect(admitSchedulingChange(none).refusals.join(" ")).toMatch(/registered/);
    const other = change(results);
    other.registration = {
      ...(other.registration as NonNullable<SchedulingChange["registration"]>),
      days: ["2026-08-01", ...days.slice(1)],
    };
    expect(admitSchedulingChange(other).refusals.join(" ")).toMatch(/not the registered days/);
  });

  it("refuses without proof the outputs are unchanged, naming what is missing", () => {
    const results = days.map((d) => better(d));
    const { outputs: _o, ...noProof } = change(results);
    expect(admitSchedulingChange(noProof).refusals.join(" ")).toMatch(/outputs are unchanged/);
    const differs = change(results, {
      outputs: {
        firstRequestIdentical: false,
        changes: { sampling: false, context: true, prompt: false, combination: false },
      },
    });
    const why = admitSchedulingChange(differs).refusals.join(" ");
    expect(why).toMatch(/first request/);
    expect(why).toMatch(/context/);
    const slot = change(results, { restoresLiveSlot: true });
    expect(admitSchedulingChange(slot).refusals.join(" ")).toMatch(/equivalence check/);
    expect(
      admitSchedulingChange(
        change(results, { restoresLiveSlot: true, equivalenceCheckPassed: true }),
      ).admitted,
    ).toBe(true);
  });
});

describe("MS-NM14-2: a change to what a request sends is not a scheduling change", () => {
  it("is refused on the scheduling row, naming rule 16c", () => {
    const v = admitSchedulingChange(
      change(
        days.map((d) => better(d)),
        { altersRequestContent: true },
      ),
    );
    expect(v.admitted).toBe(false);
    expect(v.refusals).toHaveLength(1);
    expect(v.refusals[0]).toMatch(/rule 16c/);
  });
});

describe("the paired replay feeds the admission (rule 20j)", () => {
  it("replays each day under both parameter sets with the same seed; identical parameters tie every day and are refused", () => {
    const T0 = Date.UTC(2026, 8, 1, 22);
    const recorded: SimDay[] = days.map((d, i) => ({
      day: d,
      start: T0 + i * 86_400_000,
      end: T0 + i * 86_400_000 + 4 * 3_600_000,
      cards: [
        {
          id: `c${i}`,
          arrivesAt: T0 + i * 86_400_000,
          attempts: [{ steps: [60_000, 60_000], passed: true }],
          reviewMs: 30_000,
        },
      ],
      seshat: [
        { startAt: T0 + i * 86_400_000 + 60_000, turns: [{ thinkMs: 0, serviceMs: 20_000 }] },
      ],
      presence: [],
      reserved: [],
    }));
    const config = {
      queues: { worker: "cyber", chat: "qwen", planner: "qwen", reviewer: "gemma" },
      home: "cyber",
      weights: {
        cyber: { loadMs: [240_000, 300_000], unloadMs: [4000] },
        qwen: { loadMs: [9000, 12_000], unloadMs: [2000] },
        gemma: { loadMs: [9000], unloadMs: [2000] },
      },
      memory: { models: 1 },
    };
    const same = replayPairedDays({
      days: recorded,
      seed: 11,
      config,
      baseline: DEFAULT_SWAP_POLICY,
      candidate: swapPolicyParams(),
      metric: "waitP90:interactive",
    });
    expect(same).toHaveLength(5);
    expect(same.every((r) => r.baseline === r.candidate)).toBe(true);
    expect(admitSchedulingChange(change(same)).admitted).toBe(false);
  });
});

describe("MD-N14-40: every RunProfile records the swap policy's version and parameters", () => {
  it("carries SwapPolicyParams, which schedule when requests are served and not what they send", () => {
    const p = resolveRunProfile({ env: {}, argv: [] });
    expect(p.swapPolicy).toEqual(DEFAULT_SWAP_POLICY);
    expect(p.swapPolicy?.version).toBe(SWAP_POLICY_VERSION);
    // Not part of the profile's identity: a scheduling change is admitted by
    // its own row, and the same card sends the same request with or without it.
    const { swapPolicy: _s, ...without } = p;
    expect(runProfileHash(p)).toBe(runProfileHash(without));
  });
});
