import { createHash } from "node:crypto";

/**
 * What a qualification qualifies (models rule 27a, MD-N8-1): the tuple
 * (engine, model build, host fingerprint, settings). A model assigned to a
 * role on a host is refused until that exact combination has passed, and a
 * change to any element invalidates it, naming the element (MD-N8-4).
 */

/** Speculative decoding in a combination: off, the model's MTP head, or a draft model (by its id). */
export type SpeculativeSetting = "off" | "mtp" | { draft: string };

/**
 * The role's sampling, as the combination records it (MD-N8-1): the Worker
 * is qualified at the sampling it runs at, so a change of sampling is a
 * change of combination. Only the fields that shape the draw are keyed.
 */
export interface SamplingSettings {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

export interface QualificationSettings {
  /** The window one request gets. */
  contextTokens: number;
  /** KV cache type (`-ctk`/`-ctv`). */
  kvType: string;
  speculative: SpeculativeSetting;
  /** Prompt caching on (`--cache-ram`, `--ctx-checkpoints`), as it runs in production. */
  prefixCaching: boolean;
  /** Server slots (`-np`). */
  parallelSlots: number;
  /** The chat template's checksum, or "unpinned" when none is pinned. */
  chatTemplate: string;
  /** The Worker's context version: its prompt templates and tool catalog (context.md rule 27). */
  contextVersion: string;
  /**
   * The sampling the role runs at (suite q1.2). Absent in a record made
   * before sampling was keyed (q1.1, greedy), which then differs from any
   * sampled combination by "sampling".
   */
  sampling?: SamplingSettings;
}

export interface QualificationCombination {
  /** The engine and its build, e.g. "llama.cpp b7000 (abc1234)" or "ollama". */
  engine: string;
  /** The weights: a sampled digest of the model file, or the engine's own tag. */
  modelBuild: string;
  /** `hostFingerprintHash()`. */
  host: string;
  settings: QualificationSettings;
}

/** Each element, with the name a person reads when it changes. */
const ELEMENTS: [name: string, read: (c: QualificationCombination) => unknown][] = [
  ["engine", (c) => c.engine],
  ["model build", (c) => c.modelBuild],
  ["host", (c) => c.host],
  ["context size", (c) => c.settings.contextTokens],
  ["KV type", (c) => c.settings.kvType],
  ["speculative decoding", (c) => c.settings.speculative],
  ["prefix caching", (c) => c.settings.prefixCaching],
  ["parallel slots", (c) => c.settings.parallelSlots],
  ["chat template", (c) => c.settings.chatTemplate],
  ["context version", (c) => c.settings.contextVersion],
  ["sampling", (c) => canonicalSampling(c.settings.sampling)],
];

/** The keyed sampling fields in a fixed order; undefined when none is recorded. */
function canonicalSampling(s: SamplingSettings | undefined): unknown {
  if (!s) return undefined;
  return [s.temperature ?? null, s.topP ?? null, s.topK ?? null, s.minP ?? null];
}

/**
 * The canonical form: every element in a fixed order, so key order never
 * matters. A combination without sampling keys as it did before sampling
 * was an element, so records made then keep their keys.
 */
function canonical(c: QualificationCombination): string {
  return JSON.stringify(
    ELEMENTS.filter(([name, read]) => name !== "sampling" || read(c) !== undefined).map(
      ([name, read]) => [name, read(c)],
    ),
  );
}

/** A stable key for a combination, 16 hex characters. */
export function combinationKey(c: QualificationCombination): string {
  return createHash("sha256").update(canonical(c)).digest("hex").slice(0, 16);
}

/** The elements that differ between two combinations, in a fixed order (MD-N8-4). */
export function changedCombinationElements(
  a: QualificationCombination,
  b: QualificationCombination,
): string[] {
  return ELEMENTS.filter(([, read]) => JSON.stringify(read(a)) !== JSON.stringify(read(b))).map(
    ([name]) => name,
  );
}

/** A speculative setting as a person reads it. */
export function describeSpeculative(s: SpeculativeSetting): string {
  return s === "off" ? "off" : s === "mtp" ? "MTP" : `draft model ${s.draft}`;
}

/** The combination on one line, for a refusal or a report. */
export function describeCombination(c: QualificationCombination): string {
  const s = c.settings;
  const sampling = s.sampling
    ? `, temperature ${s.sampling.temperature ?? "default"}, top_p ${s.sampling.topP ?? "default"}, top_k ${s.sampling.topK ?? "default"}, min_p ${s.sampling.minP ?? "default"}`
    : "";
  return `${c.engine}, ${s.contextTokens} tokens, KV ${s.kvType}, speculative ${describeSpeculative(s.speculative)}, prefix caching ${s.prefixCaching ? "on" : "off"}, ${s.parallelSlots} slot${s.parallelSlots === 1 ? "" : "s"}${sampling}`;
}
