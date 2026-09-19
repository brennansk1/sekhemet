import {
  type EngineCandidate,
  HttpInferenceAdapter,
  type MachineProfile,
  ManagedLlamaServerAdapter,
  ModelRegistry,
  type ModelRole,
  ModelRoster,
  type UnloadableAdapter,
  calibrateHardware,
  loadMachineProfile,
  modelTelemetry,
  needsRecalibration,
  saveMachineProfile,
  selectEngine,
} from "@sekhemet/models";

/** The inference engine behind an adapter (M24). */
function engineOf(adapter: unknown): string {
  if (adapter instanceof ManagedLlamaServerAdapter) return "llama.cpp";
  if (adapter instanceof HttpInferenceAdapter)
    return adapter.api === "ollama" ? "ollama" : "openai-compatible";
  return "unknown";
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
  /** Measure even when the saved profile matches this hardware. */
  force?: boolean;
  /** Injectable for tests. */
  resolve?: (name: string, role: ModelRole) => UnloadableAdapter;
  path?: string | false;
  /** null: record nothing (tests); omitted: the user's model registry. */
  registry?: ModelRegistry | null;
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
  const profile = await calibrateHardware({
    candidates,
    ...(registry ? { registry } : {}),
    ...(opts.buckets ? { buckets: opts.buckets } : {}),
    ...(opts.decodeTokens ? { decodeTokens: opts.decodeTokens } : {}),
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  say(
    `Machine: ${Math.round(profile.fingerprint.totalBytes / 1024 ** 3)} GB, tier ${profile.tier}, ${Math.round(profile.usableBytes / 1024 ** 3)} GB usable for models.`,
  );
  for (const [label, cal] of Object.entries(profile.models)) {
    const rows = Object.entries(cal.buckets)
      .map(
        ([b, m]) =>
          `${b}: prefill ${m.prefillTokensPerSecond?.toFixed(0) ?? "?"} tok/s, decode ${m.decodeTokensPerSecond?.toFixed(1) ?? "?"} tok/s`,
      )
      .join("; ");
    say(`  ${label} (${cal.throughputClass}): ${rows}`);
  }
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
