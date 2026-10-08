import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { connect } from "node:net";
import { totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { hostFingerprintHash } from "./calibration.js";
import { recordedGguf } from "./generic_managed.js";
import {
  type HttpAdapterOptions,
  HttpInferenceAdapter,
  type SamplingOptions,
} from "./http_adapter.js";
import { llamaServerBinary, resolveLlamaServer } from "./inference_engine.js";
import { assertKvPolicy } from "./kv_policy.js";
import { assertModelLoadAllowed, modelLoadRefusal } from "./load_guard.js";
import {
  DriveUnavailableError,
  type LoadOptions,
  assertLaunchFlags,
  assertServedContext,
  checkDrive,
  loadModeArgs,
  prereadSequential,
} from "./load_mechanics.js";
import { acquireModelLease, modelLeasePath, tryModelLease } from "./model_lease.js";
import { type ModelsDirOptions, resolveModelPath } from "./models_dir.js";
import type { SpeculativeSetting } from "./qualification_key.js";
import { readQuantisation } from "./quantisation.js";
import {
  type ModelEntry,
  type ModelRegistry,
  type ThinkingPolicy,
  thinkingPolicyFromEnv,
} from "./registry.js";
import {
  type ErasureView,
  type SlotKey,
  SlotStore,
  defaultSlotCacheDir,
  slotCacheMaxBytes,
} from "./slot_state.js";
import { DEFAULT_READ_BYTES_PER_SECOND } from "./swap_cost.js";
import type {
  AdapterHealth,
  InferenceRequest,
  ModelRole,
  TokenUsage,
  ToolCallFormat,
} from "./types.js";

/**
 * The GGUF each managed profile expects, as a name inside the user's models
 * directory. Shipped source names files, never locations (design "Getting the
 * weights"); `--models-dir` decides where they are, and a user with the
 * weights elsewhere passes `modelPath` directly.
 */

/**
 * A managed engine that could not start: its weights' file is gone (a
 * models volume detached during the load, C.6), or the server exited or
 * never became healthy. Coded like a refused connection, so a card stops
 * with `model_unavailable` — held in Ready, not counted against the Worker,
 * the queue halted (worker-loop WL-N12-2) — rather than `error`.
 */
export class EngineUnavailableError extends Error {
  public readonly code = "ENGINE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

export const MANAGED_MODEL_FILES = {
  worker: "Cyber-Tiel-Coder-35B-A3B-GGUF-MTP/Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
  researcher: "Apodex-1.1-mini-GGUF/Apodex-1.1-mini-IQ3_M.gguf",
  planner: "Dirk-Qwen3.8-27B-GGUF/Dirk-Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf",
} as const;

/**
 * Prompt-cache settings sized to the host (M17).
 *
 * llama-server's own default `--cache-ram` is 8192 MiB: on a 24 GB host that
 * already holds a 12-14 GB checkpoint, an 8 GB host-side prompt cache is the
 * difference between a warm cache and swap. CHRONICLE §2 fixes 2048 MiB and
 * 6 context checkpoints for the 24 GB M4; larger hosts get more of both.
 * Checkpoints are what let a hybrid-attention (SWA/recurrent) model reuse a
 * prefix at all: without one near the divergence point the server re-reads
 * the whole prompt.
 */
export interface CacheProfile {
  /** `--cache-ram`, MiB. 0 disables the host-side prompt cache. */
  cacheRamMiB: number;
  /** `--ctx-checkpoints` per slot. */
  ctxCheckpoints: number;
  /**
   * `-sps`: how closely a prompt must match a slot's cached prompt to be
   * routed to it. Only meaningful with more than one slot.
   */
  slotPromptSimilarity: number;
}

export function cacheProfileForHost(totalBytes: number = totalmem()): CacheProfile {
  const gb = totalBytes / 1024 ** 3;
  if (gb <= 32) return { cacheRamMiB: 2048, ctxCheckpoints: 6, slotPromptSimilarity: 0.5 };
  if (gb <= 64) return { cacheRamMiB: 4096, ctxCheckpoints: 8, slotPromptSimilarity: 0.5 };
  return { cacheRamMiB: 8192, ctxCheckpoints: 16, slotPromptSimilarity: 0.5 };
}

export interface LlamaServerProfile {
  /** Model id reported to the harness (used in evidence and reports). */
  modelId: string;
  /** Absolute path to the GGUF. */
  modelPath: string;
  /** The multimodal projector (`--mmproj`) for a vision model (X3). */
  mmprojPath?: string;
  binary?: string;
  port?: number;
  contextTokens?: number;
  /**
   * KV cache precision. 4-bit is prohibited for tool-calling models (design
   * §572); below 8 bits needs `qualifiedBelow8BitKv` (M16). Checked against
   * the final argv, `extraArgs` included.
   */
  kvType?: "f16" | "q8_0" | (string & {});
  /** The model calls tools (default true); only then is 4-bit KV refused. */
  toolCalling?: boolean;
  /** The model passed qualification with a KV type below 8 bits. */
  qualifiedBelow8BitKv?: boolean;
  /** Grammar-constrained tool calls (M8); see `HttpAdapterOptions`. */
  constrainedToolCalls?: boolean;
  /** Measured tool arm (M9). */
  preferredToolArm?: ToolCallFormat;
  /**
   * The model registry (M11, M12). Also decides MTP when it holds a
   * speculative-decoding measurement for this model on this host (M19).
   */
  registry?: ModelRegistry;
  /**
   * The model has a grafted multi-token-prediction head, so speculative
   * decoding can be measured. Whether a launch uses it is the registry's
   * recorded decision for this host and thinking policy (MD-M7-1), never
   * this flag.
   */
  mtp?: boolean;
  /** The thinking policy this launch runs under (default "off"); MTP decisions are per policy. */
  thinkingPolicy?: ThinkingPolicy;
  /**
   * A draft model for speculative decoding (`-md`, MD-N8-5). Used only when
   * the registry records a decision for this draft model, this host and this
   * thinking policy that enables it, and this combination has qualified with
   * it; then the MTP head is not used (one speculative method per launch).
   */
  draftModelPath?: string;
  /** The draft model's id in decisions and qualifications; default: its file name without `.gguf`. */
  draftModelId?: string;
  /** `--draft-max`: tokens drafted per step with a draft model. Unset leaves the server's default. */
  draftMaxTokens?: number;
  /**
   * How long an adopted server's `/props` check stands before it is read
   * again (default 60 s): another process may have restarted the server on
   * this port with other settings in the meantime.
   */
  propsRecheckMs?: number;
  /**
   * Measurement probes only: force speculative decoding on or off, ignoring
   * the recorded decision, so an A/B can measure both sides.
   */
  speculativeOverride?: boolean;
  /**
   * Directory for KV-cache slot files. When set, the slot is saved before the
   * server is stopped for a model swap and restored after it restarts, so the
   * shared prompt prefix is not re-read (research report 2: cache loss on
   * swaps is the dominant swap cost; llama.cpp --slot-save-path).
   */
  slotCacheDir?: string;
  /**
   * The slot-restore equivalence check has passed on a calibration night
   * (measurement rule 16d); until then a card's live slot is re-prefilled.
   */
  slotEquivalencePassed?: boolean;
  /** The weights' recorded SHA-256, keying slot files (rule 20i); unset: a fingerprint of the file. */
  weightsSha256?: string;
  /** `-t`: CPU threads. Unset leaves the server's default. */
  threads?: number;
  /** `-ngl`: layers offloaded to the GPU. Default 99 (all). */
  gpuLayers?: number;
  /** `-np`: server slots. Default 1. `-c` is `contextTokens`, shared by the slots. */
  parallel?: number;
  /**
   * `-np N` with every slot keeping the full `contextTokens` window: the
   * server gets `-c contextTokens*N`. Requests pick a slot with
   * `InferenceRequest.slot` (llama-server `id_slot`), so a short side call
   * (an extraction) never evicts the long conversation's prefix. Takes
   * precedence over `parallel`.
   */
  parallelSlots?: number;
  /**
   * Prompt-cache flags (M17). Unset uses `cacheProfileForHost()`; `false`
   * leaves every cache flag to the server's defaults.
   */
  cache?:
    | (Partial<Omit<CacheProfile, "slotPromptSimilarity">> & {
        /** `"server-default"` passes no `-sps`. */
        slotPromptSimilarity?: number | "server-default";
      })
    | false;
  /** `--metrics`: the Prometheus endpoint, for cache and throughput telemetry. */
  metrics?: boolean;
  /** `--no-webui` when false. */
  webui?: boolean;
  /**
   * `--reasoning`. `off` forbids thinking at the server; leave it unset (or
   * `auto`) when requests should be able to turn reasoning on (M6).
   */
  reasoning?: "on" | "off" | "auto";
  extraArgs?: string[];
  sampling?: HttpAdapterOptions["sampling"];
  /** Send tool schemas natively (default true). */
  nativeTools?: boolean;
  /** Sampling for `purpose: "planning"` requests (M5). */
  planningSampling?: HttpAdapterOptions["sampling"];
  maxTokens?: number;
  /** Ollama endpoint to evict models from before loading. */
  ollamaBaseUrl?: string;
  startupTimeoutMs?: number;
  /** The machine-wide model lease (MD-N17-1); default `<user dir>/model.lock`. */
  modelLeasePath?: string;
  /** How long a start waits for another process's model lease (MD-N17-2); default 30 minutes. */
  modelLeaseWaitMs?: number;
  /** Told once which project holds which model when a start must wait; default the standard error. */
  onModelLeaseWait?: (line: string) => void;
}

/** A live session on a server slot (rule 20i). */
interface LiveSession {
  slot: number;
  owner: string;
  kind: "thread" | "live_card";
  sources?: string[];
  promptTokens: number;
  /** R: the prompt at the measured prefill speed. */
  reprefillMs?: number;
}

/** KV bytes per token, for K before a slot's first save (hybrid MoE, q8_0; as `footprintBytes`). */
const KV_BYTES_PER_TOKEN = 64 * 1024;

/** llama.cpp's Metal command-buffer timeout, in its log or a failed request (MD-N14-33). */
const METAL_TIMEOUT =
  /kIOGPUCommandBufferCallbackErrorTimeout|GPU Timeout Error|command buffer \d+ failed with status/i;

/**
 * A fingerprint of a weights file for slot keys where no SHA-256 is
 * recorded: its size and the SHA-256 of its first and last MiB. Hashing
 * 13 GB on every swap would cost more than the slot saves.
 */
export async function weightsFingerprint(path: string): Promise<string> {
  const h = createHash("sha256");
  if (!existsSync(path)) return h.update(`missing:${path}`).digest("hex");
  const size = statSync(path).size;
  h.update(`size:${size}`);
  const handle = await open(path, "r");
  try {
    const mib = 1024 ** 2;
    const buf = Buffer.alloc(Math.min(mib, size));
    await handle.read(buf, 0, buf.length, 0);
    h.update(buf);
    if (size > mib) {
      await handle.read(buf, 0, buf.length, size - buf.length);
      h.update(buf);
    }
  } finally {
    await handle.close();
  }
  return h.digest("hex");
}

/**
 * Evict every model Ollama holds.
 *
 * Only one model fits on the 24GB reference machine. llama-server and Ollama
 * are separate processes that know nothing of each other, so starting one
 * while the other holds a 13.7GB checkpoint is how the host ran out of memory.
 */
export async function evictOllamaModels(baseUrl = "http://127.0.0.1:11434"): Promise<string[]> {
  const evicted: string[] = [];
  try {
    const res = await fetch(`${baseUrl}/api/ps`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return evicted;
    const body = (await res.json()) as { models?: { name: string }[] };
    for (const model of body.models ?? []) {
      await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.name, keep_alive: 0 }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
      evicted.push(model.name);
    }
  } catch {
    // Ollama not running: nothing to evict.
  }
  return evicted;
}

/** What a running llama-server reports about itself (`GET /props`, MD-M4-1/3). */
export interface ServerProps {
  modelPath?: string;
  /** Per-slot context (`default_generation_settings.n_ctx`). */
  contextTokens?: number;
  /** Speculative decoding on (`default_generation_settings.speculative`). */
  mtp?: boolean;
  build?: string;
}

/**
 * A llama-server process owned by the harness, exposed as an inference adapter.
 *
 * `unload()` stops the process, which is the only way to release a
 * llama-server model; that lets the ModelRouter treat it like any other role.
 * Needed for models whose features Ollama cannot use, such as a grafted MTP
 * speculative-decoding head (`--spec-type draft-mtp`).
 */
export class ManagedLlamaServerAdapter extends HttpInferenceAdapter {
  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private readonly url: string;
  private mtpSuspended = false;
  /** When the running server was last checked against this profile (MD-M4-1); undefined: not adopted. */
  private adoptedAt: number | undefined;
  /** The last start this adapter made, and whether a reply has reported it yet (MS-T7-1). */
  private lastStartup: { spawnToHealthyMs: number; at: string } | undefined;
  private startupUnreported = false;
  /** The options of the load in progress (rule 20h): its load mode and `--cache-ram`. */
  private loadOptions: LoadOptions = {};
  /** The engine (rule 20h). */
  public override readonly engine = "llama.cpp" as const;

  constructor(private profile: LlamaServerProfile) {
    const port = profile.port ?? 8098;
    super({
      modelId: profile.modelId,
      baseUrl: `http://127.0.0.1:${port}`,
      apiFormat: "openai",
      // The window one request gets: `-c` is shared across `-np` slots.
      contextTokens:
        profile.parallelSlots !== undefined
          ? (profile.contextTokens ?? 8192)
          : Math.floor((profile.contextTokens ?? 8192) / (profile.parallel ?? 1)),
      maxTokens: profile.maxTokens ?? 2048,
      disableReasoning: true,
      ...(profile.sampling ? { sampling: profile.sampling } : {}),
      ...(profile.planningSampling ? { planningSampling: profile.planningSampling } : {}),
      ...(profile.nativeTools !== undefined ? { nativeTools: profile.nativeTools } : {}),
      ...(profile.constrainedToolCalls !== undefined
        ? { constrainedToolCalls: profile.constrainedToolCalls }
        : {}),
      ...(profile.preferredToolArm ? { preferredToolArm: profile.preferredToolArm } : {}),
      ...(profile.registry ? { registry: profile.registry } : {}),
    });
    this.url = `http://127.0.0.1:${port}`;
  }

  /** The launch profile, for doctor and the Machine view. */
  public get launchProfile(): Readonly<LlamaServerProfile> {
    return this.profile;
  }

  /**
   * Suspend (or restore) the MTP head. A memory-watchdog action (M20): the
   * draft head costs memory, and the change applies at the next launch,
   * because llama-server cannot drop it from a running process.
   */
  public setMtpSuspended(suspended: boolean): void {
    this.mtpSuspended = suspended;
  }

  public get isMtpSuspended(): boolean {
    return this.mtpSuspended;
  }

  /**
   * Whether this launch uses the MTP head: only when the registry records a
   * decision for this model, this host and this thinking policy that enables
   * it (MD-M7-1/2, models rule 13: off until measured); never while the
   * watchdog has it suspended (M20). A measurement probe forces it.
   */
  public mtpEnabled(): boolean {
    if (this.mtpSuspended || this.profile.draftModelPath) return false;
    if (this.profile.speculativeOverride !== undefined) return this.profile.speculativeOverride;
    return this.speculativeStatusFor("mtp").enabled;
  }

  /**
   * The launch's elements of a qualification combination (rule 27a): the
   * per-request window, KV type, speculative decoding, prefix caching and
   * slots. The caller adds the engine and model builds, the host, the chat
   * template and the context version.
   */
  public launchSettings(): {
    contextTokens: number;
    kvType: string;
    speculative: SpeculativeSetting;
    prefixCaching: boolean;
    parallelSlots: number;
  } {
    return {
      contextTokens: this.contextWindow?.contextTokens ?? this.profile.contextTokens ?? 8192,
      kvType: this.profile.kvType ?? "q8_0",
      speculative: this.speculativeSetting(),
      prefixCaching: this.cacheSettings() !== undefined,
      parallelSlots: this.slotCount(),
    };
  }

  /** The draft model's id (MD-N8-5), when one is configured. */
  public draftModelId(): string | undefined {
    const p = this.profile.draftModelPath;
    return p ? (this.profile.draftModelId ?? basename(p).replace(/\.gguf$/i, "")) : undefined;
  }

  /** Whether this launch uses the draft model: the same two conditions as MTP (MD-N8-5). */
  public draftEnabled(): boolean {
    const draft = this.draftModelId();
    if (!draft || this.mtpSuspended) return false;
    if (this.profile.speculativeOverride !== undefined) return this.profile.speculativeOverride;
    return this.speculativeStatusFor({ draft }).enabled;
  }

  /** The speculative decoding this launch uses, as a qualification combination names it. */
  public speculativeSetting(): SpeculativeSetting {
    const draft = this.draftModelId();
    if (draft) return this.draftEnabled() ? { draft } : "off";
    return this.mtpEnabled() ? "mtp" : "off";
  }

  /** Whether the configured speculative method is on, and why (for doctor and the run's log). */
  public speculativeStatus(): { enabled: boolean; reason: string } {
    const draft = this.draftModelId();
    return this.speculativeStatusFor(draft ? { draft } : "mtp");
  }

  /**
   * Both must allow speculation (models rule 13, MD-M7-1/2, MD-N8-2): the
   * speed decision recorded for this model, method, host and thinking
   * policy, and a qualification of this combination with the method on and
   * prefix caching on whose tool-call checks passed.
   */
  private speculativeStatusFor(method: Exclude<SpeculativeSetting, "off">): {
    enabled: boolean;
    reason: string;
  } {
    const label = method === "mtp" ? "MTP" : `draft model ${method.draft}`;
    const policy = this.profile.thinkingPolicy ?? thinkingPolicyFromEnv();
    const entry = this.registry?.get(this.profile.modelId);
    const decision =
      method === "mtp"
        ? entry?.speculativeByPolicy?.[policy]
        : entry?.speculativeByDraft?.[method.draft]?.[policy];
    const host = hostFingerprintHash();
    if (!decision || decision.fingerprint !== host) {
      return { enabled: false, reason: `${label} not measured on this host (thinking ${policy})` };
    }
    if (!decision.enabled) return { enabled: false, reason: decision.reason };
    const q = this.registry?.speculativeQualification(this.profile.modelId, {
      host,
      speculative: method,
      ...(this.contextWindow ? { contextTokens: this.contextWindow.contextTokens } : {}),
      kvType: this.profile.kvType ?? "q8_0",
      parallelSlots: this.slotCount(),
    });
    if (!q || this.cacheSettings() === undefined) {
      return {
        enabled: false,
        reason: `not qualified with ${label} on and prefix caching on for this launch`,
      };
    }
    if (q.status !== "qualified" || q.toolCallChecks === false) {
      return { enabled: false, reason: q.reason ?? `${label} failed its qualification` };
    }
    return { enabled: true, reason: decision.reason };
  }

  /** The cache flags this launch uses, after the host default. */
  public cacheSettings():
    | (Omit<CacheProfile, "slotPromptSimilarity"> & { slotPromptSimilarity?: number })
    | undefined {
    const cache = this.profile.cache;
    if (cache === false) return undefined;
    const host = cacheProfileForHost();
    const sps = cache?.slotPromptSimilarity ?? host.slotPromptSimilarity;
    return {
      cacheRamMiB: cache?.cacheRamMiB ?? host.cacheRamMiB,
      ctxCheckpoints: cache?.ctxCheckpoints ?? host.ctxCheckpoints,
      ...(sps === "server-default" ? {} : { slotPromptSimilarity: sps }),
    };
  }

  /**
   * The argv the server is launched with; exposed for doctor and tests.
   * Throws `KvPolicyError` when the KV type breaks the policy (M16), so a
   * forbidden launch never starts.
   */
  public launchArgs(options: LoadOptions = {}): string[] {
    const args = this.buildLaunchArgs(options);
    assertKvPolicy(args, {
      toolCalling: this.profile.toolCalling !== false,
      qualifiedBelow8Bit: this.profile.qualifiedBelow8BitKv === true,
    });
    // Rule 20h: no --mlock (it crashes on macOS) and no direct I/O.
    assertLaunchFlags(args);
    return args;
  }

  /** `id_slot` goes only to a server with several slots (rule 16c). */
  protected override sendsSlot(): boolean {
    return this.slotCount() > 1;
  }

  /** Server slots (`-np`). */
  public slotCount(): number {
    return Math.max(1, this.profile.parallelSlots ?? this.profile.parallel ?? 1);
  }

  /** The server's total context (`-c`). */
  public totalContextTokens(): number {
    // MD-N4-2: a per-request window set in the registry sizes the launch.
    const registered = this.registry?.get(this.profile.modelId)?.contextWindow;
    if (registered !== undefined) return registered * this.slotCount();
    const ctx = this.profile.contextTokens ?? 8192;
    return this.profile.parallelSlots !== undefined ? ctx * this.slotCount() : ctx;
  }

  private buildLaunchArgs(options: LoadOptions = {}): string[] {
    const p = this.profile;
    const parallel = this.slotCount();
    const settings = this.cacheSettings();
    // Rule 20h: `--cache-ram` sized from the headroom when the scheduler says so.
    const cache =
      options.cacheRamMiB === undefined
        ? settings
        : {
            ...(settings ?? { ctxCheckpoints: cacheProfileForHost().ctxCheckpoints }),
            cacheRamMiB: options.cacheRamMiB,
          };
    return [
      "-m",
      p.modelPath,
      ...(p.mmprojPath ? ["--mmproj", p.mmprojPath] : []),
      "--host",
      "127.0.0.1",
      "--port",
      String(p.port ?? 8098),
      ...(p.threads !== undefined ? ["-t", String(p.threads)] : []),
      "-ngl",
      String(p.gpuLayers ?? 99),
      "-fa",
      "on",
      "--jinja",
      "-c",
      String(this.totalContextTokens()),
      "-ctk",
      p.kvType ?? "q8_0",
      "-ctv",
      p.kvType ?? "q8_0",
      "-np",
      String(parallel),
      ...(cache
        ? [
            "--cache-ram",
            String(cache.cacheRamMiB),
            "--ctx-checkpoints",
            String(cache.ctxCheckpoints),
            // Slot routing by prompt similarity only matters with several slots.
            ...(parallel > 1 && cache.slotPromptSimilarity !== undefined
              ? ["-sps", String(cache.slotPromptSimilarity)]
              : []),
          ]
        : []),
      ...(p.metrics ? ["--metrics"] : []),
      ...(p.webui === false ? ["--no-webui"] : []),
      ...(p.reasoning ? ["--reasoning", p.reasoning] : []),
      // One draft token at p-min 0.0: the model card's own sweep puts its peak there (MD-M7-2, DEC-42).
      ...(this.mtpEnabled()
        ? ["--spec-type", "draft-mtp", "--spec-draft-n-max", "1", "--spec-draft-p-min", "0.0"]
        : []),
      // A draft model (MD-N8-5), all its layers on the GPU like the main model's.
      ...(this.draftEnabled() && p.draftModelPath
        ? [
            "-md",
            p.draftModelPath,
            "-ngld",
            String(p.gpuLayers ?? 99),
            ...(p.draftMaxTokens !== undefined ? ["--draft-max", String(p.draftMaxTokens)] : []),
          ]
        : []),
      ...(p.slotCacheDir ? ["--slot-save-path", p.slotCacheDir] : []),
      ...loadModeArgs(options.loadMode),
      ...(p.extraArgs ?? []),
    ];
  }

  /**
   * Erase every slot's KV cache (a watchdog action, M20). The server keeps
   * running; the next request pays a cold prefill. Returns the slots erased.
   */
  public async trimCache(): Promise<number> {
    if (!(await this.healthy())) return 0;
    let erased = 0;
    for (let slot = 0; slot < this.slotCount(); slot++) {
      try {
        const res = await fetch(`${this.url}/slots/${slot}?action=erase`, {
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) erased++;
      } catch {
        // Best effort.
      }
    }
    return erased;
  }

  /**
   * Health contract (M4). A running server is ok and loaded. A stopped one
   * is ok (not loaded) only when it can be started: the model file exists
   * and the launch argv passes the KV policy.
   */
  public override async healthCheck(): Promise<AdapterHealth> {
    const start = Date.now();
    const base = { modelId: this.profile.modelId };
    if (await this.healthy()) {
      return { ...base, ok: true, reachable: true, loaded: true, latencyMs: Date.now() - start };
    }
    let detail: string | undefined;
    if (!existsSync(this.profile.modelPath)) {
      detail = `model file not found: ${this.profile.modelPath}`;
    } else {
      try {
        this.launchArgs();
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      ...base,
      ok: detail === undefined,
      reachable: false,
      loaded: false,
      latencyMs: Date.now() - start,
      ...(detail ? { detail } : { detail: "server stopped; starts on first request" }),
    };
  }

  private async healthy(): Promise<boolean> {
    return (await this.healthState()) === "ok";
  }

  /** `/health`: ok, still loading (503), or nothing listening / another error. */
  private async healthState(): Promise<"ok" | "loading" | "down"> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? "ok" : res.status === 503 ? "loading" : "down";
    } catch {
      return "down";
    }
  }

  /**
   * What the server on this port reports about itself (`GET /props`): the
   * loaded model, the per-slot context, whether speculative decoding is on
   * and the build. Undefined fields are ones the server did not report.
   */
  public async serverProps(): Promise<ServerProps | undefined> {
    const props = await this.readServerProps();
    if (props?.build !== undefined) this.lastReportedBuild = props.build;
    return props;
  }

  /**
   * The build the running server last reported on `/props` (`build_info`),
   * for a record that prefers the engine's own word to `llama-server
   * --version`; undefined until `serverProps()` has read one.
   */
  public get reportedBuild(): string | undefined {
    return this.lastReportedBuild;
  }

  private lastReportedBuild: string | undefined;

  private async readServerProps(): Promise<ServerProps | undefined> {
    try {
      const res = await fetch(`${this.url}/props`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return undefined;
      const p = (await res.json()) as {
        model_path?: unknown;
        build_info?: unknown;
        default_generation_settings?: { n_ctx?: unknown; speculative?: unknown };
      };
      const g = p.default_generation_settings ?? {};
      return {
        ...(typeof p.model_path === "string" ? { modelPath: p.model_path } : {}),
        ...(typeof g.n_ctx === "number" ? { contextTokens: g.n_ctx } : {}),
        ...(typeof g.speculative === "boolean" ? { mtp: g.speculative } : {}),
        ...(typeof p.build_info === "string" ? { build: p.build_info } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Why the server already on this port is not ours, or undefined when it
   * is (MD-M4-1): another model, another per-slot context, or another MTP
   * state than this launch would use. A server that does not say which
   * model it runs is not adopted either.
   */
  private async foreignServer(): Promise<string | undefined> {
    const props = await this.serverProps();
    const port = this.profile.port ?? 8098;
    if (props?.modelPath === undefined)
      return `the server on port ${port} does not report its model (/props); refusing to adopt it`;
    if (!samePath(props.modelPath, this.profile.modelPath))
      return `port ${port} is serving ${props.modelPath}, not ${this.profile.modelPath}; stop that server or use another port`;
    // The per-slot window, or, with a unified KV cache, the total across
    // slots: llama.cpp reports either as n_ctx (checked against b10809 live
    // before relying on it, models.md State).
    const want = this.contextWindow?.contextTokens;
    const total = this.totalContextTokens();
    if (
      props.contextTokens !== undefined &&
      props.contextTokens !== want &&
      props.contextTokens !== total
    )
      return `port ${port} is serving ${this.profile.modelId} with context ${props.contextTokens}, not ${want}${total !== want ? ` (or ${total} across its slots)` : ""}; restart it with this profile`;
    // A probe that forces the speculative method must know the server runs it
    // that way: a server that does not say is not adopted (M11).
    if (this.profile.speculativeOverride !== undefined && props.mtp === undefined)
      return `the server on port ${port} does not report its MTP state (/props); a speculative probe cannot adopt it: stop it first`;
    if (props.mtp !== undefined && props.mtp !== this.mtpEnabled())
      return `port ${port} is serving ${this.profile.modelId} with MTP ${props.mtp ? "on" : "off"}, but this launch uses it ${this.mtpEnabled() ? "on" : "off"}; restart it with this profile`;
    return undefined;
  }

  /**
   * Record the running model's quantisation from its GGUF header when the
   * registry does not have it yet (MD-M4-5; SEC-37b keys on it).
   */
  private async recordQuantisation(): Promise<void> {
    if (!this.registry || this.registry.get(this.profile.modelId)?.quant) return;
    const quant = await readQuantisation(this.profile.modelPath);
    if (quant) this.registry.upsert(this.profile.modelId, { quant });
  }

  /** Adopt a running server only once it has shown it is ours, and again once that check is stale. */
  private async adopt(): Promise<void> {
    const recheck = this.profile.propsRecheckMs ?? 60_000;
    if (this.adoptedAt !== undefined && Date.now() - this.adoptedAt < recheck) return;
    this.adoptedAt = undefined;
    const why = await this.foreignServer();
    if (why) throw new Error(why);
    this.holdAdoptedLease();
    this.adoptedAt = Date.now();
    await this.recordQuantisation();
  }

  /** The lease this adapter took for a server it adopted (MD-N17-5), until its unload. */
  private adoptedLease: (() => void) | undefined;

  /**
   * MD-N17-5: a server this adapter adopted — one a person started on its
   * port, the way this host runs its Worker — is a model resident on the
   * machine, so the adopting process takes the model lease for it when the
   * lease is free, and another project's load of another model waits. Held
   * by another process, the lease is left as it is: its holder answers for
   * what it loaded, and the same profile attaches as before.
   */
  private holdAdoptedLease(): void {
    if (this.adoptedLease || this.child) return;
    const got = tryModelLease(
      { model: this.profile.modelId, port: this.profile.port ?? 8098 },
      this.profile.modelLeasePath ?? modelLeasePath(),
    );
    if ("release" in got) this.adoptedLease = got.release;
  }

  /**
   * Start the server if needed and wait until it reports healthy. `signal`
   * aborts a start in flight: the process this adapter spawned is killed and
   * the promise rejects (the residency scheduler's `releaseAll`).
   */
  public async ensureRunning(signal?: AbortSignal): Promise<void> {
    const aborted = () => new Error("llama-server load aborted");
    if (signal?.aborted) throw aborted();
    let state = await this.healthState();
    if (state === "loading") {
      // A server still loading answers 503: wait for it rather than starting
      // a second one on the same port (A10).
      const deadline = Date.now() + (this.profile.startupTimeoutMs ?? 600_000);
      while (state === "loading" && Date.now() < deadline) {
        if (signal?.aborted) throw aborted();
        await new Promise((r) => setTimeout(r, 250));
        state = await this.healthState();
      }
      if (state === "loading")
        throw new Error(
          `the server on port ${this.profile.port ?? 8098} is still loading after ${Math.round((this.profile.startupTimeoutMs ?? 600_000) / 1000)} s`,
        );
    }
    if (state === "ok") return this.adopt();
    this.adoptedAt = undefined;
    // An abort kills the process this adapter is starting, whoever started it.
    const kill = () => {
      if (this.child && this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", kill, { once: true });
    try {
      await (this.starting ?? this.start(signal));
    } catch (err) {
      if (signal?.aborted) throw aborted();
      throw err;
    } finally {
      signal?.removeEventListener("abort", kill);
    }
    if (signal?.aborted) throw aborted();
  }

  private start(signal?: AbortSignal): Promise<void> {
    this.starting = (async () => {
      // Rule 20h: a disconnected drive is refused and its work stays queued.
      const drive = await checkDrive(this.profile.modelPath);
      if (drive.state === "disconnected")
        throw new DriveUnavailableError(
          `Refusing to load ${this.profile.modelId}: ${drive.reason}`,
        );
      if (!existsSync(this.profile.modelPath)) {
        throw new EngineUnavailableError(`Model file not found: ${this.profile.modelPath}`);
      }
      const options = this.loadOptions;
      const args = this.launchArgs(options);
      // MD-N17-1, MD-N17-2: the machine-wide model lease, before anything is
      // evicted or loaded, kept while this server runs. Held by another
      // process, the start attaches to an engine already serving this exact
      // profile, or waits and says which project holds which model.
      const lease = await acquireModelLease(
        { model: this.profile.modelId, port: this.profile.port ?? 8098 },
        {
          ...(this.profile.modelLeasePath ? { path: this.profile.modelLeasePath } : {}),
          ...(this.profile.modelLeaseWaitMs !== undefined
            ? { waitMs: this.profile.modelLeaseWaitMs }
            : {}),
          ...(this.profile.onModelLeaseWait ? { onWait: this.profile.onModelLeaseWait } : {}),
          ...(signal ? { signal } : {}),
          attach: async () =>
            (await this.healthState()) === "ok" && (await this.foreignServer()) === undefined,
        },
      );
      if ("attached" in lease) {
        this.adoptedAt = Date.now();
        await this.recordQuantisation();
        return;
      }
      // Given up when the server this start spawns exits (an unload, a crash),
      // or now when nothing was spawned.
      let spawned = false;
      try {
        await this.spawnHeld(options, args, signal, lease.release, () => {
          spawned = true;
        });
      } catch (err) {
        if (!spawned) lease.release();
        throw err;
      }
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  /** The start's spawn and health wait, under the model lease `release` gives up. */
  private async spawnHeld(
    options: LoadOptions,
    args: string[],
    signal: AbortSignal | undefined,
    release: () => void,
    onSpawn: () => void,
  ): Promise<void> {
    await evictOllamaModels(this.profile.ollamaBaseUrl);
    if (this.profile.slotCacheDir) mkdirSync(this.profile.slotCacheDir, { recursive: true });
    if (signal?.aborted) throw new Error("llama-server load aborted");

    const spawnedAt = Date.now();
    // Rule 20h: a sequential pre-read puts the weights in the file cache before mmap reads them.
    if (options.loadMode === "preread_mmap")
      await prereadSequential(this.profile.modelPath, signal ? { signal } : {});
    this.metalReported = false;
    // Rule 6b, MD-N19-5: the profile's binary, else the one resolution order;
    // the guard judges the program that would start.
    const binary = this.profile.binary ?? llamaServerBinary();
    assertModelLoadAllowed({ binary });
    this.child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    onSpawn();
    // The weights stay resident until this process exits: the lease with them.
    this.child.once("exit", release);
    this.child.once("error", release);
    this.bindToParentLifetime(this.child);
    let stderr = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4000);
      // MD-N14-33: the server's log shows a Metal command-buffer timeout.
      this.noteMetalTimeout(text);
    });

    const deadline = Date.now() + (this.profile.startupTimeoutMs ?? 600_000);
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new EngineUnavailableError(
          `llama-server exited during startup: ${stderr.slice(-800)}`,
        );
      }
      if (await this.healthy()) {
        // MS-T7-1: the load, apart from the cards' time.
        this.lastStartup = {
          spawnToHealthyMs: Date.now() - spawnedAt,
          at: new Date(spawnedAt).toISOString(),
        };
        this.startupUnreported = true;
        await this.refuseShrunkContext();
        await this.restoreLiveSlots();
        this.adoptedAt = Date.now();
        await this.recordQuantisation();
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new EngineUnavailableError(
      `llama-server did not become healthy in time: ${stderr.slice(-800)}`,
    );
  }

  public override async generate(
    ...args: Parameters<HttpInferenceAdapter["generate"]>
  ): ReturnType<HttpInferenceAdapter["generate"]> {
    await this.ensureRunning();
    let response: Awaited<ReturnType<HttpInferenceAdapter["generate"]>>;
    try {
      response = await super.generate(...args);
    } catch (err) {
      // MD-N14-33: a request that failed on a Metal command-buffer timeout.
      this.noteMetalTimeout(err instanceof Error ? err.message : String(err));
      throw err;
    }
    const [req] = args;
    if (req.session) this.trackSession(req, response.usage);
    if (this.startupUnreported && this.lastStartup) {
      this.startupUnreported = false;
      return {
        ...response,
        usage: { ...response.usage, spawnToHealthyMs: this.lastStartup.spawnToHealthyMs },
      };
    }
    return response;
  }

  /** The last start this adapter made: from spawn to the first healthy `/health` (MS-T7-1). */
  public get startup(): { spawnToHealthyMs: number; at: string } | undefined {
    return this.lastStartup;
  }

  /**
   * Take the server down with the harness process.
   *
   * A harness killed mid-run (Ctrl+C, a supervisor's SIGTERM) otherwise leaves
   * an orphaned llama-server holding the full checkpoint in memory — on this
   * host, 13GB that nothing will ever release.
   */
  private bindToParentLifetime(child: ChildProcess): void {
    const kill = (): void => {
      if (child.exitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };
    process.once("exit", kill);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        kill();
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      });
    }
    child.once("exit", () => process.removeListener("exit", kill));
  }

  /**
   * Load now (models rule 20c, MD-N14-1): start the server and wait until it
   * is healthy. A server already up, or one another start is loading, is
   * adopted: this adapter did not order that load.
   */
  public override async load(
    signal?: AbortSignal,
    options: LoadOptions = {},
  ): Promise<"loaded" | "adopted"> {
    const before = await this.healthState();
    this.loadOptions = options;
    try {
      await this.ensureRunning(signal);
    } finally {
      this.loadOptions = {};
    }
    return before === "down" ? "loaded" : "adopted";
  }

  /**
   * Refuse a server this adapter started whose served context is smaller
   * than requested: `--fit` shrinks it silently (rule 20h, MD-M4-1). The
   * server is stopped and the start rejects.
   */
  private async refuseShrunkContext(): Promise<void> {
    const served = (await this.serverProps())?.contextTokens;
    const want = this.contextWindow?.contextTokens;
    const total = this.totalContextTokens();
    if (served === undefined || want === undefined || served === want || served === total) return;
    try {
      assertServedContext(Math.min(want, total), served);
    } catch (err) {
      this.child?.kill("SIGKILL");
      throw err;
    }
  }

  /** The weights file and its bytes, for Smart Swap's record; undefined when it is missing. */
  public override async weightsSource(): Promise<{ path: string; bytes: number } | undefined> {
    if (!existsSync(this.profile.modelPath)) return undefined;
    return { path: this.profile.modelPath, bytes: statSync(this.profile.modelPath).size };
  }

  /** Weights on disk, plus the KV cache for its context and runtime overhead. */
  public async footprintBytes(): Promise<number | undefined> {
    if (!existsSync(this.profile.modelPath)) return undefined;
    const weights = statSync(this.profile.modelPath).size;
    const kv = this.totalContextTokens() * 64 * 1024; // hybrid MoE, q8_0: small
    return Math.round(weights * 1.03 + kv + 1.2 * 1024 ** 3);
  }

  private slots: SlotStore | undefined;
  /** The ledger's erasures (rule 20i, MD-N14-37): swept before every restore. */
  private erasures: (() => ErasureView) | undefined;
  /** Whether this server's Metal timeout has been signalled (once per start). */
  private metalReported = false;
  /** The live session on each slot (rule 20i): Seshat's thread, a card's attempt. */
  private readonly sessions = new Map<number, LiveSession>();
  /** Sessions saved at the last unload, restored or re-prefilled at the next start. */
  private pendingSessions: LiveSession[] = [];
  private restoredLast: { owner: string; slot: number; action: string; reason?: string }[] = [];

  private noteMetalTimeout(text: string): void {
    const m = METAL_TIMEOUT.exec(text);
    if (!m || this.metalReported) return;
    this.metalReported = true;
    this.signal({ kind: "metal_timeout", detail: m[0] });
  }

  private trackSession(req: InferenceRequest, usage: TokenUsage): void {
    const session = req.session;
    if (!session) return;
    const slot = req.slot ?? 0;
    const prev = this.sessions.get(slot);
    const same = prev?.owner === session.owner;
    // Unknown sources stay unknown: any erasure then deletes the slot.
    const sources =
      session.sources === undefined || (same && prev?.sources === undefined)
        ? undefined
        : [...new Set([...(same ? (prev?.sources ?? []) : []), ...session.sources])];
    const pps = usage.prefillTokensPerSecond;
    this.sessions.set(slot, {
      slot,
      owner: session.owner,
      kind: session.kind,
      ...(sources ? { sources } : {}),
      promptTokens: usage.promptTokens,
      ...(pps ? { reprefillMs: Math.round((usage.promptTokens / pps) * 1000) } : {}),
    });
  }

  /**
   * Save every live slot when the weights leave (rule 20i, MD-N14-36): each
   * session under its owner and kind, when K < R (R: its prompt at the
   * measured prefill speed); slot 0's stable prefix when no session holds it.
   */
  public async saveLiveSlots(): Promise<void> {
    const store = this.slotStore();
    const live = [...this.sessions.values()];
    this.sessions.clear();
    this.pendingSessions = [];
    if (!store) return;
    let key: SlotKey;
    try {
      key = await this.slotKey();
    } catch {
      return;
    }
    for (const s of live) {
      const common = {
        slot: s.slot,
        kind: s.kind,
        owner: s.owner,
        key,
        ...(s.sources ? { sources: s.sources } : {}),
        // Held from the cap while this process lives: restored on return (MD-N14-37a).
        hold: true,
      };
      try {
        const saved =
          s.reprefillMs !== undefined
            ? await store.saveIfWorth({
                ...common,
                estimatedBytes: s.promptTokens * KV_BYTES_PER_TOKEN,
                reprefillMs: s.reprefillMs,
              })
            : await store.save(common);
        if (saved) this.pendingSessions.push(s);
      } catch {
        // A slot that cannot be saved is re-prefilled on return.
      }
    }
    if (!live.some((s) => s.slot === 0)) await this.slotAction("save");
  }

  /**
   * On return (rule 20i, MD-N14-36): each saved session is restored into
   * its slot when its key matches and K < R; a card's live slot is
   * re-prefilled until the equivalence check has passed (measurement rule
   * 16d, profile `slotEquivalencePassed`).
   */
  public async restoreLiveSlots(): Promise<void> {
    // The spine (erasure): no slot whose prompt text an erasure covers is restored.
    if (!this.sweepErased()) {
      this.pendingSessions = [];
      this.restoredLast = [];
      return;
    }
    // In slot order: each session returns to the slot it was saved from.
    const pending = [...this.pendingSessions].sort((x, y) => x.slot - y.slot);
    this.pendingSessions = [];
    this.restoredLast = [];
    if (!pending.some((s) => s.slot === 0)) await this.slotAction("restore");
    const store = this.slotStore();
    if (!store || pending.length === 0) return;
    let key: SlotKey;
    try {
      key = await this.slotKey();
    } catch {
      return;
    }
    for (const s of pending) {
      const back = await store.restore({
        slot: s.slot,
        kind: s.kind,
        owner: s.owner,
        key,
        reprefillMs: s.reprefillMs ?? Number.POSITIVE_INFINITY,
        equivalencePassed: this.profile.slotEquivalencePassed === true,
      });
      this.restoredLast.push({
        owner: s.owner,
        slot: s.slot,
        action: back.action,
        ...(back.action === "reprefill" ? { reason: back.reason } : {}),
      });
      if (back.action === "restored") this.sessions.set(s.slot, s);
    }
  }

  /**
   * The ledger's erasure index this adapter sweeps its slot files by before
   * every restore (rule 20i, MD-N14-37); the harness sets it from its ledger.
   */
  public setErasureSource(source: (() => ErasureView) | undefined): void {
    this.erasures = source;
  }

  /**
   * Delete every slot file an erasure covers. False when the index could not
   * be read: then nothing is restored, rather than a slot an erasure covers.
   */
  private sweepErased(): boolean {
    const store = this.slotStore();
    if (!store || !this.erasures) return true;
    try {
      store.sweepErased(this.erasures());
      return true;
    } catch {
      return false;
    }
  }

  /** What the last start did with each saved session: restored, or re-prefilled and why. */
  public restoredSessions(): { owner: string; slot: number; action: string; reason?: string }[] {
    return [...this.restoredLast];
  }

  /** The keyed slot store over `--slot-save-path` (rule 20i); undefined without one. */
  public slotStore(): SlotStore | undefined {
    if (!this.profile.slotCacheDir) return undefined;
    this.slots ??= new SlotStore({
      dir: this.profile.slotCacheDir,
      serverUrl: this.url,
      // The slot directory's read rate is not probed yet: the internal default (MD-N14-4).
      readBytesPerSecond: DEFAULT_READ_BYTES_PER_SECOND.internal,
      // F31, MD-N14-37a: every save prunes the directory to its cap.
      maxBytes: slotCacheMaxBytes(),
    });
    return this.slots;
  }

  /**
   * The key a slot of this server is saved under (rule 20i): the weights'
   * hash (the profile's recorded SHA-256, else a fingerprint of the file's
   * size and first and last MiB), the engine build and chat template the
   * server reports, the context and the KV type.
   */
  public async slotKey(): Promise<SlotKey> {
    const props = await this.serverPropsRaw();
    return {
      weightsHash: this.profile.weightsSha256 ?? (await weightsFingerprint(this.profile.modelPath)),
      engineBuild: props.build ?? "unknown",
      contextTokens: this.totalContextTokens(),
      kvType: this.profile.kvType ?? "q8_0",
      template: createHash("sha256")
        .update(props.template ?? "")
        .digest("hex"),
    };
  }

  /** `/props`' build and chat template, for the slot key. */
  private async serverPropsRaw(): Promise<{ build?: string; template?: string }> {
    try {
      const res = await fetch(`${this.url}/props`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return {};
      const p = (await res.json()) as { build_info?: unknown; chat_template?: unknown };
      return {
        ...(typeof p.build_info === "string" ? { build: p.build_info } : {}),
        ...(typeof p.chat_template === "string" ? { template: p.chat_template } : {}),
      };
    } catch {
      return {};
    }
  }

  /**
   * Save or restore slot 0's stable prefix through the keyed store (rule
   * 20i): a restore happens only for a file saved under the same key. Its
   * sources are unknown, so any erasure deletes it. Best effort: a missing
   * file, another key or a server without slot support costs only a cold
   * prefill.
   */
  public async slotAction(action: "save" | "restore"): Promise<boolean> {
    const store = this.slotStore();
    if (!store) return false;
    try {
      const key = await this.slotKey();
      const slot = { slot: 0, kind: "prefix" as const, owner: this.profile.modelId, key };
      if (action === "save") return (await store.save({ ...slot, hold: true })) !== undefined;
      if (!this.sweepErased()) return false;
      const back = await store.restore({ ...slot, reprefillMs: Number.POSITIVE_INFINITY });
      return back.action === "restored";
    } catch {
      return false;
    }
  }

  /**
   * Why a new launch on this port would measure a server it does not own:
   * something already answers /health there (M11). Undefined when the port is free.
   */
  public async portBusy(): Promise<string | undefined> {
    const state = await this.healthState();
    return state === "ok" || state === "loading"
      ? `a server already answers /health on port ${this.profile.port ?? 8098}`
      : undefined;
  }

  /** Stop the server process, releasing its memory. */
  public override async unload(): Promise<void> {
    // Whatever happens to this server, the next use checks the port again (A9).
    this.adoptedAt = undefined;
    // MD-N17-5: an adopted server's lease goes with the adoption; a server
    // this adapter did not start is left running.
    this.adoptedLease?.();
    this.adoptedLease = undefined;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = undefined;
      return;
    }
    await this.saveLiveSlots();
    this.stopping = child;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = undefined;
  }

  /** The process `unload()` last stopped, until its exit and closed port are seen. */
  private stopping: ChildProcess | undefined;

  /**
   * Whether the server has really gone (MD-N14-2a): the process this adapter
   * stopped has exited and nothing listens on its port any more, polled
   * until `timeoutMs` (default 5 s; 0 checks once). A SIGKILL after the
   * SIGTERM grace resolves `unload()` before the exit is seen, and the
   * memory returns only then; a server this adapter adopted and could not
   * stop is never confirmed.
   */
  public override async confirmUnloaded(timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const port = this.profile.port ?? 8098;
    for (;;) {
      const child = this.stopping;
      const exited = !child || child.exitCode !== null || child.signalCode !== null;
      if (exited && !(await portListening(port))) {
        this.stopping = undefined;
        return true;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(200, left)));
    }
  }
}

/** Whether something accepts a TCP connection on this loopback port (a timeout counts as yes). */
function portListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Cyber-Tiel-Coder 35B-A3B (UD-IQ3_XXS, MTP) as the worker.
 *
 * Settings from the model card's agentic-coding recommendation: temperature
 * 0.6, top_p 0.95, top_k 20, min_p 0. Context stays at 8k rather than the
 * card's 262k: on a 24GB host the KV cache is what decides whether it swaps.
 */
export function createCyberTielWorker(
  // Portable across hosts: the Mac keeps models on an external drive, the
  // Ubuntu AI node on its NVMe. Both point `--models-dir` at their own copy;
  // the file name below is all the harness ships. SEKHEMET_LLAMA_SERVER names
  // the llama-server build (Metal, Vulkan, ROCm).
  modelPath = resolveModelPath(MANAGED_MODEL_FILES.worker),
  binary = process.env.SEKHEMET_LLAMA_SERVER,
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId: "cyber-tiel-coder-35b-a3b-mtp-iq3xxs",
    modelPath,
    slotCacheDir: defaultSlotCacheDir(),
    ...(binary ? { binary } : {}),
    // 16k: this hybrid-attention MoE keeps a small KV cache (the card documents
    // ~5GB at 262k in f16, so ~0.16GB here at q8_0). At 8k the ledger card's
    // prompt outgrew the window after 32 turns and the request was rejected.
    contextTokens: 16384,
    mtp: true,
    maxTokens: 4096,
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
  });
}

/**
 * The Apodex vendor system prompt (model card apodex/Apodex-1.1-mini §3.3),
 * verbatim, with the current time filled in.
 */
export const APODEX_SYSTEM_PROMPT = (today: string): string =>
  `You are Apodex, an AI assistant developed by Apodex AI.\n\nApodex is the flagship agent of Apodex AI. Rather than a conventional conversational LLM, it is a general-purpose solver designed for mission-critical tasks.\n\nCurrent time: ${today}. In this environment you have access to a set of tools you can use to answer the user's question.\n\nYou only have access to the tools provided. You can use multiple tools per message, and will receive the results of those tools in the user's next response. You use tools step-by-step to accomplish a given task.\n\n# General Objective\n\nYou accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.`;

/**
 * Apodex's per-slot context: 32k where the host has room for it, else 16k.
 * `SEKHEMET_RESEARCHER_CTX` (a token count) overrides it, for live
 * measurement of larger windows.
 */
export function apodexContextTokens(
  totalBytes: number = totalmem(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.SEKHEMET_RESEARCHER_CTX);
  if (Number.isInteger(override) && override >= 2048) return override;
  // IQ3_M weights are ~16 GB; a 24 GB host keeps 16k so the KV cache and the
  // toolchain still fit. 32 GB and up take the 32k window research needs.
  return totalBytes >= 32 * 1024 ** 3 ? 32768 : 16384;
}

/**
 * Apodex-1.1-mini as the Researcher (the user's choice; arXiv 2608.23283,
 * Apache-2.0, a Qwen3.5-35B-A3B research fine-tune). IQ3_M (imatrix, 16 GB)
 * is the largest quant that runs alone on a 24 GB host; a 128 GB host passes
 * its own Q8_0 file as `modelPath`. Its own port, so it never collides with
 * the worker's server when both are resident. Sampling is the vendor's
 * (model card §3.3: temperature 1.0, top_p 0.95); tools go natively, and
 * several may be called per message. Pair with `APODEX_SYSTEM_PROMPT`.
 */
export function createApodexResearcher(
  modelPath = resolveModelPath(MANAGED_MODEL_FILES.researcher),
  binary = process.env.SEKHEMET_LLAMA_SERVER,
  totalBytes: number = totalmem(),
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId: "apodex-1.1-mini",
    modelPath,
    slotCacheDir: defaultSlotCacheDir(),
    ...(binary ? { binary } : {}),
    port: 8101,
    // Slot 0: the research conversation. Slot 1: one-off web_fetch
    // extractions, which otherwise evict the conversation's prefix (live
    // hit rate 55-68% on one slot). Qwen3.5-A3B has full attention on only
    // 1 layer in 4, so the second slot's KV cache is small.
    contextTokens: apodexContextTokens(totalBytes),
    parallelSlots: 2,
    maxTokens: 1500,
    nativeTools: true,
    sampling: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0 },
  });
}

/**
 * The Researcher bake-off's two candidates (models NEW-models-11, MD-N11-1):
 * 4B research models small enough to stay loaded beside the Worker, set
 * against the incumbent Apodex-1.1-mini on the research golden set. The file
 * names are the ones a person saves them under in the models directory;
 * their download sources are unverified, so no source is recorded in
 * `MODEL_SOURCES` and the harness never fetches them (models rule 4). Neither
 * is a managed default until a bake-off adopts it (MD-N11-2), and Apodex's
 * profile stays until that adoption is recorded (MD-N11-3).
 */
export const RESEARCHER_CANDIDATE_FILES = {
  spark: "Spark-X2.5-4B-GGUF/Spark-X2.5-4B-Q8_0.gguf",
  neohorse: "NeoHorse-1-4B-GGUF/NeoHorse-1-4B-Q8_0.gguf",
} as const;

/** The llama.cpp build Spark-X2.5-4B's `spark2_5` architecture needs (PR #27868). */
export const SPARK_MIN_LLAMA_BUILD = 10828;

/**
 * Sampling for the two 4B candidates: the Qwen3.5 family's non-thinking
 * values, since both model cards were read only through a review and name
 * none for tool loops. It is part of each qualified combination (suite q1.2),
 * so the bake-off measures it rather than assuming it.
 */
const SMALL_RESEARCHER_SAMPLING = { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 } as const;

/**
 * A 4B Researcher candidate's profile: its own port, two slots (the
 * conversation, and one-off page extractions) of 32k each — a 4B model's KV
 * cache affords the window research needs — and thinking off at the server,
 * since both think by default and a tool loop pays for it on every turn.
 */
function smallResearcherProfile(
  modelId: string,
  modelPath: string,
  port: number,
  binary: string | undefined,
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId,
    modelPath,
    slotCacheDir: defaultSlotCacheDir(),
    ...(binary ? { binary } : {}),
    port,
    contextTokens: 32768,
    parallelSlots: 2,
    reasoning: "off",
    maxTokens: 2048,
    sampling: { ...SMALL_RESEARCHER_SAMPLING },
  });
}

