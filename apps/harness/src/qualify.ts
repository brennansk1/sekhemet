import {
  HttpInferenceAdapter,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  type ModelRegistry,
  type ModelRole,
  type QualificationCombination,
  type QualificationLookup,
  ROLE_WORDS,
  type WorkerOverride,
  hostFingerprintHash,
  llamaServerBinary,
  samplingSettingsOf,
} from "@sekhemet/models";
import { launchVariant } from "./model_access.js";
import { rolePromptVersion } from "./prompt_versions.js";
import { llamaRuntime, parseLlamaBuild, sampledDigest } from "./repro.js";
import type { ReviewerRole } from "./review_flow.js";

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
      // Rule 6b, MD-N19-5: the engine the launch would start, by the one resolution order.
      (
        deps.engineBuild ??
        (() => llamaRuntime(adapter.launchProfile.binary ?? llamaServerBinary()))
      )();
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

/** What `gateRole` decided for one role's adapter. */
export type RoleGate = WorkerGate;

/** A role's refusal in words that name Verify and its command (MD-N8-1). */
export function roleRefusalLine(
  role: ModelRole,
  modelId: string,
  look: QualificationLookup,
  name: string,
): string {
  const state = look.status === "missing" ? "missing" : `${look.status}: ${look.reason}`;
  return `The ${ROLE_WORDS[role]} ${modelId} is not verified on this machine for this combination (${state}). Verify it on Configuration › Models, or run: sekhemet qualify --models ${name}${role === "worker" ? "" : ` --role ${role}`}`;
}

/**
 * The one gate for every role (MD-N8-1, W11): the Coding model through
 * `gateWorker`; any other role refused until its exact combination for that
 * role has qualified on this host, unless a person recorded an override of
 * that combination's failure for that role (rule 27, MD-N4-4), which marks
 * the adapter as the Coding model's does.
 */
export function gateRole(
  registry: ModelRegistry,
  adapter: LocalInferenceAdapter,
  role: ModelRole,
  name: string,
  deps: CombinationDeps = {},
): RoleGate {
  if (role === "worker") return gateWorker(registry, adapter, name, deps);
  const combination = qualificationCombination(adapter, { ...deps, registry, role });
  registry.observeContextVersion(combination.settings.contextVersion, role);
  const look = registry.lookupQualification(adapter.modelId, combination);
  if (look.status === "qualified") return { combination };
  if (look.status === "overridden" && look.override) {
    applyWorkerOverride(adapter, look.override);
    return { combination, override: look.override };
  }
  return { refusal: roleRefusalLine(role, adapter.modelId, look, name), combination };
}

/** Rule 23: what a role falls back to when its model may not be used. */
const FALLBACK: Readonly<Record<Exclude<ModelRole, "worker">, string>> = {
  reviewer: "changes reach Review without an AI review, and each issue says so",
  researcher: "questions are answered from the repository alone",
  planner:
    "the queue runs without it: Seshat does not answer during the run, and issues are not escalated to it",
};

/**
 * `run`'s Review role, verified (MD-N8-1, rule 23): a filled role whose model
 * is not verified for the Review role on this machine becomes unfilled, the
 * refusal its reason, so the change reaches the person unreviewed and the
 * card says why.
 */
export function verifiedReviewerRole(
  registry: ModelRegistry,
  role: ReviewerRole,
  describe: (name: string, role: ModelRole) => LocalInferenceAdapter,
  deps: CombinationDeps = {},
): ReviewerRole {
  if (role.state !== "filled") return role;
  const gate = gateRole(
    registry,
    describe(role.model, role.queue === "reviewer" ? "reviewer" : "planner"),
    "reviewer",
    role.model,
    deps,
  );
  return gate.refusal
    ? { state: "unfilled", reason: `${gate.refusal}; ${FALLBACK.reviewer}.` }
    : role;
}

export interface QueueSpecLike {
  queue: string;
  role: ModelRole;
  name: string;
}

/**
 * The queue's roles, verified (MD-N8-1, rule 23): every role but the Coding
 * model (which `gateWorker` refuses outright) is kept only when its
 * combination is verified, or a person overrode its failure; each one left
 * out comes with the line naming why, the command that verifies it and its
 * fallback. A queue whose weights serve two roles (the Planner's manager and
 * escalation) is verified as the Planning model once.
 */
export function verifiedQueues<S extends QueueSpecLike>(
  registry: ModelRegistry,
  specs: readonly S[],
  describe: (name: string, role: ModelRole) => LocalInferenceAdapter,
  deps: CombinationDeps = {},
): { verified: S[]; refused: (S & { line: string; refusal: string })[] } {
  const seen = new Map<string, string | undefined>();
  const verified: S[] = [];
  const refused: (S & { line: string; refusal: string })[] = [];
  for (const spec of specs) {
    if (spec.role === "worker") {
      verified.push(spec);
      continue;
    }
    const key = `${spec.role}|${spec.name}`;
    if (!seen.has(key))
      seen.set(
        key,
        gateRole(registry, describe(spec.name, spec.role), spec.role, spec.name, deps).refusal,
      );
    const refusal = seen.get(key);
    if (refusal) refused.push({ ...spec, refusal, line: `${refusal}; ${FALLBACK[spec.role]}.` });
    else verified.push(spec);
  }
  return { verified, refused };
}

/**
 * The queue's roles, verified, as `queue` runs them (MD-N8-1, rule 23; W11):
 * the Review role first (`verifiedReviewerRole`), its queue added when it is
 * filled on its own model; then every queue through `verifiedQueues`. The
 * Planning model's weights serve the manager, Seshat and escalation queues,
 * so its refusal takes all three out with one line. A Planning model that
 * doubles as the Review model (queue "manager") leaves Review unfilled when
 * the manager queue is refused. `refusals` are the lines `queuePrelude` says
 * before the pass, one per refused model and role; the Review role's own
 * reason travels in `reviewer`, which the pass prints with the review desk.
 */
export function verifiedQueueRoles<S extends QueueSpecLike>(
  registry: ModelRegistry,
  specs: readonly S[],
  reviewer: ReviewerRole,
  describe: (name: string, role: ModelRole) => LocalInferenceAdapter,
  deps: CombinationDeps = {},
): {
  verified: S[];
  refusals: string[];
  reviewer: ReviewerRole;
  has: (queue: string) => boolean;
} {
  let role = verifiedReviewerRole(registry, reviewer, describe, deps);
  const all: (S | QueueSpecLike)[] = [...specs];
  if (role.state === "filled" && role.queue === "reviewer")
    all.push({ queue: "reviewer", role: "reviewer", name: role.model });
  const { verified, refused } = verifiedQueues(registry, all, describe, deps);
  const queues = new Set(verified.map((s) => s.queue));
  if (role.state === "filled" && role.queue === "manager" && !queues.has("manager")) {
    const why = refused.find((r) => r.queue === "manager")?.refusal ?? "";
    role = { state: "unfilled", reason: `${why}; ${FALLBACK.reviewer}.` };
  }
  return {
    verified: verified as S[],
    refusals: [...new Set(refused.filter((r) => r.role !== "reviewer").map((r) => r.line))],
    reviewer: role,
    has: (queue) => queues.has(queue),
  };
}
