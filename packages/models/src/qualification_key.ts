import { createHash } from "node:crypto";

/**
 * What a qualification qualifies (models rule 27a, MD-N8-1): the tuple
 * (engine, model build, host fingerprint, settings). A model assigned to a
 * role on a host is refused until that exact combination has passed, and a
 * change to any element invalidates it, naming the element (MD-N8-4).
 */

/** Speculative decoding in a combination: off, the model's MTP head, or a draft model (by its id). */
export type SpeculativeSetting = "off" | "mtp" | { draft: string };

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
];

/** The canonical form: every element in a fixed order, so key order never matters. */
function canonical(c: QualificationCombination): string {
  return JSON.stringify(ELEMENTS.map(([name, read]) => [name, read(c)]));
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
  return `${c.engine}, ${s.contextTokens} tokens, KV ${s.kvType}, speculative ${describeSpeculative(s.speculative)}, prefix caching ${s.prefixCaching ? "on" : "off"}, ${s.parallelSlots} slot${s.parallelSlots === 1 ? "" : "s"}`;
}
