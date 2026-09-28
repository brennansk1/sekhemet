import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import type { LocalInferenceAdapter, ModelHold } from "@sekhemet/models";
import { type EffectiveNetworkPolicy, policyAllowsEveryHost } from "@sekhemet/sandbox";
import { effectiveConfig, explicitNetworkMode } from "../config_apply.js";
import { readSettings } from "../integrations.js";
import { similarity } from "../learning/store.js";
import {
  type ModelAccess,
  type SwapLedger,
  sharedModelAccess,
  sharedQueue,
} from "../model_access.js";
import { researchPipelineAdvice } from "../research_bakeoff.js";
import { researchFetch, researchGate, researchPolicy } from "../research_consent.js";
import { userPaths } from "../user_dir.js";
import { crawl4aiInstalled } from "./crawl4ai.js";
import { installed } from "./deps.js";
import { EFFORT_CAPS, RESEARCH_EFFORTS, type ResearchEffort, effortOfLabels } from "./effort.js";
import {
  type ResearchAnswer,
  type ResearchDeps,
  investigate,
  research,
  withClaims,
} from "./researcher.js";
import { ensureSearxng } from "./searxng.js";
import { type WebConfig, webConfigFromEnv } from "./web.js";

/**
 * The research service: one entry point for every role that needs the
 * Researcher (Seshat's questions, the queue's unexplained errors, the worker's
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
  /** The installed version of each package the question named (DS-N2-5). */
  packages?: Record<string, string>;
  /** The effort the answer was researched at (DS-N4-1). */
  effort?: ResearchEffort;
}

/** Where an answer may be reused: this repository, at these installed versions (DS-N2-5). */
export interface MemoryScope {
  repo: string;
  packages: Record<string, string>;
  /** Only an answer researched at least this hard is reused (DS-N4-1). */
  effort?: ResearchEffort;
}

const effortRank = (e: ResearchEffort | undefined) => RESEARCH_EFFORTS.indexOf(e ?? "quick");

const canonicalRepo = (path: string): string => {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
};

/**
 * The packages installed in this repository that a question names, with their
 * installed versions: an answer about `zod` at 3.x is not an answer at 4.x.
 */
export function packagesInQuestion(repoPath: string, question: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tokens = new Set(
    (question.match(/@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?/gi) ?? [])
      .map((t) => t.toLowerCase().replace(/[.]+$/, ""))
      .filter((t) => t.length >= 2),
  );
  for (const name of [...tokens].sort()) {
    const pkg = installed(repoPath, name);
    if (pkg) out[name] = pkg.version;
  }
  return out;
}

const sameVersions = (a: Record<string, string> = {}, b: Record<string, string> = {}) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

export class ResearchMemory {
  constructor(private readonly path = userPaths().researchMemory) {}

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

