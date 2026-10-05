import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { DEFAULT_STEP_BUDGET } from "@sekhemet/kernel";
import {
  type MachineProfile,
  type TierSettings,
  hostFingerprintHash,
  loadMachineProfile,
  tierSettingsOf,
} from "./calibration.js";
import { recordedGguf } from "./generic_managed.js";
import {
  HttpInferenceAdapter,
  NAIL_WORKER_PROFILE,
  REASONING_BUDGET_TOKENS,
  type SamplingOptions,
} from "./http_adapter.js";
import {
  type ChronicleProfileOptions,
  FAMILY_SAMPLING,
  GENERIC_ROLE_WINDOWS,
  ManagedLlamaServerAdapter,
  createApodexResearcher,
  createCyberTielWorker,
  createGenericManaged,
  createQwen38Managed,
} from "./llama_server.js";
import { resolveModelPath } from "./models_dir.js";
import { assertNotOllamaCloud } from "./ollama_cloud.js";
import {
  type ModelEntry,
  type ModelRegistry,
  ROLE_SETTING_FIELDS,
  type ResolvedSetting,
  type RoleSettingKey,
  type RoleSettingValues,
  type ThinkingPolicy,
  thinkingPolicyFromEnv,
} from "./registry.js";
import { SHIPPED_MODELS, shippedAdapter, shippedRoleOf } from "./shipped_models.js";
import type { ModelRole, UnloadableAdapter } from "./types.js";

/** The inference engine behind an adapter (M24). */
export function engineOf(adapter: unknown): string {
  if (adapter instanceof ManagedLlamaServerAdapter) return "llama.cpp";
  if (adapter instanceof HttpInferenceAdapter)
    return adapter.api === "ollama" ? "ollama" : "openai-compatible";
  return "unknown";
}

/**
 * Names that select a harness-managed llama-server model rather than an
 * Ollama tag. Anything else is passed to Ollama as a model name.
 */
export const MANAGED_MODEL_NAMES = ["cyber-tiel", "apodex", "qwen3.8-27b", "dirk"] as const;
export type ManagedModelName = (typeof MANAGED_MODEL_NAMES)[number];

/**
 * Each managed default's model family (MD-N4-9): the Worker and the Planner
 * are Qwen. The Researcher's family is recorded from its model card when that
 * default is registered; none is claimed here.
 */
export const MANAGED_MODEL_FAMILIES: Partial<Record<ManagedModelName, string>> = {
  "cyber-tiel": "qwen",
  "qwen3.8-27b": "qwen",
  dirk: "qwen",
};

export function isManagedModelName(name: string): name is ManagedModelName {
  return (MANAGED_MODEL_NAMES as readonly string[]).includes(name);
}

/** Ollama settings per role, when a role names an Ollama model. */
/**
 * The model id a Worker name runs as: a managed name resolves to the model
 * its llama-server serves, an Ollama tag to itself without its prefix. The
 * model registry, and SEC-37b's injection record, key on this id. Building
 * the adapter starts no server.
 */
