import { HEADROOM_DEFAULTS, isLargeModel } from "./headroom.js";
import type {
  ConfigRole,
  FitLabel,
  FitVerdict,
  FoundModel,
  Graded,
  ModelShape,
  NumberGrade,
} from "./library_types.js";
import { MODEL_ROLES } from "./types.js";

/**
 * Fit to this machine (models rule 4b, MD-N12-3; dashboard DB-NM14-2): for a
 * found model and a role, weights plus the KV cache at the role's context
 * and KV type plus the engine's buffers, set against the live headroom (the
 * lower of the GPU and system measures, rule 20g). Pure: it reads no disk and
 * loads nothing, so the model page's what-if recomputes it freely.
 */

/** Each role's context and KV type until a profile says otherwise (D; rule 10: `-ctk/-ctv q8_0`). */
export const ROLE_SETTINGS: Readonly<
  Record<ConfigRole, { contextTokens: number; kvType: string }>
> = {
  worker: { contextTokens: 16384, kvType: "q8_0" },
  planner: { contextTokens: 32768, kvType: "q8_0" },
  reviewer: { contextTokens: 16384, kvType: "q8_0" },
  researcher: { contextTokens: 32768, kvType: "q8_0" },
  vision: { contextTokens: 8192, kvType: "q8_0" },
};

/** The Configuration page's roles: the one role type, and `vision` (PM_CONTRACT `Role`). */
export const CONFIG_ROLES: readonly ConfigRole[] = [...MODEL_ROLES, "vision"];

/** llama-server's `--cache-ram` on the reference host (M17, CHRONICLE §2): 2048 MiB (D). */
export const DEFAULT_PROMPT_CACHE_BYTES = 2048 * 1024 ** 2;

/** Bytes per cached element for a llama.cpp KV type (block size 32; ggml's block layouts). */
export function kvBytesPerElement(kvType: string): number {
  switch (kvType.toLowerCase()) {
    case "f32":
      return 4;
    case "f16":
    case "bf16":
      return 2;
    case "q8_0":
      return 34 / 32;
    case "q5_1":
      return 24 / 32;
    case "q5_0":
      return 22 / 32;
    case "q4_1":
      return 20 / 32;
    case "q4_0":
    case "iq4_nl":
      return 18 / 32;
    default:
      return 2;
  }
}

/** The KV cache for `contextTokens`: layers × KV heads × (key + value length) × bytes per element. */
export function kvBytes(shape: ModelShape, contextTokens: number, kvType: string): number {
  return Math.round(
    shape.layers *
      shape.kvHeads *
      (shape.keyLength + shape.valueLength) *
      kvBytesPerElement(kvType) *
      contextTokens,
  );
}

/** KV per token when the header gives no shape: 0.1 MB (D), about a 30B model's at q8_0. */
const UNKNOWN_KV_BYTES_PER_TOKEN = 100_000;

export interface MemoryBreakdown {
  weightsBytes: Graded;
  kvBytes: Graded;
  computeBufferBytes: Graded;
  promptCacheBytes: Graded;
  totalBytes: Graded;
  contextTokens: number;
  kvType: string;
}

/** A value read from the file is as exact as a measured one when summed. */
const worst = (...grades: NumberGrade[]): NumberGrade =>
  grades.includes("design") && grades.every((g) => g === "design")
    ? "design"
    : grades.some((g) => g !== "measured" && g !== "file")
      ? "estimated"
      : "measured";

/**
 * The memory a model needs at a context and KV type (DB-NM14-2): the
 * weights as they sit on disk (from the file), the KV from the header's shape
 * (estimated), the compute buffer and prompt cache from a record when given,
 * else our D values.
 */
export function memoryBreakdown(
  model: Pick<FoundModel, "sizeBytes" | "metadata">,
  settings: {
    contextTokens: number;
    kvType: string;
    computeBufferBytes?: Graded;
    promptCacheBytes?: Graded;
  },
): MemoryBreakdown {
  const shape = model.metadata.shape;
  const kv: Graded = shape
    ? { value: kvBytes(shape, settings.contextTokens, settings.kvType), grade: "estimated" }
    : {
        value: Math.round(
          UNKNOWN_KV_BYTES_PER_TOKEN *
            settings.contextTokens *
            (kvBytesPerElement(settings.kvType) / (34 / 32)),
        ),
        grade: "design",
      };
  const weights: Graded = { value: model.sizeBytes, grade: "file" };
  const compute = settings.computeBufferBytes ?? {
    value: HEADROOM_DEFAULTS.defaultComputeBufferBytes,
    grade: "design",
  };
  const cache = settings.promptCacheBytes ?? { value: DEFAULT_PROMPT_CACHE_BYTES, grade: "design" };
  const total = weights.value + kv.value + compute.value + cache.value;
  return {
    weightsBytes: weights,
    kvBytes: kv,
    computeBufferBytes: compute,
    promptCacheBytes: cache,
    totalBytes: {
      value: total,
      grade:
        worst(weights.grade, kv.grade, compute.grade, cache.grade) === "measured"
          ? "measured"
          : "estimated",
    },
    contextTokens: settings.contextTokens,
    kvType: settings.kvType,
  };
}

