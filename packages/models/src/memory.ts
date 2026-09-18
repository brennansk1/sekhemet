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

export interface HeadroomLimits {
  /** Refuse a turn once swap in use exceeds this. Default 3GB. */
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
  const swap = readSwapUsedBytes();
  if (swap === undefined) return { ok: true };

  const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
  const maxSwap = limits.maxSwapBytes ?? 3 * 1024 ** 3;
  const maxGrowth = limits.maxSwapGrowthBytes ?? 2 * 1024 ** 3;

  if (swap > maxSwap) {
    return {
      ok: false,
      swapUsedBytes: swap,
      reason: `swap in use ${gb(swap)}GB exceeds the ${gb(maxSwap)}GB limit`,
    };
  }
  if (baselineSwapBytes !== undefined && swap - baselineSwapBytes > maxGrowth) {
    return {
      ok: false,
      swapUsedBytes: swap,
      reason: `swap grew ${gb(swap - baselineSwapBytes)}GB during this card (limit ${gb(maxGrowth)}GB)`,
    };
  }
  return { ok: true, swapUsedBytes: swap };
}
