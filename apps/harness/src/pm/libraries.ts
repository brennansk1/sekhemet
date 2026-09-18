/**
 * "Is there already a library for this?" - asked before a card is written.
 *
 * The user's second most common complaint about AI coding agents is that they
 * reinvent what a well-maintained, legally usable package already does. Merit
 * searches the public registries and checks each result's licence before it
 * ever suggests one. Only the search text leaves the machine, and only when
 * Merit decides to search; the Worker stays offline in its sandbox.
 */

export interface LibraryHit {
  name: string;
  ecosystem: "npm" | "pypi";
  version: string;
  license: string;
  /** Permissive licences are safe to depend on in any project. */
  usable: boolean;
  note?: string;
  description: string;
  weeklyDownloads?: number;
  url: string;
}

const PERMISSIVE = new Set([
  "MIT",
  "ISC",
  "0BSD",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "Unlicense",
  "CC0-1.0",
  "Python-2.0",
  "PSF-2.0",
]);
/** Usable with care: file-level copyleft. Flagged, never silently recommended. */
const WEAK_COPYLEFT = new Set([
  "MPL-2.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "LGPL-2.1-only",
  "LGPL-3.0-only",
]);

export function licenseVerdict(license: string): { usable: boolean; note?: string } {
  const ids = license
    .replace(/[()]/g, " ")
    .split(/\s+(?:OR|or)\s+|\s*\/\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.some((id) => PERMISSIVE.has(id))) return { usable: true };
  if (ids.some((id) => WEAK_COPYLEFT.has(id))) {
    return {
      usable: false,
      note: `${license}: weak copyleft, check with the team before depending on it`,
    };
  }
  if (!license || /unknown|UNLICENSED|SEE LICENSE/i.test(license)) {
    return { usable: false, note: "no clear licence: do not use without legal review" };
  }
  return { usable: false, note: `${license}: not a permissive licence` };
}

type Fetcher = (url: string) => Promise<unknown>;
const defaultFetch: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
};

export async function searchLibraries(
  query: string,
  ecosystem: "npm" | "pypi" = "npm",
  fetcher: Fetcher = defaultFetch,
): Promise<LibraryHit[]> {
  if (ecosystem === "pypi") {
    // PyPI has no search API; look the name up directly.
    const name = query.trim().split(/\s+/)[0] ?? "";
    try {
      const body = (await fetcher(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`)) as {
        info: {
          name: string;
          version: string;
          license?: string;
          summary?: string;
          license_expression?: string;
          classifiers?: string[];
        };
      };
      const fromClassifier = body.info.classifiers
        ?.find((c) => c.startsWith("License :: OSI Approved ::"))
        ?.split("::")
        .at(-1)
        ?.trim()
        .replace(" License", "")
        .replace("Apache Software", "Apache-2.0")
        .replace(/^BSD$/, "BSD-3-Clause");
      const license =
        body.info.license_expression || fromClassifier || body.info.license || "unknown";
      return [
        {
          name: body.info.name,
          ecosystem,
          version: body.info.version,
          license,
          ...licenseVerdict(license),
          description: body.info.summary ?? "",
          url: `https://pypi.org/project/${body.info.name}/`,
        },
      ];
    } catch {
      return [];
    }
  }
  const search = (await fetcher(
    `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=6`,
  )) as {
    objects: {
      package: {
        name: string;
        version: string;
        description?: string;
        license?: string;
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
      ...licenseVerdict(license),
      description: p.description ?? "",
      ...(downloads?.weekly ? { weeklyDownloads: downloads.weekly } : {}),
      url: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
    };
  });
}

export function formatHits(hits: LibraryHit[]): string {
  if (hits.length === 0) return "No packages found.";
  return hits
    .map(
      (h) =>
        `- ${h.name}@${h.version} (${h.ecosystem}, ${h.license}${h.usable ? ", usable" : `, NOT usable: ${h.note}`})${h.weeklyDownloads ? `, ${h.weeklyDownloads.toLocaleString("en-US")} downloads/week` : ""}: ${h.description.slice(0, 140)}`,
    )
    .join("\n");
}
