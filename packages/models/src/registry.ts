import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sekhemetConfigDir } from "./models_dir.js";
import {
  type QualificationCombination,
  type SpeculativeSetting,
  changedCombinationElements,
  combinationKey,
  describeCombination,
} from "./qualification_key.js";
import type { ModelRole, ToolArm } from "./types.js";

/**
 * The model registry (M11): the harness's memory of what works on this
 * machine. Design "Registry record": identity, template checksum, sampling,
 * reasoning support, the measured tool arm, throughput per context bucket,
 * qualification, roles. Persisted as one JSON file (written atomically).
 */

export interface ArmMeasurement {
  passRate: number;
  /** Tool-call attempts scored (cases times samples). */
  trials: number;
  /** Share of those attempts whose call was schema-valid (MD-N5-1). */
  toolCallValidity?: number;
  validCalls?: number;
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
    minP?: number;
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
  /** The roles it may hold (MD-N4-1: the one role type). */
  roles?: ModelRole[];
  /** It reads images (X3): a capability, not a role. */
  vision?: boolean;
  /**
   * Its measurement on the labelled screens for the visual gate's vision
   * checklist (gates rule 30, measurement T11): one checklist version. Only
   * a model this qualifies answers the checklist (GT-N4-2).
   */
  visionQualification?: {
    checklistVersion: string;
    approvedScreens: number;
    wrongFails: number;
    defectScreens: number;
    falsePasses: number;
    /** When and by whom it was measured. */
    date?: string;
  };
}

/** SHA-256 of a chat template, hex. */
export function templateChecksum(template: string): string {
  return createHash("sha256").update(template, "utf8").digest("hex");
}

