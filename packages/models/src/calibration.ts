import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ModelRegistry, ThinkingPolicy } from "./registry.js";
import type { InferenceRequest, LocalInferenceAdapter, TokenUsage } from "./types.js";

/**
 * Hardware calibration, tier profiles and throughput floors (M13, M14, M15),
 * speculative-decoding and engine decisions by measurement (M19, M24).
 * Design: "Hardware calibration, tier profiles, and inference configuration".
 * The harness measures the machine; it never asks the user to pick a model
 * or a context size.
 */

const GB = 1024 ** 3;

export interface HardwareFingerprint {
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalBytes: number;
}

export function hardwareFingerprint(): HardwareFingerprint {
  const list = cpus();
  return {
    platform: platform(),
    arch: arch(),
    cpuModel: list[0]?.model ?? "unknown",
    cpuCount: list.length,
    totalBytes: totalmem(),
  };
}

export function fingerprintHash(fp: HardwareFingerprint): string {
  return createHash("sha256")
    .update(`${fp.platform}|${fp.arch}|${fp.cpuModel}|${fp.cpuCount}|${fp.totalBytes}`)
    .digest("hex")
    .slice(0, 16);
}

/** This host's fingerprint hash (re-calibrate when it changes). */
export function hostFingerprintHash(): string {
  return fingerprintHash(hardwareFingerprint());
}

// ---------------------------------------------------------------- tiers (M14)

export type MachineTier = "S" | "M" | "L" | "XL";

export interface TierProfile {
  tier: MachineTier;
  /** Memory budget range this tier covers, GB (inclusive lower bound). */
  budgetGb: [number, number];
  planner: string;
  executor: string;
  coLoaded: "n/a" | "no" | "yes" | "yes+verifier+vision";
  /** Working context, tokens (lo, hi). Stays well below the window at every tier. */
  workingContext: [number, number];
  parallelCards: [number, number];
}

/** The design's tier table, verbatim. Model names are absent on purpose. */
export const TIER_PROFILES: Record<MachineTier, TierProfile> = {
  S: {
    tier: "S",
    budgetGb: [16, 24],
    planner: "same model, planning mode",
    executor: "small MoE (~3B active)",
    coLoaded: "n/a",
    workingContext: [12_288, 16_384],
    parallelCards: [1, 1],
  },
  M: {
    tier: "M",
    budgetGb: [24, 48],
    planner: "dense, swapped on schedule",
    executor: "~30B-A3B MoE",
    coLoaded: "no",
    workingContext: [16_384, 24_576],
    parallelCards: [1, 1],
  },
  L: {
    tier: "L",
    budgetGb: [48, 96],
    planner: "dense or mid MoE",
    executor: "~30B MoE",
    coLoaded: "yes",
    workingContext: [24_576, 32_768],
    parallelCards: [1, 2],
  },
  XL: {
    tier: "XL",
    budgetGb: [96, Number.POSITIVE_INFINITY],
    planner: "large MoE",
    executor: "~30B MoE",
    coLoaded: "yes+verifier+vision",
    workingContext: [32_768, 49_152],
    parallelCards: [2, 4],
  },
};

/**
 * Below this, roles are swapped rather than held together, whatever the tier
 * table's co-loading column says. Two ~14 GB checkpoints plus the OS, the
 * sandbox and the gates is how the reference machine ran out of memory.
 */
export const CO_RESIDENT_MIN_BYTES = 32 * GB;

/** What the tier actually decides for a run (M14). */
export interface TierSettings {
  tier: MachineTier;
  /** Tokens a card's prompt may fill; a ceiling, never a target. */
  workingContextTokens: number;
  /** Cards that may run at once on this machine. */
  parallelCards: number;
  /** May two roles' weights be resident at the same time? */
  coLoadRoles: boolean;
  reason: string;
}

/**
 * The tier's numbers for this machine (M14).
 *
 * A tier is a range, and where a machine sits inside its range decides which
 * end it gets: the bottom of a band is a machine that only just qualifies.
 * Memory bandwidth gates the second card rather than the context, because
 * two cards decode against one memory bus and a slow bus makes both slower
 * than one would have been.
 */
export function tierSettingsFor(
  usableBytes: number,
  options: { memoryBandwidthGbPerSecond?: number } = {},
): TierSettings {
  const tier = tierForBudget(usableBytes);
  const gb = usableBytes / GB;
  const [lo, hi] = tier.budgetGb;
  // XL is open-ended: treat half again over its floor as its top.
  const top = Number.isFinite(hi) ? hi : lo * 1.5;
  const roomy = gb >= lo + (top - lo) / 2;
  const bandwidth = options.memoryBandwidthGbPerSecond;
  const fastBus = bandwidth === undefined || bandwidth >= MIN_PARALLEL_BANDWIDTH_GBPS;
  const coLoadRoles = tier.coLoaded.startsWith("yes") && usableBytes >= CO_RESIDENT_MIN_BYTES;
  const [ctxLo, ctxHi] = tier.workingContext;
  const [cardsLo, cardsHi] = tier.parallelCards;
  return {
    tier: tier.tier,
    workingContextTokens: roomy ? ctxHi : ctxLo,
    parallelCards: roomy && fastBus ? cardsHi : cardsLo,
    coLoadRoles,
    reason: `${gb.toFixed(1)} GB usable puts this machine ${roomy ? "high" : "low"} in tier ${tier.tier}${
      fastBus ? "" : `, on a ${bandwidth?.toFixed(0)} GB/s bus`
    }; roles ${coLoadRoles ? "co-load" : "swap"}`,
  };
}

