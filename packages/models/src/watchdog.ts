import { freemem, totalmem } from "node:os";
import { readKernelPressureLevel, readSwapUsedBytes } from "./memory.js";

/**
 * Memory-pressure watchdog (M20, H26).
 *
 * `checkExecutionHeadroom` answers once per turn, and a turn on this hardware
 * can last minutes: a swap storm that starts mid-generation is seen only when
 * it is already an OOM. The watchdog polls every 2 s and escalates through
 * graduated levels, each adding an action:
 *
 *   elevated   suspend the MTP head (next launch), stop new worktrees,
 *              shorten keep-alive
 *   high       + one card at a time, trim KV/prompt and language-server
 *              caches, mask older observations at the next step
 *   critical   + pause: issue no new turns until pressure falls
 *   emergency  + unload the models
 *
 * It escalates on the first sample that warrants it and de-escalates only
 * after `recoverySamples` consecutive calmer samples, so it does not flap.
 * The watchdog decides; the queue acts, through `handlers` (run once when an
 * action first becomes active) and `onChange`.
 */
export type WatchdogLevel = "normal" | "elevated" | "high" | "critical" | "emergency";

export type WatchdogAction =
  | "suspendMtp"
  | "stopNewWorktrees"
  | "shortenKeepAlive"
  | "throttleParallelCards"
  | "trimCaches"
  | "forceMasking"
  | "pauseTurns"
  | "unloadModels";

/**
 * Every action a level may list. Each has a handler the queue or the runner
 * acts on (MD-N2-5; `apps/harness/src/watchdog_actions.ts`); an action with
 * none is removed from the list rather than declared.
 */
export const WATCHDOG_ACTIONS: readonly WatchdogAction[] = [
  "suspendMtp",
  "stopNewWorktrees",
  "shortenKeepAlive",
  "throttleParallelCards",
  "trimCaches",
  "forceMasking",
  "pauseTurns",
  "unloadModels",
];

export const WATCHDOG_LEVELS: readonly WatchdogLevel[] = [
  "normal",
  "elevated",
  "high",
  "critical",
  "emergency",
];

const ELEVATED: WatchdogAction[] = ["suspendMtp", "stopNewWorktrees", "shortenKeepAlive"];
/**
 * The 0.90 stage (MD-N2-4): one card at a time, the KV, prompt and
 * language-server caches trimmed, and older observations masked at the next step.
 */
const HIGH: WatchdogAction[] = [...ELEVATED, "throttleParallelCards", "trimCaches", "forceMasking"];
const CRITICAL: WatchdogAction[] = [...HIGH, "pauseTurns"];

const ACTIONS_AT: Record<WatchdogLevel, WatchdogAction[]> = {
  normal: [],
  elevated: ELEVATED,
  high: HIGH,
  critical: CRITICAL,
  emergency: [...CRITICAL, "unloadModels"],
};

/** The actions in force at a level (cumulative). */
export function actionsForLevel(level: WatchdogLevel): readonly WatchdogAction[] {
  return ACTIONS_AT[level];
}

export interface MemorySample {
  /** Kernel pressure: 1 normal, 2 warning, 4 critical (macOS scale; PSI mapped onto it). */
  kernelLevel?: number | undefined;
  swapUsedBytes?: number | undefined;
  freeBytes: number;
  totalBytes: number;
}

export interface WatchdogThresholds {
  /** Swap growth since start that raises each level. */
  elevatedSwapGrowthBytes: number;
  highSwapGrowthBytes: number;
  criticalSwapGrowthBytes: number;
  emergencySwapGrowthBytes: number;
  /** Absolute swap in use that is critical regardless of growth. */
  criticalSwapBytes: number;
  /** Consecutive kernel-warning samples that make `high`. */
  sustainedWarningSamples: number;
  /** Consecutive kernel-critical samples that make `emergency`. */
  sustainedCriticalSamples: number;
}

