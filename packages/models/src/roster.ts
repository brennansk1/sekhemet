import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import {
  type MachineProfile,
  type TierSettings,
  hostFingerprintHash,
  loadMachineProfile,
  tierSettingsOf,
} from "./calibration.js";
import { recordedGguf } from "./generic_managed.js";
import { HttpInferenceAdapter, NAIL_WORKER_PROFILE } from "./http_adapter.js";
import {
  type ChronicleProfileOptions,
  ManagedLlamaServerAdapter,
  createApodexResearcher,
  createCyberTielWorker,
  createGenericManaged,
  createQwen38Managed,
} from "./llama_server.js";
import type { ModelRegistry } from "./registry.js";
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
      const generic = this.resolveGeneric(name, role, want);
      if (generic) return generic;
      const profile = { ...ollamaProfileForRole(role, name), ...want };
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
    const key = name === "dirk" ? "qwen3.8-27b" : name;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const build =
      this.options.managed?.[name] ??
      (() => {
        // MD-N14-41a: the registry's preferred recorded copy of these
        // weights when one is readable here, else the shipped file name.
        const path = recordedGguf(this.options.registry, resolveWorkerModelId(key), existsSync);
        switch (key) {
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
    const adapter = this.withRegistry(this.tuned(build()));
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
    const key = `registry:${name}`;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const entry = registry.get(name);
    const adapter = this.withRegistry(
      this.tuned(
        createGenericManaged({
          modelId: name,
          modelPath: path,
          role,
          ...(entry ? { entry } : {}),
          want,
        }),
      ),
    );
    registry.upsert(adapter.modelId, { engine: engineOf(adapter) });
    this.shared.set(key, adapter);
    return adapter;
  }

  private withRegistry<A extends UnloadableAdapter>(adapter: A): A {
    const registry = this.options.registry;
    if (registry && adapter instanceof HttpInferenceAdapter) adapter.attachRegistry(registry);
    return adapter;
  }
}
