import {
  type GpuCeiling,
  type HeadroomProbe,
  admitLoad,
  gpuCeilingsFrom,
  metalTimeoutCeiling,
} from "./headroom.js";
import { headroomSwapMemory } from "./headroom_memory.js";
import {
  DriveUnavailableError,
  type LoadOptions,
  type VolumeProber,
  cacheRamMiBFromHeadroom,
  classifyCacheByReadRate,
  predictWithProbe,
} from "./load_mechanics.js";
import { readKernelPressureLevel, readSwapUsedBytes } from "./memory.js";
import {
  type LoadPrediction,
  type SwapCostOptions,
  SwapCostTracker,
  type Volume,
} from "./swap_cost.js";
import {
  type SwapAction,
  type SwapHistoryEntry,
  type SwapMemory,
  type SwapPresence,
  type SwapRequest,
  type SwapSnapshot,
  type SwapWeightsState,
  decide,
  planLoad,
  swapStatus,
} from "./swap_decide.js";
import {
  DEFAULT_SWAP_POLICY,
  type RequestClass,
  SWAP_OVERHEAD_EVENT,
  type SessionCost,
  type SwapOverheadPayload,
  type SwapPolicyParams,
  flattenSwapPolicy,
  theta,
} from "./swap_policy.js";
import type { AdapterHealth, InferenceRequest, ModelSignal, UnloadableAdapter } from "./types.js";
import type { WatchdogLevel } from "./watchdog.js";

/**
 * One scheduler owns model residency (models rule 20a, NEW-models-9).
 *
 * - **Adapters are keyed by weights, not by role** (MD-N9-1): the roles one
 *   set of weights serves share one adapter, built once with the largest
 *   context any of them needs, so a request from either never reloads it.
 * - **Work waits in per-role queues** (MD-N9-2) and drains whenever its
 *   weights are resident. **When to swap, and to what, is Smart Swap's one
 *   pure function, `decide()`** (rule 20e, MD-N14-13): the pump builds a
 *   snapshot — the queues with their ages and predicted service, the holds,
 *   the costs of rule 20d, the memory, presence, the plan, the rolling hour —
 *   calls `decide()` at every step boundary (after each queued request, each
 *   step a slot ends, each hold released) and applies the action. It never
 *   interrupts a step: a swap away from weights with steps running raises
 *   the drain barrier (C8, RUN-35) and happens once the last step ends.
 * - **A load that does not fit is refused** (MD-N9-3): the policy's memory is
 *   `policyMemory` when given, else, with a headroom probe (rule 20g), the
 *   headroom read at each decision (`headroomSwapMemory`: each load's
 *   admission and every transition of a tour, MD-N14-31a), else the
 *   footprints against usable memory; a load that does not fit, or whose
 *   footprint is unknown, is refused naming the measure, and its work stays
 *   queued. With a headroom probe every load is also admitted by the
 *   headroom read at that moment, after its evictions.
 * - **When everything fits** (MD-N9-5) nothing is evicted.
 * - **Every caller asks it** (MD-N9-4): `submit` queues work; `acquire` hands
 *   out a queue's model now as a **hold**, for a caller that uses it across
 *   many requests (a card's run, Seshat's answer); what it evicts is
 *   `decide()`'s eviction choice (`planLoad`: Belady by the plan). A held
 *   model is never evicted or unloaded until every hold on it is released.
 *   An `acquire` that would evict weights with steps running raises the
 *   drain barrier and waits for their boundary (C8), as the pump does;
 *   `waitForHolds` waits for a hold to end rather than refusing (a step
 *   making its weights resident again), and `evict: false` refuses rather
 *   than evict (the quick answerer beside the Worker, rule 20f b).
 *   Every eviction proves the weights left (`confirmUnloaded`) and waits for
 *   normal memory pressure before the next load; a model whose health check
 *   fails is refused at once.
 * - **One lock** serialises every load decision and eviction. The load itself
 *   runs outside the lock (about five minutes from USB): the loading model's
 *   footprint is reserved and marked `loading`, no other load starts while
 *   one is in flight, and `release`, `releaseAll` and the watchdog's unload
 *   never wait behind it. `releaseAll` aborts a load in flight and frees its
 *   reservation; work queued for it stays queued. While a model loads, the
 *   CPU-side work of queued cards runs (`overlap`, C9).
 * - **Smart Swap's record** (rule 20c): every load, unload and first reply
 *   after a load is recorded, each load predicted, a slow one flagged
 *   (`SwapCostTracker`); after each swap θ is recorded with the policy's
 *   parameters (MD-N14-12). A load that fails for a reason other than memory
 *   rejects the work queued for it (MD-N14-6).
 */

/** A role's need: which weights serve it and the context it needs. */

/**
 * How long an unload waits for its adapter to confirm the weights left
 * (MD-N14-2a). A managed server exits within it; an unload not yet confirmed
 * still counts as resident until a later re-check confirms it, so nothing
 * loads beside it and no swap waits on an adapter's longer default.
 */
export const UNLOAD_CONFIRM_MS = 3000;

export interface RoleNeed {
  /** A queue name: worker, planner, seshat, reviewer, researcher, ... */
  role: string;
  /** The weights that serve it (a model build's key). */
  weights: string;
  contextTokens: number;
  /** Its requests' class (the aging cap, rule 20e C4); default by the queue's name. */
  cls?: RequestClass;
}

export interface WeightsSpec {
  /** Build the one adapter for these weights, with the context it must hold. */
  build: (contextTokens: number) => UnloadableAdapter;
  /** Resident bytes (weights, KV cache, runtime); unknown refuses the load. */
  footprintBytes?: number;
}

/**
 * Where the policy's memory comes from (rule 20g): read before `decide()`
 * into its snapshot, so the decision itself reads nothing.
 */
export interface SwapMemorySource {
  read(view: {
    resident: readonly string[];
    loading: readonly string[];
    footprints: Readonly<Record<string, number | undefined>>;
  }): Promise<SwapMemory>;
}

