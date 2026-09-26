import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { arch, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunProfile, runProfileHash } from "@sekhemet/eval";
import { TOOL_CATALOG } from "@sekhemet/loop";
import {
  DEFAULT_SWAP_POLICY,
  type LocalInferenceAdapter,
  ManagedLlamaServerAdapter,
  type ServerProps,
  type SwapPolicyParams,
  type WorkerOverride,
  harnessProvenance,
} from "@sekhemet/models";

/**
 * The per-attempt reproducibility record (H24): everything that decides what
 * a card attempt did, so a result can be re-run or explained later.
 *
 * "A number without its settings is not admissible" (evidence.ts) covers the
 * sampling settings; this covers the rest: which weights (file, size,
 * quantization, a digest), which llama.cpp build, which prompt and tool
 * schema, which playbook and gates, which harness commit, on what machine.
 *
 * The model digest samples the file's head, middle and tail plus its size
 * (a full SHA-256 of 16 GB takes minutes on a USB drive); it changes whenever
 * the weights do. Digests are cached per (path, size, mtime).
 */
export interface ReproRecord {
  schema: 1;
  cardId: string;
  attempt: number;
  recordedAt: string;
  model: {
    id: string;
    file?: string;
    bytes?: number;
    quant?: string;
    digest?: string;
    runtime?: string;
  };
  /**
   * The assembled stable prefix of this attempt's first request, not the
   * system-prompt constant. Null when no turn ran, which is honest; hashing
   * a compile-time constant is not, because it matches across every card in
   * every repository and so can never detect the drift this record exists
   * to catch.
   */
  promptSha: string | null;
  toolSchemaSha: string;
  playbookSha: string | null;
  activeRules: string[];
  gatesSha: string;
  /** The chat template's checksum the registry pinned (MD-M4-5), or null when none is pinned. */
  templateChecksum: string | null;
  /** The engine settings this launch uses (MD-M4-5): context, KV type, MTP, slots. */
  engine: EngineSettings | null;
  /** What the running server itself reported (`/props`, MD-M4-3), when it could be read. */
  server?: ServerProps;
  /** The harness's own commit, dirty flag and built-output hash (MD-M4-2). */
  harness: { commit: string | null; dirty: boolean; version: string; distSha?: string };
  host: { platform: string; arch: string; memoryGb: number; node: string };
  /** The run's one resolved settings object and its hash (measurement rule 9a, MS-M9-4). */
  runProfile?: RunProfile & { hash: string };
  /** The measured run that prepared the repository, whose `--auto-accept` merged the card (review M5). */
  measurement?: { purpose: string; by: string; createdAt: string };
  /** The person's override the Worker ran under (models rule 27, MD-N4-4). */
  workerOverride?: WorkerOverride;
  /** Smart Swap's version and every parameter the scheduler ran under (models MD-N14-40). */
  swapPolicy?: SwapPolicyParams;
}

export interface EngineSettings {
  contextTokens?: number;
  kvType?: string;
  mtp: boolean;
  parallelSlots?: number;
}

/** The engine settings of a managed launch (MD-M4-5); null for other adapters. */
function engineSettings(model: LocalInferenceAdapter): EngineSettings | null {
  if (!(model instanceof ManagedLlamaServerAdapter)) return null;
  const p = model.launchProfile;
  return {
    ...(model.contextWindow ? { contextTokens: model.contextWindow.contextTokens } : {}),
    kvType: p.kvType ?? "q8_0",
    mtp: model.mtpEnabled(),
    parallelSlots: model.slotCount(),
  };
}

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** The quantization named in a GGUF file name (IQ3_M, Q8_0, Q4_K_M, BF16, ...). */
export function quantFromFile(file: string): string | undefined {
  return /(?:^|[-_.])((?:I?Q\d(?:_[A-Z0-9]+)*)|BF16|F16|F32)(?=[-_.]|\.gguf$)/i
    .exec(file.split("/").pop() ?? "")?.[1]
    ?.toUpperCase();
}

const digestCache = new Map<string, string>();