/** Where the registry lives unless configured: `SEKHEMET_MODEL_REGISTRY` or ~/.sekhemet/models.json. */
export function defaultRegistryPath(): string {
  return process.env.SEKHEMET_MODEL_REGISTRY ?? join(sekhemetConfigDir(), "models.json");
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

/** A model whose qualification a change invalidated, waiting to be qualified again (CX-N6-1). */
export interface PendingRequalification {
  modelId: string;
  /** The combination key that was invalidated. */
  key: string;
  reason: string;
  since: string;
}

/** The registry file beside its entries: state that belongs to the host, not one model. */
interface RegistryRoot {
  /** The context version the qualifications were last checked against (CX-N6-1). */
  contextVersion?: string;
  requalify?: PendingRequalification[];
  /**
   * Role assignments per host fingerprint, newest last (NEW-models-10): a
   * person's own, the recorded baseline's and the shipped defaults'.
   */
  assignments?: Record<string, RoleAssignmentRecord[]>;
}

/** One role assignment as the registry keeps it (`assignments.ts` decides them). */
export interface RoleAssignmentRecord {
  role: string;
  model: string;
  scope: "personal" | "baseline" | "default";
  by: string;
  date: string;
  /** The recorded bake-off that admitted a baseline or default change (MD-N10-1). */
  bakeOff?: string;
  /** Set when this assignment restored an earlier one (MD-N10-2). */
  restored?: boolean;
}

type RegistryFile = RegistryRoot & { version?: number; models?: ModelEntry[] };

export class ModelRegistry {
  private entries = new Map<string, ModelEntry>();
  private root: RegistryRoot = {};
  /** Entries and root fields this instance changed: only these override the file on save (MD-N4-5). */
  private dirty = new Set<string>();
  private dirtyRoot = new Set<keyof RegistryRoot>();

  constructor(
    public readonly path: string = defaultRegistryPath(),
    private now: () => Date = () => new Date(),
  ) {
    const raw = this.readFile();
    for (const e of raw.models ?? []) this.entries.set(e.id, e);
    this.root = rootOf(raw);
  }

  private readFile(): RegistryFile {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as RegistryFile;
  }

  private touch(id: string): void {
    this.dirty.add(id);
  }

  /**
   * Record the context version the harness runs now (CX-N6-1). When it
   * differs from the one recorded, every combination qualified under another
   * version is marked invalidated, naming the old and new versions, and its
   * model is scheduled for re-qualification. Returns what was invalidated.
   */
  public observeContextVersion(version: string): PendingRequalification[] {
    const previous = this.root.contextVersion;
    if (previous === version) return [];
    this.root.contextVersion = version;
    this.dirtyRoot.add("contextVersion");
    const invalidated: PendingRequalification[] = [];
    if (previous !== undefined) {
      const date = this.now().toISOString();
      for (const entry of this.entries.values()) {
        const newest = new Map<string, CombinationQualification>();
        for (const q of entry.qualifications ?? []) newest.set(q.key, q);
        for (const q of newest.values()) {
          if (q.status !== "qualified" || q.combination.settings.contextVersion === version)
            continue;
          const reason = `context version changed (${q.combination.settings.contextVersion} -> ${version})`;
          entry.qualifications = [
            ...(entry.qualifications ?? []),
            { ...q, status: "invalidated", reason, date },
          ];
          invalidated.push({ modelId: entry.id, key: q.key, reason, since: date });
        }
        if (invalidated.some((i) => i.modelId === entry.id)) {
          if (entry.qualification && entry.qualification.status === "qualified") {
            entry.qualificationHistory = [
              ...(entry.qualificationHistory ?? []),
              entry.qualification,
            ];
            entry.qualification = {
              ...entry.qualification,
              status: "invalidated",
              reason: `context version changed (${previous} -> ${version})`,
              date,
            };
          }
          this.touch(entry.id);
        }
      }
      if (invalidated.length > 0) {
        this.root.requalify = [...(this.root.requalify ?? []), ...invalidated];
        this.dirtyRoot.add("requalify");
      }
    }
    this.save();
    return invalidated;
  }

  /** Models waiting to be qualified again after a change invalidated them (CX-N6-1). */
  public pendingRequalifications(): PendingRequalification[] {
    return [...(this.root.requalify ?? [])];
  }

  /** Every role assignment recorded for a host, oldest first (NEW-models-10). */
  public roleAssignments(host: string): RoleAssignmentRecord[] {
    return [...(this.root.assignments?.[host] ?? [])];
  }

  /** Append a role assignment for a host and save. */
  public recordRoleAssignment(host: string, record: RoleAssignmentRecord): void {
    this.root.assignments = {
      ...(this.root.assignments ?? {}),
      [host]: [...(this.root.assignments?.[host] ?? []), record],
    };
    this.dirtyRoot.add("assignments");
    this.save();
  }

  /** The context version the qualifications were last checked against. */
  public get contextVersion(): string | undefined {
    return this.root.contextVersion;
  }

  public get(id: string): ModelEntry | undefined {
    return this.entries.get(id);
  }

  /** Models registered for the vision role (X3), best qualified first. */
  public visionModels(): ModelEntry[] {
    return this.list()
      .filter((e) => e.vision === true)
      .sort((a, b) => (b.qualification?.passRate ?? 0) - (a.qualification?.passRate ?? 0));
  }

  public list(): ModelEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Merge fields into an entry (creating it) and save. */
  public upsert(id: string, fields: Partial<Omit<ModelEntry, "id">>): ModelEntry {
    const entry: ModelEntry = { ...(this.entries.get(id) ?? { id }), ...fields, id };
    this.entries.set(id, entry);
    this.touch(id);
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
    this.touch(id);
    this.save();
    return { pinned: previous === undefined, changed, checksum, ...(previous ? { previous } : {}) };
  }

  /**
   * Record one arm's qualification: pass rate, trials and, when scored, its
   * valid tool calls (MD-N5-1); then re-decide the pinned arm, which is
   * cleared when the measurements no longer support one.
   */
  public recordArmMeasurement(
    id: string,
    arm: ToolArm,
    passRate: number,
    trials: number,
    validCalls?: number,
  ): void {
    const entry = this.entries.get(id) ?? { id };
    entry.armMeasurements = {
      ...(entry.armMeasurements ?? {}),
      [arm]: {
        passRate,
        trials,
        ...(validCalls !== undefined
          ? { validCalls, toolCallValidity: trials > 0 ? validCalls / trials : 0 }
          : {}),
        date: this.now().toISOString(),
      },
    };
    const best = selectArm(entry.armMeasurements);
    if (best) entry.toolArm = best;
    else Reflect.deleteProperty(entry, "toolArm");
    this.entries.set(id, entry);
    this.touch(id);
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
    this.touch(id);
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
    this.touch(id);
    // Qualified again under the version in force: no longer waiting (CX-N6-1).
    if (
      this.root.requalify?.some((r) => r.modelId === id) &&
      (this.root.contextVersion === undefined ||
        combination.settings.contextVersion === this.root.contextVersion)
    ) {
      this.root.requalify = this.root.requalify.filter((r) => r.modelId !== id);
      this.dirtyRoot.add("requalify");
    }
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
    this.touch(id);
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
    this.touch(id);
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
    this.touch(id);
    this.save();
  }

  /**
   * Write atomically, merged with the file as it is now (MD-N4-5): an entry
   * or root field another process wrote since this one read is kept unless
   * this instance changed the same one.
   */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const disk = this.readFile();
    for (const e of disk.models ?? []) {
      if (!this.dirty.has(e.id)) this.entries.set(e.id, e);
    }
    const diskRoot = rootOf(disk);
    const root: RegistryRoot = { ...diskRoot };
    for (const k of this.dirtyRoot) {
      if (this.root[k] === undefined) Reflect.deleteProperty(root, k);
      else (root as Record<string, unknown>)[k] = this.root[k];
    }
    this.root = root;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: 1, ...root, models: this.list() }, null, 2)}\n`,
    );
    renameSync(tmp, this.path);
  }
}

function rootOf(raw: RegistryFile): RegistryRoot {
  return {
    ...(raw.contextVersion !== undefined ? { contextVersion: raw.contextVersion } : {}),
    ...(raw.requalify !== undefined ? { requalify: raw.requalify } : {}),
    ...(raw.assignments !== undefined ? { assignments: raw.assignments } : {}),
  };
}

/** The lead a pinned arm must have in tool-call validity (register R4). */
export const ARM_LEAD = 0.05;

function wilson(k: number, n: number, z = 1.959964): { low: number; high: number } {
  if (n <= 0) return { low: 0, high: 1 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * The difference in tool-call validity between two arms and its 95%
 * interval (Newcombe's hybrid score interval from the two Wilson intervals,
 * measurement.md's statistics for independent proportions).
 */
export function armLeadInterval(
  a: Pick<ArmMeasurement, "trials" | "validCalls">,
  b: Pick<ArmMeasurement, "trials" | "validCalls">,
): { difference: number; low: number; high: number } {
  const ka = a.validCalls ?? 0;
  const kb = b.validCalls ?? 0;
  const pa = a.trials > 0 ? ka / a.trials : 0;
  const pb = b.trials > 0 ? kb / b.trials : 0;
  const wa = wilson(ka, a.trials);
  const wb = wilson(kb, b.trials);
  const difference = pa - pb;
  return {
    difference,
    low: difference - Math.sqrt((pa - wa.low) ** 2 + (wb.high - pb) ** 2),
    high: difference + Math.sqrt((wa.high - pa) ** 2 + (pb - wb.low) ** 2),
  };
}

/**
 * The pinned arm (models rule 28, MD-N5-1): arms A, B and C each measured on
 * at least `MIN_ARM_TRIALS` tool-call trials, and the best by tool-call
 * validity leading the next by at least 5 points with the difference's 95%
 * interval excluding zero. Otherwise none: the model runs arm A unmeasured.
 */
export function selectArm(
  measurements: Partial<Record<ToolArm, ArmMeasurement>> | undefined,
  minTrials = MIN_ARM_TRIALS,
): ToolArm | undefined {
  if (!measurements) return undefined;
  const scored = ARM_ORDER.map((arm) => ({ arm, m: measurements[arm] }));
  if (scored.some(({ m }) => !m || m.trials < minTrials || m.validCalls === undefined))
    return undefined;
  const ranked = [...scored].sort(
    (x, y) => (y.m?.toolCallValidity ?? 0) - (x.m?.toolCallValidity ?? 0),
  );
  const [first, second] = ranked as [
    { arm: ToolArm; m: ArmMeasurement },
    { arm: ToolArm; m: ArmMeasurement },
  ];
  const lead = armLeadInterval(first.m, second.m);
  return lead.difference >= ARM_LEAD - 1e-9 && lead.low > 0 ? first.arm : undefined;
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
