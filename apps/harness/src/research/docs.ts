import { htmlToText } from "./web.js";

/**
 * Reading a library's documentation as a set, not one page at a time.
 *
 * Ported from Helga's doc_reader.py, where two measurements shaped it:
 * - Modern docs are rendered by JavaScript. dbt's entry page had eleven links
 *   in its HTML while its sitemap listed 491 docs pages, so a link-following
 *   crawl saw almost nothing. The sitemap is the primary enumeration; links
 *   are the fallback.
 * - Sitemaps are alphabetical, so taking the first N pages covered 5 of 36
 *   sections. Pages are interleaved round-robin across sections.
 *
 * Sekhemet's use is narrower than Helga's (a course needs the whole set; a
 * card needs the right three pages), so the set is enumerated cheaply by URL,
 * candidate pages are chosen by how well their path and title match the
 * question, and only those are fetched and read.
 */

export type TextFetch = (url: string) => Promise<string | undefined>;

/** Documentation homes for libraries a Sekhemet project is likely to use. */
export const KNOWN_DOCS: Record<string, string> = {
  node: "https://nodejs.org/api/",
  nodejs: "https://nodejs.org/api/",
  typescript: "https://www.typescriptlang.org/docs/",
  vitest: "https://vitest.dev/guide/",
  biome: "https://biomejs.dev/guides/getting-started/",
  pnpm: "https://pnpm.io/motivation",
  react: "https://react.dev/learn",
  vite: "https://vite.dev/guide/",
  sqlite: "https://sqlite.org/docs.html",
  postgres: "https://www.postgresql.org/docs/current/",
  postgresql: "https://www.postgresql.org/docs/current/",
  python: "https://docs.python.org/3/library/",
  fastapi: "https://fastapi.tiangolo.com/learn/",
  django: "https://docs.djangoproject.com/en/stable/",
  pytest: "https://docs.pytest.org/en/stable/",
  rust: "https://doc.rust-lang.org/std/",
  go: "https://go.dev/doc/",
  zod: "https://zod.dev/",
  express: "https://expressjs.com/en/5x/api.html",
  tanstack: "https://tanstack.com/query/latest/docs/framework/react/overview",
  "llama.cpp": "https://github.com/ggml-org/llama.cpp/tree/master/docs",
};

/** The docs root: the entry URL's path up to and including its docs segment. */
export function docRoot(entry: string): string | undefined {
  try {
    const u = new URL(entry);
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) =>
      /^(docs?|api|guide|learn|library|manual|reference|std)$/i.test(p),
    );
    const keep = i === -1 ? parts.slice(0, Math.max(0, parts.length - 1)) : parts.slice(0, i + 1);
    return `${u.origin}/${keep.join("/")}${keep.length ? "/" : ""}`;
  } catch {
    return undefined;
  }
}

function sectionOf(url: string, root: string): string {
  return url.startsWith(root) ? (url.slice(root.length).split("/")[0] ?? "") : "";
}

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

