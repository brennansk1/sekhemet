import { totalmem } from "node:os";
import { HttpInferenceAdapter, NAIL_WORKER_PROFILE } from "./http_adapter.js";
import {
  type ChronicleProfileOptions,
  createApodexResearcher,
  createCyberTielWorker,
  createQwen38Managed,
} from "./llama_server.js";
import type { ModelRegistry } from "./registry.js";
import type { ModelRole, UnloadableAdapter } from "./router.js";

/**
 * Names that select a harness-managed llama-server model rather than an
 * Ollama tag. Anything else is passed to Ollama as a model name.
 */
export const MANAGED_MODEL_NAMES = ["cyber-tiel", "apodex", "qwen3.8-27b", "dirk"] as const;
export type ManagedModelName = (typeof MANAGED_MODEL_NAMES)[number];

export function isManagedModelName(name: string): name is ManagedModelName {
  return (MANAGED_MODEL_NAMES as readonly string[]).includes(name);
}

/** Ollama settings per role, when a role names an Ollama model. */
export function ollamaProfileForRole(
  role: ModelRole,
  modelId: string,
  totalBytes: number = totalmem(),
): ConstructorParameters<typeof HttpInferenceAdapter>[0] {
  const base = { modelId, apiFormat: "ollama" as const, disableReasoning: true };
  switch (role) {
    case "worker":
      return { ...NAIL_WORKER_PROFILE, modelId };
    case "manager":
      return {
        ...base,
        contextTokens: 8192,
        maxTokens: 2048,
        sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
        planningSampling: { temperature: 0.7, topP: 0.8 },
      };
    case "escalation":
      return {
        ...base,
        // 12k keeps a dense 27B inside a 24 GB host; roomier hosts get 16k.
        contextTokens: totalBytes >= 48 * 1024 ** 3 ? 16384 : 12288,
        maxTokens: 3072,
        sampling: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 },
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
        sampling: { temperature: 0.1, topP: 0.9, topK: 20, minP: 0 },
      };
  }
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

  constructor(private options: ModelRosterOptions = {}) {}

  public resolve(name: string, role: ModelRole): UnloadableAdapter {
    if (!isManagedModelName(name)) {
      return this.withRegistry(
        new HttpInferenceAdapter(ollamaProfileForRole(role, name, this.options.totalBytes)),
      );
    }
    const key = name === "dirk" ? "qwen3.8-27b" : name;
    const existing = this.shared.get(key);
    if (existing) return existing;
    const build =
      this.options.managed?.[name] ??
      (() => {
        switch (key) {
          case "cyber-tiel":
            return createCyberTielWorker();
          case "apodex":
            return createApodexResearcher();
          default:
            return createQwen38Managed(this.options.qwen38 ?? {});
        }
      });
    const adapter = this.withRegistry(build());
    this.shared.set(key, adapter);
    return adapter;
  }

  private withRegistry<A extends UnloadableAdapter>(adapter: A): A {
    const registry = this.options.registry;
    if (registry && adapter instanceof HttpInferenceAdapter) adapter.attachRegistry(registry);
    return adapter;
  }

  /** A router factory for a role, so `new ModelRouter({ worker: roster.factory(...) })`. */
  public factory(name: string, role: ModelRole): () => UnloadableAdapter {
    return () => this.resolve(name, role);
  }
}
