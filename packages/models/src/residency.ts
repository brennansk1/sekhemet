import { readKernelPressureLevel, readSwapUsedBytes } from "./memory.js";
import {
  type LoadPrediction,
  type SwapCostOptions,
  SwapCostTracker,
  type Volume,
} from "./swap_cost.js";
import type { AdapterHealth, InferenceRequest, UnloadableAdapter } from "./types.js";

/**
 * One scheduler owns model residency (models rule 20a, NEW-models-9).
 *
 * - **Adapters are keyed by weights, not by role** (MD-N9-1): the roles one
 *   set of weights serves share one adapter, built once with the largest
 *   context any of them needs, so a request from either never reloads it.
 * - **Work waits in per-role queues** (MD-N9-2) and drains whenever its
 *   weights are resident. Swaps follow the residency plan (`order`) and the
 *   waiting queues, never the order the work arrived: every queue a resident
 *   model serves drains before the next model loads.
 * - **A load that does not fit is refused** (MD-N9-3): before any load the
 *   resident footprint plus the new model's is checked against usable memory,
 *   after evicting what may be evicted (resident weights with no waiting work
 *   and no pin). A load that still does not fit, or whose footprint is
 *   unknown, is refused naming both footprints, and its work stays queued.
 * - **When everything fits** (MD-N9-5) nothing is evicted: every model stays
 *   resident and every queue drains as work arrives.
 * - **Every caller asks it** (MD-N9-4): `submit` queues work; `acquire` hands
 *   out a queue's model now as a **hold**, for a caller that uses it across
 *   many requests (a card's run, Seshat's answer). A held model is never
 *   evicted or unloaded until every hold on it is released, and queued work
 *   holds its model while it runs. Every eviction proves the weights left
 *   (`confirmUnloaded`) and waits for normal memory pressure before the next
 *   load; a model whose health check fails is refused at once.
 * - **One lock** serialises every load decision and eviction, so two
 *   concurrent acquires never both decide on the same stale resident set.
 *   The load itself runs outside the lock (about five minutes from USB):
 *   the loading model's footprint is reserved and marked `loading`, no
 *   other load starts while one is in flight, and `release`, `releaseAll`
 *   and the watchdog's unload never wait behind it. `releaseAll` aborts a
 *   load in flight (the server process is killed or the Ollama load
 *   cancelled) and frees its reservation; work queued for it stays queued.
 * - **Smart Swap** (rule 20c, NEW-models-14): making weights resident loads
 *   them then (`adapter.load`), timed; every load, unload and first reply
 *   after a load is recorded with its volume, bytes and cold or warm state,
 *   each load is predicted beforehand, and a slow one is flagged with its
 *   causes and fixes (`SwapCostTracker`). A load that fails for a reason
 *   other than memory rejects the work queued for it (MD-N14-6).
 */

/** A role's need: which weights serve it and the context it needs. */
export interface RoleNeed {
  /** A queue name: worker, planner, seshat, reviewer, researcher, ... */
  role: string;
  /** The weights that serve it (a model build's key). */
  weights: string;
  contextTokens: number;
}

export interface WeightsSpec {
  /** Build the one adapter for these weights, with the context it must hold. */
  build: (contextTokens: number) => UnloadableAdapter;
  /** Resident bytes (weights, KV cache, runtime); unknown refuses the load. */
  footprintBytes?: number;
}

export interface ResidencySchedulerOptions {
  roles: RoleNeed[];
  weights: Record<string, WeightsSpec>;
  /** Memory the models may occupy together. */
  usableBytes: number;
  /** The residency plan: roles in the order their batches run. Unlisted roles come after. */
  order?: string[];
  /** Roles whose weights may not be evicted (a card's step holds them). */
  pinned?: string[];
  /**
   * Whether two weights may be resident at once (the tier's co-loading, rule
   * 8). False keeps one at a time even when two would fit. Default true.
   */
  coResident?: boolean;
  /** Check a model's health before its first use and after each reload. Default true. */
  healthCheck?: boolean;
  /** Longest wait for normal memory pressure after an eviction. Default 30 s. */
  headroomWaitMs?: number;
  /** Injectable: the kernel pressure level (1 normal, 2 warning, 4 critical). */
  pressureLevel?: () => number | undefined;
  /** Poll interval while waiting for pressure. Default 1 s. */
  pollMs?: number;
  log?: (line: string) => void;
  /** The clock loads and unloads are timed by. Default `Date.now`. */
  now?: () => number;
  /** Where Smart Swap records go and its history comes from (NEW-models-14). */
  swapCost?: SwapCostOptions;
  /** Longest wait for an aborted load, and its unload, to settle. Default 10 s. */
  abortWaitMs?: number;
}

