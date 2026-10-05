import { existsSync } from "node:fs";
import { UNFILLED, currentAssignment } from "./assignments.js";
import { hostFingerprintHash } from "./calibration.js";
import {
  GENERIC_ROLE_WINDOWS,
  ManagedLlamaServerAdapter,
  cacheProfileForHost,
  createApodexResearcher,
  createCyberTielWorker,
  createGenericManaged,
} from "./llama_server.js";
import { ModelRegistry } from "./registry.js";
import { resolveWorkerModelId } from "./roster.js";
import type { ModelRole } from "./types.js";

/**
 * The shipped set and the supported hardware (models rules 3, 4 and 8a,
 * NEW-models-22; DEC-47 O-5). One table: the download sources
 * (`MODEL_SOURCES`, hf_lookup.ts), the Team compose services
 * (`team_engines.ts`), the recommended set and PROVENANCE's *Model weights
 * and engine* check are all derived from it.
 *
 * A row is filled only from a verified lookup (C3, 2026-10-04): the hub's
 * tree API gave each file's LFS SHA-256 and size, its model card
 * (`cardData.license`) the licence, and each hash was cross-checked against
 * the reference host — the hash its registry recorded (Coding, Planning, the
 * baseline) or the one computed from its copy (Research). A role whose file
 * cannot be verified has no source and says why; no hash is guessed.
 */

/** A role in the product's words (NAMING.md). */
export type ShippedRole = "coding" | "planning" | "research" | "review";

/** The roster's name for each role. */
export const SHIPPED_ROLE_MODEL_ROLE: Readonly<Record<ShippedRole, ModelRole>> = {
  coding: "worker",
  planning: "planner",
  research: "researcher",
  review: "reviewer",
};

/** Where a shipped file comes from, as verified. */
export interface ShippedSource {
  repo: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  /** SPDX identifier. */
  license: string;
}

export interface ShippedModel {
  role: ShippedRole;
  /** The registry id; undefined while the role is unfilled. */
  id?: string;
  /** As a person reads it. */
  name?: string;
  family?: string;
  source?: ShippedSource;
  /**
   * The llama.cpp build its qualification on the reference host recorded
   * (rule 6a); undefined for a model not yet qualified.
   */
  minLlamaBuild?: number;
  /** Qualified for its role on the reference host (rule 27a). */
  qualified: boolean;
  /** Where it was verified, or why the role is unfilled or the model not yet verified. */
  note: string;
  /** For an unfilled role: the models that may fill it once admitted. */
  candidates?: readonly string[];
}

export const SHIPPED_MODELS: readonly ShippedModel[] = [
  {
    role: "coding",
    id: "nail-mtp",
    name: "Nail-Qwen3.6-35B-A3B MTP (UD-IQ3_XXS)",
    family: "qwen",
    source: {
      repo: "peculiar-ragdoll/Nail-Qwen3.6-35B-A3B-GGUF-MTP",
      file: "Nail-Qwen3.6-35B-A3B-MTP-UD-IQ3_XXS.gguf",
      sha256: "6275d06c6e1b0d0a4e07a69a5fbdc719dbaeaae87bc48e6c8377f4cd58ec369c",
      sizeBytes: 14_069_275_872,
      license: "Apache-2.0",
    },
    minLlamaBuild: 10809,
    qualified: true,
    note: "Qualified for Coding on the 24 GB reference host (suite q1.2, llama.cpp b10809, 2026-10-04).",
  },
  {
    role: "planning",
    id: "qwen3.8-27b-gsq-rco",
    name: "Qwen3.8-27B GSQ-RCO (IQ3_S, MTP head)",
    family: "qwen",
    source: {
      repo: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
      file: "Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
      sha256: "58fd826723939933dc86f45b7fe04545cbc2de1c70f6fe2cdd3858c87a98c12f",
      sizeBytes: 12_120_016_960,
      license: "Apache-2.0",
    },
    minLlamaBuild: 10809,
    qualified: true,
    note: "Qualified for Planning on the 24 GB reference host (suite q1.2, llama.cpp b10809, 2026-09-30).",
  },
  {
    role: "research",
    id: "apodex-1.1-mini",
    name: "Apodex-1.1-mini (IQ3_M)",
    family: "qwen",
    source: {
      repo: "abenzerps/Apodex-1.1-mini-GGUF",
      file: "Apodex-1.1-mini-IQ3_M.gguf",
      sha256: "8620c43276492c59be49269b0cce52ca4f6698c73154751274fa73eb831fb38a",
      sizeBytes: 16_022_990_656,
      license: "Apache-2.0",
    },
    qualified: false,
    note: "Not yet verified on this machine: the file matches the reference host's copy, but no qualification is recorded for it yet, so its engine floor is unset until it qualifies.",
  },
  {
    role: "review",
    qualified: false,
    note: "The Review role is unfilled until a model is admitted for it (RG-P8-13); until then a change reaches you without an AI review, and its issue says so.",
    candidates: ["gpt-oss-20b", "glm-4.7-flash", "gemma-4-26b-a4b"],
  },
];

