import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Polite, cached access to other people's public APIs and sites.
 *
 * Ported from Helga's research service (services/research/ratelimit.py and
 * doc_fetch.py), where the lesson was measured: a throttled reply looks the
 * same as "nothing exists", so ignoring a published limit does not just annoy
 * the host, it makes research silently wrong. Staying under the limit is the
 * cheapest way to avoid manufacturing that ambiguity.
 *
 * Four parts, each usable alone:
 * - HostPacer: a minimum interval per host. Documented limits are marked as
 *   such; the rest are deliberate conservatism. Concurrent callers reserve the
 *   next slot before waiting, so they queue instead of all starting at once.
 *   429/503 with Retry-After blocks the host; X-Rate-Limit headers adapt it.
 * - RobotsGate: robots.txt per origin, Crawl-delay honoured. Fails open when
 *   there is no robots.txt: an absent file forbids nothing.
 * - ResearchCache: responses on disk with a time-to-live, so the same paper or
 *   docs page is fetched once a week, not once a card.
 * - politeFetch: all three around one fetch, plus the private-address guard.
 */

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_INTERVAL_S = 1.0;

/** Seconds between requests, per host. See the module note for provenance. */
export const MIN_INTERVAL_S: Record<string, number> = {
  "export.arxiv.org": 3.0, // DOCUMENTED, hard: arXiv API terms, one request per 3 s
  "arxiv.org": 3.0, // same operator and policy for the HTML renderings
  "api.openalex.org": 0.1, // DOCUMENTED: 10/s, 100k/day
  "api.crossref.org": 0.1, // header-governed; adapts at runtime
  "api.semanticscholar.org": 1.0, // DOCUMENTED: 1/s with a key
  "huggingface.co": 0.5, // undocumented; conservative
  "registry.npmjs.org": 0.1, // CDN-backed; no published anonymous cap
  "pypi.org": 0.2,
  "api.github.com": 0.8, // DOCUMENTED: 5000/h authenticated
  "en.wikipedia.org": 1.0, // Wikimedia asks for serial requests; Helga measured 429s at 0.5
};

/** Published daily caps, warned at 90%. */
export const DAILY_CAP: Record<string, number> = { "api.openalex.org": 100_000 };

export function hostOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return "";
  }
}

