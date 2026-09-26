import type { EventLog } from "@sekhemet/kernel";
import {
  CO_RESIDENT_MIN_BYTES,
  FootprintRefusal,
  type GpuCeiling,
  type HeadroomProbe,
  type LoadOptions,
  ManagedLlamaServerAdapter,
  type ModelHold,
  type ModelRegistry,
  type ModelRole,
  ModelRoster,
  type PageCacheWarmer,
  type RequestClass,
  ResidencyScheduler,
  type ResolveOptions,
  SWAP_EVENTS,
  type SwapEvent,
  type SwapPresence,
  UNFILLED,
  type UnloadableAdapter,
  type VolumeProber,
  type WatchdogLevel,
  admitLoad,
  currentAssignment,
  gpuCeilingsFrom,
  hostFingerprintHash,
  isManagedModelName,
  loadHostMachineProfile,
  measureUsableMemory,
  pageCacheWarmer,
  resolveWorkerModelId,
  tierSettingsOf,
  withMeasurementRun,
} from "@sekhemet/models";
import { type Zone3Card, workerPromptBudget, zone3Fit } from "@sekhemet/planner";
import { defaultWorkerName } from "./config_apply.js";

/**
 * The harness's one path to a model (models rule 20a, MD-N9-4).
 *
 * Every caller that needs a model to serve a role — the queue, `run`, the
 * PM's chat, the dashboard, the Researcher, a retry — asks a `ModelAccess`,
 * which is the residency scheduler (`ResidencyScheduler`) over the roster:
 * one adapter per weights at the largest window its queues need, a footprint
 * check before every load, every eviction proven. Nothing else in the
 * harness constructs a model adapter; a search test holds that. Two more
 * builders live here for work that measures a model rather than serves a
 * role, which runs under the runner lease one model at a time:
 * `describeModel` (an adapter that has loaded nothing, for a qualification
 * combination, a gate or a measurement) and `launchVariant` (the same
 * managed launch with one setting changed, for calibration probes).
 */

/**
 * What a benchmark run holds (B4.1 half-B review, models rule 20a): its
 * models, each loaded through the scheduler and held for the run; `release`
 * unloads one it loaded (a model resident before the run stays).
 */
export interface BenchmarkLease {
  load(role: ModelRole, model: string): Promise<UnloadableAdapter>;
  release(role: ModelRole, model: string): Promise<void>;
  /**
   * Before a load this scheduler cannot see (llama-bench's own process, a
   * qualification's adapter): every idle resident unloads (it reloads on its
   * next request), and one in use or pinned refuses in words, so an unseen
   * load never lands beside another model.
   */
  exclusive(): Promise<void>;
}

/** A queue: work one role's weights serve (chat, escalated retries, questions...). */
export interface QueueSpec {
  queue: string;
  role: ModelRole;
  /** The model name as a person gives it: a managed name or an Ollama tag. */
  name: string;
  /** The window this queue needs; the weights' adapter gets the largest. */
  window?: ResolveOptions;
}