/** The managed Worker profile's id (`createCyberTielWorker`). */
const CYBER_TIEL_ID = "cyber-tiel-coder-35b-a3b-mtp-iq3xxs";

/**
 * Cyber-Tiel, the measurement-baseline profile (DEC-04, rule 2): on port
 * 8098 and in the frozen suite, with its verified source, but not a shipped
 * or recommended role (DEC-47 O-5).
 */
export const MEASUREMENT_BASELINE: readonly ShippedModel[] = [
  {
    role: "coding",
    id: CYBER_TIEL_ID,
    name: "Cyber-Tiel-Coder-35B-A3B MTP (UD-IQ3_XXS)",
    family: "qwen",
    source: {
      repo: "peculiar-ragdoll/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP",
      file: "Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
      sha256: "d60adb32312166b49ceffbd10aed297aee69626b45ec4e720700450ee048bd0e",
      sizeBytes: 13_600_579_904,
      license: "MIT",
    },
    minLlamaBuild: 10809,
    qualified: false,
    note: "The measurement baseline (DEC-04), not a shipped role.",
  },
];

/** The shipped row for a role. */
export function shippedModel(role: ShippedRole): ShippedModel {
  return SHIPPED_MODELS.find((m) => m.role === role) as ShippedModel;
}

/** A role in the product's words or the roster's; undefined for anything else. */
export function shippedRoleOf(word: string): ShippedRole | undefined {
  const w = word.trim().toLowerCase();
  for (const [role, roster] of Object.entries(SHIPPED_ROLE_MODEL_ROLE))
    if (w === role || w === roster) return role as ShippedRole;
  return undefined;
}

/** The engine floor of the shipped set: the highest `minLlamaBuild` (rule 6b's pin is at or above it). */
export const SHIPPED_ENGINE_FLOOR: number = Math.max(
  ...SHIPPED_MODELS.map((m) => m.minLlamaBuild ?? 0),
);

/** One row of rule 8a's supported-hardware table. */
export interface SupportedTier {
  tier: "S" | "M" | "L" | "XL";
  /** Installed memory, GB (2^30 bytes), inclusive lower bound. */
  minInstalledGiB: number;
  platforms: readonly string[];
  supported: boolean;
  /** The shipped roles this tier runs (the filled ones). */
  set: readonly ShippedRole[];
  residency: string;
}

const PLATFORMS = [
  "macOS arm64 (Metal)",
  "Linux x64 (CPU or Vulkan; CUDA and ROCm by building llama.cpp)",
] as const;
const FILLED = SHIPPED_MODELS.filter((m) => m.id).map((m) => m.role);

export const SUPPORTED_HARDWARE: readonly SupportedTier[] = [
  {
    tier: "S",
    minInstalledGiB: 0,
    platforms: [],
    supported: false,
    set: [],
    residency:
      "v1 supports 24 GB of memory and above (DEC-47 O-5); you may continue at your own risk.",
  },
  {
    tier: "M",
    minInstalledGiB: 24,
    platforms: PLATFORMS,
    supported: true,
    set: FILLED,
    residency: "One large model at a time: the roles swap.",
  },
  {
    tier: "L",
    minInstalledGiB: 48,
    platforms: PLATFORMS,
    supported: true,
    set: FILLED,
    residency: "Coding and Planning resident together; Research swaps.",
  },
  {
    tier: "XL",
    minInstalledGiB: 96,
    platforms: PLATFORMS,
    supported: true,
    set: FILLED,
    residency: "Every shipped role resident.",
  },
];

/**
 * How far below a tier's installed size the reported total may read and still
 * be that machine: Linux's MemTotal leaves out what the kernel and firmware
 * keep (a 24 GB machine reads about 23.4 GiB), and macOS reports it whole.
 */
const REPORTED_MEMORY_SLACK = 0.94;

/** The supported-hardware row for a machine's installed memory, as the OS reports it. */
export function supportedTierFor(installedBytes: number): SupportedTier {
  const gib = installedBytes / 1024 ** 3;
  return [...SUPPORTED_HARDWARE]
    .reverse()
    .find((t) => gib >= t.minInstalledGiB * REPORTED_MEMORY_SLACK) as SupportedTier;
}

export interface SetPlanModel {
  role: ShippedRole;
  id: string;
  name: string;
  file: string;
  /** The size of the source the download will use: the registry's recorded source, else the shipped row's. */
  sizeBytes: number;
  license: string;
  /** A readable copy is already recorded on this machine. */
  present: boolean;
}

export interface SetPlan {
  models: SetPlanModel[];
  unfilled: { role: ShippedRole; reason: string }[];
  /** The bytes still to download: the models not present. */
  totalBytes: number;
  /** Each distinct licence of the set. */
  licenses: string[];
}

