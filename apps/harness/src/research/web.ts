import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { judgeLicence, licenceVerdictWords } from "../pm/libraries.js";
import { Crawl4AiSidecar, type PageCrawler, crawl4aiInstalled } from "./crawl4ai.js";
import { focusChunks } from "./docs.js";
import { PoliteFetcher, ResearchCache, USER_AGENT, isPrivateHost } from "./polite.js";
import { researchCopy } from "./research_copy.js";
import { rankHits } from "./sources.js";

/**
 * The Researcher's reach beyond the repository: papers, the web, GitHub.
 *
 * Only legitimate, documented interfaces: the arXiv API, Hugging Face Papers,
 * Semantic Scholar (optional key), a web search provider the user configures
 * (a self-hosted SearXNG, or Brave / Tavily with the user's own key), plain
 * page fetches reduced to text, and GitHub search through the user's `gh`
 * login. No scraping of search engines whose terms forbid it. Everything is
 * read-only; what leaves the machine is the query text and the URLs fetched.
 */

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface WebConfig {
  fetch?: Fetcher;
  searxngUrl?: string;
  braveKey?: string;
  tavilyKey?: string;
  semanticScholarKey?: string;
  /** Injectable for tests: runs `gh` with these args and returns stdout. */
  gh?: (args: string[]) => Promise<string>;
  /** Pacing, robots.txt and cache for every outbound request (see polite.ts). */
  polite?: PoliteFetcher;
  /** A real contact for OpenAlex's polite pool (SEKHEMET_CONTACT); never invented. */
  contact?: string;
  /** A browser-backed reader (Crawl4AI) for pages; the plain reader is the fallback. */
  crawler?: PageCrawler;
  /**
   * The network policy for requests not sent through `fetch` — a `gh` call,
   * a page the crawler reads: throws the refusal, logs either way (NEW-security-8).
   */
  gate?: (url: string, via: string) => Promise<void>;
}

let crawlerSingleton: Crawl4AiSidecar | undefined;
/** One warm browser per process. */
export function sharedCrawler(): Crawl4AiSidecar {
  crawlerSingleton ??= new Crawl4AiSidecar();
  return crawlerSingleton;
}

export function webConfigFromEnv(
  opts: {
    allowOnly?: string[];
    fetch?: (u: string, i?: RequestInit) => Promise<Response>;
    gate?: (url: string, via: string) => Promise<void>;
    /** False: no browser reader, since the policy could not see its own requests. */
    browser?: boolean;
    /** `[network] fetch_deny` with each rule's file (DS-N4-3): never fetched, not even cached. */
    deny?: import("@sekhemet/sandbox").NetworkRule[];
  } = {},
): WebConfig {
  const env = process.env;
  const searx = env.SEKHEMET_SEARXNG_URL;
  let searxHost: string | undefined;
  try {
    searxHost = searx ? new URL(searx).host : undefined;
  } catch {
    searxHost = undefined;
  }
  return {
    // The user's own SearXNG may live on the LAN; it is the one private host allowed.
    polite: new PoliteFetcher({
      // Research through the one network policy, when the caller hands it (SEC-52a).
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.allowOnly ? { allowOnly: opts.allowOnly } : {}),
      ...(opts.deny?.length ? { deny: opts.deny } : {}),
      cache: new ResearchCache(),
      ...(searxHost ? { allowHosts: [searxHost] } : {}),
    }),
    ...(env.SEKHEMET_CONTACT ? { contact: env.SEKHEMET_CONTACT } : {}),
    ...(opts.browser !== false && crawl4aiInstalled() && env.SEKHEMET_CRAWL4AI !== "off"
      ? { crawler: sharedCrawler() }
      : {}),
    ...(opts.gate ? { gate: opts.gate } : {}),
    ...(env.SEKHEMET_SEARXNG_URL ? { searxngUrl: env.SEKHEMET_SEARXNG_URL } : {}),
    ...(env.BRAVE_SEARCH_API_KEY ? { braveKey: env.BRAVE_SEARCH_API_KEY } : {}),
    ...(env.TAVILY_API_KEY ? { tavilyKey: env.TAVILY_API_KEY } : {}),
    ...(env.SEMANTIC_SCHOLAR_API_KEY ? { semanticScholarKey: env.SEMANTIC_SCHOLAR_API_KEY } : {}),
  };
}