/**
 * Spark-X2.5-4B (Apache-2.0; Q8_0, 4.4 GB; hybrid attention, one full layer
 * per three sliding-window layers) as a Researcher candidate. It needs
 * llama.cpp b10828 or later (`SPARK_MIN_LLAMA_BUILD`); its vendor tool
 * parser is unverified, so its tool arm is measured by qualification.
 */
export function createSparkResearcher(
  modelPath = resolveModelPath(RESEARCHER_CANDIDATE_FILES.spark),
  binary = process.env.SEKHEMET_LLAMA_SERVER,
): ManagedLlamaServerAdapter {
  return smallResearcherProfile("spark-x2.5-4b", modelPath, 8102, binary);
}

/**
 * NeoHorse-1-4B (Apache-2.0, initialised from Qwen3.5-4B, 262k native
 * context) as a Researcher candidate, Spark's peer in the bake-off.
 */
export function createNeoHorseResearcher(
  modelPath = resolveModelPath(RESEARCHER_CANDIDATE_FILES.neohorse),
  binary = process.env.SEKHEMET_LLAMA_SERVER,
): ManagedLlamaServerAdapter {
  return smallResearcherProfile("neohorse-1-4b", modelPath, 8103, binary);
}

/**
 * Each role's window and answer length for a model with no managed builder:
 * the Worker's is the managed Worker's (16k; 8k overflowed a ledger card),
 * the others the roles' Ollama windows (`ollamaProfileForRole`).
 */