export function resolveWorkerModelId(name: string): string {
  const n = name.replace(/^ollama\//, "");
  if (!isManagedModelName(n)) return n;
  switch (n) {
    case "cyber-tiel":
      return createCyberTielWorker().modelId;
    case "apodex":
      return createApodexResearcher().modelId;
    default:
      return createQwen38Managed({}).modelId;
  }
}

export function ollamaProfileForRole(
  role: ModelRole,
  modelId: string,
): ConstructorParameters<typeof HttpInferenceAdapter>[0] {
  const base = { modelId, apiFormat: "ollama" as const, disableReasoning: true, role };
  switch (role) {
    case "worker":
      return { ...NAIL_WORKER_PROFILE, modelId, role };
    case "planner":
      return {
        ...base,
        contextTokens: 8192,
        maxTokens: 2048,
        sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
        planningSampling: { temperature: 0.7, topP: 0.8 },
      };
    case "researcher":
      return {
        ...base,
        contextTokens: 16384,
        maxTokens: 1200,
        sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
      };
    case "reviewer":
      return {
        ...base,
        contextTokens: 12288,
        maxTokens: 900,
        sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
      };
  }
}

/**
 * The Planner's weights driving the coding loop for an escalated retry: a
 * queue on the planner role, which needs more context and a longer answer.
 * 12k keeps a dense 27B inside a 24 GB host; roomier hosts get 16k.
 */
export function escalationWindow(totalBytes: number = totalmem()): {
  contextTokens: number;
  maxTokens: number;
} {
  return { contextTokens: totalBytes >= 48 * 1024 ** 3 ? 16384 : 12288, maxTokens: 3072 };
}

// ── per-role settings: resolved, checked and applied (NEW-models-21) ─────

/** The roles in the product's words (NAMING.md), for a source line. */
const ROLE_WORDS: Readonly<Record<ModelRole, string>> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/** The roles' code sampling (`ollamaProfileForRole`), for a model of no known family. */
const CODE_SAMPLING = { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 } as const;

const FAMILY_WORDS: Readonly<Record<string, string>> = { qwen: "Qwen", gemma: "Gemma" };

/** What a resolution may know beyond the registry entry. */
export interface ResolveSettingsInputs {
  /** This host's tier working context (rule 8): a cap, graded Estimated. */
  tierContextTokens?: number;
  /** The thinking policy the run is under (default `SEKHEMET_THINKING`). */
  thinkingPolicy?: ThinkingPolicy;
  env?: NodeJS.ProcessEnv;
}

/**
 * Every value a role runs at for a model, graded (MD-N21-1): a person's
 * value is *Set by* them; otherwise a measurement on this host, the model
 * card (or the family's published values, or the template's floor), this
 * host's tier, then the harness's own default. In `ROLE_SETTING_FIELDS`
 * order. Pure: it reads only what it is given.
 */
export function resolveRoleSettings(
  entry: ModelEntry | undefined,
  role: ModelRole,
  inputs: ResolveSettingsInputs = {},
): ResolvedSetting[] {
  const env = inputs.env ?? process.env;
  const policy = inputs.thinkingPolicy ?? thinkingPolicyFromEnv(env);
  const person = entry?.roleSettings?.[role];
  const recorded = entry?.sampling;
  const family = entry?.family ? FAMILY_SAMPLING[entry.family] : undefined;
  const familyName = FAMILY_WORDS[entry?.family ?? ""] ?? entry?.family ?? "";
  const sample = (k: "temperature" | "topP" | "topK" | "minP"): Omit<ResolvedSetting, "key"> => {
    if (recorded?.[k] !== undefined)
      return {
        value: recorded[k] as number,
        grade: "card",
        source: "its makers' published values, recorded in Sekhemet's model list",
      };
    if (family?.[k] !== undefined)
      return {
        value: family[k] as number,
        grade: "card",
        source: `the ${familyName} family's published values`,
      };
    return { value: CODE_SAMPLING[k], grade: "default", source: "Sekhemet's code sampling" };
  };
  const window = GENERIC_ROLE_WINDOWS[role].contextTokens;
  const trained = entry?.header?.contextLength;
  const context = (): Omit<ResolvedSetting, "key"> => {
    if (trained !== undefined && trained < window)
      return {
        value: trained,
        grade: "card",
        source: "the context the model was trained for (its file)",
      };
    if (inputs.tierContextTokens !== undefined && inputs.tierContextTokens < window)
      return {
        value: inputs.tierContextTokens,
        grade: "estimated",
        source: "this machine's tier caps the working context",
      };
    return {
      value: window,
      grade: "default",
      source: `Sekhemet's window for the ${ROLE_WORDS[role]}`,
    };
  };
  const decision = entry?.speculativeByPolicy?.[policy];
  const floor = entry?.reasoning?.floor;
  const derived: Record<RoleSettingKey, Omit<ResolvedSetting, "key">> = {
    contextTokens: context(),
    temperature: sample("temperature"),
    topP: sample("topP"),
    topK: sample("topK"),
    minP: sample("minP"),
    repeatPenalty:
      recorded?.penalties?.repeat !== undefined
        ? {
            value: recorded.penalties.repeat,
            grade: "card",
            source: "its makers' published values, recorded in Sekhemet's model list",
          }
        : { value: 1, grade: "default", source: "off" },
    presencePenalty:
      recorded?.penalties?.presence !== undefined
        ? {
            value: recorded.penalties.presence,
            grade: "card",
            source: "its makers' published values, recorded in Sekhemet's model list",
          }
        : { value: 0, grade: "default", source: "off" },
    seed: { value: -1, grade: "default", source: "random" },
    reasoningPolicy: {
      value: policy,
      grade: "default",
      source: env.SEKHEMET_THINKING ? "SEKHEMET_THINKING" : "Sekhemet's default: no thinking",
    },
    reasoningLevel: { value: "off", grade: "default", source: "requests ask for no thinking" },
    reasoningCapTokens:
      entry?.reasoning?.defaultBudget !== undefined && entry.reasoning.defaultBudget > 0
        ? {
            value: entry.reasoning.defaultBudget,
            grade: "card",
            source: "the model's recorded thinking budget",
          }
        : {
            value: REASONING_BUDGET_TOKENS.high,
            grade: "default",
            source: "Sekhemet's high budget",
          },
    reasoningFloor: floor
      ? { value: floor, grade: "card", source: "its template cannot turn thinking off" }
      : { value: "none", grade: "default", source: "its template can turn thinking off" },
    kvType: { value: "q8_0", grade: "default", source: "8-bit KV (rule 10)" },
    flashAttention: { value: true, grade: "default", source: "on" },
    gpuLayers: { value: 99, grade: "default", source: "every layer on the GPU" },
    slots: { value: 1, grade: "default", source: "one request at a time" },
    mtp: decision
      ? {
          value: "auto",
          grade: "measured",
          source: `${decision.enabled ? "on" : "off"}: ${decision.reason}`,
        }
      : { value: "auto", grade: "default", source: "off until measured on this machine" },
    loadMode: { value: "auto", grade: "default", source: "mmap until a load A/B is recorded" },
    toolArm: entry?.toolArm
      ? {
          value: entry.toolArm,
          grade: "measured",
          source: "measured best for this model on this machine",
        }
      : { value: "auto", grade: "default", source: "the arm measured best, once measured" },
    method: {
      value: env.SEKHEMET_WORKER_METHOD === "strict" ? "strict" : "baseline",
      grade: "default",
      source: env.SEKHEMET_WORKER_METHOD ? "SEKHEMET_WORKER_METHOD" : "Sekhemet's default",
    },
    evidenceGate: {
      value: env.SEKHEMET_EVIDENCE_GATE === "on" ? "on" : "off",
      grade: "default",
      source: env.SEKHEMET_EVIDENCE_GATE ? "SEKHEMET_EVIDENCE_GATE" : "Sekhemet's default",
    },
    stepBudget: {
      value: DEFAULT_STEP_BUDGET,
      grade: "default",
      source: "Sekhemet's step budget for an issue",
    },
  };
  return ROLE_SETTING_FIELDS.map((f) => {
    const mine = person?.values[f.key];
    if (mine !== undefined && !f.readOnly)
      return {
        key: f.key,
        value: mine,
        grade: "set" as const,
        source: person?.preset ? `the ${person.preset} preset` : "a person's choice",
        ...(person ? { by: person.by, at: person.at } : {}),
      };
    return { key: f.key, ...derived[f.key] };
  });
}

/** Why a value is refused (MD-N21-4). */
export interface SettingRefusal {
  key: string;
  refused: "unknown" | "range" | "kv" | "fit" | "readonly";
  error: string;
}

/** The KV types of 4 bits (rule 10: refused for a tool-calling model). */
const FOUR_BIT_KV = new Set(["q4_0", "q4_1", "iq4_nl"]);

/**
 * Check a person's values (MD-N21-4): the standing refusals — an unknown
 * key, a value out of range or not offered, a read-only value, 4-bit KV,
 * and (through `fit`) a context that does not fit this machine — and the
 * role-aware hints, which never refuse.
 */
export function checkRoleSettings(
  values: RoleSettingValues,
  ctx: {
    role: ModelRole;
    /** The model's floor, for the reasoning hint. */
    floor?: string;
    /** The fit at a context: a refusal's words, or undefined when it fits. */
    fit?: (contextTokens: number) => string | undefined;
  },
): { refusal?: SettingRefusal; hints: { key: RoleSettingKey; text: string }[] } {
  const fields = new Map(ROLE_SETTING_FIELDS.map((f) => [f.key as string, f]));
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined) continue;
    const f = fields.get(key);
    if (!f)
      return {
        refusal: { key, refused: "unknown", error: `${key} is not a setting Sekhemet knows.` },
        hints: [],
      };
    if (f.readOnly)
      return {
        refusal: {
          key,
          refused: "readonly",
          error: `${f.label} is a fact of the model and cannot be set.`,
        },
        hints: [],
      };
    const bad = (() => {
      if (f.kind === "bool") return typeof v !== "boolean";
      if (f.kind === "choice") return !(f.options ?? []).includes(String(v));
      if (typeof v !== "number" || !Number.isFinite(v)) return true;
      if (f.kind === "int" && !Number.isInteger(v)) return true;
      return (f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max);
    })();
    if (bad) {
      const range =
        f.kind === "choice"
          ? `one of ${(f.options ?? []).join(", ")}`
          : f.kind === "bool"
            ? "on or off"
            : `${f.kind === "int" ? "a whole number " : ""}from ${f.min} to ${f.max}`;
      return { refusal: { key, refused: "range", error: `${f.label} is ${range}.` }, hints: [] };
    }
    if (key === "kvType" && FOUR_BIT_KV.has(String(v)))
      return {
        refusal: {
          key,
          refused: "kv",
          error:
            "4-bit KV is refused: it corrupts tool calls, the Agent's only interface (rule 10). Use 8 bits (q8_0) or more.",
        },
        hints: [],
      };
  }
  if (values.contextTokens !== undefined && ctx.fit) {
    const why = ctx.fit(values.contextTokens);
    if (why) return { refusal: { key: "contextTokens", refused: "fit", error: why }, hints: [] };
  }
  const hints: { key: RoleSettingKey; text: string }[] = [];
  const toolHeavy = ctx.role === "worker" || ctx.role === "reviewer";
  for (const f of ROLE_SETTING_FIELDS) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (f.key === "temperature" && toolHeavy && (v as number) > 1)
      hints.push({
        key: f.key,
        text: `Above 1.0 the ${ROLE_WORDS[ctx.role]} makes more invalid tool calls; most coding models' makers use 0.2 to 1.0.`,
      });
    if (f.key === "repeatPenalty" && ctx.role === "worker" && (v as number) > 1)
      hints.push({
        key: f.key,
        text: "A repeat penalty above 1 penalises the names code repeats; coding models' makers run it at 1.0 and use a presence penalty instead.",
      });
    if (f.key === "kvType" && String(v).startsWith("q5"))
      hints.push({
        key: f.key,
        text: "KV below 8 bits must be verified with it on this machine before the Agent uses it (rule 10).",
      });
    if (
      f.key === "contextTokens" &&
      ctx.role === "worker" &&
      (v as number) < GENERIC_ROLE_WINDOWS.worker.contextTokens
    )
      hints.push({
        key: f.key,
        text: "INVEST's Small is sized to the Coding model's window: a smaller context makes more issues too large to start.",
      });
    if (f.key === "reasoningLevel" && v === "off" && ctx.floor && ctx.floor !== "none")
      hints.push({
        key: f.key,
        text: `This model thinks at its floor (${ctx.floor}) even when asked for none; keep the cap large enough for it.`,
      });
    if (f.key === "gpuLayers" && (v as number) < 99)
      hints.push({ key: f.key, text: "Layers left on the CPU run several times slower." });
    if (f.key === "slots" && (v as number) > 1)
      hints.push({
        key: f.key,
        text: "Each slot keeps the full context, so memory grows with every slot.",
      });
    if (f.key === "mtp" && v === "off")
      hints.push({
        key: f.key,
        text: "MTP changes speed only; it is used only where it was measured faster.",
      });
  }
  return { hints };
}

