import { execFileSync } from "node:child_process";

/**
 * Smart Swap's memory: space-aware co-residence (models rule 20g,
 * NEW-models-14, MD-N14-30–33a).
 *
 * A `HeadroomProbe` reads the host's memory measures; everything else here
 * is pure, so `decide()` (rule 20e) and the simulator (rule 20j) take a
 * `MemoryReading` in their snapshot and never read the host themselves.
 *
 * - **Headroom** is the lower of the GPU measure (`iogpu.wired_limit` − Metal
 *   in-use system memory − 1 GiB − the peak compute buffer) and the system
 *   measure (total − wired − anonymous − compressor-occupied − about 3 GB for
 *   macOS − the harness's peak).
 * - **Admission:** the footprint fits the headroom, the projected used ratio
 *   is at or below 0.80 on both measures, and swap is not growing.
 * - **No two large models** (a quarter of the GPU wired limit or more), and a
 *   GPU ceiling: seeded from recorded evidence until a calibration night
 *   records one, lowered by any recorded Metal timeout.
 * - **Cumulative feasibility:** every transition of a tour is checked.
 */

/** One process holding memory: ours (a server the harness started) or a person's own. */
export interface ProcessFootprint {
  pid: number;
  /** What a person calls it (`Hermes`, `Ollama (qwen3:8b)`, `llama-server`). */
  name: string;
  port?: number;
  /** `phys_footprint` (macOS `footprint -p`), or Ollama's reported size. */
  footprintBytes: number;
  /** Started by the harness; a person's own process is never unloaded (MD-N14-32). */
  ours: boolean;
  /** Epoch ms at which Ollama's keep-alive releases it (`/api/ps` `expires_at`). */
  expiresAt?: number;
}

/** The memory measures, read at one admission (MD-N14-30). Bytes throughout. */
export interface MemoryReading {
  /** Epoch ms of the reading. */
  at: number;
  /** `iogpu.wired_limit_mb`, or macOS's default share of memory when unset. */
  gpuWiredLimitBytes: number;
  /** ioreg `AGXAccelerator` `PerformanceStatistics` "In use system memory": every process's. */
  metalInUseBytes: number;
  totalBytes: number;
  wiredBytes: number;
  anonymousBytes: number;
  /** Pages occupied by the compressor. */
  compressorBytes: number;
  swapUsedBytes: number;
  /** The previous reading's swap, so admission sees whether swap grows. */
  previousSwapUsedBytes?: number;
  processes: ProcessFootprint[];
}

/** Reads the host's memory measures. `createDarwinHeadroomProbe` on macOS; `FakeHeadroomProbe` in tests. */
export interface HeadroomProbe {
  read(): Promise<MemoryReading>;
}

/** The D values of rule 20g (calibrated on the calibration nights, measurement rule 16d). */
export interface HeadroomParams {
  /** Kept free under the GPU wired limit. */
  gpuMarginBytes: number;
  /** Kept free for macOS. */
  macosReserveBytes: number;
  /** The peak of the harness, its language servers and tests. */
  harnessPeakBytes: number;
  /** Projected used ratio admitted on each measure (5 points under the watchdog's `elevated`). */
  admissionRatio: number;
  /** A model is large at this share of the GPU wired limit or more. */
  largeShare: number;
  /** A candidate's compute buffer when its adapter does not say. */
  defaultComputeBufferBytes: number;
}

export const HEADROOM_DEFAULTS: Readonly<HeadroomParams> = {
  gpuMarginBytes: 1024 ** 3,
  macosReserveBytes: 3e9,
  harnessPeakBytes: 2 * 1024 ** 3,
  admissionRatio: 0.8,
  largeShare: 0.25,
  defaultComputeBufferBytes: 512 * 1024 ** 2,
};

export interface Headroom {
  gpuBytes: number;
  systemBytes: number;
  /** The lower of the two. */
  bytes: number;
  binding: "gpu" | "system";
  /** Metal in-use memory. */
  gpuUsedBytes: number;
  /** wired + anonymous + compressor, at least what our servers' footprints hold. */
  systemUsedBytes: number;
}

/**
 * Used memory on the system measure. Our servers' memory-mapped weights can
 * hide as file-backed pages, outside the anonymous count, so their
 * `phys_footprint` sets a floor under it (rule 20g).
 */
