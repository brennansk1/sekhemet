import { type CardRecord, type ExternalRef, nearestCardEstimate } from "@sekhemet/kernel";
import { DELEGATE_LABEL } from "@sekhemet/sync";
import type { ProposalDraft } from "./pm/agent.js";

/**
 * Import another tool's export as PM proposals (integrations items 17-18,
 * NEW-integrations-1). Nothing is applied here: each row becomes a proposal
 * a person applies or discards. A row that is already a card — by its
 * `externalRef`, its Sekhemet id, or a unique title — updates that card, so
 * export followed by import duplicates nothing (INT-27), and every Jira or
 * Linear row carries `externalRef {system, id: the row's key}` — except onto
 * a card linked to GitHub or Forgejo, whose link an import never replaces.
 * Every proposal is `origin: "import"`: applied, its cards are untrusted by
 * origin (`card/imported`), whatever their link (B4.9 part 2, M2, M3).
 */

/** A CSV the parser refuses, with the 1-based line it names (INT-28). */
export class CsvError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
    this.name = "CsvError";
  }
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. A quote
 * left open at the end of the file is refused, naming the line it opened on
 * (INT-28), rather than swallowing the rest of the file into one field.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let openedOn = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') {
      quoted = true;
      openedOn = line;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
        line++;
      }
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (quoted) {
    throw new CsvError(
      `unterminated quote on line ${openedOn}: a quoted field opens there and never closes`,
      openedOn,
    );
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  return rows;
}

export const pickPriority = (value: string): number | undefined => {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (v === "highest" || v === "urgent" || v === "blocker" || v === "critical") return 1;
  if (v === "high" || v === "major") return 2;
  if (v === "medium" || v === "normal") return 3;
  if (v === "low" || v === "lowest" || v === "minor" || v === "trivial") return 4;
  if (v === "no priority" || v === "none") return 0;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : undefined;
};

/** Trackers Sekhemet syncs with: their link is never replaced by an import (M2). */
const SYNCED = new Set(["github", "forgejo"]);

const cleanTitle = (t: string) => t.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "").trim();

type Fields = Record<string, unknown>;
type Row = { fields: Fields; key?: string; sekhemetId?: string; url?: string };

/** Which tracker a CSV came from: the format names it, or the header gives it away. */
function csvSystem(format: string, header: string[]): "jira" | "linear" | undefined {
  if (format === "jira-csv") return "jira";
  if (format === "linear-csv") return "linear";
  const h = header.map((c) => c.trim().toLowerCase());
  if (h.includes("issue key") || h.includes("summary")) return "jira";
  if (h.includes("identifier") || (h.includes("title") && h.includes("id"))) return "linear";
  return undefined;
}

