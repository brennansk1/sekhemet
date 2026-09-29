import {
  HttpInferenceAdapter,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  type ModelRegistry,
  type ModelRole,
  type QualificationCombination,
  type WorkerOverride,
  hostFingerprintHash,
  samplingSettingsOf,
} from "@sekhemet/models";
import { launchVariant } from "./model_access.js";
import { rolePromptVersion } from "./prompt_versions.js";
import { llamaRuntime, parseLlamaBuild, sampledDigest } from "./repro.js";

/**
 * Qualification per combination on the harness side (models rule 27a,
 * NEW-models-8): the Worker's combination as this host would run it, and the
 * one-line refusal when that exact combination has not passed.
 */

/** How the combination's elements are read; tests pass fakes, nothing here loads a model. */
export interface CombinationDeps {
  /** The weights' digest: `sampledDigest` (repro.ts). */
  digest?: (file: string) => string | undefined;
  /**
   * The engine's build when the adapter has not read the running server's
   * `/props`: `llama-server --version` (repro.ts), which loads no model.
   */
  engineBuild?: () => string | undefined;
  /** `hostFingerprintHash()`. */
  host?: () => string;
  /** The role's prompt version: `rolePromptVersion(role)` (CX-N6-4). */
  contextVersion?: (role: ModelRole) => string;
  /**
   * The role the combination is qualified for (models rule 4d, MD-N10-3);
   * the Coding model's (the Worker's) by default.
   */
  role?: ModelRole;
  /**
   * The registry the caller qualifies against, which holds the pinned chat
   * template. Read from here, not from the adapter, so equivalent adapters —
   * one built through the roster, one not — get the same combination.
   */
  registry?: ModelRegistry;
}

export { copyText } from "./prompt_versions.js";

/**
 * The Coding model's prompt version, what its qualification depends on
 * (context.md rule 27, CX-N6-4; the lead's ruling on MD-N8-1): its prompt
 * templates, the copy modules it reads (the Worker's, the gates' and the
 * sandbox's), its literals outside them, its tool schemas and its budget
 * policy with the estimator's characters-per-token ratio. No other role's
 * prompts are in it (live-test F24), and playbook rules are per project and
 * card, so they are not part of it.
 */
export function workerContextVersion(inventory?: string, charsPerToken?: number): string {
  return rolePromptVersion("worker", {
    ...(inventory !== undefined ? { inventory } : {}),
    ...(charsPerToken !== undefined ? { charsPerToken } : {}),
  });
}

function templateOf(adapter: LocalInferenceAdapter, passed?: ModelRegistry): string {
  const registry = passed ?? (adapter as { registry?: ModelRegistry }).registry;
  return registry?.get(adapter.modelId)?.template?.checksum ?? "unpinned";
}

/**
 * The (engine, model build, host fingerprint, settings) combination an adapter
 * runs as (MD-N8-1). A managed llama-server reports its own launch settings;
 * an Ollama or other OpenAI-compatible model is named by its tag, with the
 * engine's own defaults for what the harness does not set.
 */
export function qualificationCombination(
  adapter: LocalInferenceAdapter,
  deps: CombinationDeps = {},
): QualificationCombination {
  const host = (deps.host ?? hostFingerprintHash)();
  const role = deps.role ?? "worker";
  const contextVersion = (deps.contextVersion ?? ((r: ModelRole) => rolePromptVersion(r)))(role);
  // The Coding model's combination keys as it did before roles were keyed.
  const forRole = role === "worker" ? {} : { role };
  const chatTemplate = templateOf(adapter, deps.registry);
  // Suite q1.2: the role qualifies at the sampling it runs at, so the
  // sampling is keyed; an adapter that does not say leaves it out.
  const sampling = samplingSettingsOf(adapter);
  if (adapter instanceof ManagedLlamaServerAdapter) {
    const file = adapter.launchProfile.modelPath;
    // The running server's own build_info when the adapter has read it, else
    // `llama-server --version`; one form either way (parseLlamaBuild).
    const reported = adapter.reportedBuild;
    const build =
      (reported ? parseLlamaBuild(reported) : undefined) ??
      (deps.engineBuild ?? (() => llamaRuntime(adapter.launchProfile.binary)))();
    const digest = deps.digest ?? sampledDigest;
    const settings = adapter.launchSettings();
    // A draft model is keyed by its weights' sampled digest, not only its id.
    const draftPath = adapter.launchProfile.draftModelPath;
    const speculative =
      typeof settings.speculative === "object" && draftPath
        ? {
            draft: `${settings.speculative.draft} ${digest(draftPath) ?? `missing file ${draftPath}`}`,
          }
        : settings.speculative;
    return {
      engine: `llama.cpp ${build ?? "unknown build"}`,
      modelBuild: digest(file) ?? `missing file ${file}`,
      host,
      settings: {
        ...settings,
        speculative,
        chatTemplate,
        contextVersion,
        ...(sampling ? { sampling } : {}),
        ...forRole,
      },
    };
  }
  const engine =
    adapter instanceof HttpInferenceAdapter
      ? adapter.api === "ollama"
        ? "ollama"
        : "openai-compatible"
      : adapter.constructor.name;
  return {
    engine,
    modelBuild: `${engine}:${adapter.modelId}`,
    host,
    settings: {
      contextTokens: adapter.contextWindow?.contextTokens ?? 0,
      kvType: "engine default",
      speculative: "off",
      prefixCaching: true,
      parallelSlots: 1,
      chatTemplate,
      contextVersion,
      ...(sampling ? { sampling } : {}),
      ...forRole,
    },
  };
}

