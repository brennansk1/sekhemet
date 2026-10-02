import {
  MemoryWatchdog,
  type MemoryWatchdogOptions,
  ThroughputFloorError,
  type WatchdogAction,
  assertModelRunnable,
  loadHostMachineProfile,
} from "@sekhemet/models";

/**
 * What the memory watchdog's actions act on (models rule 19, NEW-models-2).
 * The watchdog decides the level; these controls carry each action to the
 * queue and the runner, which read them:
 *
 * - `suspendMtp`, `shortenKeepAlive`, `trimCaches`, `unloadModels` act at once
 *   on the loaded adapters, the language-server pool and the router;
 * - `stopNewWorktrees` and `throttleParallelCards` are read by the queue
 *   before it starts a card (`mayStartCard`, `beforeNextCard`);
 * - `pauseTurns` is read by the runner before every step (`shouldPauseTurns`);
 * - `forceMasking` is a request the runner takes at its next step
 *   (`takeMaskingRequest`).
 */
export interface PressureTargets {
  /** The adapters loaded now; each may support any of the optional hooks. */
  adapters: () => Iterable<unknown>;
  /** The run's language-server pool (context `LspPool`), when there is one. */
  lspPool?: () => { trimCaches(): Promise<unknown> } | undefined;
  /** Unload every model (the router's `releaseAll`). */
  releaseModels?: () => Promise<void>;
  log?: (line: string) => void;
}

/** Keep-alive while the watchdog asks to shorten it (rule 19: five minutes). */
export const PRESSURE_KEEP_ALIVE = "5m";

type Handler = () => void | Promise<void>;

interface AdapterHooks {
  setMtpSuspended?: (suspended: boolean) => void;
  setKeepAliveOverride?: (value: string | undefined) => void;
  trimCache?: () => Promise<unknown>;
}

export class PressureControls {
  /** The queue starts no new worktree (read by `mayStartCard` through the watchdog). */
  public stopNewWorktrees = false;
  /** The queue runs at most one card at a time. */
  public throttled = false;
  /** The runner starts no new step. */
  public pauseTurns = false;
  private maskingRequested = false;

  constructor(private readonly targets: PressureTargets) {}

  private async each(fn: (a: AdapterHooks) => unknown): Promise<void> {
    await Promise.allSettled([...this.targets.adapters()].map((a) => fn(a as AdapterHooks)));
  }

  /**
   * One handler per action (MD-N2-5): the `Record` makes a new action without
   * a handler a compile error, and the spec walks the list at run time.
   */
  public handlers(): Record<WatchdogAction, Handler> {
    return {
      suspendMtp: () => this.each((a) => a.setMtpSuspended?.(true)),
      stopNewWorktrees: () => {
        this.stopNewWorktrees = true;
      },
      shortenKeepAlive: () => this.each((a) => a.setKeepAliveOverride?.(PRESSURE_KEEP_ALIVE)),
      throttleParallelCards: () => {
        this.throttled = true;
      },
      trimCaches: async () => {
        await this.each((a) => a.trimCache?.());
        await this.targets
          .lspPool?.()
          ?.trimCaches()
          .catch(() => undefined);
      },
      forceMasking: () => {
        this.maskingRequested = true;
      },
      pauseTurns: () => {
        this.pauseTurns = true;
      },
      unloadModels: async () => {
        await this.targets.releaseModels?.();
      },
    };
  }

  /** What stepping down below an action's level undoes. */
  public releaseHandlers(): Partial<Record<WatchdogAction, Handler>> {
    return {
      suspendMtp: () => this.each((a) => a.setMtpSuspended?.(false)),
      stopNewWorktrees: () => {
        this.stopNewWorktrees = false;
      },
      shortenKeepAlive: () => this.each((a) => a.setKeepAliveOverride?.(undefined)),
      throttleParallelCards: () => {
        this.throttled = false;
      },
      forceMasking: () => {
        this.maskingRequested = false;
      },
      pauseTurns: () => {
        this.pauseTurns = false;
      },
    };
  }

  /** The runner's next step masks older observations once per request (MD-N2-4). */
  public takeMaskingRequest(): boolean {
    const asked = this.maskingRequested;
    this.maskingRequested = false;
    return asked;
  }

  /**
   * Called by the queue before it starts a card: while throttled, every
   * running card ends first, so at most one runs (MD-N2-4).
   */
  public async beforeNextCard(pool: { running: number; drain(): Promise<void> }): Promise<void> {
    if (this.throttled && pool.running > 0) {
      this.targets.log?.("memory watchdog: one issue at a time until pressure falls");
      await pool.drain();
    }
  }
}

/**
 * The watchdog for one card or one queue run (MD-N2-2), started at once,
 * acting through `controls`. `stop()` ends it with the card.
 */
export function createCardWatchdog(
  controls: PressureControls,
  options: Omit<MemoryWatchdogOptions, "handlers" | "releaseHandlers"> & {
    log?: (line: string) => void;
  } = {},
): { watchdog: MemoryWatchdog; stop: () => void } {
  const { log, ...rest } = options;
  const watchdog = new MemoryWatchdog({
    ...rest,
    handlers: controls.handlers(),
    releaseHandlers: controls.releaseHandlers(),
  });
  if (log) {
    watchdog.onChange((state, previous) =>
      log(`memory watchdog: ${previous} -> ${state.level} (${state.reason})`),
    );
  }
  watchdog.start();
  return { watchdog, stop: () => watchdog.stop() };
}

/**
 * Why the Worker may not run cards on this host's measured speed (MD-N2-1,
 * MD-N2-3): below the overnight floor, naming the measured and required
 * prefill and decode rates. `run` and `queue` both ask it. A profile measured
 * on other hardware decides nothing (MD-N1-3); an unmeasured model passes.
 */
export function workerFloorRefusal(modelId: string, profilePath?: string): string | undefined {
  try {
    assertModelRunnable(loadHostMachineProfile(profilePath), modelId);
    return undefined;
  } catch (err) {
    if (err instanceof ThroughputFloorError) return err.message;
    throw err;
  }
}
