import { type LibraryHit, licenseVerdict } from "../pm/libraries.js";
import type { Hit } from "./web.js";

/**
 * Reuse before rebuild: what already exists for each thing a spec asks for.
 *
 * The complaint this answers is one of the most common about coding agents —
 * they rewrite what a maintained, legally usable package or repository already
 * does. So before a spec becomes cards, the planner looks: the package
 * registries, GitHub, and, when the work is an algorithm rather than plumbing,
 * the literature. Only what the licence allows is recommended; what was
 * excluded is said, with the licence that excluded it; and a search that could
 * not run is reported as not searched, never as "nothing found".
 *
 * Only short keyword queries leave the machine, never the spec or the code.
 */

export interface RepoHit {
  fullName: string;
  license: string;
  usable: boolean;
  note?: string;
  stars: number;
  archived: boolean;
  pushedAt: string;
  description: string;
  url: string;
}

export interface ReuseFinding {
  need: string;
  libraries: LibraryHit[];
  repos: RepoHit[];
  papers: Hit[];
  /** Candidates dropped for their licence, as "name (licence)". */
  excluded: string[];
  /** Sources that could not be searched (offline, rate-limited). */
  unsearched: string[];
}

export interface ReuseDeps {
  libraries: (query: string) => Promise<LibraryHit[]>;
  repos: (query: string) => Promise<RepoHit[]>;
  papers?: (query: string) => Promise<Hit[]>;
}

type Fetcher = (url: string) => Promise<unknown>;

const STOP = new Set(
  "a an the that this it its and or of to for in on with by from my our your their which who is are be should must can will".split(
    " ",
  ),
);
/**
 * Words that say what kind of thing is built, not what it is about. Live
 * searches on "handles refunds" and "a CLI that deduplicates photos" returned
 * a streams library and a GraphQL tool, matched on exactly these.
 */
const GENERIC = new Set(
  "cli tool tools app apps application service services library lib program script system handles handle manages manage folder directory file files simple basic small new node typescript javascript".split(
    " ",
  ),
);

const stem = (w: string): string => w.slice(0, 5);

/** Stems of a text's words, with hyphenated words also read joined. */
function stems(text: string): Set<string> {
  const lower = text.toLowerCase();
  const words = [...lower.split(/[^a-z]+/), ...lower.replace(/-/g, "").split(/[^a-z]+/)].filter(
    (w) => w.length > 2,
  );
  return new Set(words.map(stem));
}

/**
 * Does a candidate share what the need is about? At least two of the need's
 * content words (one, when it has only one), by stem, in its name or
 * description. A candidate that matched only a popular keyword is not one.
 */
function relevant(need: string, text: string, minimum = 2): boolean {
  const wanted = [...new Set(queryFor(need).split(" ").filter(Boolean).map(stem))];
  if (!wanted.length) return false;
  const have = stems(text);
  const overlap = wanted.filter((w) => have.has(w)).length;
  return overlap >= Math.min(minimum, wanted.length);
}

/** A short keyword query: what leaves the machine is this, not the spec. */
export function queryFor(need: string): string {
  return need
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !GENERIC.has(w))
    .slice(0, 4)
    .join(" ");
}

/** Work that is an algorithm, where the literature knows more than a registry. */
export function needsLiterature(need: string): boolean {
  return /\b(?:algorithm|rank|recommend|compress|schedul|optimi[sz]|classif|detect|predict|cluster|similar|search|embedding|forecast|rout|match|dedup|diff)\w*/i.test(
    need,
  );
}

