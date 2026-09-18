import { afterEach, describe, expect, it, vi } from "vitest";
import { type MemorySample, MemoryWatchdog, actionsForLevel } from "../src/watchdog.js";

const GB = 1024 ** 3;
const s = (kernelLevel: number, swapGb = 1): MemorySample => ({
  kernelLevel,
  swapUsedBytes: swapGb * GB,
  freeBytes: 2 * GB,
  totalBytes: 24 * GB,
});

function scripted(samples: MemorySample[]) {
  let i = 0;
  return () => samples[Math.min(i++, samples.length - 1)] as MemorySample;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("M20: MemoryWatchdog", () => {
  it("actions are cumulative by level", () => {
    expect(actionsForLevel("normal")).toEqual([]);
    expect(actionsForLevel("elevated")).toEqual([
      "suspendMtp",
      "stopNewWorktrees",
      "shortenKeepAlive",
    ]);
    expect(actionsForLevel("critical")).toContain("pauseTurns");
    expect(actionsForLevel("critical")).not.toContain("unloadModels");
    expect(actionsForLevel("emergency")).toContain("unloadModels");
  });

  it("escalates at once, measures swap growth from the first sample, and steps down with hysteresis", () => {
    const w = new MemoryWatchdog({
      readSample: scripted([
        s(1, 4), // baseline: 4 GB of stale swap is not this run's doing
        s(2, 4), // kernel warning
        s(1, 5.2), // +1.2 GB growth -> high
        s(1, 6.5), // +2.5 GB -> critical (growth), also > 6 GB absolute
        s(1, 4), // calm 1
        s(1, 4), // calm 2
        s(1, 4), // calm 3 -> normal
      ]),
    });
    const levels = Array.from({ length: 7 }, () => w.sample().level);
    expect(levels).toEqual([
      "normal",
      "elevated",
      "high",
      "critical",
      "critical",
      "critical",
      "normal",
    ]);
  });

  it("sustained kernel warning becomes high; sustained critical becomes emergency", () => {
    const warn = new MemoryWatchdog({ readSample: () => s(2) });
    expect([1, 2, 3].map(() => warn.sample().level)).toEqual(["elevated", "elevated", "high"]);
    const crit = new MemoryWatchdog({ readSample: () => s(4) });
    expect([1, 2, 3].map(() => crit.sample().level)).toEqual(["critical", "critical", "emergency"]);
    expect(crit.shouldPauseTurns()).toBe(true);
    expect(crit.isActive("unloadModels")).toBe(true);
  });

  it("runs each action's handler once when it becomes active, and release handlers on recovery", async () => {
    const calls: string[] = [];
    const w = new MemoryWatchdog({
      recoverySamples: 1,
      readSample: scripted([s(2), s(2), s(2), s(4), s(1)]),
      handlers: {
        suspendMtp: () => {
          calls.push("suspendMtp");
        },
        trimCaches: async () => {
          calls.push("trimCaches");
        },
        pauseTurns: () => {
          calls.push("pauseTurns");
        },
      },
      releaseHandlers: {
        suspendMtp: () => {
          calls.push("resumeMtp");
        },
      },
    });
    const changes: string[] = [];
    w.onChange((st, prev) => changes.push(`${prev}->${st.level}`));
    for (let i = 0; i < 5; i++) w.sample();
    await w.settled();
    expect(changes).toEqual([
      "normal->elevated",
      "elevated->high",
      "high->critical",
      "critical->normal",
    ]);
    expect(calls).toEqual(["suspendMtp", "trimCaches", "pauseTurns", "resumeMtp"]);
  });

  it("polls every 2 s once started, and waitUntilBelow resolves when pressure falls", async () => {
    vi.useFakeTimers();
    const read = vi.fn(scripted([s(4), s(4), s(1), s(1), s(1)]));
    const w = new MemoryWatchdog({ readSample: read });
    w.start();
    expect(w.intervalMs).toBe(2000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(w.shouldPauseTurns()).toBe(true);
    const below = w.waitUntilBelow("critical", 60_000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(below).resolves.toBe(true);
    expect(w.state.level).toBe("normal");
    w.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(5);
  });
});
