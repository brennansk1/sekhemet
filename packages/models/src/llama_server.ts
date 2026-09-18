import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { hostFingerprintHash } from "./calibration.js";
import { type HttpAdapterOptions, HttpInferenceAdapter } from "./http_adapter.js";
import { assertKvPolicy } from "./kv_policy.js";
import type { ModelRegistry } from "./registry.js";
import type { AdapterHealth, ToolArm } from "./types.js";

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
  preferredToolArm?: ToolArm;
  /**
   * The model registry (M11, M12). Also decides MTP when it holds a
   * speculative-decoding measurement for this model on this host (M19).
   */
  registry?: ModelRegistry;
  /** Enable the model's grafted multi-token-prediction head. */
  mtp?: boolean;
  /**
   * Directory for KV-cache slot files. When set, the slot is saved before the
   * server is stopped for a model swap and restored after it restarts, so the
   * shared prompt prefix is not re-read (research report 2: cache loss on
   * swaps is the dominant swap cost; llama.cpp --slot-save-path).
   */
  slotCacheDir?: string;
  /** `-t`: CPU threads. Unset leaves the server's default. */
  threads?: number;
  /** `-ngl`: layers offloaded to the GPU. Default 99 (all). */
  gpuLayers?: number;
  /** `-np`: server slots. Default 1. */
  parallel?: number;
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

  constructor(private profile: LlamaServerProfile) {
    const port = profile.port ?? 8098;
    super({
      modelId: profile.modelId,
      baseUrl: `http://127.0.0.1:${port}`,
      apiFormat: "openai",
      // The window one request gets: `-c` is shared across `-np` slots.
      contextTokens: Math.floor((profile.contextTokens ?? 8192) / (profile.parallel ?? 1)),
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
   * Whether this launch uses the MTP head (M19): the registry's measured
   * decision for this host when there is one, else the profile's `mtp`;
   * never while the watchdog has it suspended (M20).
   */
  public mtpEnabled(): boolean {
    if (this.mtpSuspended) return false;
    const measured = this.registry?.get(this.profile.modelId)?.speculative;
    if (measured && measured.fingerprint === hostFingerprintHash()) return measured.enabled;
    return this.profile.mtp === true;
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
  public launchArgs(): string[] {
    const args = this.buildLaunchArgs();
    assertKvPolicy(args, {
      toolCalling: this.profile.toolCalling !== false,
      qualifiedBelow8Bit: this.profile.qualifiedBelow8BitKv === true,
    });
    return args;
  }

  private buildLaunchArgs(): string[] {
    const p = this.profile;
    const parallel = p.parallel ?? 1;
    const cache = this.cacheSettings();
    return [
      "-m",
      p.modelPath,
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
      String(p.contextTokens ?? 8192),
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
      ...(this.mtpEnabled() ? ["--spec-type", "draft-mtp"] : []),
      ...(p.slotCacheDir ? ["--slot-save-path", p.slotCacheDir] : []),
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
    for (let slot = 0; slot < (this.profile.parallel ?? 1); slot++) {
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
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Start the server if needed and wait until it reports healthy. */
  public async ensureRunning(): Promise<void> {
    if (await this.healthy()) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (!existsSync(this.profile.modelPath)) {
        throw new Error(`Model file not found: ${this.profile.modelPath}`);
      }
      await evictOllamaModels(this.profile.ollamaBaseUrl);
      if (this.profile.slotCacheDir) mkdirSync(this.profile.slotCacheDir, { recursive: true });

      this.child = spawn(this.profile.binary ?? "llama-server", this.launchArgs(), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.bindToParentLifetime(this.child);
      let stderr = "";
      this.child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });

      const deadline = Date.now() + (this.profile.startupTimeoutMs ?? 600_000);
      while (Date.now() < deadline) {
        if (this.child.exitCode !== null) {
          throw new Error(`llama-server exited during startup: ${stderr.slice(-800)}`);
        }
        if (await this.healthy()) {
          await this.slotAction("restore");
          return;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`llama-server did not become healthy in time: ${stderr.slice(-800)}`);
    })();

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  public override async generate(
    ...args: Parameters<HttpInferenceAdapter["generate"]>
  ): ReturnType<HttpInferenceAdapter["generate"]> {
    await this.ensureRunning();
    return super.generate(...args);
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

  /** Weights on disk, plus the KV cache for its context and runtime overhead. */
  public async footprintBytes(): Promise<number | undefined> {
    if (!existsSync(this.profile.modelPath)) return undefined;
    const weights = statSync(this.profile.modelPath).size;
    const kv = (this.profile.contextTokens ?? 8192) * 64 * 1024; // hybrid MoE, q8_0: small
    return Math.round(weights * 1.03 + kv + 1.2 * 1024 ** 3);
  }

  private get slotFile(): string {
    return `${this.profile.modelId.replace(/[^\w.-]/g, "_")}.slot`;
  }

  /**
   * Save or restore slot 0's KV cache. Best effort: a missing file on the
   * first start, or a server without slot support, costs only a cold prefill.
   */
  public async slotAction(action: "save" | "restore"): Promise<boolean> {
    if (!this.profile.slotCacheDir) return false;
    try {
      const res = await fetch(`${this.url}/slots/0?action=${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: this.slotFile }),
        signal: AbortSignal.timeout(60_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Stop the server process, releasing its memory. */
  public override async unload(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await this.slotAction("save");
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
  // Ubuntu AI node on its NVMe. SEKHEMET_WORKER_GGUF and SEKHEMET_LLAMA_SERVER
  // point at the model file and the llama-server build (Metal, Vulkan, ROCm).
  modelPath = process.env.SEKHEMET_WORKER_GGUF ??
    "/Volumes/My Passport/AI-Models/llm/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP/Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
  binary = process.env.SEKHEMET_LLAMA_SERVER,
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId: "cyber-tiel-coder-35b-a3b-mtp-iq3xxs",
    modelPath,
    slotCacheDir: process.env.SEKHEMET_SLOT_CACHE ?? `${tmpdir()}/sekhemet-slots`,
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

/** Apodex's context: 32k where the host has room for it, else 16k. */
export function apodexContextTokens(totalBytes: number = totalmem()): number {
  // IQ3_M weights are ~16 GB; a 24 GB host keeps 16k so the KV cache and the
  // toolchain still fit. 32 GB and up take the 32k window research needs.
  return totalBytes >= 32 * 1024 ** 3 ? 32768 : 16384;
}

/**
 * Apodex-1.1-mini as the Researcher (the user's choice; arXiv 2608.23283,
 * Apache-2.0, a Qwen3.5-35B-A3B research fine-tune). IQ3_M (imatrix, 16 GB)
 * is the largest quant that runs alone on a 24 GB host; on a 128 GB host use
 * Q8_0 via SEKHEMET_RESEARCHER_GGUF. Its own port, so it never collides with
 * the worker's server when both are resident. Sampling is the vendor's
 * (model card §3.3: temperature 1.0, top_p 0.95); tools go natively, and
 * several may be called per message. Pair with `APODEX_SYSTEM_PROMPT`.
 */
export function createApodexResearcher(
  modelPath = process.env.SEKHEMET_RESEARCHER_GGUF ??
    "/Volumes/My Passport/AI-Models/llm/Apodex-1.1-mini-GGUF/Apodex-1.1-mini-IQ3_M.gguf",
  binary = process.env.SEKHEMET_LLAMA_SERVER,
  totalBytes: number = totalmem(),
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId: "apodex-1.1-mini",
    modelPath,
    slotCacheDir: process.env.SEKHEMET_SLOT_CACHE ?? `${tmpdir()}/sekhemet-slots`,
    ...(binary ? { binary } : {}),
    port: 8101,
    contextTokens: apodexContextTokens(totalBytes),
    maxTokens: 1500,
    nativeTools: true,
    sampling: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0 },
  });
}

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

/** The GGUF CHRONICLE §2 names, overridable per host. */
export const DEFAULT_QWEN38_GGUF =
  process.env.SEKHEMET_QWEN38_GGUF ??
  "/Volumes/My Passport/AI-Models/llm/Dirk-Qwen3.8-27B-GGUF/Dirk-Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf";

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
    modelPath: options.modelPath ?? DEFAULT_QWEN38_GGUF,
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
  const slotCacheDir =
    options.slotCacheDir ?? process.env.SEKHEMET_SLOT_CACHE ?? `${tmpdir()}/sekhemet-slots`;
  return new ManagedLlamaServerAdapter(
    chronicleLlamaServerProfile({ reasoning: "per-request", ...options, slotCacheDir }),
  );
}