/**
 * What fetching the recommended set means, before the yes (MD-N18-3,
 * MD-N22-3): each filled role's file, size and licence, whether it is
 * already here, the total still to download, and each unfilled role with
 * its reason. Shown by `models fetch --recommended` and the page.
 */
export function recommendedSetPlan(opts: { registry?: ModelRegistry } = {}): SetPlan {
  const registry = opts.registry ?? new ModelRegistry();
  const models: SetPlanModel[] = [];
  const unfilled: SetPlan["unfilled"] = [];
  for (const m of SHIPPED_MODELS) {
    if (!m.id || !m.source) {
      unfilled.push({ role: m.role, reason: m.note });
      continue;
    }
    const copy = registry.preferredWeights(m.id);
    models.push({
      role: m.role,
      id: m.id,
      name: m.name ?? m.id,
      file: m.source.file,
      sizeBytes: registry.get(m.id)?.source?.sizeBytes ?? m.source.sizeBytes,
      license: m.source.license,
      present: copy !== undefined && existsSync(copy),
    });
  }
  return {
    models,
    unfilled,
    totalBytes: models.filter((m) => !m.present).reduce((n, m) => n + m.sizeBytes, 0),
    licenses: [...new Set(models.map((m) => m.license))],
  };
}

/**
 * Each shipped role's own port (rule 26a): the managed roles' ports, so no
 * two shipped engines share one. The generic port (`genericManagedPort`, a
 * hash of the id) puts `nail-mtp` and `qwen3.8-27b-gsq-rco` both on 8182,
 * which co-resident roles cannot share.
 */
export const SHIPPED_ROLE_PORTS: Readonly<Record<Exclude<ShippedRole, "review">, number>> = {
  coding: 8098,
  planning: 8099,
  research: 8101,
};

/**
 * The launch a shipped row runs under (rule 26a): the Research model's
 * managed profile; any other its generic managed profile for the role
 * (MD-N12-10), as the roster launches a registered GGUF; each on its role's
 * port (`SHIPPED_ROLE_PORTS`). `totalBytes` sizes the host-dependent values
 * — the prompt-cache flags and the Research window — for a machine other
 * than this one (the Team compose's host); `slotCacheDir` names where the
 * server saves its slots (`--slot-save-path`). `want` is the window a caller
 * asks for (the roster's `ResolveOptions`: ModelAccess resolves shared
 * weights once, at the largest window their queues need), honoured by the
 * generic profile as for any registered GGUF; the Research model keeps its
 * managed, host-sized window.
 */
export function shippedAdapter(
  model: ShippedModel,
  opts: {
    modelPath: string;
    totalBytes?: number;
    registry?: ModelRegistry;
    slotCacheDir?: string;
    want?: { contextTokens?: number; maxTokens?: number };
  },
): ManagedLlamaServerAdapter {
  if (!model.id || model.role === "review")
    throw new Error(`The ${model.role} role is unfilled: ${model.note}`);
  const entry = opts.registry?.get(model.id);
  const base =
    model.id === "apodex-1.1-mini"
      ? createApodexResearcher(opts.modelPath, undefined, opts.totalBytes)
      : createGenericManaged({
          modelId: model.id,
          modelPath: opts.modelPath,
          role: SHIPPED_ROLE_MODEL_ROLE[model.role],
          ...(entry ? { entry } : {}),
          ...(opts.want ? { want: opts.want } : {}),
        });
  return new ManagedLlamaServerAdapter({
    ...base.launchProfile,
    port: SHIPPED_ROLE_PORTS[model.role],
    ...(opts.totalBytes !== undefined ? { cache: cacheProfileForHost(opts.totalBytes) } : {}),
    ...(opts.slotCacheDir !== undefined ? { slotCacheDir: opts.slotCacheDir } : {}),
  });
}

/**
 * The resolved Coding model's window, from the registry (MD-N4-10): the
 * window of the model this host assigned to the Coding role, else the
 * shipped Coding model's. A registered window (`contextWindow`) wins; a
 * model without one runs at the Worker's managed window, capped by its
 * header's trained context (MD-N12-10). The planner's default budget reads
 * it when a caller passes none; the harness passes its own resolution.
 */
export function codingModelWindowTokens(
  opts: { registry?: ModelRegistry; host?: string } = {},
): number {
  const registry = opts.registry ?? new ModelRegistry();
  const assigned = currentAssignment(registry, opts.host ?? hostFingerprintHash(), "worker")?.model;
  const id =
    assigned && assigned !== UNFILLED
      ? resolveWorkerModelId(assigned)
      : (shippedModel("coding").id as string);
  const entry = registry.get(id);
  if (entry?.contextWindow) return entry.contextWindow;
  if (id === CYBER_TIEL_ID) return createCyberTielWorker().totalContextTokens();
  const window = GENERIC_ROLE_WINDOWS.worker.contextTokens;
  const trained = entry?.header?.contextLength;
  return trained ? Math.min(window, trained) : window;
}