/** A role's values as the sampling an adapter sends. */
function samplingFrom(v: RoleSettingValues): SamplingOptions {
  return {
    ...(v.temperature !== undefined ? { temperature: v.temperature } : {}),
    ...(v.topP !== undefined ? { topP: v.topP } : {}),
    ...(v.topK !== undefined ? { topK: v.topK } : {}),
    ...(v.minP !== undefined ? { minP: v.minP } : {}),
    ...(v.repeatPenalty !== undefined ? { repeatPenalty: v.repeatPenalty } : {}),
    ...(v.presencePenalty !== undefined ? { presencePenalty: v.presencePenalty } : {}),
  };
}

/**
 * A managed launch with a role's values (MD-N21-2): the context, sampling,
 * seed, KV type, flash attention, GPU layers, slots, MTP off, load mode,
 * thinking policy and tool arm. No values: the adapter as it was.
 */
export function applyRoleSettingsToManaged(
  adapter: ManagedLlamaServerAdapter,
  v: RoleSettingValues | undefined,
): ManagedLlamaServerAdapter {
  if (!v || Object.keys(v).length === 0) return adapter;
  const p = adapter.launchProfile;
  const sampling = samplingFrom(v);
  const extra = [
    ...(v.flashAttention === false ? ["-fa", "off"] : []),
    ...(v.seed !== undefined && v.seed >= 0 ? ["-s", String(v.seed)] : []),
    ...(v.loadMode === "no_mmap" ? ["--no-mmap"] : []),
  ];
  return new ManagedLlamaServerAdapter({
    ...p,
    ...(v.contextTokens !== undefined ? { contextTokens: v.contextTokens } : {}),
    ...(v.kvType !== undefined ? { kvType: v.kvType } : {}),
    ...(v.gpuLayers !== undefined ? { gpuLayers: v.gpuLayers } : {}),
    ...(v.slots !== undefined ? { parallelSlots: v.slots } : {}),
    ...(v.mtp === "off" ? { mtp: false } : {}),
    ...(v.reasoningPolicy !== undefined ? { thinkingPolicy: v.reasoningPolicy } : {}),
    ...(v.toolArm !== undefined && v.toolArm !== "auto" ? { preferredToolArm: v.toolArm } : {}),
    ...(Object.keys(sampling).length ? { sampling: { ...(p.sampling ?? {}), ...sampling } } : {}),
    ...(Object.keys(sampling).length && p.planningSampling
      ? { planningSampling: { ...p.planningSampling, ...sampling } }
      : {}),
    ...(extra.length ? { extraArgs: [...(p.extraArgs ?? []), ...extra] } : {}),
  });
}