/** A load refused for memory: the work stays queued (MD-N9-3). */
export class FootprintRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FootprintRefusal";
  }
}

/** An eviction that was not proven: the next model is not loaded on top of it. */
export class SwapHeadroomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapHeadroomError";
  }
}

/** A load `releaseAll` aborted: its work stays queued, and it is not a failed model. */
export class LoadAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoadAbortedError";
  }
}

/** A queue's model failed its health check (M4). */
export class ModelUnavailableError extends Error {
  constructor(
    public readonly role: string,
    public readonly health: AdapterHealth,
  ) {
    super(
      `The ${role} model ${health.modelId} is unavailable: ${health.detail ?? "health check failed"}`,
    );
    this.name = "ModelUnavailableError";
  }
}

/**
 * A queue's model, pinned until `release` (idempotent). A caller that holds
 * a model across requests releases it when its answer is done.
 */
export interface ModelHold {
  readonly role: string;
  readonly adapter: UnloadableAdapter;
  release(): void;
}

interface Job {
  work: (adapter: UnloadableAdapter) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

/** One step of the pump: drain a resident queue, or wait out a load it started. */
type PumpStep =
  | { drain: string; release: () => void }
  | { loading: string; done: Promise<unknown> };

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

export class ResidencyScheduler {
  private readonly adapters = new Map<string, UnloadableAdapter>();
  private readonly queues = new Map<string, Job[]>();
  private readonly resident = new Set<string>();
  private readonly pinned: Set<string>;
  private readonly refused = new Map<string, FootprintRefusal>();
  private readonly footprints = new Map<string, number>();
  private readonly checked = new Set<string>();
  private pumping = false;
  private again = false;
  private loads = 0;
  private swaps = 0;
  private active: string | undefined;
  /** Holds on each weights: a held model is never evicted or unloaded. */
  private readonly holds = new Map<string, number>();
  /** The tail of the one lock every load decision and eviction takes. */
  private lock: Promise<void> = Promise.resolve();
  /**
   * Loads in flight (at most one), outside the lock: each reserves its
   * footprint until it is resident or aborted.
   */
  private readonly loading = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  /** Smart Swap's record and prediction (NEW-models-14). */
  private readonly cost: SwapCostTracker;
  /** Each weights' file, bytes and volume, once read; null when unknown. */
  private readonly sources = new Map<
    string,
    { path: string; bytes: number; volume: Volume } | null
  >();
  /** Weights whose first reply after a recorded load is still to be timed. */
  private readonly firstReplyDue = new Set<string>();
  /** Weights this scheduler loaded and recorded: only their unloads are real and recorded. */
  private readonly loadedHere = new Set<string>();

  constructor(private readonly options: ResidencySchedulerOptions) {
    this.pinned = new Set(options.pinned ?? []);
    this.cost = new SwapCostTracker({
      swapUsedBytes: readSwapUsedBytes,
      ...options.swapCost,
      ...(options.log && !options.swapCost?.log ? { log: options.log } : {}),
      now: this.now,
      cacheBytes: options.usableBytes,
    });
    for (const [key, spec] of Object.entries(options.weights)) {
      if (spec.footprintBytes !== undefined) this.footprints.set(key, spec.footprintBytes);
    }
  }

  private need(role: string): RoleNeed {
    const need = this.options.roles.find((r) => r.role === role);
    if (!need) throw new Error(`No model is assigned to the ${role} role`);
    return need;
  }

