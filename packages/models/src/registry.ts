import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
  /** Why the record was invalidated (a template change, M12). */
  reason?: string;
  byCategory?: Record<string, number>;
}

export interface SpeculativeDecision {
  enabled: boolean;
  /** Decode speed-up of speculative over plain decoding (1.0 = none). */
  speedup: number;
  reason: string;
  fingerprint: string;
  date: string;
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
  /** Earlier qualification records, newest last. */
  qualificationHistory?: QualificationRecord[];
  speculative?: SpeculativeDecision;
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

  public recordThroughput(id: string, bucket: string, prefill: number, decode: number): void {
    const entry = this.entries.get(id) ?? { id };
    entry.throughput = { ...(entry.throughput ?? {}), [bucket]: { prefill, decode } };
    this.entries.set(id, entry);
    this.save();
  }

  public recordSpeculative(id: string, decision: SpeculativeDecision): void {
    const entry = this.entries.get(id) ?? { id };
    entry.speculative = decision;
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