const UA = { "User-Agent": USER_AGENT };
const get = (cfg: WebConfig) =>
  cfg.polite
    ? (u: string, i?: RequestInit) => (cfg.polite as PoliteFetcher).fetch(u, i)
    : (cfg.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i)));
const timeout = () => AbortSignal.timeout(12_000);

export interface Hit {
  title: string;
  url: string;
  snippet: string;
  meta?: string;
}

export function formatWebHits(hits: Hit[]): string {
  if (hits.length === 0) return "No results.";
  return hits
    .map(
      (h, i) =>
        `${i + 1}. ${h.title}${h.meta ? ` (${h.meta})` : ""}\n   ${h.url}\n   ${h.snippet.replace(/\s+/g, " ").slice(0, 280)}`,
    )
    .join("\n");
}

/** Papers from Hugging Face Papers and arXiv (and Semantic Scholar with a key). */
export async function searchPapers(query: string, given: WebConfig = {}): Promise<Hit[]> {
  // DS-S8-5: an outage of every index is "not searched (unreachable)", so it
  // throws; an index that answers with nothing is "nothing found".
  let reached = false;
  const base = get(given);
  const f = async (u: string, i?: RequestInit) => {
    const res = await base(u, i);
    if (res.ok) reached = true;
    return res;
  };
  const { polite: _polite, ...rest } = given;
  const cfg: WebConfig = { ...rest, fetch: f };
  const hits: Hit[] = [];
  const seen = new Set<string>();
  try {
    const res = await f(`https://huggingface.co/api/papers/search?q=${encodeURIComponent(query)}`, {
      headers: UA,
      signal: timeout(),
    });
    if (res.ok) {
      const list = (await res.json()) as {
        paper?: { id?: string; upvotes?: number };
        title?: string;
        summary?: string;
        publishedAt?: string;
      }[];
      for (const p of list.slice(0, 6)) {
        const id = p.paper?.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        hits.push({
          title: p.title ?? id,
          url: `https://arxiv.org/abs/${id}`,
          snippet: p.summary ?? "",
          meta: `arXiv ${id}, ${p.publishedAt?.slice(0, 10) ?? "?"}, ${p.paper?.upvotes ?? 0} upvotes`,
        });
      }
    }
  } catch {
    // Fall through to arXiv.
  }
  try {
    const res = await f(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(`"${query}"`)}&max_results=5&sortBy=relevance`,
      { headers: UA, signal: timeout() },
    );
    if (res.ok) {
      const xml = await res.text();
      for (const entry of xml.split("<entry>").slice(1)) {
        const id = /<id>https?:\/\/arxiv\.org\/abs\/([^<v]+)(?:v\d+)?<\/id>/.exec(entry)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title =
          /<title>([\s\S]*?)<\/title>/.exec(entry)?.[1]?.replace(/\s+/g, " ").trim() ?? id;
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(entry)?.[1]?.trim() ?? "";
        const published = /<published>(\d{4}-\d{2}-\d{2})/.exec(entry)?.[1] ?? "?";
        hits.push({
          title,
          url: `https://arxiv.org/abs/${id}`,
          snippet: summary,
          meta: `arXiv ${id}, ${published}`,
        });
      }
    }
  } catch {
    // Keep what we have.
  }
  if (cfg.semanticScholarKey) {
    try {
      const res = await f(
        `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=5&fields=title,year,abstract,citationCount,externalIds,url`,
        { headers: { ...UA, "x-api-key": cfg.semanticScholarKey }, signal: timeout() },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          data?: {
            title: string;
            year?: number;
            abstract?: string;
            citationCount?: number;
            url?: string;
            externalIds?: { ArXiv?: string };
          }[];
        };
        for (const p of body.data ?? []) {
          const id = p.externalIds?.ArXiv;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          hits.push({
            title: p.title,
            url: id ? `https://arxiv.org/abs/${id}` : (p.url ?? ""),
            snippet: p.abstract ?? "",
            meta: `${p.year ?? "?"}, ${p.citationCount ?? 0} citations`,
          });
        }
      }
    } catch {
      // Optional source.
    }
  }
  if (hits.length < 8) {
    try {
      for (const h of await searchOpenAlex(query, cfg, 5)) {
        const id = /arXiv (\S+)/.exec(h.meta ?? "")?.[1];
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        hits.push(h);
      }
    } catch {
      // Optional source.
    }
  }
  if (!reached) throw new Error("literature unreachable: no paper index answered");
  return hits.slice(0, 10);
}