/** What a caller may set on one resolution: the window it needs (MD-N9-1). */
export interface ResolveOptions {
  contextTokens?: number;
  maxTokens?: number;
}

export interface ModelRosterOptions {
  /** Options for the Qwen3.8-27B (Dirk) managed server. */
  qwen38?: ChronicleProfileOptions;
  totalBytes?: number;
  /** Injectable for tests: builds the managed adapters. */
  managed?: Partial<Record<ManagedModelName, () => UnloadableAdapter>>;
  /**
   * The model registry (M11). Every adapter the roster builds gets it: the
   * chat template is pinned on first use (M12), the tool arm comes from the
   * measurement (M9) and managed servers take the measured MTP decision (M19).
   */
  registry?: ModelRegistry;
  /**
   * The calibrated machine profile. Its engine decision (M24) chooses the API
   * an unmanaged model is served over, so the measurement reaches the launch
   * instead of stopping at the report. Omitted loads this host's saved
   * profile; `null` is an uncalibrated machine (tests, first run).
   */
  machineProfile?: MachineProfile | null;
}

/**
 * Resolves `--worker/--manager/--researcher/--reviewer <name>` to adapters.
 *
 * Managed names share ONE adapter per name, so roles on the same weights
 * (manager and escalation on Qwen3.8-27B, say) share one server and one
 * resident entry in the router instead of loading the weights twice (C3).
 * `qwen3.8-27b` and `dirk` both select the CHRONICLE §2 Qwen3.8-27B profile
 * (M5, X29), whose planning requests sample at 0.7 / 0.8.
 */