export const GENERIC_ROLE_WINDOWS: Readonly<
  Record<ModelRole, { contextTokens: number; maxTokens: number }>
> = {
  worker: { contextTokens: 16384, maxTokens: 4096 },
  planner: { contextTokens: 8192, maxTokens: 2048 },
  researcher: { contextTokens: 16384, maxTokens: 1200 },
  reviewer: { contextTokens: 12288, maxTokens: 900 },
};

/**
 * A family's published defaults, used when the registry records no sampling
 * for the model: Qwen's non-thinking values (as the Researcher candidates'),
 * Gemma's model-card values. Any other family gets the roles' code sampling.
 */
export const FAMILY_SAMPLING: Readonly<Record<string, SamplingOptions>> = {
  qwen: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0 },
  gemma: { temperature: 1.0, topP: 0.95, topK: 64, minP: 0 },
};

/** The roles' code sampling (`ollamaProfileForRole`), for an unknown family. */
const FALLBACK_SAMPLING: SamplingOptions = { temperature: 0.2, topP: 0.9, topK: 20, minP: 0 };

/**
 * A generic model's own port, from its id: 8110–8189, clear of the Worker
 * (8098), the Planner (8099), the Researchers (8101–8103) and the owner's
 * own servers, so a registered model never adopts another model's server
 * (a collision is refused by the `/props` check, MD-M4-1, never adopted).
 */
