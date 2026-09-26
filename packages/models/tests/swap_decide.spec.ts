import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWAP_POLICY,
  type RequestClass,
  type SwapMemory,
  type SwapQueueState,
  type SwapRequest,
  type SwapSnapshot,
  type SwapWeightsState,
  decide,
  swapPolicyParams,
  swapStatus,
} from "../src/index.js";

// Smart Swap's `decide(snapshot, now)` (models rule 20e, MD-N14-13–26, -40):
// one pure function, one precedence. Every snapshot here is scripted; no
// model, no clock, no probe.

const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const GB = 1024 ** 3;
const NOW = 100 * HOUR;

/** Weights whose round trip against the Worker is 600 s: 50 + 250 + 50 + 250. */
function w(over: Partial<SwapWeightsState> = {}): SwapWeightsState {
  return {
    load: { median: 250 * S, p90: 250 * S },
    unload: { median: 50 * S, p90: 50 * S },
    fileBytes: 12 * GB,
    ...over,
  };
}

const QUEUE_WEIGHTS: Record<string, string> = {
  worker: "cyber",
  planner: "qwen",
  chat: "qwen",
  escalation: "qwen",
  reviewer: "gemma",
  researcher: "apodex",
};

const CLASS_OF: Record<string, RequestClass> = {
  worker: "worker",
  planner: "planner",
  chat: "interactive",
  escalation: "planner",
  reviewer: "reviewer",
  researcher: "researcher",
};

/** A request queued `ageMs` ago on a queue, taking `serviceMs`. */
function req(
  id: string,
  queue: string,
  ageMs: number,
  serviceMs = 10 * S,
  extra: Partial<SwapRequest> = {},
): SwapRequest & { queue: string } {
  return {
    id,
    queue,
    cls: CLASS_OF[queue] as RequestClass,
    queuedAt: NOW - ageMs,
    serviceMs,
    ...(queue === "reviewer" ? { review: true } : {}),
    ...extra,
  };
}

function queues(...reqs: (SwapRequest & { queue: string })[]): SwapQueueState[] {
  const by = new Map<string, SwapQueueState>();
  for (const { queue, ...r } of reqs) {
    const q = by.get(queue) ?? {
      queue,
      weights: QUEUE_WEIGHTS[queue] as string,
      requests: [],
    };
    q.requests.push(r);
    by.set(queue, q);
  }
  return [...by.values()];
}

/** One large model at a time: a load is admitted only once every other resident is evicted. */
function oneAtATime(): SwapMemory {
  return {
    freeBytes: 0,
    admit: ({ load, evict, resident }) => {
      const left = resident.filter((r) => r !== load && !evict.includes(r));
      return left.length === 0
        ? { ok: true }
        : { ok: false, reason: `${left.join(", ")} would stay resident beside ${load}` };
    },
  };
}

/** Room for `n` models at once. */
function room(n: number, freeBytes = 0): SwapMemory {
  return {
    freeBytes,
    admit: ({ load, evict, resident }) => {
      const left = resident.filter((r) => r !== load && !evict.includes(r));
      return left.length + 1 <= n ? { ok: true } : { ok: false, reason: "no room" };
    },
  };
}

function base(over: Partial<SwapSnapshot> = {}): SwapSnapshot {
  return {
    params: DEFAULT_SWAP_POLICY,
    home: "cyber",
    weights: {
      cyber: w({ residentSince: NOW - 2 * HOUR, lastServedAt: NOW - S }),
      qwen: w(),
      gemma: w(),
      apodex: w(),
    },
    queues: [],
    watchdog: "normal",
    presence: { present: false },
    swaps: [],
    homeAbsences: [],
    memory: oneAtATime(),
    ...over,
  };
}

const snap = base;