  /** The one adapter for the role's weights, with the largest context its roles need (MD-N9-1). */
  public adapterFor(role: string): UnloadableAdapter {
    const key = this.need(role).weights;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      const spec = this.options.weights[key];
      if (!spec) throw new Error(`No weights registered as ${key}`);
      const context = Math.max(
        ...this.options.roles.filter((r) => r.weights === key).map((r) => r.contextTokens),
      );
      adapter = spec.build(context);
      this.timeFirstReply(key, adapter);
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  private readonly now = (): number => (this.options.now ?? Date.now)();

  /**
   * Time the first reply after a recorded load (MD-N14-2): from the
   * request's start to its first streamed token, or to the reply when it
   * does not stream. The adapter keeps its identity; only `generate` is
   * wrapped, as the throughput meter wraps it.
   */
  private timeFirstReply(key: string, adapter: UnloadableAdapter): void {
    const original = adapter.generate.bind(adapter);
    adapter.generate = async (req: InferenceRequest) => {
      if (!this.firstReplyDue.delete(key)) return original(req);
      const start = this.now();
      let first: number | undefined;
      const onToken = req.onToken;
      const response = await original(
        onToken
          ? {
              ...req,
              onToken: (delta: string) => {
                first ??= this.now() - start;
                onToken(delta);
              },
            }
          : req,
      );
      await this.cost.firstToken({
        model: key,
        roles: this.rolesOf(key),
        firstTokenMs: first ?? this.now() - start,
      });
      return response;
    };
  }

  /** The weights' file, bytes and volume (read once); undefined when the adapter cannot say. */
  private async sourceOf(
    key: string,
  ): Promise<{ path: string; bytes: number; volume: Volume } | undefined> {
    if (!this.sources.has(key)) {
      const role = this.rolesOf(key)[0];
      const found = role
        ? await this.adapterFor(role)
            .weightsSource?.()
            .catch(() => undefined)
        : undefined;
      this.sources.set(key, found ? { ...found, volume: this.cost.volumeOf(found.path) } : null);
    }
    return this.sources.get(key) ?? undefined;
  }

  /**
   * What loading a queue's weights is predicted to cost now (MD-N14-4):
   * cold or warm as the load would be, from the recorded history, else the
   * stated estimate. Undefined when the weights' file is unknown. Loads nothing.
   */
  public async predictLoad(role: string): Promise<LoadPrediction | undefined> {
    const key = this.need(role).weights;
    await this.cost.ready();
    const source = await this.sourceOf(key);
    if (!source) return undefined;
    return this.cost.book.predict({
      model: key,
      volume: source.volume,
      cache: this.cost.cacheState(key, source.bytes),
      bytes: source.bytes,
    });
  }

  /** Unload `key` and record it (MD-N14-2); `confirm` proves the weights left. */
  private async unloadRecorded(key: string, confirm: boolean): Promise<boolean> {
    const adapter = this.adapters.get(key);
    const start = this.now();
    await adapter?.unload?.();
    const confirmed = confirm ? ((await adapter?.confirmUnloaded?.()) ?? true) : false;
    const unloadMs = this.now() - start;
    this.firstReplyDue.delete(key);
    const source = this.loadedHere.delete(key) ? await this.sourceOf(key) : undefined;
    if (source) {
      await this.cost.ready();
      await this.cost.unloaded({
        model: key,
        roles: this.rolesOf(key),
        volume: source.volume,
        bytes: source.bytes,
        unloadMs,
        confirmed,
      });
    }
    return confirmed;
  }

  /**
   * Load `key` now when its adapter can load on request, timed, predicted
   * and recorded, and flagged when slow (MD-N14-1, MD-N14-5). Runs outside
   * the one lock, from `startLoad`, with its footprint reserved.
   */
  private async loadRecorded(key: string, signal: AbortSignal): Promise<void> {
    const adapter = this.adapterFor(this.rolesOf(key)[0] as string);
    if (!adapter.load) return;
    await this.cost.ready();
    const source = await this.sourceOf(key);
    const prediction = source
      ? this.cost.book.predict({
          model: key,
          volume: source.volume,
          cache: this.cost.cacheState(key, source.bytes),
          bytes: source.bytes,
        })
      : undefined;
    const pressure = this.options.pressureLevel ?? readKernelPressureLevel;
    const before = pressure();
    const start = this.now();
    const outcome = await adapter.load(signal);
    if (signal.aborted) throw new LoadAbortedError(`The load of ${key} was aborted`);
    const loadMs = this.now() - start;
    if (outcome === "adopted" || !prediction) return;
    const after = pressure();
    const levels = [before, after].filter((l): l is number => l !== undefined);
    await this.cost.loaded({
      prediction,
      roles: this.rolesOf(key),
      loadMs,
      pressureLevel: levels.length ? Math.max(...levels) : undefined,
    });
    this.loadedHere.add(key);
    this.firstReplyDue.add(key);
  }

  /**
   * Add a queue after construction (a caller that first needs a model later).
   * Its weights' adapter, if already built, keeps its window: a queue that
   * needs more context than it was built with is refused rather than reloaded
   * behind the scheduler's back.
   */
  public addRole(need: RoleNeed, weights?: WeightsSpec): void {
    if (this.has(need.role)) return;
    if (!this.options.weights[need.weights]) {
      if (!weights) throw new Error(`No weights registered as ${need.weights}`);
      this.options.weights[need.weights] = weights;
      if (weights.footprintBytes !== undefined)
        this.footprints.set(need.weights, weights.footprintBytes);
    }
    const built = this.adapters.get(need.weights)?.contextWindow?.contextTokens;
    if (built !== undefined && need.contextTokens > built) {
      throw new Error(
        `The ${need.role} queue needs ${need.contextTokens} tokens of context; ${need.weights} was built with ${built}`,
      );
    }
    this.options.roles.push(need);
  }

  /** Unload one queue's weights now, unless a pinned queue shares them or someone holds them. */
  public release(role: string): Promise<void> {
    return this.exclusive(async () => {
      const key = this.need(role).weights;
      if (!this.resident.has(key) || this.isPinned(key) || this.isHeld(key)) return;
      await this.unloadRecorded(key, false);
      this.resident.delete(key);
      this.checked.delete(key);
      if (this.active && this.need(this.active).weights === key) this.active = undefined;
    });
  }

  /** Whether any hold pins these weights now. */
  public isHeld(weights: string): boolean {
    return (this.holds.get(weights) ?? 0) > 0;
  }

  private isPinned(key: string): boolean {
    return this.rolesOf(key).some((r) => this.pinned.has(r));
  }

  private takeHold(key: string): () => void {
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(key) ?? 1) - 1;
      if (n > 0) this.holds.set(key, n);
      else this.holds.delete(key);
      // Work that waited on the memory is tried again.
      if (this.waitingRoles().length > 0) this.schedule();
    };
  }