export function genericManagedPort(modelId: string): number {
  return 8110 + (createHash("sha256").update(modelId).digest().readUInt32BE(0) % 80);
}

function samplingOf(entry: ModelEntry | undefined): SamplingOptions {
  const s = entry?.sampling;
  if (s && Object.values(s).some((v) => typeof v === "number")) {
    const out: SamplingOptions = {};
    if (s.temperature !== undefined) out.temperature = s.temperature;
    if (s.topP !== undefined) out.topP = s.topP;
    if (s.topK !== undefined) out.topK = s.topK;
    if (s.minP !== undefined) out.minP = s.minP;
    return out;
  }
  return { ...(FAMILY_SAMPLING[entry?.family ?? ""] ?? FALLBACK_SAMPLING) };
}

/**
 * A managed llama-server for a registered GGUF with no managed builder
 * (MD-N12-10): the role's window (or the one a queue asks for) capped at the
 * header's trained context; q8_0 KV as the Worker's; the registry's
 * sampling, else the family's; speculative decoding measurable when the
 * header carries an MTP head, and used only once measured and qualified
 * (MD-N8-2). Its model id is the registry id, so its qualifications are its own.
 */
export function createGenericManaged(opts: {
  modelId: string;
  modelPath: string;
  role: ModelRole;
  entry?: ModelEntry;
  want?: { contextTokens?: number; maxTokens?: number };
  binary?: string;
}): ManagedLlamaServerAdapter {
  const win = GENERIC_ROLE_WINDOWS[opts.role];
  const wanted = opts.want?.contextTokens ?? win.contextTokens;
  const trained = opts.entry?.header?.contextLength;
  const binary = opts.binary ?? process.env.SEKHEMET_LLAMA_SERVER;
  return new ManagedLlamaServerAdapter({
    modelId: opts.modelId,
    modelPath: opts.modelPath,
    slotCacheDir: defaultSlotCacheDir(),
    ...(binary ? { binary } : {}),
    port: genericManagedPort(opts.modelId),
    contextTokens: trained ? Math.min(wanted, trained) : wanted,
    kvType: "q8_0",
    maxTokens: opts.want?.maxTokens ?? win.maxTokens,
    sampling: samplingOf(opts.entry),
    mtp: opts.entry?.header?.mtpHead === true,
    ...(opts.entry?.sha256 ? { weightsSha256: opts.entry.sha256 } : {}),
  });
}

