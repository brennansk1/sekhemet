import type { EventLog } from "@sekhemet/kernel";
import type { CardStore } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { mergeNetworkConfigs } from "@sekhemet/sandbox";
import { networkConfigs } from "../config_apply.js";
import type { NetworkTable } from "../config_apply.js";
import { sharedModelAccess } from "../model_access.js";
import { type Fetcher, type LibrarySearch, searchLibraries } from "../pm/libraries.js";
import {
  RESEARCH_HOSTS,
  ResearchHostAwaitsYes,
  askResearchOnce,
  awaitingResearchHosts,
  recordResearchHostsAnswer,
  researchFetch,
  researchHostRefusal,
  researchPolicy,
  unaskedResearchHosts,
} from "../research_consent.js";
import { runnerLease } from "../runner_lease.js";
import type { ConfigWrite } from "../team/config_audit.js";
import { DEPS_DEV_HOST, depsDevVersion } from "./deps_dev.js";
import type { PlanResearcherBatch } from "./packet.js";
import type { ResearchDeps } from "./researcher.js";
import {
  type DeepAnswer,
  type DeepPriorArt,
  DeepQuestionSkipped,
  type ResearchQuery,
  type ReuseDeps,
  searchRepos,
} from "./reuse.js";
import { ResearchService, researchSources, researcherModel } from "./service.js";
import { searchPapers } from "./web.js";

/**
 * `plan`'s research (design-stage S8): the reuse survey looks for what exists
 * only when a person allowed research, through the one network policy, with
 * each query on the ledger. Otherwise `plan` makes no request and says that
 * it did not look.
 */

/** Every host the plan's survey may reach; the question names each one (DS-S8-2). */
export { RESEARCH_HOSTS };

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface PlanResearchOptions {
  repoPath: string;
  log: EventLog;
  /** `--offline` or `SEKHEMET_OFFLINE=1`. */
  offline?: boolean;
  /** The first plan of a new project: the moment to ask (O16's default). */
  newProject: boolean;
  print: (line: string) => void;
  /** Asks the person; absent (no terminal), nothing is asked and nothing recorded. */
  ask?: (question: string) => Promise<boolean>;
  /** Injectable for tests; the product uses the research fetch of security item 29a. */
  fetchImpl?: Fetch;
  /**
   * Records an answer's write to the user config.toml as Sekhemet's own
   * (`config/changed` with the person, TEAM-44); `plan` passes it. Only a
   * run that may ask (`newProject` with `ask`) writes.
   */
  recordConfigWrite?: ConfigWrite;
}

const NOT_LOOKED = "Did not look for existing packages, repositories or papers";

/**
 * JSON over a fetch, one request per URL: a Python need's GitHub search
 * serves both its PyPI lookup and its repositories (DS-P7-5). A failure is
 * not kept, so a later need may try again.
 */