function systemUsed(r: MemoryReading): number {
  const counted = r.wiredBytes + r.anonymousBytes + r.compressorBytes;
  const ours = r.processes.filter((p) => p.ours).reduce((n, p) => n + p.footprintBytes, 0);
  return Math.max(counted, ours);
}

/** Headroom at this reading (MD-N14-30): the lower of the GPU and system measures. */
export function measureHeadroom(
  r: MemoryReading,
  load: { computeBufferBytes?: number | undefined } = {},
  params: HeadroomParams = HEADROOM_DEFAULTS,
): Headroom {
  const computeBuffer = load.computeBufferBytes ?? params.defaultComputeBufferBytes;
  const gpuBytes = r.gpuWiredLimitBytes - r.metalInUseBytes - params.gpuMarginBytes - computeBuffer;
  const used = systemUsed(r);
  const systemBytes = r.totalBytes - used - params.macosReserveBytes - params.harnessPeakBytes;
  const binding = gpuBytes <= systemBytes ? "gpu" : "system";
  return {
    gpuBytes,
    systemBytes,
    bytes: Math.min(gpuBytes, systemBytes),
    binding,
    gpuUsedBytes: r.metalInUseBytes,
    systemUsedBytes: used,
  };
}

/** Large: a quarter of the GPU wired limit or more (rule 22, D). */
export function isLargeModel(
  footprintBytes: number,
  gpuWiredLimitBytes: number,
  params: Pick<HeadroomParams, "largeShare"> = HEADROOM_DEFAULTS,
): boolean {
  return footprintBytes >= params.largeShare * gpuWiredLimitBytes;
}

/**
 * The least host memory at which two models may co-reside, derived from
 * measured footprints rather than fixed at 32 GB (MD-N14-33): the two
 * largest, projected at the admission ratio, plus the reserves.
 */
export function coResidentMinBytes(
  footprints: readonly number[],
  params: HeadroomParams = HEADROOM_DEFAULTS,
): number {
  const [a = 0, b = 0] = [...footprints].sort((x, y) => y - x);
  return (a + b) / params.admissionRatio + params.macosReserveBytes + params.harnessPeakBytes;
}

/**
 * A GPU ceiling: a combined GPU footprint that is refused. `seed` refuses
 * above it; a recorded one (`metal_timeout`, `calibrated`) at or above it.
 */
export interface GpuCeiling {
  basis: "seed" | "calibrated" | "metal_timeout";
  bytes: number;
  /** The models of the co-residence that timed out. */
  models?: string[];
}

/**
 * The reference host's ceiling until calibration (MD-N14-33a): known-good,
 * the Worker at a 16K context (about 14.5 GB); known-bad, 11.8 GB + 3.85 GB
 * (15.65 GB), a Metal timeout; plus a 0.5 GB margin (D).
 */
export const GPU_CEILING_SEED: Readonly<
  GpuCeiling & { knownGoodBytes: number; knownBadBytes: number; marginBytes: number }
> = {
  basis: "seed",
  bytes: 15.0e9,
  knownGoodBytes: 14.5e9,
  knownBadBytes: 15.65e9,
  marginBytes: 0.5e9,
};

/** The event recording a GPU ceiling (registered structural only, MD-N14-40a). */
export const GPU_CEILING_EVENT = "model/gpu_ceiling";

/** The event recording a model Ollama serves requantised (rule 20h). */
export const REQUANTISED_EVENT = "model/requantised";

/**
 * The ceiling a co-residence that ended in a Metal command-buffer timeout
 * sets (MD-N14-33): its combined GPU footprint, naming its models. Record it
 * as a `model/gpu_ceiling` event; `gpuCeilingsFrom` reads it back.
 */
export function metalTimeoutCeiling(resident: readonly ResidentModel[]): GpuCeiling {
  return {
    basis: "metal_timeout",
    bytes: Math.round(resident.reduce((n, m) => n + m.footprintBytes, 0)),
    models: resident.map((m) => m.weights),
  };
}

/**
 * The ceilings in force from what is recorded: every Metal timeout's, plus
 * the latest calibrated one, else the seed (MD-N14-33, MD-N14-33a).
 */
export function gpuCeilingsFrom(recorded: readonly GpuCeiling[]): GpuCeiling[] {
  const timeouts = recorded.filter((c) => c.basis === "metal_timeout");
  const calibrated = recorded.filter((c) => c.basis === "calibrated").at(-1);
  return [...timeouts, calibrated ?? { ...GPU_CEILING_SEED }];
}

