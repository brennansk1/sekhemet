import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

/**
 * Smart Swap: what a model swap costs — measured, predicted and flagged when
 * slow (models rule 20c, NEW-models-14).
 *
 * The residency scheduler (rule 20a) times every load it orders and every
 * unload, and hands each to a `SwapCostTracker`, which:
 *
 * - **records** them on the ledger (`model/loaded`, `model/unloaded`,
 *   `model/first_token`), structural fields only: the weights, the queues
 *   they serve, the volume, the bytes, cold or warm, and the milliseconds;
 * - **predicts** each load per weights, volume and cold/warm (`SwapCostBook`):
 *   the median and p90 of the last 20 loads once three exist, else a stated
 *   estimate from the file's size and the volume's read rate;
 * - **flags** a slow load (`model/slow_load`) with its likely causes and a fix
 *   for each.
 *
 * The history is read back from the ledger, so a new process predicts from
 * every load recorded before it. The swap policy that uses these numbers is
 * the Smart Swap design's (in progress).
 */

export type Volume = "internal" | "external";
export type CacheState = "cold" | "warm";

/** The event types Smart Swap writes (registered in the kernel's payload registry). */
export const SWAP_EVENTS = {
  loaded: "model/loaded",
  unloaded: "model/unloaded",
  firstToken: "model/first_token",
  slowLoad: "model/slow_load",
} as const;

/** Startup a load pays before reading weights (process, allocation, warm-up). */
export const LOAD_OVERHEAD_MS = 5000;
/** Stated read rates until a cold load on the volume is recorded (bytes/s). */
export const DEFAULT_READ_BYTES_PER_SECOND: Readonly<Record<Volume, number>> = {
  internal: 2e9,
  external: 40e6,
};
/** A warm load reads from the OS file cache. */
export const WARM_READ_BYTES_PER_SECOND = 4e9;
/** Loads per (weights, volume, cache) a prediction reads. */
export const PREDICTION_WINDOW = 20;
/** Loads needed before the prediction is measured rather than estimated. */
export const MIN_MEASURED_SAMPLES = 3;
/** A load past p90 × this is slow. */
export const SLOW_LOAD_FACTOR = 1.5;
/** A cold load with too little history is slow past this. */
export const COLD_LOAD_BOUND_MS = 120_000;
/** Weights unloaded less than this long ago may still be in the file cache. */
export const WARM_WINDOW_MS = 15 * 60_000;
/** Swap in use at a load's end that names swap as a cause. */
export const SWAP_IN_USE_BYTES = 1024 ** 3;

export type SlowLoadCause = "external_volume" | "memory_pressure" | "swap_in_use" | "cold_cache";
export type SlowLoadFix = "copy_to_internal" | "free_memory" | "prewarm_overnight";

const FIX_FOR: Readonly<Record<SlowLoadCause, SlowLoadFix>> = {
  external_volume: "copy_to_internal",
  memory_pressure: "free_memory",
  swap_in_use: "free_memory",
  cold_cache: "prewarm_overnight",
};

export interface ModelLoadedPayload {
  model: string;
  roles: string[];
  volume: Volume;
  bytes: number;
  cache: CacheState;
  loadMs: number;
  /** The prediction made before the load. */
  medianMs: number;
  p90Ms: number;
  basis: "measured" | "estimate";
}

export interface ModelUnloadedPayload {
  model: string;
  roles: string[];
  volume: Volume;
  bytes: number;
  unloadMs: number;
  confirmed: boolean;
}

export interface ModelFirstTokenPayload {
  model: string;
  roles: string[];
  firstTokenMs: number;
}

export interface ModelSlowLoadPayload {
  model: string;
  roles: string[];
  volume: Volume;
  bytes: number;
  cache: CacheState;
  loadMs: number;
  /** The bound it passed. */
  boundMs: number;
  causes: SlowLoadCause[];
  fixes: SlowLoadFix[];
}

export type SwapPayload =
  | ModelLoadedPayload
  | ModelUnloadedPayload
  | ModelFirstTokenPayload
  | ModelSlowLoadPayload;

