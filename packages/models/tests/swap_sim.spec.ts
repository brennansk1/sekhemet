import { describe, expect, it } from "vitest";
import { DEFAULT_SWAP_POLICY, type SimConfig, type SimDay, simulateDay } from "../src/index.js";

// The closed-loop replay simulator (models rule 20j, MD-N14-38, -39, and
// MD-N14-21 over two virtual hours): the real `decide()` under a virtual
// clock, with load and unload times sampled from recorded distributions by a
// seed, and a fake memory that holds one large model at a time.

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 20, 22, 0, 0);

function config(over: Partial<SimConfig> = {}): SimConfig {
  return {
    params: DEFAULT_SWAP_POLICY,
    seed: 7,
    queues: { worker: "cyber", chat: "qwen", planner: "qwen", reviewer: "gemma" },
    home: "cyber",
    weights: {
      cyber: { loadMs: [240 * S, 250 * S, 300 * S], unloadMs: [4 * S, 5 * S] },
      qwen: { loadMs: [9 * S, 10 * S, 14 * S], unloadMs: [2 * S] },
      gemma: { loadMs: [8 * S, 12 * S], unloadMs: [2 * S] },
    },
    memory: { models: 1 },
    ...over,
  };
}

/** A day of three cards, one failing once and escalated, and a short Seshat conversation. */
function day(over: Partial<SimDay> = {}): SimDay {
  return {
    day: "2026-09-20",
    start: T0,
    end: T0 + 8 * HOUR,
    cards: [
      {
        id: "c1",
        arrivesAt: T0,
        attempts: [{ steps: [60 * S, 90 * S, 45 * S], passed: true }],
        reviewMs: 40 * S,
      },
      {
        id: "c2",
        arrivesAt: T0 + 5 * MIN,
        attempts: [
          { steps: [60 * S, 60 * S], passed: false, escalationMs: 50 * S },
          { steps: [70 * S], passed: true },
        ],
        reviewMs: 30 * S,
      },
      {
        id: "c3",
        arrivesAt: T0 + 20 * MIN,
        attempts: [{ steps: [120 * S], passed: true }],
        reviewMs: 30 * S,
      },
    ],
    seshat: [
      {
        startAt: T0 + 10 * MIN,
        turns: [
          { thinkMs: 0, serviceMs: 20 * S },
          { thinkMs: 2 * MIN, serviceMs: 25 * S },
        ],
      },
    ],
    presence: [{ from: T0, to: T0 + HOUR }],
    reserved: [{ from: T0 + 10 * HOUR, to: T0 + 20 * HOUR }],
    ...over,
  };
}