export interface ResidencySchedulerOptions {
  roles: RoleNeed[];
  weights: Record<string, WeightsSpec>;
  /** Memory the models may occupy together (the footprint check without a policy memory). */
  usableBytes: number;
  /** The residency plan: roles in the order their batches run (the plan's next uses, C2). */
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
  /**
   * Smart Swap's memory probe (rule 20g): when set, every load is admitted
   * by `admitLoad` at that moment, after its evictions, and its
   * `--cache-ram` is sized from the headroom.
   */
  headroom?: HeadroomProbe;
  /** GPU ceilings recorded elsewhere (rule 20g), with those on the ledger; none: the seed. */
  gpuCeilings?: GpuCeiling[];
  /** The load options per weights (rule 20h): the load mode chosen by the A/B. */
  loadOptions?: (weights: string) => LoadOptions | undefined;
  /** The drive check and 256 MB read probe before a load (rule 20h, MD-N14-9). */
  volumeProbe?: VolumeProber;
  /** Smart Swap's parameters (`SwapPolicyParams`); default the recorded defaults. */
  policy?: SwapPolicyParams;
  /** The Worker's queue: the home every absence returns to (C5). Default `worker` when configured. */
  home?: string;
  /** Whether a person is present, and when the reserved hours start (C6). Default: absent. */
  presence?: () => SwapPresence;
  /** The watchdog's level now (rule 19). Default `normal`. */
  watchdogLevel?: () => WatchdogLevel;
  /** The memory `decide()` reads (rule 20g); default the footprints against `usableBytes`. */
  policyMemory?: SwapMemorySource;
  /** Live sessions on some weights, each with its restore and re-prefill time (rule 20i). */
  sessions?: (weights: string) => SessionCost[];
  /** The Worker's parallel slots and the idle each swap leaves per slot (C8). */
  slots?: { n: number; idleMsPerSlot: number };
  /** CPU-side work of queued cards, run while a model loads (C9). */
  overlap?: (loading: string) => void | Promise<void>;
  /** Warm weights into the page cache (C10). */
  prefetch?: (weights: string) => Promise<void>;
  /** Weights became resident or left (C10's warmed bytes are forgotten then). */
  onResidencyChange?: (weights: string, change: "loaded" | "unloaded") => void;
}

/** How `acquire` hands out a model (C8, rule 20f b). */
export interface AcquireOptions {
  /** Wait for a hold to end rather than refuse when only a hold stops the load. */
  waitForHolds?: boolean;
  /** `false`: refuse rather than evict anything (a model only beside what is resident). */
  evict?: boolean;
  /**
   * The hold is a pin only the policy respects, never the watchdog (rule 19):
   * an escalated card's attempt, whose weights the emergency level unloads
   * between its steps.
   */
  yieldsToWatchdog?: boolean;
  /** A person is waiting (Seshat's answer): the swap is interactive, not counted by C7. */
  interactive?: boolean;
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

/** What a queued request says about itself (rule 20d's W, rule 20e's classes). */
export interface SubmitOptions {
  cls?: RequestClass;
  /** Predicted service time (the median), from `serviceMs`. */
  serviceMs?: number;
  /** A review of a finished card (C6). */
  review?: boolean;
}

/** A request's predicted start (the median) and whether it takes rule 20f's quick path. */
export interface PredictedWait {
  queue: string;
  startsAt: number;
  waitMs: number;
  /** The full answer would break the Worker's floor (C5): answer by rule 20f meanwhile. */
  quickPath: boolean;
  /** The rule that decided. */
  rule: SwapAction["rule"];
}

interface Job {
  work: (adapter: UnloadableAdapter) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  meta: SwapRequest;
}

/** One step of the pump: run one queued request, wait out a load it started, or look again. */
type PumpStep =
  | { run: Job; role: string; release: () => void }
  | { loading: string; done: Promise<unknown> }
  | { again: true };

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** A queue's class by its name, unless its need names one. */
export function classOfQueue(queue: string): RequestClass {
  if (/^(chat|seshat|pm|interactive)/.test(queue)) return "interactive";
  if (/^review/.test(queue)) return "reviewer";
  if (/^research/.test(queue)) return "researcher";
  if (/^worker/.test(queue)) return "worker";
  return "planner";
}

export class ResidencyScheduler {
  private readonly adapters = new Map<string, UnloadableAdapter>();
  private readonly queues = new Map<string, Job[]>();
  private readonly resident = new Set<string>();
  private readonly pinned: Set<string>;
  private readonly refused = new Map<string, FootprintRefusal>();
  private readonly footprints = new Map<string, number>();
  /**
   * Weights unloaded without the unload being confirmed (MD-N14-2a): their
   * footprints still count as resident memory until a re-check confirms them.
   */
  private readonly unconfirmed = new Set<string>();
  private readonly checked = new Set<string>();
  private pumping = false;
  private again = false;
  private loads = 0;
  private swaps = 0;
  private active: string | undefined;
  /** Holds on each weights: a held model is never evicted or unloaded. */
  private readonly holds = new Map<string, number>();
  /** Of those, pins only the policy respects: the watchdog's emergency overrides them. */
  private readonly softHolds = new Map<string, number>();
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
  /** `--cache-ram` per weights, sized from the headroom at its admission (rule 20h). */
  private readonly cacheRam = new Map<string, number>();
  // --- Smart Swap's state between boundaries (rule 20e) ---
  private readonly policy: SwapPolicyParams;
  private readonly residentAt = new Map<string, number>();
  private readonly lastServed = new Map<string, number>();
  private readonly running = new Map<string, number>();
  private readonly prefetched = new Set<string>();
  private readonly prefetching = new Set<string>();
  private overThreshold: string[] = [];
  private tour: string[] = [];
  private plan: string[] | undefined;
  private benchmark: string | undefined;
  private homeBacklogFlag: boolean | undefined;
  private swapLog: SwapHistoryEntry[] = [];
  private absences: { from: number; to?: number }[] = [];
  private barrier: { waiters: (() => void)[] } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private decision: SwapAction | undefined;
  private loadGuard: ((weights: string) => void | Promise<void>) | undefined;
  /** Acquires waiting at the drain barrier for running steps to end (C8). */
  private draining = 0;
  /** Steps waiting for the drain barrier to lower. */
  private stepWaiters: (() => void)[] = [];
  /** Acquires waiting for a step to end, or for a hold to be released. */
  private stepEnded: (() => void)[] = [];
  private holdReleased: (() => void)[] = [];
  /** The headroom as the policy reads it (rule 20g), when a probe is set. */
  private readonly headroomMemory: SwapMemorySource | undefined;

