import { createHash } from "node:crypto";
import type { ModelRole, ReasoningLevel, ToolCallFormat } from "./types.js";

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
  /**
   * The role's prompt version (context.md rule 27, CX-N6-4): the role's own
   * templates, copy modules, tool schemas and budget policy. A qualification
   * depends on this and on no other role's prompts (live-test F24).
   */
  contextVersion: string;
  /**
   * The role the qualification is for (models rule 4d, MD-N10-3). Absent is
   * the Coding model's (the Worker's): records made before roles were keyed
   * were all the Coding model's, and keep their keys.
   */
  role?: ModelRole;
  /**
   * The sampling the role runs at (suite q1.2). Absent in a record made
   * before sampling was keyed (q1.1, greedy), which then differs from any
   * sampled combination by "sampling".
   */
  sampling?: SamplingSettings;
  /**
   * The repeat and presence penalties a person set for the role
   * (NEW-models-21, MD-N21-3). Absent until set, so every earlier record
   * keeps its key.
   */
  penalties?: { repeat?: number; presence?: number };
  /** The reasoning level and thinking cap a person set for the role (R3c, MD-N21-3). */
  reasoning?: { level?: ReasoningLevel; capTokens?: number };
  /** Flash attention, when a person set it (on is the launch's default). */
  flashAttention?: boolean;
  /** The tool arm a person chose for the role over the measured one. */
  toolArm?: ToolCallFormat;
}

/**
 * The values a person may set for a role that the combination keys
 * (NEW-models-21): the subset of `RoleSettingValues` (registry.ts) that can
 * change what the model emits. Speed-only and harness values (seed, GPU
 * layers, load mode, method, evidence gate, step budget) are not here.
 */
export interface CombinationSettingValues {
  contextTokens?: number;
  kvType?: string;
  slots?: number;
  mtp?: "auto" | "off";
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  repeatPenalty?: number;
  presencePenalty?: number;
  reasoningLevel?: ReasoningLevel;
  reasoningCapTokens?: number;
  flashAttention?: boolean;
  toolArm?: "auto" | ToolCallFormat;
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
  ["role", (c) => roleOf(c)],
  ["repeat and presence penalties", (c) => canonicalPenalties(c.settings.penalties)],
  ["reasoning", (c) => canonicalReasoning(c.settings.reasoning)],
  ["flash attention", (c) => c.settings.flashAttention],
  ["tool arm", (c) => c.settings.toolArm],
];

/** Elements absent from a combination until a person sets them (NEW-models-21): an absent one keys as before. */
const OPTIONAL = new Set([
  "sampling",
  "repeat and presence penalties",
  "reasoning",
  "flash attention",
  "tool arm",
]);

function canonicalPenalties(p: QualificationSettings["penalties"]): unknown {
  if (!p || (p.repeat === undefined && p.presence === undefined)) return undefined;
  return [p.repeat ?? null, p.presence ?? null];
}

function canonicalReasoning(r: QualificationSettings["reasoning"]): unknown {
  if (!r || (r.level === undefined && r.capTokens === undefined)) return undefined;
  return [r.level ?? null, r.capTokens ?? null];
}

/** The role a combination is qualified for: absent is the Coding model's (the Worker's). */
export function roleOf(c: Pick<QualificationCombination, "settings">): ModelRole {
  return c.settings.role ?? "worker";
}

/** The keyed sampling fields in a fixed order; undefined when none is recorded. */
function canonicalSampling(s: SamplingSettings | undefined): unknown {
  if (!s) return undefined;
  return [s.temperature ?? null, s.topP ?? null, s.topK ?? null, s.minP ?? null];
}

/**
 * The canonical form: every element in a fixed order, so key order never
 * matters. A combination without sampling keys as it did before sampling
 * was an element, and the Coding model's as it did before roles were, so
 * records made then keep their keys.
 */
function canonical(c: QualificationCombination): string {
  return JSON.stringify(
    ELEMENTS.filter(
      ([name, read]) =>
        (!OPTIONAL.has(name) || read(c) !== undefined) && (name !== "role" || read(c) !== "worker"),
    ).map(([name, read]) => [name, read(c)]),
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

/**
 * The values a person set that the running adapter does not report itself
 * (NEW-models-21, MD-N21-3): the penalties, the reasoning level and cap,
 * flash attention and the tool arm. The registry folds these into a
 * combination when it records or looks one up, so a change to any of them
 * is a change of combination, while the context, KV type, slots, MTP and
 * sampling reach the combination through the launch the roster applied
 * them to. Nothing set adds nothing.
 */
export function withRoleExtras(
  c: QualificationCombination,
  v: CombinationSettingValues | undefined,
): QualificationCombination {
  if (!v) return c;
  const settings: QualificationSettings = { ...c.settings };
  if (v.repeatPenalty !== undefined || v.presencePenalty !== undefined)
    settings.penalties = {
      ...(v.repeatPenalty !== undefined ? { repeat: v.repeatPenalty } : {}),
      ...(v.presencePenalty !== undefined ? { presence: v.presencePenalty } : {}),
    };
  if (v.reasoningLevel !== undefined || v.reasoningCapTokens !== undefined)
    settings.reasoning = {
      ...(v.reasoningLevel !== undefined ? { level: v.reasoningLevel } : {}),
      ...(v.reasoningCapTokens !== undefined ? { capTokens: v.reasoningCapTokens } : {}),
    };
  // On is the launch's own default: only off changes what runs.
  if (v.flashAttention === false) settings.flashAttention = false;
  if (v.toolArm !== undefined && v.toolArm !== "auto") settings.toolArm = v.toolArm;
  return { ...c, settings };
}

/**
 * A qualified combination as a person's values would make it (MD-N21-3):
 * every element they set, the launch's ones included, so the page can say
 * *Needs verifying* and name what changed before anything runs.
 */
export function applyRoleSettings(
  c: QualificationCombination,
  v: CombinationSettingValues | undefined,
): QualificationCombination {
  if (!v) return c;
  const out = withRoleExtras(c, v);
  const settings: QualificationSettings = { ...out.settings };
  if (v.contextTokens !== undefined) settings.contextTokens = v.contextTokens;
  if (v.kvType !== undefined) settings.kvType = v.kvType;
  if (v.slots !== undefined) settings.parallelSlots = v.slots;
  if (v.mtp === "off") settings.speculative = "off";
  const sampled =
    v.temperature !== undefined ||
    v.topP !== undefined ||
    v.topK !== undefined ||
    v.minP !== undefined;
  if (sampled)
    settings.sampling = {
      ...(settings.sampling ?? {}),
      ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
      ...(v.topP !== undefined ? { topP: v.topP } : {}),
      ...(v.topK !== undefined ? { topK: v.topK } : {}),
      ...(v.minP !== undefined ? { minP: v.minP } : {}),
    };
  return { ...out, settings };
}

/** A combination without the values a person set that the registry folds in (`withRoleExtras`). */
export function withoutRoleExtras(c: QualificationCombination): QualificationCombination {
  const { penalties: _p, reasoning: _r, flashAttention: _f, toolArm: _t, ...settings } = c.settings;
  return { ...c, settings };
}
