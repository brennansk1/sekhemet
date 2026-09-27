import { createReadStream, existsSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, sep } from "node:path";
import {
  type CacheState,
  LOAD_OVERHEAD_MS,
  type LoadPrediction,
  type SwapCostBook,
  type SwapCostTracker,
  type Volume,
  percentile,
} from "./swap_cost.js";

/**
 * Smart Swap's load mechanics, chosen by measurement (models rule 20h,
 * NEW-models-14, MD-N14-9, MD-N14-10, MD-N14-34, MD-N14-35).
 *
 * - **The load mode** per volume and engine — mmap, `--no-mmap`, or a
 *   sequential pre-read then mmap — is chosen by an A/B of at least three
 *   loads per mode recorded on the ledger; until one is, mmap.
 * - **The read probe:** a 256 MB sequential read of the volume replaces the
 *   stated default read rates, plus the drive's spin-up when it had spun
 *   down (a small timed read), as an estimate of ±50%.
 * - **Cold or warm is measured** after the fact, by the load's effective
 *   read rate against the volume's cold rate. A page-cache residency helper
 *   (`mincore`) would need a native build (a compiler on the host), so the
 *   read-rate classification is used instead (MD-N14-10's fallback).
 * - **Guards:** no `--mlock` and no direct I/O; `--cache-ram` sized from the
 *   headroom; `--fit`'s silent context shrink refused; a disconnected drive
 *   refused before a load, the work kept queued; an Ollama model whose
 *   served quantisation or hash differs from the file flagged requantised.
 */

export type Engine = "llama.cpp" | "ollama" | "mlx";
export type LoadMode = "mmap" | "no_mmap" | "preread_mmap";
export const LOAD_MODES: readonly LoadMode[] = ["mmap", "no_mmap", "preread_mmap"];

/** What the scheduler passes an adapter's `load()` (the adapter's load options). */
export interface LoadOptions {
  /** Default `mmap` (rule 20h, until an A/B is recorded). */
  loadMode?: LoadMode;
  /** `--cache-ram`, MiB, sized from the headroom (`cacheRamMiBFromHeadroom`). */
  cacheRamMiB?: number;
}

/** The event a finished load-mode A/B records (registered structural only, MD-N14-40a). */
export const LOAD_MODE_AB_EVENT = "model/load_mode_ab";

/** Loads per mode before an A/B decides (MD-N14-34). */
export const AB_MIN_LOADS_PER_MODE = 3;
/** The read probe's size (MD-N14-9). */
export const READ_PROBE_BYTES = 256 * 1024 ** 2;
/** A probe estimate's stated spread: ±50%. */
export const PROBE_SPREAD = 0.5;
/** A small read slower than this means the drive was spun down. */
export const SPIN_UP_THRESHOLD_MS = 1000;
/** A load whose effective read rate is at least this multiple of the cold rate was warm. */
export const WARM_RATE_FACTOR = 2;

/** The launch arguments a load mode adds: only `--no-mmap` adds one. */
export function loadModeArgs(mode: LoadMode | undefined): string[] {
  return mode === "no_mmap" ? ["--no-mmap"] : [];
}

/** The A/B's order: the modes alternating, `perMode` loads each (MD-N14-34). */
export function abOrder(
  modes: readonly LoadMode[] = LOAD_MODES,
  perMode = AB_MIN_LOADS_PER_MODE,
): LoadMode[] {
  const order: LoadMode[] = [];
  for (let i = 0; i < perMode; i++) order.push(...modes);
  return order;
}

export interface AbLoad {
  mode: LoadMode;
  loadMs: number;
  firstTokenMs: number;
}

export interface AbModeResult {
  mode: LoadMode;
  loads: number;
  medianLoadMs: number;
  medianFirstTokenMs: number;
  medianTotalMs: number;
}

/**
 * The mode with the lowest median load plus first-token time; with fewer
 * than three loads of any mode tried, nothing is decided and mmap stays.
 */
