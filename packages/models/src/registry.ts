import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type QualificationCombination,
  type SpeculativeSetting,
  changedCombinationElements,
  combinationKey,
  describeCombination,
} from "./qualification_key.js";
import type { ToolArm } from "./types.js";

/**
 * The model registry (M11): the harness's memory of what works on this
 * machine. Design "Registry record": identity, template checksum, sampling,
 * reasoning support, the measured tool arm, throughput per context bucket,
 * qualification, roles. Persisted as one JSON file (written atomically).
 */
export type RegistryRole = "planner" | "executor" | "verifier" | "vision" | "pruner";

export interface ArmMeasurement {
  passRate: number;
  trials: number;
  date: string;
}

export interface QualificationRecord {
  suiteVersion: string;
  passRate: number;
  date: string;
  status: "qualified" | "failed" | "invalidated";
  /** KV type the qualification ran with (below-8-bit KV needs one, M16). */
  kvType?: string;
  /** Why the record was invalidated (a template change, M12), or why it failed. */
  reason?: string;
  byCategory?: Record<string, number>;
}

/**
 * One combination's qualification (rule 27a, MD-N8-1): the record, the exact
 * combination it ran on, the speed measured with it, and whether the
 * tool-call checks (schema validity, the multi-step conversation, recall and
 * recovery) passed on their own.
 */
export interface CombinationQualification extends QualificationRecord {
  key: string;
  combination: QualificationCombination;
  toolCallChecks?: boolean;
  speed?: { decodeTokensPerSecond: number; medianCaseMs: number };
  /** Each check's exact (Clopper–Pearson) 95% interval over its samples (suite q1.2). */
  intervals?: Record<string, { low: number; high: number }>;
  /** The samples each case ran (k, suite q1.2). */
  samples?: number;
}

/**
 * A person's recorded decision to run a Worker whose combination failed
 * qualification (rule 27, MD-N4-4): who, why, when, and the checks that
 * failed. What every measurement made under it records.
 */
export interface WorkerOverride {
  by: string;
  reason: string;
  date: string;
  failedChecks: string[];
}

/** An override as the registry holds it: for one exact combination (rule 27a). */
export interface QualificationOverride extends WorkerOverride {
  key: string;
  combination: QualificationCombination;
  /** The date of the failed qualification it overrides. */
  failedAt: string;
}

/** What a lookup found for a model and combination (MD-N8-1, MD-N8-4). */
export interface QualificationLookup {
  /** `overridden`: the combination failed and a person recorded an override (MD-N4-4). */
  status: "qualified" | "overridden" | "failed" | "invalidated" | "missing";
  /** One sentence: why the combination may or may not be used. */
  reason: string;
  /** For `invalidated`: the elements that differ from the nearest qualified combination. */
  changed?: string[];
  record?: CombinationQualification;
  /** For `overridden`: the override that lets the failed combination run. */
  override?: WorkerOverride;
}

/** The override's one line, as a refusal check prints it. */
export function describeOverride(o: WorkerOverride): string {
  return `qualified by override: ${o.by}, ${o.date.slice(0, 10)}: failed ${o.failedChecks.join(", ")}`;
}

export type ThinkingPolicy = "off" | "surgical" | "all";

/** SEKHEMET_THINKING=off|surgical|all; anything else is the default, off. */
export function thinkingPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ThinkingPolicy {
  const v = env.SEKHEMET_THINKING;
  return v === "surgical" || v === "all" ? v : "off";
}

export interface SpeculativeDecision {
  enabled: boolean;
  /** Decode speed-up of speculative over plain decoding (1.0 = none). */
  speedup: number;
  reason: string;
  fingerprint: string;
  date: string;
  /** The thinking policy it was measured under; a decision applies to that policy only (MD-M7-2). */
  thinking?: ThinkingPolicy;
  /** The draft model it was measured with (MD-N8-5); absent for the model's own MTP head. */
  draft?: string;
}

