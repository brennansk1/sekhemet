/**
 * "Is there already a library for this?" - asked before a card is written.
 *
 * The user's second most common complaint about AI coding agents is that they
 * reinvent what a well-maintained, legally usable package already does. Seshat
 * searches the public registries and checks each result's licence before it
 * ever suggests one. Only the search text leaves the machine, and only when
 * Seshat decides to search; the Worker stays offline in its sandbox.
 */

import {
  type LicenceAction,
  type LicenceClassification,
  type LicenceVerdict,
  classifyLicence,
  licenceFromTroveClassifiers,
} from "@sekhemet/gates";
import { queryFor, relevanceTermsFor } from "../research/keywords.js";
import { rankByRelevance } from "../research/rank.js";

/** A registry result as found, before its licence is judged. */
export interface LibraryCandidate {
  name: string;
  ecosystem: "npm" | "pypi";
  version: string;
  /** The licence as the registry states it. */
  license: string;
  description: string;
  weeklyDownloads?: number;
  /** Stars of the project's repository, when the search knows them (DS-P7-4). */
  stars?: number;
  /** When its latest release was published (ISO), for the maintenance filter. */
  publishedAt?: string;
  /** Its repository is archived: nobody maintains it. */
  archived?: boolean;
  /** The registry's keywords, ranked with the name and description (P7). */
  keywords?: string[];
  /** Advisories affecting this version, from deps.dev in research mode (DEC-44). */
  advisories?: string[];
  url: string;
}

/**
 * A licence judged by the one classifier (`classifyLicence`, design-stage
 * P7): never set by hand, never read from a search result.
 */
export interface LicenceJudgement {
  /** Only a permissive licence is safe to depend on in any project. */
  usable: boolean;
  verdict: LicenceVerdict;
  /** DS-P7-2: recommend, flag (weak copyleft), exclude and name, or drop silently. */
  action: LicenceAction;
  /** Why it is not usable, for a person and the model. */
  note?: string;
}

export type LibraryHit = LibraryCandidate & LicenceJudgement;

/** A registry search; injectable for tests. Its results are judged by the caller. */
export type LibrarySearch = (
  query: string,
  ecosystem?: "npm" | "pypi",
) => Promise<LibraryCandidate[]>;

const NOT_USABLE: Readonly<Record<Exclude<LicenceVerdict, "permissive">, string>> = {
  weak_copyleft: "weak copyleft, check with the team before depending on it",
  strong_copyleft: "strong copyleft, not usable without the team's agreement",
  proprietary: "proprietary or restricted, not usable",
  unknown: "no clear licence, do not use without legal review",
  absent: "no licence, so all rights are reserved",
};

/** The verdict in words: "permissive, usable", or why it is not usable. */
export function licenceVerdictWords(verdict: LicenceVerdict): string {
  return verdict === "permissive" ? "permissive, usable" : NOT_USABLE[verdict];
}

function noteFor(license: string, c: LicenceClassification): string | undefined {
  if (c.verdict === "permissive") return undefined;
  const why = NOT_USABLE[c.verdict];
  return license.trim() ? `${license}: ${why}` : why;
}

/** A licence string judged by the one classifier. */
export function judgeLicence(license: string | null | undefined): LicenceJudgement {
  const c = classifyLicence(license);
  const note = noteFor(license ?? "", c);
  return { usable: c.usable, verdict: c.verdict, action: c.action, ...(note ? { note } : {}) };
}

/**
 * A candidate with its licence judged now, by the classifier: whatever
 * `usable` or verdict a search result carried is replaced (DS-P7-3).
 */
export function judged<T extends { license: string }>(
  candidate: T,
): Omit<T, keyof LicenceJudgement> & LicenceJudgement {
  const {
    usable: _u,
    verdict: _v,
    action: _a,
    note: _n,
    ...rest
  } = candidate as T & Partial<LicenceJudgement>;
  return { ...(rest as Omit<T, keyof LicenceJudgement>), ...judgeLicence(candidate.license) };
}