/** One model the Researcher bake-off runs (MD-N11-1): the incumbent first. */
export interface ResearcherCandidate {
  modelId: string;
  /** The GGUF inside the models directory. */
  file: string;
  /** The oldest llama.cpp build that runs it, when it needs a recent one. */
  minLlamaBuild?: number;
  create(modelPath?: string, binary?: string): ManagedLlamaServerAdapter;
}

export const RESEARCHER_CANDIDATES: readonly ResearcherCandidate[] = [
  {
    modelId: "apodex-1.1-mini",
    file: MANAGED_MODEL_FILES.researcher,
    create: (path, binary) => createApodexResearcher(path, binary),
  },
  {
    modelId: "spark-x2.5-4b",
    file: RESEARCHER_CANDIDATE_FILES.spark,
    minLlamaBuild: SPARK_MIN_LLAMA_BUILD,
    create: (path, binary) => createSparkResearcher(path, binary),
  },
  {
    modelId: "neohorse-1-4b",
    file: RESEARCHER_CANDIDATE_FILES.neohorse,
    create: (path, binary) => createNeoHorseResearcher(path, binary),
  },
];

/** CHRONICLE §2 sampling for code and structured output. */
export const QWEN38_CODE_SAMPLING = {
  temperature: 0.2,
  topP: 0.9,
  topK: 20,
  minP: 0,
  presencePenalty: 1.5,
} as const;