export interface ModelEntry {
  id: string;
  family?: string;
  quant?: string;
  sizeBytes?: number;
  contextWindow?: number;
  engine?: string;
  template?: { path?: string; checksum: string; pinnedAt: string };
  sampling?: {
    temperature?: number;
    topP?: number;
    topK?: number;
    penalties?: Record<string, number>;
  };
  reasoning?: { supported: boolean; defaultBudget: number; stripTraces: boolean };
  /** The winning arm from qualification runs (measured, not assumed). */
  toolArm?: ToolArm;
  armMeasurements?: Partial<Record<ToolArm, ArmMeasurement>>;
  scriptCapable?: boolean;
  /** Tokens/s per context bucket (e.g. "2k", "8k", "16k"). */
  throughput?: Record<string, { prefill: number; decode: number }>;
  qualification?: QualificationRecord;
  /** The tier an air-gap manifest claims (SEC-34b): information, not a qualification. */
  manifestTier?: string;
  /** Earlier qualification records, newest last. */
  qualificationHistory?: QualificationRecord[];
  /** The latest speculative decision recorded, for display. */
  speculative?: SpeculativeDecision;
  /** Each thinking policy's decision (MD-M7-2): the one a launch reads. */
  speculativeByPolicy?: Partial<Record<ThinkingPolicy, SpeculativeDecision>>;
  /** A draft model's decisions (MD-N8-5), keyed by the draft model, then the thinking policy. */
  speculativeByDraft?: Record<string, Partial<Record<ThinkingPolicy, SpeculativeDecision>>>;
  /** Qualifications per combination (rule 27a), newest last. */
  qualifications?: CombinationQualification[];
  /** Persons' overrides of failed combinations (rule 27, MD-N4-4), newest last. */
  overrides?: QualificationOverride[];
  roles?: RegistryRole[];
}

/** SHA-256 of a chat template, hex. */
export function templateChecksum(template: string): string {
  return createHash("sha256").update(template, "utf8").digest("hex");
}

/** Where the registry lives unless configured: `SEKHEMET_MODEL_REGISTRY` or ~/.sekhemet/models.json. */
export function defaultRegistryPath(): string {
  return process.env.SEKHEMET_MODEL_REGISTRY ?? join(homedir(), ".sekhemet", "models.json");
}

/** Minimum trials before an arm measurement may decide the arm. */
export const MIN_ARM_TRIALS = 5;

const ARM_ORDER: ToolArm[] = ["arm_a_flat", "arm_b_json", "arm_c_sketch"];

export interface TemplatePinResult {
  /** No template was pinned before; this one is now. */
  pinned: boolean;
  /** A different template was pinned: qualification was invalidated. */
  changed: boolean;
  checksum: string;
  previous?: string;
}

export class ModelRegistry {
  private entries = new Map<string, ModelEntry>();