const GB = 1024 ** 3;

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  elevatedSwapGrowthBytes: 0.5 * GB,
  highSwapGrowthBytes: 1 * GB,
  criticalSwapGrowthBytes: 2 * GB,
  emergencySwapGrowthBytes: 3 * GB,
  criticalSwapBytes: 6 * GB,
  sustainedWarningSamples: 3,
  sustainedCriticalSamples: 3,
};

export interface WatchdogState {
  level: WatchdogLevel;
  actions: readonly WatchdogAction[];
  /** Why the level is what it is, for the log and the Machine view. */
  reason: string;
  sample: MemorySample;
  swapGrowthBytes: number | undefined;
  /** When the level last changed (ms epoch). */
  since: number;
  samples: number;
}

export interface MemoryWatchdogOptions {
  /** Poll interval. Default 2000 ms. */
  intervalMs?: number;
  thresholds?: Partial<WatchdogThresholds>;
  /** Calmer samples in a row before stepping down. Default 3. */
  recoverySamples?: number;
  /** Injectable: one reading of the host. */
  readSample?: () => MemorySample;
  /** Run once when an action becomes active (entering a level that adds it). */
  handlers?: Partial<Record<WatchdogAction, () => void | Promise<void>>>;
  /** Run when an action stops being active (e.g. resume MTP). */
  releaseHandlers?: Partial<Record<WatchdogAction, () => void | Promise<void>>>;
  now?: () => number;
}

function defaultSample(): MemorySample {
  return {
    kernelLevel: readKernelPressureLevel(),
    swapUsedBytes: readSwapUsedBytes(),
    freeBytes: freemem(),
    totalBytes: totalmem(),
  };
}

function rank(level: WatchdogLevel): number {
  return WATCHDOG_LEVELS.indexOf(level);
}

export class MemoryWatchdog {
  private readonly thresholds: WatchdogThresholds;
  private readonly readSample: () => MemorySample;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private baselineSwap: number | undefined;
  private warningRun = 0;
  private criticalRun = 0;
  private calmRun = 0;
  private listeners = new Set<(state: WatchdogState, previous: WatchdogLevel) => void>();
  private current: WatchdogState;
  /** Handler promises still running, so tests and shutdown can await them. */
  private pending: Promise<unknown>[] = [];

  constructor(private options: MemoryWatchdogOptions = {}) {
    this.thresholds = { ...DEFAULT_WATCHDOG_THRESHOLDS, ...(options.thresholds ?? {}) };
    this.readSample = options.readSample ?? defaultSample;
    this.now = options.now ?? Date.now;
    this.current = {
      level: "normal",
      actions: [],
      reason: "not yet sampled",
      sample: { freeBytes: 0, totalBytes: 0 },
      swapGrowthBytes: undefined,
      since: this.now(),
      samples: 0,
    };
  }

  public get intervalMs(): number {
    return this.options.intervalMs ?? 2000;
  }

  /** Start polling. Idempotent. The timer never keeps the process alive. */
  public start(): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public get running(): boolean {
    return this.timer !== undefined;
  }

  public get state(): WatchdogState {
    return this.current;
  }

  /** True while the loop must not issue a new turn. */
  public shouldPauseTurns(): boolean {
    return this.current.actions.includes("pauseTurns");
  }

  public isActive(action: WatchdogAction): boolean {
    return this.current.actions.includes(action);
  }

  /** Subscribe to level changes; returns an unsubscribe function. */
  public onChange(listener: (state: WatchdogState, previous: WatchdogLevel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait until every action handler started so far has finished. */
  public async settled(): Promise<void> {
    const pending = this.pending;
    this.pending = [];
    await Promise.allSettled(pending);
  }

  /** Resolve true once the level is below `level`, false on timeout. */
  public waitUntilBelow(level: WatchdogLevel, timeoutMs: number): Promise<boolean> {
    if (rank(this.current.level) < rank(level)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, timeoutMs);
      const off = this.onChange((state) => {
        if (rank(state.level) < rank(level)) {
          clearTimeout(timer);
          off();
          resolve(true);
        }
      });
    });
  }