/** CHRONICLE §2 sampling for planning: 0.7 / 0.8, the rest as for code. */
export const QWEN38_PLANNING_SAMPLING = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  minP: 0,
  presencePenalty: 1.5,
} as const;

/** The GGUF CHRONICLE §2 names, inside this host's models directory. */
export function defaultQwen38Gguf(options: ModelsDirOptions = {}): string {
  return resolveModelPath(MANAGED_MODEL_FILES.planner, options);
}

/**
 * The weights the managed profiles resolve to on this host, for the weights
 * check. Building an adapter starts no server, so this is safe in `doctor`.
 */
export function managedModelWeights(
  options: ModelsDirOptions & { registry?: ModelRegistry | undefined } = {},
): { modelId: string; path: string }[] {
  const adapters = [
    createCyberTielWorker(resolveModelPath(MANAGED_MODEL_FILES.worker, options)),
    createApodexResearcher(resolveModelPath(MANAGED_MODEL_FILES.researcher, options)),
    createQwen38Managed({ modelPath: resolveModelPath(MANAGED_MODEL_FILES.planner, options) }),
  ];
  // MD-N14-41a: the registry's readable recorded copy, as the roster launches it.
  return adapters.map((a) => ({
    modelId: a.launchProfile.modelId,
    path:
      recordedGguf(options.registry, a.launchProfile.modelId, existsSync) ??
      a.launchProfile.modelPath,
  }));
}