export function chooseLoadMode(loads: readonly AbLoad[]): {
  mode: LoadMode;
  decided: boolean;
  modes: AbModeResult[];
} {
  const tried = LOAD_MODES.filter((m) => loads.some((l) => l.mode === m));
  const modes = tried.map((mode) => {
    const mine = loads.filter((l) => l.mode === mode);
    return {
      mode,
      loads: mine.length,
      medianLoadMs: percentile(
        mine.map((l) => l.loadMs),
        0.5,
      ),
      medianFirstTokenMs: percentile(
        mine.map((l) => l.firstTokenMs),
        0.5,
      ),
      medianTotalMs: percentile(
        mine.map((l) => l.loadMs + l.firstTokenMs),
        0.5,
      ),
    };
  });
  const decided = modes.length >= 2 && modes.every((m) => m.loads >= AB_MIN_LOADS_PER_MODE);
  if (!decided) return { mode: "mmap", decided, modes };
  const best = [...modes].sort((a, b) => a.medianTotalMs - b.medianTotalMs)[0] as AbModeResult;
  return { mode: best.mode, decided, modes };
}

/** The `model/load_mode_ab` payload: structural only. */
export interface LoadModeAbPayload {
  model: string;
  volume: Volume;
  engine: Engine;
  modes: AbModeResult[];
  decided: boolean;
  chosen: LoadMode;
  /**
   * The cache state the modes were compared in, measured per load by its
   * read rate (live-test F13): alternating modes on one file reload it from
   * the page cache, so an A/B that could not empty the cache compares warm
   * loads, and says so.
   */
  cache?: CacheState | "mixed";
}

/**
 * The mode for a volume and engine: the latest decided A/B's that compared
 * cold loads, else mmap (MD-N14-34). A warm or mixed comparison says nothing
 * about the slow cold load the mode exists for (live-test F13).
 */
export function loadModeFor(
  records: readonly LoadModeAbPayload[],
  volume: Volume,
  engine: Engine,
): LoadMode {
  const last = records
    .filter((r) => r.decided && r.cache === "cold" && r.volume === volume && r.engine === engine)
    .at(-1);
  return last?.chosen ?? "mmap";
}

/**
 * Cold or warm, measured after a load by its effective read rate against
 * the volume's cold rate (MD-N14-10).
 */
export function classifyCacheByReadRate(l: {
  bytes: number;
  loadMs: number;
  coldBytesPerSecond: number;
  overheadMs?: number;
}): CacheState {
  const seconds = Math.max(1, l.loadMs - (l.overheadMs ?? LOAD_OVERHEAD_MS)) / 1000;
  return l.bytes / seconds >= WARM_RATE_FACTOR * l.coldBytesPerSecond ? "warm" : "cold";
}

/**
 * Run a load-mode A/B (MD-N14-34): the modes alternate on the same weights,
 * each load recorded through the tracker with its engine, mode and measured
 * cache state, its first token and its unload; then the A/B itself.
 * Loads nothing by itself: `load`, `firstToken`, `unload` and
 * `confirmUnloaded` are the caller's (a calibration night's, F13).
 *
 * - `firstToken` returns the true first token when the request streamed;
 *   otherwise the request's whole time is recorded as the reply time, not a
 *   first token (F14), and stands in for it only in the mode comparison.
 * - Only `unload` is timed; `confirmUnloaded` runs after the timer, and its
 *   answer is what `confirmed` records (MD-N14-2a).
 * - `evictCache`, when given, empties the page cache of the file before each
 *   load so the modes compare cold loads; either way the cache state each
 *   load was measured in is recorded, and the A/B's `cache` says whether it
 *   compared cold, warm or mixed loads.
 */