/** Strip HTML to readable text: scripts, styles, navigation and tags removed. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|nav|header|footer|svg|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)>/gi, "\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n) => `\n${"#".repeat(Number(n))} `)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Fetch a page as text. Only http(s); private and loopback hosts refused. */
export async function fetchPage(
  url: string,
  cfg: WebConfig = {},
  maxChars = 12_000,
  query?: string,
): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Invalid URL.";
  }
  if (!/^https?:$/.test(u.protocol)) return "Only http and https pages can be fetched.";
  // No reaching into the user's network from a model-chosen URL.
  if (isPrivateHost(u.hostname)) return "Refusing to fetch a private or loopback address.";
  // DS-N4-3: a denied host is refused before any cache is read.
  const denied = cfg.polite?.denied(u.toString());
  if (denied) return denied;
  const fit = (text: string) => {
    if (text.length <= maxChars) return text;
    if (query) return focusChunks(text, query, maxChars);
    return `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters)`;
  };
  // A real browser first: most documentation is rendered by JavaScript.
  if (cfg.crawler && !/\.(pdf|xml|json|txt)$/i.test(u.pathname)) {
    const key = `crawl:${u.toString()}`;
    const hit = cfg.polite?.cached(key);
    if (hit) return fit(hit);
    const refused = cfg.polite ? await cfg.polite.permit(u.toString()) : undefined;
    if (refused) return refused;
    // NEW-security-8: the page passes the network policy, and is logged, first.
    try {
      await cfg.gate?.(u.toString(), "crawl4ai");
    } catch (err) {
      return asRefusal(u.hostname, err);
    }
    const r = await cfg.crawler.crawl(u.toString());
    if (r.ok && r.markdown && r.markdown.length > 200) {
      const text = `${r.title ? `# ${r.title}\n\n` : ""}${r.markdown}`;
      cfg.polite?.store(key, text);
      return fit(text);
    }
    // Fall through to the plain reader.
  }
  const init: RequestInit = { headers: UA, signal: timeout(), redirect: "follow" };
  // Page reads honour robots.txt; API calls (search, registries) are not crawling.
  // A fetcher that throws (a refusal, a daily cap, a failed lookup) read
  // nothing: its reason is returned as a refusal, never as the page.
  let res: Response;
  try {
    res = cfg.polite
      ? await cfg.polite.fetch(u.toString(), init, true)
      : await get(cfg)(u.toString(), init);
  } catch (err) {
    return asRefusal(u.hostname, err);
  }
  if (res.status === 451) return "The site's robots.txt disallows fetching this page.";
  if (!res.ok) return `The page answered ${res.status}.`;
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  return fit(/html/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body);
}

/**
 * A failure to read `host` as a refusal `isFetchRefusal` recognises, whatever
 * the thrown message said (a policy gate's own failure, a fetcher's error).
 */
