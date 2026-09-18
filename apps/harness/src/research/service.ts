import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CardStore } from "@sekhemet/kernel";
import {
  HttpInferenceAdapter,
  type LocalInferenceAdapter,
  createApodexResearcher,
} from "@sekhemet/models";
import { readSettings } from "../integrations.js";
import { similarity } from "../learning/store.js";
import { crawl4aiInstalled } from "./crawl4ai.js";
import { type ResearchAnswer, type ResearchDeps, investigate, research } from "./researcher.js";
import { ensureSearxng } from "./searxng.js";
import { type WebConfig, webConfigFromEnv } from "./web.js";

/**
 * The research service: one entry point for every role that needs the
 * Researcher (Merit's questions, the queue's unexplained errors, the worker's
 * `ask`, the CLI), so each gets the same model, sources, memory and record.
 *
 * - Model: Apodex through the managed llama-server (never Ollama, which cannot
 *   load it), or any Ollama model named by the user.
 * - Sources: the web only when the project turned research web access on.
 *   Then the private SearXNG is started if its image is present, and pages are
 *   read through Crawl4AI when it is installed.
 * - Memory: grounded answers are kept across projects. A question already
 *   answered well (same question, recent, confident) is answered from memory
 *   rather than researched again, and says so.
 * - Record: an answer about a card goes on the card's dossier (the ledger), so
 *   every later attempt reads it.
 */

export interface MemoryEntry {
  question: string;
  answer: string;
  sources: string[];
  confidence: number;
  at: string;
  repo: string;
}

export class ResearchMemory {
  constructor(
    private readonly path = join(
      process.env.SEKHEMET_CONFIG_DIR ?? join(homedir(), ".config", "sekhemet"),
      "research",
      "memory.jsonl",
    ),
  ) {}

  all(): MemoryEntry[] {
    try {
      return readFileSync(this.path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as MemoryEntry);
    } catch {
      return [];
    }
  }

  /** A recent, confident answer to (nearly) the same question. */
  recall(question: string, maxAgeDays = 30, minSimilarity = 0.6): MemoryEntry | undefined {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    let best: { e: MemoryEntry; s: number } | undefined;
    for (const e of this.all()) {
      if (Date.parse(e.at) < cutoff || e.confidence < 0.35) continue;
      const s = similarity(e.question, question);
      if (s >= minSimilarity && (!best || s > best.s)) best = { e, s };
    }
    return best?.e;
  }

