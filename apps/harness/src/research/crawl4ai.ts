import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "./polite.js";

/**
 * Crawl4AI (Apache-2.0, https://github.com/unclecode/crawl4ai) as the
 * Researcher's page reader: a real browser renders JavaScript-built pages
 * (most modern docs) and the page comes back as clean markdown, filtered to
 * the parts about the question (BM25 "fit markdown"), beside the whole page.
 *
 * This product includes software developed by UncleCode
 * (https://x.com/unclecode) as part of the Crawl4AI project
 * (https://github.com/unclecode/crawl4ai).
 *
 * It runs as a warm sidecar (crawl4ai_server.py) from a private venv, started
 * on first use and bound to loopback. When it is not installed the Researcher
 * falls back to the plain HTML reader; nothing else changes.
 */

export const CRAWL4AI_HOME =
  process.env.SEKHEMET_CRAWL4AI_HOME ?? join(homedir(), ".local", "share", "sekhemet", "crawl4ai");

export interface CrawlResult {
  ok: boolean;
  title?: string;
  /** The whole page as Markdown (Crawl4AI's raw markdown): what the cache keeps. */
  markdown?: string;
  /**
   * The parts Crawl4AI's BM25 filter kept for the question (its "fit
   * markdown", design-stage DS-N9-10); "" when there was no question or the
   * filter kept too little to trust.
   */
  fitMarkdown?: string;
  error?: string;
}

export interface PageCrawler {
  crawl(url: string, query?: string): Promise<CrawlResult>;
}

function serverScript(): string | undefined {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const p of [
    join(here, "crawl4ai_server.py"),
    join(here, "..", "..", "src", "research", "crawl4ai_server.py"),
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

export function crawl4aiInstalled(home = CRAWL4AI_HOME): boolean {
  return existsSync(join(home, ".venv", "bin", "python")) && serverScript() !== undefined;
}

/** A client for the sidecar that starts it on first use and stops it on exit. */
export class Crawl4AiSidecar implements PageCrawler {
  private proc: ChildProcess | undefined;
  private starting: Promise<boolean> | undefined;

  constructor(
    private readonly port = Number(process.env.SEKHEMET_CRAWL4AI_PORT ?? 11235),
    private readonly home = CRAWL4AI_HOME,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private get base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await this.fetchFn(`${this.base}/health`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Start the sidecar if needed. False when Crawl4AI is not installed or will not start. */
  ensure(): Promise<boolean> {
    if (!this.starting) {
      this.starting = (async () => {
        if (await this.healthy()) return true;
        const script = serverScript();
        const python = join(this.home, ".venv", "bin", "python");
        if (!script || !existsSync(python)) return false;
        this.proc = spawn(python, [script], {
          env: {
            ...process.env,
            SEKHEMET_CRAWL4AI_PORT: String(this.port),
            SEKHEMET_USER_AGENT: USER_AGENT,
          },
          stdio: "ignore",
        });
        this.proc.unref();
        const stop = () => this.stop();
        process.once("exit", stop);
        // A cold browser takes a few seconds.
        for (let i = 0; i < 60; i++) {
          if (await this.healthy()) return true;
          if (this.proc.exitCode !== null) return false;
          await new Promise((r) => setTimeout(r, 500));
        }
        return false;
      })();
      // A failed start may be retried later.
      this.starting.then((ok) => {
        if (!ok) this.starting = undefined;
      });
    }
    return this.starting;
  }

  async crawl(url: string, query?: string): Promise<CrawlResult> {
    if (!(await this.ensure())) return { ok: false, error: "Crawl4AI is not available." };
    try {
      const r = await this.fetchFn(`${this.base}/md`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, query: query ?? null }),
        signal: AbortSignal.timeout(65_000),
      });
      return (await r.json()) as CrawlResult;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(): void {
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGTERM");
    this.proc = undefined;
    this.starting = undefined;
  }
}