export class ModelRoster {
  private shared = new Map<string, UnloadableAdapter>();
  /** null until the machine profile has been consulted, then the verdict. */
  private engine: string | undefined | null = null;

  constructor(private options: ModelRosterOptions = {}) {}

  /**
   * This host's calibrated profile. A profile measured on other hardware
   * decides nothing here, which is what the fingerprint is for.
   */
  private calibrated(): MachineProfile | undefined {
    if (this.options.machineProfile === null) return undefined;
    const profile = this.options.machineProfile ?? loadMachineProfile();
    return profile && profile.fingerprintHash === hostFingerprintHash() ? profile : undefined;
  }

  /** The engine this host measured as fastest (M24). */
  public measuredEngine(): string | undefined {
    if (this.engine !== null) return this.engine;
    this.engine = this.calibrated()?.engine?.engine;
    return this.engine;
  }

  /** What the calibrated tier decides for this machine (M14). */
  public tierSettings(): TierSettings | undefined {
    const profile = this.calibrated();
    if (!profile) return undefined;
    return tierSettingsOf(profile);
  }

  /**
   * Launch a managed server the way this machine measured (M13, M14): the
   * tier's working context as a ceiling — a model whose own profile is
   * tighter keeps its own number, because quality degrades with length long
   * before the window runs out — and the swept prefill batch and offload,
   * which were chosen one step back from this host's memory cliff.
   */
  private tuned<A extends UnloadableAdapter>(adapter: A): A {
    const profile = this.calibrated();
    if (!profile || !(adapter instanceof ManagedLlamaServerAdapter)) return adapter;
    const p = adapter.launchProfile;
    const working = this.tierSettings()?.workingContextTokens;
    const total = p.contextTokens ?? 8192;
    // `parallelSlots` gives each slot the full window; `parallel` shares one.
    const slots = p.parallelSlots !== undefined ? 1 : (p.parallel ?? 1);
    const capped =
      working !== undefined && Math.floor(total / slots) > working ? working * slots : undefined;
    const launch = profile.launch;
    if (capped === undefined && launch === undefined) return adapter;
    return new ManagedLlamaServerAdapter({
      ...p,
      ...(capped !== undefined ? { contextTokens: capped } : {}),
      ...(launch
        ? {
            gpuLayers: launch.gpuLayers,
            extraArgs: [...(p.extraArgs ?? []), "-b", String(launch.batchTokens)],
          }
        : {}),
    }) as unknown as A;
  }