export interface ChronicleProfileOptions {
  modelPath?: string;
  modelId?: string;
  binary?: string;
  /**
   * `off` is CHRONICLE §2 verbatim (`--reasoning off`). `per-request` omits
   * the flag, so a planning or repair request can turn thinking on (M6).
   */
  reasoning?: "off" | "per-request";
  slotCacheDir?: string;
}

/**
 * The CHRONICLE §2 llama-server launch profile (X29), as a selectable
 * `LlamaServerProfile`:
 *
 *   llama-server -m <gguf> --host 127.0.0.1 --port 8099 -t 2 -ngl 999 -fa on
 *     -ctk q8_0 -ctv q8_0 -np 2 -c 49152 --ctx-checkpoints 6 --cache-ram 2048
 *     --jinja --metrics --no-webui --reasoning off
 *
 * MTP stays off: §2 measured it 21% slower on M4 Metal.
 */
export function chronicleLlamaServerProfile(
  options: ChronicleProfileOptions = {},
): LlamaServerProfile {
  const binary = options.binary ?? process.env.SEKHEMET_LLAMA_SERVER;
  return {
    modelId: options.modelId ?? "qwen3.8-27b",
    modelPath: options.modelPath ?? defaultQwen38Gguf(),
    ...(binary ? { binary } : {}),
    port: 8099,
    threads: 2,
    gpuLayers: 999,
    kvType: "q8_0",
    parallel: 2,
    contextTokens: 49152,
    // Exactly §2: no -sps (the server default applies to its two slots).
    cache: { cacheRamMiB: 2048, ctxCheckpoints: 6, slotPromptSimilarity: "server-default" },
    metrics: true,
    webui: false,
    ...((options.reasoning ?? "off") === "off" ? { reasoning: "off" as const } : {}),
    mtp: false,
    ...(options.slotCacheDir ? { slotCacheDir: options.slotCacheDir } : {}),
    maxTokens: 2048,
    sampling: { ...QWEN38_CODE_SAMPLING },
    planningSampling: { ...QWEN38_PLANNING_SAMPLING },
  };
}

