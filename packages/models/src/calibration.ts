import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { arch, cpus, homedir, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { ModelRegistry } from "./registry.js";
import type { LocalInferenceAdapter, TokenUsage } from "./types.js";

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
  tier: MachineTier;
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
  /** Usable memory; default total RAM minus a 4 GB OS reserve. */
  usableBytes?: number;
  buckets?: readonly number[];
  decodeTokens?: number;
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
  const usableBytes = options.usableBytes ?? Math.max(0, fingerprint.totalBytes - 4 * GB);
  const tier = tierForBudget(usableBytes).tier;
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
  const profile: MachineProfile = {
    version: 1,
    date: (options.now?.() ?? new Date()).toISOString(),
    fingerprint,
    fingerprintHash: fingerprintHash(fingerprint),
    usableBytes,
    tier,
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
 * Measure a model with and without its speculative head and record the
 * decision in the registry for this host; `ManagedLlamaServerAdapter`
 * launches with it (M19).
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
  options.registry?.recordSpeculative(options.modelId, {
    ...verdict,
    fingerprint: hostFingerprintHash(),
    date: new Date().toISOString(),
  });
  return verdict;
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
