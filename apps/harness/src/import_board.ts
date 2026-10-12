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
  return parseCsvLines(text).map((r) => r.cells);
}

/** `parseCsv`'s rows, each with the file line it starts on (W6 A3: a note names it). */
export function parseCsvLines(text: string): { cells: string[]; line: number }[] {
  const rows: { cells: string[]; line: number }[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let startsOn = 1;
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
      if (row.some((f) => f !== "")) rows.push({ cells: row, line: startsOn });
      row = [];
      field = "";
      startsOn = line;
    } else field += c;
  }
  if (quoted) {
    // W6 A5: one sentence a person can act on, naming the line (INT-28).
    throw new CsvError(
      `Line ${openedOn} has a quote that opens and never closes. Close that quote, then try again.`,
      openedOn,
    );
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push({ cells: row, line: startsOn });
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
type Row = {
  fields: Fields;
  key?: string;
  sekhemetId?: string;
  url?: string;
  /** The row's parent as the file names it: a tracker's key or a Sekhemet id. */
  parent?: string;
  /** Where the row is, as a person finds it: *Line 4* of a CSV, *Item 2* of a JSON file. */
  where: string;
};

/** What a read of the file found: its rows, and what it left out or did not keep (W6 A3). */
type Read = { rows: Row[]; notes: string[]; system?: "jira" | "linear" };

/** Which tracker a CSV came from: the format names it, or the header gives it away. */
function csvSystem(format: string, header: string[]): "jira" | "linear" | undefined {
  if (format === "jira-csv") return "jira";
  if (format === "linear-csv") return "linear";
  const h = header.map((c) => c.trim().toLowerCase());
  if (h.includes("issue key") || h.includes("summary")) return "jira";
  if (h.includes("identifier") || (h.includes("title") && h.includes("id"))) return "linear";
  return undefined;
}

/**
 * A row's issue type as the card fields the board reads it from
 * (`issueTypeOf`; integrations item 17's types): what the preview shows is
 * what Apply creates (W6 A4). No type, or a type Sekhemet has not, is a Task,
 * the type Apply has always given an imported row.
 */
const TYPES: Record<string, Fields> = {
  epic: { tier: "epic" },
  story: { tier: "story" },
  task: { tier: "task" },
  subtask: { tier: "task" },
  "sub-task": { tier: "task" },
  bug: { tier: "story", change: "fix" },
  spike: { tier: "story", kind: "spike" },
};

const MAX_TITLE = 300;

/** The title as kept, and a note when it was cut. */
function keptTitle(t: string, where: string, notes: string[]): string {
  if (t.length > MAX_TITLE)
    notes.push(`${where}: the title is ${t.length} characters; the first ${MAX_TITLE} are kept.`);
  return t.slice(0, MAX_TITLE);
}

function csvRows(format: string, content: string): Read {
  const [header, ...rows] = parseCsvLines(content);
  const notes: string[] = [];
  if (!header) return { rows: [], notes };
  const col = (...names: string[]) =>
    header.cells.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const system = csvSystem(format, header.cells);
  const title = col("summary", "title", "name");
  const desc = col("description", "body");
  const prio = col("priority");
  const est = col("story points", "estimate", "points", "custom field (story points)");
  const labels = col("labels", "label");
  const due = col("due date", "duedate", "due");
  const sekhemet = col("sekhemet id");
  const type = col("issue type", "issuetype", "type");
  const parent = col("parent", "parent id", "parent key");
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
  if (title < 0) return { rows: [], notes, ...(system ? { system } : {}) };
  const out: Row[] = [];
  for (const { cells: r, line } of rows) {
    const where = `Line ${line}`;
    const t = r[title]?.trim();
    if (!t) {
      notes.push(`${where} has no title, so it is not imported.`);
      continue;
    }
    const rawPrio = prio >= 0 ? (r[prio] ?? "").trim() : "";
    const p = rawPrio ? pickPriority(rawPrio) : undefined;
    if (rawPrio && p === undefined)
      notes.push(
        `${where}: priority “${rawPrio}” is not Urgent, High, Medium, Low or 0–4, so it is left out.`,
      );
    const rawEst = est >= 0 ? (r[est] ?? "").trim() : "";
    const e = rawEst ? Number(rawEst) : Number.NaN;
    if (rawEst && !(Number.isFinite(e) && e > 0))
      notes.push(`${where}: estimate “${rawEst}” is not a positive number, so it is left out.`);
    // PM_CONTRACT §2: the kernel refuses any estimate outside {1,2,3,5,8}.
    // A Jira (or other) import's own scale is mapped to the nearest allowed
    // value rather than failing the import; the imported number is kept in
    // the card's description, since it is otherwise lost.
    const mappedEstimate = Number.isFinite(e) && e > 0 ? nearestCardEstimate(e) : undefined;
    const l = labels >= 0 ? (r[labels] ?? "").split(/[,\s]+/).filter(Boolean) : [];
    const d = due >= 0 ? (r[due] ?? "").trim() : "";
    if (d && !/^\d{4}-\d{2}-\d{2}/.test(d))
      notes.push(`${where}: due date “${d}” is not a date (YYYY-MM-DD), so it is left out.`);
    const rawType = type >= 0 ? (r[type] ?? "").trim() : "";
    const typeFields = TYPES[rawType.toLowerCase()];
    if (rawType && !typeFields)
      notes.push(
        `${where}: issue type “${rawType}” is not one Sekhemet has, so it is imported as a Task.`,
      );
    // The parent is named once the row is matched (`importPreview`): a row
    // that is already an issue with that parent loses nothing.
    const rawParent = parent >= 0 ? (r[parent] ?? "").trim() : "";
    const sid = sekhemet >= 0 ? r[sekhemet]?.trim() : undefined;
    const k = (key >= 0 ? r[key]?.trim() : undefined) || sid;
    const u = url >= 0 ? r[url]?.trim() : undefined;
    const spec = desc >= 0 ? r[desc]?.trim() : undefined;
    const estimateNote =
      mappedEstimate !== undefined && mappedEstimate !== e
        ? `Imported story points: ${e} (mapped to the nearest allowed value, ${mappedEstimate}).`
        : undefined;
    out.push({
      where,
      fields: {
        title: keptTitle(t, where, notes),
        ...(typeFields ?? TYPES.task),
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
      ...(rawParent ? { parent: rawParent } : {}),
    });
  }
  return { rows: out, notes, ...(system ? { system } : {}) };
}

function jsonRows(content: string): Read {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // W6 A5: the parser's own message is not a person's.
    throw new Error("The file is not valid JSON. Export it again, then try again.");
  }
  const list = Array.isArray(parsed) ? parsed : ((parsed as { cards?: unknown[] }).cards ?? []);
  const out: Row[] = [];
  const notes: string[] = [];
  for (const [i, item] of (list as Record<string, unknown>[]).entries()) {
    const where = `Item ${i + 1}`;
    const t = typeof item?.title === "string" ? item.title.trim() : "";
    if (!t) {
      notes.push(`${where} has no title, so it is not imported.`);
      continue;
    }
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
      where,
      fields: {
        title: keptTitle(t, where, notes),
        ...TYPES.task,
        ...(typeof item.body === "string" && item.body.trim() ? { spec: item.body.trim() } : {}),
        ...(typeof item.spec === "string" ? { spec: item.spec } : {}),
        ...(p !== undefined ? { priority: p } : {}),
        ...(plain.length ? { labels: plain } : {}),
      },
      ...(sid ? { sekhemetId: sid } : {}),
    });
  }
  return { rows: out, notes };
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