/**
 * Qwen3.8-27B (the Dirk GSQ-RCO IQ3_S build) under a harness-managed
 * llama-server with the CHRONICLE §2 profile (M5). One adapter serves both
 * code and planning: requests with `purpose: "planning"` get 0.7 / 0.8, so
 * the manager and escalation roles can share the same weights and server.
 * Reasoning is per request (`reasoning: "per-request"` by default here), so
 * repair rungs and plans can think while mechanical steps do not.
 */
export function createQwen38Managed(
  options: ChronicleProfileOptions = {},
): ManagedLlamaServerAdapter {
  const slotCacheDir = options.slotCacheDir ?? defaultSlotCacheDir();
  return new ManagedLlamaServerAdapter(
    chronicleLlamaServerProfile({ reasoning: "per-request", ...options, slotCacheDir }),
  );
}

/**
 * Whether two model paths name the same file: resolved through symbolic
 * links when both exist (A8), else compared as absolute paths.
 */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  return real(a) === real(b);
}

/**
 * llama-bench, the llama.cpp build's own benchmark (dashboard DB-NM14-3,
 * DEC-44): beside the llama-server the harness resolves (rule 6b:
 * `SEKHEMET_LLAMA_SERVER`, else the downloaded engine or PATH's), else on
 * the PATH. It loads the model itself, so it runs only inside a benchmark
 * run of the residency scheduler, on a person's confirmed request.
 */
export function llamaBenchBinary(
  server = process.env.SEKHEMET_LLAMA_SERVER ?? resolveLlamaServer().engine?.path,
): string {
  return server ? join(dirname(server), "llama-bench") : "llama-bench";
}

/** Run llama-bench and return its stdout (`BenchExec` for `runLlamaBench`); 20 minutes at most per run. */
export function llamaBenchExec(): (bin: string, args: string[]) => Promise<string> {
  return (bin, args) =>
    new Promise((resolveRun, reject) => {
      const refused = modelLoadRefusal({ binary: bin });
      if (refused) return reject(new Error(refused));
      execFile(
        bin,
        args,
        { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err, stdout) => (err ? reject(err) : resolveRun(stdout)),
      );
    });
}

// Rule 6b: the engine's resolution and download live in inference_engine.ts.
export * from "./inference_engine.js";
