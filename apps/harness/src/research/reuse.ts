import { detectGateTemplate } from "@sekhemet/gates";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import {
  type LibraryCandidate,
  type LibraryHit,
  type LicenceJudgement,
  type RepoCandidate,
  type RepoHit,
  screenLibraries,
  screenRepos,
} from "../pm/libraries.js";
import { type QueryOrigin, capabilityQueries } from "./capability_queries.js";
import { type DepsDevVersion, withDepsDev } from "./deps_dev.js";
import { builtInNeed, relevanceTermsFor } from "./keywords.js";
import { rankByRelevance } from "./rank.js";
import type { Hit } from "./web.js";

export { builtInNeed, queryFor } from "./keywords.js";
export {
  type RepoCandidate,
  type RepoHit,
  githubSearchUrl,
  searchRepos,
} from "../pm/libraries.js";

/**
 * Reuse before rebuild: what already exists for each thing a spec asks for.
 *
 * The complaint this answers is one of the most common about coding agents —
 * they rewrite what a maintained, legally usable package or repository already
 * does. So before a spec becomes cards, the planner looks: the package
 * registries, GitHub, and, when the work is an algorithm rather than plumbing,
 * the literature. Only what the licence allows is recommended, every licence
 * judged by the one classifier (`classifyLicence`, P7); weak copyleft is
 * flagged, anything else excluded is said with the licence that excluded it,
 * and a candidate with no licence is dropped silently; a search that could
 * not run is reported as not searched, never as "nothing found".
 *
 * Only short queries leave the machine, never the spec or the code: the
 * Planning model's capability queries, or the need's keywords without one
 * (`capabilityQueries`). Candidates are ranked by BM25 over their names,
 * descriptions and keywords (`rankByRelevance`), and in research mode
 * deps.dev supplies each one's release date, licences and advisories.
 */

export interface ReuseFinding {
  need: string;
  libraries: LibraryHit[];
  repos: RepoHit[];
  papers: Hit[];
  /** Candidates dropped for their licence, as "name (licence)". */
  excluded: string[];
  /** Weak-copyleft candidates, not recommended, named for a person to decide (DS-P7-2). */
  flagged: string[];
  /** Sources that could not be searched (offline, rate-limited). */
  unsearched: string[];
  /** The language itself covers this need: no package is needed, none was searched (DS-P7-6). */
  noneNeeded?: boolean;
  /** What was searched for it, and who wrote the queries (design-stage §2.5 item 1). */
  queries?: string[];
  origin?: QueryOrigin;
  /** Usable packages not recommended: deps.dev knows advisories on the version found, as "name (ids)". */
  advised?: string[];
  /** Why deps.dev was not asked about this need's packages, when it was not (DEC-44). */
  depsDevNotChecked?: string;
}

/** A project's language, as the survey searches for it (DS-P7-5). */
export type ReuseStack = "typescript" | "python" | "rust" | "go";

export interface ReuseDeps {
  /** Registry results; the survey judges each licence itself (DS-P7-3). */
  libraries: (query: string, ecosystem: "npm" | "pypi") => Promise<LibraryCandidate[]>;
  /** GitHub results, in the project's language when it has one (DS-P7-5). */
  repos: (query: string, language?: string) => Promise<RepoCandidate[]>;
  papers?: (query: string) => Promise<Hit[]>;
  /**
   * deps.dev's record of a package version (DEC-44), undefined when it does
   * not know it; omitted, the registry's own facts stand.
   */
  depsDev?: (
    ecosystem: "npm" | "pypi",
    name: string,
    version: string,
  ) => Promise<DepsDevVersion | undefined>;
  /** Each query sent, for the ledger's `research/query` (design-stage DS-S8-3). */
  record?: (q: ResearchQuery) => void | Promise<void>;
}