  /**
   * A recent, confident answer to (nearly) the same question, recorded for
   * this repository at the same installed versions of the packages the
   * question names (DS-N2-5); never one recorded for another.
   */
  recall(
    question: string,
    scope: MemoryScope,
    maxAgeDays = 30,
    minSimilarity = 0.6,
  ): MemoryEntry | undefined {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const repo = canonicalRepo(scope.repo);
    let best: { e: MemoryEntry; s: number } | undefined;
    for (const e of this.all()) {
      if (Date.parse(e.at) < cutoff || e.confidence < 0.35) continue;
      if (canonicalRepo(e.repo) !== repo || !sameVersions(e.packages, scope.packages)) continue;
      if (effortRank(e.effort) < effortRank(scope.effort)) continue;
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

/**
 * The Researcher's model by name ("apodex" is managed; anything else is an
 * Ollama tag), as the `research` queue on the process's one scheduler
 * (MD-N9-4). The first `acquire` takes one hold, kept across the flow's
 * requests so nothing evicts the model mid-question; `release` releases it
 * and unloads the model: a 16 GB model is not left resident behind one
 * question.
 */
export function researcherModel(
  name: string,
  access: ModelAccess = sharedModelAccess(),
  ledger?: SwapLedger,
): {
  acquire: () => Promise<LocalInferenceAdapter>;
  release: () => Promise<void>;
} {
  const take = sharedQueue(
    { queue: "research", role: "researcher", name },
    ledger ? { ledger } : {},
    access,
  );
  let held: Promise<ModelHold> | undefined;
  return {
    acquire: async () => {
      held ??= take().catch((err: unknown) => {
        held = undefined;
        throw err;
      });
      return (await held).adapter;
    },
    release: async () => {
      const hold = await held?.catch(() => undefined);
      held = undefined;
      hold?.release();
      await access.release("research");
    },
  };
}

export interface SourceStatus {
  web: boolean;
  search: string;
  pages: string;
  /**
   * What a project's config.toml tried to widen and was ignored, one line
   * each with the file (DS-N4-4): research fetches nothing on its account.
   */
  ignored: string[];
}

/** One line per ignored widening, for a person (DS-N4-4). */
function ignoredLines(policy: EffectiveNetworkPolicy): string[] {
  return (policy.ignored ?? [])
    .filter((w) => w.key !== "research")
    .map(
      (w) =>
        `${w.file}: ${w.key === "mode" ? `mode = "${w.value}"` : `fetch_allow "${w.value}"`} ignored (a project's file may only narrow)`,
    );
}

/** Sources for this project, starting the private SearXNG when web access is on. */
export async function researchSources(
  repoPath: string,
  opts: { forceWeb?: boolean; ensure?: typeof ensureSearxng; log?: EventLog } = {},
): Promise<{ web: WebConfig | undefined; status: SourceStatus }> {
  // NEW-security-8 (security item 29a): `[network] research` in config.toml.
  const { policy, project } = researchPolicy(repoPath);
  const nets = { project };
  const ignored = ignoredLines(policy);
  // DS-N4-3: every reader below refuses a denied host, naming the file and rule.
  const deny = policy.denyRules ?? [];
  // SEC-52b: a project's `research = "no"` means no research request for it.
  if (nets.project.research === "no" && opts.forceWeb !== true) {
    return {
      web: undefined,
      status: {
        web: false,
        search: 'off (this project\'s config.toml: research = "no")',
        pages: "off",
        ignored,
      },
    };
  }
  // SEC-52a: the person's yes is research's one exception to `mode`; every
  // request goes through the one network policy and onto the ledger.
  if (policy.research === "yes" && opts.log) {
    // NEW-security-8: `gh` and Crawl4AI pass the same policy, logged; a
    // browser's own sub-requests are beyond it, so Crawl4AI runs only where
    // the policy refuses no public host.
    const browser = policyAllowsEveryHost(policy, { research: true });
    const web = webConfigFromEnv({
      fetch: researchFetch(repoPath, opts.log),
      gate: researchGate(repoPath, opts.log),
      browser,
      deny,
    });
    return {
      web,
      status: {
        web: true,
        search: process.env.SEKHEMET_SEARXNG_URL
          ? `SearXNG (${process.env.SEKHEMET_SEARXNG_URL})`
          : "none configured",
        pages: web.crawler
          ? 'Crawl4AI (rendered), each page through the network policy (config.toml: research = "yes")'
          : `plain HTML reader, through the network policy (config.toml: research = "yes")${browser ? "" : "; Crawl4AI off while fetch_allow or fetch_deny limits research"}`,
        ignored,
      },
    };
  }
  // H15: config.toml [network] mode, when the user set it, outranks the
  // Integrations switch: "offline" means no web, "allowlist" limits reads.
  const mode = explicitNetworkMode(repoPath);
  if (mode === "offline" && opts.forceWeb !== true) {
    return {
      web: undefined,
      status: {
        web: false,
        search: "off (config.toml network.mode = offline)",
        pages: "off",
        ignored,
      },
    };
  }
  const on = opts.forceWeb ?? readSettings(repoPath).researchWeb === true;
  if (!on) {
    return {
      web: undefined,
      status: { web: false, search: "off (project setting)", pages: "off", ignored },
    };
  }
  const allowOnly =
    mode === "allowlist" ? effectiveConfig(repoPath).config.network.allow : undefined;
  if (
    !process.env.SEKHEMET_SEARXNG_URL &&
    !process.env.BRAVE_SEARCH_API_KEY &&
    !process.env.TAVILY_API_KEY
  ) {
    const url = await (opts.ensure ?? ensureSearxng)().catch(() => undefined);
    if (url) process.env.SEKHEMET_SEARXNG_URL = url;
  }
  const web = webConfigFromEnv({ ...(allowOnly ? { allowOnly } : {}), deny });
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
      ignored,
    },
  };
}

export interface AskOptions {
  /** Deep research: `standard` effort unless `effort` says otherwise. */
  deep?: boolean;
  /** How hard to look (DS-N4-1); else a research card's `effort:` label, else by `deep`. */
  effort?: ResearchEffort;
  cardId?: string;
  /** Skip memory (always research afresh). */
  fresh?: boolean;
  /**
   * The question carries text that stays on this machine (the repair
   * question: a card's spec, a gate's output, DS-N5-1): refused rather than
   * sent to a Researcher whose server is remote.
   */
  localOnly?: boolean;
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
      mcp?: import("../mcp_client.js").McpHub | undefined;
      /** The ledger: every question, its sources and verdict, recorded (X5). */
      log?: import("@sekhemet/kernel").EventLog | undefined;
    },
  ) {}

  private get memory(): ResearchMemory {
    return this.deps.memory ?? new ResearchMemory();
  }

  async ask(question: string, opts: AskOptions = {}): Promise<AskResult> {
    const askedAt = Date.now();
    const card = opts.cardId
      ? await this.deps.cardStore?.getCard?.(opts.cardId).catch(() => undefined)
      : undefined;
    const effort: ResearchEffort =
      opts.effort ?? effortOfLabels(card?.labels) ?? (opts.deep ? "standard" : "quick");
    const caps = EFFORT_CAPS[effort];
    const scope: MemoryScope = {
      repo: this.deps.repoPath,
      packages: packagesInQuestion(this.deps.repoPath, question),
      effort,
    };
    const known = opts.fresh ? undefined : this.memory.recall(question, scope);
    let result: AskResult;
    if (known) {
      result = {
        ...(known.effort ? { effort: known.effort } : {}),
        ...withClaims({
          answer: `${known.answer}\n\n(From research memory, ${known.at.slice(0, 10)}.)`,
          sources: known.sources,
          evidence: known.sources.map((ref) => ({ kind: "memory", ref })),
          grounded: true,
          confidence: known.confidence,
          badCitations: [],
        }),
        fromMemory: true,
      };
    } else {
      const model = await this.deps.model();
      if (opts.localOnly && model.remote === true) {
        throw new Error(
          `Refusing to research this question on ${model.modelId}: its server is not on this machine, and the question carries an issue's description and a check's output, which stay here.`,
        );
      }
      // DS-N2-9: the pipeline the latest golden-set run recommends for this model.
      const pipeline = this.deps.log
        ? (await researchPipelineAdvice(this.deps.log).catch(() => [])).find(
            (v) => v.model === model.modelId,
          )?.recommended
        : undefined;
      const rdeps: ResearchDeps = {
        ...(pipeline ? { pipeline } : {}),
        repoPath: this.deps.repoPath,
        web: this.deps.web,
        ...this.deps.tools,
        ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}),
        ...(this.deps.mcp ? { mcp: this.deps.mcp } : {}),
        ...(this.deps.today ? { today: this.deps.today } : {}),
        ...(this.deps.maxRounds ? { maxRounds: this.deps.maxRounds } : {}),
      };
      // The effort's recorded caps (DS-N4-1): sub-questions, page reads per
      // sub-question, and the critique pass's candidates.
      const r =
        effort === "quick"
          ? await research(model, question, { ...rdeps, maxPages: caps.pagesPerSubQuestion })
          : await investigate(model, question, rdeps, {
              maxItems: caps.subQuestions,
              subRounds: caps.turnsPerSubQuestion,
              pagesPerSubQuestion: caps.pagesPerSubQuestion,
              critiqueCandidates: caps.critiqueCandidates,
            });
      result = { ...r, effort, fromMemory: false };
      // Keep only what can be trusted later: grounded, cited, confident.
      if (r.grounded && r.badCitations.length === 0 && r.confidence >= 0.35) {
        this.memory.remember({
          question,
          answer: r.answer,
          sources: r.sources,
          confidence: r.confidence,
          at: new Date().toISOString(),
          repo: this.deps.repoPath,
          packages: scope.packages,
          effort,
        });
      }
    }
    await this.deps.log
      ?.append({
        actor: "researcher",
        type: "research/asked",
        ...(opts.cardId ? { cardId: opts.cardId } : {}),
        // The question can carry a card's spec and a gate's output (the
        // repair batch's): private and erasable (kernel rule 33), never in
        // the hashed, exported payload.
        private: { question: question.slice(0, 1000) },
        payload: {
          deep: effort !== "quick",
          effort,
          fromMemory: result.fromMemory,
          grounded: result.grounded,
          confidence: result.confidence,
          sources: result.sources.slice(0, 20),
          badCitations: result.badCitations,
          ms: Date.now() - askedAt,
        },
      })
      .catch(() => undefined);
    // DS-N5-3: the answer is stored whole on the card's dossier (`card/research`),
    // scoped to that card, with every source it read.
    if (opts.cardId && this.deps.cardStore && result.grounded) {
      await this.deps.cardStore
        .recordDossierEntry({
          cardId: opts.cardId,
          kind: "research",
          text: `Q: ${question.split("\n")[0]?.slice(0, 300) ?? ""}\nA: ${result.answer}\nSources: ${result.sources.join("; ")}`,
          ...(result.sources.length ? { sources: result.sources } : {}),
        })
        .catch(() => undefined);
    }
    return result;
  }
}