export interface ModelAccessOptions {
  registry?: ModelRegistry;
  /** Builds an adapter; default the roster's `resolve`. Tests pass fakes. */
  resolve?: (name: string, role: ModelRole, want: ResolveOptions) => UnloadableAdapter;
  /** Memory the models may occupy together; default this host's measured usable memory. */
  usableBytes?: number;
  /** Whether two weights may be resident at once; default the calibrated tier's rule. */
  coResident?: boolean;
  /** Called once per weights' adapter when it is built (throughput metering, marking). */
  wrap?: (adapter: UnloadableAdapter, queues: string[]) => UnloadableAdapter;
  healthCheck?: boolean;
  pressureLevel?: () => number | undefined;
  headroomWaitMs?: number;
  log?: (line: string) => void;
  /**
   * The ledger Smart Swap records every load and unload on, and reads its
   * history from (models rule 20c, NEW-models-14). Without one nothing is
   * recorded and every prediction is the stated estimate.
   */
  ledger?: SwapLedger;
  /** The volume a weights file is on; default by its device (`volumeOf`). Tests pass fakes. */
  volumeOf?: (path: string) => "internal" | "external";
  /**
   * Smart Swap's memory probe (models rule 20g): every load admitted by the
   * headroom. Not on by default until the calibration nights set the D
   * values on the reference host (measurement rule 16d).
   */
  headroom?: HeadroomProbe;
  /** GPU ceilings recorded elsewhere (rule 20g), beside those on the ledger; none: the seed. */
  gpuCeilings?: GpuCeiling[];
  /** Load options per weights (rule 20h): the load mode the A/B chose. */
  loadOptions?: (weights: string) => LoadOptions | undefined;
  /** The drive check and read probe before each load (rule 20h). */
  volumeProbe?: VolumeProber;
  /** The clock the scheduler times and decides by; default `Date.now`. Tests pass a fake. */
  now?: () => number;
  /** How often waits poll (memory pressure, the watchdog's level falling). Default 1 s. */
  pollMs?: number;
}

/**
 * What Smart Swap's snapshot reads from the product (models rule 20e), set
 * once the product has them (the queue's watchdog starts after its router).
 */
export interface SwapInputs {
  /** Presence (C6): the dashboard's sessions, reserve-now and the reserved hours. */
  presence?: () => SwapPresence;
  /** The memory watchdog's level (rule 19). */
  watchdogLevel?: () => WatchdogLevel;
  /** CPU-side work of queued cards, run while a model loads (C9). */
  overlap?: (loading: string) => void | Promise<void>;
}

/** What a queued request says about itself (rule 20e): its class, predicted service, and whether it is a review (C6). */
export interface QueuedRequest {
  cls?: RequestClass;
  /** Predicted service time (the median), for W (rule 20d). */
  serviceMs?: number;
  /** A review of a finished card (C6). */
  review?: boolean;
}

/**
 * What Smart Swap needs of the ledger; its erasure index, when it has one, is
 * what every adapter sweeps its saved slots by before a restore (MD-N14-37).
 */
export type SwapLedger = Pick<EventLog, "appendNow" | "getEventsByTypes"> &
  Partial<Pick<EventLog, "erasureIndex">>;

/** Smart Swap's recorded history on a ledger, oldest first (MD-N14-4). */
export async function swapHistory(ledger: SwapLedger): Promise<SwapEvent[]> {
  return (await ledger.getEventsByTypes(Object.values(SWAP_EVENTS))).map((e) => ({
    type: e.type,
    payload: e.payload as SwapEvent["payload"],
    at: Date.parse(e.createdAt),
  }));
}