/** One query the survey sent: its source, the keywords, the names it found. */
export interface ResearchQuery {
  source: string;
  /** The need's keywords, or a capability query the Planning model wrote (DS-S8-3). */
  query: string;
  /** Who wrote the query; a name looked up is its search's. */
  origin?: QueryOrigin;
  /** The search's language qualifier, when the project has one (DS-P7-5). */
  language?: string;
  results: string[];
  ok: boolean;
}

/** Work that is an algorithm, where the literature knows more than a registry. */
export function needsLiterature(need: string): boolean {
  return /\b(?:algorithm|rank|recommend|compress|schedul|optimi[sz]|classif|detect|predict|cluster|similar|search|embedding|forecast|rout|match|dedup|diff)\w*/i.test(
    need,
  );
}

/** Registry and GitHub language per stack: npm for TypeScript, PyPI for Python, none for Rust and Go. */
const SEARCH: Record<ReuseStack, { ecosystem?: "npm" | "pypi"; language?: string }> = {
  typescript: { ecosystem: "npm" },
  python: { ecosystem: "pypi", language: "python" },
  rust: { language: "rust" },
  go: { language: "go" },
};

/**
 * The project's language for the survey: its manifests first, read by the
 * one detector the gate templates use (`detectGateTemplate`), then the
 * language the request named or the design stage assumed (DS-P7-5).
 */
export function reuseStack(repoPath: string, stated: ReuseStack): ReuseStack {
  switch (detectGateTemplate(repoPath)) {
    case "pnpm":
    case "npm":
    case "yarn":
      return "typescript";
    case "python":
      return "python";
    case "rust":
      return "rust";
    case "go":
      return "go";
    default:
      return stated;
  }
}

/** Candidates enriched from deps.dev per need, at most: one request each. */
const DEPS_DEV_PER_NEED = 6;

/**
 * Look for what already exists for each need, in the project's own
 * ecosystem (DS-P7-5), and keep what passes the one set of filters the
 * `find_library` tools also apply (DS-P7-9): relevance (BM25), popularity,
 * licence, maintenance and, with deps.dev, advisories. A need the language
 * itself covers is not searched: no package is needed, and the finding says
 * so (DS-P7-6). With a Planning model (`planner`), each need is searched by
 * its capability queries; the registry takes each of them, GitHub the first
 * only (its unauthenticated search allows ten a minute).
 */