  /** The level one sample warrants on its own, before hysteresis. */
  private classify(sample: MemorySample): { level: WatchdogLevel; reason: string } {
    const t = this.thresholds;
    const k = sample.kernelLevel;
    this.warningRun = k !== undefined && k >= 2 && k < 4 ? this.warningRun + 1 : 0;
    this.criticalRun = k !== undefined && k >= 4 ? this.criticalRun + 1 : 0;
    const growth =
      sample.swapUsedBytes !== undefined && this.baselineSwap !== undefined
        ? sample.swapUsedBytes - this.baselineSwap
        : 0;
    const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

    if (this.criticalRun >= t.sustainedCriticalSamples) {
      return { level: "emergency", reason: `kernel critical for ${this.criticalRun} samples` };
    }
    if (growth >= t.emergencySwapGrowthBytes) {
      return { level: "emergency", reason: `swap grew ${gb(growth)}` };
    }
    if (k !== undefined && k >= 4) return { level: "critical", reason: "kernel critical" };
    if (growth >= t.criticalSwapGrowthBytes) {
      return { level: "critical", reason: `swap grew ${gb(growth)}` };
    }
    if (sample.swapUsedBytes !== undefined && sample.swapUsedBytes >= t.criticalSwapBytes) {
      return { level: "critical", reason: `swap in use ${gb(sample.swapUsedBytes)}` };
    }
    if (this.warningRun >= t.sustainedWarningSamples) {
      return { level: "high", reason: `kernel warning for ${this.warningRun} samples` };
    }
    if (growth >= t.highSwapGrowthBytes)
      return { level: "high", reason: `swap grew ${gb(growth)}` };
    if (k !== undefined && k >= 2) return { level: "elevated", reason: "kernel warning" };
    if (growth >= t.elevatedSwapGrowthBytes) {
      return { level: "elevated", reason: `swap grew ${gb(growth)}` };
    }
    return { level: "normal", reason: "pressure normal" };
  }

  /** Take one reading and apply it. Called by the timer; callable directly. */
  public sample(): WatchdogState {
    const sample = this.readSample();
    if (this.baselineSwap === undefined && sample.swapUsedBytes !== undefined) {
      // Stale swap from before the run is not this run's doing: measure growth.
      this.baselineSwap = sample.swapUsedBytes;
    }
    const verdict = this.classify(sample);
    const previous = this.current.level;
    let next = previous;
    let reason = this.current.reason;

    if (rank(verdict.level) > rank(previous)) {
      next = verdict.level;
      reason = verdict.reason;
      this.calmRun = 0;
    } else if (rank(verdict.level) < rank(previous)) {
      this.calmRun++;
      if (this.calmRun >= (this.options.recoverySamples ?? 3)) {
        next = verdict.level;
        reason = verdict.reason;
        this.calmRun = 0;
      }
    } else {
      this.calmRun = 0;
      reason = verdict.reason;
    }

    const growth =
      sample.swapUsedBytes !== undefined && this.baselineSwap !== undefined
        ? sample.swapUsedBytes - this.baselineSwap
        : undefined;
    this.current = {
      level: next,
      actions: ACTIONS_AT[next],
      reason,
      sample,
      swapGrowthBytes: growth,
      since: next === previous ? this.current.since : this.now(),
      samples: this.current.samples + 1,
    };

    if (next !== previous) {
      const before = new Set(ACTIONS_AT[previous]);
      const after = new Set(ACTIONS_AT[next]);
      for (const action of after) {
        if (!before.has(action)) this.run(this.options.handlers?.[action]);
      }
      for (const action of before) {
        if (!after.has(action)) this.run(this.options.releaseHandlers?.[action]);
      }
      for (const listener of this.listeners) listener(this.current, previous);
    }
    return this.current;
  }

  private run(handler: (() => void | Promise<void>) | undefined): void {
    if (!handler) return;
    try {
      const result = handler();
      if (result instanceof Promise) this.pending.push(result.catch(() => undefined));
    } catch {
      // An action that fails must not stop the watchdog.
    }
  }
}
