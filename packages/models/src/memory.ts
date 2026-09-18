import { freemem, totalmem } from "node:os";

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