  public resolve(name: string, role: ModelRole, want: ResolveOptions = {}): UnloadableAdapter {
    if (!isManagedModelName(name)) {
      // Rule 14c, MD-N20-2: a role whose configuration names an Ollama cloud
      // model is refused on every run, before any request.
      assertNotOllamaCloud(name, role);
      const generic = this.resolveGeneric(name, role, want);
      if (generic) return generic;
      const shipped = this.resolveShipped(name, role, want);
      if (shipped) return shipped;
      // MD-N21-2: an Ollama model takes a role's context and sampling.
      const mine = this.roleValues(name, role);
      const profile = {
        ...ollamaProfileForRole(role, name),
        ...(mine?.contextTokens !== undefined ? { contextTokens: mine.contextTokens } : {}),
        ...want,
      };
      if (mine && Object.keys(samplingFrom(mine)).length)
        profile.sampling = { ...(profile.sampling ?? {}), ...samplingFrom(mine) };
      // The engine decision is the whole point of measuring one: where the
      // OpenAI-compatible path won, the same weights are served over it
      // rather than through Ollama's own API.
      const openAiCompatible = this.measuredEngine() === "openai-compatible";
      const working = this.tierSettings()?.workingContextTokens;
      const adapter = this.withRegistry(
        new HttpInferenceAdapter({
          ...profile,
          ...(working !== undefined
            ? { contextTokens: Math.min(profile.contextTokens ?? working, working) }
            : {}),
          ...(openAiCompatible
            ? {
                apiFormat: "openai" as const,
                baseUrl: `${(profile.baseUrl ?? "http://127.0.0.1:11434").replace(/\/+$/, "")}/v1`,
              }
            : {}),
        }),
      );
      this.options.registry?.upsert(adapter.modelId, { engine: engineOf(adapter) });
      return adapter;
    }
    const base = name === "dirk" ? "qwen3.8-27b" : name;
    const mine = this.roleValues(resolveWorkerModelId(base), role);
    // A role with its own values runs its own launch; roles that agree share one (MD-N9-1).
    const key = mine ? `${base}#${JSON.stringify(mine)}` : base;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const build =
      this.options.managed?.[name] ??
      (() => {
        // MD-N14-41a: the registry's preferred recorded copy of these
        // weights when one is readable here, else the shipped file name.
        const path = recordedGguf(this.options.registry, resolveWorkerModelId(base), existsSync);
        switch (base) {
          case "cyber-tiel":
            return createCyberTielWorker(path);
          case "apodex":
            return createApodexResearcher(path);
          default:
            return createQwen38Managed({
              ...(path ? { modelPath: path } : {}),
              ...(this.options.qwen38 ?? {}),
            });
        }
      });
    const built = this.tuned(build());
    const adapter = this.withRegistry(
      built instanceof ManagedLlamaServerAdapter ? applyRoleSettingsToManaged(built, mine) : built,
    );
    const family = MANAGED_MODEL_FAMILIES[name];
    this.options.registry?.upsert(adapter.modelId, {
      engine: engineOf(adapter),
      ...(family ? { family } : {}),
    });
    this.shared.set(key, adapter);
    return adapter;
  }

