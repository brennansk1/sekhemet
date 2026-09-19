import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { arch, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPT_ZONE_1_SYSTEM } from "@sekhemet/context";
import { TOOL_CATALOG } from "@sekhemet/loop";
import type { LocalInferenceAdapter } from "@sekhemet/models";

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
  promptSha: string;
  toolSchemaSha: string;
  playbookSha: string | null;
  activeRules: string[];
  gatesSha: string;
  harness: { commit: string | null; dirty: boolean; version: string };
  host: { platform: string; arch: string; memoryGb: number; node: string };
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

let runtimeCache: string | undefined;
function llamaRuntime(
  binary = process.env.SEKHEMET_LLAMA_SERVER ?? "llama-server",
): string | undefined {
  if (runtimeCache !== undefined) return runtimeCache || undefined;
  try {
    const out = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtimeCache = /version:\s*(\S+ \([^)]+\))/.exec(out)?.[1] ?? out.split("\n")[0]?.trim() ?? "";
  } catch (err) {
    const text = String((err as { stderr?: string }).stderr ?? "");
    runtimeCache = /version:\s*(\S+ \([^)]+\))/.exec(text)?.[1] ?? "";
  }
  return runtimeCache || undefined;
}

function harnessCommit(): { commit: string | null; dirty: boolean; version: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  let version = "0.0.0";
  try {
    version = (
      JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version: string }
    ).version;
  } catch {
    // Keep the default.
  }
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: here,
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: here,
        encoding: "utf8",
        timeout: 5000,
      }).trim() !== "";
    return { commit, dirty, version };
  } catch {
    return { commit: null, dirty: false, version };
  }
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
  cardId: string;
  attempt: number;
  model: LocalInferenceAdapter;
  repoPath: string;
  gatesSha: string;
  activeRules?: string[];
}): ReproRecord {
  const file = modelFileOf(input.model);
  const playbookPath = join(input.repoPath, ".sekhemet", "playbook.toml");
  let bytes: number | undefined;
  if (file && existsSync(file)) bytes = statSync(file).size;
  const digest = file ? sampledDigest(file) : undefined;
  const quant = file ? quantFromFile(file) : undefined;
  const runtime = file ? llamaRuntime() : undefined;
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
    promptSha: sha(PROMPT_ZONE_1_SYSTEM),
    toolSchemaSha: sha(JSON.stringify(TOOL_CATALOG)),
    playbookSha: existsSync(playbookPath) ? sha(readFileSync(playbookPath)) : null,
    activeRules: [...(input.activeRules ?? [])].sort(),
    gatesSha: input.gatesSha,
    harness: harnessCommit(),
    host: {
      platform: platform(),
      arch: arch(),
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      node: process.version,
    },
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
  cmp("harness", a.harness.commit, b.harness.commit);
  cmp("host", a.host, b.host);
  return out;
}
