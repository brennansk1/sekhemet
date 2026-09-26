import { FootprintRefusal, type ResidencyScheduler } from "./residency.js";
import { type SwapPolicyParams, flattenSwapPolicy } from "./swap_policy.js";

/**
 * Calibration nights and measurement runs (measurement rule 16d,
 * MS-NM14-3; DEC-42, DEC-45).
 *
 * - **A measurement run** — the frozen suite, a bake-off, an A/B,
 *   qualification — starts from a declared state and **unloads its models
 *   when it ends** (`withMeasurementRun`), even when it fails.
 * - **A calibration night runs the policy as designed** (`runCalibrationNight`):
 *   models stay resident, swap and prefetch as `decide()` chooses, and every
 *   load, unload and first token is recorded by the scheduler. Before its
 *   first load it declares its protocol in one `measure/calibration` event;
 *   before each load it checks DEC-42's host limits (swap under 4 GB and at
 *   least 60% of memory free), refusing a load past them with its work kept
 *   queued; it never starts while a suite or measurement run holds the
 *   runner; and it unloads everything at its end.
 */

export const CALIBRATION_EVENT = "measure/calibration";

export type CalibrationLoadMode = "mmap" | "no_mmap" | "preread_mmap";
export type CalibrationProbe = "read_probe" | "drive_check" | "headroom";

/** What a calibration night declares before its first load. */
export interface CalibrationProtocol {
  policy: SwapPolicyParams;
  /** The weights it will load. */
  models: string[];
  volumes: ("internal" | "external")[];
  loadModes: CalibrationLoadMode[];
  /** The order the load-mode A/B alternates in. */
  abOrder: CalibrationLoadMode[];
  /** Loads per mode (an A/B with fewer than three decides nothing, MD-N14-34). */
  loadsPerMode: number;
  probes: CalibrationProbe[];
  /** Whether it runs the slot-restore equivalence check (rule 16a's scheduling row). */
  equivalenceCheck: boolean;
}

/** DEC-42's host limits before each load. */
export const DEC42_HOST_LIMITS = { maxSwapBytes: 4 * 1024 ** 3, minFreeRatio: 0.6 } as const;

/** Whether the host may take a load now (DEC-42): swap under 4 GB and at least 60% free. */
export function dec42HostCheck(
  reading: { swapUsedBytes: number; freeRatio: number },
  limits: { maxSwapBytes: number; minFreeRatio: number } = DEC42_HOST_LIMITS,
): { ok: true } | { ok: false; reason: string } {
  const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (reading.swapUsedBytes >= limits.maxSwapBytes)
    return {
      ok: false,
      reason: `swap is ${gb(reading.swapUsedBytes)}, at or over the ${gb(limits.maxSwapBytes)} limit`,
    };
  if (reading.freeRatio < limits.minFreeRatio)
    return {
      ok: false,
      reason: `${Math.round(reading.freeRatio * 100)}% of memory is free, under the ${Math.round(limits.minFreeRatio * 100)}% limit`,
    };
  return { ok: true };
}

/** Who holds the runner now. */
export type RunnerHolder = "suite" | "measurement" | "card" | "calibration" | undefined;

export interface CalibrationNightDeps {
  protocol: CalibrationProtocol;
  /** The ledger. */
  record: (event: { type: string; payload: object }) => void | Promise<void>;
  runnerHolder: () => RunnerHolder | Promise<RunnerHolder>;
  /** The host's swap and free-memory share, read before each load. */
  host: () =>
    | { swapUsedBytes: number; freeRatio: number }
    | Promise<{ swapUsedBytes: number; freeRatio: number }>;
  scheduler: Pick<ResidencyScheduler, "setLoadGuard" | "releaseAll">;
  /** The night's work, submitted to the scheduler, which runs `decide()` as designed. */
  night: () => Promise<void>;
}

/** Run one calibration night (MS-NM14-3). */
export async function runCalibrationNight(
  deps: CalibrationNightDeps,
): Promise<{ ran: boolean; refused?: string; hostRefusals: string[] }> {
  const holder = await deps.runnerHolder();
  if (holder === "suite" || holder === "measurement")
    return {
      ran: false,
      refused: `a ${holder} run holds the runner; a calibration night never runs during one`,
      hostRefusals: [],
    };
  const p = deps.protocol;
  if (p.loadsPerMode < 3 || p.abOrder.length === 0)
    return {
      ran: false,
      refused: "the load-mode A/B needs at least three loads per mode, in a declared order",
      hostRefusals: [],
    };
  await deps.record({
    type: CALIBRATION_EVENT,
    payload: {
      policyVersion: p.policy.version,
      params: flattenSwapPolicy(p.policy),
      models: p.models,
      volumes: p.volumes,
      loadModes: p.loadModes,
      abOrder: p.abOrder,
      probes: p.probes,
      equivalenceCheck: p.equivalenceCheck,
    },
  });
  const hostRefusals: string[] = [];
  deps.scheduler.setLoadGuard(async (weights) => {
    const verdict = dec42HostCheck(await deps.host());
    if (!verdict.ok) {
      const why = `DEC-42: not loading ${weights}: ${verdict.reason}`;
      hostRefusals.push(why);
      throw new FootprintRefusal(`${why}; the work stays queued.`);
    }
  });
  try {
    await deps.night();
  } finally {
    deps.scheduler.setLoadGuard(undefined);
    await deps.scheduler.releaseAll();
  }
  return { ran: true, hostRefusals };
}

/** A measurement run (the suite, a bake-off, an A/B, qualification) unloads its models when it ends. */
export async function withMeasurementRun<T>(
  scheduler: Pick<ResidencyScheduler, "releaseAll">,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } finally {
    await scheduler.releaseAll();
  }
}