export interface LoadCandidate {
  weights: string;
  /** Weights + KV at its context and KV type + compute buffer; undefined refuses. */
  footprintBytes: number | undefined;
  computeBufferBytes?: number;
}

export interface ResidentModel {
  weights: string;
  footprintBytes: number;
}

export type AdmissionMeasure =
  | "gpu"
  | "system"
  | "swap"
  | "large_model"
  | "gpu_ceiling"
  | "unknown_footprint";

export type Admission =
  | { verdict: "admit"; headroom: Headroom }
  | { verdict: "refuse"; measure: AdmissionMeasure; reason: string; headroom?: Headroom }
  | { verdict: "wait"; untilMs: number; reason: string; headroom: Headroom };

const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;
const gb2 = (bytes: number): string => `${(bytes / 1e9).toFixed(2)} GB`;

/** `Hermes on 8080 holds 9.0 GB`: a person's own processes, named in a refusal (MD-N14-32). */
export function describeHolders(processes: readonly ProcessFootprint[]): string {
  return processes
    .filter((p) => !p.ours && p.footprintBytes > 0)
    .map(
      (p) =>
        `${p.name}${p.port !== undefined ? ` on ${p.port}` : ""} holds ${gb(p.footprintBytes)}`,
    )
    .join("; ");
}

/** The memory measures fail: which, and why; undefined when they admit (MD-N14-31). */
function memoryFails(
  r: MemoryReading,
  footprint: number,
  computeBufferBytes: number | undefined,
  params: HeadroomParams,
): { measure: "gpu" | "system"; why: string; headroom: Headroom } | { headroom: Headroom } {
  const headroom = measureHeadroom(r, { computeBufferBytes }, params);
  const gpuRatio = (r.metalInUseBytes + footprint) / r.gpuWiredLimitBytes;
  const sysRatio = (headroom.systemUsedBytes + footprint) / r.totalBytes;
  if (footprint > headroom.bytes) {
    const m = headroom.binding;
    const room = m === "gpu" ? headroom.gpuBytes : headroom.systemBytes;
    return {
      measure: m,
      why: `${gb(footprint)} exceeds the ${m === "gpu" ? "GPU" : "system"} headroom of ${gb(Math.max(0, room))}`,
      headroom,
    };
  }
  if (gpuRatio > params.admissionRatio)
    return {
      measure: "gpu",
      why: `the GPU measure would stand at ${gpuRatio.toFixed(2)} of the wired limit, above ${params.admissionRatio.toFixed(2)}`,
      headroom,
    };
  if (sysRatio > params.admissionRatio)
    return {
      measure: "system",
      why: `the system measure would stand at ${sysRatio.toFixed(2)} of memory, above ${params.admissionRatio.toFixed(2)}`,
      headroom,
    };
  return { headroom };
}

/** The reading once `gone` has released its memory (Ollama's keep-alive, waited out). */
function without(r: MemoryReading, gone: readonly ProcessFootprint[]): MemoryReading {
  const bytes = gone.reduce((n, p) => n + p.footprintBytes, 0);
  return {
    ...r,
    metalInUseBytes: Math.max(0, r.metalInUseBytes - bytes),
    anonymousBytes: Math.max(0, r.anonymousBytes - bytes),
    processes: r.processes.filter((p) => !gone.includes(p)),
  };
}

/**
 * Whether a load may start now (MD-N14-31–33a). Pure: the reading is the
 * probe's, taken at this admission. A refusal names the measure that
 * refused it and a person's own processes holding memory; a model Ollama
 * keeps alive is waited for when its expiry would let the load fit.
 */
