import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, platform, totalmem } from "node:os";

export type MemoryPressureLevel = "normal" | "warning" | "critical";

export interface MemoryPressureStatus {
  level: MemoryPressureLevel;
  usedRatio: number;
  /** Suppress multi-token prediction, which trades memory for speed. */
  throttleMtp: boolean;
  /** Stop creating additional worktrees until pressure subsides. */
  throttleWorktrees: boolean;
  /** Hold card execution entirely; the next allocation would likely swap. */
  pauseExecution: boolean;
  /** How long a model should stay resident between turns at this pressure. */
  recommendedKeepAlive: string;
}

const WARNING_RATIO = 0.85;
const CRITICAL_RATIO = 0.94;

/**
 * Classify memory pressure from used/total bytes.
 *
 * A resident MoE checkpoint is ~14GB on a 24GB box, so the margin between
 * "fine" and "swapping" is a couple of gigabytes. Keeping a model pinned for
 * half an hour is what turns a tight box into an unusable one, so keep-alive
 * shortens as pressure climbs rather than staying fixed.
 */
export function classifyMemoryPressure(
  usedBytes: number,
  totalBytes: number,
): MemoryPressureStatus {
  const usedRatio = totalBytes > 0 ? usedBytes / totalBytes : 0;

  if (usedRatio >= CRITICAL_RATIO) {
    return {
      level: "critical",
      usedRatio,
      throttleMtp: true,
      throttleWorktrees: true,
      pauseExecution: true,
      // Not "0": evicting mid-card forces a full weight reload on the next
      // turn, which on this hardware costs far more wall clock than the memory
      // it frees. The card runner unloads explicitly when the card ends.
      recommendedKeepAlive: "60s",
    };
  }

  if (usedRatio >= WARNING_RATIO) {
    return {
      level: "warning",
      usedRatio,
      throttleMtp: true,
      throttleWorktrees: usedRatio >= 0.9,
      pauseExecution: false,
      // A resident model is the expected steady state while a card runs; the
      // pressure response is to stop adding worktrees, not to evict the weights.
      recommendedKeepAlive: "5m",
    };
  }

  return {
    level: "normal",
    usedRatio,
    throttleMtp: false,
    throttleWorktrees: false,
    pauseExecution: false,
    recommendedKeepAlive: "5m",
  };
}

/** Sample current host memory pressure. */
export function currentMemoryPressure(): MemoryPressureStatus {
  const total = totalmem();
  return classifyMemoryPressure(total - freemem(), total);
}

/**
 * Bytes of swap currently in use, or undefined where it cannot be read.
 *
 * Swap is the signal that actually predicts an OOM on unified-memory Macs.
 * `os.freemem()` counts reclaimable file cache as used, so it reads "high
 * pressure" on a healthy machine and gave no warning before the host ran out
 * of memory during a Chronicle run with 9.4GB of 10GB swap consumed.
 */
export function readSwapUsedBytes(): number | undefined {
  try {
    if (platform() === "darwin") {
      const out = execFileSync("sysctl", ["-n", "vm.swapusage"], { encoding: "utf8" });
      const match = /used\s*=\s*([\d.]+)([KMG])/i.exec(out);
      if (!match) return undefined;
      const unit = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[
        (match[2] ?? "M").toUpperCase() as "K" | "M" | "G"
      ];
      return Number.parseFloat(match[1] ?? "0") * unit;
    }
    if (platform() === "linux") {
      const info = readFileSync("/proc/meminfo", "utf8");
      const total = /SwapTotal:\s+(\d+)/.exec(info)?.[1];
      const free = /SwapFree:\s+(\d+)/.exec(info)?.[1];
      if (total === undefined || free === undefined) return undefined;
      return (Number(total) - Number(free)) * 1024;
    }
  } catch {
    // Unreadable: the guard treats unknown as "no evidence of danger".
  }
  return undefined;
}