export interface Clock {
  now: () => number; // ms
  sleep: (ms: number) => Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class HostPacer {
  private last = new Map<string, number>();
  private blockedUntil = new Map<string, number>();
  private intervals: Record<string, number>;
  private calls = new Map<string, { day: string; n: number }>();

  constructor(
    private readonly clock: Clock = realClock,
    intervals: Record<string, number> = MIN_INTERVAL_S,
  ) {
    this.intervals = { ...intervals };
  }

  intervalFor(host: string): number {
    return this.intervals[host] ?? DEFAULT_INTERVAL_S;
  }

  /**
   * Wait until this host may be called. Returns the ms waited. `minIntervalS`
   * can raise the floor (a robots Crawl-delay), never lower a documented one.
   */
  async wait(url: string, minIntervalS = 0): Promise<number> {
    const host = hostOf(url);
    if (!host) return 0;
    const interval = Math.max(this.intervalFor(host), minIntervalS) * 1000;
    const now = this.clock.now();
    const prev = this.last.get(host);
    const earliest = Math.max(
      prev === undefined ? 0 : prev + interval,
      this.blockedUntil.get(host) ?? 0,
    );
    const delay = Math.max(0, earliest - now);
    // Reserve the slot before sleeping: the next caller queues behind this one.
    this.last.set(host, now + delay);
    if (delay > 0) await this.clock.sleep(delay);
    return delay;
  }

  /** Feed a response's rate-limit signals back in. */
  note(url: string, status: number, headers?: Headers): void {
    const host = hostOf(url);
    if (!host) return;
    if (status === 429 || status === 503) {
      const retry = Number(headers?.get("retry-after") ?? 0) || 5;
      this.blockedUntil.set(host, this.clock.now() + Math.min(retry, 300) * 1000);
      return;
    }
    const limit = Number(headers?.get("x-rate-limit-limit"));
    const per = Number.parseFloat(headers?.get("x-rate-limit-interval") ?? "");
    if (limit > 0 && per > 0) this.intervals[host] = Math.max(per / limit, 0.01);
  }

  isBlocked(url: string): boolean {
    return (this.blockedUntil.get(hostOf(url)) ?? 0) > this.clock.now();
  }

  /** Count a call against a published daily cap; false once over it. */
  count(url: string, today = new Date().toISOString().slice(0, 10)): boolean {
    const host = hostOf(url);
    const cap = DAILY_CAP[host];
    if (!cap) return true;
    const c = this.calls.get(host);
    const n = c && c.day === today ? c.n + 1 : 1;
    this.calls.set(host, { day: today, n });
    return n <= cap;
  }
}

/** robots.txt rules for one user-agent group: longest match wins, Allow on ties. */
interface RobotsRules {
  allow: string[];
  disallow: string[];
  delayS: number;
}

export function parseRobots(text: string, agent: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: { allow: [], disallow: [], delayS: 0 } };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow" && value) current.rules.allow.push(value);
    if (key === "disallow" && value) current.rules.disallow.push(value);
    if (key === "crawl-delay") current.rules.delayS = Number(value) || 0;
  }
  const a = agent.toLowerCase();
  const own = groups.find((g) => g.agents.some((x) => x !== "*" && a.includes(x)));
  return (
    own?.rules ??
    groups.find((g) => g.agents.includes("*"))?.rules ?? { allow: [], disallow: [], delayS: 0 }
  );
}

function robotsMatch(pattern: string, path: string): number {
  // `*` wildcards and a `$` end anchor, as Google and Bing interpret them.
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    `^${body
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}${anchored ? "$" : ""}`,
  );
  return re.test(path) ? pattern.length : -1;
}

export function robotsAllows(rules: RobotsRules, path: string): boolean {
  const best = (list: string[]) => Math.max(-1, ...list.map((p) => robotsMatch(p, path)));
  const allow = best(rules.allow);
  const disallow = best(rules.disallow);
  return disallow === -1 || allow >= disallow;
}

export class RobotsGate {
  private rules = new Map<string, Promise<RobotsRules>>();
  constructor(
    private readonly fetchText: (url: string) => Promise<string | undefined>,
    private readonly agent = USER_AGENT,
  ) {}

  private load(origin: string): Promise<RobotsRules> {
    let p = this.rules.get(origin);
    if (!p) {
      p = this.fetchText(`${origin}/robots.txt`)
        .then((t) => parseRobots(t ?? "", this.agent))
        .catch(() => parseRobots("", this.agent)); // fail open
      this.rules.set(origin, p);
    }
    return p;
  }

  async check(url: string): Promise<{ allowed: boolean; delayS: number }> {
    const u = new URL(url);
    const rules = await this.load(u.origin);
    return { allowed: robotsAllows(rules, u.pathname + u.search), delayS: rules.delayS };
  }
}

/** Response bodies on disk, keyed by URL, with a time-to-live. */
export class ResearchCache {
  constructor(
    private readonly dir = process.env.SEKHEMET_RESEARCH_CACHE ??
      join(homedir(), ".cache", "sekhemet", "research"),
    private readonly ttlMs = 7 * 24 * 3600 * 1000,
  ) {}

  private path(key: string): string {
    return join(this.dir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }

  get(key: string): { status: number; type: string; body: string } | undefined {
    try {
      const e = JSON.parse(readFileSync(this.path(key), "utf8")) as {
        at: number;
        status: number;
        type: string;
        body: string;
      };
      return Date.now() - e.at < this.ttlMs ? e : undefined;
    } catch {
      return undefined;
    }
  }

  set(key: string, status: number, type: string, body: string): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.path(key), JSON.stringify({ at: Date.now(), status, type, body }));
    } catch {
      // A cache that cannot write is only slower.
    }
  }
}