/** GitHub repositories for a query, each with a licence verdict. */
export async function searchRepos(query: string, fetcher: Fetcher): Promise<RepoHit[]> {
  const body = (await fetcher(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`,
  )) as {
    items?: {
      full_name: string;
      license: { spdx_id?: string | null } | null;
      stargazers_count: number;
      archived: boolean;
      pushed_at: string;
      description: string | null;
      html_url: string;
    }[];
  };
  return (body.items ?? []).map((r) => {
    const spdx = r.license?.spdx_id;
    const license = spdx && spdx !== "NOASSERTION" ? spdx : "unknown";
    return {
      fullName: r.full_name,
      license,
      ...licenseVerdict(license),
      stars: r.stargazers_count,
      archived: r.archived,
      pushedAt: r.pushed_at,
      description: r.description ?? "",
      url: r.html_url,
    };
  });
}

const TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000;
/**
 * Below these, a candidate is someone's experiment, not a dependency: live
 * searches recommended a test fork at 187 downloads a week.
 */
const MIN_WEEKLY_DOWNLOADS = 1000;
const MIN_STARS = 20;
/** No licence means all rights reserved: unusable, and not worth naming. */
const unlicensed = (license: string) => /^(?:unknown|none|unlicensed|)$/i.test(license.trim());

export async function reuseSurvey(
  needs: readonly string[],
  deps: ReuseDeps,
  options: { now?: Date; perNeed?: number } = {},
): Promise<ReuseFinding[]> {
  const now = options.now ?? new Date();
  const keep = options.perNeed ?? 3;
  const findings: ReuseFinding[] = [];
  for (const need of needs) {
    const q = queryFor(need) || need;
    const unsearched: string[] = [];
    const attempt = async <T>(label: string, run: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await run();
      } catch {
        unsearched.push(label);
        return [];
      }
    };
    const libs = await attempt("registries", () => deps.libraries(q));
    const repos = await attempt("GitHub", () => deps.repos(q));
    const searchPapers = deps.papers;
    const papers =
      searchPapers && needsLiterature(need)
        ? await attempt("literature", () => searchPapers(q))
        : [];

    // Relevance first: an unrelated result is not a candidate, so it is
    // neither recommended nor "excluded for its licence".
    const libsOn = libs.filter(
      (l) =>
        relevant(need, `${l.name} ${l.description}`) &&
        (l.weeklyDownloads === undefined || l.weeklyDownloads >= MIN_WEEKLY_DOWNLOADS),
    );
    const reposOn = repos.filter(
      (r) => relevant(need, `${r.fullName} ${r.description}`) && r.stars >= MIN_STARS,
    );
    const papersOn = papers.filter((p) => relevant(need, `${p.title} ${p.snippet}`, 1));
    const excluded = [
      ...libsOn
        .filter((l) => !l.usable && !unlicensed(l.license))
        .map((l) => `${l.name} (${l.license})`),
      ...reposOn
        .filter((r) => !r.usable && !unlicensed(r.license))
        .map((r) => `${r.fullName} (${r.license})`),
    ];
    // A repository nobody maintains is a liability, not a head start.
    const maintained = (r: RepoHit) =>
      !r.archived && now.getTime() - Date.parse(r.pushedAt) < TWO_YEARS_MS;
    findings.push({
      need,
      libraries: libsOn.filter((l) => l.usable).slice(0, keep),
      repos: reposOn.filter((r) => r.usable && maintained(r)).slice(0, keep),
      papers: papersOn.slice(0, keep),
      excluded,
      unsearched,
    });
  }
  return findings;
}

const libLine = (l: LibraryHit) =>
  `${l.name} (${l.license}${l.weeklyDownloads ? `, ${l.weeklyDownloads.toLocaleString("en-US")}/week` : ""}) ${l.url}`;
const repoLine = (r: RepoHit) => `${r.fullName} (${r.license}, ${r.stars}★) ${r.url}`;

/** The brief's Prior art section, one entry per need. */
export function priorArtLines(findings: readonly ReuseFinding[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`- **${f.need}**`);
    if (f.libraries.length) lines.push(`  - packages: ${f.libraries.map(libLine).join("; ")}`);
    if (f.repos.length) lines.push(`  - repositories: ${f.repos.map(repoLine).join("; ")}`);
    if (f.papers.length)
      lines.push(`  - literature: ${f.papers.map((p) => `${p.title} ${p.url}`).join("; ")}`);
    if (f.excluded.length) lines.push(`  - excluded for their licence: ${f.excluded.join(", ")}`);
    for (const s of f.unsearched) lines.push(`  - ${s}: not searched (unreachable)`);
    if (!f.libraries.length && !f.repos.length && !f.papers.length && !f.unsearched.length) {
      lines.push("  - nothing suitable found; this is written here.");
    }
  }
  return lines;
}

/** What the Worker is told before it writes something that already exists. */
export function dossierNote(f: ReuseFinding): string | undefined {
  const options = [...f.libraries.map(libLine), ...f.repos.map(repoLine)];
  if (!options.length && !f.papers.length) return undefined;
  const parts = [];
  if (options.length)
    parts.push(
      `Before writing this yourself, consider what exists for "${f.need}": ${options.join("; ")}. Licences checked as usable; matched on name and description, so read one before depending on it. Depend on one, or say with note why none fits.`,
    );
  if (f.papers.length)
    parts.push(`Relevant literature: ${f.papers.map((p) => `${p.title} ${p.url}`).join("; ")}.`);
  return parts.join(" ");
}

/** Put what was found into the brief's Prior art section. */
export function withPriorArt(brief: string, lines: readonly string[]): string {
  return brief.replace(/## Prior art\n[\s\S]*?(?=\n## |$)/, `## Prior art\n${lines.join("\n")}\n`);
}