  /** Run `fn` under the one lock: loads and evictions never interleave. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Whether a queue is configured. */
  public has(role: string): boolean {
    return this.options.roles.some((r) => r.role === role);
  }

  /** Whether asking this queue now costs no load (its weights are resident). */
  public isResident(role: string): boolean {
    return this.has(role) && this.resident.has(this.need(role).weights);
  }

  /** The queue handed out most recently. */
  public get activeRole(): string | undefined {
    return this.active;
  }

  /** Every queue whose weights are resident now. */
  public residentRoles(): string[] {
    return this.options.roles.filter((r) => this.resident.has(r.weights)).map((r) => r.role);
  }

  /** Known footprints, by weights. */
  public footprintOf(weights: string): number | undefined {
    return this.footprints.get(weights);
  }

  /**
   * Learn each weights' footprint from its adapter (`footprintBytes`), which
   * loads nothing. Weights whose footprint stays unknown are named: they are
   * refused until it is known (MD-N9-3).
   */
  public async measureFootprints(): Promise<{
    footprints: Record<string, number>;
    unknown: string[];
    usableBytes: number;
  }> {
    const unknown: string[] = [];
    for (const key of Object.keys(this.options.weights)) {
      if (this.footprints.has(key)) continue;
      const role = this.rolesOf(key)[0];
      if (!role) continue;
      const bytes = await this.adapterFor(role)
        .footprintBytes?.()
        .catch(() => undefined);
      if (bytes === undefined) unknown.push(key);
      else this.footprints.set(key, bytes);
    }
    return {
      footprints: Object.fromEntries(this.footprints),
      unknown,
      usableBytes: this.options.usableBytes,
    };
  }

  /**
   * A queue's model, resident now and held until the hold is released
   * (MD-N9-4): what may be evicted is evicted (never a pinned or held
   * model), with every eviction proven, under the one lock. Throws a
   * `FootprintRefusal` when it cannot fit beside what is held, a
   * `SwapHeadroomError` when an eviction was not proven, a
   * `ModelUnavailableError` when unhealthy.
   */
  public async acquire(role: string): Promise<ModelHold> {
    const key = this.need(role).weights;
    // A load this acquire started is held from the moment it is resident, so
    // no other acquire evicts it before it is handed out.
    let held: (() => void) | undefined;
    try {
      for (;;) {
        const step = await this.exclusive(() => this.handOut(role, key, held));
        if ("hold" in step) return step.hold;
        // The load runs outside the lock; its failure or abort is this caller's.
        const took = await step.wait;
        if (typeof took === "function") held = took as () => void;
      }
    } catch (err) {
      held?.();
      throw err;
    }
  }

