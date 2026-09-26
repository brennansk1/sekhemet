import type { EventLog } from "@sekhemet/kernel";
import {
  CO_RESIDENT_MIN_BYTES,
  ManagedLlamaServerAdapter,
  type ModelHold,
  type ModelRegistry,
  type ModelRole,
  ModelRoster,
  ResidencyScheduler,
  type ResolveOptions,
  SWAP_EVENTS,
  type SwapEvent,
  UNFILLED,
  type UnloadableAdapter,
  currentAssignment,
  hostFingerprintHash,
  isManagedModelName,
  loadHostMachineProfile,
  measureUsableMemory,
  resolveWorkerModelId,
  tierSettingsOf,
} from "@sekhemet/models";

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
}

/** What Smart Swap needs of the ledger. */
export type SwapLedger = Pick<EventLog, "appendNow" | "getEventsByTypes">;

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
   * other queue evicts it meanwhile (a Seshat answer, a research question).
   */
  public hold(queue: string): Promise<ModelHold> {
    return this.scheduler.acquire(queue);
  }

  /**
   * A queue's model, resident now but not held (evicting what may be
   * evicted, proven): for the one flow that owns this `ModelAccess` and asks
   * one model at a time (`run`, the queue). A caller that shares the
   * scheduler holds instead (`hold`).
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

  /** Queue work until the queue's weights are resident (MD-N9-2). */
  public submit<T>(queue: string, work: (adapter: UnloadableAdapter) => Promise<T>): Promise<T> {
    return this.scheduler.submit(queue, work);
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

  public get swapCount(): number {
    return this.scheduler.swapCount;
  }

  public release(queue: string): Promise<void> {
    return this.scheduler.release(queue);
  }

  public releaseAll(): Promise<void> {
    return this.scheduler.releaseAll();
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
  return async () => {
    await access.measure();
    return access.hold(spec.queue);
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