export async function reuseSurvey(
  needs: readonly string[],
  deps: ReuseDeps,
  options: {
    now?: Date;
    perNeed?: number;
    stack?: ReuseStack;
    /** The Planning model, which writes the capability queries; omitted, the keywords are sent. */
    planner?: LocalInferenceAdapter;
  } = {},
): Promise<ReuseFinding[]> {
  const now = options.now ?? new Date();
  const keep = options.perNeed ?? 3;
  const stack = options.stack ?? "typescript";
  const { ecosystem, language } = SEARCH[stack];
  const findings: ReuseFinding[] = [];
  for (const need of needs) {
    if (builtInNeed(need)) {
      findings.push({
        need,
        libraries: [],
        repos: [],
        papers: [],
        excluded: [],
        flagged: [],
        unsearched: [],
        noneNeeded: true,
      });
      continue;
    }
    // DS-S8-4: a need with no query left sends nothing at all.
    const { queries, origin } = await capabilityQueries(need, {
      ...(options.planner ? { planner: options.planner } : {}),
      stack,
    });
    const first = queries[0];
    if (!first) continue;
    const unsearched: string[] = [];
    const attempt = async <T>(
      label: string,
      q: string,
      run: () => Promise<T[]>,
      name: (hit: T) => string,
    ): Promise<T[]> => {
      const sent = { source: label, query: q, origin, ...(language ? { language } : {}) };
      try {
        const hits = await run();
        await deps.record?.({ ...sent, results: hits.map(name), ok: true });
        return hits;
      } catch {
        if (!unsearched.includes(label)) unsearched.push(label);
        await deps.record?.({ ...sent, results: [], ok: false });
        return [];
      }
    };
    // Rust and Go have no registry search here: GitHub, in the language, only.
    // A Python registry search is a GitHub search: the first query only.
    const registryQueries = ecosystem === "npm" ? queries : [first];
    const libs: LibraryCandidate[] = [];
    if (ecosystem) {
      for (const q of registryQueries) {
        for (const l of await attempt(
          "registries",
          q,
          () => deps.libraries(q, ecosystem),
          (x) => x.name,
        )) {
          if (!libs.some((x) => x.name === l.name)) libs.push(l);
        }
      }
    }
    const repos = await attempt(
      "GitHub",
      first,
      () => deps.repos(first, language),
      (r) => r.fullName,
    );
    const searchPapers = deps.papers;
    const papers =
      searchPapers && needsLiterature(need)
        ? await attempt(
            "literature",
            first,
            () => searchPapers(first),
            (p) => p.title,
          )
        : [];

    // deps.dev, for the candidates the filters would consider: the release
    // date, the licences and the advisories of the version found (DEC-44).
    const extra = origin === "planning-model" ? queries : [];
    const { enriched, notChecked } = await withDepsDevFacts(
      screenLibraries(need, libs, now, extra).candidates,
      libs,
      deps,
    );
    // Every licence is judged there, by the classifier, whatever the search said.
    const libsOn = screenLibraries(need, enriched, now, extra);
    const reposOn = screenRepos(need, repos, now, extra);
    const papersOn = rankByRelevance([relevanceTermsFor(need), ...extra], papers, {
      text: (p) => ({ name: p.title, description: p.snippet }),
      minimum: 1,
    });
    // DS-P7-2: weak copyleft flagged, the rest excluded and named, absent dropped.
    const named = (action: LicenceJudgement["action"]) => [
      ...libsOn.candidates
        .filter((l) => l.action === action)
        .map((l) => `${l.name} (${l.license})`),
      ...reposOn.candidates
        .filter((r) => r.action === action)
        .map((r) => `${r.fullName} (${r.license})`),
    ];
    findings.push({
      need,
      libraries: libsOn.recommended.slice(0, keep),
      repos: reposOn.recommended.slice(0, keep),
      papers: papersOn.slice(0, keep),
      excluded: named("exclude"),
      flagged: named("flag"),
      unsearched,
      queries,
      origin,
      ...(libsOn.advised.length
        ? {
            advised: libsOn.advised.map((l) => `${l.name} (${(l.advisories ?? []).join(", ")})`),
          }
        : {}),
      ...(notChecked ? { depsDevNotChecked: notChecked } : {}),
    });
  }
  return findings;
}

/**
 * The candidates with deps.dev's facts, best first, at most
 * `DEPS_DEV_PER_NEED` asked; the rest, and every one when deps.dev cannot
 * be asked, keep the registry's. The first failure stops the asking: a host
 * awaiting a yes, or unreachable, is said once for the need.
 */
async function withDepsDevFacts(
  ranked: readonly LibraryCandidate[],
  all: readonly LibraryCandidate[],
  deps: ReuseDeps,
): Promise<{ enriched: LibraryCandidate[]; notChecked?: string }> {
  const lookup = deps.depsDev;
  if (!lookup || ranked.length === 0) return { enriched: [...all] };
  const facts = new Map<string, LibraryCandidate>();
  let notChecked: string | undefined;
  for (const c of ranked.slice(0, DEPS_DEV_PER_NEED)) {
    const sent = { source: "deps.dev", query: c.name };
    try {
      const d = await lookup(c.ecosystem, c.name, c.version);
      await deps.record?.({ ...sent, results: d ? [`${c.name}@${d.version}`] : [], ok: true });
      if (d) facts.set(c.name, withDepsDev(c, d));
    } catch (err) {
      await deps.record?.({ ...sent, results: [], ok: false });
      // A refusal by the network policy says why; anything else is an outage.
      const refused = /^network policy refused [^:]+: (.+)$/s.exec(
        err instanceof Error ? err.message : "",
      );
      notChecked = refused?.[1] ?? "unreachable";
      break;
    }
  }
  return {
    enriched: all.map((c) => facts.get(c.name) ?? c),
    ...(notChecked ? { notChecked } : {}),
  };
}