export async function runLoadModeAb(input: {
  model: string;
  roles: string[];
  volume: Volume;
  engine: Engine;
  bytes: number;
  /** The volume's cold read rate (a probe or history), for the cache state. */
  coldBytesPerSecond: number;
  tracker: SwapCostTracker;
  now: () => number;
  load: (mode: LoadMode) => Promise<void>;
  /** The true first token when the request streamed; anything else is none. */
  firstToken: () => Promise<unknown>;
  unload: () => Promise<void>;
  confirmUnloaded?: () => Promise<boolean>;
  evictCache?: () => Promise<void>;
  record: (event: { type: string; payload: LoadModeAbPayload }) => void | Promise<void>;
  modes?: readonly LoadMode[];
  perMode?: number;
}): Promise<LoadModeAbPayload> {
  const loads: AbLoad[] = [];
  const caches = new Set<CacheState>();
  for (const mode of abOrder(input.modes, input.perMode)) {
    const prediction = input.tracker.book.predict({
      model: input.model,
      volume: input.volume,
      cache: "cold",
      bytes: input.bytes,
    });
    await input.evictCache?.();
    const start = input.now();
    await input.load(mode);
    const loadMs = input.now() - start;
    const cache = classifyCacheByReadRate({
      bytes: input.bytes,
      loadMs,
      coldBytesPerSecond: input.coldBytesPerSecond,
    });
    caches.add(cache);
    await input.tracker.loaded({
      prediction,
      roles: input.roles,
      loadMs,
      pressureLevel: undefined,
      engine: input.engine,
      loadMode: mode,
      cache,
    });
    const asked = input.now();
    const measured = await input.firstToken();
    const replyMs = input.now() - asked;
    const firstTokenMs = typeof measured === "number" ? measured : undefined;
    await input.tracker.firstToken({
      model: input.model,
      roles: input.roles,
      ...(firstTokenMs !== undefined ? { firstTokenMs } : { replyMs }),
    });
    const unloadStart = input.now();
    await input.unload();
    const unloadMs = input.now() - unloadStart;
    const confirmed = (await input.confirmUnloaded?.()) ?? false;
    await input.tracker.unloaded({
      model: input.model,
      roles: input.roles,
      volume: input.volume,
      bytes: input.bytes,
      unloadMs,
      confirmed,
    });
    loads.push({ mode, loadMs, firstTokenMs: firstTokenMs ?? replyMs });
  }
  const chosen = chooseLoadMode(loads);
  const payload: LoadModeAbPayload = {
    model: input.model,
    volume: input.volume,
    engine: input.engine,
    modes: chosen.modes,
    decided: chosen.decided,
    chosen: chosen.mode,
    cache: caches.size === 1 ? ([...caches][0] as CacheState) : "mixed",
  };
  await input.record({ type: LOAD_MODE_AB_EVENT, payload });
  return payload;
}

/** Read a file start to end in large sequential chunks: the pre-read of `preread_mmap`. */
export async function prereadSequential(
  path: string,
  options: { chunkBytes?: number; signal?: AbortSignal } = {},
): Promise<{ bytes: number }> {
  let bytes = 0;
  const stream = createReadStream(path, {
    highWaterMark: options.chunkBytes ?? 8 * 1024 ** 2,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  return { bytes };
}

export interface ReadProbeResult {
  bytesRead: number;
  ms: number;
  bytesPerSecond: number;
}

/**
 * A sequential read of up to 256 MB of a file on the volume, timed
 * (MD-N14-9). What the OS file cache already holds reads faster than the
 * disk, so a probe of recently loaded weights overstates the rate; the
 * probe is taken once per volume, before a load, and labelled an estimate.
 */
export async function readProbe(
  path: string,
  options: { bytes?: number; now?: () => number; chunkBytes?: number } = {},
): Promise<ReadProbeResult> {
  const now = options.now ?? Date.now;
  const limit = options.bytes ?? READ_PROBE_BYTES;
  const handle = await open(path, "r");
  const buffer = Buffer.allocUnsafe(options.chunkBytes ?? 8 * 1024 ** 2);
  let bytesRead = 0;
  const start = now();
  try {
    while (bytesRead < limit) {
      const { bytesRead: n } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, limit - bytesRead),
        bytesRead,
      );
      if (n === 0) break;
      bytesRead += n;
    }
  } finally {
    await handle.close();
  }
  const ms = Math.max(1, now() - start);
  return { bytesRead, ms, bytesPerSecond: Math.round(bytesRead / (ms / 1000)) };
}

export type DriveState = "ready" | "spun_down" | "disconnected" | "missing";

/** A load refused because its drive is not connected: the work stays queued (MD-N14-35). */
export class DriveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveUnavailableError";
  }
}