function csvRows(format: string, content: string): { rows: Row[]; system?: "jira" | "linear" } {
  const [header, ...rows] = parseCsv(content);
  if (!header) return { rows: [] };
  const col = (...names: string[]) =>
    header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const system = csvSystem(format, header);
  const title = col("summary", "title", "name");
  const desc = col("description", "body");
  const prio = col("priority");
  const est = col("story points", "estimate", "points", "custom field (story points)");
  const labels = col("labels", "label");
  const due = col("due date", "duedate", "due");
  const sekhemet = col("sekhemet id");
  // The row's key: Jira's issue key, Linear's identifier; our own export's
  // Jira CSV carries the card's id as its `Issue Id` (NEW-integrations-5,
  // INT-46a) — or, written before DEC-55, as its Sekhemet id — which is then the key.
  const key =
    system === "jira"
      ? col("issue key", "key") >= 0
        ? col("issue key", "key")
        : col("issue id")
      : system === "linear"
        ? col("id", "identifier")
        : -1;
  const url = col("url", "link", "issue url");
  if (title < 0) return { rows: [], ...(system ? { system } : {}) };
  const out: Row[] = [];
  for (const r of rows) {
    const t = r[title]?.trim();
    if (!t) continue;
    const p = prio >= 0 ? pickPriority(r[prio] ?? "") : undefined;
    const e = est >= 0 ? Number(r[est]) : Number.NaN;
    // PM_CONTRACT §2: the kernel refuses any estimate outside {1,2,3,5,8}.
    // A Jira (or other) import's own scale is mapped to the nearest allowed
    // value rather than failing the import; the imported number is kept in
    // the card's description, since it is otherwise lost.
    const mappedEstimate = Number.isFinite(e) && e > 0 ? nearestCardEstimate(e) : undefined;
    const l = labels >= 0 ? (r[labels] ?? "").split(/[,\s]+/).filter(Boolean) : [];
    const d = due >= 0 ? (r[due] ?? "").trim() : "";
    const sid = sekhemet >= 0 ? r[sekhemet]?.trim() : undefined;
    const k = (key >= 0 ? r[key]?.trim() : undefined) || sid;
    const u = url >= 0 ? r[url]?.trim() : undefined;
    const spec = desc >= 0 ? r[desc]?.trim() : undefined;
    const estimateNote =
      mappedEstimate !== undefined && mappedEstimate !== e
        ? `Imported story points: ${e} (mapped to the nearest allowed value, ${mappedEstimate}).`
        : undefined;
    out.push({
      fields: {
        title: t.slice(0, 300),
        ...(spec || estimateNote
          ? { spec: [spec, estimateNote].filter(Boolean).join("\n\n") }
          : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(mappedEstimate !== undefined ? { estimate: mappedEstimate } : {}),
        ...(l.length ? { labels: l } : {}),
        ...(/^\d{4}-\d{2}-\d{2}/.test(d) ? { dueDate: d.slice(0, 10) } : {}),
      },
      ...(k ? { key: k } : {}),
      ...(sid ? { sekhemetId: sid } : {}),
      ...(u ? { url: u } : {}),
    });
  }
  return { rows: out, ...(system ? { system } : {}) };
}

function jsonRows(content: string): Row[] {
  const parsed = JSON.parse(content) as unknown;
  const list = Array.isArray(parsed) ? parsed : ((parsed as { cards?: unknown[] }).cards ?? []);
  const out: Row[] = [];
  for (const item of list as Record<string, unknown>[]) {
    const t = typeof item.title === "string" ? item.title.trim() : "";
    if (!t) continue;
    const labelNames = Array.isArray(item.labels)
      ? item.labels
          .map((l) => (typeof l === "string" ? l : String((l as { name?: string }).name ?? "")))
          .filter(Boolean)
      : [];
    const prioLabel = labelNames.find((l) => l.startsWith("priority:"));
    const p = prioLabel
      ? pickPriority(prioLabel.slice(9))
      : pickPriority(String(item.priority ?? ""));
    const plain = labelNames.filter((l) => !l.includes(":"));
    const sid =
      typeof item.sekhemet_id === "string"
        ? item.sekhemet_id
        : typeof item.id === "string"
          ? item.id
          : undefined;
    out.push({
      fields: {
        title: t.slice(0, 300),
        ...(typeof item.body === "string" && item.body.trim() ? { spec: item.body.trim() } : {}),
        ...(typeof item.spec === "string" ? { spec: item.spec } : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(plain.length ? { labels: plain } : {}),
      },
      ...(sid ? { sekhemetId: sid } : {}),
    });
  }
  return out;
}

/**
 * The card a row already is, if any: by its link, its Sekhemet id, then a
 * unique title. `taken` when the row names a card — by its link or its id —
 * that an earlier row of the file already matched: that row proposes
 * nothing, rather than a duplicate card.
 */
function matchCard(
  row: Row,
  system: string | undefined,
  cards: CardRecord[],
  taken: Set<string>,
): CardRecord | "taken" | undefined {
  const free = (c: CardRecord) => (taken.has(c.id) ? "taken" : c);
  if (system && row.key) {
    const linked = cards.find(
      (c) => c.externalRef?.system === system && c.externalRef.id === row.key,
    );
    if (linked) return free(linked);
  }
  for (const id of [row.sekhemetId, row.key]) {
    const byId = id ? cards.find((c) => c.id === id) : undefined;
    if (byId) return free(byId);
  }
  const title = String(row.fields.title ?? "");
  const same = cards.filter(
    (c) =>
      !taken.has(c.id) &&
      cleanTitle(c.title) === title &&
      (!c.externalRef || c.externalRef.system === system),
  );
  return same.length === 1 ? same[0] : undefined;
}

const sameLabels = (a: string[] = [], b: string[] = []) => {
  const x = a.filter((l) => l !== DELEGATE_LABEL).sort();
  const y = b.filter((l) => l !== DELEGATE_LABEL).sort();
  return JSON.stringify(x) === JSON.stringify(y);
};

/** The fields a row would change on its card, with what they are now. */
function diff(card: CardRecord, fields: Fields): { patch: Fields; before: Fields } {
  const patch: Fields = {};
  const before: Fields = {};
  const set = (field: string, value: unknown, current: unknown) => {
    patch[field] = value;
    before[field] = current ?? null;
  };
  const title = String(fields.title ?? "");
  if (title && title !== cleanTitle(card.title)) set("title", title, card.title);
  if (typeof fields.priority === "number" && fields.priority !== (card.priority ?? 0)) {
    set("priority", fields.priority, card.priority);
  }
  if (typeof fields.estimate === "number" && fields.estimate !== card.estimate) {
    set("estimate", fields.estimate, card.estimate);
  }
  if (Array.isArray(fields.labels) && !sameLabels(fields.labels as string[], card.labels)) {
    set("labels", fields.labels, card.labels);
  }
  if (typeof fields.dueDate === "string" && fields.dueDate !== card.dueDate) {
    set("dueDate", fields.dueDate, card.dueDate);
  }
  return { patch, before };
}

/**
 * Proposals for a file: an update for each row that is already a card — none
 * when it changes nothing, so a second import proposes nothing — and a new
 * card only for a row no card matches. Throws `CsvError` on a malformed CSV.
 */
export function importProposals(
  format: string,
  content: string,
  cards: CardRecord[] = [],
): ProposalDraft[] {
  let rows: Row[] = [];
  let system: "jira" | "linear" | undefined;
  if (format === "jira-csv" || format === "linear-csv" || format === "csv") {
    ({ rows, system } = csvRows(format, content));
  } else if (format === "github-json" || format === "json") {
    rows = jsonRows(content);
  }
  const taken = new Set<string>();
  const out: ProposalDraft[] = [];
  for (const row of rows) {
    const ref: ExternalRef | undefined =
      system && row.key ? { system, id: row.key, url: row.url ?? "" } : undefined;
    const card = matchCard(row, system, cards, taken);
    if (card === "taken") continue;
    if (!card) {
      out.push({
        kind: "create_card",
        cards: [{ ...row.fields, ...(ref ? { externalRef: ref } : {}) }],
        summary: `Import ${String(row.fields.title)}`,
        origin: "import",
      });
      continue;
    }
    taken.add(card.id);
    const { patch, before } = diff(card, row.fields);
    // M2: a synced tracker's link is the card's one identity there; an
    // imported row's key never replaces it.
    const synced = card.externalRef && SYNCED.has(card.externalRef.system);
    if (ref && !synced && JSON.stringify(card.externalRef ?? null) !== JSON.stringify(ref)) {
      patch.externalRef = ref;
      before.externalRef = card.externalRef ?? null;
    }
    if (Object.keys(patch).length === 0) continue;
    out.push({
      kind: "update_card",
      cardId: card.id,
      patch,
      before,
      summary: `Import ${cleanTitle(card.title)}: ${Object.keys(patch).join(", ")}`,
      origin: "import",
    });
  }
  return out;
}
