import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { basename, resolve } from "node:path";
import { hostFingerprintHash } from "./calibration.js";
import { type HttpAdapterOptions, HttpInferenceAdapter } from "./http_adapter.js";
import { assertKvPolicy } from "./kv_policy.js";
import { type ModelsDirOptions, resolveModelPath } from "./models_dir.js";
import type { SpeculativeSetting } from "./qualification_key.js";
import { readQuantisation } from "./quantisation.js";
import { type ModelRegistry, type ThinkingPolicy, thinkingPolicyFromEnv } from "./registry.js";
import type { AdapterHealth, ToolArm } from "./types.js";

/**
 * The GGUF each managed profile expects, as a name inside the user's models
 * directory. Shipped source names files, never locations (design "Getting the
 * weights"); `--models-dir` decides where they are, and a user with the
 * weights elsewhere passes `modelPath` directly.
 */
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
  preferredToolArm?: ToolArm;
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
        reason: `not qualified with ${label} on and prefix caching on for this launch (MD-N8-2)`,
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
  public launchArgs(): string[] {
    const args = this.buildLaunchArgs();
    assertKvPolicy(args, {
      toolCalling: this.profile.toolCalling !== false,
      qualifiedBelow8Bit: this.profile.qualifiedBelow8BitKv === true,
    });
    return args;
  }

  /** Server slots (`-np`). */
  public slotCount(): number {
    return Math.max(1, this.profile.parallelSlots ?? this.profile.parallel ?? 1);
  }

  /** The server's total context (`-c`). */
  public totalContextTokens(): number {
    const ctx = this.profile.contextTokens ?? 8192;
    return this.profile.parallelSlots !== undefined ? ctx * this.slotCount() : ctx;
  }

  private buildLaunchArgs(): string[] {
    const p = this.profile;
    const parallel = this.slotCount();
    const cache = this.cacheSettings();
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
      // Two draft tokens: the measured sweet spot for a grafted head (MD-M7-2).
      ...(this.mtpEnabled() ? ["--spec-type", "draft-mtp", "--spec-draft-n-max", "2"] : []),
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
    this.adoptedAt = Date.now();
    await this.recordQuantisation();
  }

  /** Start the server if needed and wait until it reports healthy. */
  public async ensureRunning(): Promise<void> {
    let state = await this.healthState();
    if (state === "loading") {
      // A server still loading answers 503: wait for it rather than starting
      // a second one on the same port (A10).
      const deadline = Date.now() + (this.profile.startupTimeoutMs ?? 600_000);
      while (state === "loading" && Date.now() < deadline) {
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
          this.adoptedAt = Date.now();
          await this.recordQuantisation();
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
    const kv = this.totalContextTokens() * 64 * 1024; // hybrid MoE, q8_0: small
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
  // Ubuntu AI node on its NVMe. Both point `--models-dir` at their own copy;
  // the file name below is all the harness ships. SEKHEMET_LLAMA_SERVER names
  // the llama-server build (Metal, Vulkan, ROCm).
  modelPath = resolveModelPath(MANAGED_MODEL_FILES.worker),
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
    slotCacheDir: process.env.SEKHEMET_SLOT_CACHE ?? `${tmpdir()}/sekhemet-slots`,
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
  options: ModelsDirOptions = {},
): { modelId: string; path: string }[] {
  const adapters = [
    createCyberTielWorker(resolveModelPath(MANAGED_MODEL_FILES.worker, options)),
    createApodexResearcher(resolveModelPath(MANAGED_MODEL_FILES.researcher, options)),
    createQwen38Managed({ modelPath: resolveModelPath(MANAGED_MODEL_FILES.planner, options) }),
  ];
  return adapters.map((a) => ({
    modelId: a.launchProfile.modelId,
    path: a.launchProfile.modelPath,
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
  const slotCacheDir =
    options.slotCacheDir ?? process.env.SEKHEMET_SLOT_CACHE ?? `${tmpdir()}/sekhemet-slots`;
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
