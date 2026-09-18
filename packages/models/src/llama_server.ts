import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { type HttpAdapterOptions, HttpInferenceAdapter } from "./http_adapter.js";

export interface LlamaServerProfile {
  /** Model id reported to the harness (used in evidence and reports). */
  modelId: string;
  /** Absolute path to the GGUF. */
  modelPath: string;
  binary?: string;
  port?: number;
  contextTokens?: number;
  /** KV cache precision. 4-bit is prohibited for tool-calling models (design §572). */
  kvType?: "f16" | "q8_0";
  /** Enable the model's grafted multi-token-prediction head. */
  mtp?: boolean;
  extraArgs?: string[];
  sampling?: HttpAdapterOptions["sampling"];
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

  constructor(private profile: LlamaServerProfile) {
    const port = profile.port ?? 8098;
    super({
      modelId: profile.modelId,
      baseUrl: `http://127.0.0.1:${port}`,
      apiFormat: "openai",
      contextTokens: profile.contextTokens ?? 8192,
      maxTokens: profile.maxTokens ?? 2048,
      disableReasoning: true,
      ...(profile.sampling ? { sampling: profile.sampling } : {}),
    });
    this.url = `http://127.0.0.1:${port}`;
  }

  /** The argv the server is launched with; exposed for doctor and tests. */
  public launchArgs(): string[] {
    const p = this.profile;
    return [
      "-m",
      p.modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(p.port ?? 8098),
      "-ngl",
      "99",
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
      "1",
      ...(p.mtp ? ["--spec-type", "draft-mtp"] : []),
      ...(p.extraArgs ?? []),
    ];
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

      this.child = spawn(this.profile.binary ?? "llama-server", this.launchArgs(), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      this.child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });

      const deadline = Date.now() + (this.profile.startupTimeoutMs ?? 600_000);
      while (Date.now() < deadline) {
        if (this.child.exitCode !== null) {
          throw new Error(`llama-server exited during startup: ${stderr.slice(-800)}`);
        }
        if (await this.healthy()) return;
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

  /** Stop the server process, releasing its memory. */
  public override async unload(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
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
  modelPath = "/Volumes/My Passport/AI-Models/llm/Cyber-Tiel-Coder-35B-A3B-GGUF-MTP/Cyber-Tiel-Coder-35B-A3B-MTP-UD-IQ3_XXS.gguf",
): ManagedLlamaServerAdapter {
  return new ManagedLlamaServerAdapter({
    modelId: "cyber-tiel-coder-35b-a3b-mtp-iq3xxs",
    modelPath,
    contextTokens: 8192,
    mtp: true,
    maxTokens: 4096,
    sampling: { temperature: 0.6, topP: 0.95, topK: 20, minP: 0 },
  });
}
