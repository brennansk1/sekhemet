import type { ModelRole } from "./types.js";

/**
 * The model library's shapes (B4.1 step 0): what a scan of the model folders
 * finds, how each model fits this machine per role, and each role's
 * assignment. Types only; the scan (`model_scan.ts`), fit (`model_fit.ts`)
 * and recommendation (`recommend.ts`) arrive with B4.1 part (b).
 *
 * The wire shapes are [PM_CONTRACT §3](../../../docs/design/PM_CONTRACT.md)
 * *Configuration*; the fields beyond them are the models spec's
 * (NEW-models-12, NEW-models-13, NEW-models-14 rule 20k) and the dashboard's
 * model details (DB-NM14-1–5).
 */

/** A role on the Configuration page: the four model roles, and `vision` for images on cards (PM_CONTRACT §3). */
export type ConfigRole = ModelRole | "vision";

/**
 * How a number is known (dashboard DB-NM14-1): recorded on this machine by a
 * run, read from the model's file itself (its size, its header — shown *From
 * the file*), computed before a measurement, or one of our design values not
 * yet tuned by replay.
 */
export type NumberGrade = "measured" | "file" | "estimated" | "design";

/** A number with its grade; every number the model section renders carries one (DB-NM14-1). */
export interface Graded<T = number> {
  value: T;
  grade: NumberGrade;
  /** The spread of an estimate where it has one (dashboard §2.16 item 1a). */
  low?: T;
  high?: T;
}

/** Where a model folder was named (models rule 6, PM_CONTRACT `ModelFolder.source`). */
export type ModelFolderSource = "config" | "flag" | "env";

/**
 * A model folder (models rule 4a, MD-N13-1, PM_CONTRACT `ModelFolder`). It is
 * only read, never written, and nothing outside it is read.
 */
export interface ModelFolder {
  path: string;
  /** `config.toml` (`[models] folders`), `--models-dir`, `SEKHEMET_MODELS_DIR`. */
  source: ModelFolderSource;
  /** Scan subfolders to the depth limit (default 6) and file-count limit (default 5,000), MD-N13-1. */
  includeSubfolders: boolean;
  readable: boolean;
  /** Why it could not be read. */
  error?: string;
  /** How many models it held at the last scan (dashboard §2.16 item 1). */
  modelCount?: number;
}

/** The weights' on-disk format (models rule 4a). */
export type ModelFormat = "gguf" | "safetensors" | "mlx";

/**
 * Where a metadata value came from (MD-N13-2): the file's header, a Hugging
 * Face lookup under the research policy (SEC-N10-3), or our registry.
 */
export type MetadataSource = "header" | "huggingface" | "registry";

/** The metadata a model's header (or a lookup) gives, without loading it (MD-N12-1, MD-N13-2). */
export interface ModelMetadata {
  /** GGUF `general.architecture`, or `config.json`'s model type. */
  architecture?: string;
  /** The family; decides the Reviewer's eligibility (models rule 3, MD-N12-4). */
  family?: string;
  baseModel?: string;
  parametersTotal?: number;
  /** Active parameters per token, for a mixture of experts (MD-N13-3's bytes per token). */
  parametersActive?: number;
  /** The file type, e.g. `IQ3_XXS`, `Q4_K_M`, `BF16`. */
  quantisation?: string;
  /** Bits per weight, for the speed prediction (MD-N13-3). */
  bitsPerWeight?: number;
  /** The trained maximum context, in tokens. */
  contextLength?: number;
  license?: string;
  /** Each value's source (MD-N13-2); a key absent here came from the header. */
  sources?: Partial<Record<Exclude<keyof ModelMetadata, "sources" | "shape">, MetadataSource>>;
  /** The attention shape the KV estimate needs (rule 4b), from the header. */
  shape?: ModelShape;
}

/** The attention shape from a GGUF header, for KV bytes per token (MD-N12-3). */
export interface ModelShape {
  layers: number;
  /** KV heads (grouped-query attention); the largest per-layer value when the header lists them. */
  kvHeads: number;
  keyLength: number;
  valueLength: number;
  embeddingLength?: number;
  /** Mixture of experts: experts and those used per token. */
  expertCount?: number;
  expertUsedCount?: number;
}

/**
 * The hash state (MD-N12-2): computed in the background after the scan; a
 * model is *Verified* only when it matches the registry's published SHA-256.
 */
export type HashState = "pending" | "verified" | "hash_differs" | "not_registry";

/** The PM_CONTRACT fit label per role: fits, fits but swaps with the other roles, or needs more memory. */
export type FitLabel = "yes" | "swaps" | "no";