  remember(entry: MemoryEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

/** The Researcher's model by name: "apodex" is managed; anything else is an Ollama tag. */
export function researcherAdapter(name: string): LocalInferenceAdapter {
  if (name === "apodex") return createApodexResearcher();
  return new HttpInferenceAdapter({
    modelId: name,
    apiFormat: "ollama",
    contextTokens: 16384,
    maxTokens: 1200,
    disableReasoning: true,
  });
}

export interface SourceStatus {
  web: boolean;
  search: string;
  pages: string;
}

/** Sources for this project, starting the private SearXNG when web access is on. */
export async function researchSources(
  repoPath: string,
  opts: { forceWeb?: boolean; ensure?: typeof ensureSearxng } = {},
): Promise<{ web: WebConfig | undefined; status: SourceStatus }> {
  const on = opts.forceWeb ?? readSettings(repoPath).researchWeb === true;
  if (!on) {
    return {
      web: undefined,
      status: { web: false, search: "off (project setting)", pages: "off" },
    };
  }
  if (
    !process.env.SEKHEMET_SEARXNG_URL &&
    !process.env.BRAVE_SEARCH_API_KEY &&
    !process.env.TAVILY_API_KEY
  ) {
    const url = await (opts.ensure ?? ensureSearxng)().catch(() => undefined);
    if (url) process.env.SEKHEMET_SEARXNG_URL = url;
  }
  const web = webConfigFromEnv();
  const env = process.env;
  return {
    web,
    status: {
      web: true,
      search: env.SEKHEMET_SEARXNG_URL
        ? `SearXNG (${env.SEKHEMET_SEARXNG_URL})`
        : env.BRAVE_SEARCH_API_KEY
          ? "Brave"
          : env.TAVILY_API_KEY
            ? "Tavily"
            : "none (papers, docs, GitHub and page reads still work)",
      pages: web.crawler
        ? "Crawl4AI (rendered)"
        : crawl4aiInstalled()
          ? "Crawl4AI (off)"
          : "plain HTML reader",
    },
  };
}

export interface AskOptions {
  deep?: boolean;
  cardId?: string;
  /** Skip memory (always research afresh). */
  fresh?: boolean;
}

export interface AskResult extends ResearchAnswer {
  fromMemory: boolean;
}

export class ResearchService {
  constructor(
    private readonly deps: {
      repoPath: string;
      model: () => Promise<LocalInferenceAdapter>;
      web?: WebConfig | undefined;
      cardStore?: CardStore;
      memory?: ResearchMemory;
      today?: string;
      maxRounds?: number;
      /** Tool dependencies passed through (registries, fetchers; injectable for tests). */
      tools?: Pick<ResearchDeps, "fetchJson" | "libraries">;
      onEvent?: (line: string) => void;
    },
  ) {}

  private get memory(): ResearchMemory {
    return this.deps.memory ?? new ResearchMemory();
  }

  async ask(question: string, opts: AskOptions = {}): Promise<AskResult> {
    const known = opts.fresh ? undefined : this.memory.recall(question);
    let result: AskResult;
    if (known) {
      result = {
        answer: `${known.answer}\n\n(From research memory, ${known.at.slice(0, 10)}.)`,
        sources: known.sources,
        evidence: known.sources.map((ref) => ({ kind: "memory", ref })),
        grounded: true,
        confidence: known.confidence,
        badCitations: [],
        fromMemory: true,
      };
    } else {
      const model = await this.deps.model();
      const rdeps: ResearchDeps = {
        repoPath: this.deps.repoPath,
        web: this.deps.web,
        ...this.deps.tools,
        ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}),
        ...(this.deps.today ? { today: this.deps.today } : {}),
        ...(this.deps.maxRounds ? { maxRounds: this.deps.maxRounds } : {}),
      };
      const r = opts.deep
        ? await investigate(model, question, rdeps)
        : await research(model, question, rdeps);
      result = { ...r, fromMemory: false };
      // Keep only what can be trusted later: grounded, cited, confident.
      if (r.grounded && r.badCitations.length === 0 && r.confidence >= 0.35) {
        this.memory.remember({
          question,
          answer: r.answer,
          sources: r.sources,
          confidence: r.confidence,
          at: new Date().toISOString(),
          repo: this.deps.repoPath,
        });
      }
    }
    if (opts.cardId && this.deps.cardStore && result.grounded) {
      await this.deps.cardStore
        .recordDossierEntry({
          cardId: opts.cardId,
          kind: "research",
          text: `Q: ${question.slice(0, 300)}\nA: ${result.answer.slice(0, 1500)}\nSources: ${result.sources.slice(0, 8).join("; ")}`,
        })
        .catch(() => undefined);
    }
    return result;
  }
}

/**
 * A one-shot Researcher for callers that do not hold a model router (the
 * dashboard's Merit): load, ask, unload. A 16 GB model is not left resident
 * behind a chat message.
 */
export function oneShotResearcher(
  repoPath: string,
  modelName: string,
  cardStore?: CardStore,
): (question: string, opts?: AskOptions) => Promise<AskResult> {
  return async (question, opts = {}) => {
    const { web } = await researchSources(repoPath);
    let adapter: LocalInferenceAdapter | undefined;
    const service = new ResearchService({
      repoPath,
      web,
      ...(cardStore ? { cardStore } : {}),
      model: async () => {
        adapter ??= researcherAdapter(modelName);
        return adapter;
      },
    });
    try {
      return await service.ask(question, opts);
    } finally {
      const unload = (adapter as { unload?: () => Promise<void> } | undefined)?.unload;
      if (unload) await unload.call(adapter).catch(() => undefined);
    }
  };
}
