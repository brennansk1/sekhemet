import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PoliteFetcher, ResearchCache, USER_AGENT } from "./polite.js";
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
}

export function webConfigFromEnv(): WebConfig {
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
      cache: new ResearchCache(),
      ...(searxHost ? { allowHosts: [searxHost] } : {}),
    }),
    ...(env.SEKHEMET_CONTACT ? { contact: env.SEKHEMET_CONTACT } : {}),
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
export async function searchPapers(query: string, cfg: WebConfig = {}): Promise<Hit[]> {
  const f = get(cfg);
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
): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "Invalid URL.";
  }
  if (!/^https?:$/.test(u.protocol)) return "Only http and https pages can be fetched.";
  // No reaching into the user's network from a model-chosen URL.
  if (
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|169\.254\.)/.test(
      u.hostname,
    )
  ) {
    return "Refusing to fetch a private or loopback address.";
  }
  const init: RequestInit = { headers: UA, signal: timeout(), redirect: "follow" };
  // Page reads honour robots.txt; API calls (search, registries) are not crawling.
  const res = cfg.polite
    ? await cfg.polite.fetch(u.toString(), init, true)
    : await get(cfg)(u.toString(), init);
  if (res.status === 451) return "The site's robots.txt disallows fetching this page.";
  if (!res.ok) return `The page answered ${res.status}.`;
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = /html/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}\n… (truncated at ${maxChars} characters)`
    : text;
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
  if (/^The page answered 404|^The site's robots/.test(text) || text.length < 1500) {
    text = await fetchPage(`https://arxiv.org/abs/${arxivId}`, cfg, 20_000);
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

/** General web search through the provider the user configured. */
export async function webSearch(query: string, cfg: WebConfig = {}): Promise<Hit[] | string> {
  const f = get(cfg);
  if (cfg.searxngUrl) {
    const res = await f(
      `${cfg.searxngUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}&format=json`,
      {
        headers: UA,
        signal: timeout(),
      },
    );
    const body = (await res.json()) as {
      results?: { title: string; url: string; content?: string; engine?: string }[];
    };
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
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`,
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
      body: JSON.stringify({ api_key: cfg.tavilyKey, query, max_results: 8 }),
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
      JSON.parse(out) as {
        fullName: string;
        description?: string;
        stargazersCount: number;
        license?: { key?: string };
        url: string;
      }[]
    ).map((r) => ({
      title: r.fullName,
      url: r.url,
      snippet: r.description ?? "",
      meta: `${r.stargazersCount} stars, licence ${r.license?.key ?? "none"}`,
    }));
  } catch (err) {
    return `GitHub search failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
  }
}
