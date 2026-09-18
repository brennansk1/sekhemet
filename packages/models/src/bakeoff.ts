import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { HttpInferenceAdapter } from "./http_adapter.js";
import { ManagedLlamaServerAdapter } from "./llama_server.js";
import type { LocalInferenceAdapter, ToolArm } from "./types.js";

/**
 * Per-repo bake-off records (M23, design "Per-repo bake-off"): every result
 * is recorded with its full settings (model, quant, tool arm, step budget,
 * working context, engine, date, harness commit). A number without settings
 * is not admissible, so `validateBakeOffRecord` rejects incomplete ones.
 */
export interface CandidateSettings {
  modelId: string;
  quant: string;
  engine: "llama.cpp" | "ollama" | "openai-compatible" | "mlx" | (string & {});
  toolArm: ToolArm;
  contextTokens: number | undefined;
  kvType?: string;
  sampling?: Record<string, number>;
  mtp?: boolean;
}

export interface BakeOffRecord {
  candidate: CandidateSettings;
  /** The fixture or synthesized task set. */
  fixture: string;
  stepBudget: number;
  harnessCommit: string;
  date: string;
  passed: number;
  total: number;
  passAt1: number;
  minutes: number;
  tokens: number;
}

/** The quantisation named in a GGUF file name or an Ollama tag. */
export function quantFromName(name: string): string {
  const m = /(UD-)?(IQ\d_[A-Z]+|Q\d_K_[A-Z]+|Q\d_K|Q\d_\d|BF16|F16|F32|MXFP4|Q8_0)/i.exec(
    basename(name),
  );
  return m ? m[0].toUpperCase() : "unknown";
}

/**
 * Derive a candidate's full settings from its adapter. Managed llama-server
 * adapters know their GGUF and launch profile; Ollama adapters know their
 * tag. The arm is the measured one when the registry has it.
 */
export function candidateSettings(
  adapter: LocalInferenceAdapter,
  overrides: Partial<CandidateSettings> = {},
): CandidateSettings {
  let quant = quantFromName(adapter.modelId);
  let engine: CandidateSettings["engine"] = "openai-compatible";
  let kvType: string | undefined;
  let mtp: boolean | undefined;
  let sampling: Record<string, number> | undefined;
  if (adapter instanceof ManagedLlamaServerAdapter) {
    const p = adapter.launchProfile;
    quant = quantFromName(p.modelPath);
    engine = "llama.cpp";
    kvType = p.kvType ?? "q8_0";
    mtp = adapter.mtpEnabled();
    if (p.sampling) sampling = { ...p.sampling } as Record<string, number>;
  } else if (adapter instanceof HttpInferenceAdapter) {
    engine = adapter.api === "ollama" ? "ollama" : "openai-compatible";
    sampling = { ...adapter.samplingFor({}) } as Record<string, number>;
  }
  return {
    modelId: adapter.modelId,
    quant,
    engine,
    toolArm: adapter.preferredToolArm ?? "arm_a_flat",
    contextTokens: adapter.contextWindow?.contextTokens,
    ...(kvType ? { kvType } : {}),
    ...(mtp !== undefined ? { mtp } : {}),
    ...(sampling ? { sampling } : {}),
    ...overrides,
  };
}

/** The harness's own commit (git HEAD of `repoPath`), or "unknown". */
export function harnessCommit(repoPath: string = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: repoPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Missing settings that make a record inadmissible. Empty when admissible. */
export function validateBakeOffRecord(r: BakeOffRecord): string[] {
  const missing: string[] = [];
  const c = r.candidate;
  if (!c.modelId) missing.push("model");
  if (!c.quant || c.quant === "unknown") missing.push("quant");
  if (!c.engine) missing.push("engine");
  if (!c.toolArm) missing.push("tool arm");
  if (!c.contextTokens) missing.push("working context");
  if (!r.stepBudget) missing.push("step budget");
  if (!r.date) missing.push("date");
  if (!r.harnessCommit || r.harnessCommit === "unknown") missing.push("harness commit");
  return missing;
}

/**
 * Append a record to the bake-off log (JSONL). Throws when the record is
 * inadmissible, unless `allowIncomplete` is set (then it is tagged).
 */
export function appendBakeOffRecord(
  path: string,
  record: BakeOffRecord,
  options: { allowIncomplete?: boolean } = {},
): void {
  const missing = validateBakeOffRecord(record);
  if (missing.length > 0 && !options.allowIncomplete) {
    throw new Error(`Bake-off record is inadmissible; missing: ${missing.join(", ")}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const line = missing.length > 0 ? { ...record, incomplete: missing } : record;
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

export function readBakeOffRecords(path: string): BakeOffRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as BakeOffRecord);
}

/** Build a record from a run's outcome and the candidate's adapter. */
export function bakeOffRecord(input: {
  adapter: LocalInferenceAdapter;
  fixture: string;
  stepBudget: number;
  passed: number;
  total: number;
  minutes: number;
  tokens: number;
  repoPath?: string;
  overrides?: Partial<CandidateSettings>;
  now?: Date;
}): BakeOffRecord {
  return {
    candidate: candidateSettings(input.adapter, input.overrides),
    fixture: input.fixture,
    stepBudget: input.stepBudget,
    harnessCommit: harnessCommit(input.repoPath),
    date: (input.now ?? new Date()).toISOString(),
    passed: input.passed,
    total: input.total,
    passAt1: input.total > 0 ? Math.round((input.passed / input.total) * 1000) / 1000 : 0,
    minutes: Math.round(input.minutes * 10) / 10,
    tokens: input.tokens,
  };
}