  /**
   * A registry model with recorded GGUF weights and no managed builder
   * (MD-N12-10): a managed llama-server with the generic profile, one
   * adapter per model. Undefined when the registry records no GGUF for it
   * (an Ollama tag).
   */
  private resolveGeneric(
    name: string,
    role: ModelRole,
    want: ResolveOptions,
  ): UnloadableAdapter | undefined {
    const registry = this.options.registry;
    // A readable copy first; else the recorded one, whose launch then names the missing file.
    const path = recordedGguf(registry, name, existsSync) ?? recordedGguf(registry, name);
    if (!registry || !path) return undefined;
    // A shipped id runs its shipped profile, on its role's own port (rule 26a).
    if (SHIPPED_MODELS.some((m) => m.id === name && m.source))
      return this.resolveShipped(name, role, want, path);
    const mine = this.roleValues(name, role);
    const key = `registry:${name}${mine ? `#${role}#${JSON.stringify(mine)}` : ""}`;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const entry = registry.get(name);
    const adapter = this.withRegistry(
      applyRoleSettingsToManaged(
        this.tuned(
          createGenericManaged({
            modelId: name,
            modelPath: path,
            role,
            ...(entry ? { entry } : {}),
            want,
          }),
        ),
        mine,
      ),
    );
    registry.upsert(adapter.modelId, { engine: engineOf(adapter) });
    this.shared.set(key, adapter);
    return adapter;
  }

  /**
   * A shipped model (rule 3; MD-N21-12): its shipped profile at its recorded
   * copy, else at `<models dir>/<file>`, the way the measurement baseline
   * resolves — never an Ollama tag, whose 8,192-token window would size
   * every issue for a window the Coding model does not have.
   */
  private resolveShipped(
    name: string,
    role: ModelRole,
    want: ResolveOptions,
    path?: string,
  ): UnloadableAdapter | undefined {
    const model = SHIPPED_MODELS.find((m) => m.id === name && m.source);
    if (!model?.source) return undefined;
    const mine = this.roleValues(name, role);
    // C4: a role other than its shipped one runs at that role's window and port.
    const serves = shippedRoleOf(role) ?? model.role;
    const other = serves === model.role ? "" : `@${serves}`;
    const key = `shipped:${name}${other}${mine ? `#${role}#${JSON.stringify(mine)}` : ""}`;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const registry = this.options.registry;
    const adapter = this.withRegistry(
      applyRoleSettingsToManaged(
        this.tuned(
          shippedAdapter(model, {
            modelPath: path ?? resolveModelPath(model.source.file),
            role: serves,
            ...(registry ? { registry } : {}),
            // The caller's window, as `createGenericManaged` honoured it before (B1-C3 review).
            ...(Object.keys(want).length > 0 ? { want } : {}),
          }),
        ),
        mine,
      ),
    );
    registry?.upsert(adapter.modelId, {
      engine: engineOf(adapter),
      ...(model.family ? { family: model.family } : {}),
    });
    this.shared.set(key, adapter);
    return adapter;
  }

  /** A person's values for this model in this role, when any are set (MD-N21-2). */
  private roleValues(id: string, role: ModelRole): RoleSettingValues | undefined {
    const v = this.options.registry?.roleSettings(id, role)?.values;
    return v && Object.keys(v).length ? v : undefined;
  }

  private withRegistry<A extends UnloadableAdapter>(adapter: A): A {
    const registry = this.options.registry;
    if (registry && adapter instanceof HttpInferenceAdapter) adapter.attachRegistry(registry);
    return adapter;
  }
}
