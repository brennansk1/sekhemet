/**
 * Team practices and the project manager, as pure functions (PM_DESIGN.md).
 *
 * Priority and points, proposal field diffs, the PM's safe markdown, the
 * board's filter language, grouping into swimlanes, cycle progress, flow
 * metric maths and the waiting-state steps. The browser imports the compiled
 * module as `/app/lib/pm.js`, so it must stay free of runtime imports, and
 * everything that turns model text into markup escapes first.
 */

// ---------------------------------------------------------------------------
// Priority (contract §2: Linear's 0..4 scale) and points
// ---------------------------------------------------------------------------

export type Priority = 0 | 1 | 2 | 3 | 4;

export const PRIORITY_LABELS: Record<Priority, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** Query-language names, in menu order. */
export const PRIORITY_NAMES: Record<Priority, string> = {
  1: "urgent",
  2: "high",
  3: "medium",
  4: "low",
  0: "none",
};

/** Menu order: Urgent first, None last. */
export const PRIORITY_ORDER: Priority[] = [1, 2, 3, 4, 0];

/** A valid priority, or 0 for anything else (unset, WSJF-era numbers, junk). */
export function priorityOf(value: unknown): Priority {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4
    ? (value as Priority)
    : 0;
}

/** Sort rank: 1 (urgent) first and 0 (none) last (contract §2). */
export function priorityRank(value: unknown): number {
  const p = priorityOf(value);
  return p === 0 ? 5 : p;
}

export function priorityIcon(value: unknown): string {
  return (
    {
      0: "priority-none",
      1: "priority-urgent",
      2: "priority-high",
      3: "priority-medium",
      4: "priority-low",
    } as const
  )[priorityOf(value)];
}

/** Fibonacci points; anything bigger is a card the Planner should split. */
export const ESTIMATES = [1, 2, 3, 5, 8] as const;

export function formatPoints(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "None";
  return `${n} ${n === 1 ? "pt" : "pts"}`;
}

