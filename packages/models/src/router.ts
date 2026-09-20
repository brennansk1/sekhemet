import { freemem } from "node:os";
import {
  type TierSettings,
  hostFingerprintHash,
  loadMachineProfile,
  tierSettingsFor,
} from "./calibration.js";
import { readKernelPressureLevel } from "./memory.js";
import type { AdapterHealth, LocalInferenceAdapter } from "./types.js";

/** Roles the harness assigns to models. */
/**
 * worker: the fast coder. manager: Seshat, repair plans and reflection.
 * escalation: the manager's model driving the coding loop, for retries of
 * cards beyond the worker's measured capability.
 * reviewer: an optional model from a different family for Seshat's review
 * (ARIS: cross-family review catches errors a same-family model shares).
 * researcher: evidence-gathering questions (Apodex-1.1-mini by default).
 */
export type ModelRole = "worker" | "manager" | "escalation" | "reviewer" | "researcher";

/** An adapter that can release its weights. HttpInferenceAdapter implements this. */
export interface UnloadableAdapter extends LocalInferenceAdapter {
  unload?(): Promise<void>;
  /** Resolves true once the weights are really gone (see HttpInferenceAdapter). */
  confirmUnloaded?(timeoutMs?: number): Promise<boolean>;
  /** Bytes the model occupies when resident (weights, KV cache, runtime). */
  footprintBytes?(): Promise<number | undefined>;
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
  /**
   * Memory the models may occupy together (total RAM minus a reserve for
   * the OS, sandbox and gates). With a budget and footprints, the router keeps
   * as many models resident as fit and evicts the least valuable one only
   * when a load would not fit. Without one it keeps one model at a time.
   */
  budgetBytes?: number;
  /** Resident size of each role's model (weights plus KV cache). */
  footprints?: Partial<Record<ModelRole, number>>;
  /**
   * Check a model's health (M4) before handing it out for the first time
   * (and after each reload). Default true: an unavailable model fails fast
   * with `ModelUnavailableError` instead of a request timeout minutes later.
   */
  healthCheck?: boolean;
  /**
   * The calibrated tier (M14). Its co-loading rule decides whether two roles
   * may be resident at once; omitted, `calibrate()` reads this host's saved
   * machine profile, and `null` leaves the decision to the budget alone.
   */
  tier?: TierSettings | null;
  /** Injectable for tests. */
  pressureLevel?: () => number | undefined;
  freeBytes?: () => number;
}

/**
 * How valuable it is to keep a role resident. The worker runs every turn;
 * Seshat plans, answers and repairs; the researcher and reviewer work in
 * batches at the end of passes. Escalation shares the manager's weights.
 */
export const ROLE_PRIORITY: Record<ModelRole, number> = {
  worker: 4,
  manager: 3,
  escalation: 3,
  researcher: 2,
  reviewer: 1,
};

/**
 * Which roles a host keeps resident together: the most valuable set that
 * fits the budget, greedily by priority (roles on shared weights count once).
 * Everything else swaps in on demand. Exposed for the Machine view and doctor.
 */
export function planResidency(
  roles: { role: ModelRole; modelId: string; bytes: number }[],
  budgetBytes: number,
): { resident: ModelRole[]; swapped: ModelRole[]; usedBytes: number } {
  const byPriority = [...roles].sort((a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role]);
  const loaded = new Map<string, number>();
  const resident: ModelRole[] = [];
  const swapped: ModelRole[] = [];
  let used = 0;
  for (const r of byPriority) {
    if (loaded.has(r.modelId)) {
      resident.push(r.role);
      continue;
    }
    if (used + r.bytes <= budgetBytes) {
      loaded.set(r.modelId, r.bytes);
      used += r.bytes;
      resident.push(r.role);
    } else {
      swapped.push(r.role);
    }
  }
  return { resident, swapped, usedBytes: used };
}

export class SwapHeadroomError extends Error {}

/** A role's model failed its health check (M4). */
export class ModelUnavailableError extends Error {
  constructor(
    public readonly role: ModelRole,
    public readonly health: AdapterHealth,
  ) {
    super(
      `The ${role} model ${health.modelId} is unavailable: ${health.detail ?? "health check failed"}`,
    );
    this.name = "ModelUnavailableError";
  }
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
/**
 * Hands out one model per role while keeping memory safe.
 *
 * With a memory budget it keeps as many models resident as fit (all four on
 * a 128 GB host) and evicts the lowest-priority, least-recently-used model
 * only when a load would not fit. Without one (the 24 GB default) it keeps a
 * single model resident and swaps. Every eviction proves the weights left
 * and waits for normal memory pressure before the next load.
 */
export class ModelRouter {
  private adapters = new Map<ModelRole, UnloadableAdapter>();
  /** Resident models by model id: which roles use them and when last used. */
  private resident = new Map<string, { roles: Set<ModelRole>; lastUsed: number }>();
  private last: ModelRole | undefined;
  private swaps = 0;
  private tick = 0;

  constructor(
    private factories: Partial<Record<ModelRole, () => UnloadableAdapter>>,
    private options: RouterOptions = {},
  ) {}

  public has(role: ModelRole): boolean {
    return this.factories[role] !== undefined;
  }

  /** Number of evictions performed, for the run report. */
  public get swapCount(): number {
    return this.swaps;
  }