  /**
   * Under the one lock: a hold on resident weights, or what to wait for
   * first (a load of them now started, or the load in flight).
   */
  private async handOut(
    role: string,
    key: string,
    held: (() => void) | undefined,
  ): Promise<{ hold: ModelHold } | { wait: Promise<unknown> }> {
    if (!this.resident.has(key)) {
      const busy = this.inFlight(key);
      if (busy) return { wait: busy };
      return { wait: (await this.startLoad(key, "now", true)).done };
    }
    const adapter = this.adapterFor(role);
    if (this.options.healthCheck !== false && adapter.healthCheck && !this.checked.has(key)) {
      const health = await adapter.healthCheck();
      this.options.log?.(
        `health ${role} ${health.modelId}: ${health.ok ? "ok" : "UNAVAILABLE"}${health.detail ? ` (${health.detail})` : ""}`,
      );
      if (!health.ok) {
        this.resident.delete(key);
        throw new ModelUnavailableError(role, health);
      }
      this.checked.add(key);
    }
    this.active = role;
    return { hold: { role, adapter, release: held ?? this.takeHold(key) } };
  }

  /**
   * What an acquire of `key` waits for while a load is in flight: that load
   * when it is of `key` (its failure is the caller's), else its end.
   */
  private inFlight(key: string): Promise<unknown> | undefined {
    const own = this.loading.get(key);
    if (own) return own.done;
    if (this.loading.size === 0) return undefined;
    return Promise.allSettled([...this.loading.values()].map((l) => l.done));
  }