/**
 * A found model's fit for one role (models rule 4b, MD-N12-3): weights plus KV
 * at the role's context and KV type plus the engine's buffers, against the
 * usable memory (the live headroom, rule 20g). A `no` is listed and never
 * loaded, benchmarked or recommended.
 */
export interface FitVerdict {
  role: ConfigRole;
  fits: FitLabel;
  /** What the model needs for this role, in bytes. */
  requiredBytes: Graded;
  /** Usable bytes left after it; negative is the shortfall ("needs N GB"). */
  headroomBytes: Graded;
  /** The breakdown the model details show (DB-NM14-2), recomputed by the what-if without loading. */
  breakdown?: {
    weightsBytes: number;
    kvBytes: number;
    computeBufferBytes: number;
    promptCacheBytes: number;
    contextTokens: number;
    kvType: string;
  };
  /** For `swaps`: the swap's time from measured loads (C_pair, rule 20d). */
  swapSeconds?: Graded;
  /** In words, e.g. "13 GB of 16 GB usable; swaps with the Planner". */
  reason: string;
}

/** A vision projector (`mmproj`): a companion of its model, not a model (MD-N12-1). */
export interface ModelCompanion {
  kind: "mmproj";
  path: string;
  sizeBytes: number;
}

/**
 * A model a scan found (MD-N12-1, MD-N13-1, PM_CONTRACT `FoundModel`). A split
 * GGUF is one model with its `parts`; a safetensors or MLX directory is one
 * model named by its directory. The PM_CONTRACT fields come first.
 */
export interface FoundModel {
  /** Stable: the file's SHA-256 once hashed, until then a key derived from its path and size. */
  id: string;
  name: string;
  /** The file (or the first part, or the directory) relative to `folder`. */
  file: string;
  folder: string;
  family?: string;
  sizeBytes: number;
  quantisation: string;
  contextLength: number;
  /** Per role (PM_CONTRACT): the KV cache depends on each role's context (rule 4b). */
  fits: Partial<Record<ConfigRole, FitLabel>>;
  fitReason: Partial<Record<ConfigRole, string>>;
  /** Matches the registry's published SHA-256 (PM_CONTRACT); `hash` says more. */
  verified?: boolean;

  /** The absolute path of the file, first part or directory. */
  path: string;
  format: ModelFormat;
  /** A split GGUF's parts in order (`-00001-of-0000N`), relative to `folder`. */
  parts?: string[];
  companions?: ModelCompanion[];
  /** The SHA-256 once computed (MD-N12-2). */
  sha256?: string;
  hash: HashState;
  metadata: ModelMetadata;
  /** The full verdict per role, from `fitFor` (MD-N12-3). */
  fit?: Partial<Record<ConfigRole, FitVerdict>>;
  /** "no engine here serves this format" (models rule 4a, rule 14), when none does. */
  noEngine?: string;
  /** The registry id when the hash or name matches a registry entry. */
  registryId?: string;
}

/**
 * A file a scan did not list as a model, with its reason (MD-N12-1's
 * unreadable file, MD-N13-1's skipped file, SEC-N10-1/2): an unparseable or
 * oversized header, a symbolic link leaving the folder, a limit reached.
 */
export interface SkippedFile {
  path: string;
  reason:
    | "unreadable"
    | "header_too_large"
    | "symlink_outside"
    | "depth_limit"
    | "file_limit"
    | "not_a_model";
  /** The reason in words, e.g. the parser's error. */
  detail?: string;
}

/**
 * The recommendation for a role (models rule 4c, MD-N12-4, PM_CONTRACT
 * `RoleAssignment.recommendation`). Computing it assigns, loads and downloads
 * nothing (MD-N12-5).
 */
export interface RoleRecommendation {
  model: string;
  /** One plain sentence naming its evidence. */
  reason: string;
  /** Found in a configured folder. */
  present: boolean;
  /** Only a registered source (MD-N12-6). */
  download?: { source: string; sizeBytes: number; sha256: string };
  /** The two best candidates could not be separated by the paired sign test (MD-N12-4). */
  indistinguishableFrom?: string[];
}

/** A role's assignment on the Configuration page (models rule 4d, PM_CONTRACT `RoleAssignment`). */
export interface RoleAssignment {
  role: ConfigRole;
  /** The name people read, e.g. Seshat's model under `planner`. */
  model?: string;
  state: "resident" | "swapped_out" | "not_configured";
  /** Passed qualification for this role on this host (models rule 27a). */
  qualified: boolean;
  /** Why the role is unfilled, in words (review-git §2.3.7 for the Reviewer). */
  unfilledReason?: string;
  recommendation?: RoleRecommendation;
  /** The previous assignment, which **Restore previous** brings back (MD-N10-2). */
  previous?: string;
}