/**
 * Below this a second card is not worth starting: both cards decode against
 * one memory bus, and local decode is bandwidth-bound long before it is
 * compute-bound.
 */
export const MIN_PARALLEL_BANDWIDTH_GBPS = 100;

export class UnsupportedHardwareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedHardwareError";
  }
}

/**
 * The tier for a memory budget (unified memory, or VRAM plus RAM where
 * expert offload applies). Below 16 GB is unsupported (design).
 */
export function tierForBudget(budgetBytes: number): TierProfile {
  const gb = budgetBytes / GB;
  // 0.5 GB slack: a "16 GB" machine reports slightly under 16 GiB.
  if (gb < 15.5) {
    throw new UnsupportedHardwareError(
      `${gb.toFixed(1)} GB of usable memory is below the 16 GB minimum; Sekhemet does not run cards here.`,
    );
  }
  if (gb < 23.5) return TIER_PROFILES.S;
  if (gb < 47.5) return TIER_PROFILES.M;
  if (gb < 95.5) return TIER_PROFILES.L;
  return TIER_PROFILES.XL;
}

// ------------------------------------------------------- throughput floors (M15)

export type ThroughputMode = "overnight" | "interactive" | "recommended";

export const THROUGHPUT_FLOORS: Record<
  ThroughputMode,
  { prefill: number; decode: number; secondsPerTurn: number }
> = {
  overnight: { prefill: 40, decode: 10, secondsPerTurn: 70 },
  interactive: { prefill: 100, decode: 20, secondsPerTurn: 30 },
  recommended: { prefill: 300, decode: 40, secondsPerTurn: 12 },
};

export interface MeasuredSpeed {
  prefillTokensPerSecond: number | undefined;
  decodeTokensPerSecond: number | undefined;
}

/** The best mode a model's measured speed meets, or `below_floor`. */
export function throughputClass(
  speed: MeasuredSpeed,
): ThroughputMode | "below_floor" | "unmeasured" {
  const { prefillTokensPerSecond: p, decodeTokensPerSecond: d } = speed;
  if (p === undefined || d === undefined) return "unmeasured";
  const meets = (m: ThroughputMode) =>
    p >= THROUGHPUT_FLOORS[m].prefill && d >= THROUGHPUT_FLOORS[m].decode;
  if (meets("recommended")) return "recommended";
  if (meets("interactive")) return "interactive";
  if (meets("overnight")) return "overnight";
  return "below_floor";
}

export class ThroughputFloorError extends Error {
  constructor(
    message: string,
    public readonly modelId: string,
    public readonly speed: MeasuredSpeed,
    public readonly mode: ThroughputMode,
  ) {
    super(message);
    this.name = "ThroughputFloorError";
  }
}

/**
 * Refuse to run below a floor (default: overnight, the design's hard stop)
 * and say why. Unmeasured speed passes: calibration has not run yet.
 */
export function assertThroughputFloor(
  modelId: string,
  speed: MeasuredSpeed,
  mode: ThroughputMode = "overnight",
): void {
  const { prefillTokensPerSecond: p, decodeTokensPerSecond: d } = speed;
  if (p === undefined || d === undefined) return;
  const floor = THROUGHPUT_FLOORS[mode];
  const short: string[] = [];
  if (p < floor.prefill) short.push(`prefill ${p.toFixed(1)} tok/s < ${floor.prefill}`);
  if (d < floor.decode) short.push(`decode ${d.toFixed(1)} tok/s < ${floor.decode}`);
  if (short.length > 0) {
    throw new ThroughputFloorError(
      `Refusing to run cards on ${modelId}: ${short.join(", ")} (the ${mode} floor). A turn would take far longer than ~${floor.secondsPerTurn}s.`,
      modelId,
      speed,
      mode,
    );
  }
}

// ------------------------------------------------------- host measurement (M13)

export interface UsableMemory {
  usableBytes: number;
  /** How the number was arrived at, so a surprising tier can be explained. */
  source: string;
}

/**
 * Memory the models may really use, measured rather than assumed.
 *
 * "Total minus 4 GB" is wrong in both directions. On Apple Silicon what the
 * GPU may wire down is a fraction of physical memory — the driver's default,
 * which `iogpu.wired_limit_mb` overrides — and that fraction is why a 24 GB
 * M4 carries about 16 GB of weights and not 20. On Linux what is available
 * is what the kernel says is available, not what is installed.
 */