/**
 * JSON for a URL. There is no default: every caller hands in a fetch that
 * goes through the research network policy (`researchFetch`, logged as
 * `harness/egress`), so no registry request leaves unguarded.
 */
export type Fetcher = (url: string) => Promise<unknown>;

/** A GitHub repository as found, before its licence is judged. */
export interface RepoCandidate {
  fullName: string;
  /** GitHub's SPDX id, `NOASSERTION` for a licence it could not name, or `unknown` for none. */
  license: string;
  stars: number;
  archived: boolean;
  pushedAt: string;
  description: string;
  /** GitHub's topics, ranked with the name and description (P7). */
  topics?: string[];
  url: string;
}

export type RepoHit = RepoCandidate & LicenceJudgement;

/**
 * GitHub's repository search for a keyword query, in one language when the
 * project has one (DS-P7-5). One URL per query and language, so a plan that
 * searches both packages and repositories for a need sends it once.
 */
export function githubSearchUrl(query: string, language?: string): string {
  const q = language ? `${query} language:${language}` : query;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`;
}

/** GitHub repositories for a query, each with a licence verdict. */
export async function searchRepos(
  query: string,
  fetcher: Fetcher,
  language?: string,
): Promise<RepoHit[]> {
  const body = (await fetcher(githubSearchUrl(query, language))) as {
    items?: {
      full_name: string;
      license: { spdx_id?: string | null } | null;
      stargazers_count: number;
      archived: boolean;
      pushed_at: string;
      description: string | null;
      topics?: string[];
      html_url: string;
    }[];
  };
  return (body.items ?? []).map((r) =>
    judged({
      fullName: r.full_name,
      license: r.license?.spdx_id || "unknown",
      stars: r.stargazers_count,
      archived: r.archived,
      pushedAt: r.pushed_at,
      description: r.description ?? "",
      ...(Array.isArray(r.topics) && r.topics.length ? { topics: r.topics } : {}),
      url: r.html_url,
    }),
  );
}

/** A registry answered "no such project" (404): not found, unlike an outage. */
const notFound = (err: unknown) => err instanceof Error && /^404\b/.test(err.message);

/** The names a repository is published under on PyPI, most likely first. */
const pypiNames = (repo: string) => {
  const name = repo.toLowerCase();
  return [...new Set([name, `python-${name}`, name.replace(/^python-|^py-/, "")])];
};

const normalisedUrl = (u: string) =>
  u
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\.git$|\/+$/g, "");

/**
 * PyPI by verified name (DS-P7-5). PyPI has no search API, so the keyword
 * query goes to GitHub, in Python; each relevant, popular repository's name
 * is looked up on PyPI, and a project counts only when its own links name
 * that repository — a same-named project someone else published is not it.
 * Only names GitHub returned for the keywords are looked up. Its stars and
 * archived state are the repository's; its release date is PyPI's.
 */
export async function searchPyPI(query: string, fetcher: Fetcher): Promise<LibraryHit[]> {
  const repos = rankByRelevance([queryFor(query)], await searchRepos(query, fetcher, "python"), {
    text: repoText,
    popularity: (r) => r.stars,
  })
    .filter((r) => r.stars >= MIN_STARS)
    .slice(0, 3);
  const found: LibraryHit[] = [];
  for (const r of repos) {
    const repoUrl = normalisedUrl(`github.com/${r.fullName}`);
    for (const name of pypiNames(r.fullName.split("/")[1] ?? "")) {
      let body: {
        info: {
          name: string;
          version: string;
          license?: string | null;
          summary?: string | null;
          license_expression?: string | null;
          classifiers?: string[];
          home_page?: string | null;
          project_urls?: Record<string, string> | null;
        };
        urls?: { upload_time_iso_8601?: string }[];
      };
      try {
        body = (await fetcher(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as never;
      } catch (err) {
        if (notFound(err)) continue;
        throw err;
      }
      const links = [body.info.home_page ?? "", ...Object.values(body.info.project_urls ?? {})];
      // The repository itself or a page under it, never `<repo>-extra`.
      const linksBack = (l: string) => {
        const u = normalisedUrl(l);
        return u === repoUrl || (/^[/#?]/.test(u.slice(repoUrl.length)) && u.startsWith(repoUrl));
      };
      if (!links.some(linksBack)) continue;
      // PEP 639's expression first; then every licence trove classifier,
      // mapped to SPDX by the classifier's table and joined with AND (PyPI
      // sorts them, so the first is not the one that governs); then the free
      // `license` field, unless it holds a licence's whole text.
      const text = body.info.license?.trim() ?? "";
      const stated =
        body.info.license_expression?.trim() ||
        licenceFromTroveClassifiers(body.info.classifiers) ||
        (text.length <= 80 ? text : "");
      // Verified as the same project: the repository's licence when PyPI states none.
      const license = stated || r.license;
      const publishedAt = body.urls?.[0]?.upload_time_iso_8601;
      found.push({
        name: body.info.name,
        ecosystem: "pypi",
        version: body.info.version,
        license,
        ...judgeLicence(license),
        description: body.info.summary || r.description,
        stars: r.stars,
        archived: r.archived,
        ...(publishedAt ? { publishedAt } : {}),
        url: `https://pypi.org/project/${body.info.name}/`,
      });
      break;
    }
  }
  return found;
}