/** A sampled digest of a large file: size plus 1 MB from its start, middle and end. */
export function sampledDigest(file: string): string | undefined {
  try {
    const st = statSync(file);
    const key = `${file}:${st.size}:${st.mtimeMs}`;
    const hit = digestCache.get(key);
    if (hit) return hit;
    const h = createHash("sha256").update(String(st.size));
    const fd = openSync(file, "r");
    try {
      const chunk = Buffer.alloc(Math.min(1 << 20, st.size));
      for (const at of [
        0,
        Math.max(0, Math.floor(st.size / 2) - chunk.length / 2),
        Math.max(0, st.size - chunk.length),
      ]) {
        const n = readSync(fd, chunk, 0, chunk.length, at);
        h.update(chunk.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }
    const d = `sampled-sha256:${h.digest("hex").slice(0, 32)}`;
    digestCache.set(key, d);
    return d;
  } catch {
    return undefined;
  }
}

/**
 * A llama.cpp build in one form, `b<build> (<commit>)`, from any source:
 * `llama-server --version` as b10809 prints it ("version: 0.4.0 (build
 * 10809, commit 5266f24da)"), the older "version: 5266 (abc1234)", or
 * `/props` `build_info` ("b10809-5266f24da"). One form, so a combination
 * recorded from the server matches one read later from the binary.
 */
export function parseLlamaBuild(text: string): string | undefined {
  const modern = /\(build (\d+), commit ([0-9a-f]+)\)/i.exec(text);
  if (modern) return `b${modern[1]} (${modern[2]})`;
  const older = /version:\s*(\d+) \(([0-9a-f]+)\)/i.exec(text);
  if (older) return `b${older[1]} (${older[2]})`;
  const info = /^\s*b(\d+)(?:-| \()([0-9a-f]+)\)?\s*$/i.exec(text);
  if (info) return `b${info[1]} (${info[2]})`;
  // A version line in a form not seen yet: kept as the binary gave it.
  return /version:\s*(.+)/.exec(text)?.[1]?.trim() || undefined;
}

const runtimeCache = new Map<string, string>();
/**
 * The llama.cpp build (`llama-server --version`, which loads no model),
 * cached per binary. b10809 prints it on stderr, so both streams are read.
 */
export function llamaRuntime(
  binary = process.env.SEKHEMET_LLAMA_SERVER ?? "llama-server",
): string | undefined {
  const cached = runtimeCache.get(binary);
  if (cached !== undefined) return cached || undefined;
  const r = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const build = r.error ? undefined : parseLlamaBuild(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  runtimeCache.set(binary, build ?? "");
  return build;
}

function harnessCommit(): {
  commit: string | null;
  dirty: boolean;
  version: string;
  distSha: string;
} {
  const here = dirname(fileURLToPath(import.meta.url));
  let version = "0.0.0";
  try {
    version = (
      JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }
    ).version;
  } catch {
    // Keep the default.
  }
  // One reading of the harness's provenance for the evidence and this record (MD-M4-2).
  const p = harnessProvenance();
  return {
    commit: p.commit === "unknown" ? null : p.commit,
    dirty: p.dirty,
    version,
    distSha: p.distSha,
  };
}

/** The llama-server binary a managed adapter launches, when it names one. */
function binaryOf(model: LocalInferenceAdapter): string | undefined {
  const p = (model as { profile?: { binary?: unknown } }).profile?.binary;
  return typeof p === "string" ? p : undefined;
}

/** The model file behind an adapter, when it is a managed llama-server model. */
function modelFileOf(model: LocalInferenceAdapter): string | undefined {
  // ManagedLlamaServerAdapter keeps its launch profile privately; read it
  // structurally rather than widen that class's API for a record.
  const m = model as { modelPath?: unknown; profile?: { modelPath?: unknown } };
  const p = m.modelPath ?? m.profile?.modelPath;
  return typeof p === "string" ? p : undefined;
}

export function buildReproRecord(input: {
  /** `prefixHash` of the attempt's first assembled prompt. */
  promptSha?: string | undefined;
  cardId: string;
  attempt: number;
  model: LocalInferenceAdapter;
  repoPath: string;
  gatesSha: string;
  activeRules?: string[];
  /** The running server's own report (`serverProps()`), read by the caller. */
  server?: ServerProps | undefined;
  /** The run's resolved `RunProfile`, when the run resolved one (MS-M9-4). */
  runProfile?: RunProfile | undefined;
  measurement?: { purpose: string; by: string; createdAt: string } | undefined;
  /** The swap policy the scheduler ran under; default the RunProfile's, else the defaults. */
  swapPolicy?: SwapPolicyParams | undefined;
}): ReproRecord {
  const file = modelFileOf(input.model);
  const playbookPath = join(input.repoPath, ".sekhemet", "playbook.toml");
  let bytes: number | undefined;
  if (file && existsSync(file)) bytes = statSync(file).size;
  const digest = file ? sampledDigest(file) : undefined;
  const entry = (input.model as { registry?: { get(id: string): unknown } }).registry?.get(
    input.model.modelId,
  ) as { quant?: string; template?: { checksum?: string } } | undefined;
  // The header's quantisation (recorded at launch), else the file name's.
  const quant = entry?.quant ?? (file ? quantFromFile(file) : undefined);
  // The running server's own report first (its build_info), else the binary's.
  const reported = input.server?.build ? parseLlamaBuild(input.server.build) : undefined;
  const runtime = file ? (reported ?? llamaRuntime(binaryOf(input.model))) : undefined;
  const workerOverride = (input.model as { workerOverride?: WorkerOverride }).workerOverride;
  return {
    schema: 1,
    cardId: input.cardId,
    attempt: input.attempt,
    recordedAt: new Date().toISOString(),
    model: {
      id: input.model.modelId,
      ...(file ? { file } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(quant ? { quant } : {}),
      ...(digest ? { digest } : {}),
      ...(runtime ? { runtime } : {}),
    },
    promptSha: input.promptSha ?? null,
    toolSchemaSha: sha(JSON.stringify(TOOL_CATALOG)),
    playbookSha: existsSync(playbookPath) ? sha(readFileSync(playbookPath)) : null,
    activeRules: [...(input.activeRules ?? [])].sort(),
    gatesSha: input.gatesSha,
    templateChecksum: entry?.template?.checksum ?? null,
    engine: engineSettings(input.model),
    ...(input.server ? { server: input.server } : {}),
    harness: harnessCommit(),
    host: {
      platform: platform(),
      arch: arch(),
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
    },
    ...(input.runProfile
      ? { runProfile: { ...input.runProfile, hash: runProfileHash(input.runProfile) } }
      : {}),
    ...(input.measurement ? { measurement: input.measurement } : {}),
    swapPolicy: input.swapPolicy ?? input.runProfile?.swapPolicy ?? DEFAULT_SWAP_POLICY,
    // Rule 27, MD-N4-4: a Worker running under a person's override says so.
    ...(workerOverride ? { workerOverride } : {}),
  };
}

/** Fields that differ between two records: what changed between two attempts. */
export function reproDiff(a: ReproRecord, b: ReproRecord): string[] {
  const out: string[] = [];
  const cmp = (label: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(label);
  };
  cmp("model", { ...a.model }, { ...b.model });
  cmp("prompt", a.promptSha, b.promptSha);
  cmp("tool schema", a.toolSchemaSha, b.toolSchemaSha);
  cmp("playbook", a.playbookSha, b.playbookSha);
  cmp("active rules", a.activeRules, b.activeRules);
  cmp("gates", a.gatesSha, b.gatesSha);
  cmp("chat template", a.templateChecksum, b.templateChecksum);
  cmp("engine", a.engine, b.engine);
  cmp("server", a.server, b.server);
  cmp("harness", [a.harness.commit, a.harness.distSha], [b.harness.commit, b.harness.distSha]);
  cmp("host", a.host, b.host);
  cmp("run profile", a.runProfile?.hash ?? null, b.runProfile?.hash ?? null);
  return out;
}