/**
 * The weights' drive, checked before a load (rule 20h): the file present
 * and a small timed read. A path under a mount point that is gone is
 * `disconnected`; a slow small read is `spun_down`, its time the spin-up.
 */
export async function checkDrive(
  path: string,
  options: { now?: () => number; thresholdMs?: number; volumesRoot?: string } = {},
): Promise<{ state: DriveState; spinUpMs?: number; reason?: string }> {
  const now = options.now ?? Date.now;
  const root = options.volumesRoot ?? "/Volumes";
  if (!existsSync(path)) {
    const prefix = `${root}${sep}`;
    if (path.startsWith(prefix)) {
      const name = path.slice(prefix.length).split(sep)[0] ?? "";
      if (name && !existsSync(`${prefix}${name}`))
        return {
          state: "disconnected",
          reason: `the drive "${name}" that holds ${basename(path)} is not connected; the work stays queued until it is`,
        };
    }
    return { state: "missing", reason: `the weights file ${basename(path)} is missing` };
  }
  const size = statSync(path).size;
  const small = 4096;
  const offset = size > small ? Math.floor((Math.random() * (size - small)) / small) * small : 0;
  const start = now();
  const handle = await open(path, "r");
  try {
    await handle.read(Buffer.alloc(small), 0, Math.min(small, size), offset);
  } finally {
    await handle.close();
  }
  const ms = now() - start;
  return ms >= (options.thresholdMs ?? SPIN_UP_THRESHOLD_MS)
    ? { state: "spun_down", spinUpMs: ms }
    : { state: "ready" };
}

export type ProbedPrediction = LoadPrediction & {
  /** Where the read rate came from. */
  rateBasis: "measured" | "warm" | "volume_history" | "probe" | "default";
  /** The spread stated with a probe estimate (±50%). */
  spread?: number;
  /** A spun-down drive's measured spin-up, included. */
  spinUpMs?: number;
};

/**
 * A prediction with the probe (MD-N14-9, MD-N14-35): a cold load with no
 * measured history and no measured rate for the volume is estimated from
 * the probe's rate instead of the stated default, ±50%; a spun-down drive's
 * spin-up is added to any cold prediction. With no probe, the stated rates.
 */
export function predictWithProbe(
  base: LoadPrediction,
  book: SwapCostBook,
  probe: { bytesPerSecond: number; spinUpMs?: number } | undefined,
): ProbedPrediction {
  const spinUp = base.cache === "cold" && probe?.spinUpMs ? probe.spinUpMs : 0;
  const plus = (p: LoadPrediction) => ({
    ...p,
    medianMs: p.medianMs + spinUp,
    p90Ms: p.p90Ms + spinUp,
    ...(spinUp ? { spinUpMs: spinUp } : {}),
  });
  if (base.basis === "measured") return { ...plus(base), rateBasis: "measured" };
  if (base.cache === "warm") return { ...base, rateBasis: "warm" };
  if (book.readRate(base.volume).basis === "measured")
    return { ...plus(base), rateBasis: "volume_history" };
  if (!probe) return { ...base, rateBasis: "default" };
  const estimate = Math.round(
    LOAD_OVERHEAD_MS + (base.bytes / probe.bytesPerSecond) * 1000 + spinUp,
  );
  return {
    ...base,
    medianMs: estimate,
    p90Ms: estimate,
    basis: "estimate",
    rateBasis: "probe",
    spread: PROBE_SPREAD,
    ...(spinUp ? { spinUpMs: spinUp } : {}),
  };
}

/** `--mlock` crashes on macOS, and no direct I/O is used (rule 20h). Throws naming the flag. */
export function assertLaunchFlags(args: readonly string[]): void {
  if (args.includes("--mlock"))
    throw new Error("--mlock is never passed: it crashes on macOS (models rule 20h)");
  const dio = args.find((a) => a === "--direct-io" || a === "-dio" || a === "--dio");
  if (dio) throw new Error(`${dio}: no direct I/O is used (models rule 20h)`);
}

/**
 * `--cache-ram` from the headroom (rule 20h): half of what the headroom
 * leaves after the model's footprint, up to 4 GiB, never llama-server's
 * 8 GiB default.
 */