/**
 * A descriptive User-Agent. A contact address is added only when the user
 * sets SEKHEMET_CONTACT: a fake address is worse than none (Helga's lesson).
 */
export const USER_AGENT = `Sekhemet-Researcher/1.1 (local-first coding harness${
  process.env.SEKHEMET_CONTACT ? `; mailto:${process.env.SEKHEMET_CONTACT}` : ""
})`;

export function isPrivateHost(hostname: string): boolean {
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe80:|169\.254\.|.*\.local$|.*\.internal$)/i.test(
    hostname,
  );
}

export interface PoliteOptions {
  fetch?: FetchFn;
  pacer?: HostPacer;
  cache?: ResearchCache | undefined;
  robots?: boolean;
  /** Hosts that are allowed although private (the user's own SearXNG). */
  allowHosts?: string[];
}

export interface PoliteStats {
  fetched: number;
  cached: number;
  blocked: number;
  failed: number;
}

/**
 * One polite fetcher: private-address guard, robots (for page fetches), host
 * pacing, 429 backoff with one retry, and a cache for successful GETs.
 */
export class PoliteFetcher {
  readonly pacer: HostPacer;
  readonly stats: PoliteStats = { fetched: 0, cached: 0, blocked: 0, failed: 0 };
  private readonly raw: FetchFn;
  private readonly robots: RobotsGate;

  constructor(private readonly opts: PoliteOptions = {}) {
    this.raw = opts.fetch ?? ((u, i) => fetch(u, i));
    this.pacer = opts.pacer ?? new HostPacer();
    this.robots = new RobotsGate(async (u) => {
      await this.pacer.wait(u);
      const r = await this.raw(u, { headers: { "User-Agent": USER_AGENT } });
      return r.ok ? r.text() : undefined;
    });
  }

  /** GET (or POST for APIs) with every courtesy; `respectRobots` for page reads. */
  async fetch(url: string, init: RequestInit = {}, respectRobots = false): Promise<Response> {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https can be fetched.");
    const allowed = (this.opts.allowHosts ?? []).includes(u.host);
    if (!allowed && isPrivateHost(u.hostname)) {
      throw new Error("Refusing to fetch a private or loopback address.");
    }
    const isGet = (init.method ?? "GET").toUpperCase() === "GET";
    const key = isGet ? url : "";
    const hit = key ? this.opts.cache?.get(key) : undefined;
    if (hit) {
      this.stats.cached++;
      return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type } });
    }
    let delayS = 0;
    if (respectRobots && this.opts.robots !== false && !allowed) {
      const r = await this.robots.check(url);
      if (!r.allowed) {
        this.stats.blocked++;
        return new Response("Disallowed by the site's robots.txt.", { status: 451 });
      }
      delayS = r.delayS;
    }
    if (!this.pacer.count(url)) throw new Error(`Daily cap reached for ${u.host}.`);
    const headers = { "User-Agent": USER_AGENT, ...(init.headers as Record<string, string>) };
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.pacer.wait(url, delayS);
      let res: Response;
      try {
        res = await this.raw(url, {
          ...init,
          headers,
          signal: init.signal ?? AbortSignal.timeout(15_000),
        });
      } catch (err) {
        this.stats.failed++;
        throw err;
      }
      this.pacer.note(url, res.status, res.headers);
      // One retry after the host's own Retry-After; beyond that, report it.
      if ((res.status === 429 || res.status === 503) && attempt === 0) continue;
      this.stats.fetched++;
      if (key && res.ok && this.opts.cache) {
        const body = await res.text();
        this.opts.cache.set(key, res.status, res.headers.get("content-type") ?? "", body);
        return new Response(body, { status: res.status, headers: res.headers });
      }
      return res;
    }
    this.stats.failed++;
    return new Response("Rate limited.", { status: 429 });
  }
}
