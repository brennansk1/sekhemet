import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpInferenceAdapter } from "./http_adapter.js";
import { ManagedLlamaServerAdapter } from "./llama_server.js";
import type { WorkerOverride } from "./registry.js";
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
  /** A person's override the Worker runs under (rule 27, MD-N4-4). */
  workerOverride?: WorkerOverride;
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
  const workerOverride = (adapter as { workerOverride?: WorkerOverride }).workerOverride;
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
    // Rule 27, MD-N4-4: a Worker running under a person's override says so.
    ...(workerOverride ? { workerOverride } : {}),
    ...overrides,
  };
}

export interface HarnessProvenance {
  /** The harness repository's HEAD, or "unknown" outside a checkout. */
  commit: string;
  /** Tracked files differ from that commit. */
  dirty: boolean;
  /** A hash of every built `dist` directory: what actually ran (MD-M4-2). */
  distSha: string;
}

let provenanceCache: HarnessProvenance | undefined;

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesUnder(join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * The running harness's provenance (MD-M4-2): the commit and dirty flag of
 * the repository this code was built from, found from the code's own
 * location, and a hash of its built `dist` directories, since a package sees
 * another only through `dist`, so the source commit alone does not say
 * what ran. Never the target repository's HEAD. Computed once per process.
 *
 * `dirty` is `git status --porcelain --untracked-files=no`: tracked changes only, so an untracked
 * source file does not set it. What ran is `distSha`, which hashes every
 * built file whatever git knows of its source; read the two together.
 */
export function harnessProvenance(): HarnessProvenance {
  if (provenanceCache) return provenanceCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  let root: string | undefined;
  let commit = "unknown";
  let dirty = false;
  try {
    root = git(["rev-parse", "--show-toplevel"], here);
    commit = git(["rev-parse", "HEAD"], root);
    dirty = git(["status", "--porcelain", "--untracked-files=no"], root) !== "";
  } catch {
    // Not a checkout: an installed build still hashes its own output.
  }
  const base = root ?? join(here, "..", "..", "..");
  const h = createHash("sha256");
  for (const group of ["packages", "apps"]) {
    const groupDir = join(base, group);
    if (!existsSync(groupDir)) continue;
    for (const pkg of readdirSync(groupDir).sort()) {
      const dist = join(groupDir, pkg, "dist");
      if (!existsSync(dist)) continue;
      for (const f of filesUnder(dist)) {
        h.update(`${group}/${pkg}/dist/${f}\0`);
        h.update(readFileSync(join(dist, f)));
      }
    }
  }
  provenanceCache = { commit, dirty, distSha: h.digest("hex").slice(0, 16) };
  return provenanceCache;
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