export function admitLoad(input: {
  reading: MemoryReading;
  candidate: LoadCandidate;
  /** Our models resident now, by GPU footprint. */
  resident: readonly ResidentModel[];
  now: number;
  /** Default: the seed (`gpuCeilingsFrom([])`). */
  ceilings?: readonly GpuCeiling[];
  params?: HeadroomParams;
}): Admission {
  const { reading: r, candidate: c } = input;
  const params = input.params ?? HEADROOM_DEFAULTS;
  const who = `the load of ${c.weights}`;
  const holders = describeHolders(r.processes);
  const naming = holders ? ` (${holders})` : "";
  if (c.footprintBytes === undefined)
    return {
      verdict: "refuse",
      measure: "unknown_footprint",
      reason: `Refusing ${who}: its footprint is unknown, so it cannot be shown to fit; the work stays queued.`,
    };
  const footprint = c.footprintBytes;
  const others = input.resident.filter((m) => m.weights !== c.weights);

  // Rule 22: a second large model is always refused, whatever the headroom shows.
  if (isLargeModel(footprint, r.gpuWiredLimitBytes, params)) {
    const large = others.find((m) => isLargeModel(m.footprintBytes, r.gpuWiredLimitBytes, params));
    if (large)
      return {
        verdict: "refuse",
        measure: "large_model",
        reason: `Refusing ${who}: ${c.weights} (${gb(footprint)}) and ${large.weights} (${gb(large.footprintBytes)}) are both large models, and two are never resident at once; the work stays queued.`,
      };
  }

  // The GPU ceiling: recorded ones first (they name the models), then the seed.
  const combined = footprint + others.reduce((n, m) => n + m.footprintBytes, 0);
  const names = [...others.map((m) => m.weights), c.weights].join(" + ");
  const ceilings = [...(input.ceilings ?? gpuCeilingsFrom([]))].sort(
    (a, b) => Number(a.basis === "seed") - Number(b.basis === "seed"),
  );
  // A ceiling bounds a co-residence: one model alone is bounded by the headroom.
  for (const ceiling of others.length > 0 ? ceilings : []) {
    const over = ceiling.basis === "seed" ? combined > ceiling.bytes : combined >= ceiling.bytes;
    if (!over) continue;
    const source =
      ceiling.basis === "seed"
        ? `the seeded GPU ceiling of ${gb2(ceiling.bytes)} (known-good ${gb2(GPU_CEILING_SEED.knownGoodBytes)} plus ${gb2(GPU_CEILING_SEED.marginBytes)}; known-bad ${gb2(GPU_CEILING_SEED.knownBadBytes)}, a Metal timeout)`
        : ceiling.basis === "metal_timeout"
          ? `this host's GPU ceiling of ${gb2(ceiling.bytes)}, where ${(ceiling.models ?? []).join(" + ")} timed out in Metal`
          : `this host's calibrated GPU ceiling of ${gb2(ceiling.bytes)}`;
    return {
      verdict: "refuse",
      measure: "gpu_ceiling",
      reason: `Refusing ${who}: ${names} would hold ${gb2(combined)} of GPU memory, at or above ${source}; the work stays queued.`,
    };
  }

  if (r.previousSwapUsedBytes !== undefined && r.swapUsedBytes > r.previousSwapUsedBytes)
    return {
      verdict: "refuse",
      measure: "swap",
      reason: `Refusing ${who}: swap grew from ${gb(r.previousSwapUsedBytes)} to ${gb(r.swapUsedBytes)} between the last two readings${naming}; the work stays queued.`,
    };

  const now = memoryFails(r, footprint, c.computeBufferBytes, params);
  if (!("measure" in now)) return { verdict: "admit", headroom: now.headroom };

  // A model Ollama keeps alive: wait for its expiry when that lets the load fit (MD-N14-32).
  const expiring = r.processes
    .filter((p) => !p.ours && p.expiresAt !== undefined && p.expiresAt > input.now)
    .sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number));
  for (let i = 1; i <= expiring.length; i++) {
    const gone = expiring.slice(0, i);
    const later = memoryFails(without(r, gone), footprint, c.computeBufferBytes, params);
    if (!("measure" in later)) {
      const until = gone.at(-1)?.expiresAt as number;
      return {
        verdict: "wait",
        untilMs: until,
        reason: `Waiting to load ${c.weights}: ${gone.map((p) => p.name).join(", ")} keeps ${gb(gone.reduce((n, p) => n + p.footprintBytes, 0))} alive until ${new Date(until).toISOString()}.`,
        headroom: now.headroom,
      };
    }
  }
  return {
    verdict: "refuse",
    measure: now.measure,
    reason: `Refusing ${who}: ${now.why}${naming}; the work stays queued.`,
    headroom: now.headroom,
  };
}

/** What a model holds, by part (MD-N14-31a). */
export interface ResidentParts {
  id: string;
  weights: number;
  kv: number;
  /** Compute buffers. */
  engine: number;
  promptCache: number;
}