export function measureUsableMemory(
  options: {
    platform?: string;
    totalBytes?: number;
    sysctl?: (name: string) => string | undefined;
    readMeminfo?: () => string | undefined;
  } = {},
): UsableMemory {
  const os = options.platform ?? platform();
  const total = options.totalBytes ?? totalmem();
  if (os === "darwin") {
    const limit = Number(options.sysctl?.(SYSCTL_WIRED_LIMIT) ?? readSysctl(SYSCTL_WIRED_LIMIT));
    if (Number.isFinite(limit) && limit > 0) {
      return { usableBytes: limit * 1024 * 1024, source: `${SYSCTL_WIRED_LIMIT} (set)` };
    }
    // The driver's own default: two thirds up to 36 GB, three quarters above.
    // Measured against Metal's recommendedMaxWorkingSetSize on this machine.
    const share = total > 36 * GB ? 0.75 : 2 / 3;
    return {
      usableBytes: Math.floor(total * share),
      source: `Metal default wired limit (${Math.round(share * 100)}% of ${(total / GB).toFixed(0)} GB)`,
    };
  }
  if (os === "linux") {
    const info = options.readMeminfo?.() ?? readFileSafe("/proc/meminfo");
    const available = /MemAvailable:\s+(\d+)/.exec(info ?? "")?.[1];
    if (available !== undefined) {
      return { usableBytes: Number(available) * 1024, source: "/proc/meminfo MemAvailable" };
    }
  }
  return { usableBytes: Math.max(0, total - 4 * GB), source: "total minus a 4 GB OS reserve" };
}

const SYSCTL_WIRED_LIMIT = "iogpu.wired_limit_mb";

