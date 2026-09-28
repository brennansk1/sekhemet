import type { Fetcher, LibraryCandidate } from "../pm/libraries.js";

/**
 * deps.dev (Google's free API, v3; DEC-44, REUSE_SURVEY_2026-09 "licence,
 * popularity and maintenance signals"): in research mode only, through the
 * one network policy, for a candidate's release date, SPDX licences and
 * advisories. One request per candidate, for the version the registry named
 * as its latest: `GET /v3/systems/{npm|pypi}/packages/{name}/versions/{v}`.
 * The host is one of `RESEARCH_HOSTS`, so a yes given before it was added
 * does not cover it and it is asked about once (DS-S8-8).
 */

export const DEPS_DEV_HOST = "api.deps.dev";

export interface DepsDevVersion {
  version: string;
  /** When this version was published (ISO). */
  publishedAt?: string;
  /** SPDX expressions deps.dev found, without its "non-standard" marker. */
  licenses: string[];
  /** Advisory ids that affect this version (GHSA, OSV). */
  advisories: string[];
}

const SYSTEM = { npm: "npm", pypi: "pypi" } as const;

export function depsDevUrl(ecosystem: "npm" | "pypi", name: string, version: string): string {
  return `https://${DEPS_DEV_HOST}/v3/systems/${SYSTEM[ecosystem]}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

/** A registry answered "no such package or version" (404): unknown to it, not an outage. */
const notFound = (err: unknown) => err instanceof Error && /^404\b/.test(err.message);

/** deps.dev's record of one version, or undefined when deps.dev does not know it. */
export async function depsDevVersion(
  ecosystem: "npm" | "pypi",
  name: string,
  version: string,
  fetcher: Fetcher,
): Promise<DepsDevVersion | undefined> {
  let body: {
    versionKey?: { version?: string };
    publishedAt?: string;
    licenses?: unknown;
    advisoryKeys?: { id?: string }[];
  };
  try {
    body = (await fetcher(depsDevUrl(ecosystem, name, version))) as typeof body;
  } catch (err) {
    if (notFound(err)) return undefined;
    throw err;
  }
  const licenses = Array.isArray(body.licenses)
    ? body.licenses.filter(
        (l): l is string => typeof l === "string" && l.trim() !== "" && l !== "non-standard",
      )
    : [];
  return {
    version: body.versionKey?.version ?? version,
    ...(body.publishedAt ? { publishedAt: body.publishedAt } : {}),
    licenses,
    advisories: (body.advisoryKeys ?? [])
      .map((a) => a.id)
      .filter((id): id is string => typeof id === "string" && id !== ""),
  };
}

const grouped = (spdx: string) => (/\s/.test(spdx.trim()) ? `(${spdx.trim()})` : spdx.trim());

/**
 * A candidate with deps.dev's facts: its release date, its licence (every
 * expression deps.dev found, joined with AND, so it is usable only if each
 * is; the registry's own string when deps.dev found none it could name) and
 * its advisories. The classifier still judges the licence (DS-P7-3).
 */
export function withDepsDev(c: LibraryCandidate, d: DepsDevVersion): LibraryCandidate {
  const license =
    d.licenses.length === 0
      ? c.license
      : d.licenses.length === 1
        ? (d.licenses[0] as string)
        : d.licenses.map(grouped).join(" AND ");
  return {
    ...c,
    license,
    ...(d.publishedAt ? { publishedAt: d.publishedAt } : {}),
    advisories: d.advisories,
  };
}