export async function searchLibraries(
  query: string,
  ecosystem: "npm" | "pypi",
  fetcher: Fetcher,
): Promise<LibraryHit[]> {
  if (ecosystem === "pypi") return searchPyPI(query, fetcher);
  const search = (await fetcher(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=6`,
  )) as {
    objects: {
      package: {
        name: string;
        version: string;
        description?: string;
        keywords?: string[];
        license?: string;
        date?: string;
        links?: { npm?: string };
      };
      downloads?: { weekly?: number };
    }[];
  };
  return search.objects.map(({ package: p, downloads }) => {
    const license = p.license ?? "unknown";
    return {
      name: p.name,
      ecosystem,
      version: p.version,
      license,
      ...judgeLicence(license),
      description: p.description ?? "",
      ...(Array.isArray(p.keywords) && p.keywords.length ? { keywords: p.keywords } : {}),
      ...(downloads?.weekly ? { weeklyDownloads: downloads.weekly } : {}),
      ...(p.date ? { publishedAt: p.date } : {}),
      url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
    };
  });
}

/**
 * The survey's filters, one set for the survey and both `find_library`
 * tools (DS-P7-4, DS-P7-9). Below these a candidate is someone's
 * experiment, not a dependency: live searches recommended a test fork at 187
 * downloads a week.
 */
export const MIN_WEEKLY_DOWNLOADS = 1000;
export const MIN_STARS = 20;
const TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000;

/**
 * Popular enough to depend on: a known weekly download count at the floor;
 * with none (or zero), at least 20 stars on its repository (DS-P7-4).
 */
export function popularEnough(c: { weeklyDownloads?: number; stars?: number }): boolean {
  if (c.weeklyDownloads) return c.weeklyDownloads >= MIN_WEEKLY_DOWNLOADS;
  return (c.stars ?? 0) >= MIN_STARS;
}

/** Maintained: not archived, and active (a release or a push) within two years. */
export function maintained(
  archived: boolean | undefined,
  lastActive: string | undefined,
  now: Date,
): boolean {
  if (archived) return false;
  if (!lastActive) return true;
  const at = Date.parse(lastActive);
  return Number.isNaN(at) || now.getTime() - at < TWO_YEARS_MS;
}

/** What the filters left: recommended, flagged (weak copyleft), excluded and named. */
export interface Screened<T> {
  /** Candidates, best first by relevance (BM25): relevant, popular, licence not absent. */
  candidates: T[];
  recommended: T[];
  flagged: T[];
  excluded: T[];
  /** Usable and maintained, but deps.dev knows advisories on the version found (DEC-44). */
  advised: T[];
}

function screen<T extends LicenceJudgement & { advisories?: string[] }>(
  kept: readonly T[],
  isMaintained: (c: T) => boolean,
): Screened<T> {
  // DS-P7-2: an absent licence is dropped silently: code nobody may use.
  const candidates = kept.filter((c) => c.action !== "drop");
  const advised = (c: T) => (c.advisories?.length ?? 0) > 0;
  return {
    candidates,
    recommended: candidates.filter((c) => c.usable && isMaintained(c) && !advised(c)),
    flagged: candidates.filter((c) => c.action === "flag"),
    excluded: candidates.filter((c) => c.action === "exclude"),
    advised: candidates.filter((c) => c.usable && isMaintained(c) && advised(c)),
  };
}

const libraryText = (l: LibraryCandidate) => ({
  name: l.name,
  description: l.description,
  ...(l.keywords ? { keywords: l.keywords } : {}),
});
const repoText = (r: RepoCandidate) => ({
  name: r.fullName,
  description: r.description,
  ...(r.topics ? { keywords: r.topics } : {}),
});
/** Weekly downloads where the registry counts them, else the repository's stars. */
const popularity = (c: { weeklyDownloads?: number; stars?: number }) =>
  c.weeklyDownloads || c.stars || 0;

/**
 * Registry results through the survey's filters: relevance to the need
 * first, ranked by BM25 over name, description and keywords with a
 * popularity prior (`rankByRelevance`) — an unrelated result is not a
 * candidate, so it is neither recommended nor "excluded for its licence" —
 * then popularity, then each licence judged here by the classifier, then
 * maintenance and advisories. `queries` are the capability queries the
 * survey sent besides the need's own keywords (design-stage §2.5 item 1).
 */
export function screenLibraries(
  need: string,
  found: readonly LibraryCandidate[],
  now: Date = new Date(),
  queries: readonly string[] = [],
): Screened<LibraryHit> {
  return screen(
    rankByRelevance([relevanceTermsFor(need), ...queries], found, { text: libraryText, popularity })
      .filter(popularEnough)
      .map(judged),
    (l) => maintained(l.archived, l.publishedAt, now),
  );
}

/** GitHub results through the same filters. */
export function screenRepos(
  need: string,
  found: readonly RepoCandidate[],
  now: Date = new Date(),
  queries: readonly string[] = [],
): Screened<RepoHit> {
  return screen(
    rankByRelevance([relevanceTermsFor(need), ...queries], found, { text: repoText, popularity })
      .filter(popularEnough)
      .map(judged),
    (r) => maintained(r.archived, r.pushedAt, now),
  );
}

/**
 * The results `find_library` shows, for Seshat and the Researcher alike:
 * the survey's relevance, popularity, maintenance and licence filters
 * applied to the query (DS-P7-9), each licence judged here by the
 * classifier; weak and strong copyleft are shown as not usable, a candidate
 * with no licence is dropped silently (DS-P7-2).
 */
export function formatHits(
  query: string,
  found: readonly LibraryCandidate[],
  now: Date = new Date(),
): string {
  const s = screenLibraries(query, found, now);
  const shown = new Set([...s.recommended, ...s.flagged, ...s.excluded]);
  const hits = s.candidates.filter((h) => shown.has(h));
  if (hits.length === 0) return "No packages found.";
  return hits
    .map(
      (h) =>
        `- ${h.name}@${h.version} (${h.ecosystem}, ${h.license}${h.usable ? ", usable" : `, NOT usable: ${h.note}`})${h.weeklyDownloads ? `, ${h.weeklyDownloads.toLocaleString("en-US")} downloads/week` : ""}: ${h.description.slice(0, 140)}`,
    )
    .join("\n");
}