function readSysctl(name: string): string | undefined {
  try {
    return execFileSync("sysctl", ["-n", name], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Sustained read bandwidth, GB/s, from a buffer far larger than the last
 * level of cache. Local decode is bandwidth-bound — a 30B MoE reads its
 * active experts once per token — so this, not core count, is what says
 * whether a second card is worth starting.
 */
export function measureMemoryBandwidth(options: { bytes?: number; passes?: number } = {}): number {
  const bytes = options.bytes ?? 64 * 1024 * 1024;
  const passes = options.passes ?? 8;
  const buffer = new Float64Array(Math.floor(bytes / 8));
  for (let i = 0; i < buffer.length; i++) buffer[i] = i;
  // One untimed pass so the measurement is of memory, not of page faults.
  let sink = 0;
  for (let i = 0; i < buffer.length; i++) sink += buffer[i] as number;
  const start = performance.now();
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i < buffer.length; i++) sink += buffer[i] as number;
  }
  const seconds = (performance.now() - start) / 1000;
  // `sink` is read so the loop cannot be optimised away.
  if (!Number.isFinite(sink) || seconds <= 0) return 0;
  return Math.round(((buffer.byteLength * passes) / seconds / 1e9) * 10) / 10;
}

// ------------------------------------------ prefill batch / offload sweep (M13)

export interface SweepCandidate {
  /** `-b`, the prefill batch size. */
  batchTokens: number;
  /** `-ngl`, layers kept on the accelerator; fewer means experts offloaded. */
  gpuLayers: number;
}

export interface SweepPoint extends SweepCandidate {
  speed: MeasuredSpeed;
  /** The probe could not run this setting, or the host started paging. */
  hitCliff?: boolean;
}

export interface SweepChoice extends SweepCandidate {
  reason: string;
  points: SweepPoint[];
}

/** Prefill batch sizes, ascending in memory demand. */
export const DEFAULT_BATCH_SIZES = [512, 1024, 2048, 4096] as const;

/**
 * A prefill slower than this share of the best measured is the cliff showing
 * itself as speed rather than as a failure: the setting no longer fits and
 * the host is paging to pretend it does.
 */
export const CLIFF_THROUGHPUT_RATIO = 0.8;

/**
 * The setting one step back from the memory cliff (design: "Sweep prefill
 * batch size and expert-offload settings, keeping the setting one step back
 * from the memory cliff"). Candidates are read in ascending order of demand:
 * the choice is the last one before the first that fell off, so a machine
 * that is fine today is still fine when a card's prompt is longer.
 */
export function oneStepBackFromCliff(points: readonly SweepPoint[]): SweepChoice {
  const safe: SweepPoint[] = [];
  let best = 0;
  for (const p of points) {
    const prefill = p.speed.prefillTokensPerSecond;
    if (p.hitCliff || prefill === undefined) break;
    // A drop after the peak is the cliff showing itself as speed: the setting
    // no longer fits and the host is paging to pretend it does.
    if (best > 0 && prefill < best * CLIFF_THROUGHPUT_RATIO) break;
    best = Math.max(best, prefill);
    safe.push(p);
  }
  const chosen = safe.at(-1) ?? points[0];
  if (!chosen) {
    return { batchTokens: DEFAULT_BATCH_SIZES[0], gpuLayers: 99, points: [], reason: "not swept" };
  }
  const cliff = points[safe.length];
  return {
    batchTokens: chosen.batchTokens,
    gpuLayers: chosen.gpuLayers,
    points: [...points],
    reason: cliff
      ? `-b ${chosen.batchTokens} -ngl ${chosen.gpuLayers}: one step back from -b ${cliff.batchTokens} -ngl ${cliff.gpuLayers}, which fell off`
      : `-b ${chosen.batchTokens} -ngl ${chosen.gpuLayers}: the largest setting measured, no cliff reached`,
  };
}

/**
 * Measure each candidate in ascending order of demand and stop at the first
 * one that falls off: nothing past the cliff is worth measuring, and on a
 * tight host measuring it is what causes the damage.
 */
export async function sweepLaunchSettings(options: {
  candidates?: readonly SweepCandidate[];
  probe: (candidate: SweepCandidate) => Promise<{ speed: MeasuredSpeed; hitCliff?: boolean }>;
}): Promise<SweepChoice> {
  const candidates =
    options.candidates ??
    DEFAULT_BATCH_SIZES.map((batchTokens) => ({ batchTokens, gpuLayers: 99 }));
  const points: SweepPoint[] = [];
  for (const candidate of candidates) {
    const result = await options.probe(candidate).catch(() => ({
      speed: { prefillTokensPerSecond: undefined, decodeTokensPerSecond: undefined },
      hitCliff: true,
    }));
    points.push({ ...candidate, ...result });
    if (result.hitCliff) break;
  }
  return oneStepBackFromCliff(points);
}

// -------------------------------------------------------------- calibration (M13)

export interface BucketMeasurement {
  contextTokens: number;
  prefillTokensPerSecond: number | undefined;
  decodeTokensPerSecond: number | undefined;
  wallMs: number;
}

export interface ModelCalibration {
  modelId: string;
  label: string;
  buckets: Record<string, BucketMeasurement>;
  /** Speed at the smallest bucket, for floors. */
  speed: MeasuredSpeed;
  throughputClass: ReturnType<typeof throughputClass>;
}

export interface MachineProfile {
  version: 1;
  date: string;
  fingerprint: HardwareFingerprint;
  fingerprintHash: string;
  usableBytes: number;
  /** How `usableBytes` was measured. */
  usableMemorySource?: string;
  /** Sustained read bandwidth, GB/s: what decides a second card. */
  memoryBandwidthGbPerSecond?: number;
  tier: MachineTier;
  /** What the tier decides for this machine, and what the run applies. */
  settings?: TierSettings;
  /** Prefill batch size and offload, one step back from the cliff. */
  launch?: SweepChoice;
  models: Record<string, ModelCalibration>;
  speculative?: Record<string, SpeculativeVerdict>;
  engine?: EngineDecision;
}

export const DEFAULT_CONTEXT_BUCKETS = [2048, 8192, 16384] as const;

export function bucketLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/**
 * A prompt of about `tokens` tokens (4 chars per token), unique per call
 * (`nonce`) so the server's prefix cache cannot make prefill look free.
 */
export function calibrationPrompt(tokens: number, nonce: string): string {
  const unit = `[${nonce}] The quick brown fox jumps over the lazy dog near the riverbank. `;
  const chars = Math.max(unit.length, tokens * 4);
  return `${unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)}\nReply with the word OK.`;
}

function speedFrom(usage: TokenUsage, wallMs: number): MeasuredSpeed {
  const prefill =
    usage.prefillTokensPerSecond ??
    (usage.prefillMs && usage.promptTokens > 0
      ? usage.promptTokens / (usage.prefillMs / 1000)
      : undefined);
  const decode =
    usage.decodeTokensPerSecond ??
    (usage.decodeMs && usage.completionTokens > 0
      ? usage.completionTokens / (usage.decodeMs / 1000)
      : wallMs > 0 && usage.completionTokens > 0
        ? usage.completionTokens / (wallMs / 1000)
        : undefined);
  return { prefillTokensPerSecond: prefill, decodeTokensPerSecond: decode };
}

/**
 * Measure one model's prefill and decode speed at several context lengths
 * (M13). Each bucket sends a fresh prompt of that size and asks for
 * `decodeTokens` tokens; the server's own timings are preferred.
 */
export async function calibrateModel(
  adapter: LocalInferenceAdapter,
  options: {
    label?: string;
    buckets?: readonly number[];
    decodeTokens?: number;
    nonce?: () => string;
  } = {},
): Promise<ModelCalibration> {
  const buckets = [...(options.buckets ?? DEFAULT_CONTEXT_BUCKETS)].sort((a, b) => a - b);
  const window = adapter.contextWindow?.contextTokens;
  const nonce = options.nonce ?? (() => Math.random().toString(36).slice(2, 10));
  const out: Record<string, BucketMeasurement> = {};
  for (const tokens of buckets) {
    // Leave room for the reply; skip buckets the window cannot hold.
    if (window !== undefined && tokens + (options.decodeTokens ?? 64) > window) continue;
    const start = Date.now();
    const res = await adapter.generate({
      prompt: calibrationPrompt(tokens, nonce()),
      toolArm: "arm_a_flat",
      maxTokens: options.decodeTokens ?? 64,
      // Greedy on purpose: this measures prefill and decode speed, which the
      // sampling settings do not change, and greedy keeps the reply length
      // steady across buckets. Qualification, which judges behaviour, runs at
      // the role's own sampling instead (models rule 27a, suite q1.2).
      temperature: 0,
      reasoning: "off",
    });
    const wallMs = Date.now() - start;
    out[bucketLabel(tokens)] = { contextTokens: tokens, wallMs, ...speedFrom(res.usage, wallMs) };
  }
  const first = Object.values(out)[0];
  const speed: MeasuredSpeed = {
    prefillTokensPerSecond: first?.prefillTokensPerSecond,
    decodeTokensPerSecond: first?.decodeTokensPerSecond,
  };
  return {
    modelId: adapter.modelId,
    label: options.label ?? adapter.modelId,
    buckets: out,
    speed,
    throughputClass: throughputClass(speed),
  };
}

export function defaultMachineProfilePath(): string {
  return process.env.SEKHEMET_MACHINE_PROFILE ?? join(homedir(), ".sekhemet", "machine.json");
}

export interface CalibrateHardwareOptions {
  /** Candidate models, each measured in turn (the caller swaps them). */
  candidates: { label: string; adapter: LocalInferenceAdapter; release?: () => Promise<void> }[];
  /** Usable memory; default measured from the host (`measureUsableMemory`). */
  usableBytes?: number;
  buckets?: readonly number[];
  decodeTokens?: number;
  /** Prefill batch and offload sweep; omitted, the sweep does not run. */
  sweep?: Parameters<typeof sweepLaunchSettings>[0];
  /** Injectable for tests: bandwidth is measured on the host by default. */
  memoryBandwidthGbPerSecond?: number;
  registry?: ModelRegistry;
  /** Where to save the machine profile; `false` does not save. */
  path?: string | false;
  now?: () => Date;
}

/**
 * The calibration procedure (M13): fingerprint the machine, derive its
 * tier, measure every candidate at each context bucket, record throughput in
 * the registry and save the machine profile. Re-run on hardware change
 * (`needsRecalibration`) or on demand (`sekhemet calibrate`).
 */
export async function calibrateHardware(
  options: CalibrateHardwareOptions,
): Promise<MachineProfile> {
  const fingerprint = hardwareFingerprint();
  const measured = measureUsableMemory({ totalBytes: fingerprint.totalBytes });
  const usableBytes = options.usableBytes ?? measured.usableBytes;
  const bandwidth = options.memoryBandwidthGbPerSecond ?? measureMemoryBandwidth();
  const settings = tierSettingsFor(usableBytes, { memoryBandwidthGbPerSecond: bandwidth });
  const models: Record<string, ModelCalibration> = {};
  for (const c of options.candidates) {
    const cal = await calibrateModel(c.adapter, {
      label: c.label,
      ...(options.buckets ? { buckets: options.buckets } : {}),
      ...(options.decodeTokens ? { decodeTokens: options.decodeTokens } : {}),
    });
    models[c.label] = cal;
    if (options.registry) {
      for (const [bucket, m] of Object.entries(cal.buckets)) {
        if (m.prefillTokensPerSecond !== undefined && m.decodeTokensPerSecond !== undefined) {
          options.registry.recordThroughput(
            c.adapter.modelId,
            bucket,
            Math.round(m.prefillTokensPerSecond * 10) / 10,
            Math.round(m.decodeTokensPerSecond * 10) / 10,
          );
        }
      }
    }
    await c.release?.();
  }
  const launch = options.sweep ? await sweepLaunchSettings(options.sweep) : undefined;
  const profile: MachineProfile = {
    version: 1,
    date: (options.now?.() ?? new Date()).toISOString(),
    fingerprint,
    fingerprintHash: fingerprintHash(fingerprint),
    usableBytes,
    ...(options.usableBytes === undefined ? { usableMemorySource: measured.source } : {}),
    memoryBandwidthGbPerSecond: bandwidth,
    tier: settings.tier,
    settings,
    ...(launch ? { launch } : {}),
    models,
  };
  if (options.path !== false) saveMachineProfile(profile, options.path);
  return profile;
}

export function saveMachineProfile(
  profile: MachineProfile,
  path: string = defaultMachineProfilePath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`);
  renameSync(tmp, path);
}

export function loadMachineProfile(
  path: string = defaultMachineProfilePath(),
): MachineProfile | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as MachineProfile;
}

/** True when there is no profile or it was measured on different hardware. */
export function needsRecalibration(profile: MachineProfile | undefined): boolean {
  return profile === undefined || profile.fingerprintHash !== hostFingerprintHash();
}

/**
 * Refuse a run on a model whose calibrated speed is below the floor (M15).
 * Models the profile never measured pass (nothing to refuse on).
 */
export function assertModelRunnable(
  profile: MachineProfile | undefined,
  modelId: string,
  mode: ThroughputMode = "overnight",
): void {
  if (!profile) return;
  const cal = Object.values(profile.models).find((m) => m.modelId === modelId);
  if (cal) assertThroughputFloor(modelId, cal.speed, mode);
}

// ------------------------------------------------ speculative decoding (M19)

export interface SpeculativeVerdict {
  enabled: boolean;
  speedup: number;
  reason: string;
}

/**
 * Memory the draft head needs beyond the model's own footprint before it is
 * worth measuring. The head is the first thing the memory watchdog drops
 * (M20); on a 24 GB host carrying a 16 GB checkpoint there is barely this
 * much left, and measuring it would mean loading it.
 */
export const SPECULATIVE_HEADROOM_BYTES = 1.5 * GB;

/**
 * Decide MTP / draft-model speculative decoding by measurement (M19). It is
 * enabled only when it makes decode at least `minSpeedup` faster (default
 * 5%) and memory headroom allows the extra head. CHRONICLE §2 measured MTP
 * 21% slower on the M4, which this turns off.
 */
export function decideSpeculative(
  plain: MeasuredSpeed,
  speculative: MeasuredSpeed,
  options: { memoryHeadroomOk?: boolean; minSpeedup?: number } = {},
): SpeculativeVerdict {
  const base = plain.decodeTokensPerSecond;
  const spec = speculative.decodeTokensPerSecond;
  const measured = base !== undefined && spec !== undefined && base > 0;
  const speedup = measured ? Math.round(((spec as number) / (base as number)) * 1000) / 1000 : 1;
  // Headroom first: a head that does not fit is off whether or not it is fast,
  // and the caller may not have been able to measure it at all.
  if (options.memoryHeadroomOk === false) {
    return { enabled: false, speedup, reason: "no memory headroom for the draft head" };
  }
  if (!measured) {
    return { enabled: false, speedup: 1, reason: "not measured; speculative decoding stays off" };
  }
  const min = options.minSpeedup ?? 1.05;
  if (speedup < min) {
    return {
      enabled: false,
      speedup,
      reason: `speculative decode ${spec.toFixed(1)} tok/s vs plain ${base.toFixed(1)} (x${speedup}) is under x${min}`,
    };
  }
  return {
    enabled: true,
    speedup,
    reason: `speculative decode is x${speedup} faster (${spec.toFixed(1)} vs ${base.toFixed(1)} tok/s)`,
  };
}

/**
 * Measure a model's decode speed with and without its speculative head, for
 * display (M19). It records the verdict without a thinking policy, so it
 * never reaches `speculativeByPolicy`: decode speed alone never justifies MTP
 * (models rule 13), and only the per-step A/B (`mtpStepAB`, `sekhemet
 * calibrate --mtp-ab`) decides what a launch uses.
 */
export async function calibrateSpeculative(options: {
  modelId: string;
  plain: LocalInferenceAdapter;
  speculative: LocalInferenceAdapter;
  registry?: ModelRegistry;
  buckets?: readonly number[];
  release?: (adapter: LocalInferenceAdapter) => Promise<void>;
  memoryHeadroomOk?: boolean;
}): Promise<SpeculativeVerdict> {
  const buckets = options.buckets ?? [2048];
  // Nothing is loaded on a host with no room for the head: the measurement
  // would need the very memory it is being refused, and on a 24 GB machine
  // that is a swap storm, not a number.
  if (options.memoryHeadroomOk === false) {
    const unmeasured: MeasuredSpeed = {
      prefillTokensPerSecond: undefined,
      decodeTokensPerSecond: undefined,
    };
    const verdict = decideSpeculative(unmeasured, unmeasured, { memoryHeadroomOk: false });
    options.registry?.recordSpeculative(options.modelId, {
      ...verdict,
      fingerprint: hostFingerprintHash(),
      date: new Date().toISOString(),
    });
    return verdict;
  }
  const plain = await calibrateModel(options.plain, { buckets });
  await options.release?.(options.plain);
  const spec = await calibrateModel(options.speculative, { buckets });
  await options.release?.(options.speculative);
  const verdict = decideSpeculative(plain.speed, spec.speed, {
    ...(options.memoryHeadroomOk !== undefined
      ? { memoryHeadroomOk: options.memoryHeadroomOk }
      : {}),
  });
  // Display only: no thinking policy, so no launch reads it (models rule 13).
  options.registry?.recordSpeculative(options.modelId, {
    ...verdict,
    fingerprint: hostFingerprintHash(),
    date: new Date().toISOString(),
  });
  return verdict;
}

// ------------------------------------------------ MTP on seconds per step (M11)

/** One replayed step's time on one server (MD-M11-1). */
export interface StepTiming {
  prefillSeconds: number;
  decodeSeconds: number;
  totalSeconds: number;
  /** Accepted over drafted tokens, when the server drafted any. */
  draftAcceptance?: number;
  /**
   * Tokens produced per verify step, when the server drafted any: each verify
   * step yields its accepted drafts plus one token of its own.
   */
  tokensPerVerifyStep?: number;
}

export interface MtpAbResult {
  steps: { plain: StepTiming; speculative: StepTiming }[];
  /** Median paired difference, speculative minus plain, in total seconds per step. */
  medianDeltaSeconds: number;
  /**
   * Median plain seconds per step over median speculative seconds per step:
   * a ratio of whole steps (prefill and decode), not a decode speed-up.
   */
  speedup: number;
  /** One-sided sign test on the paired deltas: the chance of this many faster steps by luck. */
  signTestP: number;
  enabled: boolean;
  reason: string;
  /** Peak memory each side reached, when a probe was given (the Metal working set on macOS). */
  peakBytes?: { plain?: number; speculative?: number };
  /** Where the per-step timings were written, when they were. */
  evidencePath?: string;
}

/** The fewest replayed steps the A/B decides on (A6). */
export const MTP_AB_MIN_STEPS = 30;
/** The median saving must exceed this share of the plain median step (A6). */
export const MTP_AB_MARGIN = 0.02;
/** The sign test's level (A6). */
export const MTP_AB_ALPHA = 0.05;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * One-sided sign test: the probability of at least `faster` of `n` non-tied
 * pairs favouring speculation if either side were equally likely to win.
 */
export function signTestP(faster: number, n: number): number {
  if (n === 0 || faster <= 0) return 1;
  // In log space: C(n, k) / 2^n overflows a double past n = 1023.
  const lnFact = [0];
  for (let i = 1; i <= n; i++) lnFact[i] = (lnFact[i - 1] as number) + Math.log(i);
  const lnTerm = (k: number) =>
    (lnFact[n] as number) - (lnFact[k] as number) - (lnFact[n - k] as number) - n * Math.LN2;
  const terms: number[] = [];
  for (let k = faster; k <= n; k++) terms.push(lnTerm(k));
  const top = Math.max(...terms);
  const lnP = top + Math.log(terms.reduce((sum, t) => sum + Math.exp(t - top), 0));
  return Math.min(1, Math.exp(lnP));
}

async function timeSteps(
  adapter: LocalInferenceAdapter,
  steps: readonly InferenceRequest[],
): Promise<StepTiming[]> {
  const out: StepTiming[] = [];
  // A discarded warm-up of the block's first step, so neither side pays a
  // cold cache the other does not (M11).
  const [first] = steps;
  if (first) await adapter.generate(first);
  for (const req of steps) {
    const started = Date.now();
    const r = await adapter.generate(req);
    const u = r.usage;
    const prefill = (u.prefillMs ?? 0) / 1000;
    const decode = (u.decodeMs ?? 0) / 1000;
    // The server's own split only when it reports both parts; otherwise the
    // wall clock, so a step is never counted as only half its time.
    const total =
      u.prefillMs !== undefined && u.decodeMs !== undefined
        ? prefill + decode
        : (Date.now() - started) / 1000;
    const accepted = u.draftAcceptedTokens ?? 0;
    const verifySteps = u.completionTokens - accepted;
    out.push({
      prefillSeconds: prefill,
      decodeSeconds: decode,
      totalSeconds: total,
      ...(u.draftTokens ? { draftAcceptance: accepted / u.draftTokens } : {}),
      ...(u.draftTokens && verifySteps > 0
        ? { tokensPerVerifyStep: u.completionTokens / verifySteps }
        : {}),
    });
  }
  return out;
}

/**
 * The speculative A/B (MD-M11-1/2, A6): replay recorded Worker step prompts
 * on the same GGUF and server build with speculation off and on, one server
 * at a time, in ABBA order — plain on the first half, speculative on the
 * first half, speculative on the second half, plain on the second half — so
 * drift over the run (thermal, cache, background load) falls on both sides.
 * It decides on paired total seconds per step, never on decode speed: on
 * only when a one-sided sign test on the paired deltas gives p < 0.05 and
 * the median saving exceeds 2% of the plain median step. The decision is
 * recorded for the thinking policy the steps ran under (for a draft model,
 * keyed by it, MD-N8-5), and every step's timings are written as evidence.
 */
export async function mtpStepAB(options: {
  modelId: string;
  steps: readonly InferenceRequest[];
  plain: LocalInferenceAdapter;
  speculative: LocalInferenceAdapter;
  thinking: ThinkingPolicy;
  registry?: ModelRegistry;
  release?: (adapter: LocalInferenceAdapter) => Promise<void>;
  peakBytes?: () => Promise<number | undefined>;
  /** A draft model's id (MD-N8-5): the decision is keyed by it, not the MTP head's. */
  draft?: string;
  /** Default `MTP_AB_MIN_STEPS`. */
  minSteps?: number;
  /** Where the per-step evidence goes; default `evidence/` beside the registry, or none. */
  evidenceDir?: string;
  /**
   * Why the A/B cannot start, when a server already answers on the port: an
   * adopted server outlives `release`, so both halves would measure it (M11).
   */
  portBusy?: () => Promise<string | undefined>;
}): Promise<MtpAbResult> {
  const busy = await options.portBusy?.();
  if (busy) throw new Error(`${busy}: stop it first, then run the A/B`);
  const n = options.steps.length;
  if (n === 0) throw new Error("no recorded Worker steps to replay: run the frozen suite first");
  const minSteps = options.minSteps ?? MTP_AB_MIN_STEPS;
  if (n < minSteps)
    throw new Error(
      `${n} recorded steps; the A/B needs at least ${minSteps}: run more cards first`,
    );
  const half = Math.ceil(n / 2);
  const first = options.steps.slice(0, half);
  const second = options.steps.slice(half);
  // A: plain, first half.
  const plainFirst = await timeSteps(options.plain, first);
  await options.release?.(options.plain);
  // B B: speculative, both halves, one load.
  const specFirst = await timeSteps(options.speculative, first);
  const specSecond = await timeSteps(options.speculative, second);
  const specPeak = await options.peakBytes?.();
  await options.release?.(options.speculative);
  // A: plain, second half.
  const plainSecond = await timeSteps(options.plain, second);
  const plainPeak = await options.peakBytes?.();
  await options.release?.(options.plain);
  const plain = [...plainFirst, ...plainSecond];
  const spec = [...specFirst, ...specSecond];

  const deltas = plain.map((p, i) => (spec[i] as StepTiming).totalSeconds - p.totalSeconds);
  const medianDeltaSeconds = median(deltas);
  const plainMedian = median(plain.map((t) => t.totalSeconds));
  const specMedian = median(spec.map((t) => t.totalSeconds));
  const speedup = specMedian > 0 ? plainMedian / specMedian : 1;
  const nonTied = deltas.filter((d) => d !== 0);
  const faster = nonTied.filter((d) => d < 0).length;
  const p = signTestP(faster, nonTied.length);
  const saving = -medianDeltaSeconds;
  const margin = MTP_AB_MARGIN * plainMedian;
  const test = `${faster} of ${nonTied.length} steps faster, sign test p = ${p.toFixed(4)}`;
  const enabled = medianDeltaSeconds < 0 && p < MTP_AB_ALPHA && saving > margin;
  const reason = enabled
    ? `faster per step: median ${saving.toFixed(2)} s saved over ${n} replayed steps (${test})`
    : medianDeltaSeconds >= 0
      ? `not faster per step: median ${medianDeltaSeconds.toFixed(2)} s over ${n} replayed steps (${test})`
      : p >= MTP_AB_ALPHA
        ? `not shown faster per step: ${test}, not under ${MTP_AB_ALPHA}`
        : `median saving ${saving.toFixed(3)} s is under the ${MTP_AB_MARGIN * 100}% margin (${margin.toFixed(3)} s) of the plain step (${test})`;
  const date = new Date().toISOString();
  options.registry?.recordSpeculative(options.modelId, {
    enabled,
    speedup,
    reason,
    fingerprint: hostFingerprintHash(),
    date,
    thinking: options.thinking,
    ...(options.draft ? { draft: options.draft } : {}),
  });
  const steps = plain.map((pl, i) => ({ plain: pl, speculative: spec[i] as StepTiming }));
  const peakBytes =
    plainPeak !== undefined || specPeak !== undefined
      ? {
          ...(plainPeak !== undefined ? { plain: plainPeak } : {}),
          ...(specPeak !== undefined ? { speculative: specPeak } : {}),
        }
      : undefined;
  const evidenceDir =
    options.evidenceDir ??
    (options.registry ? join(dirname(options.registry.path), "evidence") : undefined);
  let evidencePath: string | undefined;
  if (evidenceDir) {
    const safe = (s: string) => s.replace(/[^\w.-]+/g, "_");
    evidencePath = join(
      evidenceDir,
      `mtp-ab-${safe(options.modelId)}${options.draft ? `-draft-${safe(options.draft)}` : ""}-${options.thinking}-${date.slice(0, 10)}-${date.slice(11, 19).replaceAll(":", "")}.json`,
    );
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          modelId: options.modelId,
          ...(options.draft ? { draft: options.draft } : {}),
          thinking: options.thinking,
          host: hostFingerprintHash(),
          date,
          order: "ABBA",
          enabled,
          reason,
          speedup,
          medianDeltaSeconds,
          signTestP: p,
          ...(peakBytes ? { peakBytes } : {}),
          steps,
        },
        null,
        2,
      )}\n`,
    );
  }
  return {
    steps,
    medianDeltaSeconds,
    speedup,
    signTestP: p,
    enabled,
    reason,
    ...(peakBytes ? { peakBytes } : {}),
    ...(evidencePath ? { evidencePath } : {}),
  };
}