/**
 * A one-shot Researcher for callers that do not hold a model router (the
 * dashboard's Seshat): load, ask, unload. A 16 GB model is not left resident
 * behind a chat message.
 */
export function oneShotResearcher(
  repoPath: string,
  modelName: string,
  cardStore?: CardStore,
  log?: import("@sekhemet/kernel").EventLog,
): (question: string, opts?: AskOptions) => Promise<AskResult> {
  return async (question, opts = {}) => {
    const { web } = await researchSources(repoPath, log ? { log } : {});
    const model = researcherModel(modelName, sharedModelAccess(), log);
    const service = new ResearchService({
      repoPath,
      web,
      ...(cardStore ? { cardStore } : {}),
      ...(log ? { log } : {}),
      model: model.acquire,
    });
    try {
      return await service.ask(question, opts);
    } finally {
      await model.release().catch(() => undefined);
    }
  };
}

/**
 * Official documentation for the Worker's `docs` tool, from the web, without
 * any model: the docs reader (llms.txt first, then the sitemap), the polite
 * fetcher (robots, pacing, 7-day cache) and focused excerpts. Undefined when
 * the project has research web access off or config.toml says offline.
 */
export async function workerWebDocs(
  repoPath: string,
): Promise<((library: string, query: string) => Promise<string>) | undefined> {
  const { web } = await researchSources(repoPath, { ensure: async () => undefined });
  if (!web) return undefined;
  const { readDocs } = await import("./docs.js");
  const polite = web.polite;
  const fetchText = async (u: string) => {
    const res = polite ? await polite.fetch(u, {}, true) : await fetch(u);
    return res.ok ? res.text() : undefined;
  };
  return async (library, query) => {
    const r = await readDocs(library, query, fetchText, {
      maxFetch: 6,
      maxPages: 2,
      charsPerPage: 2500,
    });
    if (typeof r === "string") return r;
    if (r.pages.length === 0) return `No readable documentation pages under ${r.root}.`;
    return r.pages.map((p) => `## ${p.title}\n${p.url}\n${p.text}`).join("\n\n");
  };
}