  constructor(
    public readonly path: string = defaultRegistryPath(),
    private now: () => Date = () => new Date(),
  ) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { models?: ModelEntry[] };
      for (const e of raw.models ?? []) this.entries.set(e.id, e);
    }
  }

  public get(id: string): ModelEntry | undefined {
    return this.entries.get(id);
  }

  /** Models registered for the vision role (X3), best qualified first. */
  public visionModels(): ModelEntry[] {
    return this.list()
      .filter((e) => e.roles?.includes("vision"))
      .sort((a, b) => (b.qualification?.passRate ?? 0) - (a.qualification?.passRate ?? 0));
  }

  public list(): ModelEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Merge fields into an entry (creating it) and save. */
  public upsert(id: string, fields: Partial<Omit<ModelEntry, "id">>): ModelEntry {
    const entry: ModelEntry = { ...(this.entries.get(id) ?? { id }), ...fields, id };
    this.entries.set(id, entry);
    this.save();
    return entry;
  }

  /**
   * Pin a chat template by checksum (M12). The first template seen is
   * pinned; a different one later invalidates the model's qualification,
   * because up to 40% of small-model tool-call failures trace to templates.
   */
  public pinTemplate(id: string, template: string, path?: string): TemplatePinResult {
    const checksum = templateChecksum(template);
    const entry = this.entries.get(id) ?? { id };
    const previous = entry.template?.checksum;
    if (previous === checksum) return { pinned: false, changed: false, checksum };
    const date = this.now().toISOString();
    entry.template = { checksum, pinnedAt: date, ...(path ? { path } : {}) };
    let changed = false;
    if (previous !== undefined) {
      changed = true;
      if (entry.qualification && entry.qualification.status !== "invalidated") {
        entry.qualificationHistory = [...(entry.qualificationHistory ?? []), entry.qualification];
        entry.qualification = {
          ...entry.qualification,
          status: "invalidated",
          reason: `chat template changed (${previous.slice(0, 12)} -> ${checksum.slice(0, 12)})`,
          date,
        };
      }
      // The measured arm was measured under the old template too.
      Reflect.deleteProperty(entry, "toolArm");
      Reflect.deleteProperty(entry, "armMeasurements");
    }
    this.entries.set(id, entry);
    this.save();
    return { pinned: previous === undefined, changed, checksum, ...(previous ? { previous } : {}) };
  }

  /** Record one arm's qualification pass rate (M9), then re-decide the arm. */
  public recordArmMeasurement(id: string, arm: ToolArm, passRate: number, trials: number): void {
    const entry = this.entries.get(id) ?? { id };
    entry.armMeasurements = {
      ...(entry.armMeasurements ?? {}),
      [arm]: { passRate, trials, date: this.now().toISOString() },
    };
    const best = selectArm(entry.armMeasurements);
    if (best) entry.toolArm = best;
    this.entries.set(id, entry);
    this.save();
  }

  /** The measured arm for a model, undefined until measured (M9). */
  public armFor(id: string): ToolArm | undefined {
    return this.entries.get(id)?.toolArm;
  }

  public recordQualification(id: string, record: Omit<QualificationRecord, "date">): void {
    const entry = this.entries.get(id) ?? { id };
    if (entry.qualification) {
      entry.qualificationHistory = [...(entry.qualificationHistory ?? []), entry.qualification];
    }
    entry.qualification = { ...record, date: this.now().toISOString() };
    this.entries.set(id, entry);
    this.save();
  }

  /** Qualified now: a current, non-invalidated record at or above the bar. */
  public isQualified(id: string, bar: number): boolean {
    const q = this.entries.get(id)?.qualification;
    return q !== undefined && q.status === "qualified" && q.passRate >= bar;
  }

  /**
   * Record a qualification for one combination (MD-N8-1). The per-model
   * record (`qualification`) is kept up to date as well, so readers written
   * before combinations still see the latest result.
   */
  public recordCombinationQualification(
    id: string,
    combination: QualificationCombination,
    record: Omit<CombinationQualification, "date" | "key" | "combination">,
  ): CombinationQualification {
    const entry = this.entries.get(id) ?? { id };
    const date = this.now().toISOString();
    const full: CombinationQualification = {
      ...record,
      date,
      key: combinationKey(combination),
      combination,
    };
    entry.qualifications = [...(entry.qualifications ?? []), full];
    if (entry.qualification) {
      entry.qualificationHistory = [...(entry.qualificationHistory ?? []), entry.qualification];
    }
    const {
      key: _k,
      combination: _c,
      toolCallChecks: _t,
      speed: _s,
      intervals: _i,
      samples: _n,
      ...plain
    } = full;
    entry.qualification = plain;
    this.entries.set(id, entry);
    this.save();
    return full;
  }

  /**
   * Record a person's override of this combination's latest qualification,
   * which must have failed (rule 27, MD-N4-4): what was not measured, or
   * passed, cannot be overridden. The failure and the bar are left as they
   * are; the checks under `bar` are named.
   */
  public recordQualificationOverride(
    id: string,
    combination: QualificationCombination,
    decision: { by: string; reason: string },
    bar: number,
  ): WorkerOverride {
    const entry = this.entries.get(id);
    const key = combinationKey(combination);
    const exact = [...(entry?.qualifications ?? [])].reverse().find((q) => q.key === key);
    if (!entry || !exact) {
      throw new Error(
        `no failed qualification of ${id} for this combination (${describeCombination(combination)}): qualify it first, then override the failure`,
      );
    }
    if (exact.status !== "failed") {
      throw new Error(
        exact.status === "qualified"
          ? `${id} is qualified for this combination: nothing to override`
          : `${id}'s qualification for this combination was invalidated: qualify it again first`,
      );
    }
    const scores = Object.entries(exact.byCategory ?? {}).filter(([, v]) => v < bar);
    const failedChecks =
      scores.length > 0
        ? scores.map(([c, v]) => `${c} ${Math.round(v * 100)}%`)
        : [exact.reason ?? `pass rate ${Math.round(exact.passRate * 100)}%`];
    const override: QualificationOverride = {
      by: decision.by,
      reason: decision.reason,
      date: this.now().toISOString(),
      failedChecks,
      key,
      combination,
      failedAt: exact.date,
    };
    entry.overrides = [...(entry.overrides ?? []), override];
    this.save();
    const { key: _k, combination: _c, failedAt: _f, ...plain } = override;
    return plain;
  }

  /**
   * Whether a model may be used with this combination (MD-N8-1). The newest
   * record for the exact combination decides; with none, the nearest
   * qualified combination names what changed (MD-N8-4).
   */
  public lookupQualification(
    id: string,
    combination: QualificationCombination,
  ): QualificationLookup {
    const entry = this.entries.get(id);
    const all = entry?.qualifications ?? [];
    const key = combinationKey(combination);
    const exact = [...all].reverse().find((q) => q.key === key);
    if (exact) {
      if (exact.status === "qualified") {
        return {
          status: "qualified",
          reason: `qualified ${exact.date.slice(0, 10)}`,
          record: exact,
        };
      }
      // A person's override of this exact failure (MD-N4-4): the record stays
      // failed. Only the newest failure is overridden: a later run of the same
      // combination, passed or failed, supersedes it (review major 1).
      const override =
        exact.status === "failed"
          ? [...(entry?.overrides ?? [])]
              .reverse()
              .find((o) => o.key === key && o.failedAt === exact.date)
          : undefined;
      if (override) {
        const { key: _k, combination: _c, failedAt: _f, ...plain } = override;
        return {
          status: "overridden",
          reason: describeOverride(plain),
          record: exact,
          override: plain,
        };
      }
      const invalidated = exact.status === "invalidated";
      return {
        status: invalidated ? "invalidated" : "failed",
        reason: `this combination ${invalidated ? "was invalidated" : "failed qualification"}${exact.reason ? `: ${exact.reason}` : ""}`,
        record: exact,
      };
    }
    const nearest = all
      .filter((q) => q.status === "qualified")
      .map((q) => ({ q, changed: changedCombinationElements(q.combination, combination) }))
      .sort((a, b) => a.changed.length - b.changed.length)[0];
    // An override is invalidated by a change exactly as a qualification is (MD-N8-4).
    const nearestOverride = (entry?.overrides ?? [])
      .map((o) => ({ o, changed: changedCombinationElements(o.combination, combination) }))
      .sort((a, b) => a.changed.length - b.changed.length)[0];
    if (nearestOverride && (!nearest || nearestOverride.changed.length < nearest.changed.length)) {
      const { o, changed } = nearestOverride;
      return {
        status: "invalidated",
        reason: `${changed.join(", ")} changed since the override by ${o.by} (${describeCombination(o.combination)})`,
        changed,
      };
    }
    if (nearest) {
      return {
        status: "invalidated",
        reason: `${nearest.changed.join(", ")} changed since it qualified (${describeCombination(nearest.q.combination)})`,
        changed: nearest.changed,
        record: nearest.q,
      };
    }
    return {
      status: "missing",
      reason: entry?.qualification
        ? "qualified per model, before combinations were recorded; this combination never qualified"
        : "never qualified on this host",
    };
  }

  /**
   * The newest qualification of this model on this host with the given
   * speculative setting, prefix caching on, and the given launch settings
   * (MD-N8-2). The launch knows these elements; the rest of the combination
   * (engine and model builds, template, context version) is checked when the
   * model is assigned or used (MD-N8-1).
   */
  public speculativeQualification(
    id: string,
    want: {
      host: string;
      speculative: Exclude<SpeculativeSetting, "off">;
      contextTokens?: number;
      kvType?: string;
      parallelSlots?: number;
    },
  ): CombinationQualification | undefined {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    return [...(this.entries.get(id)?.qualifications ?? [])].reverse().find((q) => {
      const s = q.combination.settings;
      return (
        q.combination.host === want.host &&
        same(s.speculative, want.speculative) &&
        s.prefixCaching &&
        (want.contextTokens === undefined || s.contextTokens === want.contextTokens) &&
        (want.kvType === undefined || s.kvType === want.kvType) &&
        (want.parallelSlots === undefined || s.parallelSlots === want.parallelSlots)
      );
    });
  }

  public recordThroughput(id: string, bucket: string, prefill: number, decode: number): void {
    const entry = this.entries.get(id) ?? { id };
    entry.throughput = { ...(entry.throughput ?? {}), [bucket]: { prefill, decode } };
    this.entries.set(id, entry);
    this.save();
  }

  public recordSpeculative(id: string, decision: SpeculativeDecision): void {
    const entry = this.entries.get(id) ?? { id };
    entry.speculative = decision;
    if (decision.thinking && decision.draft) {
      // A draft model's decision is its own (MD-N8-5): it never stands in for the MTP head's.
      entry.speculativeByDraft = {
        ...(entry.speculativeByDraft ?? {}),
        [decision.draft]: {
          ...(entry.speculativeByDraft?.[decision.draft] ?? {}),
          [decision.thinking]: decision,
        },
      };
    } else if (decision.thinking)
      entry.speculativeByPolicy = {
        ...(entry.speculativeByPolicy ?? {}),
        [decision.thinking]: decision,
      };
    this.entries.set(id, entry);
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, models: this.list() }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}