// --------------------------------------------------------- engine selection (M24)

export interface EngineCandidate {
  engine: string;
  speed: MeasuredSpeed;
  /**
   * Cross-turn prefix-cache retention in [0, 1]: the token-weighted hit rate
   * on tool-result steps of a multi-turn probe. Weighted heavily (design).
   */
  cacheRetention: number | undefined;
  /** Qualification pass rate under this engine, [0, 1]. */
  qualificationPassRate?: number;
}

export interface EngineDecision {
  engine: string;
  scores: Record<string, number>;
  reason: string;
}

/**
 * Choose the engine by measurement (M24). A multi-turn card's turn cost is
 * dominated by the uncached prefill, so the score is the predicted seconds
 * for a representative tool-result turn: uncached prompt tokens over
 * prefill speed plus reply tokens over decode speed. Cache retention enters
 * through the uncached share; a failing qualification disqualifies.
 */
export function selectEngine(
  candidates: readonly EngineCandidate[],
  turn: { promptTokens: number; replyTokens: number; qualificationBar?: number } = {
    promptTokens: 12_000,
    replyTokens: 300,
  },
): EngineDecision {
  const scores: Record<string, number> = {};
  const bar = turn.qualificationBar ?? 0;
  for (const c of candidates) {
    const p = c.speed.prefillTokensPerSecond;
    const d = c.speed.decodeTokensPerSecond;
    if (!p || !d) continue;
    if (c.qualificationPassRate !== undefined && c.qualificationPassRate < bar) continue;
    const uncached = turn.promptTokens * (1 - (c.cacheRetention ?? 0));
    scores[c.engine] = Math.round((uncached / p + turn.replyTokens / d) * 100) / 100;
  }
  const ranked = Object.entries(scores).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const best = ranked[0];
  if (!best) {
    return { engine: "llama.cpp", scores, reason: "no engine measured; llama.cpp is the baseline" };
  }
  const runner = ranked[1];
  return {
    engine: best[0],
    scores,
    reason: runner
      ? `${best[0]} predicts ${best[1]}s per tool-result turn vs ${runner[0]} ${runner[1]}s`
      : `${best[0]} is the only measured engine (${best[1]}s per turn)`,
  };
}