/** What is resident now: another role's model (ours, unloadable) or a person's own process. */
export interface ResidentFootprint {
  /** As a sentence names it: "the Worker", "the Planner", "Hermes on 8080". */
  name: string;
  footprintBytes: number;
  /** Started by the harness; a person's own process is never unloaded (rule 20g). */
  ours: boolean;
}

export interface FitHost {
  /** The live headroom now (rule 20g), measured with no compute buffer taken off. */
  headroom: Graded;
  resident?: readonly ResidentFootprint[];
  gpuWiredLimitBytes?: number;
  /** The GPU ceiling: the seed until calibrated (MD-N14-33a). */
  gpuCeilingBytes?: number;
  /** Per-role context and KV type (profiles); ROLE_SETTINGS otherwise. */
  roleSettings?: Partial<Record<ConfigRole, { contextTokens: number; kvType: string }>>;
  computeBufferBytes?: Graded;
  promptCacheBytes?: Graded;
  /** The swap's time from measured loads (C_pair, rule 20d), for a `swaps` verdict. */
  swapSeconds?: (model: FoundModel, role: ConfigRole) => Graded | undefined;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** A role list in words: "the Worker", "the Worker and the Planner". */
const names = (list: readonly string[]) =>
  list.length <= 1 ? (list[0] ?? "") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/**
 * One model's fit for one role (MD-N12-3): *fits*, *fits, swaps with the
 * other roles* (it fits alone but not beside what is resident, or it is a
 * second large model, rule 22), or *needs N GB* (the shortfall in words). A
 * `no` is listed, never loaded, benchmarked or recommended.
 */
export function fitFor(model: FoundModel, role: ConfigRole, host: FitHost): FitVerdict {
  const settings = host.roleSettings?.[role] ?? ROLE_SETTINGS[role];
  const b = memoryBreakdown(model, {
    ...settings,
    ...(host.computeBufferBytes ? { computeBufferBytes: host.computeBufferBytes } : {}),
    ...(host.promptCacheBytes ? { promptCacheBytes: host.promptCacheBytes } : {}),
  });
  const required = b.totalBytes.value;
  const ours = (host.resident ?? []).filter((r) => r.ours);
  // Alone: our own servers would be unloaded; a person's processes stay.
  const usableAlone = host.headroom.value + ours.reduce((n, r) => n + r.footprintBytes, 0);
  const breakdown = {
    weightsBytes: b.weightsBytes.value,
    kvBytes: b.kvBytes.value,
    computeBufferBytes: b.computeBufferBytes.value,
    promptCacheBytes: b.promptCacheBytes.value,
    contextTokens: b.contextTokens,
    kvType: b.kvType,
  };
  const requiredBytes: Graded = { value: required, grade: "estimated" };
  const grade: NumberGrade = host.headroom.grade === "design" ? "design" : "estimated";
  const verdict = (fits: FitLabel, headroom: number, reason: string): FitVerdict => ({
    role,
    fits,
    requiredBytes,
    headroomBytes: { value: headroom, grade },
    breakdown,
    reason,
  });
  // The GPU part (weights, KV, compute buffer) against the GPU ceiling (rule 20g).
  const gpuPart = b.weightsBytes.value + b.kvBytes.value + b.computeBufferBytes.value;
  if (host.gpuCeilingBytes !== undefined && gpuPart > host.gpuCeilingBytes) {
    return verdict(
      "no",
      host.gpuCeilingBytes - gpuPart,
      `Needs ${gb(gpuPart - host.gpuCeilingBytes)} more: ${gb(gpuPart)} on the GPU is above this machine's GPU ceiling of ${gb(host.gpuCeilingBytes)}`,
    );
  }
  if (required > usableAlone) {
    return verdict(
      "no",
      usableAlone - required,
      `Needs ${gb(required - usableAlone)} more: ${gb(required)} of ${gb(usableAlone)} usable`,
    );
  }
  const large =
    host.gpuWiredLimitBytes !== undefined &&
    isLargeModel(gpuPart, host.gpuWiredLimitBytes) &&
    ours.some((r) => isLargeModel(r.footprintBytes, host.gpuWiredLimitBytes as number));
  if (ours.length > 0 && (required > host.headroom.value || large)) {
    const v = verdict(
      "swaps",
      host.headroom.value - required,
      `${gb(required)} of ${gb(usableAlone)} usable; swaps with ${names(ours.map((r) => r.name))}`,
    );
    const swap = host.swapSeconds?.(model, role);
    return swap ? { ...v, swapSeconds: swap } : v;
  }
  return verdict("yes", usableAlone - required, `${gb(required)} of ${gb(usableAlone)} usable`);
}

/** Every role's fit for every model (PM_CONTRACT `FoundModel.fits` and `fitReason`). */
export function applyFits(models: readonly FoundModel[], host: FitHost): FoundModel[] {
  return models.map((m) => {
    const fit: Partial<Record<ConfigRole, FitVerdict>> = {};
    const fits: Partial<Record<ConfigRole, FitLabel>> = {};
    const fitReason: Partial<Record<ConfigRole, string>> = {};
    for (const role of CONFIG_ROLES) {
      const v = fitFor(m, role, host);
      fit[role] = v;
      fits[role] = v.fits;
      fitReason[role] = v.reason;
    }
    return { ...m, fit, fits, fitReason };
  });
}