/**
 * The same launch with its speculative method forced on (MD-N8-2): what
 * `sekhemet qualify --speculative on` runs, so speculation is qualified
 * together with prefix caching, as it would run in production.
 */
export function speculativeProbe(
  adapter: ManagedLlamaServerAdapter,
  registry?: ModelRegistry,
): ManagedLlamaServerAdapter {
  return launchVariant(
    adapter,
    { speculativeOverride: true, ...(registry ? { registry } : {}) },
    { keepRegistry: true },
  );
}

/**
 * One line refusing the model as the Worker, naming why and the command that
 * qualifies it; undefined when the exact combination has qualified (MD-N8-1).
 */
export function qualificationRefusal(
  registry: ModelRegistry,
  adapter: LocalInferenceAdapter,
  combination: QualificationCombination,
  name: string,
): string | undefined {
  const look = registry.lookupQualification(adapter.modelId, combination);
  // A person's recorded override lets the failed combination run (rule 27, MD-N4-4).
  if (look.status === "qualified" || look.status === "overridden") return undefined;
  const state = look.status === "missing" ? "not verified on this machine" : look.status;
  return `Refusing ${adapter.modelId} as the Coding model: ${state} for this combination on this host (${look.reason}). Verify it on this machine with: sekhemet qualify --models ${name}`;
}

/** The override the Worker's exact combination runs under, if a person recorded one (MD-N4-4). */
export function workerOverrideFor(
  registry: ModelRegistry,
  adapter: LocalInferenceAdapter,
  combination: QualificationCombination,
): WorkerOverride | undefined {
  const look = registry.lookupQualification(adapter.modelId, combination);
  return look.status === "overridden" ? look.override : undefined;
}

/**
 * Mark the Worker's adapter as running under a person's override, so every
 * evidence bundle's settings (`candidateSettings`) and every `card/repro`
 * record carry it (rule 27, MD-N4-4). Not enumerable: it is not part of the
 * adapter's launch.
 */
export function applyWorkerOverride<A extends object>(adapter: A, override: WorkerOverride): A {
  Object.defineProperty(adapter, "workerOverride", {
    value: override,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return adapter;
}

/** What `gateWorker` decided for a Worker adapter. */
export interface WorkerGate {
  /** One line refusing the Worker; undefined when it may run. */
  refusal?: string;
  /** The person's override it runs under, when its combination failed and one was recorded. */
  override?: WorkerOverride;
  combination: QualificationCombination;
}

/**
 * The one gate every path that runs the Worker passes (run, queue, `replay
 * --as`, the bake-off's records; review medium 2): refuse a combination that
 * has not qualified (MD-N8-1), look up a person's override of its failure
 * (rule 27, MD-N4-4), and mark the adapter with it so every evidence bundle
 * and `card/repro` made with it says so.
 */
export function gateWorker(
  registry: ModelRegistry,
  adapter: LocalInferenceAdapter,
  name: string,
  deps: CombinationDeps = {},
): WorkerGate {
  const combination = qualificationCombination(adapter, { ...deps, registry, role: "worker" });
  // CX-N6-1: a Coding model qualified under another version and not under
  // this build's is scheduled for re-qualification under it, naming both.
  // Nothing is invalidated: a build still running the other version keeps
  // its qualification (live-test F23).
  registry.observeContextVersion(combination.settings.contextVersion, "worker");
  const refusal = qualificationRefusal(registry, adapter, combination, name);
  if (refusal) return { refusal, combination };
  const override = workerOverrideFor(registry, adapter, combination);
  if (override) applyWorkerOverride(adapter, override);
  return { combination, ...(override ? { override } : {}) };
}
