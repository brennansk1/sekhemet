import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HttpInferenceAdapter,
  type MachineProfile,
  type MemorySample,
  WATCHDOG_ACTIONS,
  actionsForLevel,
  hardwareFingerprint,
  hostFingerprintHash,
  saveMachineProfile,
} from "@sekhemet/models";
import { afterEach, describe, expect, it } from "vitest";
import {
  PressureControls,
  createCardWatchdog,
  workerFloorRefusal,
} from "../src/watchdog_actions.js";

const GB = 1024 ** 3;
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const sample = (kernelLevel: number, swapGb = 1): MemorySample => ({
  kernelLevel,
  swapUsedBytes: swapGb * GB,
  freeBytes: 2 * GB,
  totalBytes: 24 * GB,
});

function fakeTargets() {
  const calls: string[] = [];
  const adapter = {
    modelId: "w",
    setMtpSuspended: (s: boolean) => calls.push(`mtp ${s}`),
    setKeepAliveOverride: (v: string | undefined) => calls.push(`keepAlive ${v}`),
    trimCache: async () => {
      calls.push("kv trim");
      return 1;
    },
  };
  const controls = new PressureControls({
    adapters: () => [adapter],
    lspPool: () => ({
      trimCaches: async () => {
        calls.push("lsp trim");
        return { stopped: 1, documentsClosed: 2 };
      },
    }),
    releaseModels: async () => {
      calls.push("unload");
    },
  });
  return { calls, controls };
}

describe("NEW-models-2: the watchdog's actions, on every path", () => {
  it("MD-N2-4: high throttles parallel cards, trims caches and forces masking; elevated stops worktrees and shortens keep-alive", () => {
    const elevated = actionsForLevel("elevated");
    expect(elevated).toContain("stopNewWorktrees");
    expect(elevated).toContain("shortenKeepAlive");
    expect(elevated).not.toContain("throttleParallelCards");
    const high = actionsForLevel("high");
    for (const a of ["throttleParallelCards", "trimCaches", "forceMasking"] as const) {
      expect(high).toContain(a);
    }
    expect(high).not.toContain("pauseTurns");
  });

  it("MD-N2-5: every action the levels list has a handler the queue or the runner acts on", async () => {
    const listed = new Set(
      (["elevated", "high", "critical", "emergency"] as const).flatMap((l) => actionsForLevel(l)),
    );
    expect([...listed].sort()).toEqual([...WATCHDOG_ACTIONS].sort());
    const { calls, controls } = fakeTargets();
    const handlers = controls.handlers();
    for (const action of WATCHDOG_ACTIONS) {
      const handler = handlers[action];
      expect(handler, `no handler for ${action}`).toBeTypeOf("function");
      await handler();
    }
    expect(calls).toEqual(
      expect.arrayContaining(["mtp true", "keepAlive 5m", "kv trim", "lsp trim", "unload"]),
    );
    // What the queue and the runner read, each set by its handler.
    expect(controls.stopNewWorktrees).toBe(true);
    expect(controls.throttled).toBe(true);
    expect(controls.pauseTurns).toBe(true);
    expect(controls.takeMaskingRequest()).toBe(true);
    expect(controls.takeMaskingRequest()).toBe(false);
    // Released, they undo what can be undone.
    const release = controls.releaseHandlers();
    for (const action of WATCHDOG_ACTIONS) await release[action]?.();
    expect(calls).toContain("mtp false");
    expect(calls).toContain("keepAlive undefined");
    expect(controls.throttled).toBe(false);
    expect(controls.stopNewWorktrees).toBe(false);
  });

  it("MD-N2-4: while throttled the queue runs one card at a time", async () => {
    const { controls } = fakeTargets();
    let drained = 0;
    const pool = { running: 2, drain: async () => void drained++ };
    await controls.beforeNextCard(pool);
    expect(drained).toBe(0);
    await controls.handlers().throttleParallelCards();
    await controls.beforeNextCard(pool);
    expect(drained).toBe(1);
    await controls.beforeNextCard({ running: 0, drain: pool.drain });
    expect(drained).toBe(1);
  });

  it("MD-N2-4: a real adapter's keep-alive is shortened and restored", () => {
    const adapter = new HttpInferenceAdapter({
      modelId: "x",
      keepAlive: "30m",
      memoryAware: false,
    });
    const seen = () => (adapter as unknown as { resolveKeepAlive(): string }).resolveKeepAlive();
    expect(seen()).toBe("30m");
    adapter.setKeepAliveOverride("5m");
    expect(seen()).toBe("5m");
    adapter.setKeepAliveOverride(undefined);
    expect(seen()).toBe("30m");
  });

  it("MD-N2-2: the card's watchdog runs for the card and a critical level pauses new steps", async () => {
    const samples = [sample(1), sample(4), sample(4)];
    let i = 0;
    const { calls, controls } = fakeTargets();
    const guard = createCardWatchdog(controls, {
      readSample: () => samples[Math.min(i++, samples.length - 1)] as MemorySample,
      intervalMs: 60_000,
    });
    expect(guard.watchdog.running).toBe(true);
    expect(guard.watchdog.shouldPauseTurns()).toBe(false);
    guard.watchdog.sample();
    await guard.watchdog.settled();
    expect(guard.watchdog.state.level).toBe("critical");
    expect(guard.watchdog.shouldPauseTurns()).toBe(true);
    expect(calls).toContain("kv trim");
    guard.stop();
    expect(guard.watchdog.running).toBe(false);
  });

  it("MD-N2-1, MD-N2-3: a Worker below the overnight floor is refused, naming measured and required rates", () => {
    const dir = mkdtempSync(join(tmpdir(), "sek-floor-"));
    dirs.push(dir);
    const path = join(dir, "machine.json");
    const profile: MachineProfile = {
      version: 1,
      date: "2026-09-25T00:00:00Z",
      fingerprint: hardwareFingerprint(),
      fingerprintHash: hostFingerprintHash(),
      usableBytes: 16 * GB,
      tier: "M",
      models: {
        w: {
          modelId: "slow-worker",
          label: "w",
          buckets: {},
          speed: { prefillTokensPerSecond: 150, decodeTokensPerSecond: 6 },
          throughputClass: "below_floor",
        },
      },
    };
    saveMachineProfile(profile, path);
    const refusal = workerFloorRefusal("slow-worker", path);
    expect(refusal).toMatch(/prefill 150\.0 tok\/s \(required 40\)/);
    expect(refusal).toMatch(/decode 6\.0 tok\/s \(required 10\)/);
    expect(workerFloorRefusal("never-measured", path)).toBeUndefined();
    // A profile measured on other hardware decides nothing here (MD-N1-3).
    saveMachineProfile({ ...profile, fingerprintHash: "elsewhere" }, path);
    expect(workerFloorRefusal("slow-worker", path)).toBeUndefined();
  });
});