export function assigneeLabel(a: unknown): string {
  if (a === "worker") return "Worker";
  if (a === "human") return "You";
  if (typeof a === "string" && a.trim()) return a;
  return "Unassigned";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09-29` or a full ISO time -> `Sep 29` (calendar date, no zone shift). */
export function formatShortDate(iso: unknown): string {
  if (typeof iso !== "string") return "None";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return "None";
  return `${MONTHS[Number(m[2]) - 1] ?? "?"} ${Number(m[3])}`;
}

// ---------------------------------------------------------------------------
// Proposal diffs
// ---------------------------------------------------------------------------

export interface CycleLike {
  id: string;
  name: string;
  startsOn: string;
  endsOn: string;
  goal?: string;
  state: "planned" | "active" | "closed";
}

export interface EpicLike {
  id: string;
  title: string;
  progress?: { done: number; total: number; points?: number };
}

export interface PmCardLike {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  estimate?: number;
  labels?: string[];
  epicId?: string;
  cycleId?: string;
  assignee?: string;
  dueDate?: string;
  kind?: string;
  dependsOn?: string[];
  updatedAt?: string;
  orderKey?: string;
  display?: {
    title?: string;
    kinds?: string[];
    shortId?: string;
    needsYou?: boolean;
    mark?: string;
    tone?: string;
  };
}

export interface ProposalLike {
  id: string;
  kind: string;
  summary: string;
  cardId?: string;
  patch?: Record<string, unknown>;
  before?: Record<string, unknown>;
  cards?: Partial<PmCardLike>[];
  state: "open" | "applied" | "discarded" | "stale";
}

export interface DiffContext {
  cycles?: CycleLike[];
  epics?: EpicLike[];
  cards?: PmCardLike[];
  /** `in_progress` -> `Working`; pass the vocabulary's columnLabel. */
  statusLabel?: (s: string) => string;
}

export const FIELD_LABELS: Record<string, string> = {
  priority: "Priority",
  estimate: "Points",
  labels: "Labels",
  epicId: "Epic",
  cycleId: "Cycle",
  assignee: "Assignee",
  dueDate: "Due",
  status: "State",
  title: "Title",
  spec: "Spec",
  orderKey: "Position",
  dependsOn: "Waits on",
  acceptanceCriteria: "Done when",
  scopeFiles: "May edit",
};

export function fieldLabel(field: string): string {
  return (
    FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
  );
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** One field value as a person reads it. */
export function formatFieldValue(field: string, value: unknown, ctx: DiffContext = {}): string {
  if (field === "priority")
    return isEmpty(value) ? "No priority" : PRIORITY_LABELS[priorityOf(value)];
  if (isEmpty(value)) return "None";
  switch (field) {
    case "estimate":
      return formatPoints(value);
    case "assignee":
      return assigneeLabel(value);
    case "dueDate":
      return formatShortDate(value);
    case "cycleId":
      return ctx.cycles?.find((c) => c.id === value)?.name ?? String(value);
    case "epicId":
      return (
        ctx.epics?.find((e) => e.id === value)?.title ??
        ctx.cards?.find((c) => c.id === value)?.display?.title ??
        String(value)
      );
    case "status":
      return ctx.statusLabel ? ctx.statusLabel(String(value)) : String(value);
    case "dependsOn":
      return (value as unknown[])
        .map((id) => ctx.cards?.find((c) => c.id === id)?.display?.title ?? String(id))
        .join(", ");
    default:
      if (Array.isArray(value)) return value.map(String).join(", ");
      if (typeof value === "object") return JSON.stringify(value);
      return String(value);
  }
}

export interface DiffRow {
  field: string;
  label: string;
  /** `set` shows before -> after; `labels` shows the set difference. */
  type: "set" | "labels";
  before: string;
  after: string;
  /** Raw values, for glyphs (priority) next to the words. */
  beforeRaw?: unknown;
  afterRaw?: unknown;
  added?: string[];
  removed?: string[];
}

/**
 * Field-by-field rows for an update-style proposal. `before` comes from the
 * proposal (what the PM saw); when absent, from the card as it is now.
 * Fields whose value does not change are dropped: a diff shows changes only.
 */
export function proposalDiff(p: ProposalLike, ctx: DiffContext = {}): DiffRow[] {
  const patch = p.patch ?? {};
  const card = p.cardId ? ctx.cards?.find((c) => c.id === p.cardId) : undefined;
  const rows: DiffRow[] = [];
  for (const [field, after] of Object.entries(patch)) {
    const before =
      p.before && field in p.before
        ? p.before[field]
        : (card as Record<string, unknown> | undefined)?.[field];
    if (field === "labels") {
      const b = Array.isArray(before) ? before.map(String) : [];
      const a = Array.isArray(after) ? after.map(String) : [];
      const added = a.filter((x) => !b.includes(x));
      const removed = b.filter((x) => !a.includes(x));
      if (added.length === 0 && removed.length === 0) continue;
      rows.push({
        field,
        label: fieldLabel(field),
        type: "labels",
        before: formatFieldValue(field, b, ctx),
        after: formatFieldValue(field, a, ctx),
        added,
        removed,
      });
      continue;
    }
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    rows.push({
      field,
      label: fieldLabel(field),
      type: "set",
      before: formatFieldValue(field, before, ctx),
      after: formatFieldValue(field, after, ctx),
      beforeRaw: before,
      afterRaw: after,
    });
  }
  return rows;
}

export const PROPOSAL_KINDS: Record<string, { label: string; icon: string }> = {
  create_card: { label: "Create card", icon: "plus" },
  update_card: { label: "Update", icon: "pencil" },
  split_card: { label: "Split", icon: "split" },
  reorder: { label: "Reorder", icon: "layers" },
  move_card: { label: "Move", icon: "arrow-right" },
  create_cycle: { label: "Create cycle", icon: "cycle" },
  assign_cycle: { label: "Assign to cycle", icon: "cycle" },
  park: { label: "Park", icon: "park" },
  unpark: { label: "Unpark", icon: "undo" },
};

export function proposalKind(kind: string): { label: string; icon: string } {
  return PROPOSAL_KINDS[kind] ?? { label: fieldLabel(kind.replace(/_/g, " ")), icon: "pencil" };
}

/** Cards an apply touches: the target, plus any cards it creates. */
export function proposalCardCount(p: ProposalLike): number {
  const created = p.cards?.length ?? 0;
  if (p.kind === "create_card") return Math.max(1, created);
  return (p.cardId ? 1 : 0) + created;
}

/** "Apply 3 changes to 5 cards" — Apply all says what it does. */
export function applyAllLabel(proposals: ProposalLike[]): string {
  const open = proposals.filter((p) => p.state === "open");
  const cards = open.reduce((n, p) => n + proposalCardCount(p), 0);
  const changes = `${open.length} ${open.length === 1 ? "change" : "changes"}`;
  return cards > 0
    ? `Apply ${changes} to ${cards} ${cards === 1 ? "card" : "cards"}`
    : `Apply ${changes}`;
}

// ---------------------------------------------------------------------------
// Safe markdown for PM replies
// ---------------------------------------------------------------------------

export function escapeHtml(v: unknown): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MENTION = /(^|[\s(\[,;*_])@([A-Za-z][A-Za-z0-9_.-]*[A-Za-z0-9])/g;

/** Card ids mentioned as `@id`, in order, without duplicates. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "").matchAll(MENTION)) {
    const id = m[2] as string;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export interface MarkdownOptions {
  /** Markup for a known card chip, or null to leave `@id` as text. Must escape. */
  chip?: (id: string) => string | null;
}

function inline(raw: string, opts: MarkdownOptions): string {
  // Code spans are cut out first so nothing inside them is formatted.
  return raw
    .split(/(`[^`\n]+`)/g)
    .map((part) => {
      if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      let s = escapeHtml(part);
      // Chips become placeholders first, so emphasis never reaches their
      // markup and an id like card_a_b is never read as _emphasis_.
      const chips: string[] = [];
      if (opts.chip) {
        s = s.replace(MENTION, (whole, pre: string, id: string) => {
          const chip = opts.chip?.(id);
          if (!chip) return whole;
          chips.push(chip);
          return `${pre}\uE000${chips.length - 1}\uE000`;
        });
      }
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
      s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
      return s.replace(/\uE000(\d+)\uE000/g, (_m, i: string) => chips[Number(i)] ?? "");
    })
    .join("");
}