/**
 * Linux Pressure Stall Information mapped onto the macOS scale.
 *
 * `some avg10` is the share of the last 10 s in which at least one task
 * stalled on memory; `full avg10`, the share in which every task did. Any
 * sustained full stall is critical (the machine is thrashing); a some-stall
 * above 10% is the warning a swap storm starts with.
 */
export function psiPressureLevel(psi: string): number | undefined {
  const some = /some\s+avg10=([\d.]+)/.exec(psi)?.[1];
  const full = /full\s+avg10=([\d.]+)/.exec(psi)?.[1];
  if (some === undefined) return undefined;
  const s = Number(some);
  const f = full === undefined ? 0 : Number(full);
  if (f >= 5 || s >= 40) return 4;
  if (s >= 10) return 2;
  return 1;
}

/**
 * The kernel's own memory-pressure level: 1 normal, 2 warning, 4 critical.
 *
 * This is the live signal. Swap in use is not: pages written out earlier stay
 * on disk until touched, so a healthy machine can show gigabytes of stale swap.
 */
export function readKernelPressureLevel(): number | undefined {
  if (platform() === "linux") {
    try {
      return psiPressureLevel(readFileSync("/proc/pressure/memory", "utf8"));
    } catch {
      return undefined;
    }
  }
  if (platform() !== "darwin") return undefined;
  try {
    const out = execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
      encoding: "utf8",
    });
    const level = Number.parseInt(out.trim(), 10);
    return Number.isFinite(level) ? level : undefined;
  } catch {
    return undefined;
  }
}

export interface HeadroomLimits {
  /** Refuse a turn once swap in use exceeds this. Default 6GB. */
  maxSwapBytes?: number;
  /** Refuse once swap has grown this much since the card started. Default 2GB. */
  maxSwapGrowthBytes?: number;
}

export interface HeadroomVerdict {
  ok: boolean;
  swapUsedBytes?: number;
  reason?: string;
}

/**
 * Decide whether it is safe to issue another inference turn.
 *
 * The harness must stop itself before the host does. A card that halts with a
 * recorded `memory_pressure` stop reason is resumable; a kernel OOM takes the
 * whole machine, every uncommitted change, and the user's other work with it.
 */
export function checkExecutionHeadroom(
  baselineSwapBytes: number | undefined,
  limits: HeadroomLimits = {},
): HeadroomVerdict {
  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);

  // The kernel's critical level means the next allocation is likely to stall
  // or be killed, whatever swap says: stop immediately.
  const level = readKernelPressureLevel();
  if (level !== undefined && level >= 4) {
    return { ok: false, reason: "the kernel reports critical memory pressure" };
  }

  const swap = readSwapUsedBytes();
  if (swap === undefined) return { ok: true };

  // Absolute cap is generous because stale swap is common; growth during the
  // card is the signal that this run is the cause.
  const maxSwap = limits.maxSwapBytes ?? 6 * 1024 ** 3;
  const maxGrowth = limits.maxSwapGrowthBytes ?? 2 * 1024 ** 3;

  if (swap > maxSwap) {
    return {
      ok: false,
      swapUsedBytes: swap,
      reason: `swap in use ${gb(swap)}GB exceeds the ${gb(maxSwap)}GB limit`,
    };
  }
  const growth = baselineSwapBytes !== undefined ? swap - baselineSwapBytes : 0;
  // At the warning level, tolerate half the usual growth.
  const effectiveGrowth = level !== undefined && level >= 2 ? maxGrowth / 2 : maxGrowth;
  if (baselineSwapBytes !== undefined && growth > effectiveGrowth) {
    return {
      ok: false,
      swapUsedBytes: swap,
      reason: `swap grew ${gb(growth)}GB during this card (limit ${gb(effectiveGrowth)}GB${
        effectiveGrowth < maxGrowth ? ", halved at warning pressure" : ""
      })`,
    };
  }
  return { ok: true, swapUsedBytes: swap };
}
