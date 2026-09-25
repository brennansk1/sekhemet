import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BlobStore, type ContextPack } from "@sekhemet/kernel";
import {
  type EngineCandidate,
  type InferenceRequest,
  type MachineProfile,
  ManagedLlamaServerAdapter,
  type MeasuredSpeed,
  ModelRegistry,
  type ModelRole,
  ModelRoster,
  SPECULATIVE_HEADROOM_BYTES,
  type SpeculativeVerdict,
  type SweepCandidate,
  type ThinkingPolicy,
  type ToolDefinition,
  type UnloadableAdapter,
  calibrateHardware,
  calibrateModel,
  calibrateSpeculative,
  checkExecutionHeadroom,
  defaultRegistryPath,
  engineOf,
  loadMachineProfile,
  modelTelemetry,
  mtpStepAB,
  needsRecalibration,
  readSwapUsedBytes,
  saveMachineProfile,
  selectEngine,
} from "@sekhemet/models";

/** The two adapters a speculative-decoding measurement compares (M19). */
export interface SpeculativeProbes {
  plain: ManagedLlamaServerAdapter;
  speculative: ManagedLlamaServerAdapter;
  /** The draft model the A/B measures (MD-N8-5); absent for the MTP head. */
  draft?: string;
}

/**
 * The same model with and without its grafted head, one server each so that
 * only the flag differs. The registry is left off both: these probes are
 * measuring the decision, so they must not be steered by an earlier one.
 * A model with no head to graft is not measured.
 */
/**
 * The same launch with speculation forced off, then on: the model's MTP
 * head, or its draft model (MD-N8-5), whose id then keys the decision.
 */
export function speculativeProbes(adapter: UnloadableAdapter): SpeculativeProbes | undefined {
  if (!(adapter instanceof ManagedLlamaServerAdapter)) return undefined;
  const { registry: _measured, ...profile } = adapter.launchProfile;
  const draft = adapter.draftModelId();
  if (profile.mtp !== true && draft === undefined) return undefined;
  return {
    plain: new ManagedLlamaServerAdapter({ ...profile, speculativeOverride: false }),
    speculative: new ManagedLlamaServerAdapter({ ...profile, speculativeOverride: true }),
    ...(draft !== undefined ? { draft } : {}),
  };
}

/**
 * One point of the prefill-batch and offload sweep (M13): the same server
 * relaunched with `-b` and `-ngl`, measured, then stopped. Swap growth
 * during the point is the cliff — the host pretending the setting fits — and
 * a server that will not start at all is the same answer, louder.
 */
async function sweepProbe(
  adapter: ManagedLlamaServerAdapter,
  candidate: SweepCandidate,
  buckets: number[] | undefined,
): Promise<{ speed: MeasuredSpeed; hitCliff?: boolean }> {
  const { registry: _measured, ...profile } = adapter.launchProfile;
  const probe = new ManagedLlamaServerAdapter({
    ...profile,
    gpuLayers: candidate.gpuLayers,
    extraArgs: [...(profile.extraArgs ?? []), "-b", String(candidate.batchTokens)],
  });
  const baselineSwap = readSwapUsedBytes();
  try {
    const measurement = await calibrateModel(probe, {
      ...(buckets?.length ? { buckets } : {}),
    });
    const headroom = checkExecutionHeadroom(baselineSwap);
    return { speed: measurement.speed, ...(headroom.ok ? {} : { hitCliff: true }) };
  } catch {
    return {
      speed: { prefillTokensPerSecond: undefined, decodeTokensPerSecond: undefined },
      hitCliff: true,
    };
  } finally {
    await probe.unload();
  }
}

/**
 * `sekhemet calibrate` (H3): measure this machine and every model it will
 * run, so residency, throughput floors and the Researcher's budgets rest on
 * numbers from this host rather than someone else's.
 *
 * Models are measured one at a time and unloaded in between, so calibrating
 * three 16 GB models on a 24 GB machine never holds two at once. The profile
 * is saved (models/calibration.ts) and throughput goes into the model
 * registry, where routing and floors read it.
 */

export interface CalibrateCommandOptions {
  /** name=role pairs, e.g. cyber-tiel=worker,apodex=researcher. */
  models: { name: string; role: ModelRole }[];
  buckets?: number[];
  decodeTokens?: number;
  /** Memory the models may use; default is measured from the host. */
  usableBytes?: number;
  /** Measure even when the saved profile matches this hardware. */
  force?: boolean;
  /** Injectable for tests. */
  resolve?: (name: string, role: ModelRole) => UnloadableAdapter;
  path?: string | false;
  /** null: record nothing (tests); omitted: the user's model registry. */
  registry?: ModelRegistry | null;
  /**
   * The prefill batch and offload sweep (M13). Omitted, it runs against the
   * first managed server of the run; `false` skips it, for a quick re-measure.
   */
  sweep?: Parameters<typeof calibrateHardware>[0]["sweep"] | false;
  /** Injectable for tests: the with/without pair for the MTP measurement (M19). */
  speculative?: (adapter: UnloadableAdapter) => SpeculativeProbes | undefined;
  say?: (line: string) => void;
}