/** The weights a model name loads: managed names by their model id, Ollama tags by themselves. */
export function weightsKey(name: string): string {
  const n = name.replace(/^ollama\//, "");
  return isManagedModelName(n) ? resolveWorkerModelId(n) : n;
}

/**
 * A model's adapter for measuring or gating it, not for serving a role:
 * nothing loads until a request is sent (MD-N4-3: through the roster).
 */
export function describeModel(
  name: string,
  role: ModelRole,
  opts: { registry?: ModelRegistry; want?: ResolveOptions } = {},
): UnloadableAdapter {
  return new ModelRoster(opts.registry ? { registry: opts.registry } : {}).resolve(
    name.replace(/^ollama\//, ""),
    role,
    opts.want ?? {},
  );
}

/** The same managed launch with some settings changed, for a probe. */
export function launchVariant(
  adapter: ManagedLlamaServerAdapter,
  change: Partial<ManagedLlamaServerAdapter["launchProfile"]>,
  opts: { keepRegistry?: boolean } = {},
): ManagedLlamaServerAdapter {
  const { registry, ...profile } = adapter.launchProfile;
  return new ManagedLlamaServerAdapter({
    ...profile,
    ...(opts.keepRegistry && registry ? { registry } : {}),
    ...change,
  });
}

/**
 * The model a role runs as (models rule 30a, MD-N10-3): the command line's
 * name, else the person's assignment on this host (`sekhemet models assign`),
 * else undefined (the caller's shipped default).
 */
export function roleModelName(
  role: ModelRole,
  flag: string | undefined,
  opts: { registry: ModelRegistry; host?: string },
): string | undefined {
  if (flag) return flag;
  const model = currentAssignment(opts.registry, opts.host ?? hostFingerprintHash(), role)?.model;
  // An unfilled Reviewer is no model (MD-N4-9): the role's fallback applies.
  return model === UNFILLED ? undefined : model;
}

/**
 * The Worker's name, one way for `run`, `queue` and the dashboard (SUR-11,
 * MD-N10-3): the flag, else the person's assignment, else config.toml's
 * `configured`, else the roster default for this machine's tier.
 */
export function resolveWorkerName(
  flag: string | undefined,
  configured: string | undefined,
  opts: { registry: ModelRegistry; host?: string },
): string {
  return roleModelName("worker", flag, opts) ?? configured ?? defaultWorkerName();
}

/**
 * The board's `ready` entry check (PM-12..14, K-N5-7): the planner's own
 * `zone3Fit` at the resolved Worker's W, so INVEST's Small and the board are
 * one computation. The Worker is resolved once, on the first card measured.
 */
export function workerZone3Fit(
  repoPath: string,
  opts: { registry: ModelRegistry; configured?: string | undefined; host?: string },
): (card: Zone3Card) => { tokens: number; cap: number } {
  let promptBudgetTokens: number | undefined;
  return (card) => {
    promptBudgetTokens ??= workerPromptBudget(resolvedWorkerWindowTokens(opts));
    return zone3Fit(card, { repoRoot: repoPath, promptBudgetTokens });
  };
}

/**
 * The resolved Worker's context window, as its adapter reads it from the
 * registry (models NEW-models-4): the window INVEST's Small is computed at,
 * for the planner and the board alike (PM-13).
 */
export function resolvedWorkerWindowTokens(opts: {
  registry: ModelRegistry;
  configured?: string | undefined;
  host?: string;
}): number {
  const name = resolveWorkerName(undefined, opts.configured, {
    registry: opts.registry,
    ...(opts.host ? { host: opts.host } : {}),
  });
  const window = describeModel(name, "worker", { registry: opts.registry }).contextWindow;
  // PM-13: no fixed default — a Worker with no known window cannot be measured against.
  if (!window)
    throw new Error(
      `The Worker ${name} has no context window in the registry, so INVEST's Small cannot be checked; qualify it first.`,
    );
  return window.contextTokens;
}

function hostMemory(): { usableBytes: number; coResident: boolean } {
  const profile = loadHostMachineProfile();
  const usableBytes = profile?.usableBytes ?? measureUsableMemory().usableBytes;
  const coResident = profile
    ? tierSettingsOf(profile).coLoadRoles
    : usableBytes >= CO_RESIDENT_MIN_BYTES;
  return { usableBytes, coResident };
}

export class ModelAccess {
  private readonly specs = new Map<string, QueueSpec>();
  private ledger: SwapLedger | undefined;
  private inputs: SwapInputs = {};
  /** Inside a measurement run (rule 20b): C9 and C10 are bypassed. */
  private measuring = false;
  /** Inside a benchmark run: no other role loads. */
  private benchmarking = false;
  /** The load guard set from outside (a calibration night), kept under a benchmark's. */
  private loadGuard: ((weights: string) => void | Promise<void>) | undefined;
  /** C10's page-cache warmer, when the headroom probe is on. */
  private warmer: PageCacheWarmer | undefined;

  private constructor(
    private readonly scheduler: ResidencyScheduler,
    private readonly options: ModelAccessOptions,
  ) {}

  /** A scheduler for these queues, each resolved through the roster. */
  public static forQueues(queues: QueueSpec[], options: ModelAccessOptions = {}): ModelAccess {
    const host =
      options.usableBytes !== undefined
        ? {
            usableBytes: options.usableBytes,
            coResident: options.usableBytes >= CO_RESIDENT_MIN_BYTES,
          }
        : hostMemory();
    const memory = {
      ...host,
      ...(options.coResident !== undefined ? { coResident: options.coResident } : {}),
    };
    // Smart Swap (NEW-models-14): the ledger is read when first needed, so
    // one attached after construction (`recordSwapsOn`) still counts.
    let access: ModelAccess | undefined;
    const scheduler = new ResidencyScheduler({
      roles: [],
      weights: {},
      usableBytes: memory.usableBytes,
      coResident: memory.coResident,
      ...(options.healthCheck !== undefined ? { healthCheck: options.healthCheck } : {}),
      ...(options.pressureLevel ? { pressureLevel: options.pressureLevel } : {}),
      ...(options.headroomWaitMs !== undefined ? { headroomWaitMs: options.headroomWaitMs } : {}),
      ...(options.log ? { log: options.log } : {}),
      ...(options.headroom ? { headroom: options.headroom } : {}),
      ...(options.gpuCeilings ? { gpuCeilings: options.gpuCeilings } : {}),
      ...(options.loadOptions ? { loadOptions: options.loadOptions } : {}),
      ...(options.volumeProbe ? { volumeProbe: options.volumeProbe } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      // Smart Swap's snapshot inputs, read at each decision (rule 20e).
      presence: () => access?.inputs.presence?.() ?? { present: false },
      watchdogLevel: () => access?.inputs.watchdogLevel?.() ?? "normal",
      // C9: while a model loads, the CPU-side work of queued cards runs.
      overlap: async (loading) => {
        if (access && !access.measuring) await access.inputs.overlap?.(loading);
      },
      // C10: the successor warmed into the page cache, only with the headroom probe.
      ...(options.headroom
        ? {
            prefetch: async (weights: string) => {
              if (!access || access.measuring)
                throw new Error("a measurement run does not prefetch (rule 20b)");
              await access.warmer?.warm(weights);
            },
          }
        : {}),
      // C10: warmed bytes count only while the weights are neither loaded nor unloaded since.
      onResidencyChange: (weights) => access?.warmer?.forget(weights),
      swapCost: {
        record: ({ type, payload }) => {
          access?.ledger?.appendNow({ actor: "harness", type, payload });
        },
        history: () => (access?.ledger ? swapHistory(access.ledger) : []),
        ...(options.volumeOf ? { volumeOf: options.volumeOf } : {}),
      },
    });
    access = new ModelAccess(scheduler, options);
    access.ledger = options.ledger;
    if (options.headroom) {
      const self = access;
      self.warmer = pageCacheWarmer({
        probe: options.headroom,
        watchdogLevel: () => self.inputs.watchdogLevel?.() ?? "normal",
        source: (weights) => self.weightsSource(weights),
      });
    }
    for (const q of queues) access.ensureQueue(q);
    return access;
  }

  /**
   * Record this scheduler's loads and unloads on `ledger` from now on, unless
   * one is already attached (the process's shared scheduler is created by
   * whichever caller asks first).
   */
  public recordSwapsOn(ledger: SwapLedger | undefined): void {
    this.ledger ??= ledger;
  }

  /** What loading a queue's weights is predicted to cost now (MD-N14-4); loads nothing. */
  public predictLoad(queue: string): ReturnType<ResidencyScheduler["predictLoad"]> {
    return this.scheduler.predictLoad(queue);
  }

  /** Add a queue unless it is known; queues on known weights share their adapter. */
  public ensureQueue(spec: QueueSpec): void {
    if (this.specs.has(spec.queue)) return;
    this.specs.set(spec.queue, spec);
    const key = weightsKey(spec.name);
    const resolve =
      this.options.resolve ??
      ((name: string, role: ModelRole, want: ResolveOptions) =>
        describeModel(name, role, {
          ...(this.options.registry ? { registry: this.options.registry } : {}),
          want,
        }));
    this.scheduler.addRole(
      { role: spec.queue, weights: key, contextTokens: spec.window?.contextTokens ?? 0 },
      {
        build: (contextTokens) => {
          const sharing = [...this.specs.values()].filter((s) => weightsKey(s.name) === key);
          const maxTokens = Math.max(0, ...sharing.map((s) => s.window?.maxTokens ?? 0));
          const first = sharing[0] ?? spec;
          const adapter = resolve(first.name.replace(/^ollama\//, ""), first.role, {
            ...(contextTokens > 0 ? { contextTokens } : {}),
            ...(maxTokens > 0 ? { maxTokens } : {}),
          });
          // Rule 20i, MD-N14-37: before every restore the adapter deletes the
          // slot files an erasure on this ledger covers.
          adapter.setErasureSource?.(() => {
            const index = this.ledger?.erasureIndex?.();
            if (!index) throw new Error("no ledger to read erasures from");
            return index;
          });
          return this.options.wrap
            ? this.options.wrap(
                adapter,
                sharing.map((s) => s.queue),
              )
            : adapter;
        },
      },
    );
  }

  /** Learn every queue's footprint (loads nothing); unknown ones are refused later. */
  public measure(): ReturnType<ResidencyScheduler["measureFootprints"]> {
    return this.scheduler.measureFootprints();
  }

  /**
   * A queue's model, resident now and held until the hold is released: no
   * other queue evicts it meanwhile. This bypasses `decide()`'s queue (it is
   * `acquire`): only for a caller that truly needs the model at once — prefer
   * `submitHold`. `yieldsToWatchdog`: a pin only the policy respects (an
   * escalated card's attempt, which the watchdog's emergency unloads between
   * its steps, rule 19).
   */
  public hold(queue: string, opts: { yieldsToWatchdog?: boolean } = {}): Promise<ModelHold> {
    return this.scheduler.acquire(queue, opts);
  }

  /**
   * Queue a request for a queue's model (models rule 20e): `decide()` serves
   * it when C1–C7 allow — batched into a tour with the other queues, aged by
   * its class's cap, counted by the storm cap — and the caller then holds the
   * model until it releases the hold. A flow of several requests (a batch of
   * plans, Seshat's answer, a batch of research questions) is one request.
   */
  public submitHold(
    queue: string,
    opts: QueuedRequest & { yieldsToWatchdog?: boolean } = {},
  ): Promise<ModelHold> {
    return this.scheduler.submitHold(queue, opts);
  }

  /**
   * A queue's model through `decide()`'s queue, resident once served but not
   * held: for the flow that owns this `ModelAccess` and needs its model next
   * (a card's start on the Worker, which its steps then keep, C8).
   */
  public useQueued(queue: string, opts: QueuedRequest = {}): Promise<UnloadableAdapter> {
    return this.scheduler.submit(queue, async (adapter) => adapter, opts);
  }

  /**
   * A model for a flow that may or may not need it (research that may be
   * answered from memory): the first `model()` queues one `submitHold`,
   * later ones return the same adapter; `release` ends the hold, if any.
   */
  public queuedModel(
    queue: string,
    opts: QueuedRequest = {},
  ): { model: () => Promise<UnloadableAdapter>; release: () => Promise<void> } {
    let held: Promise<ModelHold> | undefined;
    return {
      model: async () => {
        held ??= this.submitHold(queue, opts).catch((err: unknown) => {
          held = undefined;
          throw err;
        });
        return (await held).adapter;
      },
      release: async () => {
        const hold = await held?.catch(() => undefined);
        held = undefined;
        hold?.release();
      },
    };
  }

  /**
   * A queue's model, resident now but not held (evicting what may be
   * evicted, proven). It bypasses `decide()`'s queue (it is `acquire`): only
   * for a flow that owns this `ModelAccess` with one queue (`run`, `plan`),
   * or a caller nested inside another request's hold, which a queued request
   * would deadlock behind. Otherwise `useQueued`, `submitHold` or `submit`.
   */
  public async use(queue: string): Promise<UnloadableAdapter> {
    const hold = await this.scheduler.acquire(queue);
    hold.release();
    return hold.adapter;
  }

  /** The queue's adapter without loading it (for a gate or a label). */
  public adapterFor(queue: string): UnloadableAdapter {
    return this.scheduler.adapterFor(queue);
  }

  /** Queue work until `decide()` has the queue's weights resident (MD-N9-2, rule 20e). */
  public submit<T>(
    queue: string,
    work: (adapter: UnloadableAdapter) => Promise<T>,
    opts: QueuedRequest = {},
  ): Promise<T> {
    return this.scheduler.submit(queue, work, opts);
  }

  public has(queue: string): boolean {
    return this.scheduler.has(queue);
  }

  public isResident(queue: string): boolean {
    return this.scheduler.isResident(queue);
  }

  public get activeRole(): string | undefined {
    return this.scheduler.activeRole;
  }

  public residentRoles(): string[] {
    return this.scheduler.residentRoles();
  }

  /** The weights resident now, by weights key. */
  public residentWeights(): string[] {
    return this.scheduler.residentWeights();
  }

  /** The weights loading now (a load in flight): what background disk work yields to. */
  public loadingWeights(): string[] {
    return this.scheduler.loadingWeights();
  }

  public get swapCount(): number {
    return this.scheduler.swapCount;
  }

  public release(queue: string): Promise<void> {
    return this.scheduler.release(queue);
  }

  public releaseAll(): Promise<void> {
    return this.scheduler.releaseAll();
  }

  // --- Smart Swap (models rule 20e): what `decide()` predicts and needs ---

  /**
   * When a request on `queue` would start (the median, MD-N14-8) and whether
   * its full answer takes rule 20f's quick path, so Seshat can say it.
   * `homeBacklog`: the Worker is mid-card (the runner's step boundary).
   */
  public predictWait(
    queue: string,
    opts: { cls?: "interactive"; homeBacklog?: boolean } = {},
  ): ReturnType<ResidencyScheduler["predictWait"]> {
    return this.scheduler.predictWait(queue, opts);
  }

  /** θ, the caps with their feasibility, the placement notice and the policy's parameters. */
  public swapStatus(): ReturnType<ResidencyScheduler["status"]> {
    return this.scheduler.status();
  }

  /** Whether the Worker has a card in progress (C5 counts its absences then); undefined: its queue says. */
  public setHomeBacklog(on: boolean | undefined): void {
    this.scheduler.setHomeBacklog(on);
  }

  /**
   * One step on a queue's weights (models rule 20e, C8; RUN-35): no step
   * starts while a decided swap waits at the drain barrier, and none runs on
   * weights that are not resident — it asks for them through `decide()`'s
   * queue, so a tour under way (a batch of reviews) finishes first, a hold
   * (Seshat's answer) ends first, and the watchdog's critical level starts no
   * load. The returned function ends the step, a step boundary.
   */
  public async beginStep(queue: string): Promise<() => void> {
    for (;;) {
      const end = await this.scheduler.beginStep(queue);
      if (this.scheduler.isResident(queue)) return end;
      end();
      await this.measure();
      await this.scheduler.submit(queue, async () => undefined);
    }
  }

  /** Smart Swap's snapshot inputs from the product (presence, the watchdog, C9's work). */
  public setSwapInputs(inputs: SwapInputs): void {
    this.inputs = { ...this.inputs, ...inputs };
  }

  /** The plan's next uses, as queues in order (C2's tours, Belady eviction, C10's successor). */
  public setPlan(queues: readonly string[]): void {
    if (this.measuring) return;
    this.scheduler.setPlan(queues.filter((q) => this.scheduler.has(q)));
  }

  /** The plan in force, as the first queue on each planned weights. */
  public plannedQueues(): string[] {
    return this.scheduler.plannedWeights.map(
      (w) => [...this.specs.values()].find((s) => weightsKey(s.name) === w)?.queue ?? w,
    );
  }

  /** A step boundary with no step (the plan or an input changed): decide again. */
  public boundary(): void {
    this.scheduler.boundary();
  }

  /**
   * Bytes the page-cache warmer read (C10) for weights not resident, each
   * once: never counted as used memory, and never stale (a load or unload
   * forgets them).
   */
  public warmedBytes(): number {
    return this.warmer?.warmedBytes() ?? 0;
  }

  /** Whether the headroom probe is on (models rule 20g; off until calibration). */
  public get headroomOn(): boolean {
    return this.options.headroom !== undefined;
  }

  /**
   * Whether the measured headroom admits a queue's model beside what is
   * resident now, evicting nothing (rule 20f b's quick answerer). Without the
   * headroom probe nothing is measured, so nothing is admitted.
   */
  public async admits(queue: string): Promise<{ ok: boolean; reason: string }> {
    if (!this.options.headroom)
      return { ok: false, reason: "the headroom probe is off, so no headroom is measured" };
    if (this.scheduler.isResident(queue)) return { ok: true, reason: "resident" };
    await this.measure();
    const weights = weightsKey(this.specs.get(queue)?.name ?? queue);
    const verdict = admitLoad({
      reading: await this.options.headroom.read(),
      candidate: { weights, footprintBytes: this.scheduler.footprintOf(weights) },
      resident: this.scheduler.residentWeights().map((w) => ({
        weights: w,
        footprintBytes: this.scheduler.footprintOf(w) ?? 0,
      })),
      now: this.options.now?.() ?? Date.now(),
      // The configured ceilings and those recorded on the ledger (rule 20g, MD-N14-33).
      ceilings: gpuCeilingsFrom(await this.scheduler.gpuCeilings()),
    });
    return verdict.verdict === "admit"
      ? { ok: true, reason: "admitted by the headroom" }
      : { ok: false, reason: verdict.reason };
  }

  /**
   * A queue's model held beside what is resident, never evicting (rule 20f
   * b). Kept synchronous (`acquire` with `evict: false`): the quick answer's
   * point is not to wait for a swap, and it evicts nothing, so no policy
   * rule (C1–C7) is at stake.
   */
  public holdBeside(queue: string): Promise<ModelHold> {
    return this.scheduler.acquire(queue, { evict: false });
  }

  /**
   * A measurement run (the frozen suite, a bake-off, an A/B, qualification;
   * measurement MS-NM14-3, rule 20b): C9's overlap, C10's prefetch and the
   * plan are bypassed inside it, and its models are unloaded when it ends,
   * even when it fails (DEC-42).
   */
  public async measurementRun<T>(run: () => Promise<T>): Promise<T> {
    this.measuring = true;
    try {
      return await withMeasurementRun(this.scheduler, run);
    } finally {
      this.measuring = false;
    }
  }

  /**
   * A benchmark run (measurement NEW-measurement-5, models rule 20a; B4.1
   * half-B review): its models load through this scheduler, one lease for
   * the run, and while it runs no other role loads — a queued request (a
   * Seshat answer, a research question) stays queued until it ends, and an
   * immediate hold is refused in words. C9's overlap and C10's prefetch are
   * bypassed, as in any measurement run (rule 20b). When it ends, even when
   * it fails, it unloads only what it loaded: a model resident before it
   * stays, unless the run asked for `exclusive()` before a load this
   * scheduler cannot see. One benchmark at a time.
   */
  public async benchmarkRun<T>(run: (lease: BenchmarkLease) => Promise<T>): Promise<T> {
    if (this.benchmarking) throw new Error("A benchmark is running already; one runs at a time.");
    const allowed = new Set<string>();
    const holds = new Map<string, ModelHold>();
    /** Queues whose weights this run loaded (not resident when it asked). */
    const loadedHere = new Set<string>();
    this.benchmarking = true;
    this.measuring = true;
    const outer = this.loadGuard;
    this.scheduler.setLoadGuard(async (weights) => {
      if (!allowed.has(weights))
        throw new FootprintRefusal(
          `A benchmark is running: ${weights} is not loaded until it ends; the work stays queued.`,
        );
      await outer?.(weights);
    });
    const queueOf = (role: ModelRole, model: string) => `benchmark/${role}/${model}`;
    const lease: BenchmarkLease = {
      load: async (role, model) => {
        const queue = queueOf(role, model);
        const had = holds.get(queue);
        if (had) return had.adapter;
        this.ensureQueue({ queue, role, name: model });
        const key = weightsKey(model);
        allowed.add(key);
        if (!this.scheduler.residentWeights().includes(key)) loadedHere.add(queue);
        await this.measure();
        const hold = await this.scheduler.acquire(queue);
        holds.set(queue, hold);
        return hold.adapter;
      },
      release: async (role, model) => {
        const queue = queueOf(role, model);
        holds.get(queue)?.release();
        holds.delete(queue);
        if (loadedHere.delete(queue)) await this.scheduler.release(queue);
      },
      exclusive: async () => {
        for (const queue of this.scheduler.residentRoles()) await this.scheduler.release(queue);
        const left = this.scheduler.residentWeights();
        if (left.length > 0)
          throw new FootprintRefusal(
            `${left.join(", ")} is in use; the measurement waits until it is free.`,
          );
      },
    };
    try {
      return await run(lease);
    } finally {
      for (const h of holds.values()) h.release();
      holds.clear();
      for (const queue of loadedHere) await this.scheduler.release(queue).catch(() => undefined);
      loadedHere.clear();
      this.scheduler.setLoadGuard(outer);
      this.benchmarking = false;
      this.measuring = false;
      // The work that waited is served now.
      this.scheduler.boundary();
    }
  }

  /** Whether a benchmark run holds the scheduler now. */
  public get benchmarkRunning(): boolean {
    return this.benchmarking;
  }

  /** A check before every load (a calibration night's DEC-42 limits); undefined removes it. */
  public setLoadGuard(guard: ((weights: string) => void | Promise<void>) | undefined): void {
    this.loadGuard = guard;
    this.scheduler.setLoadGuard(guard);
  }

  /** The scheduler, for a calibration night (`runCalibrationNight`) and a measurement run. */
  public get residency(): Pick<ResidencyScheduler, "setLoadGuard" | "releaseAll"> {
    return this.scheduler;
  }

  /** A weights key's file, through the first queue that serves it; undefined when unknown. */
  private async weightsSource(
    weights: string,
  ): Promise<{ path: string; bytes: number } | undefined> {
    const spec = [...this.specs.values()].find((s) => weightsKey(s.name) === weights);
    if (!spec) return undefined;
    return this.scheduler.adapterFor(spec.queue).weightsSource?.();
  }
}

let shared: ModelAccess | undefined;

/**
 * One queue on a scheduler (the process's shared one by default): a function
 * that makes its model resident and returns a hold on it (footprints
 * measured first). The caller releases the hold when its answer is done.
 */
export function sharedQueue(
  spec: QueueSpec,
  options: ModelAccessOptions = {},
  access: ModelAccess = sharedModelAccess(options),
): () => Promise<ModelHold> {
  access.recordSwapsOn(options.ledger);
  access.ensureQueue(spec);
  // Rule 20e: through `decide()`'s queue (a person's chat is interactive by its
  // queue's class; research waits its turn), then held until released.
  return async () => {
    await access.measure();
    return access.submitHold(spec.queue);
  };
}

/**
 * The process's one `ModelAccess`, for callers that serve a person between
 * runs (the dashboard's Seshat, the ACP bridge, `sekhemet research`): their
 * queues share one scheduler, so a chat answer and a research question never
 * hold two large models at once.
 */
export function sharedModelAccess(options: ModelAccessOptions = {}): ModelAccess {
  shared ??= ModelAccess.forQueues([], options);
  return shared;
}