/**
 * Render the PM's markdown subset: paragraphs, `-`/`*` and `1.` lists,
 * `**bold**`, `*em*`, `` `code` ``, fenced code and `#`–`###` headings.
 * Everything is escaped before formatting, and links are left as text.
 */
export function renderPmMarkdown(text: string, opts: MarkdownOptions = {}): string {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, opts)).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list)
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(i, opts)}</li>`).join("")}</${list.tag}>`,
      );
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] as string))
        code.push(lines[i++] as string);
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^\s{0,3}#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h4>${inline(heading[1] as string, opts)}</h4>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(((bullet ?? numbered) as RegExpExecArray)[1] as string);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list) {
      // A continuation line of the last list item.
      if (/^\s+/.test(line)) {
        list.items[list.items.length - 1] += ` ${line.trim()}`;
        continue;
      }
      flushList();
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("");
}

// ---------------------------------------------------------------------------
// The filter language (GitHub Projects syntax)
// ---------------------------------------------------------------------------

export const FILTER_FIELDS = [
  "priority",
  "label",
  "epic",
  "cycle",
  "assignee",
  "kind",
  "state",
  "is",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export interface FilterTerm {
  field: FilterField;
  values: string[];
  negate?: boolean;
}

export interface CardFilter {
  terms: FilterTerm[];
  text: string;
}

const FIELD_ALIASES: Record<string, FilterField> = {
  priority: "priority",
  p: "priority",
  label: "label",
  labels: "label",
  epic: "epic",
  cycle: "cycle",
  sprint: "cycle",
  iteration: "cycle",
  assignee: "assignee",
  kind: "kind",
  state: "state",
  status: "state",
  is: "is",
};

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(-?[\w]+:(?:"[^"]*"|[^\s]+))|("[^"]*")|(\S+)/g;
  for (const m of q.matchAll(re)) out.push(m[0]);
  return out;
}

function splitValues(raw: string): string[] {
  const unq = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unq
    .split(",")
    .map((v) => v.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter(Boolean);
}

/** `priority:urgent,high -label:later ledger` -> terms plus free text. */
export function parseQuery(q: string): CardFilter {
  const terms: FilterTerm[] = [];
  const text: string[] = [];
  for (const tok of tokenize(String(q ?? ""))) {
    const m = /^(-?)(\w+):(.+)$/.exec(tok);
    const field = m ? FIELD_ALIASES[(m[2] as string).toLowerCase()] : undefined;
    if (m && field) {
      const values = splitValues(m[3] as string);
      if (values.length === 0) continue;
      const negate = m[1] === "-";
      const existing = terms.find((t) => t.field === field && Boolean(t.negate) === negate);
      if (existing) {
        for (const v of values) if (!existing.values.includes(v)) existing.values.push(v);
      } else {
        terms.push(negate ? { field, values, negate } : { field, values });
      }
    } else {
      text.push(tok.replace(/^"|"$/g, ""));
    }
  }
  return { terms, text: text.join(" ").trim() };
}

function quoteValue(v: string): string {
  return /[\s,"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

export function formatQuery(f: CardFilter): string {
  const parts = f.terms
    .filter((t) => t.values.length)
    .map((t) => `${t.negate ? "-" : ""}${t.field}:${t.values.map(quoteValue).join(",")}`);
  if (f.text.trim()) parts.push(f.text.trim());
  return parts.join(" ");
}

/** Replace (or remove, with no values) one field's positive term. */
export function setTerm(f: CardFilter, field: FilterField, values: string[]): CardFilter {
  const terms = f.terms.filter((t) => !(t.field === field && !t.negate));
  if (values.length) terms.push({ field, values: values.map((v) => v.toLowerCase()) });
  return { terms, text: f.text };
}

export function termValues(f: CardFilter, field: FilterField): string[] {
  return f.terms.find((t) => t.field === field && !t.negate)?.values ?? [];
}

export interface MatchContext {
  cycles?: CycleLike[];
  epics?: EpicLike[];
  statusLabel?: (s: string) => string;
}

export function slug(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The cycle in force: the one marked active, else a non-closed cycle whose
 * dates contain today (a cycle can start by the calendar before anyone
 * flips its state).
 */
export function activeCycle(
  cycles: CycleLike[] | undefined,
  now = Date.now(),
): CycleLike | undefined {
  const marked = cycles?.find((c) => c.state === "active");
  if (marked) return marked;
  const today = new Date(now).toISOString().slice(0, 10);
  return cycles?.find(
    (c) =>
      c.state !== "closed" && c.startsOn.slice(0, 10) <= today && c.endsOn.slice(0, 10) >= today,
  );
}

const STARTED = new Set(["planning", "in_progress", "verify", "review", "parked"]);

function termMatches(card: PmCardLike, t: FilterTerm, ctx: MatchContext): boolean {
  const vals = t.values;
  switch (t.field) {
    case "priority": {
      const p = priorityOf(card.priority);
      return vals.some(
        (v) => v === String(p) || v === PRIORITY_NAMES[p] || (v === "no" && p === 0),
      );
    }
    case "label": {
      const labels = (card.labels ?? []).map((l) => l.toLowerCase());
      return vals.some((v) => (v === "none" ? labels.length === 0 : labels.includes(v)));
    }
    case "epic": {
      if (!card.epicId) return vals.includes("none");
      const epic = ctx.epics?.find((e) => e.id === card.epicId);
      return vals.some(
        (v) =>
          v === card.epicId?.toLowerCase() ||
          (epic && (slug(epic.title) === slug(v) || epic.title.toLowerCase().includes(v))),
      );
    }
    case "cycle": {
      if (!card.cycleId) return vals.includes("none");
      const cycle = ctx.cycles?.find((c) => c.id === card.cycleId);
      return vals.some(
        (v) =>
          v === card.cycleId?.toLowerCase() ||
          (v === "current" && cycle !== undefined && cycle === activeCycle(ctx.cycles)) ||
          (v === "next" && cycle?.state === "planned") ||
          (cycle && slug(cycle.name) === slug(v)),
      );
    }
    case "assignee": {
      const a = (card.assignee ?? "").toLowerCase();
      return vals.some((v) =>
        v === "none"
          ? !a
          : v === a || (v === "me" && a === "human") || (v === "you" && a === "human"),
      );
    }
    case "kind":
      return vals.some((v) => (card.display?.kinds ?? []).includes(v));
    case "state": {
      const s = card.status ?? "";
      const label = ctx.statusLabel ? ctx.statusLabel(s).toLowerCase() : s;
      return vals.some((v) => v === s || v === label || slug(label) === v);
    }
    case "is":
      return vals.some((v) => {
        switch (v) {
          case "blocked":
            return card.display?.mark === "blocked";
          case "needs-you":
          case "needsyou":
            return Boolean(card.display?.needsYou);
          case "running":
            return card.status === "in_progress";
          case "unestimated":
            return !(typeof card.estimate === "number" && card.estimate > 0);
          case "done":
            return card.status === "done";
          case "open":
            return card.status !== "done" && card.status !== "rejected";
          case "started":
            return STARTED.has(card.status ?? "");
          default:
            return false;
        }
      });
    default:
      return true;
  }
}

/** Every term must hold (AND); values within a term are alternatives (OR). */
export function matchCard(card: PmCardLike, f: CardFilter, ctx: MatchContext = {}): boolean {
  for (const t of f.terms) {
    const hit = termMatches(card, t, ctx);
    if (t.negate ? hit : !hit) return false;
  }
  const words = f.text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    const hay =
      `${card.display?.title ?? card.title ?? ""} ${card.id} ${card.display?.shortId ?? ""}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export function isFilterEmpty(f: CardFilter): boolean {
  return f.terms.length === 0 && !f.text.trim();
}

// ---------------------------------------------------------------------------
// Grouping (swimlanes and table groups)
// ---------------------------------------------------------------------------

export type GroupBy = "none" | "epic" | "assignee" | "priority" | "cycle";

export interface CardGroup<C extends PmCardLike = PmCardLike> {
  key: string;
  label: string;
  cards: C[];
  points: number;
  epic?: EpicLike | undefined;
  cycle?: CycleLike | undefined;
}

export function sumPoints(cards: PmCardLike[]): number {
  return cards.reduce(
    (n, c) => n + (typeof c.estimate === "number" && c.estimate > 0 ? c.estimate : 0),
    0,
  );
}

const CYCLE_STATE_ORDER = { active: 0, planned: 1, closed: 2 } as const;

export function groupCards<C extends PmCardLike>(
  cards: C[],
  by: GroupBy,
  ctx: MatchContext = {},
): CardGroup<C>[] {
  if (by === "none") return [{ key: "all", label: "All cards", cards, points: sumPoints(cards) }];
  const map = new Map<string, C[]>();
  const keyOf = (c: C): string => {
    switch (by) {
      case "epic":
        return c.epicId ?? "";
      case "assignee":
        return c.assignee ?? "";
      case "priority":
        return String(priorityOf(c.priority));
      case "cycle":
        return c.cycleId ?? "";
    }
  };
  for (const c of cards) {
    const k = keyOf(c);
    const list = map.get(k);
    if (list) list.push(c);
    else map.set(k, [c]);
  }
  const groups: CardGroup<C>[] = [...map.entries()].map(([key, list]) => {
    const g: CardGroup<C> = { key, label: key, cards: list, points: sumPoints(list) };
    if (by === "epic") {
      g.epic = ctx.epics?.find((e) => e.id === key);
      g.label = key ? (g.epic?.title ?? key) : "No epic";
    } else if (by === "assignee") {
      g.label = key ? assigneeLabel(key) : "No assignee";
    } else if (by === "priority") {
      g.label = PRIORITY_LABELS[priorityOf(Number(key))];
    } else if (by === "cycle") {
      g.cycle = ctx.cycles?.find((c) => c.id === key);
      g.label = key ? (g.cycle?.name ?? key) : "No cycle";
    }
    return g;
  });
  const rank = (g: CardGroup<C>): [number, string] => {
    if (by === "priority") return [priorityRank(Number(g.key)), ""];
    if (!g.key) return [99, ""];
    if (by === "epic") {
      const i = ctx.epics?.findIndex((e) => e.id === g.key) ?? -1;
      return [i < 0 ? 50 : i, g.label.toLowerCase()];
    }
    if (by === "assignee")
      return [g.key === "worker" ? 0 : g.key === "human" ? 1 : 2, g.label.toLowerCase()];
    if (by === "cycle") {
      const st = g.cycle ? CYCLE_STATE_ORDER[g.cycle.state] : 3;
      return [st, g.cycle?.startsOn ?? g.label];
    }
    return [0, g.label];
  };
  return groups.sort((a, b) => {
    const [ra, la] = rank(a);
    const [rb, lb] = rank(b);
    return ra - rb || la.localeCompare(lb);
  });
}

/** Stable sort by priority (1..4, then none), keeping the incoming order as the tiebreak. */
export function sortByPriority<C extends PmCardLike>(cards: C[]): C[] {
  return cards
    .map((c, i) => [c, i] as const)
    .sort((a, b) => priorityRank(a[0].priority) - priorityRank(b[0].priority) || a[1] - b[1])
    .map(([c]) => c);
}

// ---------------------------------------------------------------------------
// Cycle progress
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function dayStart(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
}

export interface CycleProgress {
  totalDays: number;
  /** Whole days left including today; 0 once the end date has passed. */
  daysLeft: number;
  /** 0..1, how far through the cycle's calendar we are. */
  elapsedRatio: number;
  points: { done: number; started: number; notStarted: number; total: number };
  cards: { done: number; total: number };
  /** Cards without an estimate; each counts as 1 point. */
  unestimated: number;
  /** Points behind a straight line from 0 to total; negative is ahead. */
  behindBy: number;
  /** Under two days left and under 70% of points done. */
  atRisk: boolean;
}

export function cycleProgress(
  cycle: CycleLike,
  cards: PmCardLike[],
  now = Date.now(),
): CycleProgress {
  const start = dayStart(cycle.startsOn);
  const end = dayStart(cycle.endsOn) + DAY; // the end date is inclusive
  const totalDays = Math.max(1, Math.round((end - start) / DAY));
  const elapsedRatio = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const daysLeft = Math.max(0, Math.ceil((end - now) / DAY));
  const inCycle = cards.filter((c) => c.cycleId === cycle.id && c.status !== "rejected");
  const pts = (c: PmCardLike) =>
    typeof c.estimate === "number" && c.estimate > 0 ? c.estimate : 1;
  const points = { done: 0, started: 0, notStarted: 0, total: 0 };
  let doneCards = 0;
  let unestimated = 0;
  for (const c of inCycle) {
    const p = pts(c);
    if (!(typeof c.estimate === "number" && c.estimate > 0)) unestimated++;
    points.total += p;
    if (c.status === "done") {
      points.done += p;
      doneCards++;
    } else if (STARTED.has(c.status ?? "")) points.started += p;
    else points.notStarted += p;
  }
  const behindBy = Math.round(points.total * elapsedRatio - points.done);
  const atRisk = points.total > 0 && daysLeft < 2 && points.done / points.total < 0.7;
  return {
    totalDays,
    daysLeft,
    elapsedRatio,
    points,
    cards: { done: doneCards, total: inCycle.length },
    unestimated,
    behindBy,
    atRisk,
  };
}

// ---------------------------------------------------------------------------
// Flow metrics
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile (p in 0..100) of unsorted values; NaN when empty. */
export function percentile(values: number[], p: number): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  if (v.length === 1) return v[0] as number;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (v.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return (v[lo] as number) + ((v[hi] as number) - (v[lo] as number)) * (rank - lo);
}

export interface CycleTimeStats {
  n: number;
  p50: number;
  p85: number;
  p95: number;
}

export function cycleTimeStats(entries: { hours: number }[]): CycleTimeStats {
  const h = entries.map((e) => e.hours);
  return { n: h.length, p50: percentile(h, 50), p85: percentile(h, 85), p95: percentile(h, 95) };
}

/** Trailing moving average; the first points average what exists so far. */
export function movingAverage(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= window) sum -= values[i - window] as number;
    out.push(sum / Math.min(i + 1, window));
  }
  return out;
}

/** Aging WIP: `old` above the 85th percentile, `watch` above the 50th. */
export function agingClass(hours: number, stats: CycleTimeStats): "ok" | "watch" | "old" {
  if (Number.isFinite(stats.p85) && hours > stats.p85) return "old";
  if (Number.isFinite(stats.p50) && hours > stats.p50) return "watch";
  return "ok";
}

export const CFD_KEYS = ["backlog", "ready", "working", "checking", "review", "done"] as const;
export type CfdKey = (typeof CFD_KEYS)[number];

/**
 * Stack CFD rows bottom-up in `CFD_KEYS` order: for each row, each key gets
 * `[y0, y1]`. `max` is the tallest stack, for the y scale.
 */
export function stackCfd(rows: Partial<Record<CfdKey, number>>[]): {
  bands: Record<CfdKey, [number, number][]>;
  max: number;
} {
  const bands = Object.fromEntries(CFD_KEYS.map((k) => [k, [] as [number, number][]])) as Record<
    CfdKey,
    [number, number][]
  >;
  let max = 0;
  for (const row of rows) {
    let y = 0;
    for (const k of CFD_KEYS) {
      const v = Math.max(0, Number(row[k] ?? 0) || 0);
      bands[k].push([y, y + v]);
      y += v;
    }
    max = Math.max(max, y);
  }
  return { bands, max };
}

/** Hours as a person reads them: `45m`, `6.2h`, `3.1d`. */
export function formatHours(h: number): string {
  if (!Number.isFinite(h)) return "–";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h)}h`;
  const d = h / 24;
  return `${d < 10 ? d.toFixed(1).replace(/\.0$/, "") : Math.round(d)}d`;
}

// ---------------------------------------------------------------------------
// Waiting and preemption (PmStatus.phase)
// ---------------------------------------------------------------------------

export type PmPhase = "idle" | "waiting_for_step" | "loading_pm" | "thinking" | "resuming_worker";

export interface PmStatusLike {
  phase: PmPhase;
  detail?: string;
  model?: string;
  workerPaused?: boolean;
  since?: string;
  step?: number;
  etaSeconds?: number;
}

export const PM_PHASES: PmPhase[] = [
  "waiting_for_step",
  "loading_pm",
  "thinking",
  "resuming_worker",
];

export function statusStep(s: PmStatusLike): number | undefined {
  if (typeof s.step === "number") return s.step;
  const m = /step\s+(\d+)/i.exec(s.detail ?? "");
  return m ? Number(m[1]) : undefined;
}

export function statusEtaSeconds(s: PmStatusLike): number | undefined {
  if (typeof s.etaSeconds === "number") return s.etaSeconds;
  const m = /~\s*(\d+)\s*s\b/.exec(s.detail ?? "");
  return m ? Number(m[1]) : undefined;
}

export interface PmStepRow {
  phase: PmPhase;
  label: string;
  state: "done" | "current" | "todo";
}

/**
 * The procedure shown while Merit replies. The Worker rows appear only when
 * a Worker is involved (it was paused, or a Worker phase was seen).
 */
export function pmSteps(
  status: PmStatusLike,
  opts: { workerInvolved?: boolean; step?: number; eta?: number } = {},
): PmStepRow[] {
  const worker =
    opts.workerInvolved ||
    Boolean(status.workerPaused) ||
    status.phase === "waiting_for_step" ||
    status.phase === "resuming_worker";
  const phases = worker ? PM_PHASES : (["loading_pm", "thinking"] as PmPhase[]);
  const cur = phases.indexOf(status.phase);
  const step = statusStep(status) ?? opts.step;
  const eta = statusEtaSeconds(status) ?? opts.eta;
  return phases.map((phase, i) => {
    const state =
      cur < 0
        ? status.phase === "idle"
          ? "done"
          : "todo"
        : i < cur
          ? "done"
          : i === cur
            ? "current"
            : "todo";
    let label = "";
    switch (phase) {
      case "waiting_for_step":
        label =
          state === "done"
            ? `Paused the Worker${step ? ` after step ${step}` : ""}`
            : `Pausing the Worker${step ? ` after step ${step}` : " at its next step"}`;
        break;
      case "loading_pm":
        label =
          state === "done" ? "Loaded the PM" : `Loading the PM${eta ? ` · about ${eta}s` : ""}`;
        break;
      case "thinking":
        label = state === "done" ? "Replied" : "Thinking";
        break;
      case "resuming_worker":
        label = state === "done" ? "Resumed the Worker" : "Resuming the Worker";
        break;
      default:
        label = phase;
    }
    return { phase, label, state };
  });
}

/** `0:07`, `1:04`, `12:30` — elapsed time on a running clock. */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Worker capability (GET /api/capability)
// ---------------------------------------------------------------------------

/** Below this many attempts a rate is shown but called out as untrustworthy. */
export const MIN_TRUSTED_ATTEMPTS = 10;

export interface CapabilityType {
  type: string;
  label: string;
  attempts: number;
  passes: number;
  rate: number;
  low: number;
  high: number;
}

export interface CapabilityRow extends CapabilityType {
  trusted: boolean;
  /** `7 of 9 passed · 78% (45–94%)` */
  text: string;
}

function pct(v: number): string {
  return `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`;
}

/** Rows for the per-type chart, best-evidenced first, with plain words. */
export function capabilityRows(types: CapabilityType[] | undefined): CapabilityRow[] {
  return [...(types ?? [])]
    .filter((t) => Number.isFinite(t.attempts) && t.attempts > 0)
    .sort((a, b) => b.attempts - a.attempts || b.rate - a.rate)
    .map((t) => {
      const trusted = t.attempts >= MIN_TRUSTED_ATTEMPTS;
      return {
        ...t,
        trusted,
        text: `${t.passes} of ${t.attempts} passed · ${pct(t.rate)} (${pct(t.low).replace("%", "")}–${pct(t.high)})`,
      };
    });
}

/** The headline sentence for the size curve. */
export function horizonSentence(lines: number | undefined): string {
  if (typeof lines !== "number" || !Number.isFinite(lines) || lines <= 0) {
    return "Not enough attempts yet to say how large a change the Worker handles reliably.";
  }
  return `The Worker passes 80% of cards that change up to about ${Math.round(lines)} lines.`;
}

// ---------------------------------------------------------------------------
// Learning: playbook rules, the user profile, the stopping-policy tuner
// (PM_CONTRACT §6)
// ---------------------------------------------------------------------------

export interface LearnedRuleLike {
  id: string;
  role: "worker" | "manager";
  text: string;
  scope: { kind?: string; pathPattern?: string; errorPattern?: string };
  status: "candidate" | "active" | "retired";
  helpful: number;
  harmful: number;
  value: number;
  source: "struggle" | "send_back" | "reflection" | "seed";
  evidence: { cardId?: string; note: string }[];
  createdAt: string;
}

export const RULE_SOURCE_LABELS: Record<string, string> = {
  struggle: "From a fix that took the Worker several tries",
  send_back: "From your send-back note",
  reflection: "From Merit's end-of-run review",
  seed: "Seeded with the project",
};

/** Retirement is proposed at 3 or more harmful uses over helpful ones (§6). */
export function retireSuggested(
  r: Pick<LearnedRuleLike, "status" | "helpful" | "harmful">,
): boolean {
  return r.status === "active" && r.harmful - r.helpful >= 3;
}

export function groupRules<R extends LearnedRuleLike>(
  rules: R[],
): { candidate: R[]; active: R[]; retired: R[] } {
  const by = (s: string) => rules.filter((r) => r.status === s);
  const newest = (a: R, b: R) => String(b.createdAt).localeCompare(String(a.createdAt));
  return {
    candidate: by("candidate").sort(newest),
    // Rules proposed for retirement first, then the most valuable.
    active: by("active").sort(
      (a, b) => Number(retireSuggested(b)) - Number(retireSuggested(a)) || b.value - a.value,
    ),
    retired: by("retired").sort(newest),
  };
}

/** Scope as readable chips: `Kind: Rules`, `Files: src/**`, `Error: TS2353`. */
export function scopeChips(
  scope: LearnedRuleLike["scope"] | undefined,
  kindLabel: (k: string) => string = (k) => k,
): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  if (scope?.kind) out.push({ label: "Kind", value: kindLabel(scope.kind) });
  if (scope?.pathPattern) out.push({ label: "Files", value: scope.pathPattern });
  if (scope?.errorPattern) out.push({ label: "Error", value: scope.errorPattern });
  if (out.length === 0) out.push({ label: "Applies to", value: "every card" });
  return out;
}

/**
 * The value bar: signed, relative to the largest |value| on the page, so the
 * most valuable rule fills the bar and a negative one reads as harmful.
 */
export function valueBar(value: number, maxAbs: number): { ratio: number; negative: boolean } {
  const m = Math.max(1e-9, Math.abs(maxAbs));
  const v = Number.isFinite(value) ? value : 0;
  return { ratio: Math.min(1, Math.abs(v) / m), negative: v < 0 };
}

export interface ProfileEntryLike {
  id: string;
  statement: string;
  category: "code_style" | "planning" | "communication" | "priorities";
  strength: number;
  evidence: { note: string; at: string }[];
  status: "active" | "dismissed";
  source: "send_back" | "proposal_choices" | "edits" | "reflection";
}

export const PROFILE_CATEGORIES: { id: ProfileEntryLike["category"]; label: string }[] = [
  { id: "code_style", label: "Code style" },
  { id: "planning", label: "Planning" },
  { id: "communication", label: "Communication" },
  { id: "priorities", label: "Priorities" },
];

export const PROFILE_SOURCE_LABELS: Record<string, string> = {
  send_back: "From your send-back notes",
  proposal_choices: "From which proposals you apply or discard",
  edits: "From fields you changed after Merit set them",
  reflection: "From Merit's end-of-run review",
};

/** `Strong` from 0.7, `Moderate` from 0.4, else `Weak`. */
export function strengthLabel(s: number): string {
  if (!Number.isFinite(s)) return "Weak";
  return s >= 0.7 ? "Strong" : s >= 0.4 ? "Moderate" : "Weak";
}

/** Active entries by category, strongest first; empty categories dropped. */
export function profileByCategory<E extends ProfileEntryLike>(
  entries: E[],
): { id: string; label: string; entries: E[] }[] {
  return PROFILE_CATEGORIES.map((c) => ({
    ...c,
    entries: entries
      .filter((e) => e.status === "active" && e.category === c.id)
      .sort((a, b) => b.strength - a.strength),
  })).filter((g) => g.entries.length > 0);
}

export interface PolicyScoreLike {
  policy: { stepBudget: number; maxFailedChecks: number };
  firstTry: number;
  eventually: number;
  cards: number;
  minutes: number;
}

export interface TuningReportLike {
  at?: string;
  method?: string;
  current: PolicyScoreLike;
  best: PolicyScoreLike;
  all?: PolicyScoreLike[];
}

export interface TuningSummary {
  same: boolean;
  savedMinutes: number;
  /** `19.4 minutes`, or `4 seconds` under a minute. */
  savedText: string;
  savedPercent: number;
  /** `18 of 18` passes the recommendation keeps. */
  passesKept: string;
  firstTryKept: string;
  command: string;
  /** Set when the recommended failed-check limit differs and has no flag. */
  checksNote?: string;
  headline: string;
}

function checksText(n: number): string {
  return n >= 99 ? "no limit" : `${n}`;
}

export function tuningSummary(t: TuningReportLike): TuningSummary {
  const { current: c, best: b } = t;
  const same =
    b.policy.stepBudget === c.policy.stepBudget &&
    b.policy.maxFailedChecks === c.policy.maxFailedChecks;
  const raw = Math.max(0, c.minutes - b.minutes);
  const saved = Math.round(raw * 10) / 10;
  const savedText = raw < 1 ? `${Math.round(raw * 60)} seconds` : `${saved} minutes`;
  const pct = c.minutes > 0 ? Math.round((saved / c.minutes) * 100) : 0;
  const passesKept = `${b.eventually} of ${c.eventually}`;
  const firstTryKept = `${b.firstTry} of ${c.firstTry}`;
  const headline = same
    ? "Your current stopping policy is already the fastest one that keeps every pass."
    : `A ${b.policy.stepBudget}-step cap would have cut ${c.minutes} to ${b.minutes} minutes (${pct}% less) and kept ${passesKept} passes.`;
  const out: TuningSummary = {
    same,
    savedMinutes: saved,
    savedText,
    savedPercent: pct,
    passesKept,
    firstTryKept,
    command: `sekhemet queue --max-turns ${b.policy.stepBudget}`,
    headline,
  };
  if (!same && b.policy.maxFailedChecks !== c.policy.maxFailedChecks) {
    out.checksNote = `The recommendation also allows ${checksText(b.policy.maxFailedChecks)} failed checks (now ${checksText(c.policy.maxFailedChecks)}); that limit has no command-line flag yet.`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Model roster (GET /api/models) and research sources
// ---------------------------------------------------------------------------

export interface RosterRoleLike {
  role: string;
  model?: string;
  state: "resident" | "swapped" | "unconfigured";
  note?: string;
}

export const ROSTER_ROLES: { role: string; aliases: string[]; label: string; does: string }[] = [
  {
    role: "worker",
    aliases: ["worker", "executor"],
    label: "Worker",
    does: "Writes the code for one card at a time, inside its worktree, until the gates pass.",
  },
  {
    role: "manager",
    aliases: ["manager", "pm", "merit", "planner"],
    label: "Merit · Project manager",
    does: "Plans cycles, answers you, and proposes changes you approve.",
  },
  {
    role: "reviewer",
    aliases: ["reviewer", "adversarial", "adversarial_reviewer", "critic"],
    label: "Adversarial reviewer",
    does: "Reviews passing work. A different model family, so it catches what the worker's family misses.",
  },
  {
    role: "researcher",
    aliases: ["researcher", "research"],
    label: "Researcher",
    does: "Evidence-gathering: papers, docs, registries, the project's history; every answer cites sources.",
  },
];

export const ROSTER_STATE_LABELS: Record<string, string> = {
  resident: "Resident",
  swapped: "Swapped out",
  unconfigured: "Not configured",
};

/** The four roles in a fixed order; a role the server omits reads as not configured. */
export function rosterRows(
  roles: RosterRoleLike[] | undefined,
): (RosterRoleLike & { label: string; does: string })[] {
  const list = roles ?? [];
  return ROSTER_ROLES.map((r) => {
    const hit = list.find((x) => r.aliases.includes(String(x.role).toLowerCase()));
    const state = hit?.model ? (hit.state ?? "swapped") : "unconfigured";
    const row: RosterRoleLike & { label: string; does: string } = {
      role: r.role,
      state,
      label: r.label,
      does: r.does,
    };
    if (hit?.model) row.model = hit.model;
    if (hit?.note) row.note = hit.note;
    return row;
  });
}

export interface SourceCite {
  url?: string;
  label: string;
}

/**
 * Research sources from a reply's `cites`: entries with a url or a bare label
 * (card, run and evidence cites are rendered separately). Only http(s) URLs
 * are kept as links; anything else is shown as text.
 */
export function sourceCites(
  cites:
    | { url?: string; label?: string; cardId?: string; runId?: string; evidenceId?: string }[]
    | undefined,
): { label: string; href?: string; host?: string }[] {
  const out: { label: string; href?: string; host?: string }[] = [];
  for (const c of cites ?? []) {
    if (c.cardId || c.runId || c.evidenceId) continue;
    if (!c.url && !c.label) continue;
    let href: string | undefined;
    let host: string | undefined;
    if (c.url) {
      try {
        const u = new URL(c.url);
        if (u.protocol === "https:" || u.protocol === "http:") {
          href = u.href;
          host = u.hostname.replace(/^www\./, "");
        }
      } catch {
        // Not a URL: shown as text.
      }
    }
    const item: { label: string; href?: string; host?: string } = { label: c.label || c.url || "" };
    if (href) item.href = href;
    if (host) item.host = host;
    out.push(item);
  }
  return out;
}