function jsonOnce(
  f: Fetch,
  /** Told of each request actually sent, once, with its status and body. */
  sentOne?: (url: string, status: number | undefined, body: unknown) => Promise<void>,
): Fetcher {
  const sent = new Map<string, Promise<unknown>>();
  return (url) => {
    const known = sent.get(url);
    if (known) return known;
    const request = (async () => {
      let res: Response;
      try {
        res = await f(url, {
          headers: { "User-Agent": "sekhemet", Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
      } catch (err) {
        await sentOne?.(url, undefined, undefined);
        throw err;
      }
      const body = res.ok ? await res.json() : undefined;
      await sentOne?.(url, res.status, body);
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return body;
    })();
    sent.set(url, request);
    request.catch(() => sent.delete(url));
    return request;
  };
}

/**
 * The survey's sources for this plan, or undefined — with the reason printed —
 * when it must not look (DS-S8-1, -2, -6). No request is made here.
 */
export async function planResearch(o: PlanResearchOptions): Promise<ReuseDeps | undefined> {
  if (o.offline) {
    o.print(`${NOT_LOOKED}: offline (--offline or SEKHEMET_OFFLINE).`);
    return undefined;
  }
  const n = networkConfigs(o.repoPath);
  if (n.project.research === "no") {
    o.print(`${NOT_LOOKED}: this project's config.toml says research = "no".`);
    return undefined;
  }
  let allowed = mergeNetworkConfigs(n.user, n.project).research === "yes";
  if (!allowed && n.user.research === undefined && o.newProject && o.ask) {
    const ask = o.ask;
    const answer = await askResearchOnce({
      hosts: RESEARCH_HOSTS,
      ...(o.recordConfigWrite ? { record: o.recordConfigWrite } : {}),
      ask: () =>
        ask(
          `Look for existing packages, repositories and papers before planning? A yes lets Sekhemet's own research reach ${RESEARCH_HOSTS.join(", ")} (short keyword queries only, each logged); the commands an issue runs still get no network. [y/N] `,
        ),
    });
    allowed = answer === "yes";
  }
  if (!allowed) {
    o.print(
      `${NOT_LOOKED}: research is off (set [network] research = "yes" in your config.toml to allow it).`,
    );
    return undefined;
  }
  // DS-S8-8: a yes covers exactly the hosts its question named. A host added
  // since is asked about once, on a new project's plan with a terminal, and
  // is not reached until a yes names it.
  const unasked = unaskedResearchHosts(networkConfigs(o.repoPath).user);
  if (unasked.length && o.newProject && o.ask) {
    const yes = await o.ask(
      `Research may also reach ${unasked.join(", ")}, which your earlier yes to research did not name (short keyword queries only, each logged; the commands an issue runs still get no network). Allow ${unasked.length === 1 ? "it" : "them"} too? [y/N] `,
    );
    recordResearchHostsAnswer(yes, unasked, undefined, o.recordConfigWrite);
  }
  const user = networkConfigs(o.repoPath).user;
  const awaiting = awaitingResearchHosts(user);
  if (awaiting.length) {
    const declined = awaiting.filter((h) => user.researchHostsDeclined?.includes(h));
    const waiting = awaiting.filter((h) => !declined.includes(h));
    if (waiting.length)
      o.print(
        `Research does not reach ${waiting.join(", ")}: ${waiting.length === 1 ? "it awaits" : "they await"} a yes (the research question you answered did not name ${waiting.length === 1 ? "it" : "them"}; a new project's plan in a terminal asks, or add ${waiting.length === 1 ? "it" : "them"} to [network] research_hosts).`,
      );
    if (declined.length)
      o.print(
        `Research does not reach ${declined.join(", ")}: you said no to ${declined.length === 1 ? "it" : "them"} ([network] research_hosts_declined).`,
      );
  }
  const f: Fetch = o.fetchImpl ? coveredOnly(o.fetchImpl, user) : researchFetch(o.repoPath, o.log);
  // DS-S8-3: the keywords and the names found are free text: the private part.
  const record = async (q: ResearchQuery) => {
    await o.log
      .append({
        actor: "harness",
        type: "research/query",
        payload: {
          source: q.source,
          ok: q.ok,
          count: q.results.length,
          ...(q.origin ? { origin: q.origin } : {}),
        },
        private: {
          query: q.query,
          ...(q.language ? { language: q.language } : {}),
          results: q.results,
        },
      })
      .catch(() => undefined);
  };
  // DS-S8-3: a PyPI project looked up by a name GitHub returned is a query
  // sent too: recorded with the name, and the project found (none on a 404).
  const json = jsonOnce(f, async (url, status, body) => {
    const name = PYPI_PROJECT.exec(url)?.[1];
    if (!name) return;
    const found = (body as { info?: { name?: string } } | undefined)?.info?.name;
    await record({
      source: "pypi-name",
      query: decodeURIComponent(name),
      results: found ? [found] : [],
      ok: status !== undefined && (status < 400 || status === 404),
    });
  });
  return {
    // DS-P7-5: the project's registry — npm, or PyPI by verified name — never the other.
    libraries: registryCovered(
      (q, ecosystem) => searchLibraries(q, ecosystem ?? "npm", json),
      user,
    ),
    repos: (q, language) => searchRepos(q, json, language),
    papers: (q) => searchPapers(q, { fetch: (u, i) => f(u, i) }),
    // DEC-44: deps.dev through the same policy; refused before sending while
    // the person's yes does not name it (DS-S8-8).
    depsDev: (ecosystem, name, version) => {
      const reason = researchHostRefusal(DEPS_DEV_HOST, user);
      return reason
        ? Promise.reject(new ResearchHostAwaitsYes(DEPS_DEV_HOST, reason))
        : depsDevVersion(ecosystem, name, version, json);
    },
    record,
  };
}

/**
 * The registry search for Seshat's `find_library`: through the research
 * policy like the survey's (fetch_allow, fetch_deny, each request a
 * `harness/egress` event), or undefined — nothing is searched and the tool
 * says so — when the person has not allowed research or the project turned
 * it off (DS-S8-1, DS-S8-6).
 */
export function registrySearch(repoPath: string, log: EventLog): LibrarySearch | undefined {
  const { policy, project, user } = researchPolicy(repoPath);
  if (policy.research !== "yes" || project.research === "no") return undefined;
  const json = jsonOnce(researchFetch(repoPath, log));
  return registryCovered((q, ecosystem) => searchLibraries(q, ecosystem ?? "npm", json), user);
}

/**
 * A fetch that refuses, before sending, a research host the person's yes did
 * not name (DS-S8-8): the check `researchFetch` makes, for a fetch handed in.
 */
function coveredOnly(f: Fetch, user: NetworkTable): Fetch {
  return async (input, init) => {
    const host = new URL(String(input)).hostname;
    const reason = researchHostRefusal(host, user);
    if (reason) throw new ResearchHostAwaitsYes(host, reason);
    return f(input, init);
  };
}

/**
 * A registry search refused, before any request, when the yes did not name
 * its registry (DS-S8-8): a PyPI search's GitHub query serves only its PyPI
 * lookup, so nothing is sent for it.
 */
function registryCovered(search: LibrarySearch, user: NetworkTable): LibrarySearch {
  return (q, ecosystem) => {
    const host = (ecosystem ?? "npm") === "pypi" ? "pypi.org" : "registry.npmjs.org";
    const reason = researchHostRefusal(host, user);
    return reason ? Promise.reject(new ResearchHostAwaitsYes(host, reason)) : search(q, ecosystem);
  };
}

const PYPI_PROJECT = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/json$/;

/**
 * Whether the brief's deep question may run (DS-P7-10), and why not when it
 * may not: `plan` is offline, research is not allowed, no Researcher is
 * configured, or a card is running — the Researcher is a second large model
 * and would compete with the Worker for this machine's memory. Checked when
 * `plan` starts, and again just before the Researcher loads; nothing is
 * loaded here.
 */
export function deepPriorArtFor(o: {
  repoPath: string;
  /** The survey may look (`planResearch` returned its sources). */
  allowed: boolean;
  offline: boolean;
  /** The Researcher's model (`--researcher`, the assignment, or SEKHEMET_RESEARCHER). */
  researcher: string | undefined;
  /** Asks the Researcher; the product loads it once, asks, and unloads it. */
  ask: (question: string) => Promise<DeepAnswer>;
  /**
   * The plan's one Researcher load (DS-N9-16): the deep question and the
   * research packet's questions together. Checked against the lease as
   * `ask` is.
   */
  batch?: PlanResearcherBatch;
}): DeepPriorArt & { batch?: PlanResearcherBatch } {
  if (o.offline) return { skipped: "plan ran offline (--offline or SEKHEMET_OFFLINE)" };
  if (!o.allowed) return { skipped: "research is off for this plan, so nothing was looked up" };
  if (!o.researcher)
    return {
      skipped:
        "no Research model is configured (name one with --researcher or SEKHEMET_RESEARCHER, or assign one with sekhemet models assign researcher <model>)",
    };
  const busy = () => {
    const holder = runnerLease(o.repoPath);
    if (!holder) return undefined;
    const what = holder.cardId
      ? `issue ${holder.cardId} is running`
      : `a ${holder.kind ?? "run"} holds the machine`;
    return `${what} (pid ${holder.pid}), and the Research model would compete with it for memory; plan again when it ends`;
  };
  const now = busy();
  if (now) return { skipped: now };
  // Planning can take minutes: a card started meanwhile is caught here,
  // just before the Researcher would load beside it.
  const batch = o.batch;
  return {
    run: async (question) => {
      const later = busy();
      if (later) throw new DeepQuestionSkipped(later);
      return o.ask(question);
    },
    ...(batch
      ? {
          batch: async (q: Parameters<PlanResearcherBatch>[0]) => {
            const later = busy();
            if (later) throw new DeepQuestionSkipped(later);
            return batch(q);
          },
        }
      : {}),
  };
}

/**
 * The Researcher's tools for the brief's deep question: the registries
 * through the research policy, and nothing that reads this repository. The
 * question is built from the needs' keywords only, and without the
 * repository tools the model has nothing of the repository to put in a
 * query (design-stage S8).
 */
export function deepQuestionDeps(o: {
  repoPath: string;
  fetchJson: Fetcher;
}): Pick<ResearchDeps, "repoPath" | "fetchJson" | "libraries" | "repository"> {
  return {
    repoPath: o.repoPath,
    fetchJson: o.fetchJson,
    libraries: registryCovered(
      (q, ecosystem) => searchLibraries(q, ecosystem ?? "npm", o.fetchJson),
      networkConfigs(o.repoPath).user,
    ),
    repository: false,
  };
}

/**
 * The Researcher for the plan (DS-P7-10, DS-N9-16): loaded once, asked the
 * brief's deep question at the deep effort with nothing of the repository,
 * then each research-packet question at the quick effort with the tools
 * that read the installed dependencies (`deps_source`, `deps_grep`,
 * `probe`) and never the project's own; unloaded after the last. Its
 * registry tools fetch through the research policy like the survey's
 * (fetch_allow, fetch_deny, each request logged as `harness/egress`); its
 * web is the project's research web access. A packet answer is kept as a
 * note, never in research memory. The caller releases the Planner's model
 * first.
 */
export function planResearcher(o: {
  repoPath: string;
  log: EventLog;
  cardStore?: CardStore;
  model: string;
  /** The Researcher's hold; the shared model access's by default (tests hand one in). */
  hold?: () => { acquire: () => Promise<LocalInferenceAdapter>; release: () => Promise<void> };
}): PlanResearcherBatch {
  return async ({ deep, packet }) => {
    const { web } = await researchSources(o.repoPath, { log: o.log });
    const model = o.hold ? o.hold() : researcherModel(o.model, sharedModelAccess(), o.log);
    const fetchJson = jsonOnce(researchFetch(o.repoPath, o.log));
    const service = (tools: ResearchServiceTools) =>
      new ResearchService({
        repoPath: o.repoPath,
        web,
        log: o.log,
        ...(o.cardStore ? { cardStore: o.cardStore } : {}),
        model: model.acquire,
        tools,
      });
    const failed = (err: unknown) => ({
      failed: err instanceof Error ? err.message : String(err),
    });
    try {
      const out: Awaited<ReturnType<PlanResearcherBatch>> = { packet: [], model: o.model };
      if (deep !== undefined) {
        try {
          const r = await service(deepQuestionDeps({ repoPath: o.repoPath, fetchJson })).ask(deep, {
            deep: true,
          });
          out.deep = { answer: r.answer, sources: r.sources, grounded: r.grounded };
        } catch (err) {
          out.deep = failed(err);
        }
      }
      const asker = packet.length
        ? service(packetQuestionDeps({ repoPath: o.repoPath, fetchJson }))
        : undefined;
      for (const question of packet) {
        try {
          const r = await (asker as ResearchService).ask(question, {
            effort: "quick",
            fresh: true,
            remember: false,
          });
          out.packet.push({
            answer: r.answer,
            sources: r.sources,
            grounded: r.grounded,
            evidence: r.evidence,
            ...(r.probeClaims ? { probeClaims: r.probeClaims } : {}),
          });
        } catch (err) {
          out.packet.push(failed(err));
        }
      }
      return out;
    } finally {
      await model.release().catch(() => undefined);
    }
  };
}

type ResearchServiceTools = Pick<ResearchDeps, "fetchJson" | "libraries" | "repository">;

/**
 * The Researcher's tools for a research-packet question (DS-N9-16): the
 * registries through the research policy, and of the repository tools only
 * those that read the installed dependencies — the question carries a
 * symbol and `pkg@ver` alone, and the project's own code stays unread.
 */
export function packetQuestionDeps(o: {
  repoPath: string;
  fetchJson: Fetcher;
}): ResearchServiceTools {
  return { ...deepQuestionDeps(o), repository: "dependencies" };
}