export type Part = "weights" | "kv" | "engine" | "promptCache";

/** One transition of a tour. */
export type Transition =
  | ({ kind: "load" } & ResidentParts)
  /** Release every part except `keep` (a slot save still holding the KV, say). */
  | { kind: "unload"; id: string; keep?: Part[] }
  /** Release what `unload` kept. */
  | { kind: "release"; id: string }
  /** A slot restore adds KV to a resident model. */
  | { kind: "restore"; id: string; kv: number };

const sumParts = (m: Omit<ResidentParts, "id">): number =>
  m.weights + m.kv + m.engine + m.promptCache;

/**
 * Cumulative feasibility (MD-N14-31a): each transition is checked against
 * what would be resident at that moment — weights + KV + engine state +
 * prompt cache — not only the end state. `failedAt` is the first step that
 * would not fit.
 */
export function checkTransitions(input: {
  limitBytes: number;
  resident: readonly ResidentParts[];
  steps: readonly Transition[];
}): { feasible: boolean; failedAt?: number; peakBytes: number; endBytes: number } {
  const held = new Map<string, Omit<ResidentParts, "id">>(
    input.resident.map(({ id, ...parts }) => [id, { ...parts }]),
  );
  const total = () => [...held.values()].reduce((n, m) => n + sumParts(m), 0);
  let peak = total();
  let failedAt: number | undefined = peak > input.limitBytes ? -1 : undefined;
  input.steps.forEach((step, i) => {
    if (step.kind === "load") {
      const { kind: _k, id, ...parts } = step;
      held.set(id, parts);
    } else if (step.kind === "unload") {
      const m = held.get(step.id);
      if (m) {
        const keep = new Set(step.keep ?? []);
        held.set(step.id, {
          weights: keep.has("weights") ? m.weights : 0,
          kv: keep.has("kv") ? m.kv : 0,
          engine: keep.has("engine") ? m.engine : 0,
          promptCache: keep.has("promptCache") ? m.promptCache : 0,
        });
      }
    } else if (step.kind === "release") {
      held.delete(step.id);
    } else {
      const m = held.get(step.id);
      if (m) m.kv += step.kv;
      else held.set(step.id, { weights: 0, kv: step.kv, engine: 0, promptCache: 0 });
    }
    const now = total();
    peak = Math.max(peak, now);
    if (failedAt === undefined && now > input.limitBytes) failedAt = i;
  });
  return {
    feasible: failedAt === undefined,
    ...(failedAt !== undefined ? { failedAt } : {}),
    peakBytes: peak,
    endBytes: total(),
  };
}

/** Replays readings in order, repeating the last; `set` changes what comes next. */
export class FakeHeadroomProbe implements HeadroomProbe {
  private readonly readings: MemoryReading[];
  public reads = 0;

  constructor(readings: MemoryReading | MemoryReading[]) {
    this.readings = Array.isArray(readings) ? [...readings] : [readings];
  }

  public async read(): Promise<MemoryReading> {
    this.reads++;
    const next = this.readings.length > 1 ? this.readings.shift() : this.readings[0];
    if (!next) throw new Error("FakeHeadroomProbe has no reading");
    return { ...next, processes: [...next.processes] };
  }

  /** Replace what the next reads return. */
  public set(reading: MemoryReading): void {
    this.readings.splice(0, this.readings.length, reading);
  }
}

/** Runs a read-only command; injectable for tests. */
export type ProbeExec = (cmd: string, args: string[]) => string | Promise<string>;

const defaultExec: ProbeExec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });

export interface DarwinProbeOptions {
  exec?: ProbeExec;
  now?: () => number;
  /** Ports whose listening process is measured by pid: ours (servers we manage) or a person's own. */
  watch: { port: number; name: string; ours: boolean }[];
  /** A local Ollama whose models are read from `/api/ps` (size and keep-alive expiry). */
  ollamaUrl?: string;
}

const UNIT: Readonly<Record<string, number>> = {
  B: 1,
  K: 1024,
  KB: 1024,
  M: 1024 ** 2,
  MB: 1024 ** 2,
  G: 1024 ** 3,
  GB: 1024 ** 3,
};

/** `vm_stat`'s count for a label, in bytes. */
function vmStat(out: string, label: string, pageSize: number): number {
  const m = new RegExp(`${label}:\\s+(\\d+)`).exec(out);
  return m ? Number(m[1]) * pageSize : 0;
}

