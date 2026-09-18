import { freemem } from "node:os";
import { readKernelPressureLevel } from "./memory.js";
import type { LocalInferenceAdapter } from "./types.js";

/** Roles the harness assigns to models. */
/**
 * worker: the fast coder. manager: Merit, repair plans and reflection.
 * escalation: the manager's model driving the coding loop, for retries of
 * cards beyond the worker's measured capability.
 */
export type ModelRole = "worker" | "manager" | "escalation";

/** An adapter that can release its weights. HttpInferenceAdapter implements this. */
export interface UnloadableAdapter extends LocalInferenceAdapter {
  unload?(): Promise<void>;
  /** Resolves true once the weights are really gone (see HttpInferenceAdapter). */
  confirmUnloaded?(timeoutMs?: number): Promise<boolean>;
}

export interface RouterOptions {
  /** Swap log: what was unloaded, whether it was confirmed, free RAM before/after. */
  log?: (line: string) => void;
  /** Longest wait for memory pressure to return to normal after an unload. */
  headroomWaitMs?: number;
  /**
   * Keep both models resident instead of swapping. Only for hosts with the
   * memory for it (see `canCoReside`); on a 24 GB machine it must stay false.
   */
  coResident?: boolean;
  /** Injectable for tests. */
  pressureLevel?: () => number | undefined;
  freeBytes?: () => number;
}

export class SwapHeadroomError extends Error {}

/**
 * Hands out one model per role while guaranteeing only one is ever resident.
 *
 * On a 24GB machine a 13.7GB worker and an 11.3GB manager cannot coexist:
 * loading both is exactly how the host ran out of memory. Switching roles
 * therefore unloads the current model first. Swaps are expensive (seconds from
 * the internal SSD, minutes from the external drive), so callers should batch
 * work per role rather than alternate per turn.
 */
export class ModelRouter {
  private adapters = new Map<ModelRole, UnloadableAdapter>();
  private active: ModelRole | undefined;
  private swaps = 0;

  constructor(
    private factories: Partial<Record<ModelRole, () => UnloadableAdapter>>,
    private options: RouterOptions = {},
  ) {}

  public has(role: ModelRole): boolean {
    return this.factories[role] !== undefined;
  }

  /** Number of role switches performed, for the run report. */
  public get swapCount(): number {
    return this.swaps;
  }

  public get activeRole(): ModelRole | undefined {
    return this.active;
  }

  private adapter(role: ModelRole): UnloadableAdapter {
    let adapter = this.adapters.get(role);
    if (!adapter) {
      const factory = this.factories[role];
      if (!factory) throw new Error(`No model configured for role '${role}'`);
      adapter = factory();
      this.adapters.set(role, adapter);
    }
    return adapter;
  }

  /** Return the adapter for `role`, unloading whichever other role was resident. */
  public async use(role: ModelRole): Promise<UnloadableAdapter> {
    if (this.active !== undefined && this.active !== role && !this.options.coResident) {
      // Two roles on the same weights (manager and escalation) share the
      // resident model: unloading it only to load it again is pure swap cost.
      const same = this.adapters.get(this.active)?.modelId === this.adapter(role).modelId;
      if (!same) {
        await this.swapOut(this.active, role);
        this.swaps++;
      }
    }
    this.active = role;
    return this.adapter(role);
  }

  /**
   * Unload the resident model and prove the memory came back before the next
   * one loads. Loading on top of a model that has not actually left is how
   * this 24 GB host ran out of memory: an unload request is not an unload.
   */
  private async swapOut(from: ModelRole, to: ModelRole): Promise<void> {
    const log = this.options.log ?? (() => undefined);
    const free = this.options.freeBytes ?? freemem;
    const pressure = this.options.pressureLevel ?? readKernelPressureLevel;
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    const before = free();
    const outgoing = this.adapters.get(from);
    await outgoing?.unload?.();
    const confirmed = (await outgoing?.confirmUnloaded?.()) ?? true;

    // Then wait for the kernel to report normal pressure (1) again.
    const deadline = Date.now() + (this.options.headroomWaitMs ?? 30_000);
    let level = pressure();
    while (level !== undefined && level > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      level = pressure();
    }
    log(
      `swap ${from} -> ${to}: unload ${confirmed ? "confirmed" : "NOT confirmed"}, free ${gb(before)} -> ${gb(free())}, pressure ${level === undefined ? "n/a" : level === 1 ? "normal" : level === 2 ? "warning" : "critical"}`,
    );
    if (!confirmed || (level !== undefined && level >= 4)) {
      throw new SwapHeadroomError(
        `Refusing to load the ${to} model: ${!confirmed ? `the ${from} model did not unload` : "memory pressure is still critical"}. Loading now could exhaust memory.`,
      );
    }
  }

  /** Unload everything. Call on every exit path. */
  public async releaseAll(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.unload?.();
    this.active = undefined;
  }
}

/**
 * Whether a host can hold the worker and the manager at once: total memory
 * must cover both models plus a working reserve for the OS, the sandbox and
 * the gates (TypeScript and Vitest are not small). Today's 24 GB host cannot;
 * a 48-64 GB host usually can, and then every swap disappears.
 */
export function canCoReside(
  totalBytes: number,
  workerBytes: number,
  managerBytes: number,
  reserveBytes = 10 * 1024 ** 3,
): boolean {
  return totalBytes >= workerBytes + managerBytes + reserveBytes;
}