function asRefusal(host: string, err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return isFetchRefusal(why) ? why : researchCopy.unreadable(host, why);
}

/**
 * True when `fetchPage` returned a refusal or a failure rather than a page:
 * such text was not read from the source and never counts as a read.
 */
export function isFetchRefusal(text: string): boolean {
  return /^(Invalid URL|Only http|Refusing|The site's robots|The page answered|network policy refused)/.test(
    text,
  );
}

/** Headings of a text produced by htmlToText ("# Title", "## 3 Method"). */
export function outlineOf(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^#{1,4} \S/.test(l))
    .map((l) => l.trim().slice(0, 100))
    .slice(0, 60);
}

/**
 * A paper's full text from arXiv's HTML rendering, optionally from one
 * section. Without a section it returns the outline first, so the model can
 * ask for the part it needs (delegated reading, as SoL-Pi does for files).
 * Papers without an HTML rendering fall back to the abstract page.
 */
export async function readPaper(
  arxivId: string,
  section: string | undefined,
  cfg: WebConfig = {},
): Promise<string> {
  if (!/^\d{4}\.\d{4,5}$/.test(arxivId)) return "Give an arXiv id like 2605.03042.";
  let text = await fetchPage(`https://arxiv.org/html/${arxivId}`, cfg, 400_000);
  if (isFetchRefusal(text) || text.length < 1500) {
    text = await fetchPage(`https://arxiv.org/abs/${arxivId}`, cfg, 20_000);
    // A refused abstract is a refusal, never a paper read.
    if (isFetchRefusal(text)) return text;
    return `(No HTML full text; abstract page.)\n${text.slice(0, 6000)}`;
  }
  if (!section) {
    const outline = outlineOf(text);
    return `${outline.length ? `SECTIONS\n${outline.join("\n")}\n\n` : ""}${text.slice(0, 10_000)}`;
  }
  const lower = text.toLowerCase();
  const heading = lower.search(
    new RegExp(`\\n#{1,4} [^\\n]*${section.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  const at = heading !== -1 ? heading + 1 : lower.indexOf(section.toLowerCase());
  return at === -1
    ? `No section "${section}". Sections: ${outlineOf(text).join(" | ")}`
    : text.slice(at, at + 12_000);
}

interface OpenAlexWork {
  id: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  ids?: { arxiv?: string; doi?: string };
  referenced_works?: string[];
}

/** OpenAlex stores abstracts as word -> positions; put the words back in order. */
export function invertedAbstract(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [w, positions] of Object.entries(index)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

const OA_FIELDS = "id,doi,title,publication_year,cited_by_count,abstract_inverted_index,ids";

function oaUrl(path: string, cfg: WebConfig): string {
  const sep = path.includes("?") ? "&" : "?";
  return `https://api.openalex.org/${path}${cfg.contact ? `${sep}mailto=${encodeURIComponent(cfg.contact)}` : ""}`;
}

function arxivOf(w: OpenAlexWork): string | undefined {
  const doi = (w.doi ?? w.ids?.doi ?? "").toLowerCase();
  return /10\.48550\/arxiv\.(\d{4}\.\d{4,5})/.exec(doi)?.[1];
}

function oaHit(w: OpenAlexWork): Hit {
  const ax = arxivOf(w);
  return {
    title: w.title ?? w.id,
    url: ax ? `https://arxiv.org/abs/${ax}` : (w.doi ?? w.id),
    snippet: invertedAbstract(w.abstract_inverted_index).slice(0, 600),
    meta: `${w.publication_year ?? "?"}, ${w.cited_by_count ?? 0} citations${ax ? `, arXiv ${ax}` : ""}`,
  };
}

/** Scholarly works from OpenAlex (250M works, free, documented 10/s). */
export async function searchOpenAlex(
  query: string,
  cfg: WebConfig = {},
  limit = 6,
): Promise<Hit[]> {
  const res = await get(cfg)(
    oaUrl(`works?search=${encodeURIComponent(query)}&per-page=${limit}&select=${OA_FIELDS}`, cfg),
    { headers: UA, signal: timeout() },
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { results?: OpenAlexWork[] };
  return (body.results ?? []).map(oaHit);
}

/**
 * Snowballing: the papers a paper cites ("references") or the papers that
 * cite it ("cited_by", most cited first). The standard way to find the work
 * a result builds on and the work that superseded it.
 */
export async function paperCitations(
  id: string,
  direction: "references" | "cited_by",
  cfg: WebConfig = {},
): Promise<Hit[] | string> {
  const key = /^\d{4}\.\d{4,5}$/.test(id)
    ? `doi:10.48550/arXiv.${id}`
    : /^10\./.test(id)
      ? `doi:${id}`
      : /^W\d+$/.test(id)
        ? id
        : undefined;
  if (!key) return "Give an arXiv id, a DOI or an OpenAlex id (W123...).";
  const f = get(cfg);
  const res = await f(oaUrl(`works/${key}?select=id,referenced_works`, cfg), {
    headers: UA,
    signal: timeout(),
  });
  if (!res.ok) return `OpenAlex does not know ${id} (${res.status}).`;
  const work = (await res.json()) as OpenAlexWork;
  const wid = work.id.split("/").pop() ?? "";
  const path =
    direction === "cited_by"
      ? `works?filter=cites:${wid}&sort=cited_by_count:desc&per-page=8&select=${OA_FIELDS}`
      : `works?filter=openalex:${(work.referenced_works ?? [])
          .slice(0, 40)
          .map((w) => w.split("/").pop())
          .join("|")}&sort=cited_by_count:desc&per-page=8&select=${OA_FIELDS}`;
  if (direction === "references" && (work.referenced_works ?? []).length === 0) {
    return "OpenAlex lists no references for it.";
  }
  const list = await f(oaUrl(path, cfg), { headers: UA, signal: timeout() });
  if (!list.ok) return `OpenAlex answered ${list.status}.`;
  return ((await list.json()) as { results?: OpenAlexWork[] }).results?.map(oaHit) ?? [];
}

export interface SearchOptions {
  /** Only these domains (and their subdomains). */
  site?: string[];
  /** Never these domains. */
  exclude?: string[];
  /** Only results from the last day, week, month or year. */
  recency?: "day" | "week" | "month" | "year";
}

const bareDomain = (d: string) =>
  d
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .toLowerCase();

const onDomain = (url: string, domains: string[]) => {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "");
    return domains.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
};

/** General web search with domain and recency filters (as Claude's and Gemini's tools offer). */
export async function webSearch(
  query: string,
  cfg: WebConfig = {},
  opts: SearchOptions = {},
): Promise<Hit[] | string> {
  const site = (opts.site ?? []).map(bareDomain).filter(Boolean);
  const exclude = (opts.exclude ?? []).map(bareDomain).filter(Boolean);
  const raw = await webSearchRaw(
    site.length === 1 ? `${query} site:${site[0]}` : query,
    cfg,
    opts.recency,
  );
  if (typeof raw === "string") return raw;
  const kept = raw.filter(
    (h) => (site.length === 0 || onDomain(h.url, site)) && !onDomain(h.url, exclude),
  );
  return kept.length === 0 && raw.length > 0
    ? `No results on ${site.join(", ") || "the allowed domains"} (${raw.length} elsewhere). Widen the domains or rephrase.`
    : kept;
}

async function webSearchRaw(
  query: string,
  cfg: WebConfig,
  recency: SearchOptions["recency"],
): Promise<Hit[] | string> {
  const f = get(cfg);
  if (cfg.searxngUrl) {
    const res = await f(
      `${cfg.searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json${recency ? `&time_range=${recency}` : ""}`,
      {
        headers: UA,
        signal: timeout(),
      },
    );
    const body = (await res.json()) as {
      results?: { title: string; url: string; content?: string; engine?: string }[];
      unresponsive_engines?: [string, string][];
    };
    // Helga's lesson: an empty page from failing engines is not "nothing exists".
    const dead = (body.unresponsive_engines ?? []).map((e) => `${e[0]} (${e[1]})`);
    if ((body.results ?? []).length === 0 && dead.length > 0) {
      return `Web search is degraded, not empty: ${dead.join(", ")} did not answer. Try again, rephrase, or use scholar_search / read_docs / github_search.`;
    }
    return rankHits(body.results ?? [])
      .slice(0, 8)
      .map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? "",
        ...(r.engine ? { meta: r.engine } : {}),
      }));
  }
  if (cfg.braveKey) {
    const res = await f(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8${recency ? `&freshness=p${recency[0]}` : ""}`,
      {
        headers: { ...UA, Accept: "application/json", "X-Subscription-Token": cfg.braveKey },
        signal: timeout(),
      },
    );
    const body = (await res.json()) as {
      web?: { results?: { title: string; url: string; description?: string }[] };
    };
    return rankHits(body.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: htmlToText(r.description ?? ""),
    }));
  }
  if (cfg.tavilyKey) {
    const res = await f("https://api.tavily.com/search", {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: cfg.tavilyKey,
        query,
        max_results: 8,
        ...(recency ? { time_range: recency } : {}),
      }),
      signal: timeout(),
    });
    const body = (await res.json()) as {
      results?: { title: string; url: string; content?: string }[];
    };
    return rankHits(body.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content ?? "",
    }));
  }
  return "No web search provider is configured (set SEKHEMET_SEARXNG_URL, BRAVE_SEARCH_API_KEY or TAVILY_API_KEY). Paper search, page fetches and GitHub search still work.";
}

const execGh = async (args: string[]): Promise<string> =>
  (await promisify(execFile)("gh", args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

/** GitHub repositories (with licence and stars) or code, via the user's gh login. */
export async function githubSearch(
  query: string,
  kind: "repos" | "code",
  cfg: WebConfig = {},
): Promise<Hit[] | string> {
  const run = cfg.gh ?? execGh;
  try {
    // NEW-security-8: `gh` reaches api.github.com; the policy decides first.
    await cfg.gate?.(
      `https://api.github.com/search/${kind === "code" ? "code" : "repositories"}`,
      "gh",
    );
    if (kind === "code") {
      const out = await run([
        "search",
        "code",
        query,
        "--limit",
        "8",
        "--json",
        "repository,path,url",
      ]);
      return (
        JSON.parse(out) as { repository: { nameWithOwner: string }; path: string; url: string }[]
      ).map((r) => ({
        title: `${r.repository.nameWithOwner}: ${r.path}`,
        url: r.url,
        snippet: "",
      }));
    }
    const out = await run([
      "search",
      "repos",
      query,
      "--limit",
      "8",
      "--json",
      "fullName,description,stargazersCount,license,url",
    ]);
    return (
      (
        JSON.parse(out) as {
          fullName: string;
          description?: string;
          stargazersCount: number;
          license?: { key?: string };
          url: string;
        }[]
      )
        .map((r) => ({ r, judgement: judgeLicence(r.license?.key) }))
        // DS-P7-2: a repository with no licence is dropped silently, as the survey does.
        .filter(({ judgement }) => judgement.action !== "drop")
        .map(({ r, judgement }) => ({
          title: r.fullName,
          url: r.url,
          snippet: r.description ?? "",
          // DS-P7-9: judged by the same classifier as the survey's REST search.
          meta: `${r.stargazersCount} stars, licence ${r.license?.key} (${licenceVerdictWords(judgement.verdict)})`,
        }))
    );
  } catch (err) {
    return `GitHub search failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}