/**
 * The macOS probe: `sysctl` (the GPU wired limit, memory, swap), `vm_stat`
 * (wired, anonymous, compressor), ioreg `AGXAccelerator` (Metal in-use
 * memory), `lsof` and `footprint -p` (each watched port's process by pid,
 * its `phys_footprint`) and Ollama's `/api/ps`. Every call is read-only.
 */
export function createDarwinHeadroomProbe(options: DarwinProbeOptions): HeadroomProbe {
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  let lastSwap: number | undefined;
  const run = async (cmd: string, args: string[]): Promise<string> => {
    try {
      return await exec(cmd, args);
    } catch {
      return "";
    }
  };
  const pidOn = async (port: number): Promise<number | undefined> => {
    const out = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    const pid = Number.parseInt(out.trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(pid) ? pid : undefined;
  };
  const footprintOf = async (pid: number): Promise<number | undefined> => {
    const out = await run("footprint", ["-p", String(pid)]);
    const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB)/.exec(out);
    return m ? Math.round(Number(m[1]) * (UNIT[m[2] as string] ?? 1)) : undefined;
  };
  return {
    async read(): Promise<MemoryReading> {
      const totalBytes = Number((await run("sysctl", ["-n", "hw.memsize"])).trim()) || 0;
      const limitMb = Number((await run("sysctl", ["-n", "iogpu.wired_limit_mb"])).trim()) || 0;
      // Unset (0): macOS lets the GPU wire about two thirds of memory up to 36 GB, three quarters above.
      const gpuWiredLimitBytes =
        limitMb > 0
          ? limitMb * 1024 ** 2
          : Math.round(totalBytes * (totalBytes <= 36 * 1024 ** 3 ? 2 / 3 : 3 / 4));
      const vm = await run("vm_stat", []);
      const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1] ?? 16384);
      const swapOut = await run("sysctl", ["-n", "vm.swapusage"]);
      const swap = /used\s*=\s*([\d.]+)([KMG])/i.exec(swapOut);
      const swapUsedBytes = swap
        ? Math.round(Number(swap[1]) * (UNIT[(swap[2] as string).toUpperCase()] ?? 1))
        : 0;
      const ioreg = await run("ioreg", ["-r", "-c", "AGXAccelerator", "-d", "1", "-w", "0"]);
      const metal = [...ioreg.matchAll(/"In use system memory"=(\d+)/g)].map((m) => Number(m[1]));
      const processes: ProcessFootprint[] = [];
      for (const w of options.watch) {
        const pid = await pidOn(w.port);
        if (pid === undefined) continue;
        const bytes = await footprintOf(pid);
        if (bytes === undefined) continue;
        processes.push({ pid, name: w.name, port: w.port, footprintBytes: bytes, ours: w.ours });
      }
      if (options.ollamaUrl) {
        try {
          const res = await fetch(`${options.ollamaUrl}/api/ps`, {
            signal: AbortSignal.timeout(2000),
          });
          const body = (await res.json()) as {
            models?: { name?: string; size?: number; size_vram?: number; expires_at?: string }[];
          };
          const port = Number(new URL(options.ollamaUrl).port || 11434);
          const pid = await pidOn(port);
          for (const m of body.models ?? []) {
            const expires = m.expires_at ? Date.parse(m.expires_at) : Number.NaN;
            processes.push({
              pid: pid ?? 0,
              name: `Ollama (${m.name ?? "?"})`,
              port,
              footprintBytes: m.size_vram || m.size || 0,
              ours: false,
              ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
            });
          }
        } catch {
          // No Ollama answering: nothing of it is resident.
        }
      }
      const reading: MemoryReading = {
        at: now(),
        gpuWiredLimitBytes,
        metalInUseBytes: metal.length ? Math.max(...metal) : 0,
        totalBytes,
        wiredBytes: vmStat(vm, "Pages wired down", pageSize),
        anonymousBytes: vmStat(vm, "Anonymous pages", pageSize),
        compressorBytes: vmStat(vm, "Pages occupied by compressor", pageSize),
        swapUsedBytes,
        ...(lastSwap !== undefined ? { previousSwapUsedBytes: lastSwap } : {}),
        processes,
      };
      lastSwap = swapUsedBytes;
      return reading;
    },
  };
}
