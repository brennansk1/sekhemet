import { createHash } from "node:crypto";
import {
  type Ecosystem,
  type InstalledDependency,
  dependencyFile,
  dependencyFiles,
  resolveDependency,
} from "@sekhemet/loop";
import { type Excerpt, KNOWN_DOCS, type TextFetch, excerpts, readDocs, urlScore } from "./docs.js";
import { researchCopy } from "./research_copy.js";
import { htmlToText } from "./web.js";

/**
 * Documentation at the version the project pins (design-stage DS-N9-8 to
 * -12). An engineer reads the docs of the release they run; a page for
 * another release reads the same and is wrong in the detail that matters
 * (arXiv 2604.09515). So a dependency's documentation is resolved at its
 * pinned version — docs.rs, pkg.go.dev, a Read the Docs version, the npm
 * package's own files on unpkg — and a page for another or an unknown
 * version is read only when the pinned one gave too few, labelled and
 * ranked after it.
 *
 * Nothing here fetches by itself: every request goes through the caller's
 * `TextFetch`, which is the research's polite fetcher (robots, pacing, the
 * cache, `fetch_deny`, and with research on the research policy and its
 * `harness/egress` record, DS-N9-9). No model is involved.
 */

/** A dependency and the version the project pins, with where its docs live when it says. */
export interface PinnedDocsTarget {
  eco: Ecosystem;
  name: string;
  version: string;
  /** The Documentation URL the distribution declares (Python's METADATA). */
  docsUrl?: string;
}

/** One URL to try, and whether it documents the pinned version. */
export interface DocsCandidate {
  url: string;
  exact: boolean;
  /** The version the URL documents ("latest", "stable"), when known. */
  version?: string;
}

/** One page read for the question, with its excerpts. */
export interface PinnedDocsPage {
  url: string;
  title: string;
  exact: boolean;
  version?: string;
  /** `[docs for X; project pins Y]` on a page for another or an unknown version. */
  label?: string;
  /** SHA-256 of the bytes fetched (what the research cache holds). */
  pageSha256: string;
  excerpts: Excerpt[];
}