/**
 * The winning arm from measurements (M9): highest pass rate among arms with
 * at least `MIN_ARM_TRIALS` trials; ties go to the simpler arm (A, B, C).
 */
export function selectArm(
  measurements: Partial<Record<ToolArm, ArmMeasurement>> | undefined,
  minTrials = MIN_ARM_TRIALS,
): ToolArm | undefined {
  if (!measurements) return undefined;
  let best: ToolArm | undefined;
  let bestRate = -1;
  for (const arm of ARM_ORDER) {
    const m = measurements[arm];
    if (!m || m.trials < minTrials) continue;
    if (m.passRate > bestRate) {
      best = arm;
      bestRate = m.passRate;
    }
  }
  return best;
}

/**
 * Read the chat template a running server uses: llama-server `GET /props`
 * (`chat_template`), Ollama `POST /api/show` (`template`). Undefined when
 * the server does not expose it.
 */
export async function fetchChatTemplate(
  baseUrl: string,
  apiFormat: "ollama" | "openai",
  modelId: string,
): Promise<string | undefined> {
  try {
    if (apiFormat === "ollama") {
      const res = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return undefined;
      const body = (await res.json()) as { template?: string };
      return typeof body.template === "string" && body.template ? body.template : undefined;
    }
    const res = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { chat_template?: string };
    return typeof body.chat_template === "string" && body.chat_template
      ? body.chat_template
      : undefined;
  } catch {
    return undefined;
  }
}
