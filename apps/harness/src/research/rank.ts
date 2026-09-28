import { DatabaseSync } from "node:sqlite";

/**
 * Which candidates are about a need, and in what order (design-stage §2.5
 * item 3, P7; REUSE_SURVEY_2026-09 "relevance ranking": SQLite FTS5's
 * `bm25()`, built into `node:sqlite`). Each ranking builds a throwaway
 * in-memory FTS5 index over the candidates' names, descriptions and
 * keywords, tokenised with Porter stemming, so "sends", "sending" and "send"
 * are one word, and a hyphenated word is also read joined ("e-mail" is
 * "email"). A stem of four letters or more also matches the words it begins
 * (FTS5's prefix query): Porter keeps "parser" and "server" apart from
 * "parse" and "serve", which a candidate's description uses as often.
 *
 * - **Relevant**: for at least one query, the candidate holds at least two
 *   of its words (every word, when the query has only one), after stemming.
 * - **Order**: BM25 over the three fields (the name weighted most), with a
 *   popularity prior: relevance scaled to the best candidate's, plus half the
 *   candidate's popularity on a log scale against the most popular one's.
 *
 * Nothing leaves the machine here, and no model runs: a dense index was
 * rejected for this machine (DECISIONS, rejected alternatives).
 */

export interface RankedText {
  name: string;
  description: string;
  keywords?: readonly string[];
}

export interface RankOptions<T> {
  text: (item: T) => RankedText;
  /** Weekly downloads, or stars when a source has no download count. */
  popularity?: (item: T) => number;
  /** Query words a relevant candidate must hold, at most (default 2). */
  minimum?: number;
}

const TOKENIZE = "porter unicode61 remove_diacritics 2";
/** BM25 column weights: name, description, keywords. */
const WEIGHTS = [5, 1, 2] as const;
/** How much popularity counts against relevance (DS-P7-7's ranking; fixed before it was measured). */
export const POPULARITY_PRIOR = 0.5;

/** A text with each hyphenated or dotted word also written joined: "e-mail" adds "email". */
function withJoined(text: string): string {
  const joined = [...text.matchAll(/[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+/g)].map((m) =>
    m[0].replace(/[-.]/g, ""),
  );
  return joined.length ? `${text} ${joined.join(" ")}` : text;
}

/** A stem this long also matches the words it begins. */
const PREFIX_FROM = 4;

/** Does a candidate's stem answer a query's stem: the same, or begun by a long enough one? */
const answers = (docTerm: string, queryTerm: string) =>
  docTerm === queryTerm || (queryTerm.length >= PREFIX_FROM && docTerm.startsWith(queryTerm));

/** The queries' words, lower case, at least two letters. */
const wordsOf = (queries: readonly string[]) => [
  ...new Set(
    queries.flatMap((q) =>
      withJoined(q)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2),
    ),
  ),
];

/**
 * The candidates about the queries, best first. An item that holds too few
 * of every query's words is left out; an empty query list keeps nothing.
 */
export function rankByRelevance<T>(
  queries: readonly string[],
  items: readonly T[],
  o: RankOptions<T>,
): T[] {
  const qs = queries.map((q) => q.trim()).filter(Boolean);
  const words = wordsOf(qs);
  if (!items.length || !words.length) return [];
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE VIRTUAL TABLE doc USING fts5(name, description, keywords, tokenize='${TOKENIZE}');
      CREATE VIRTUAL TABLE doc_terms USING fts5vocab(doc, 'instance');
      CREATE VIRTUAL TABLE query USING fts5(text, tokenize='${TOKENIZE}');
      CREATE VIRTUAL TABLE query_terms USING fts5vocab(query, 'instance');
      CREATE VIRTUAL TABLE word USING fts5(text, tokenize='${TOKENIZE}');
      CREATE VIRTUAL TABLE word_terms USING fts5vocab(word, 'instance');`);
    const addDoc = db.prepare(
      "INSERT INTO doc(rowid, name, description, keywords) VALUES (?, ?, ?, ?)",
    );
    items.forEach((item, i) => {
      const t = o.text(item);
      addDoc.run(
        i + 1,
        withJoined(t.name),
        withJoined(t.description),
        withJoined((t.keywords ?? []).join(" ")),
      );
    });
    const addQuery = db.prepare("INSERT INTO query(rowid, text) VALUES (?, ?)");
    qs.forEach((q, i) => addQuery.run(i + 1, withJoined(q)));

    // Stemmed words per query and per candidate, from the index itself.
    const termsBy = (table: string) => {
      const out = new Map<number, Set<string>>();
      for (const r of db.prepare(`SELECT DISTINCT doc, term FROM ${table}`).all() as {
        doc: number;
        term: string;
      }[]) {
        const set = out.get(r.doc) ?? new Set<string>();
        set.add(r.term);
        out.set(r.doc, set);
      }
      return out;
    };
    const queryTerms = [...termsBy("query_terms").values()].filter((s) => s.size > 0);
    const docTerms = termsBy("doc_terms");
    const minimum = o.minimum ?? 2;
    const relevant = (row: number) => {
      const have = [...(docTerms.get(row) ?? [])];
      return queryTerms.some((want) => {
        let n = 0;
        for (const w of want) if (have.some((h) => answers(h, w))) n++;
        return n >= Math.min(minimum, want.size);
      });
    };
    // Each word quoted (FTS5's keywords are words here), a prefix query when
    // its stem is long enough; FTS5 stems the word itself, once.
    const addWord = db.prepare("INSERT INTO word(rowid, text) VALUES (?, ?)");
    words.forEach((w, i) => addWord.run(i + 1, w));
    const stems = termsBy("word_terms");
    const expression = words
      .map((w, i) => {
        const stem = [...(stems.get(i + 1) ?? [])][0] ?? w;
        return stem.length >= PREFIX_FROM ? `"${w}"*` : `"${w}"`;
      })
      .join(" OR ");

    const scored = (
      db
        .prepare(
          `SELECT rowid AS row, bm25(doc, ${WEIGHTS.join(", ")}) AS score FROM doc WHERE doc MATCH ?`,
        )
        .all(expression) as { row: number; score: number }[]
    )
      .filter((r) => relevant(r.row))
      .map((r) => ({ row: r.row, relevance: -r.score }));
    if (!scored.length) return [];

    const best = Math.max(...scored.map((s) => s.relevance)) || 1;
    const pop = (row: number) =>
      Math.log10(1 + Math.max(0, o.popularity?.(items[row - 1] as T) ?? 0));
    const topPop = Math.max(...scored.map((s) => pop(s.row))) || 1;
    return scored
      .map((s) => ({
        ...s,
        final: s.relevance / best + POPULARITY_PRIOR * (pop(s.row) / topPop),
      }))
      .sort((a, b) => b.final - a.final || a.row - b.row)
      .map((s) => items[s.row - 1] as T);
  } finally {
    db.close();
  }
}