const libLine = (l: LibraryHit) =>
  `${l.name} (${l.license}${l.weeklyDownloads ? `, ${l.weeklyDownloads.toLocaleString("en-US")}/week` : ""}) ${l.url}`;
const repoLine = (r: RepoHit) => `${r.fullName} (${r.license}, ${r.stars}★) ${r.url}`;

/** DS-P7-6, said to a person: the language covers it. */
export const NONE_NEEDED =
  "no package is needed: the language's standard library covers this, so nothing was searched.";

/** The brief's Prior art section, one entry per need. */
export function priorArtLines(findings: readonly ReuseFinding[]): string[] {
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(`- **${f.need}**`);
    if (f.noneNeeded) {
      lines.push(`  - ${NONE_NEEDED}`);
      continue;
    }
    if (f.libraries.length) lines.push(`  - packages: ${f.libraries.map(libLine).join("; ")}`);
    if (f.repos.length) lines.push(`  - repositories: ${f.repos.map(repoLine).join("; ")}`);
    if (f.papers.length)
      lines.push(`  - literature: ${f.papers.map((p) => `${p.title} ${p.url}`).join("; ")}`);
    if (f.flagged.length)
      lines.push(
        `  - weak copyleft, check with the team before depending on it: ${f.flagged.join(", ")}`,
      );
    if (f.excluded.length) lines.push(`  - excluded for their licence: ${f.excluded.join(", ")}`);
    if (f.advised?.length)
      lines.push(
        `  - not recommended, known security advisories on the latest version: ${f.advised.join(", ")}`,
      );
    for (const s of f.unsearched) lines.push(`  - ${s}: not searched (unreachable)`);
    if (f.depsDevNotChecked)
      lines.push(
        `  - release dates, licences and advisories not checked on deps.dev: ${f.depsDevNotChecked}`,
      );
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

/** Add lines at the end of the brief's Prior art section, keeping what is there. */
export function appendPriorArt(brief: string, lines: readonly string[]): string {
  return brief.replace(
    /## Prior art\n([\s\S]*?)\n*(?=\n## |$)/,
    (_m, body: string) =>
      `## Prior art\n${[body.replace(/\n+$/, ""), ...lines].filter(Boolean).join("\n")}\n`,
  );
}

/** The Researcher's answer to the brief's deep question (DS-P7-10). */
export interface DeepAnswer {
  answer: string;
  sources: string[];
  grounded: boolean;
}

/**
 * The brief's deep question: the Researcher's to run when it may (it is
 * configured, research is allowed and no card is running), or why it may not.
 */
export type DeepPriorArt = { run: (question: string) => Promise<DeepAnswer> } | { skipped: string };

/**
 * Thrown by a deep question's `run` that finds, when it is about to load
 * the Researcher, that it may not run after all (a card started while the
 * plan ran): the brief says it did not run and why, not that it failed.
 */
export class DeepQuestionSkipped extends Error {}

/**
 * The Prior art lines for the deep question (DS-P7-10): one cited answer, or
 * that it did not run and why. An answer that cites nothing is not written
 * as one.
 */
export function deepPriorArtLines(outcome: { answer: DeepAnswer } | { skipped: string }): string[] {
  if ("skipped" in outcome) return [`- The deep question did not run: ${outcome.skipped}.`];
  const a = outcome.answer;
  if (!a.grounded || a.sources.length === 0) {
    return ["- The deep question ran but its answer cited no source, so it is not written here."];
  }
  const text = a.answer.replace(/\s+/g, " ").trim().slice(0, 1500);
  return [
    `- **The Research model's deep answer**: ${text}`,
    `  - sources: ${a.sources.map((s, i) => `[${i + 1}] ${s}`).join("; ")}`,
  ];
}
