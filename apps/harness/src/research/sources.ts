import { hostOf } from "./polite.js";

/**
 * What a source is worth, and how sure the Researcher may be.
 *
 * Ported from Helga's ranking.py and re-weighted for software work. Two ideas
 * carried over because Helga paid for them in bugs:
 *
 * 1. One registry of source kinds. Helga's confidence score was wrong three
 *    times because callers kept their own list of kinds and a new kind scored
 *    zero. Here the scorer reads kinds off the sources themselves, and an
 *    unregistered kind gets a small non-zero weight rather than vanishing.
 * 2. Caps per family. Without them the score rewards count, and five blog
 *    posts outscore the official documentation. Substitutes share a cap.
 *
 * For software, the settled canon is the project's own documentation, its
 * type declarations and its source; a paper is evidence at the frontier; a
 * forum answer is a lead to verify, not an authority.
 */

export type SourceKind =
  | "documentation" // official docs of the library or platform
  | "api" // type declarations or the module's real exports
  | "source" // the code itself (a repository file, the project's history)
  | "specification" // a standard: RFC, W3C, TC39, WHATWG
  | "paper" // peer-reviewed or preprint
  | "registry" // npm / PyPI metadata (licence, versions)
  | "repository" // a GitHub repository listing
  | "forum" // Stack Overflow, discussions, issues
  | "web"; // anything else

/** kind -> points per source and cap family. */
export const SOURCE_KIND_WEIGHTS: Record<SourceKind, [number, string]> = {
  documentation: [0.35, "canon"],
  api: [0.35, "canon"],
  specification: [0.35, "canon"],
  source: [0.3, "code"],
  paper: [0.25, "frontier"],
  registry: [0.15, "metadata"],
  repository: [0.15, "metadata"],
  forum: [0.15, "community"],
  web: [0.1, "community"],
};

/** Full confidence has to be earned with canon or code, never with a pile of posts. */
export const FAMILY_CAPS: Record<string, number> = {
  canon: 0.7,
  code: 0.4,
  frontier: 0.5,
  metadata: 0.2,
  community: 0.3,
};

const UNKNOWN_WEIGHT = 0.1;
const UNKNOWN_CAP = 0.2;

export interface Source {
  kind: SourceKind | string;
  ref: string; // a URL, "arXiv 2605.03042", "npm README of zod", a file path
  title?: string;
  /** The words the model actually read from it (for coverage and citation checks). */
  excerpt?: string;
}

/** Grounding confidence in [0, 1] from the sources whose text reached the model. */
export function groundingConfidence(sources: Source[]): number {
  const byFamily = new Map<string, number>();
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.ref)) continue;
    seen.add(s.ref);
    const [w, family] = SOURCE_KIND_WEIGHTS[s.kind as SourceKind] ?? [UNKNOWN_WEIGHT, "unknown"];
    byFamily.set(family, (byFamily.get(family) ?? 0) + w);
  }
  let total = 0;
  for (const [family, score] of byFamily)
    total += Math.min(score, FAMILY_CAPS[family] ?? UNKNOWN_CAP);
  return Math.round(Math.min(total, 1) * 100) / 100;
}

/** Hosts whose pages are primary documentation or standards. */
const CANON_HOSTS = [
  "nodejs.org",
  "developer.mozilla.org",
  "typescriptlang.org",
  "docs.python.org",
  "sqlite.org",
  "postgresql.org",
  "vitest.dev",
  "biomejs.dev",
  "react.dev",
  "doc.rust-lang.org",
  "go.dev",
  "pnpm.io",
  "tc39.es",
  "w3.org",
  "whatwg.org",
  "rfc-editor.org",
  "datatracker.ietf.org",
  "readthedocs.io",
  "readthedocs.org",
  "docs.github.com",
];
const PAPER_HOSTS = [
  "arxiv.org",
  "openreview.net",
  "aclanthology.org",
  "doi.org",
  "dl.acm.org",
  "semanticscholar.org",
];
const FORUM_HOSTS = [
  "stackoverflow.com",
  "stackexchange.com",
  "serverfault.com",
  "superuser.com",
  "reddit.com",
  "news.ycombinator.com",
];
/** Content farms and scraped mirrors: never cited. */
export const BLOCKED_HOSTS = [
  "geeksforgeeks.org",
  "w3resource.com",
  "tutorialspoint.com",
  "javatpoint.com",
  "codegrepper.com",
  "programmerall.com",
  "coder.work",
  "itecnote.com",
];

const matches = (host: string, list: string[]) =>
  list.some((e) => host === e || host.endsWith(`.${e}`));

/** Classify a URL by what it most likely is. Docs subdomains count as documentation. */
export function kindOfUrl(url: string): SourceKind {
  const host = hostOf(url);
  if (!host) return "web";
  if (matches(host, PAPER_HOSTS)) return "paper";
  if (matches(host, CANON_HOSTS) || /^docs?\./.test(host) || /\/docs?\//.test(url))
    return "documentation";
  if (host === "github.com") {
    return /\/(blob|tree)\//.test(url) ? "source" : "repository";
  }
  if (host === "npmjs.com" || host === "pypi.org") return "registry";
  if (matches(host, FORUM_HOSTS)) return "forum";
  return "web";
}

/** 1 (canon) to 3 (anything); undefined when blocked. Used to order results. */
export function tierOf(url: string): 1 | 2 | 3 | undefined {
  const host = hostOf(url);
  if (matches(host, BLOCKED_HOSTS)) return undefined;
  const k = kindOfUrl(url);
  if (k === "documentation" || k === "paper" || k === "source") return 1;
  if (k === "repository" || k === "registry" || k === "forum") return 2;
  return 3;
}

/**
 * Order hits: blocked hosts dropped, duplicates removed (by URL without
 * fragment or trailing slash), then by tier, keeping the engine's order within one.
 */
export function rankHits<T extends { url: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const kept: { h: T; tier: number; i: number }[] = [];
  hits.forEach((h, i) => {
    const tier = tierOf(h.url);
    const key = h.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (tier === undefined || seen.has(key)) return;
    seen.add(key);
    kept.push({ h, tier, i });
  });
  return kept.sort((a, b) => a.tier - b.tier || a.i - b.i).map((k) => k.h);
}

/** The topic of a checklist item, without the explanation models append after a colon. */
export function topicName(item: string): string {
  let head = item.split(":", 1)[0]?.trim() ?? "";
  for (const sep of [" — ", " – ", " - "])
    if (head.includes(sep)) head = head.split(sep)[0]?.trim() ?? head;
  return head || item.trim();
}

const STOP = new Set([
  "what",
  "which",
  "does",
  "with",
  "from",
  "that",
  "this",
  "have",
  "when",
  "where",
  "there",
  "their",
  "about",
  "into",
  "should",
  "would",
  "could",
  "using",
  "used",
]);

/**
 * Deterministic coverage: does the evidence mention at least half of the
 * item's content words? No model judges it, so it cannot drift (Helga: the
 * model proposes, the code disposes). Weak on purpose: "did we find something
 * about this", not "is it good"; the citation check and the reviewer do that.
 */
export function isCovered(item: string, evidence: string): boolean {
  const words = topicName(item)
    .toLowerCase()
    .split(/[^a-z0-9_.@/-]+/)
    .map((w) => w.replace(/^[.]+|[.]+$/g, ""))
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 6);
  if (words.length === 0) return false;
  const blob = evidence.toLowerCase();
  const hits = words.filter((w) => blob.includes(w)).length;
  return hits >= Math.max(1, Math.ceil(words.length / 2));
}