export const DEFAULT_CALIBRATION_MODELS: { name: string; role: ModelRole }[] = [
  { name: "cyber-tiel", role: "worker" },
];

export function parseModelList(spec: string | undefined): { name: string; role: ModelRole }[] {
  if (!spec) return DEFAULT_CALIBRATION_MODELS;
  const roles: ModelRole[] = ["worker", "manager", "escalation", "reviewer", "researcher"];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [name, role = "worker"] = pair.split("=");
      if (!roles.includes(role as ModelRole)) throw new Error(`Unknown role "${role}" for ${name}`);
      return { name: name as string, role: role as ModelRole };
    });
}

export async function runCalibrate(
  opts: CalibrateCommandOptions,
): Promise<MachineProfile | undefined> {
  const say = opts.say ?? ((l: string) => console.log(l));
  const saved = opts.path === false ? undefined : loadMachineProfile(opts.path || undefined);
  if (!opts.force && !needsRecalibration(saved)) {
    say(
      `This machine was calibrated on ${saved?.date.slice(0, 10)} (tier ${saved?.tier}); use --force to measure again.`,
    );
    return saved;
  }
  const registry = opts.registry === null ? undefined : (opts.registry ?? new ModelRegistry());
  const roster = new ModelRoster(registry ? { registry } : {});
  const resolve = opts.resolve ?? ((n: string, r: ModelRole) => roster.resolve(n, r));
  const candidates = opts.models.map((m) => {
    const adapter = resolve(m.name, m.role);
    return { label: m.name, adapter, release: () => adapter.unload?.() ?? Promise.resolve() };
  });
  say(
    `Calibrating ${candidates.map((c) => c.label).join(", ")}: one at a time, unloading in between.`,
  );
  // M13: the prefill batch and offload sweep, on the first managed server of
  // the run. It is per machine, not per model, and each point costs a server
  // restart, so it is measured once and applied to every managed launch.
  const sweepable = candidates.find((c) => c.adapter instanceof ManagedLlamaServerAdapter);
  const sweep =
    opts.sweep === false || !sweepable
      ? undefined
      : (opts.sweep ?? {
          probe: (candidate: SweepCandidate) =>
            sweepProbe(sweepable.adapter as ManagedLlamaServerAdapter, candidate, opts.buckets),
        });
  const profile = await calibrateHardware({
    candidates,
    ...(registry ? { registry } : {}),
    ...(opts.buckets ? { buckets: opts.buckets } : {}),
    ...(opts.decodeTokens ? { decodeTokens: opts.decodeTokens } : {}),
    ...(opts.usableBytes !== undefined ? { usableBytes: opts.usableBytes } : {}),
    ...(sweep ? { sweep } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  const gb = (n: number) => Math.round(n / 1024 ** 3);
  say(
    `Machine: ${gb(profile.fingerprint.totalBytes)} GB, tier ${profile.tier}, ${gb(profile.usableBytes)} GB usable for models (${profile.usableMemorySource ?? "given"}), ${profile.memoryBandwidthGbPerSecond ?? "?"} GB/s.`,
  );
  if (profile.settings) {
    const s = profile.settings;
    say(
      `  working context ${s.workingContextTokens} tokens, ${s.parallelCards} card(s) at once, roles ${s.coLoadRoles ? "co-loaded" : "swapped"} — ${s.reason}.`,
    );
  }
  if (profile.launch) say(`  ${profile.launch.reason}.`);
  for (const [label, cal] of Object.entries(profile.models)) {
    const rows = Object.entries(cal.buckets)
      .map(
        ([b, m]) =>
          `${b}: prefill ${m.prefillTokensPerSecond?.toFixed(0) ?? "?"} tok/s, decode ${m.decodeTokensPerSecond?.toFixed(1) ?? "?"} tok/s`,
      )
      .join("; ");
    say(`  ${label} (${cal.throughputClass}): ${rows}`);
  }
  // M19: the speculative head's decode speed, with and without it, one server
  // at a time, for display. Decode speed alone never turns MTP on (models
  // rule 13): what a launch uses is decided per step by --mtp-ab.
  const probeFor = opts.speculative ?? speculativeProbes;
  const speculative: Record<string, SpeculativeVerdict> = {};
  for (const c of candidates) {
    const probes = probeFor(c.adapter);
    if (!probes) continue;
    const footprint = await c.adapter.footprintBytes?.().catch(() => undefined);
    const verdict = await calibrateSpeculative({
      modelId: c.adapter.modelId,
      plain: probes.plain,
      speculative: probes.speculative,
      ...(registry ? { registry } : {}),
      ...(opts.buckets?.[0] ? { buckets: [opts.buckets[0]] } : {}),
      release: async (a) => {
        await (a as UnloadableAdapter).unload?.();
      },
      // Unknown size is not evidence against the head; a size that leaves no
      // room is, and then nothing is loaded to find out.
      ...(footprint !== undefined
        ? { memoryHeadroomOk: profile.usableBytes - footprint >= SPECULATIVE_HEADROOM_BYTES }
        : {}),
    });
    speculative[c.label] = verdict;
    say(
      `  ${c.label} speculative decoding: ${verdict.enabled ? "on" : "off"} by decode speed alone (${verdict.reason}). That does not decide the launch; measure it per step with \`sekhemet calibrate --mtp-ab --from <repo>\`.`,
    );
  }
  if (Object.keys(speculative).length > 0) profile.speculative = speculative;

  // M24: the engine by measurement: predicted seconds per tool-result turn,
  // with cross-turn cache retention (from live telemetry) weighted in.
  const cacheByModel = modelTelemetry.snapshot().cache;
  const engines = new Map<string, EngineCandidate>();
  for (const c of candidates) {
    const cal = profile.models[c.label];
    if (!cal) continue;
    const engine = engineOf(c.adapter);
    const retention = cacheByModel[c.adapter.modelId]?.toolResultHitRate;
    const prev = engines.get(engine);
    const speed = cal.speed;
    if (!prev || (speed.decodeTokensPerSecond ?? 0) > (prev.speed.decodeTokensPerSecond ?? 0)) {
      engines.set(engine, { engine, speed, cacheRetention: retention });
    }
  }
  const decision = selectEngine([...engines.values()]);
  profile.engine = decision;
  if (opts.path !== false) saveMachineProfile(profile, opts.path || undefined);
  say(`Engine: ${decision.engine} (${decision.reason}).`);
  return profile;
}

const ARM_OF_LETTER: Record<string, InferenceRequest["toolArm"]> = {
  A: "arm_a_flat",
  B: "arm_b_json",
  C: "arm_c_sketch",
};

const ARMS = new Set<string>(["arm_a_flat", "arm_b_json", "arm_c_sketch"]);
const POLICIES = new Set<string>(["off", "surgical", "all"]);

export interface RecordedSteps {
  requests: InferenceRequest[];
  /** The thinking policy every replayed step ran under (undefined when none was found). */
  thinking?: ThinkingPolicy;
  /** Steps not replayed, by reason. Another model's steps are not counted. */
  skipped: Record<string, number>;
}

/**
 * The Worker's recorded step requests from run ledgers (MD-M11-1): each step
 * row's context pack (kernel rule 17), rebuilt as exactly the request that
 * was sent — the stored tool definitions (a session's variants included),
 * the arm, reasoning budget, token cap, temperature and purpose — in step
 * order. Only `modelId`'s steps are kept. A step whose pack lacks what the
 * request carried (recorded before packs held it, or its definitions blob
 * gone) is skipped and counted. The steps must have run under one thinking
 * policy (the A/B files its decision under it): `thinking` picks one;
 * without it a mix is refused.
 */
export function recordedStepRequests(
  repos: readonly string[],
  opts: { modelId: string; maxSteps?: number; thinking?: ThinkingPolicy },
): RecordedSteps {
  const byPolicy = new Map<ThinkingPolicy, InferenceRequest[]>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };
  const enough = () =>
    opts.maxSteps !== undefined &&
    (opts.thinking
      ? (byPolicy.get(opts.thinking)?.length ?? 0)
      : [...byPolicy.values()].flat().length) >= opts.maxSteps;
  for (const repo of repos) {
    const dbPath = join(repo, ".sekhemet", "events.db");
    if (!existsSync(dbPath)) continue;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT s.context_pack_id, a.tool_arm FROM steps s JOIN attempts a ON a.id = s.attempt_id
         WHERE s.context_pack_id IS NOT NULL ORDER BY s.card_id, s.attempt_id, s.step_index`,
      )
      .all() as { context_pack_id: string; tool_arm: string }[];
    db.close();
    const blobs = new BlobStore(repo);
    for (const row of rows) {
      if (enough()) break;
      const raw = blobs.get(row.context_pack_id);
      if (raw === undefined) {
        skip("context pack missing");
        continue;
      }
      const pack = JSON.parse(raw) as ContextPack;
      if (pack.modelId !== opts.modelId) continue;
      if (!pack.toolSchemas || !pack.thinking || !POLICIES.has(pack.thinking)) {
        skip("no exact request recorded (an older pack)");
        continue;
      }
      const schemas = blobs.get(pack.toolSchemas);
      if (schemas === undefined) {
        skip("tool definitions missing");
        continue;
      }
      const thinking = pack.thinking as ThinkingPolicy;
      if (opts.thinking && thinking !== opts.thinking) {
        skip(`ran under thinking ${thinking}`);
        continue;
      }
      const list = byPolicy.get(thinking) ?? [];
      list.push({
        systemPrompt: pack.systemPrompt,
        prompt: pack.prompt,
        // The arm it was sent in: the pack's, else the attempt row's (A3).
        toolArm:
          pack.toolArm && ARMS.has(pack.toolArm)
            ? (pack.toolArm as InferenceRequest["toolArm"])
            : (ARM_OF_LETTER[row.tool_arm] ?? "arm_a_flat"),
        tools: JSON.parse(schemas) as ToolDefinition[],
        ...(pack.reasoning
          ? { reasoning: pack.reasoning as NonNullable<InferenceRequest["reasoning"]> }
          : {}),
        ...(pack.reasoningBudgetTokens !== undefined
          ? { reasoningBudgetTokens: pack.reasoningBudgetTokens }
          : {}),
        ...(pack.maxTokens !== undefined ? { maxTokens: pack.maxTokens } : {}),
        ...(pack.temperature !== undefined ? { temperature: pack.temperature } : {}),
        ...(pack.purpose
          ? { purpose: pack.purpose as NonNullable<InferenceRequest["purpose"]> }
          : {}),
      });
      byPolicy.set(thinking, list);
    }
  }
  if (opts.thinking) {
    return { requests: byPolicy.get(opts.thinking) ?? [], thinking: opts.thinking, skipped };
  }
  if (byPolicy.size > 1) {
    const counts = [...byPolicy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, r]) => `${p} ${r.length}`)
      .join(", ");
    throw new Error(
      `the recorded steps ran under more than one thinking policy (${counts}): pick one with --thinking <policy>`,
    );
  }
  const [only] = [...byPolicy.entries()];
  return only ? { requests: only[1], thinking: only[0], skipped } : { requests: [], skipped };
}

/**
 * `sekhemet calibrate --mtp-ab --from <repo,...>` (MD-M11-1/2): replay the
 * Worker's recorded steps with MTP off, then on, one server at a time, and
 * record the decision for the current thinking policy.
 */
export async function runMtpAb(opts: {
  repos: readonly string[];
  worker?: string;
  maxSteps?: number;
  /** Replay only steps that ran under this policy (A4); required when the ledgers mix policies. */
  thinking?: ThinkingPolicy;
  registry?: ModelRegistry;
  say?: (line: string) => void;
}): Promise<number> {
  const say = opts.say ?? ((l: string) => console.log(l));
  const registry = opts.registry ?? new ModelRegistry(defaultRegistryPath());
  const adapter = new ModelRoster({ registry }).resolve(opts.worker ?? "cyber-tiel", "worker");
  const probes = speculativeProbes(adapter);
  if (!probes) {
    say(`${adapter.modelId} has no MTP head or draft model to measure.`);
    return 1;
  }
  const method = probes.draft ? `draft model ${probes.draft}` : "MTP";
  let recorded: RecordedSteps;
  try {
    recorded = recordedStepRequests(opts.repos, {
      modelId: adapter.modelId,
      ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
    });
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 1;
  }
  for (const [why, n] of Object.entries(recorded.skipped)) say(`Skipped ${n} step(s): ${why}.`);
  const { requests, thinking } = recorded;
  if (!thinking || requests.length === 0) {
    say(`No replayable steps of ${adapter.modelId} in ${opts.repos.join(", ")}.`);
    return 1;
  }
  say(
    `Replaying ${requests.length} recorded steps of ${adapter.modelId}, which ran under thinking ${thinking}: ${method} off and on, in ABBA order.`,
  );
  let r: Awaited<ReturnType<typeof mtpStepAB>>;
  try {
    r = await mtpStepAB({
      modelId: adapter.modelId,
      steps: requests,
      plain: probes.plain,
      speculative: probes.speculative,
      thinking,
      registry,
      release: async (a) => {
        await (a as UnloadableAdapter).unload?.();
      },
      // An already-running Worker would be adopted by both probes and
      // measured twice: refuse while the port answers (M11).
      portBusy: () => probes.plain.portBusy(),
      ...(probes.draft ? { draft: probes.draft } : {}),
    });
  } catch (err) {
    say(err instanceof Error ? err.message : String(err));
    return 1;
  }
  say(
    `${method} ${r.enabled ? "on" : "off"} for thinking ${thinking}: ${r.reason} (median ${r.speedup.toFixed(2)}x seconds per step). It is used only once \`sekhemet qualify --speculative on\` has also passed with it (MD-N8-2).`,
  );
  if (r.evidencePath) say(`Per-step timings: ${r.evidencePath}`);
  return 0;
}
