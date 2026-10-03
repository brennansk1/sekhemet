/**
 * Full-text search's page side (dashboard §2.4.21, NEW-dashboard-12; DEC-51;
 * FINDINGS PRC-04). `GET /api/search?q=` answers from an FTS5 index the
 * server keeps from the ledger; each row names the issue, where the words
 * matched and a snippet with the matched words between `HIT_START` and
 * `HIT_END`. This module turns those rows into the palette's *Issues* group
 * and reads a query's free words, for the palette and the query box alike.
 *
 * The browser loads the compiled module as `/app/lib/search.js`.
 */
import { parseQuery } from "./pm.js";
import { boardColumnLabel, shortId } from "./vocabulary.js";

/** The marks around a matched word in a snippet: control characters no issue text carries. */
export const HIT_START = "\u0002";
export const HIT_END = "\u0003";

export type SearchField = "title" | "key" | "description" | "criteria" | "comment";

/** One row of `GET /api/search`. */
export interface SearchRow {
  id: string;
  title: string;
  status: string;
  field: SearchField | string;
  snippet: string;
  project?: { id: string; name: string };
}

export interface SearchHit {
  id: string;
  key: string;
  title: string;
  project?: { id: string; name: string };
  /** The issue's column, in the board's words (Done and Won't do included). */
  column: string;
  /** Where the words matched. */
  where: string;
  /** The snippet, split so the page marks the matched words without parsing markup. */
  context: { text: string; hit: boolean }[];
}

const WHERE: Record<SearchField, string> = {
  title: "in the title",
  key: "in the key",
  description: "in the description",
  criteria: "in the acceptance criteria",
  comment: "in a comment",
};

/** A query's free words: what is left once its field terms (`label:api`, `is:open`) are read. */
export function searchWords(query: string): string[] {
  return parseQuery(query)
    .text.split(/\s+/)
    .map((w) => w.replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** A snippet split at its marks. */
function contextOf(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest) {
    const start = rest.indexOf(HIT_START);
    if (start < 0) {
      out.push({ text: rest, hit: false });
      break;
    }
    if (start > 0) out.push({ text: rest.slice(0, start), hit: false });
    const end = rest.indexOf(HIT_END, start + 1);
    const word = rest.slice(start + 1, end < 0 ? undefined : end);
    if (word) out.push({ text: word, hit: true });
    rest = end < 0 ? "" : rest.slice(end + 1);
  }
  return out;
}

/** The palette's *Issues* group for a query, from the search's rows (DB-N12-1). */
export function searchHits(rows: readonly SearchRow[], query: string): SearchHit[] {
  if (searchWords(query).length === 0) return [];
  return rows.map((r) => ({
    id: r.id,
    key: shortId(r.id),
    title: r.title,
    ...(r.project ? { project: r.project } : {}),
    column: boardColumnLabel(r.status),
    where: WHERE[r.field as SearchField] ?? "",
    context: contextOf(r.snippet),
  }));
}