describe("MD-N14-38: a seeded replay is reproducible", () => {
  it("two runs with the same seed report identical θ, waits, accepted cards per hour, maximum age and swaps per hour", () => {
    const a = simulateDay(day(), config());
    const b = simulateDay(day(), config());
    expect(a.metrics).toEqual(b.metrics);
    expect(a.metrics.accepted).toBe(3);
    expect(a.metrics.swaps).toBeGreaterThan(0);
    expect(a.metrics.theta).toBeGreaterThan(0);
    for (const cls of ["worker", "reviewer", "planner", "interactive"] as const) {
      expect(a.metrics.waits[cls]).toMatchObject({
        p50: expect.any(Number),
        p90: expect.any(Number),
        max: expect.any(Number),
      });
    }
    expect(a.metrics.acceptedPerHour).toBeCloseTo(3 / 8, 9);
    expect(a.metrics.swapsPerHour).toBeCloseTo(a.metrics.swaps / 8, 9);
    expect(a.metrics.maxAgeMs).toBeGreaterThan(0);
  });

  it("the load times are sampled by the seed from the recorded distributions", () => {
    const loads = (seed: number) =>
      simulateDay(day(), config({ seed }))
        .trace.filter((e) => e.kind === "swap")
        .map((e) => e.ms);
    expect(loads(7)).toEqual(loads(7));
    const seeds = [1, 2, 3, 4, 5, 6].map((s) => loads(s).join(","));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
});

describe("MD-N14-39: the replay is closed-loop", () => {
  it("a card the policy delays by an hour has its review demand delayed by the same hour", () => {
    const fixed = config({
      weights: {
        cyber: { loadMs: [240 * S], unloadMs: [0] },
        qwen: { loadMs: [10 * S], unloadMs: [0] },
        gemma: { loadMs: [10 * S], unloadMs: [0] },
      },
    });
    const one = (over: Partial<SimDay>) =>
      day({
        cards: [
          {
            id: "c1",
            arrivesAt: T0,
            attempts: [{ steps: [60 * S], passed: true }],
            reviewMs: 30 * S,
          },
        ],
        seshat: [],
        ...over,
      });
    const reviewQueued = (d: SimDay) =>
      simulateDay(d, fixed).trace.find((e) => e.kind === "queued" && e.queue === "reviewer")?.at;
    const free = reviewQueued(one({}));
    // An overnight benchmark block holds the machine for the first hour.
    const held = reviewQueued(one({ blocks: [{ weights: "gemma", from: T0, to: T0 + HOUR }] }));
    expect(free).toBeDefined();
    expect((held as number) - (free as number)).toBe(HOUR);
  });

  it("escalations follow failures as recorded, and Seshat's turns arrive as think-times after each answer", () => {
    const run = simulateDay(day(), config());
    const esc = run.trace.find((e) => e.kind === "queued" && e.queue === "planner");
    expect(esc).toBeDefined();
    const c2Attempt2 = run.trace.find(
      (e) => e.kind === "queued" && e.queue === "worker" && e.card === "c2" && e.attempt === 2,
    );
    const escDone = run.trace.find((e) => e.kind === "served" && e.queue === "planner");
    expect(c2Attempt2?.at).toBe((escDone?.at as number) + (escDone?.ms as number));
    const chats = run.trace.filter((e) => e.kind === "queued" && e.queue === "chat");
    const answers = run.trace.filter(
      (e) => (e.kind === "served" || e.kind === "quick") && e.queue === "chat",
    );
    expect(chats).toHaveLength(2);
    const firstAnswerEnd =
      answers[0]?.kind === "quick"
        ? (answers[0].at as number)
        : (answers[0]?.at as number) + (answers[0]?.ms as number);
    expect(chats[1]?.at).toBe(firstAnswerEnd + 2 * MIN);
  });
});

describe("MD-N14-21: the Worker's floor holds against a chatty conversation", () => {
  it("C_pair 300 s, a Seshat question every 3 minutes for two hours: the Worker resident ≥ 48 minutes of each hour, every question answered by rule 20f", () => {
    // 25 + 125 + 25 + 125 = 300 s.
    const cfg = config({
      weights: {
        cyber: { loadMs: [125 * S], unloadMs: [25 * S] },
        qwen: { loadMs: [125 * S], unloadMs: [25 * S] },
        gemma: { loadMs: [125 * S], unloadMs: [25 * S] },
      },
    });
    const long = Array.from({ length: 200 }, () => 60 * S);
    const run = simulateDay(
      day({
        end: T0 + 2 * HOUR + 10 * MIN,
        cards: [
          { id: "big", arrivesAt: T0, attempts: [{ steps: long, passed: true }], reviewMs: 30 * S },
        ],
        seshat: [
          {
            startAt: T0 + 5 * MIN,
            turns: Array.from({ length: 40 }, () => ({ thinkMs: 3 * MIN, serviceMs: 20 * S })),
          },
        ],
        presence: [{ from: T0, to: T0 + 2 * HOUR }],
      }),
      cfg,
    );
    // The first hour starts once the Worker is first resident.
    const hours = run.metrics.homeResidencyByHour;
    expect(hours.length).toBeGreaterThanOrEqual(2);
    for (const fraction of hours.slice(0, 2)) expect(fraction).toBeGreaterThanOrEqual(48 / 60);
    const asked = run.trace.filter((e) => e.kind === "queued" && e.queue === "chat");
    const handled = new Set(
      run.trace
        .filter((e) => (e.kind === "served" || e.kind === "quick") && e.queue === "chat")
        .map((e) => e.request),
    );
    expect(asked.length).toBeGreaterThan(5);
    const unanswered = asked.filter((e) => !handled.has(e.request));
    // Only a question asked in the last moments may still be waiting at the end.
    expect(unanswered.length).toBeLessThanOrEqual(1);
    expect(run.trace.some((e) => e.kind === "quick")).toBe(true);
  });
});