export interface PinnedDocsRead {
  target: PinnedDocsTarget;
  /** Pages at the pinned version first, then the labelled ones. */
  pages: PinnedDocsPage[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The Documentation URL in a Python distribution's METADATA headers. */
function metadataDocsUrl(metadata: string): string | undefined {
  const headers = metadata.split(/\r?\n\r?\n/)[0] ?? "";
  let home: string | undefined;
  for (const line of headers.split(/\r?\n/)) {
    const project = /^Project-URL:\s*([^,]+),\s*(https?:\/\/\S+)/i.exec(line);
    if (project && /^(documentation|docs)$/i.test((project[1] ?? "").trim())) return project[2];
    const page = /^Home-page:\s*(https?:\/\/\S+)/i.exec(line);
    if (page) home = page[1];
  }
  return home && /\.readthedocs\.io\//i.test(home) ? home : undefined;
}

function pythonDocsUrl(dep: InstalledDependency): string | undefined {
  if (!dep.installed) return undefined;
  const meta = dependencyFiles(dep, 300).find((f) => f.endsWith(".dist-info/METADATA"));
  if (!meta) return undefined;
  const read = dependencyFile(dep, meta, 200_000);
  return read.ok ? metadataDocsUrl(read.text) : undefined;
}

/**
 * The dependency `library` names in this project and the version it pins
 * (installed, else the lockfile's), in any ecosystem; undefined for a name
 * the project does not depend on.
 */
export function pinnedTarget(repo: string, library: string): PinnedDocsTarget | undefined {
  if (/^https?:\/\//i.test(library)) return undefined;
  const dep = resolveDependency(repo, library);
  if (!dep?.version) return undefined;
  const docsUrl = dep.eco === "python" ? pythonDocsUrl(dep) : undefined;
  return { eco: dep.eco, name: dep.name, version: dep.version, ...(docsUrl ? { docsUrl } : {}) };
}

/**
 * Whether the Worker's `docs` web tier may read `library` (DS-N9-12): a
 * dependency the project pins, or a library with a known documentation
 * home. A URL or any other name sends nothing: the Worker chooses which
 * documentation is read, never where a request goes.
 */
export function workerMayRead(repo: string, library: string): boolean {
  if (library.includes("://")) return false;
  if (pinnedTarget(repo, library)) return true;
  return Object.hasOwn(KNOWN_DOCS, library.toLowerCase().replace(/^@/, ""));
}

/**
 * Whether `url` documents exactly `version` of the package, by its address
 * (DS-N9-24): `docs.rs/{crate}/{ver}/…`, `pkg.go.dev/{module}@{ver}`, a Read
 * the Docs `/{lang}/{ver}/` or `/{lang}/v{ver}/` path, `unpkg.com/{name}@{ver}/…`.
 * A page for `latest`, another version, a blog or an issue does not.
 */
export function documentsVersion(
  url: string,
  eco: Ecosystem,
  name: string,
  version: string,
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!version || version.includes(",")) return false;
  const path = decodeURIComponent(u.pathname);
  const host = u.hostname.toLowerCase();
  if (eco === "rust") return host === "docs.rs" && path.startsWith(`/${name}/${version}/`);
  if (eco === "go")
    return (
      host === "pkg.go.dev" &&
      (path === `/${name}@${version}` || path.startsWith(`/${name}@${version}/`))
    );
  if (eco === "npm") return host === "unpkg.com" && path.startsWith(`/${name}@${version}/`);
  return (
    host.endsWith(".readthedocs.io") &&
    [version, `v${version}`].some((v) =>
      new RegExp(`^/[a-z]{2}(?:-[a-z]+)?/${v.replace(/\./g, "\\.")}/`, "i").test(path),
    )
  );
}

/** Read the Docs: `/<lang>/<version>/<rest>` on a `*.readthedocs.io` host. */
function readTheDocs(t: PinnedDocsTarget, docsUrl: string): DocsCandidate[] {
  let u: URL;
  try {
    u = new URL(docsUrl);
  } catch {
    return [];
  }
  const m = /^\/([a-z]{2}(?:-[a-z]+)?)\/([^/]+)\/(.*)$/i.exec(u.pathname);
  if (!/\.readthedocs\.io$/i.test(u.hostname) || !m) return [{ url: docsUrl, exact: false }];
  const [, lang, current, rest] = m as unknown as [string, string, string, string];
  const versions = [t.version, `v${t.version}`];
  const exact = versions.includes(current)
    ? [
        { url: `${u.origin}/${lang}/${current}/llms.txt`, exact: true, version: current },
        { url: docsUrl, exact: true, version: current },
      ]
    : versions.flatMap((v) => [
        { url: `${u.origin}/${lang}/${v}/llms.txt`, exact: true, version: v },
        { url: `${u.origin}/${lang}/${v}/${rest}`, exact: true, version: v },
      ]);
  return [
    ...exact,
    { url: `${u.origin}/llms.txt`, exact: false },
    ...(versions.includes(current) ? [] : [{ url: docsUrl, exact: false, version: current }]),
  ];
}

/**
 * The URLs that document `t` at its pinned version, in reading order, then
 * those for another or an unknown version (DS-N9-8). A versioned llms.txt
 * comes before its page, and before the origin's own llms.txt.
 */
export function pinnedDocsCandidates(t: PinnedDocsTarget): DocsCandidate[] {
  const v = t.version;
  if (t.eco === "rust") {
    const crate = t.name.replace(/-/g, "_");
    return [
      { url: `https://docs.rs/${t.name}/${v}/${crate}/all.html`, exact: true, version: v },
      { url: `https://docs.rs/${t.name}/${v}/${crate}/`, exact: true, version: v },
      { url: `https://docs.rs/${t.name}/latest/${crate}/`, exact: false, version: "latest" },
    ];
  }
  if (t.eco === "go") {
    return [
      { url: `https://pkg.go.dev/${t.name}@${v}`, exact: true, version: v },
      { url: `https://pkg.go.dev/${t.name}`, exact: false, version: "latest" },
    ];
  }
  if (t.eco === "npm") {
    return [
      { url: `https://unpkg.com/${t.name}@${v}/llms.txt`, exact: true, version: v },
      { url: `https://unpkg.com/${t.name}@${v}/README.md`, exact: true, version: v },
    ];
  }
  return t.docsUrl ? readTheDocs(t, t.docsUrl) : [];
}

const looksHtml = (body: string) => /^\s*</.test(body);

function titleOf(body: string, text: string, url: string): string {
  const html = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  if (html) return htmlToText(html);
  const heading = /^#{1,6} (.+)$/m.exec(text)?.[1];
  return heading?.trim() ?? url;
}

/** docs.rs's `all.html` items whose name the question says, as page URLs. */
function symbolPages(allHtml: string, base: string, question: string): string[] {
  const words = new Set(question.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  const out: string[] = [];
  for (const m of allHtml.matchAll(
    /href="((?:[\w]+\/)*(?:struct|enum|fn|trait|macro|type|constant|static|union|attr|derive)\.([A-Za-z_]\w*)\.html)"/g,
  )) {
    if (!words.has(m[2] as string)) continue;
    const url = new URL(m[1] as string, base).toString();
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/** The markdown links of an llms.txt that stay on its origin, best match first. */
function llmsLinks(index: string, url: string, question: string): string[] {
  const origin = new URL(url).origin;
  const links = [...index.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)]
    .map((m) => m[1] as string)
    .filter((l) => l.startsWith(origin));
  return [...new Set(links)]
    .map((l, i) => ({ l, s: urlScore(l, question), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.l);
}

/**
 * Read `t`'s documentation for `question` at its pinned version (DS-N9-8,
 * -10): candidates in order, each fetched through `fetchText`, a page kept
 * when an excerpt answers the question; another version's page only while
 * fewer than `maxPages` were read, labelled; at most `maxExcerpts` (five)
 * excerpts in all, pinned pages' first. `fetchApi` (no robots, an API
 * call) asks PyPI for a Documentation URL a distribution not installed
 * declares.
 */
export async function readPinnedDocs(
  t: PinnedDocsTarget,
  question: string,
  fetchText: TextFetch,
  opts: { maxPages?: number; maxFetch?: number; maxExcerpts?: number; fetchApi?: TextFetch } = {},
): Promise<PinnedDocsRead> {
  const maxPages = opts.maxPages ?? 2;
  const maxFetch = opts.maxFetch ?? 6;
  let target = t;
  if (t.eco === "python" && !t.docsUrl && opts.fetchApi) {
    const body = await opts
      .fetchApi(
        `https://pypi.org/pypi/${encodeURIComponent(t.name)}/${encodeURIComponent(t.version)}/json`,
      )
      .catch(() => undefined);
    try {
      const urls = (
        JSON.parse(body ?? "{}") as { info?: { project_urls?: Record<string, string> } }
      ).info?.project_urls;
      const docsUrl = Object.entries(urls ?? {}).find(([k]) =>
        /^(documentation|docs)$/i.test(k),
      )?.[1];
      if (docsUrl) target = { ...t, docsUrl };
    } catch {
      // No metadata: no Documentation URL.
    }
  }
  let fetches = 0;
  const get = async (url: string) => {
    if (fetches >= maxFetch) return undefined;
    fetches++;
    return fetchText(url).catch(() => undefined);
  };
  const pages: PinnedDocsPage[] = [];
  const seen = new Set<string>();
  const keep = (c: DocsCandidate, url: string, body: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    const text = looksHtml(body) ? htmlToText(body) : body;
    const pageSha256 = sha256(body);
    const found = excerpts(text, question, {
      max: opts.maxExcerpts ?? 5,
      url,
      pageSha256,
    });
    if (found.length === 0) return;
    pages.push({
      url,
      title: titleOf(body, text, url),
      exact: c.exact,
      ...(c.version ? { version: c.version } : {}),
      ...(c.exact ? {} : { label: researchCopy.docsForVersion(c.version, t.version) }),
      pageSha256,
      excerpts: found,
    });
  };
  for (const c of pinnedDocsCandidates(target)) {
    if (pages.length >= maxPages || fetches >= maxFetch) break;
    const body = await get(c.url);
    if (!body) continue;
    if (c.url.endsWith("/llms.txt") && !looksHtml(body)) {
      const links = llmsLinks(body, c.url, question);
      if (links.length === 0) keep(c, c.url, body);
      for (const link of links) {
        if (pages.length >= maxPages) break;
        const page = await get(link);
        if (page) keep(c, link, page);
      }
      continue;
    }
    if (c.url.endsWith("/all.html")) {
      for (const link of symbolPages(body, c.url, question)) {
        if (pages.length >= maxPages) break;
        const page = await get(link);
        if (page) keep(c, link, page);
      }
      continue;
    }
    keep(c, c.url, body);
  }
  // Pages at the pinned version first: a labelled page never outranks one.
  pages.sort((a, b) => Number(b.exact) - Number(a.exact));
  // At most five excerpts for the whole read (DS-N9-10), in that order.
  let left = opts.maxExcerpts ?? 5;
  const kept: PinnedDocsPage[] = [];
  for (const p of pages) {
    if (left <= 0) break;
    kept.push({ ...p, excerpts: p.excerpts.slice(0, left) });
    left -= Math.min(left, p.excerpts.length);
  }
  return { target, pages: kept };
}

/** The pages as the model reads them: each excerpt under its heading, with its URL and anchor. */
export function renderPinnedDocs(r: PinnedDocsRead): string {
  return [
    researchCopy.pinnedDocsHead(r.target.name, r.target.version),
    ...r.pages.map((p) =>
      [
        `## ${p.title}${p.label ? ` ${p.label}` : ""}`,
        p.url,
        ...p.excerpts.map(
          (e) =>
            `### ${e.heading || p.title} (${e.anchor ? `${e.url}#${e.anchor}` : e.url})\n${e.text}`,
        ),
      ].join("\n"),
    ),
  ].join("\n\n");
}

/** What `readDocsAtPin` read: the text for the model and the first page, for citing. */
export interface DocsReading {
  text: string;
  /** The first page read; undefined when none was. */
  url?: string;
  title?: string;
}

/**
 * The one documentation reader for the Worker's `docs` web tier and the
 * Researcher's `read_docs` (DS-N9-12): a dependency the project pins is read
 * at that version; when no page answers at any version, or the name is not a
 * dependency (`node`, a docs URL), its known documentation home is read as
 * before, labelled as an unknown version when the project pins it.
 * `repo` undefined reads nothing of the repository (the brief's deep question).
 */
export async function readDocsAtPin(
  repo: string | undefined,
  library: string,
  question: string,
  fetchText: TextFetch,
  opts: { maxPages?: number; maxFetch?: number; charsPerPage?: number; fetchApi?: TextFetch } = {},
): Promise<DocsReading> {
  const target = repo ? pinnedTarget(repo, library) : undefined;
  if (target) {
    const r = await readPinnedDocs(target, question, fetchText, {
      maxPages: opts.maxPages ?? 2,
      maxFetch: opts.maxFetch ?? 6,
      ...(opts.fetchApi ? { fetchApi: opts.fetchApi } : {}),
    });
    const first = r.pages[0];
    if (first) return { text: renderPinnedDocs(r), url: first.url, title: first.title };
  }
  const r = await readDocs(library, question, fetchText, {
    ...(opts.maxFetch ? { maxFetch: opts.maxFetch } : {}),
    ...(opts.maxPages ? { maxPages: opts.maxPages } : {}),
    ...(opts.charsPerPage ? { charsPerPage: opts.charsPerPage } : {}),
  });
  if (typeof r === "string") return { text: r };
  if (r.pages.length === 0) return { text: researchCopy.noReadableDocs(r.root) };
  const label = target ? ` ${researchCopy.docsForVersion(undefined, target.version)}` : "";
  const first = r.pages[0];
  return {
    text: `${r.available ? `${researchCopy.docsSetSize(r.available, r.pages.length)}\n` : ""}${r.pages
      .map((p) => `## ${p.title}${label}\n${p.url}\n${p.text}`)
      .join("\n\n")}`,
    ...(first ? { url: first.url, title: first.title } : {}),
  };
}