/** The Worker away and `visitor` resident since `sinceMs` ago. */
function visiting(visitor: string, sinceMs: number, extra: Partial<SwapWeightsState> = {}) {
  return {
    cyber: w(),
    qwen: w(),
    gemma: w(),
    apodex: w(),
    [visitor]: w({ residentSince: NOW - sinceMs, lastServedAt: NOW - sinceMs, ...extra }),
  };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as object)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MD-N14-13: one pure function", () => {
  it("returns the same action for the same snapshot and time, reading no clock, randomness or probe", () => {
    const s = deepFreeze(
      snap({
        queues: queues(req("w1", "worker", MIN), req("p1", "planner", 20 * MIN)),
        overThreshold: ["qwen"],
      }),
    );
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("decide read the clock");
    });
    vi.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("decide drew a random number");
    });
    vi.spyOn(performance, "now").mockImplementation(() => {
      throw new Error("decide read the clock");
    });
    const a = decide(s, NOW);
    const b = decide(s, NOW);
    expect(a).toEqual(b);
  });

  it("no other code chooses which weights to load or evict (a search), except the watchdog", () => {
    const roots = [
      join(import.meta.dirname, "../src"),
      join(import.meta.dirname, "../../../apps/harness/src"),
    ];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    for (const r of roots) walk(r);
    // The old ways of choosing: a plan-order rank, an "evictable" list, a victim loop.
    const choosing = /\bevictable\b|order\?\.indexOf|for \(const victim of/;
    const offenders = files
      .filter((f) => !f.endsWith("swap_decide.ts"))
      .filter((f) => choosing.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    const residency = readFileSync(join(import.meta.dirname, "../src/residency.ts"), "utf8");
    expect(residency).toMatch(/decide\(/);
  });
});

describe("MD-N14-14: one precedence, and every delayed request's predicted start", () => {
  it("the watchdog at emergency unloads every model nobody holds", () => {
    const a = decide(
      snap({
        memory: room(3),
        weights: {
          cyber: w({ residentSince: NOW - HOUR }),
          qwen: w({ residentSince: NOW - MIN, held: true }),
          gemma: w(),
          apodex: w(),
        },
        watchdog: "emergency",
        queues: queues(req("w1", "worker", MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "unload", weights: ["cyber"], rule: "watchdog" });
  });

  it("a hold outranks everything below the watchdog: the held visitor stays and the aged review waits with its start", () => {
    const a = decide(
      snap({
        weights: visiting("qwen", 5 * MIN, { held: true }),
        queues: queues(req("r1", "reviewer", 50 * MIN), req("w1", "worker", MIN)),
      }),
      NOW,
    );
    expect(a.kind).toBe("wait");
    expect(a.rule).toBe("hold");
    expect(a.starts.r1).toBeGreaterThan(NOW);
    expect(a.starts.w1).toBeGreaterThan(NOW);
  });

  it("an interactive request that would break C5 gets the quick path and the full answer's predicted start", () => {
    const a = decide(
      snap({
        // The Worker has been away 11 of the last 60 minutes, with cards waiting.
        homeAbsences: [{ from: NOW - 40 * MIN, to: NOW - 29 * MIN }],
        homeBacklog: true,
        queues: queues(req("w1", "worker", S), req("c1", "chat", 30 * S)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "keep", serve: "worker" });
    expect(a.quickPath).toEqual(["c1"]);
    // The full answer starts once the Worker's absence rolls out of the hour.
    expect(a.starts.c1).toBeGreaterThan(NOW + 10 * MIN);
  });

  it("an interactive request that keeps C5 is swapped for at the next boundary, outside the storm count", () => {
    const a = decide(
      snap({
        homeBacklog: true,
        queues: queues(req("w1", "worker", S), req("c1", "chat", 30 * S)),
        // Two round trips already this hour: C7 would stop a non-interactive swap.
        swaps: [
          { at: NOW - 50 * MIN, ms: 5 * MIN, to: "gemma", interactive: false, roundTrip: true },
          { at: NOW - 40 * MIN, ms: 5 * MIN, to: "apodex", interactive: false, roundTrip: true },
        ],
      }),
      NOW,
    );
    expect(a).toMatchObject({
      kind: "swap",
      load: "qwen",
      evict: ["cyber"],
      rule: "interactive",
      interactive: true,
    });
  });

  it("at elevated the watchdog's keep-alive ends a visitor's idle hold, and starts no prefetch", () => {
    const a = decide(
      snap({
        memory: room(1, 64 * GB),
        weights: visiting("qwen", 5 * MIN),
        plan: ["gemma"],
        watchdog: "elevated",
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "unload", weights: ["qwen"], rule: "watchdog" });
  });

  it("never interrupts a step: a swap away from weights mid-step waits at the drain barrier", () => {
    const a = decide(
      snap({
        weights: {
          cyber: w({ residentSince: NOW - HOUR, runningSteps: 1 }),
          qwen: w(),
          gemma: w(),
          apodex: w(),
        },
        queues: queues(req("c1", "chat", 10 * S)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", load: "qwen", barrier: true });
  });
});

describe("MD-N14-15: C1, exhaustive service with a threshold and hysteresis", () => {
  // Weights on a fast SSD: C_pair = 1 + 5 + 1 + 5 = 12 s, so the threshold is
  // W ≥ 12 s ÷ 0.2 = 60 s, and a visit fits the Worker's floor (C5).
  const fast = (over: Partial<SwapWeightsState> = {}) =>
    w({ load: { median: 5 * S, p90: 5 * S }, unload: { median: S, p90: S }, ...over });
  const fastWeights = {
    cyber: fast({ residentSince: NOW - HOUR }),
    qwen: fast(),
    gemma: fast(),
    apodex: fast(),
  };
  const over = queues(
    req("w1", "worker", S),
    req("p1", "planner", 5 * MIN, 40 * S),
    req("p2", "planner", 4 * MIN, 40 * S),
  );
  const under = queues(req("w1", "worker", S), req("p1", "planner", 5 * MIN, 40 * S));
  const snap = (o: Partial<SwapSnapshot>) => base({ weights: fastWeights, ...o });

  it("a crossing at one boundary and a fall at the next swaps nothing", () => {
    const first = decide(snap({ queues: over, homeBacklog: true }), NOW);
    expect(first).toMatchObject({ kind: "keep", serve: "worker" });
    expect(first.memo.overThreshold).toEqual(["qwen"]);
    const second = decide(
      snap({ queues: under, homeBacklog: true, overThreshold: first.memo.overThreshold }),
      NOW + S,
    );
    expect(second).toMatchObject({ kind: "keep", serve: "worker" });
    expect(second.memo.overThreshold).toEqual([]);
    const third = decide(
      snap({ queues: over, homeBacklog: true, overThreshold: second.memo.overThreshold }),
      NOW + 2 * S,
    );
    expect(third.kind).toBe("keep");
  });

  it("two consecutive boundaries over the threshold swap, with the resident's queue still full", () => {
    const a = decide(snap({ queues: over, homeBacklog: true, overThreshold: ["qwen"] }), NOW);
    expect(a).toMatchObject({ kind: "swap", load: "qwen", rule: "C1", roundTrip: true });
  });

  it("with the resident's queue empty, r's work loads r at once", () => {
    const a = decide(base({ queues: queues(req("p1", "planner", MIN)) }), NOW);
    expect(a).toMatchObject({ kind: "swap", load: "qwen", evict: ["cyber"], rule: "C1" });
  });

  it("with no cost known, exhaustive service alone decides", () => {
    const unknown = base({
      queues: over,
      homeBacklog: true,
      overThreshold: ["qwen"],
      weights: {
        cyber: { residentSince: NOW - HOUR },
        qwen: {},
        gemma: {},
        apodex: {},
      },
    });
    expect(decide(unknown, NOW)).toMatchObject({ kind: "keep", serve: "worker" });
  });
});

describe("MD-N14-16: C2, one absence serves every queue past half its cap", () => {
  it("a Planner question at 60% and a review at 55% go in one tour, the shared weights first; the Researcher at 20% waits", () => {
    const a = decide(
      snap({
        queues: queues(
          req("p1", "planner", 18 * MIN),
          req("r1", "reviewer", 24.75 * MIN),
          req("x1", "researcher", 12 * MIN),
        ),
      }),
      NOW,
    );
    expect(a).toMatchObject({
      kind: "swap",
      load: "qwen",
      tour: ["qwen", "gemma"],
      roundTrip: true,
    });
  });

  it("the tour continues from visitor to visitor without a new round trip, then returns to the Worker", () => {
    const next = decide(
      snap({
        weights: visiting("qwen", 5 * MIN),
        tour: ["gemma"],
        queues: queues(req("r1", "reviewer", 30 * MIN)),
      }),
      NOW,
    );
    expect(next).toMatchObject({ kind: "swap", load: "gemma", roundTrip: false, rule: "C2" });
    const back = decide(
      snap({
        weights: visiting("gemma", 5 * MIN),
        tour: [],
        queues: queues(req("w1", "worker", MIN)),
        homeBacklog: true,
        homeAbsences: [{ from: NOW - 11 * MIN }],
      }),
      NOW,
    );
    expect(back).toMatchObject({ kind: "swap", load: "cyber", roundTrip: false });
  });
});

describe("MD-N14-17: the horizon optimiser, and eviction by next use", () => {
  it("takes the order that meets every cap over the default order", () => {
    const a = decide(
      snap({
        queues: queues(
          req("p1", "planner", 16 * MIN, 60 * S),
          req("r1", "reviewer", 38 * MIN, 60 * S),
        ),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", load: "gemma", tour: ["gemma", "qwen"] });
  });

  it("when no order meets every cap, the precedence order stands and each wait is stated", () => {
    const a = decide(
      snap({
        queues: queues(
          req("p1", "planner", 29 * MIN, 60 * S),
          req("r1", "reviewer", 44 * MIN, 60 * S),
        ),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", tour: ["qwen", "gemma"] });
    expect(a.starts.r1).toBeGreaterThan(NOW - 44 * MIN + 45 * MIN);
  });

  it("evicts the resident whose next use in the plan is farthest, not the least recently used", () => {
    const three = (plan?: string[]) =>
      snap({
        home: undefined,
        memory: room(3),
        weights: {
          qwen: w({ residentSince: NOW - HOUR, lastServedAt: NOW - 5 * MIN }),
          gemma: w({ residentSince: NOW - HOUR, lastServedAt: NOW - 50 * MIN }),
          apodex: w({ residentSince: NOW - HOUR, lastServedAt: NOW - 2 * MIN }),
          phi: w(),
        },
        queues: [{ queue: "phi", weights: "phi", requests: [req("f1", "planner", MIN)] }],
        ...(plan ? { plan } : {}),
      });
    expect(decide(three(["phi", "gemma", "qwen", "apodex"]), NOW)).toMatchObject({
      kind: "swap",
      load: "phi",
      evict: ["apodex"],
    });
    // With no plan, the least recently used.
    expect(decide(three(), NOW)).toMatchObject({ kind: "swap", load: "phi", evict: ["gemma"] });
  });
});

describe("MD-N14-18: C3, minimum dwell and idle hold equal C_pair", () => {
  it("keeps an idle visitor 600 s after its last request, then returns to the Worker the plan uses next", () => {
    const plan = ["cyber"];
    const at599 = decide(snap({ weights: visiting("qwen", 599 * S), plan }), NOW);
    expect(at599).toMatchObject({ kind: "keep", rule: "C3", until: NOW + S });
    const at601 = decide(snap({ weights: visiting("qwen", 601 * S), plan }), NOW);
    expect(at601).toMatchObject({ kind: "swap", load: "cyber", evict: ["qwen"], rule: "C3" });
    // With no plan the visitor stays, evictable without its dwell.
    expect(decide(snap({ weights: visiting("qwen", 601 * S) }), NOW)).toMatchObject({
      kind: "keep",
      rule: "idle",
    });
  });

  it("an elevated sample at 300 s ends the hold", () => {
    const a = decide(snap({ weights: visiting("qwen", 300 * S), watchdog: "elevated" }), NOW);
    expect(a).toMatchObject({ kind: "unload", weights: ["qwen"] });
  });

  it("a request for another role at 200 s ends the idle hold", () => {
    const a = decide(
      snap({ weights: visiting("qwen", 200 * S), queues: queues(req("x1", "researcher", S)) }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", load: "apodex", evict: ["qwen"] });
  });

  it("within its minimum dwell a working visitor is not swapped away by the threshold", () => {
    const heavy = queues(
      req("p1", "planner", MIN),
      req("x1", "researcher", MIN, 1600 * S),
      req("x2", "researcher", MIN, 1600 * S),
    );
    const early = decide(
      snap({ weights: visiting("qwen", 100 * S), queues: heavy, overThreshold: ["apodex"] }),
      NOW,
    );
    expect(early).toMatchObject({ kind: "keep", serve: "planner" });
    const late = decide(
      snap({ weights: visiting("qwen", 700 * S), queues: heavy, overThreshold: ["apodex"] }),
      NOW,
    );
    expect(late).toMatchObject({ kind: "swap", load: "apodex" });
  });
});

describe("MD-N14-19, -20: C4, one aging mechanism", () => {
  it("a request at its cap is served at the next boundary", () => {
    const a = decide(
      snap({
        homeBacklog: true,
        queues: queues(req("w1", "worker", S), req("x1", "researcher", 60 * MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", load: "apodex", rule: "C4" });
  });

  it("a cap below C_pair is infeasible: no aging swap, and the predicted wait is given", () => {
    const params = swapPolicyParams({
      capsMs: { ...DEFAULT_SWAP_POLICY.capsMs, researcher: 5 * MIN },
    });
    const a = decide(
      snap({
        params,
        homeBacklog: true,
        queues: queues(req("w1", "worker", S), req("x1", "researcher", 6 * MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "keep", serve: "worker" });
    expect(a.starts.x1).toBeGreaterThan(NOW);
    const status = swapStatus(snap({ params, queues: queues(req("x1", "researcher", MIN)) }), NOW);
    expect(status.caps.find((c) => c.cls === "researcher")).toMatchObject({
      feasible: false,
      predictedWaitMs: 600 * S,
    });
  });

  it("past θ_max the Planner's cap stretches: 31 minutes is not yet aged at θ = 0.3", () => {
    const busy = [
      { at: NOW - 50 * MIN, ms: 9 * MIN, to: "qwen", interactive: true, roundTrip: true },
      { at: NOW - 30 * MIN, ms: 9 * MIN, to: "cyber", interactive: true, roundTrip: false },
    ];
    const a = decide(
      snap({
        homeBacklog: true,
        swaps: busy,
        queues: queues(req("w1", "worker", S), req("p1", "planner", 31 * MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "keep", serve: "worker" });
    expect(swapStatus(snap({ swaps: busy }), NOW).placementNotice).toBe(true);
    const calm = decide(
      snap({
        homeBacklog: true,
        queues: queues(req("w1", "worker", S), req("p1", "planner", 31 * MIN)),
      }),
      NOW,
    );
    expect(calm).toMatchObject({ kind: "swap", load: "qwen", rule: "C4" });
  });
});

describe("MD-N14-22: C6, presence-aware reviews", () => {
  it("while a person is present, reviews rank first after interactive requests", () => {
    const q = queues(req("p1", "planner", 15 * MIN), req("r1", "reviewer", 5 * MIN));
    expect(decide(snap({ queues: q, presence: { present: true } }), NOW)).toMatchObject({
      kind: "swap",
      load: "gemma",
      tour: ["gemma", "qwen"],
    });
    expect(decide(snap({ queues: q }), NOW)).toMatchObject({
      kind: "swap",
      load: "qwen",
      tour: ["qwen"],
    });
  });

  it("overnight, reviews batch into one tour that ends before the reserved hours start", () => {
    const night = (reservedInMs: number) =>
      snap({
        homeBacklog: true,
        presence: { present: false, reservedStartsAt: NOW + reservedInMs },
        queues: queues(
          req("w1", "worker", S),
          req("r1", "reviewer", 50 * MIN, 30 * S),
          req("r2", "reviewer", 20 * MIN, 30 * S),
        ),
      });
    // Five hours before the morning: past the 45-minute cap, and still batched.
    expect(decide(night(5 * HOUR), NOW)).toMatchObject({ kind: "keep", serve: "worker" });
    // The tour's median is 600 s + 60 s of reviews; it starts within one C_pair
    // of its latest start, 21 minutes before the morning.
    expect(decide(night(22 * MIN), NOW)).toMatchObject({ kind: "keep", serve: "worker" });
    const due = decide(night(19 * MIN), NOW);
    expect(due).toMatchObject({ kind: "swap", load: "gemma", rule: "C6" });
    expect(due.starts.r2).toBeLessThan(NOW + 19 * MIN);
  });
});

describe("MD-N14-23: C7, the storm cap in round trips", () => {
  const storm = [
    // Short swaps (θ = 0.05), so no cap is stretched.
    { at: NOW - 50 * MIN, ms: MIN, to: "gemma", interactive: false, roundTrip: true },
    { at: NOW - 40 * MIN, ms: MIN, to: "gemma", interactive: false, roundTrip: false },
    { at: NOW - 30 * MIN, ms: MIN, to: "apodex", interactive: false, roundTrip: true },
  ];

  it("past θ_max × 3600 ÷ C_pair round trips no non-interactive swap is decided; waits carry their start", () => {
    // 720 s ÷ 600 s = 1.2 round trips; two have happened.
    const a = decide(
      snap({
        homeBacklog: true,
        swaps: storm,
        queues: queues(req("w1", "worker", S), req("x1", "researcher", 61 * MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "keep", serve: "worker" });
    expect(a.starts.x1).toBeGreaterThanOrEqual(NOW + 10 * MIN);
  });

  it("an interactive request is not bounded by the storm cap", () => {
    const a = decide(snap({ swaps: storm, queues: queues(req("c1", "chat", 10 * S)) }), NOW);
    expect(a).toMatchObject({ kind: "swap", load: "qwen", interactive: true });
  });
});

describe("MD-N14-26: C10, prefetch from free memory only", () => {
  const idle = (freeBytes: number, over: Partial<SwapSnapshot> = {}) =>
    snap({ memory: room(1, freeBytes), plan: ["qwen"], ...over });

  it("warms the successor while free memory minus 2 GB exceeds its bytes and the watchdog is normal", () => {
    expect(decide(idle(20 * GB), NOW)).toMatchObject({ kind: "prefetch", weights: "qwen" });
    expect(decide(idle(13 * GB), NOW).kind).toBe("keep");
    expect(decide(idle(20 * GB, { watchdog: "elevated" }), NOW).kind).not.toBe("prefetch");
    const warmed = idle(20 * GB, {
      weights: {
        cyber: w({ residentSince: NOW - HOUR }),
        qwen: w({ prefetched: true }),
        gemma: w(),
        apodex: w(),
      },
    });
    expect(decide(warmed, NOW).kind).toBe("keep");
  });
});

describe("MD-N14-40: a benchmark block swaps once at its start and bypasses C1–C10", () => {
  it("loads the block's weights whatever the storm cap says, then serves only them", () => {
    const storm = [
      { at: NOW - 50 * MIN, ms: 5 * MIN, to: "gemma", interactive: false, roundTrip: true },
      { at: NOW - 30 * MIN, ms: 5 * MIN, to: "apodex", interactive: false, roundTrip: true },
    ];
    const start = decide(
      snap({
        benchmark: { weights: "gemma" },
        swaps: storm,
        homeBacklog: true,
        queues: queues(req("w1", "worker", S)),
      }),
      NOW,
    );
    expect(start).toMatchObject({ kind: "swap", load: "gemma", rule: "benchmark" });
    const inside = decide(
      snap({
        benchmark: { weights: "gemma" },
        weights: visiting("gemma", 10 * MIN),
        queues: queues(
          req("r1", "reviewer", MIN),
          req("x1", "researcher", 2 * HOUR),
          req("c1", "chat", 5 * MIN),
        ),
      }),
      NOW,
    );
    expect(inside).toMatchObject({ kind: "keep", serve: "reviewer", rule: "benchmark" });
  });
});

describe("memory: a refused load keeps its work queued, naming why", () => {
  it("names the refusal and loads nothing", () => {
    const a = decide(
      snap({
        memory: {
          admit: ({ load }) =>
            load === "gemma" ? { ok: false, reason: "Hermes on 8080 holds 9 GB" } : { ok: true },
        },
        queues: queues(req("r1", "reviewer", MIN)),
      }),
      NOW,
    );
    expect(a.kind).toBe("wait");
    expect(a.refused).toEqual([{ weights: "gemma", reason: "Hermes on 8080 holds 9 GB" }]);
  });
});

describe("review fixes to decide()", () => {
  it("C7: at most ⌊θ_max × 3600 ÷ C_pair⌋ round trips — with a cap of 1.2, a second one waits", () => {
    const one = [{ at: NOW - 50 * MIN, ms: MIN, to: "gemma", interactive: false, roundTrip: true }];
    const research = queues(req("w1", "worker", S), req("x1", "researcher", 61 * MIN));
    const a = decide(snap({ homeBacklog: true, swaps: one, queues: research }), NOW);
    expect(a.kind).not.toBe("swap");
    // With none this hour, the first round trip is decided.
    const b = decide(snap({ homeBacklog: true, swaps: [], queues: research }), NOW);
    expect(b).toMatchObject({ kind: "swap", load: "apodex" });
  });

  it("a final wait carries the earliest time a blocked visit may go, so the pump wakes then", () => {
    const one = [{ at: NOW - 50 * MIN, ms: MIN, to: "gemma", interactive: false, roundTrip: true }];
    // A visitor idle past its hold; a research request the storm cap blocks.
    const a = decide(
      snap({
        weights: visiting("qwen", 20 * MIN),
        swaps: one,
        queues: queues(req("x1", "researcher", MIN)),
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "wait", rule: "C7", until: NOW + 10 * MIN });
  });

  it("the elevated watchdog overrides C3's dwell on the threshold's path", () => {
    const heavy = queues(
      req("p1", "planner", MIN),
      req("x1", "researcher", MIN, 1600 * S),
      req("x2", "researcher", MIN, 1600 * S),
    );
    const a = decide(
      snap({
        weights: visiting("qwen", 100 * S),
        queues: heavy,
        overThreshold: ["apodex"],
        watchdog: "elevated",
      }),
      NOW,
    );
    expect(a).toMatchObject({ kind: "swap", load: "apodex" });
  });

  it("at emergency a model held only for the policy (an escalated attempt) with no running step is unloaded; a running step or a person's hold keeps it", () => {
    const soft = { held: true, holdYieldsToWatchdog: true };
    const at = (extra: Partial<SwapWeightsState>) =>
      decide(snap({ weights: visiting("qwen", MIN, extra), watchdog: "emergency" }), NOW);
    expect(at(soft)).toMatchObject({ kind: "unload", weights: ["qwen"], rule: "watchdog" });
    expect(at({ ...soft, runningSteps: 1 }).kind).not.toBe("unload");
    expect(at({ held: true }).kind).not.toBe("unload");
  });
});