const SYSTEM_NAMES: Record<string, string> = {
  jira: "Jira",
  linear: "Linear",
  github: "GitHub",
  forgejo: "Forgejo",
};

/** The fields an update changes, in words (W6 A1): never a field's key. */
const FIELD_WORDS: Record<string, string> = {
  title: "title",
  priority: "priority",
  estimate: "points",
  labels: "labels",
  dueDate: "due date",
};

function wordsList(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** A repeated row: the same key, or with no key the same fields, as an earlier row. */
function sameAs(row: Row, seen: Map<string, string>): string | undefined {
  const id = row.key ? `key:${row.key}` : `fields:${JSON.stringify(row.fields)}`;
  const earlier = seen.get(id);
  if (!earlier) seen.set(id, row.where.toLowerCase());
  return earlier;
}

/** A card's parent as an export writes it (`exportBoard`'s `Parent`): its parent issue, else its epic. */
const parentOf = (c: CardRecord) => c.parentId ?? (c.tier === "epic" ? undefined : c.epicId);

/**
 * The note for a row's parent, which an import does not link (W6 A4), or
 * none when the row is already an issue with that parent — a round trip
 * loses nothing. The parent is named by its title when it is an issue here
 * or a row of the file, else by the tracker's key; never by a Sekhemet id.
 */
function parentNote(
  row: Row,
  card: CardRecord | undefined,
  system: string | undefined,
  cards: CardRecord[],
  rows: Row[],
): string | undefined {
  const raw = row.parent;
  if (!raw) return undefined;
  const parent =
    cards.find((c) => c.id === raw) ??
    (system
      ? cards.find((c) => c.externalRef?.system === system && c.externalRef.id === raw)
      : undefined);
  if (card && parent && parentOf(card) === parent.id) return undefined;
  const ours = /^card_/.test(raw);
  const title = ours
    ? (parent?.title ??
      rows.find((r) => r.sekhemetId === raw || r.key === raw)?.fields.title?.toString())
    : undefined;
  const named = title ? `“${cleanTitle(title)}” ` : ours ? "" : `${raw} `;
  return `${row.where}: its parent ${named}is not linked; an import does not bring parent links.`;
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
  return importPreview(format, content, cards).drafts;
}

/**
 * `importProposals` with what the read left out or did not keep, in words
 * (W6 A3): a row with no title, a value that is not one Sekhemet knows, a
 * title cut short, a repeated row proposed once, a parent link not brought,
 * and, when every proposal only links an issue, that nothing else changes.
 */
export function importPreview(
  format: string,
  content: string,
  cards: CardRecord[] = [],
): { drafts: ProposalDraft[]; notes: string[] } {
  let read: Read = { rows: [], notes: [] };
  if (format === "jira-csv" || format === "linear-csv" || format === "csv") {
    read = csvRows(format, content);
  } else if (format === "github-json" || format === "json") {
    read = jsonRows(content);
  }
  const { rows, system } = read;
  const notes = [...read.notes];
  const taken = new Set<string>();
  const seen = new Map<string, string>();
  const out: ProposalDraft[] = [];
  const systemName = system ? (SYSTEM_NAMES[system] ?? system) : "";
  let linksOnly = 0;
  for (const row of rows) {
    const earlier = sameAs(row, seen);
    if (earlier) {
      notes.push(`${row.where} is the same as ${earlier}, so it is proposed once.`);
      continue;
    }
    const ref: ExternalRef | undefined =
      system && row.key ? { system, id: row.key, url: row.url ?? "" } : undefined;
    const card = matchCard(row, system, cards, taken);
    if (card === "taken") {
      notes.push(`${row.where} is an issue an earlier row already names, so it is proposed once.`);
      continue;
    }
    const parentSays = parentNote(row, card, system, cards, rows);
    if (parentSays) notes.push(parentSays);
    if (!card) {
      out.push({
        kind: "create_card",
        cards: [{ ...row.fields, ...(ref ? { externalRef: ref } : {}) }],
        summary: String(row.fields.title),
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
    const changed = Object.keys(patch);
    if (changed.length === 0) continue;
    const title = cleanTitle(card.title);
    const fields = changed.filter((f) => f !== "externalRef").map((f) => FIELD_WORDS[f] ?? f);
    const link = patch.externalRef ? `the link to ${systemName}` : "";
    if (fields.length === 0) linksOnly++;
    out.push({
      kind: "update_card",
      cardId: card.id,
      patch,
      before,
      summary:
        fields.length === 0
          ? `Link “${title}” to ${systemName}`
          : `${title}: ${wordsList([...fields, ...(link ? [link] : [])])}`,
      origin: "import",
    });
  }
  if (out.length > 0 && linksOnly === out.length)
    notes.push(
      `Every row is already an issue here. Applying links each one to its row in ${systemName}; nothing else changes.`,
    );
  return { drafts: out, notes };
}
