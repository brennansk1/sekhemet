import type { LocalInferenceAdapter } from "./types.js";

/** Roles the harness assigns to models. */
export type ModelRole = "worker" | "manager";

/** An adapter that can release its weights. HttpInferenceAdapter implements this. */
export interface UnloadableAdapter extends LocalInferenceAdapter {
  unload?(): Promise<void>;
}

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

  constructor(private factories: Partial<Record<ModelRole, () => UnloadableAdapter>>) {}

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
    if (this.active !== undefined && this.active !== role) {
      await this.adapters.get(this.active)?.unload?.();
      this.swaps++;
    }
    this.active = role;
    return this.adapter(role);
  }

  /** Unload everything. Call on every exit path. */
  public async releaseAll(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.unload?.();
    this.active = undefined;
  }
}
