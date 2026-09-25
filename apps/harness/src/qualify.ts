import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { computeContextVersion, workerCopy } from "@sekhemet/context";
import { gateCopy } from "@sekhemet/gates";
import { TOOL_CATALOG } from "@sekhemet/loop";
import {
  HttpInferenceAdapter,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  type ModelRegistry,
  type QualificationCombination,
  hostFingerprintHash,
} from "@sekhemet/models";
import { llamaRuntime, sampledDigest } from "./repro.js";

/**
 * Qualification per combination on the harness side (models rule 27a,
 * NEW-models-8): the Worker's combination as this host would run it, and the
 * one-line refusal when that exact combination has not passed.
 */

/** How the combination's elements are read; tests pass fakes, nothing here loads a model. */
export interface CombinationDeps {
  /** The weights' digest: `sampledDigest` (repro.ts). */
  digest?: (file: string) => string | undefined;
  /** The engine's build: `llama-server --version` (repro.ts), which loads no model. */
  engineBuild?: () => string | undefined;
  /** `hostFingerprintHash()`. */
  host?: () => string;
  /** The Worker's context version: `workerContextVersion()`. */
  contextVersion?: () => string;
  /**
   * The registry the caller qualifies against, which holds the pinned chat
   * template. Read from here, not from the adapter, so equivalent adapters —
   * one built through the roster, one not — get the same combination.
   */
  registry?: ModelRegistry;
}

/** A copy module as text: its strings, and each builder's source. */
export function copyText(copy: Record<string, unknown>): string {
  return JSON.stringify(copy, (_k, v) => (typeof v === "function" ? String(v) : v));
}

/**
 * The Worker's context version for a qualification (context.md rule 27; the
 * lead's ruling on MD-N8-1): its prompt templates, the copy modules it reads
 * (the Worker's and the gates') and its tool schemas. Playbook rules are per
 * project and card, so they are not part of it.
 */
export function workerContextVersion(inventory: string = recordedLiteralInventory()): string {
  return computeContextVersion({
    tools: TOOL_CATALOG,
    templates: [copyText(workerCopy), copyText(gateCopy), inventory],
  }).version;
}

/**
 * The recorded inventory of model-facing literals outside the copy modules
 * (context CX-M1-13): editing a Worker literal that has not moved into a copy
 * module yet changes it, and so the context version.
 */
function recordedLiteralInventory(): string {
  try {
    const pkg = createRequire(import.meta.url).resolve("@sekhemet/context/package.json");
    return readFileSync(join(dirname(pkg), "prompt_literals_baseline.json"), "utf8");
  } catch {
    return "no recorded inventory";
  }
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
  const contextVersion = (deps.contextVersion ?? workerContextVersion)();
  const chatTemplate = templateOf(adapter, deps.registry);
  if (adapter instanceof ManagedLlamaServerAdapter) {
    const file = adapter.launchProfile.modelPath;
    const build = (deps.engineBuild ?? llamaRuntime)();
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
      settings: { ...settings, speculative, chatTemplate, contextVersion },
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
  return new ManagedLlamaServerAdapter({
    ...adapter.launchProfile,
    ...(registry ? { registry } : {}),
    speculativeOverride: true,
  });
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
  if (look.status === "qualified") return undefined;
  const state = look.status === "missing" ? "not qualified" : look.status;
  return `Refusing ${adapter.modelId} as the Worker: ${state} for this combination on this host (${look.reason}). Qualify it with: sekhemet qualify --models ${name}`;
}