/** One recorded swap event, as read back from the ledger. */
export interface SwapEvent {
  type: string;
  payload: SwapPayload;
  /** Epoch milliseconds. */
  at: number;
}

/** One recorded load, as the prediction reads it. */
export interface LoadSample {
  model: string;
  volume: Volume;
  cache: CacheState;
  bytes: number;
  loadMs: number;
}

export interface LoadPrediction {
  model: string;
  volume: Volume;
  cache: CacheState;
  bytes: number;
  medianMs: number;
  p90Ms: number;
  basis: "measured" | "estimate";
  /** Recorded loads of this weights, volume and cache state. */
  samples: number;
}

/** Nearest-rank percentile of sorted-or-not values (p in 0..1). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] as number;
}

/** How `volumeOf` reads devices; injectable for tests. */
export interface VolumeProbe {
  /** The device a path is on; undefined when it cannot be read. */
  dev?: (path: string) => number | undefined;
  /** The home directory. Default `os.homedir()`. */
  home?: string;
}

function statDev(path: string): number | undefined {
  try {
    return statSync(path).dev;
  } catch {
    return undefined;
  }
}

/**
 * The volume a weights file is on, by device, never by path: internal when
 * it shares a device with the system volume (the root) or the home
 * directory, external otherwise. A file that cannot be read is judged by its
 * nearest readable directory.
 */
export function volumeOf(path: string, probe: VolumeProbe = {}): Volume {
  const dev = probe.dev ?? statDev;
  let at = resolve(path);
  let device = dev(at);
  while (device === undefined && dirname(at) !== at) {
    at = dirname(at);
    device = dev(at);
  }
  const internal = new Set(
    [dev(probe.home ?? homedir()), dev(parse(at).root)].filter((d): d is number => d !== undefined),
  );
  return device === undefined || internal.has(device) ? "internal" : "external";
}

/**
 * The load history and the prediction it gives (MD-N14-4). Pure: fed samples,
 * it predicts; it reads no clock and no disk.
 */
export class SwapCostBook {
  private readonly samples: LoadSample[] = [];

  constructor(history: readonly LoadSample[] = []) {
    for (const s of history) this.add(s);
  }

  public add(sample: LoadSample): void {
    this.samples.push(sample);
  }

  /**
   * The volume's read rate: the median effective rate of the cold loads
   * recorded on it (any weights), else the stated default.
   */
  public readRate(volume: Volume): { bytesPerSecond: number; basis: "measured" | "default" } {
    const rates = this.samples
      .filter((s) => s.volume === volume && s.cache === "cold")
      .slice(-PREDICTION_WINDOW)
      .map((s) => s.bytes / (Math.max(1, s.loadMs - LOAD_OVERHEAD_MS) / 1000));
    if (rates.length === 0)
      return { bytesPerSecond: DEFAULT_READ_BYTES_PER_SECOND[volume], basis: "default" };
    return { bytesPerSecond: percentile(rates, 0.5), basis: "measured" };
  }

  public predict(load: {
    model: string;
    volume: Volume;
    cache: CacheState;
    bytes: number;
  }): LoadPrediction {
    const mine = this.samples
      .filter((s) => s.model === load.model && s.volume === load.volume && s.cache === load.cache)
      .slice(-PREDICTION_WINDOW)
      .map((s) => s.loadMs);
    if (mine.length >= MIN_MEASURED_SAMPLES) {
      return {
        ...load,
        medianMs: percentile(mine, 0.5),
        p90Ms: percentile(mine, 0.9),
        basis: "measured",
        samples: mine.length,
      };
    }
    const rate =
      load.cache === "warm"
        ? WARM_READ_BYTES_PER_SECOND
        : this.readRate(load.volume).bytesPerSecond;
    const estimate = Math.round(LOAD_OVERHEAD_MS + (load.bytes / rate) * 1000);
    return {
      ...load,
      medianMs: estimate,
      p90Ms: estimate,
      basis: "estimate",
      samples: mine.length,
    };
  }
}

