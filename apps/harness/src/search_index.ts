import { DatabaseSync } from "node:sqlite";
import { type CardRecord, type CardStore, ERASED_MARKER, type EventLog } from "@sekhemet/kernel";
import { HIT_END, HIT_START, type SearchField, searchWords, shortId } from "@sekhemet/ui";

/**
 * Full-text search (dashboard §2.4.21, NEW-dashboard-12; DB-N12-1..3;
 * FINDINGS PRC-04; DEC-51, which settles DESIGN_GAPS b14 on SQLite FTS5 in
 * the built-in `node:sqlite`, no library — as the research ranking already
 * uses it, `research/rank.ts`).
 *
 * The index is a projection of the ledger, never a store of its own: an
 * in-memory FTS5 table, one row per issue, with its title, key,
 * description, acceptance criteria and comment text in their own columns.
 * It is built on the first search from the card projection and the
 * `issue/commented` events, then kept current by folding only the events
 * appended since (`card/created`, `card/updated`, `issue/commented`). A
 * `ledger/erased` event rebuilds it from the ledger as it now reads, so text
 * an erasure removed is never returned (DB-N12-2). Which issues a person may
 * see is decided at each search by the caller's `canSee`, the access
 * module's level on the issue's project (TEAM-58).
 */

const CREATED = "card/created";
const UPDATED = "card/updated";
const COMMENTED = "issue/commented";
const ERASED = "ledger/erased";
const PAGE = 5_000;

/** The indexed columns, in the order a hit names the first that matched. */
const COLUMNS: readonly SearchField[] = ["title", "key", "description", "criteria", "comment"];

export interface SearchHitRow {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  field: SearchField;
  snippet: string;
  project?: { id: string; name: string };
}

export interface SearchDeps {
  log: EventLog;
  cardStore: CardStore;
  projectOf: (card: CardRecord) => string | undefined;
}

class SearchIndex {
  private readonly db = new DatabaseSync(":memory:");
  private lastSeq = 0;
  private built = false;
  private readonly rowOf = new Map<string, number>();
  private readonly comments = new Map<string, Map<string, string>>();
  private nextRow = 1;

  constructor() {
    // unicode61 folds case and diacritics; the prefix index answers `word*`.
    this.db.exec(
      `CREATE VIRTUAL TABLE doc USING fts5(card UNINDEXED, ${COLUMNS.join(", ")}, tokenize='unicode61 remove_diacritics 2', prefix='2 3');`,
    );
  }

  /** Bring the index up to the ledger's head. */
  async advance(deps: SearchDeps): Promise<void> {
    if (!this.built) {
      await this.build(deps);
      return;
    }
    const dirty = new Set<string>();
    for (;;) {
      const events = await deps.log.getEventsByTypes(
        [CREATED, UPDATED, COMMENTED, ERASED],
        this.lastSeq + 1,
        PAGE,
      );
      for (const e of events) {
        this.lastSeq = Math.max(this.lastSeq, e.seq);
        if (e.type === ERASED) {
          // The erased text is gone from the ledger: rebuild from what it reads now.
          await this.build(deps);
          return;
        }
        const p = e.payload as { id?: string; cardId?: string };
        const cardId = e.cardId ?? p.cardId ?? p.id;
        if (!cardId) continue;
        if (e.type === COMMENTED) this.addComment(cardId, e.id, e.private?.text);
        dirty.add(cardId);
      }
      if (events.length < PAGE) break;
    }
    for (const id of dirty) {
      const card = await deps.cardStore.getCard(id);
      if (card) this.put(card);
    }
  }

