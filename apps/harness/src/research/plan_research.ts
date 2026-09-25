import type { EventLog } from "@sekhemet/kernel";
import { mergeNetworkConfigs } from "@sekhemet/sandbox";
import { networkConfigs } from "../config_apply.js";
import { searchLibraries } from "../pm/libraries.js";
import { askResearchOnce, researchFetch } from "../research_consent.js";
import { type ReuseDeps, searchRepos } from "./reuse.js";
import { searchPapers } from "./web.js";

/**
 * `plan`'s research (design-stage S8): the reuse survey looks for what exists
 * only when a person allowed research, through the one network policy, with
 * each query on the ledger. Otherwise `plan` makes no request and says that
 * it did not look.
 */

/** Every host the plan's survey may reach; the question names each one (DS-S8-2). */
export const RESEARCH_HOSTS = [
  "registry.npmjs.org",
  "api.github.com",
  "huggingface.co",
  "export.arxiv.org",
  "api.openalex.org",
] as const;

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
}

const NOT_LOOKED = "Did not look for existing packages, repositories or papers";

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
      ask: () =>
        ask(
          `Look for existing packages, repositories and papers before planning? A yes lets Sekhemet's own research reach ${RESEARCH_HOSTS.join(", ")} (short keyword queries only, each logged); card commands still get no network. [y/N] `,
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
  const f: Fetch = o.fetchImpl ?? researchFetch(o.repoPath, o.log);
  const json = async (url: string): Promise<unknown> => {
    const res = await f(url, {
      headers: { "User-Agent": "sekhemet", Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
    return res.json();
  };
  return {
    libraries: (q) => searchLibraries(q, "npm", json),
    repos: (q) => searchRepos(q, json),
    papers: (q) => searchPapers(q, { fetch: (u, i) => f(u, i) }),
    // DS-S8-3: the keywords and the names found are free text: the private part.
    record: async (q) => {
      await o.log
        .append({
          actor: "harness",
          type: "research/query",
          payload: { source: q.source, ok: q.ok, count: q.results.length },
          private: { query: q.query, results: q.results },
        })
        .catch(() => undefined);
    },
  };
}