/**
 * Whether a load was slow, and the bound it passed (MD-N14-5): past p90 × 1.5
 * with measured history; with less, a cold load over 120 s or a warm load
 * past 1.5 × its estimate.
 */
export function slowLoadBound(prediction: LoadPrediction): number {
  if (prediction.basis === "measured" || prediction.cache === "warm")
    return Math.round(prediction.p90Ms * SLOW_LOAD_FACTOR);
  return COLD_LOAD_BOUND_MS;
}

/** The likely causes of a slow load, in a fixed order, and a fix for each. */
export function slowLoadCauses(c: {
  volume: Volume;
  cache: CacheState;
  /** The worst kernel pressure level seen at the load's start or end. */
  pressureLevel: number | undefined;
  swapUsedBytes: number | undefined;
}): { causes: SlowLoadCause[]; fixes: SlowLoadFix[] } {
  const causes: SlowLoadCause[] = [];
  if (c.volume === "external") causes.push("external_volume");
  if (c.pressureLevel !== undefined && c.pressureLevel >= 2) causes.push("memory_pressure");
  if (c.swapUsedBytes !== undefined && c.swapUsedBytes >= SWAP_IN_USE_BYTES)
    causes.push("swap_in_use");
  if (c.cache === "cold") causes.push("cold_cache");
  const fixes = [...new Set(causes.map((cause) => FIX_FOR[cause]))];
  return { causes, fixes };
}

const CAUSE_WORDS: Readonly<Record<SlowLoadCause, string>> = {
  external_volume: "the weights are on an external drive",
  memory_pressure: "memory was under pressure",
  swap_in_use: "the machine was using swap",
  cold_cache: "the file cache was cold",
};
const FIX_WORDS: Readonly<Record<SlowLoadFix, string>> = {
  copy_to_internal: "copy the weights to internal storage",
  free_memory: "close other large programs to free memory",
  prewarm_overnight: "let it pre-warm overnight",
};

const minutes = (ms: number) =>
  ms >= 90_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;

/** One sentence for a person: what was slow, why, and what to do. */
export function describeSlowLoad(p: ModelSlowLoadPayload): string {
  const why = p.causes.length
    ? ` Likely: ${p.causes.map((c) => CAUSE_WORDS[c]).join("; ")}.`
    : " No likely cause was found.";
  const fix = p.fixes.length ? ` Fix: ${p.fixes.map((f) => FIX_WORDS[f]).join("; ")}.` : "";
  return `Loading ${p.model} took ${minutes(p.loadMs)}, past the ${minutes(p.boundMs)} expected.${why}${fix}`;
}

export interface SwapCostOptions {
  /** Where records go (the ledger); a failure to record never fails a load. */
  record?: (event: { type: string; payload: SwapPayload }) => void | Promise<void>;
  /** The recorded history (the ledger's swap events, in order), read once before the first use. */
  history?: () => SwapEvent[] | Promise<SwapEvent[]>;
  /** The volume of a weights file; default `volumeOf`. */
  volumeOf?: (path: string) => Volume;
  /** Swap in use now; default the OS reading. */
  swapUsedBytes?: () => number | undefined;
  /** How long an unloaded model may stay in the file cache; default 15 minutes. */
  warmWindowMs?: number;
  log?: (line: string) => void;
}

/**
 * The scheduler's record of swap cost: it replays the history, decides cold
 * or warm, predicts, records, and flags (MD-N14-1–5).
 */
export class SwapCostTracker {
  public readonly book = new SwapCostBook();
  private readonly lastUnload = new Map<string, number>();
  /** Loads since the start, in order: when and how many bytes. */
  private readonly loadsAt: { at: number; model: string; bytes: number }[] = [];
  private seeded: Promise<void> | undefined;

  constructor(
    private readonly options: SwapCostOptions & {
      now: () => number;
      /** File-cache capacity for the warm rule: usable memory. */
      cacheBytes: number;
    },
  ) {}