  private async build(deps: SearchDeps): Promise<void> {
    this.db.exec("DELETE FROM doc");
    this.rowOf.clear();
    this.comments.clear();
    this.nextRow = 1;
    const head = (await deps.log.getLastEvent())?.seq ?? 0;
    for (let from = 1; from <= head; ) {
      const events = await deps.log.getEventsByTypes([COMMENTED], from, PAGE);
      for (const e of events) {
        if (e.seq > head) break;
        const p = e.payload as { cardId?: string };
        const cardId = e.cardId ?? p.cardId;
        if (cardId) this.addComment(cardId, e.id, e.private?.text);
      }
      if (events.length < PAGE) break;
      from = (events[events.length - 1]?.seq ?? head) + 1;
    }
    const cards = await deps.cardStore.listCards();
    this.db.exec("BEGIN");
    try {
      for (const card of cards) this.put(card);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.lastSeq = head;
    this.built = true;
  }

  /** A comment's text, unless an erasure blanked it. */
  private addComment(cardId: string, eventId: string, text: unknown): void {
    if (typeof text !== "string" || !text.trim() || text === ERASED_MARKER) return;
    let m = this.comments.get(cardId);
    if (!m) {
      m = new Map();
      this.comments.set(cardId, m);
    }
    m.set(eventId, text);
  }

  /** Write one issue's row (replacing any it had). */
  private put(card: CardRecord): void {
    let row = this.rowOf.get(card.id);
    if (row === undefined) {
      row = this.nextRow++;
      this.rowOf.set(card.id, row);
    } else {
      this.db.prepare("DELETE FROM doc WHERE rowid = ?").run(row);
    }
    this.db
      .prepare(`INSERT INTO doc (rowid, card, ${COLUMNS.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        row,
        card.id,
        card.title ?? "",
        shortId(card.id),
        card.spec ?? "",
        (card.acceptanceCriteria ?? []).join("\n"),
        [...(this.comments.get(card.id)?.values() ?? [])].join("\n"),
      );
  }

  /**
   * The matching issues, best first: each with the first column that
   * matched and its snippet, the matched words between `HIT_START` and
   * `HIT_END`.
   */
  match(
    expr: string,
    offset: number,
    count: number,
  ): { card: string; field: SearchField; snippet: string }[] {
    const snippets = COLUMNS.map(
      (_c, i) => `snippet(doc, ${i + 1}, :start, :end, '…', 12) AS s${i}`,
    ).join(", ");
    const rows = this.db
      .prepare(
        `SELECT card, ${snippets} FROM doc WHERE doc MATCH :expr ORDER BY bm25(doc, 0, 10, 8, 3, 2, 1) LIMIT :count OFFSET :offset`,
      )
      .all({ expr, start: HIT_START, end: HIT_END, count, offset }) as Record<string, string>[];
    return rows.map((r) => {
      const i = COLUMNS.findIndex((_c, k) => (r[`s${k}`] ?? "").includes(HIT_START));
      const at = i < 0 ? 0 : i;
      return {
        card: r.card as string,
        field: COLUMNS[at] as SearchField,
        snippet: r[`s${at}`] ?? "",
      };
    });
  }
}

const indexes = new WeakMap<EventLog, SearchIndex>();
const advancing = new WeakMap<EventLog, Promise<void>>();

/** The log's index, advanced to its head; one advance at a time per log. */
async function indexFor(deps: SearchDeps): Promise<SearchIndex> {
  let index = indexes.get(deps.log);
  if (!index) {
    index = new SearchIndex();
    indexes.set(deps.log, index);
  }
  const prior = advancing.get(deps.log) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(() => (index as SearchIndex).advance(deps));
  advancing.set(deps.log, run);
  try {
    await run;
  } catch (err) {
    // A half-advanced index is not kept: the next search builds it again.
    indexes.delete(deps.log);
    throw err;
  } finally {
    if (advancing.get(deps.log) === run) advancing.delete(deps.log);
  }
  return index;
}

/**
 * An FTS5 query from a person's free words: each word's letters and digits,
 * quoted (so no word is read as an operator) and as a prefix, all required.
 */
export function ftsQuery(q: string): string | undefined {
  const terms = searchWords(q)
    .flatMap((w) => w.replace(/[^\p{L}\p{N}]+/gu, " ").split(" "))
    .filter(Boolean);
  return terms.length ? terms.map((t) => `"${t}"*`).join(" ") : undefined;
}

/**
 * Search every issue the person can see (DB-N12-1, -2): title, key,
 * description, acceptance criteria and comments, Done and Won't do issues
 * included, best match first; `project` narrows to one project's issues.
 */
export async function searchText(
  deps: SearchDeps,
  input: {
    q: string;
    canSee: (project: string | undefined) => boolean;
    project?: string;
    limit?: number;
  },
): Promise<SearchHitRow[]> {
  const expr = ftsQuery(input.q);
  if (!expr) return [];
  const limit = Math.max(1, Math.min(500, input.limit ?? 20));
  const index = await indexFor(deps);
  const out: SearchHitRow[] = [];
  const page = Math.max(limit * 2, 100);
  for (let offset = 0; out.length < limit; offset += page) {
    const rows = index.match(expr, offset, page);
    for (const r of rows) {
      const card = await deps.cardStore.getCard(r.card);
      if (!card) continue;
      const project = deps.projectOf(card);
      if (input.project && project !== input.project) continue;
      if (!input.canSee(project)) continue;
      const rec = project ? deps.cardStore.getProject(project) : undefined;
      out.push({
        id: card.id,
        title: card.title,
        status: card.status,
        updatedAt: card.updatedAt,
        field: r.field,
        snippet: r.snippet,
        ...(rec ? { project: { id: rec.id, name: rec.name } } : {}),
      });
      if (out.length >= limit) break;
    }
    if (rows.length < page) break;
  }
  return out;
}