  /** Queue work for a role; it runs once the role's weights are resident. */
  public submit<T>(role: string, work: (adapter: UnloadableAdapter) => Promise<T>): Promise<T> {
    this.need(role);
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(role) ?? [];
      queue.push({
        work: work as Job["work"],
        resolve: resolve as Job["resolve"],
        reject,
      });
      this.queues.set(role, queue);
      this.schedule();
    });
  }

  /** Items waiting for a role. */
  public waiting(role: string): number {
    return this.queues.get(role)?.length ?? 0;
  }

  /** Why each waiting role's load is refused now, by role. */
  public refusals(): Record<string, FootprintRefusal | undefined> {
    return Object.fromEntries(this.refused);
  }

  /** Record a measured footprint; queued work is tried again. */
  public setFootprint(weights: string, bytes: number): void {
    this.footprints.set(weights, bytes);
    this.schedule();
  }

  public pin(role: string): void {
    this.pinned.add(role);
  }

  /** Release a pin; queued work that waited on the memory is tried again. */
  public unpin(role: string): void {
    this.pinned.delete(role);
    this.schedule();
  }

  public residentWeights(): string[] {
    return [...this.resident];
  }

  /** Loads performed (a first load counts). */
  public get loadCount(): number {
    return this.loads;
  }

  /** Loads that evicted another model first. */
  public get swapCount(): number {
    return this.swaps;
  }

  /** Weights loading now, their footprint reserved. */
  public loadingWeights(): string[] {
    return [...this.loading.keys()];
  }

  /**
   * Unload everything nobody holds, first aborting a load in flight (the
   * watchdog's critical unload never waits minutes behind a load); queued
   * work stays queued.
   */
  public releaseAll(): Promise<void> {
    return this.exclusive(async () => {
      await this.abortLoads();
      for (const key of [...this.resident]) {
        if (this.isHeld(key)) continue;
        await this.unloadRecorded(key, false);
        this.resident.delete(key);
        this.checked.delete(key);
      }
      this.active = undefined;
    });
  }

  /**
   * Abort every load in flight and free its reservation: the adapter stops
   * its server process or cancels its request, and its unload is asked for
   * too, in case the server finished the load regardless. Neither is waited
   * on longer than `abortWaitMs`. Called only under the one lock.
   */
  private async abortLoads(): Promise<void> {
    const wait = this.options.abortWaitMs ?? 10_000;
    const capped = async (p: Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        p.then(
          () => undefined,
          () => undefined,
        ),
        new Promise((r) => {
          timer = setTimeout(r, wait);
        }),
      ]);
      clearTimeout(timer);
    };
    for (const [key, entry] of [...this.loading]) {
      entry.controller.abort();
      await capped(entry.done);
      if (this.loading.get(key) === entry) this.loading.delete(key);
      this.resident.delete(key);
      await capped(this.adapters.get(key)?.unload?.() ?? Promise.resolve());
      this.options.log?.(`residency: the load of ${key} was aborted`);
    }
  }

  private rank(role: string): number {
    const i = this.options.order?.indexOf(role) ?? -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  private waitingRoles(): string[] {
    return [...this.queues.entries()]
      .filter(([, q]) => q.length > 0)
      .map(([role]) => role)
      .sort((a, b) => this.rank(a) - this.rank(b));
  }

  private schedule(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    // A macrotask: work submitted in the same turn is batched before any load.
    setImmediate(() => {
      void this.pump().finally(() => {
        this.pumping = false;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      });
    });
  }

  private async pump(): Promise<void> {
    for (;;) {
      const step = await this.exclusive(async (): Promise<PumpStep | undefined> => {
        // 1. Drain every queue whose weights are resident, in plan order,
        // holding them while the work runs.
        const ready = this.waitingRoles().find((r) => this.resident.has(this.need(r).weights));
        if (ready) return { drain: ready, release: this.takeHold(this.need(ready).weights) };
        // A load in flight: no other starts; its end schedules this again.
        if (this.loading.size > 0) return undefined;
        // 2. Load the next weights the plan and the queues ask for.
        const tried = new Set<string>();
        for (const role of this.waitingRoles()) {
          const key = this.need(role).weights;
          if (tried.has(key)) continue;
          tried.add(key);
          const started = await this.load(key);
          if (started) return { loading: key, done: started.done };
        }
        return undefined;
      });
      if (step === undefined) return;
      if ("done" in step) {
        // The load runs outside the lock; then the queues are looked at again.
        // An aborted load (the watchdog's unload) is not retried at once.
        if (await this.settleQueued(step.loading, step.done)) continue;
        return;
      }
      try {
        await this.drain(step.drain);
      } finally {
        step.release();
      }
    }
  }

  private async drain(role: string): Promise<void> {
    const queue = this.queues.get(role) ?? [];
    const adapter = this.adapterFor(role);
    this.active = role;
    while (queue.length > 0) {
      const job = queue.shift() as Job;
      try {
        job.resolve(await job.work(adapter));
      } catch (err) {
        job.reject(err);
      }
    }
  }

  private rolesOf(key: string): string[] {
    return this.options.roles.filter((r) => r.weights === key).map((r) => r.role);
  }

  private refuse(key: string, message: string): false {
    const refusal = new FootprintRefusal(message);
    for (const role of this.rolesOf(key))
      if (this.waiting(role) > 0) this.refused.set(role, refusal);
    this.options.log?.(message);
    return false;
  }

  /**
   * For queued work: a refusal for memory keeps the work queued and is
   * recorded; a load that failed otherwise (a missing file, a server that
   * exited) rejects the work queued for these weights (MD-N14-6).
   */
  private async load(key: string): Promise<{ done: Promise<unknown> } | false> {
    try {
      return await this.startLoad(key, "queue");
    } catch (err) {
      if (err instanceof FootprintRefusal || err instanceof SwapHeadroomError)
        return this.refuse(key, err.message);
      this.failQueued(key, err);
      return false;
    }
  }

  /**
   * Wait out a load queued work started; false when it was aborted, whose
   * work stays queued. A load that failed otherwise rejects its work.
   */
  private async settleQueued(key: string, done: Promise<unknown>): Promise<boolean> {
    try {
      await done;
    } catch (err) {
      if (err instanceof LoadAbortedError) return false;
      this.failQueued(key, err);
    }
    return true;
  }

  private failQueued(key: string, err: unknown): void {
    for (const role of this.rolesOf(key)) {
      const queue = this.queues.get(role) ?? [];
      this.queues.set(role, []);
      for (const job of queue) job.reject(err);
    }
    this.options.log?.(
      `residency: loading ${key} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /**
   * Start loading `key`, first evicting what may be evicted: in `queue` mode
   * weights nothing pins or holds and no work waits on; in `now` mode weights
   * nothing pins or holds. Called only under the one lock, with no load in
   * flight; the decision and evictions happen under it, then the footprint
   * is reserved and the load runs outside it (`done`).
   */
  private async startLoad(
    key: string,
    mode: "queue" | "now",
    holdWhenResident = false,
  ): Promise<{ done: Promise<(() => void) | undefined> }> {
    const roles = this.rolesOf(key);
    const need = this.footprints.get(key);
    const who = `the ${roles.join("/")} model ${key}`;
    const usable = this.options.usableBytes;
    if (need === undefined) {
      throw new FootprintRefusal(
        `Refusing to load ${who}: the footprint of ${key} is unknown, so it cannot be shown to fit ${gb(usable)} usable; the work stays queued.`,
      );
    }
    const bytesOf = (keys: Iterable<string>) =>
      [...keys].reduce((n, k) => n + (this.footprints.get(k) ?? 0), 0);
    // A load in flight holds its reservation.
    const residentBytes = () => bytesOf(this.resident) + bytesOf(this.loading.keys());
    const oneAtATime = this.options.coResident === false;
    if (oneAtATime || residentBytes() + need > usable) {
      const evictable = [...this.resident].filter(
        (k) =>
          !this.isPinned(k) &&
          !this.isHeld(k) &&
          (mode === "now" || !this.rolesOf(k).some((r) => this.waiting(r) > 0)),
      );
      const keep = [
        ...[...this.resident].filter((k) => !evictable.includes(k)),
        ...this.loading.keys(),
      ];
      const keptBytes = bytesOf(keep);
      if (keptBytes + need > usable || (oneAtATime && keep.length > 0)) {
        const resident = keep.length
          ? `${gb(keptBytes)} resident (${keep.join(", ")})`
          : "nothing resident";
        throw new FootprintRefusal(
          `Refusing to load ${who}: ${resident} + ${gb(need)} (${key}) exceeds ${gb(usable)} usable${oneAtATime && keep.length ? ", and this tier holds one model at a time" : ""}; the work stays queued.`,
        );
      }
      let evicted = false;
      for (const victim of evictable) {
        if (!oneAtATime && residentBytes() + need <= usable) break;
        await this.evict(victim, key);
        evicted = true;
      }
      if (evicted) this.swaps++;
    }
    this.adapterFor(roles[0] as string);
    const controller = new AbortController();
    const entry: { controller: AbortController; done: Promise<(() => void) | undefined> } = {
      controller,
      done: Promise.resolve(undefined),
    };
    this.loading.set(key, entry);
    entry.done = (async () => {
      try {
        await this.loadRecorded(key, controller.signal);
        if (controller.signal.aborted) throw new LoadAbortedError(`The load of ${key} was aborted`);
        this.resident.add(key);
        this.loads++;
        for (const role of roles) this.refused.delete(role);
        this.options.log?.(`residency: ${key} resident for ${roles.join(", ")}`);
        return holdWhenResident ? this.takeHold(key) : undefined;
      } catch (err) {
        if (controller.signal.aborted && !(err instanceof LoadAbortedError))
          throw new LoadAbortedError(
            `The load of ${key} was aborted: ${err instanceof Error ? err.message : String(err)}`,
          );
        throw err;
      } finally {
        if (this.loading.get(key) === entry) this.loading.delete(key);
        // Work queued behind the load is looked at again, unless it was aborted.
        if (!controller.signal.aborted && this.waitingRoles().length > 0) this.schedule();
      }
    })();
    // The caller awaits `done`; a rejection before it does is not unhandled.
    entry.done.catch(() => undefined);
    return { done: entry.done };
  }

  /**
   * Unload `victim` and prove it: the unload is confirmed and memory pressure
   * is back to normal before `next` loads. An unload request is not an unload.
   * Called only under the one lock, from `startLoad`.
   */
  private async evict(victim: string, next: string): Promise<void> {
    const confirmed = await this.unloadRecorded(victim, true);
    this.checked.delete(victim);
    const pressure = this.options.pressureLevel ?? readKernelPressureLevel;
    const deadline = Date.now() + (this.options.headroomWaitMs ?? 30_000);
    let level = pressure();
    while (confirmed && level !== undefined && level > 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.options.pollMs ?? 1000));
      level = pressure();
    }
    const said =
      level === undefined ? "n/a" : level === 1 ? "normal" : level === 2 ? "warning" : "critical";
    this.options.log?.(
      `swap ${victim} -> ${next}: unload ${confirmed ? "confirmed" : "NOT confirmed"}, pressure ${said}`,
    );
    if (!confirmed || (level !== undefined && level >= 4)) {
      throw new SwapHeadroomError(
        `Refusing to load ${next}: ${!confirmed ? `${victim} did not unload` : "memory pressure is still critical"}. Loading now could exhaust memory.`,
      );
    }
    this.resident.delete(victim);
  }
}