  /** Replay the recorded history once. */
  public ready(): Promise<void> {
    this.seeded ??= (async () => {
      const events = (await this.options.history?.()) ?? [];
      for (const e of events) this.apply(e);
    })().catch((err) => {
      this.options.log?.(
        `swap cost: history unreadable (${err instanceof Error ? err.message : String(err)})`,
      );
    });
    return this.seeded;
  }

  private apply(e: SwapEvent): void {
    if (e.type === SWAP_EVENTS.loaded) {
      const p = e.payload as ModelLoadedPayload;
      this.book.add({
        model: p.model,
        volume: p.volume,
        cache: p.cache,
        bytes: p.bytes,
        loadMs: p.loadMs,
      });
      this.loadsAt.push({ at: e.at, model: p.model, bytes: p.bytes });
    } else if (e.type === SWAP_EVENTS.unloaded) {
      this.lastUnload.set((e.payload as ModelUnloadedPayload).model, e.at);
    }
  }

  public volumeOf(path: string): Volume {
    return (this.options.volumeOf ?? volumeOf)(path);
  }

  /**
   * Warm only when the same weights left less than the warm window ago and
   * what loaded since, plus these weights, fits the file cache (MD-N14-3).
   */
  public cacheState(model: string, bytes: number): CacheState {
    const left = this.lastUnload.get(model);
    const now = this.options.now();
    if (left === undefined || now - left >= (this.options.warmWindowMs ?? WARM_WINDOW_MS))
      return "cold";
    const since = this.loadsAt
      .filter((l) => l.at >= left && l.model !== model)
      .reduce((n, l) => n + l.bytes, 0);
    return since + bytes <= this.options.cacheBytes ? "warm" : "cold";
  }

  private async write(type: string, payload: SwapPayload): Promise<void> {
    try {
      await this.options.record?.({ type, payload });
    } catch (err) {
      this.options.log?.(
        `swap cost: could not record ${type} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  /** Record a load and, when it was slow, the flag (MD-N14-1, MD-N14-5). */
  public async loaded(l: {
    prediction: LoadPrediction;
    roles: string[];
    loadMs: number;
    /** The worst pressure level at the load's start or end. */
    pressureLevel: number | undefined;
  }): Promise<ModelSlowLoadPayload | undefined> {
    const { prediction: p } = l;
    const at = this.options.now();
    const payload: ModelLoadedPayload = {
      model: p.model,
      roles: l.roles,
      volume: p.volume,
      bytes: p.bytes,
      cache: p.cache,
      loadMs: l.loadMs,
      medianMs: p.medianMs,
      p90Ms: p.p90Ms,
      basis: p.basis,
    };
    await this.write(SWAP_EVENTS.loaded, payload);
    this.apply({ type: SWAP_EVENTS.loaded, payload, at });
    const boundMs = slowLoadBound(p);
    if (l.loadMs <= boundMs) return undefined;
    const { causes, fixes } = slowLoadCauses({
      volume: p.volume,
      cache: p.cache,
      pressureLevel: l.pressureLevel,
      swapUsedBytes: this.options.swapUsedBytes?.(),
    });
    const slow: ModelSlowLoadPayload = {
      model: p.model,
      roles: l.roles,
      volume: p.volume,
      bytes: p.bytes,
      cache: p.cache,
      loadMs: l.loadMs,
      boundMs,
      causes,
      fixes,
    };
    await this.write(SWAP_EVENTS.slowLoad, slow);
    this.options.log?.(describeSlowLoad(slow));
    return slow;
  }

  /** Record an unload (MD-N14-2). */
  public async unloaded(u: ModelUnloadedPayload): Promise<void> {
    await this.write(SWAP_EVENTS.unloaded, u);
    this.apply({ type: SWAP_EVENTS.unloaded, payload: u, at: this.options.now() });
  }

  /** Record the first reply after a load (MD-N14-2). */
  public async firstToken(f: ModelFirstTokenPayload): Promise<void> {
    await this.write(SWAP_EVENTS.firstToken, f);
  }
}