/** Every page of the docs set from its sitemap(s), interleaved by section. [] if none. */
export async function sitemapUrls(
  entry: string,
  fetchText: TextFetch,
  limit = 3000,
): Promise<string[]> {
  const root = docRoot(entry);
  if (!root) return [];
  const origin = new URL(entry).origin;
  const queue = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const robots = (await fetchText(`${origin}/robots.txt`).catch(() => undefined)) ?? "";
  for (const line of robots.split(/\r?\n/)) {
    const m = /^sitemap:\s*(\S+)/i.exec(line.trim());
    if (m?.[1]) queue.push(m[1]);
  }
  const seenMaps = new Set<string>();
  const urls = new Set<string>();
  while (queue.length > 0 && seenMaps.size < 25 && urls.size < limit) {
    const sm = queue.shift() as string;
    if (seenMaps.has(sm)) continue;
    seenMaps.add(sm);
    const body = await fetchText(sm).catch(() => undefined);
    if (!body || !/<loc/i.test(body)) continue;
    const isIndex = /<sitemapindex/i.test(body.slice(0, 2000));
    for (const m of body.matchAll(LOC)) {
      const loc = (m[1] ?? "").replace(/&amp;/g, "&");
      if (isIndex) queue.push(loc);
      else if (loc.startsWith(root)) urls.add(loc.replace(/#.*$/, ""));
    }
  }
  // Round-robin across sections, biggest sections first.
  const buckets = new Map<string, string[]>();
  for (const u of urls) {
    const s = sectionOf(u, root);
    buckets.set(s, [...(buckets.get(s) ?? []), u]);
  }
  const order = [...buckets.keys()].sort(
    (a, b) => (buckets.get(b)?.length ?? 0) - (buckets.get(a)?.length ?? 0) || a.localeCompare(b),
  );
  const out: string[] = [];
  while (out.length < urls.size) {
    for (const s of order) {
      const next = buckets.get(s)?.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/** Links on a page that stay inside the docs root. */
export function docLinks(html: string, base: string, root: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#>]+)/gi)) {
    try {
      const u = new URL(m[1] ?? "", base).toString().replace(/#.*$/, "");
      if (
        u.startsWith(root) &&
        !/\.(png|jpe?g|gif|svg|pdf|zip|gz|js|css|ico|woff2?|xml|json)$/i.test(u)
      ) {
        out.add(u);
      }
    } catch {
      // Unparseable href.
    }
  }
  return [...out];
}

function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length > 2),
    ),
  ];
}

/** How well a URL (its path words) matches the question. */
export function urlScore(url: string, question: string): number {
  const path = terms(decodeURIComponent(new URL(url).pathname.replace(/[-_/.]/g, " ")));
  const q = terms(question);
  return q.filter((w) => path.some((p) => p === w || p.startsWith(w) || w.startsWith(p))).length;
}

export interface DocPage {
  url: string;
  title: string;
  text: string;
  score: number;
  codeBlocks: number;
}

/**
 * Read the pages of a docs set most relevant to `question`.
 *
 * Enumerates by sitemap (or by breadth-first links from the entry when there
 * is none), ranks candidates by URL match, fetches up to `maxFetch`, then
 * re-ranks by how often the question's terms appear in the page text.
 */
export async function readDocs(
  libraryOrUrl: string,
  question: string,
  fetchText: TextFetch,
  opts: { maxFetch?: number; maxPages?: number; charsPerPage?: number } = {},
): Promise<{ root: string; available: number; pages: DocPage[] } | string> {
  const entry = /^https?:\/\//.test(libraryOrUrl)
    ? libraryOrUrl
    : KNOWN_DOCS[libraryOrUrl.toLowerCase().replace(/^@/, "")];
  if (!entry) {
    return `No known documentation home for "${libraryOrUrl}". Pass the docs URL (find it with web_search or the package README).`;
  }
  const root = docRoot(entry) ?? entry;
  const maxFetch = opts.maxFetch ?? 8;
  let candidates = await sitemapUrls(entry, fetchText);
  const available = candidates.length;
  const fetched = new Map<string, string>();
  if (candidates.length === 0) {
    // Link-following fallback, breadth-first to depth 2.
    const seen = new Set([entry]);
    let frontier = [entry];
    for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const u of frontier.slice(0, depth === 0 ? 1 : 6)) {
        const html = fetched.get(u) ?? (await fetchText(u).catch(() => undefined));
        if (!html) continue;
        fetched.set(u, html);
        for (const l of docLinks(html, u, root)) {
          if (seen.has(l)) continue;
          seen.add(l);
          next.push(l);
        }
      }
      frontier = next.sort((a, b) => urlScore(b, question) - urlScore(a, question));
    }
    candidates = [...seen];
  }
  const ranked = [entry, ...candidates.filter((c) => c !== entry)]
    .map((u, i) => ({ u, s: urlScore(u, question), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, maxFetch);
  const q = terms(question);
  const pages: DocPage[] = [];
  for (const { u } of ranked) {
    const html = fetched.get(u) ?? (await fetchText(u).catch(() => undefined));
    if (!html) continue;
    const text = htmlToText(html);
    if (text.length < 300) continue; // an index stub, not a page
    const lower = text.toLowerCase();
    const score = q.reduce((n, w) => n + Math.min(5, lower.split(w).length - 1), 0);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? u;
    pages.push({
      url: u,
      title: htmlToText(title),
      text: excerptAround(text, q, opts.charsPerPage ?? 3000),
      score,
      codeBlocks: (html.match(/<pre[\s>]/gi) ?? []).length,
    });
  }
  pages.sort((a, b) => b.score - a.score);
  return { root, available, pages: pages.slice(0, opts.maxPages ?? 3) };
}

/** The window of `text` densest in the question's terms. */
export function excerptAround(text: string, q: string[], chars: number): string {
  if (text.length <= chars) return text;
  const lower = text.toLowerCase();
  let best = 0;
  let bestAt = 0;
  const step = Math.max(200, Math.floor(chars / 4));
  for (let at = 0; at < text.length; at += step) {
    const win = lower.slice(at, at + chars);
    const n = q.reduce((s, w) => s + (win.split(w).length - 1), 0);
    if (n > best) {
      best = n;
      bestAt = at;
    }
  }
  return `${bestAt > 0 ? "… " : ""}${text.slice(bestAt, bestAt + chars)}${bestAt + chars < text.length ? " …" : ""}`;
}

/**
 * The parts of a long page about `focus`, in page order: the page is cut at
 * headings and paragraphs, chunks are scored with BM25 against the focus
 * terms, and the best are kept up to `maxChars`. Several relevant sections
 * survive, not just the single densest window (what a coding agent's page
 * fetch does when asked a question about a page).
 */
export function focusChunks(text: string, focus: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const q = terms(focus);
  if (q.length === 0) return `${text.slice(0, maxChars)}\n… (truncated)`;
  // Chunks: split before headings, then pack paragraphs to ~1200 characters.
  const chunks: string[] = [];
  for (const section of text.split(/\n(?=#{1,6} )/)) {
    let cur = "";
    for (const para of section.split(/\n{2,}/)) {
      if (cur.length + para.length > 1200 && cur) {
        chunks.push(cur);
        cur = "";
      }
      cur += (cur ? "\n\n" : "") + para;
    }
    if (cur) chunks.push(cur);
  }
  const docs = chunks.map((c) => c.toLowerCase());
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const df = new Map(q.map((w) => [w, docs.filter((d) => d.includes(w)).length]));
  const N = docs.length;
  const score = (d: string) =>
    q.reduce((s, w) => {
      const tf = d.split(w).length - 1;
      if (tf === 0) return s;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      return s + (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }, 0);
  const ranked = docs.map((d, i) => ({ i, s: score(d) })).sort((a, b) => b.s - a.s);
  const keep = new Set<number>([0]); // the page's opening says what the page is
  let used = (chunks[0] ?? "").length;
  for (const { i, s } of ranked) {
    if (s <= 0) break;
    const len = (chunks[i] ?? "").length;
    if (used + len > maxChars) continue;
    keep.add(i);
    used += len;
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last !== -1 && i > last + 1) out.push("…");
    out.push(chunks[i] ?? "");
    last = i;
  }
  return out.join("\n\n");
}