  constructor(private readonly options: ResidencySchedulerOptions) {
    this.pinned = new Set(options.pinned ?? []);
    this.policy = options.policy ?? DEFAULT_SWAP_POLICY;
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
    if (options.order) this.setPlanFromRoles(options.order);
    this.headroomMemory = options.headroom
      ? headroomSwapMemory({
          probe: options.headroom,
          ceilings: () => [...(options.gpuCeilings ?? []), ...this.cost.ceilings],
          now: this.now,
        })
      : undefined;
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
      adapter.onSignal?.((s) => void this.onSignal(key, s));
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  private readonly now = (): number => (this.options.now ?? Date.now)();

  /**
   * An engine's signal (rules 20g, 20h): a Metal command-buffer timeout
   * records the combined GPU footprint resident now as the host's ceiling
   * (MD-N14-33); a model Ollama serves requantised is recorded and flagged.
   */
  private async onSignal(key: string, s: ModelSignal): Promise<void> {
    if (s.kind === "metal_timeout") {
      const resident = [...new Set([key, ...this.resident, ...this.loading.keys()])].map((k) => ({
        weights: k,
        footprintBytes: this.footprints.get(k) ?? 0,
      }));
      // The model that timed out, then the others, in residency order.
      resident.sort((a, b) => (a.weights === key ? -1 : b.weights === key ? 1 : 0));
      const ceiling = metalTimeoutCeiling(resident);
      await this.cost.gpuCeiling(ceiling);
      this.options.log?.(
        `residency: a Metal timeout with ${ceiling.models?.join(" + ")} resident; ${(ceiling.bytes / 1e9).toFixed(2)} GB is now this host's GPU ceiling`,
      );
      return;
    }
    await this.cost.requantised({
      model: key,
      ...(s.servedQuant ? { servedQuant: s.servedQuant } : {}),
      ...(s.fileQuant ? { fileQuant: s.fileQuant } : {}),
      hashDiffers: s.hashDiffers,
    });
    this.options.log?.(`residency: ${s.reason}`);
  }

  /**
   * Time the first reply after a recorded load (MD-N14-2): from the
   * request's start to its first streamed token, or to the reply when it
   * does not stream. Later replies' first tokens are kept in memory as the
   * steady state C_pair's first-token excess is measured against (rule 20d).
   * The adapter keeps its identity; only `generate` is wrapped.
   */
  private timeFirstReply(key: string, adapter: UnloadableAdapter): void {
    const original = adapter.generate.bind(adapter);
    adapter.generate = async (req: InferenceRequest) => {
      const afterLoad = this.firstReplyDue.delete(key);
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
      const firstTokenMs = first ?? this.now() - start;
      if (afterLoad)
        await this.cost.firstToken({ model: key, roles: this.rolesOf(key), firstTokenMs });
      else this.cost.warmFirstToken(key, firstTokenMs);
      return response;
    };
  }

  /** The weights' file, bytes and volume (read once); undefined when the adapter cannot say. */
  private async sourceOf(
    key: string,
  ): Promise<{ path: string; bytes: number; volume: Volume } | undefined> {
    if (!this.sources.has(key)) {
      const role = this.rolesOf(key)[0];
      let found: { path: string; bytes: number } | undefined;
      try {
        found = role
          ? await this.adapterFor(role)
              .weightsSource?.()
              .catch(() => undefined)
          : undefined;
      } catch {
        found = undefined;
      }
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

  /**
   * Unload `key`, prove the weights left (MD-N14-2a: the adapter polls,
   * within its bound) and record it (MD-N14-2). An unload not confirmed
   * keeps counting as resident memory until a re-check confirms it.
   */
  private async unloadRecorded(key: string): Promise<boolean> {
    const adapter = this.adapters.get(key);
    const start = this.now();
    await adapter?.unload?.();
    // A short bound here; a server still listing the weights is re-checked,
    // without waiting, at every later admission (`stillUnconfirmed`).
    const confirmed = (await adapter?.confirmUnloaded?.(UNLOAD_CONFIRM_MS)) ?? true;
    if (confirmed) this.unconfirmed.delete(key);
    else this.unconfirmed.add(key);
    const unloadMs = this.now() - start;
    this.firstReplyDue.delete(key);
    this.prefetched.delete(key);
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
    // Rule 20h: the drive checked before the load, the volume probed once (MD-N14-9, MD-N14-35).
    const probe =
      source && this.options.volumeProbe
        ? await this.options.volumeProbe.probe(source.path, source.volume)
        : undefined;
    if (probe?.state === "disconnected")
      throw new DriveUnavailableError(`Refusing to load ${key}: ${probe.reason}`);
    const base = source
      ? this.cost.book.predict({
          model: key,
          volume: source.volume,
          cache: this.cost.cacheState(key, source.bytes),
          bytes: source.bytes,
        })
      : undefined;
    const prediction = base
      ? predictWithProbe(
          base,
          this.cost.book,
          probe?.bytesPerSecond !== undefined
            ? {
                bytesPerSecond: probe.bytesPerSecond,
                ...(probe.spinUpMs ? { spinUpMs: probe.spinUpMs } : {}),
              }
            : undefined,
        )
      : undefined;
    const loadOptions: LoadOptions = {
      ...this.options.loadOptions?.(key),
      ...(this.cacheRam.has(key) ? { cacheRamMiB: this.cacheRam.get(key) as number } : {}),
    };
    const pressure = this.options.pressureLevel ?? readKernelPressureLevel;
    const before = pressure();
    const start = this.now();
    const outcome = await adapter.load(signal, loadOptions);
    if (signal.aborted) throw new LoadAbortedError(`The load of ${key} was aborted`);
    const loadMs = this.now() - start;
    if (outcome === "adopted" || !prediction) return;
    const after = pressure();
    const levels = [before, after].filter((l): l is number => l !== undefined);
    // MD-N14-10: the cache state measured by the load's read rate, where a cold rate is known.
    const cold = this.cost.book.readRate(prediction.volume);
    const coldRate = cold.basis === "measured" ? cold.bytesPerSecond : probe?.bytesPerSecond;
    await this.cost.loaded({
      prediction,
      roles: this.rolesOf(key),
      loadMs,
      pressureLevel: levels.length ? Math.max(...levels) : undefined,
      ...(adapter.engine ? { engine: adapter.engine } : {}),
      ...(adapter.engine === "llama.cpp" ? { loadMode: loadOptions.loadMode ?? "mmap" } : {}),
      ...(coldRate !== undefined
        ? {
            cache: classifyCacheByReadRate({
              bytes: prediction.bytes,
              loadMs,
              coldBytesPerSecond: coldRate,
            }),
          }
        : {}),
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
      await this.unloadRecorded(key);
      this.markGone(key);
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

  /** Whether a hold the watchdog respects (a person's, a request's) pins these weights. */
  private isHardHeld(key: string): boolean {
    return (this.holds.get(key) ?? 0) > (this.softHolds.get(key) ?? 0);
  }

  /** Whether the watchdog's emergency may unload these weights now (rule 19). */
  private watchdogMayUnload(key: string): boolean {
    if (!this.isHeld(key)) return true;
    return !this.isHardHeld(key) && (this.running.get(key) ?? 0) === 0;
  }

  private takeHold(key: string, soft = false): () => void {
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    if (soft) this.softHolds.set(key, (this.softHolds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(key) ?? 1) - 1;
      if (n > 0) this.holds.set(key, n);
      else this.holds.delete(key);
      if (soft) {
        const k = (this.softHolds.get(key) ?? 1) - 1;
        if (k > 0) this.softHolds.set(key, k);
        else this.softHolds.delete(key);
      }
      this.lastServed.set(key, this.now());
      for (const w of this.holdReleased.splice(0)) w();
      // A step boundary: work that waited on the memory is tried again.
      if (this.waitingRoles().length > 0 || this.barrier) this.schedule();
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
   * (MD-N9-4): what may be evicted is chosen by `decide()`'s eviction rule
   * (never a pinned or held model), each eviction proven, under the one
   * lock. Throws a `FootprintRefusal` when it cannot fit beside what is
   * held, a `SwapHeadroomError` when an eviction was not proven, a
   * `ModelUnavailableError` when unhealthy.
   */
  public async acquire(role: string, opts: AcquireOptions = {}): Promise<ModelHold> {
    const key = this.need(role).weights;
    // A load this acquire started is held from the moment it is resident, so
    // no other acquire evicts it before it is handed out.
    let held: (() => void) | undefined;
    let draining = false;
    const stopDraining = () => {
      if (!draining) return;
      draining = false;
      this.draining--;
      if (this.draining === 0 && !this.barrier) this.releaseSteps();
    };
    try {
      for (;;) {
        const step = await this.exclusive(() => this.handOut(role, key, held, opts));
        if ("drain" in step) {
          // C8: no new step starts until the running ones reach their boundary.
          if (!draining) {
            draining = true;
            this.draining++;
          }
          await step.drain;
          continue;
        }
        stopDraining();
        if ("hold" in step) return step.hold;
        // The load runs outside the lock; its failure or abort is this caller's.
        const took = await step.wait;
        if (typeof took === "function") held = took as () => void;
      }
    } catch (err) {
      stopDraining();
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
    opts: AcquireOptions,
  ): Promise<{ hold: ModelHold } | { wait: Promise<unknown> } | { drain: Promise<void> }> {
    if (!this.resident.has(key)) {
      const busy = this.inFlight(key);
      if (busy) return { wait: busy };
      // Rule 20e (the watchdog, rule 19): at critical or higher no load starts;
      // the caller waits for the level to fall.
      if (this.watchdogBlocksLoads())
        return {
          wait: new Promise<void>((r) => setTimeout(r, this.options.pollMs ?? 1000)),
        };
      const plan = planLoad(await this.snapshot(), key, this.now());
      if (!plan.ok) {
        // A hold, not the room, stops it: wait for a hold to end when asked.
        if (plan.hold && opts.waitForHolds)
          return { wait: new Promise<void>((r) => this.holdReleased.push(r)) };
        throw new FootprintRefusal(plan.reason);
      }
      if (opts.evict === false && plan.evict.length > 0)
        throw new FootprintRefusal(
          `Refusing to load ${key} beside what is resident: it would evict ${plan.evict.join(", ")}; the work stays queued.`,
        );
      // C8: never preempt a step; the swap waits for every running step's boundary.
      if (plan.evict.some((e) => (this.running.get(e) ?? 0) > 0))
        return { drain: new Promise<void>((r) => this.stepEnded.push(r)) };
      const need = this.need(role);
      const interactive = opts.interactive ?? (need.cls ?? classOfQueue(role)) === "interactive";
      const started = await this.startLoad(key, plan.evict, {
        holdWhenResident: true,
        softHold: opts.yieldsToWatchdog === true,
        interactive,
        roundTrip: !interactive && plan.evict.length > 0 && key !== this.homeWeights(),
      });
      return { wait: started.done };
    }
    const adapter = this.adapterFor(role);
    await this.checkHealth(role, key, adapter);
    this.active = role;
    return {
      hold: { role, adapter, release: held ?? this.takeHold(key, opts.yieldsToWatchdog === true) },
    };
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

  /** Queue work for a role; it runs once `decide()` has its weights resident. */
  public submit<T>(
    role: string,
    work: (adapter: UnloadableAdapter) => Promise<T>,
    opts: SubmitOptions = {},
  ): Promise<T> {
    const need = this.need(role);
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(role) ?? [];
      queue.push({
        work: work as Job["work"],
        resolve: resolve as Job["resolve"],
        reject,
        meta: this.requestMeta(role, need, opts),
      });
      this.queues.set(role, queue);
      this.schedule();
    });
  }

  /**
   * Queue a request for a role's model and, once `decide()` serves it, hold
   * the model for the caller until it releases the hold (MD-N9-4): a flow of
   * several requests (a batch of plans, a Seshat answer, a batch of research
   * questions) is one queued request, so C1–C7 decide when it is served, and
   * nothing evicts the model mid-flow. The pump is not blocked meanwhile.
   */
  public submitHold(
    role: string,
    opts: SubmitOptions & { yieldsToWatchdog?: boolean } = {},
  ): Promise<ModelHold> {
    const key = this.need(role).weights;
    return this.submit(
      role,
      async (adapter) => {
        // Taken before the pump's own hold on this request is released: no gap.
        const release = this.takeHold(key, opts.yieldsToWatchdog === true);
        try {
          await this.checkHealth(role, key, adapter);
        } catch (err) {
          release();
          throw err;
        }
        return { role, adapter, release } satisfies ModelHold;
      },
      opts,
    );
  }

  /** A model's health, once per residency (M4); unhealthy weights are marked gone. */
  private async checkHealth(role: string, key: string, adapter: UnloadableAdapter): Promise<void> {
    if (this.options.healthCheck === false || !adapter.healthCheck || this.checked.has(key)) return;
    const health = await adapter.healthCheck();
    this.options.log?.(
      `health ${role} ${health.modelId}: ${health.ok ? "ok" : "UNAVAILABLE"}${health.detail ? ` (${health.detail})` : ""}`,
    );
    if (!health.ok) {
      this.markGone(key);
      throw new ModelUnavailableError(role, health);
    }
    this.checked.add(key);
  }

  private requestMeta(role: string, need: RoleNeed, opts: SubmitOptions): SwapRequest {
    return {
      id: `${role}#${++this.seq}`,
      cls: opts.cls ?? need.cls ?? classOfQueue(role),
      queuedAt: this.now(),
      serviceMs: opts.serviceMs ?? 0,
      ...(opts.review ? { review: true } : {}),
    };
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

  // --- Smart Swap's inputs and outputs (rule 20e) -----------------------------

  /** The plan's next uses, as queues in order (C2's tours and Belady eviction). */
  public setPlan(queues: readonly string[]): void {
    this.setPlanFromRoles(queues);
    this.schedule();
  }

  private setPlanFromRoles(queues: readonly string[]): void {
    const weights: string[] = [];
    for (const q of queues) {
      const w = this.options.roles.find((r) => r.role === q)?.weights ?? q;
      if (!weights.includes(w)) weights.push(w);
    }
    this.plan = weights;
  }

  /** Whether the Worker has work beyond its queue (a card in progress), for C5; undefined: its queue says. */
  public setHomeBacklog(on: boolean | undefined): void {
    this.homeBacklogFlag = on;
    this.schedule();
  }

  /**
   * An overnight benchmark block (rule 20b, MD-N14-40): its weights are
   * swapped in once at its start and C1–C10 do not apply inside it; the
   * watchdog still does. `undefined` ends the block.
   */
  public benchmarkBlock(queue: string | undefined): void {
    this.benchmark = queue === undefined ? undefined : this.need(queue).weights;
    this.schedule();
  }

  /**
   * A check before every load (a calibration night's DEC-42 host limits,
   * measurement MS-NM14-3): it throws a `FootprintRefusal` to refuse, and
   * the work stays queued. `undefined` removes it.
   */
  public setLoadGuard(guard: ((weights: string) => void | Promise<void>) | undefined): void {
    this.loadGuard = guard;
  }

  /** A step boundary: look at the queues again. */
  public boundary(): void {
    this.schedule();
  }

  /**
   * Begin one step on a queue's weights (a slot, RUN-35). No step is admitted
   * while a decided swap waits at the drain barrier (C8); the returned
   * function ends the step, which is a step boundary.
   */
  public async beginStep(queue: string): Promise<() => void> {
    const key = this.need(queue).weights;
    while (this.barrier || this.draining > 0) {
      await new Promise<void>((r) => this.stepWaiters.push(r));
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const n = (this.running.get(key) ?? 1) - 1;
      if (n > 0) this.running.set(key, n);
      else this.running.delete(key);
      this.lastServed.set(key, this.now());
      for (const w of this.stepEnded.splice(0)) w();
      this.schedule();
    };
  }

  /** Steps running on these weights now (RUN-35 slots). */
  public runningSteps(queue: string): number {
    return this.running.get(this.need(queue).weights) ?? 0;
  }

  /** The plan's next uses as weights, in order (C2, Belady); empty without one. */
  public get plannedWeights(): string[] {
    return [...(this.plan ?? [])];
  }

  private lowerBarrier(): void {
    this.barrier = undefined;
    if (this.draining === 0) this.releaseSteps();
  }

  private releaseSteps(): void {
    for (const w of this.stepWaiters.splice(0)) w();
  }

  /** The last decision the pump applied. */
  public get lastDecision(): SwapAction | undefined {
    return this.decision;
  }

  /**
   * When a request on `queue` would start (the median, MD-N14-8) and whether
   * its full answer takes the quick path (C5, rule 20f). Loads nothing.
   */
  public async predictWait(
    queue: string,
    opts: SubmitOptions & {
      /** The Worker is mid-card although its queue here is empty (the runner's step boundary). */
      homeBacklog?: boolean;
    } = {},
  ): Promise<PredictedWait> {
    const need = this.need(queue);
    const probe = { ...this.requestMeta(queue, need, opts), id: `${queue}#predict` };
    const snapshot = await this.snapshot();
    if (opts.homeBacklog !== undefined && snapshot.home !== undefined)
      snapshot.homeBacklog = opts.homeBacklog;
    const existing = snapshot.queues.find((q) => q.queue === queue);
    if (existing) existing.requests.push(probe);
    else snapshot.queues.push({ queue, weights: need.weights, requests: [probe] });
    const now = this.now();
    const action = decide(snapshot, now);
    const startsAt = action.starts[probe.id] ?? now;
    return {
      queue,
      startsAt,
      waitMs: Math.max(0, startsAt - now),
      quickPath: action.quickPath.includes(probe.id),
      rule: action.rule,
    };
  }

  /** The GPU ceilings in force: the configured ones and those recorded on the ledger (rule 20g). */
  public async gpuCeilings(): Promise<GpuCeiling[]> {
    await this.cost.ready();
    return [...(this.options.gpuCeilings ?? []), ...this.cost.ceilings];
  }

  /** θ, the caps with their feasibility, the placement notice, the storm count and the Worker's floor. */
  public async status(): Promise<ReturnType<typeof swapStatus> & { policy: SwapPolicyParams }> {
    return { ...swapStatus(await this.snapshot(), this.now()), policy: this.policy };
  }

  /** The policy's parameters in force (recorded in each evidence bundle and `RunProfile`). */
  public get swapPolicy(): SwapPolicyParams {
    return this.policy;
  }

  private homeWeights(): string | undefined {
    const queue = this.options.home ?? (this.has("worker") ? "worker" : undefined);
    return queue !== undefined && this.has(queue) ? this.need(queue).weights : undefined;
  }

  private homeBacklog(home: string | undefined): boolean {
    if (home === undefined) return false;
    if (this.homeBacklogFlag !== undefined) return this.homeBacklogFlag;
    return (this.running.get(home) ?? 0) > 0 || this.rolesOf(home).some((r) => this.waiting(r) > 0);
  }

  /** Open or close the Worker's current absence (C5 counts it while the Worker has work). */
  private trackAbsence(): void {
    const home = this.homeWeights();
    const open = this.absences.at(-1);
    const away = home !== undefined && !this.resident.has(home) && this.homeBacklog(home);
    const now = this.now();
    if (away && !(open && open.to === undefined)) this.absences.push({ from: now });
    if (!away && open && open.to === undefined) open.to = now;
    const cutoff = now - this.policy.windowMs;
    this.absences = this.absences.filter((a) => a.to === undefined || a.to > cutoff);
    this.swapLog = this.swapLog.filter((x) => x.at + x.ms > cutoff);
  }

  /** The footprints against usable memory: the policy's memory without a source (MD-N9-3). */
  private footprintMemory(): SwapMemory {
    const usable = this.options.usableBytes;
    const oneAtATime = this.options.coResident === false;
    const bytesOf = (keys: readonly string[]) =>
      keys.reduce((n, k) => n + (this.footprints.get(k) ?? 0), 0);
    return {
      admit: ({ load, evict, resident }) => {
        const who = `the ${this.rolesOf(load).join("/")} model ${load}`;
        const need = this.footprints.get(load);
        if (need === undefined)
          return {
            ok: false,
            reason: `Refusing to load ${who}: the footprint of ${load} is unknown, so it cannot be shown to fit ${gb(usable)} usable; the work stays queued.`,
          };
        const keep = resident.filter((k) => k !== load && !evict.includes(k));
        const kept = bytesOf(keep);
        if (kept + need <= usable && !(oneAtATime && keep.length > 0)) return { ok: true };
        const held = keep.length ? `${gb(kept)} resident (${keep.join(", ")})` : "nothing resident";
        return {
          ok: false,
          reason: `Refusing to load ${who}: ${held} + ${gb(need)} (${load}) exceeds ${gb(usable)} usable${oneAtATime && keep.length ? ", and this tier holds one model at a time" : ""}; the work stays queued.`,
        };
      },
    };
  }

  /**
   * The weights whose unload is still unconfirmed after one more look
   * (MD-N14-2a): each is asked again, without waiting, and those now gone
   * are forgotten.
   */
  private async stillUnconfirmed(): Promise<string[]> {
    for (const key of [...this.unconfirmed]) {
      if (this.resident.has(key) || this.loading.has(key)) {
        this.unconfirmed.delete(key);
        continue;
      }
      const gone = (await this.adapters.get(key)?.confirmUnloaded?.(0)) ?? true;
      if (gone) this.unconfirmed.delete(key);
    }
    return [...this.unconfirmed];
  }

  /** The memory with every unconfirmed unload still counted as resident and never evicted. */
  private async withUnconfirmed(memory: SwapMemory): Promise<SwapMemory> {
    const lingering = await this.stillUnconfirmed();
    if (lingering.length === 0) return memory;
    const also = (resident: readonly string[], load?: string) => [
      ...resident,
      ...lingering.filter((k) => k !== load && !resident.includes(k)),
    ];
    const tour = memory.tour?.bind(memory);
    return {
      ...memory,
      admit: (step) => memory.admit({ ...step, resident: also(step.resident, step.load) }),
      ...(tour ? { tour: (steps, resident) => tour(steps, also(resident)) } : {}),
    };
  }

  /**
   * Everything `decide()` reads, taken now (rule 20e): the reads happen here
   * (the ledger's history, each weights' file, the memory), never in it.
   */
  private async snapshot(): Promise<SwapSnapshot> {
    await this.cost.ready();
    this.trackAbsence();
    const home = this.homeWeights();
    const relevant = new Set<string>([
      ...this.resident,
      ...this.loading.keys(),
      ...(home !== undefined ? [home] : []),
      ...(this.plan ?? []),
      ...this.waitingRoles().map((r) => this.need(r).weights),
      ...(this.benchmark !== undefined ? [this.benchmark] : []),
    ]);
    const weights: Record<string, SwapWeightsState> = {};
    for (const key of Object.keys(this.options.weights)) {
      const state: SwapWeightsState = {};
      if (relevant.has(key)) {
        const source = await this.sourceOf(key);
        const p = source
          ? this.cost.book.predict({
              model: key,
              volume: source.volume,
              cache: this.cost.cacheState(key, source.bytes),
              bytes: source.bytes,
            })
          : undefined;
        if (p) {
          state.load = { median: p.medianMs, p90: p.p90Ms };
          state.fileBytes = p.bytes;
          const unload = this.cost.book.unloadCost(key);
          if (unload) state.unload = unload;
          const excess = this.cost.book.firstTokenExcess(key);
          if (excess !== undefined) state.firstTokenExcessMs = excess;
        }
        const sessions = this.options.sessions?.(key);
        if (sessions?.length) state.sessions = sessions;
      }
      const since = this.residentAt.get(key);
      if (this.resident.has(key) && since !== undefined) state.residentSince = since;
      if (this.loading.has(key)) state.loading = true;
      const served = this.lastServed.get(key);
      if (served !== undefined) state.lastServedAt = served;
      if (this.isHeld(key)) state.held = true;
      if (this.isHeld(key) && !this.isHardHeld(key)) state.holdYieldsToWatchdog = true;
      if (this.isPinned(key)) state.pinned = true;
      if (this.prefetched.has(key)) state.prefetched = true;
      const running = this.running.get(key);
      if (running) state.runningSteps = running;
      weights[key] = state;
    }
    const queues = [...this.queues.entries()]
      .filter(([, q]) => q.length > 0)
      .map(([queue, q]) => ({
        queue,
        weights: this.need(queue).weights,
        requests: q.map((j) => ({ ...j.meta })),
      }));
    const source = this.options.policyMemory ?? this.headroomMemory;
    const read = source
      ? await source.read({
          resident: [...this.resident],
          loading: [...this.loading.keys()],
          footprints: Object.fromEntries(
            Object.keys(this.options.weights).map((k) => [k, this.footprints.get(k)]),
          ),
        })
      : this.footprintMemory();
    const memory = await this.withUnconfirmed(read);
    return {
      params: this.policy,
      ...(home !== undefined ? { home, homeBacklog: this.homeBacklog(home) } : {}),
      weights,
      queues,
      watchdog: this.options.watchdogLevel?.() ?? "normal",
      presence: this.options.presence?.() ?? { present: false },
      ...(this.plan ? { plan: [...this.plan] } : {}),
      swaps: this.swapLog.map((x) => ({ ...x })),
      homeAbsences: this.absences.map((a) => ({ ...a })),
      overThreshold: [...this.overThreshold],
      tour: [...this.tour],
      ...(this.options.slots ? { slots: this.options.slots } : {}),
      memory,
      ...(this.benchmark !== undefined ? { benchmark: { weights: this.benchmark } } : {}),
    };
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
        // A person's hold and a step mid-step stay; an escalated attempt's
        // hold (a pin only the policy respects) yields between its steps.
        if (!this.watchdogMayUnload(key)) continue;
        await this.unloadRecorded(key);
        this.markGone(key);
      }
      this.active = undefined;
      this.tour = [];
    });
  }

  private markGone(key: string): void {
    const was = this.resident.has(key);
    this.resident.delete(key);
    this.residentAt.delete(key);
    this.checked.delete(key);
    this.prefetched.delete(key);
    if (was) this.options.onResidencyChange?.(key, "unloaded");
  }

  /** Rule 20e: at the watchdog's critical level or higher no load starts. */
  private watchdogBlocksLoads(): boolean {
    const level = this.options.watchdogLevel?.() ?? "normal";
    return level === "critical" || level === "emergency";
  }

  /**
   * When to look again with nothing else happening: `until`, and while the
   * watchdog stops loads with work waiting, the next poll (its level falling
   * notifies no one).
   */
  private lookAgainAt(until: number | undefined): number | undefined {
    if (!this.watchdogBlocksLoads() || this.waitingRoles().length === 0) return until;
    const poll = this.now() + (this.options.pollMs ?? 1000);
    return until === undefined ? poll : Math.min(until, poll);
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
      this.markGone(key);
      await capped(this.adapters.get(key)?.unload?.() ?? Promise.resolve());
      this.options.log?.(`residency: the load of ${key} was aborted`);
    }
  }

  private waitingRoles(): string[] {
    return [...this.queues.entries()].filter(([, q]) => q.length > 0).map(([role]) => role);
  }

  private schedule(): void {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    // A macrotask: work submitted in the same turn is batched before any load.
    setImmediate(() => {
      void this.pump()
        .catch((err) => {
          this.options.log?.(`residency: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          this.pumping = false;
          if (this.again) {
            this.again = false;
            this.schedule();
          }
        });
    });
  }

  /** Look again at `until` even if nothing happens (a hold's end, the storm cap freeing). */
  private wakeAt(until: number | undefined): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (until === undefined) return;
    this.timer = setTimeout(() => this.schedule(), Math.max(0, until - this.now()));
    this.timer.unref?.();
  }

  private startPrefetch(weights: string): void {
    const warm = this.options.prefetch;
    if (!warm || this.prefetching.has(weights) || this.prefetched.has(weights)) return;
    this.prefetching.add(weights);
    void warm(weights)
      .then(() => {
        this.prefetched.add(weights);
      })
      .catch((err) => {
        this.options.log?.(
          `residency: prefetching ${weights} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        this.prefetching.delete(weights);
      });
  }

  /** Under the one lock: take a snapshot, decide, and apply the action. */
  private async step(): Promise<PumpStep | undefined> {
    const snapshot = await this.snapshot();
    const action = decide(snapshot, this.now());
    this.decision = action;
    this.overThreshold = action.memo.overThreshold;
    for (const r of action.refused) this.refuse(r.weights, r.reason);
    switch (action.kind) {
      case "keep": {
        if (action.prefetch !== undefined) this.startPrefetch(action.prefetch);
        if (this.barrier) this.lowerBarrier();
        if (action.serve === undefined) {
          this.wakeAt(this.lookAgainAt(action.until));
          return undefined;
        }
        const job = this.queues.get(action.serve)?.shift();
        if (!job) return undefined;
        return {
          run: job,
          role: action.serve,
          release: this.takeHold(this.need(action.serve).weights),
        };
      }
      case "swap": {
        if (action.barrier) {
          // C8: no new step until every slot is at its boundary; each step's end looks again.
          this.barrier ??= { waiters: [] };
          return undefined;
        }
        const home = this.homeWeights();
        this.tour =
          action.load === home ? [] : action.tour.slice(action.tour.indexOf(action.load) + 1);
        // C8: no step starts on weights being evicted; lowered once the load starts.
        if (action.evict.length > 0) this.barrier ??= { waiters: [] };
        const started = await this.load(action.load, action.evict, action);
        if (this.barrier) this.lowerBarrier();
        return started ? { loading: action.load, done: started.done } : undefined;
      }
      case "unload": {
        // C8: no swap waits at the barrier any more.
        if (this.barrier) this.lowerBarrier();
        for (const w of action.weights) {
          if (!this.resident.has(w)) continue;
          // Only the watchdog's emergency passes an escalated attempt's hold.
          if (action.rule === "watchdog" ? !this.watchdogMayUnload(w) : this.isHeld(w)) continue;
          await this.unloadRecorded(w);
          this.markGone(w);
          this.options.log?.(`residency: unloaded ${w} (${action.rule}: ${action.reason})`);
        }
        return { again: true };
      }
      case "prefetch":
        if (this.barrier) this.lowerBarrier();
        this.startPrefetch(action.weights);
        return undefined;
      case "wait":
        // C8: the swap the barrier waited for is not being made now (memory,
        // a hold, C5 or C7 stopped it): the steps resume.
        if (this.barrier) this.lowerBarrier();
        this.wakeAt(this.lookAgainAt(action.until));
        return undefined;
    }
  }

  private async pump(): Promise<void> {
    let unloads = 0;
    for (;;) {
      const step = await this.exclusive(() => this.step());
      if (step === undefined) return;
      if ("again" in step) {
        // An unload is applied, then the queues are looked at again (a bounded number of times).
        if (++unloads > 8) return;
        continue;
      }
      if ("done" in step) {
        // The load runs outside the lock; then the queues are looked at again.
        // An aborted load (the watchdog's unload) is not retried at once.
        if (await this.settleQueued(step.loading, step.done)) continue;
        return;
      }
      this.active = step.role;
      try {
        step.run.resolve(await step.run.work(this.adapterFor(step.role)));
      } catch (err) {
        step.run.reject(err);
      } finally {
        step.release();
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
  private async load(
    key: string,
    evict: readonly string[],
    action: { interactive: boolean; roundTrip: boolean },
  ): Promise<{ done: Promise<unknown> } | false> {
    try {
      return await this.startLoad(key, evict, {
        holdWhenResident: false,
        softHold: false,
        interactive: action.interactive,
        roundTrip: action.roundTrip,
      });
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
      // Rule 20h: a disconnected drive keeps the work queued, saying why.
      if (err instanceof DriveUnavailableError) {
        this.refuse(key, err.message);
        return false;
      }
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
   * Start loading `key` after evicting what `decide()` chose. Called only
   * under the one lock, with no load in flight; the evictions happen under
   * it, then the footprint is reserved and the load runs outside it (`done`),
   * while the CPU-side work of queued cards runs (C9).
   */
  private async startLoad(
    key: string,
    evict: readonly string[],
    opts: {
      holdWhenResident: boolean;
      softHold: boolean;
      interactive: boolean;
      roundTrip: boolean;
    },
  ): Promise<{ done: Promise<(() => void) | undefined> }> {
    const roles = this.rolesOf(key);
    const need = this.footprints.get(key);
    const began = this.now();
    for (const leaving of evict) await this.evict(leaving, key);
    // DEC-42's host check reads the memory as the load will find it: after
    // the evictions (a calibration night, MS-NM14-3).
    await this.loadGuard?.(key);
    if (evict.length > 0) this.swaps++;
    this.trackAbsence();
    // Rule 20g: admitted by the headroom read now, after the evictions (MD-N14-31–33a).
    if (this.options.headroom) {
      await this.cost.ready();
      const verdict = admitLoad({
        reading: await this.options.headroom.read(),
        candidate: { weights: key, footprintBytes: need },
        resident: [
          ...new Set([
            ...this.resident,
            ...this.loading.keys(),
            ...(await this.stillUnconfirmed()),
          ]),
        ]
          .filter((k) => k !== key)
          .map((k) => ({ weights: k, footprintBytes: this.footprints.get(k) ?? 0 })),
        now: this.now(),
        // The ceilings recorded on Metal timeouts, with the configured ones (MD-N14-33).
        ceilings: gpuCeilingsFrom([...(this.options.gpuCeilings ?? []), ...this.cost.ceilings]),
      });
      if (verdict.verdict !== "admit") throw new FootprintRefusal(verdict.reason);
      if (need !== undefined)
        this.cacheRam.set(key, cacheRamMiBFromHeadroom(verdict.headroom.bytes, need));
    }
    this.adapterFor(roles[0] as string);
    const controller = new AbortController();
    const entry: { controller: AbortController; done: Promise<(() => void) | undefined> } = {
      controller,
      done: Promise.resolve(undefined),
    };
    this.loading.set(key, entry);
    if (this.options.overlap) {
      void Promise.resolve()
        .then(() => this.options.overlap?.(key))
        .catch((err) => {
          this.options.log?.(
            `residency: overlap work failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
    entry.done = (async () => {
      try {
        await this.loadRecorded(key, controller.signal);
        if (controller.signal.aborted) throw new LoadAbortedError(`The load of ${key} was aborted`);
        this.resident.add(key);
        this.residentAt.set(key, this.now());
        this.prefetched.delete(key);
        this.options.onResidencyChange?.(key, "loaded");
        this.loads++;
        for (const role of roles) this.refused.delete(role);
        this.options.log?.(`residency: ${key} resident for ${roles.join(", ")}`);
        if (evict.length > 0) await this.recordSwap(began, evict, key, opts);
        this.trackAbsence();
        return opts.holdWhenResident ? this.takeHold(key, opts.softHold) : undefined;
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

  /** A swap enters the rolling hour, and θ is recorded with the policy's parameters (MD-N14-12). */
  private async recordSwap(
    began: number,
    evict: readonly string[],
    to: string,
    opts: { interactive: boolean; roundTrip: boolean },
  ): Promise<void> {
    const now = this.now();
    this.swapLog.push({
      at: began,
      ms: Math.max(0, now - began),
      to,
      ...(evict[0] !== undefined ? { from: evict[0] } : {}),
      interactive: opts.interactive,
      roundTrip: opts.roundTrip,
    });
    const window = this.policy.windowMs;
    const inWindow = this.swapLog.filter((x) => x.at + x.ms > now - window);
    const th = theta(inWindow, now, window);
    const payload: SwapOverheadPayload = {
      theta: th,
      windowMs: window,
      swapMs: Math.round(th * window),
      swaps: inWindow.length,
      placementNotice: th > this.policy.thetaMax,
      policyVersion: this.policy.version,
      params: flattenSwapPolicy(this.policy),
    };
    try {
      await this.options.swapCost?.record?.({ type: SWAP_OVERHEAD_EVENT, payload });
    } catch (err) {
      this.options.log?.(
        `swap cost: could not record ${SWAP_OVERHEAD_EVENT} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /**
   * Unload `victim` and prove it: the unload is confirmed and memory pressure
   * is back to normal before `next` loads. An unload request is not an unload.
   * Called only under the one lock, from `startLoad`.
   */
  private async evict(victim: string, next: string): Promise<void> {
    const confirmed = await this.unloadRecorded(victim);
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
    this.markGone(victim);
  }
}