export function cacheRamMiBFromHeadroom(
  headroomBytes: number,
  footprintBytes: number,
  options: { share?: number; maxMiB?: number } = {},
): number {
  const spare = headroomBytes - footprintBytes;
  if (spare <= 0) return 0;
  const mib = Math.floor((spare * (options.share ?? 0.5)) / 1024 ** 2);
  return Math.min(options.maxMiB ?? 4096, mib);
}

/** A server serving less context than requested: `--fit` shrank it (MD-M4-1). */
export class ContextShrinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextShrinkError";
  }
}

/** Refuse a server whose served context is smaller than requested (rule 20h, MD-M4-1). */
export function assertServedContext(requested: number, served: number | undefined): void {
  if (served !== undefined && served < requested)
    throw new ContextShrinkError(
      `the server serves a context of ${served} tokens, not the ${requested} requested (--fit shrinks it silently); refusing it (MD-M4-1)`,
    );
}

/**
 * Whether Ollama serves a model requantised (rule 20h): its served
 * quantisation (`/api/show`) or blob digest (`/api/tags`) differs from the
 * file's. Ollama silently requantises an IQ3_XXS file.
 */
export async function checkOllamaQuantisation(
  baseUrl: string,
  modelId: string,
  file: { quant?: string; sha256?: string },
): Promise<{ requantised: boolean; servedQuant?: string; servedDigest?: string; reason?: string }> {
  let servedQuant: string | undefined;
  let servedDigest: string | undefined;
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { details?: { quantization_level?: string } };
    servedQuant = body.details?.quantization_level;
  } catch {
    // Unknown: not flagged on this ground.
  }
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as {
      models?: { name?: string; model?: string; digest?: string }[];
    };
    const m = (body.models ?? []).find((x) => x.name === modelId || x.model === modelId);
    servedDigest = m?.digest?.replace(/^sha256:/, "");
  } catch {
    // Unknown.
  }
  const norm = (q: string) => q.toUpperCase();
  const quantDiffers =
    file.quant !== undefined && servedQuant !== undefined && norm(file.quant) !== norm(servedQuant);
  const hashDiffers =
    file.sha256 !== undefined && servedDigest !== undefined && file.sha256 !== servedDigest;
  const reason = quantDiffers
    ? `Ollama serves ${modelId} as ${servedQuant}, but the file is ${file.quant}: it was requantised; prefer llama-server where exact weights matter`
    : hashDiffers
      ? `Ollama serves ${modelId} with another weights hash than the file's: it was requantised or changed; prefer llama-server where exact weights matter`
      : undefined;
  return {
    requantised: quantDiffers || hashDiffers,
    ...(servedQuant !== undefined ? { servedQuant } : {}),
    ...(servedDigest !== undefined ? { servedDigest } : {}),
    ...(reason ? { reason } : {}),
  };
}

export interface VolumeProbeResult {
  state: DriveState;
  reason?: string;
  /** The volume's probed sequential read rate; undefined when no probe could run. */
  bytesPerSecond?: number;
  spinUpMs?: number;
}

/**
 * The drive checked before every load, and the 256 MB read probe run once
 * per volume (by device) and remembered (MD-N14-9, MD-N14-35).
 */
export class VolumeProber {
  private readonly rates = new Map<string, number>();

  constructor(
    private readonly fns: { readProbe?: typeof readProbe; checkDrive?: typeof checkDrive } = {},
  ) {}

  public async probe(path: string, volume: Volume): Promise<VolumeProbeResult> {
    const drive = await (this.fns.checkDrive ?? checkDrive)(path);
    if (drive.state === "disconnected" || drive.state === "missing") return drive;
    const id = `${volume}:${statSync(path).dev}`;
    let rate = this.rates.get(id);
    if (rate === undefined) {
      try {
        rate = (await (this.fns.readProbe ?? readProbe)(path)).bytesPerSecond;
        this.rates.set(id, rate);
      } catch {
        // No probe could run: the stated rates stand.
      }
    }
    return { ...drive, ...(rate !== undefined ? { bytesPerSecond: rate } : {}) };
  }
}