  /** The role used most recently. */
  public get activeRole(): ModelRole | undefined {
    return this.last;
  }

  /** Every role whose model is resident now. */
  public residentRoles(): ModelRole[] {
    return [...this.resident.values()].flatMap((r) => [...r.roles]);
  }

  /** Whether asking this role now costs no load (it, or its weights, are resident). */
  public isResident(role: ModelRole): boolean {
    if (!this.has(role)) return false;
    return this.resident.has(this.adapter(role).modelId);
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

  private footprint(role: ModelRole): number {
    return this.options.footprints?.[role] ?? 0;
  }

  private residentBytes(): number {
    let total = 0;
    for (const r of this.resident.values()) {
      total += Math.max(...[...r.roles].map((role) => this.footprint(role)));
    }
    return total;
  }

  /** Return the adapter for `role`, evicting others only if it would not fit. */
  public async use(role: ModelRole): Promise<UnloadableAdapter> {
    const adapter = this.adapter(role);
    const key = adapter.modelId;
    this.tick++;
    const entry = this.resident.get(key);
    if (entry) {
      entry.roles.add(role);
      entry.lastUsed = this.tick;
      this.last = role;
      return adapter;
    }

    if (this.options.healthCheck !== false && adapter.healthCheck) {
      const health = await adapter.healthCheck();
      this.options.log?.(
        `health ${role} ${health.modelId}: ${health.ok ? "ok" : "UNAVAILABLE"}${health.detail ? ` (${health.detail})` : ""}`,
      );
      if (!health.ok) throw new ModelUnavailableError(role, health);
    }

    const budget = this.options.coResident ? Number.POSITIVE_INFINITY : this.options.budgetBytes;
    const need = this.footprint(role);
    const mustEvict = (): boolean =>
      this.resident.size > 0 &&
      (budget === undefined ? true : this.residentBytes() + need > budget);
    while (mustEvict()) {
      // Evict the least valuable resident: lowest priority, then least recent.
      const victim = [...this.resident.entries()].sort((a, b) => {
        const pa = Math.max(...[...a[1].roles].map((r) => ROLE_PRIORITY[r]));
        const pb = Math.max(...[...b[1].roles].map((r) => ROLE_PRIORITY[r]));
        return pa - pb || a[1].lastUsed - b[1].lastUsed;
      })[0];
      if (!victim) break;
      const [victimKey, victimEntry] = victim;
      const victimRole = [...victimEntry.roles][0] as ModelRole;
      await this.swapOut(victimRole, role);
      this.resident.delete(victimKey);
      this.swaps++;
    }
    this.resident.set(key, { roles: new Set([role]), lastUsed: this.tick });
    this.last = role;
    return adapter;
  }

  /**
   * Unload a resident model and prove the memory came back before the next
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

  /**
   * Measure every configured role's footprint and derive the memory budget
   * (total RAM minus a reserve for the OS, the sandbox and the gates), then
   * return the residency plan. Call once before a run; the router then keeps
   * as many models resident as the plan allows. Roles whose size cannot be
   * measured fall back to one-at-a-time swapping for safety.
   */
  public async calibrate(
    totalBytes: number,
    reserveBytes = Math.max(8 * 1024 ** 3, totalBytes * 0.2),
  ): Promise<ReturnType<typeof planResidency> & { budgetBytes: number }> {
    const roles = (Object.keys(this.factories) as ModelRole[]).filter((r) => this.has(r));
    const measured: { role: ModelRole; modelId: string; bytes: number }[] = [];
    const footprints: Partial<Record<ModelRole, number>> = {};
    let unknown = false;
    for (const role of roles) {
      const a = this.adapter(role);
      const bytes = await a.footprintBytes?.().catch(() => undefined);
      if (bytes === undefined) {
        unknown = true;
        continue;
      }
      footprints[role] = bytes;
      measured.push({ role, modelId: a.modelId, bytes });
    }
    let budgetBytes = Math.max(0, totalBytes - reserveBytes);
    const tier = this.tierSettings();
    if (tier && !tier.coLoadRoles && measured.length > 0) {
      // The tier says roles swap rather than share the machine (below 32 GB
      // they always do). A budget that happens to fit two small models would
      // otherwise keep both, which is the co-residency the tier ruled out.
      budgetBytes = Math.min(budgetBytes, Math.max(...measured.map((m) => m.bytes)));
      this.options.coResident = false;
      this.options.log?.(`residency: ${tier.reason}`);
    }
    if (!unknown) {
      this.options.footprints = footprints;
      this.options.budgetBytes = budgetBytes;
    }
    return { ...planResidency(measured, unknown ? 0 : budgetBytes), budgetBytes };
  }

  /** The tier this run applies: the option, else this host's saved profile. */
  private tierSettings(): TierSettings | undefined {
    if (this.options.tier !== undefined) return this.options.tier ?? undefined;
    const profile = loadMachineProfile();
    if (!profile || profile.fingerprintHash !== hostFingerprintHash()) return undefined;
    return profile.settings ?? tierSettingsFor(profile.usableBytes);
  }

  /** Unload everything. Call on every exit path. */
  public async releaseAll(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.unload?.();
    this.resident.clear();
    this.last = undefined;
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
