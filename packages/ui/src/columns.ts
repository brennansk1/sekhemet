/**
 * The board's columns as a pure model (dashboard §2.4.1–3, P3: DB-P3-1, 3, 9,
 * 10, 11, 15, 16, 18). The page (`web/board.js`) renders what this returns
 * and nothing else, so a reloaded page and one that stayed open on the stream
 * build the same board from the same `/api/board` payload.
 *
 * The browser loads the compiled module as `/app/lib/columns.js`: runtime
 * imports stay relative to the other published lib modules.
 */
import type { CardStatus } from "@sekhemet/kernel";
import { type PmCardLike, sortByPriority } from "./pm.js";
import {
  BOARD_COLUMNS,
  type BoardColumnDef,
  PIPELINE_COLUMNS,
  WONT_DO_COLUMN,
  plural,
} from "./vocabulary.js";

/** The subset of a board card the columns read. */
export interface ColumnCardLike extends PmCardLike {
  status: string;
  hold?: { kind: string };
  display?: NonNullable<PmCardLike["display"]> & { enteredColumnAt?: string };
}

export type SortMode = "priority" | "wait" | "recent";

/**
 * How the In review limit was reached (review-git §2.2, S6), from
 * `/api/board`'s `reviewLimit`: review minutes a day over the median minutes a
 * person's review took (the 15-minute prior before the first), or a limit a
 * person fixed with `[review] wip`.
 */
export interface ReviewLimitFacts {
  limit: number;
  fixed: boolean;
  minutesPerDay?: number;
  minutesPerCard?: number;
  /** How many of a person's recorded reviews the median is taken over. */
  reviews?: number;
}

export interface ColumnLimit {
  /** The cards counted against it (an accepted card waiting on its PR is not). */
  count: number;
  limit: number;
  state: "" | "full" | "over";
  /** `2 / 3`. */
  text: string;
  /** The limit and where it comes from, in words (DB-P3-9). */
  derivation: string;
}

export interface ColumnView<C extends ColumnCardLike> {
  id: string;
  label: string;
  states: CardStatus[];
  empty: string;
  queue: boolean;
  /** The cards the filter lets through, in display order. */
  cards: C[];
  /** Every card in the column, filtered or not. */
  count: number;
  points: number;
  pointsText: string;
  limit?: ColumnLimit;
  /** `parked`: On hold's count in `--state-parked` (DB-P3-18). */
  countTone: "" | "parked";
}

export interface BoardModelInput<C extends ColumnCardLike> {
  cards: C[];
  /** Ids the filter lets through; every card when absent. */
  visible?: ReadonlySet<string>;
  now: number;
  /** Pipeline stages: the nine stored states as columns (DB-P3-3). */
  pipeline?: boolean;
  wipLimits?: Partial<Record<string, number>>;
  reviewLimit?: ReviewLimitFacts | null;
  /** Empty columns a person opened from their chip. */
  expanded?: ReadonlySet<string>;
  /** Columns a person folded into a chip from the column menu. */
  collapsed?: ReadonlySet<string>;
  /** A person's sort choice per column. */
  sort?: Readonly<Record<string, SortMode>>;
  /** The filter asks for rejected cards: show the Won't do column. */
  wontDo?: boolean;
}

export interface BoardModel<C extends ColumnCardLike> {
  /** Full columns, left to right; On hold (or Parked) last but Rejected. */
  columns: ColumnView<C>[];
  /** Empty and folded columns, shown as chips above the board (DB-P3-10). */
  chips: ColumnView<C>[];
}

/** A column's default order: queues by wait, the rest by priority (DB-P3-11). */
export function defaultSort(col: Pick<BoardColumnDef, "queue">): SortMode {
  return col.queue ? "wait" : "priority";
}

function waitMs(c: ColumnCardLike, now: number): number {
  const at = c.display?.enteredColumnAt ? Date.parse(c.display.enteredColumnAt) : Number.NaN;
  return Number.isFinite(at) ? now - at : 0;
}

/** Stable: equal keys keep the order the board sent. */
export function sortColumn<C extends ColumnCardLike>(cards: C[], mode: SortMode, now: number): C[] {
  if (mode === "priority") return sortByPriority(cards);
  const keyed = cards.map((c, i) => [c, i] as const);
  if (mode === "wait") keyed.sort((a, b) => waitMs(b[0], now) - waitMs(a[0], now) || a[1] - b[1]);
  else
    keyed.sort((a, b) => (b[0].updatedAt ?? "").localeCompare(a[0].updatedAt ?? "") || a[1] - b[1]);
  return keyed.map(([c]) => c);
}

export function pointsText(points: number): string {
  return `${points} ${points === 1 ? "pt" : "pts"}`;
}

const FULL = "Full. The Worker holds finished cards until you clear one.";

/** The In review limit and its derivation, whatever its size (DB-P3-9). */
export function reviewLimitText(f: ReviewLimitFacts, now: { count: number; held: number }): string {
  const parts: string[] = [];
  if (f.fixed) {
    parts.push(`Limit ${f.limit}, set by [review] wip in the project configuration.`);
  } else if (f.minutesPerDay !== undefined && f.minutesPerCard !== undefined) {
    const basis =
      (f.reviews ?? 0) > 0
        ? `the median of ${plural(f.reviews ?? 0, "review")}`
        : "the starting estimate until you review a card";
    parts.push(
      `Limit ${f.limit}, from ${f.minutesPerDay} review minutes a day at ~${Math.round(f.minutesPerCard)} min per card (${basis}).`,
    );
  } else {
    parts.push(`Limit ${f.limit}.`);
  }
  if (now.count > f.limit) parts.push("Over the limit.");
  else if (now.count === f.limit) parts.push(FULL);
  if (now.held === 1) parts.push("An accepted card waiting on its pull request does not count.");
  else if (now.held > 1)
    parts.push(`${now.held} accepted cards waiting on their pull requests do not count.`);
  return parts.join(" ");
}

/** Stored states whose limit is work in progress (never Done, Parked or Rejected). */
const LIMITED: ReadonlySet<string> = new Set([
  "backlog",
  "ready",
  "planning",
  "in_progress",
  "verify",
  "review",
]);

function limitOf<C extends ColumnCardLike>(
  col: BoardColumnDef,
  all: C[],
  input: BoardModelInput<C>,
): ColumnLimit | undefined {
  const reviewCol = col.states.length === 1 && col.states[0] === "review";
  // The default board shows the one limit a person sets from review time;
  // pipeline stages shows every stored state's (§2.4.3).
  if (!reviewCol && !(input.pipeline && col.states.length === 1 && LIMITED.has(col.id))) {
    return undefined;
  }
  const facts = reviewCol ? input.reviewLimit : undefined;
  const limit = facts?.limit ?? input.wipLimits?.[col.states[0] as string];
  if (typeof limit !== "number" || !Number.isFinite(limit)) return undefined;
  const held = reviewCol ? all.filter((c) => c.hold?.kind === "awaitingMerge").length : 0;
  const count = all.length - held;
  const state = count > limit ? "over" : count === limit ? "full" : "";
  const derivation = facts
    ? reviewLimitText(facts, { count, held })
    : reviewCol
      ? reviewLimitText({ limit, fixed: false }, { count, held })
      : [
          `${col.label} limit ${limit}.`,
          state === "over" ? "Over the limit." : state ? "Full." : "",
        ]
          .filter(Boolean)
          .join(" ");
  return { count, limit, state, text: `${count} / ${limit}`, derivation };
}

/**
 * The columns in force, left to right, for the board and its swimlanes alike
 * (DB-P3-1): the professional columns, with *Won't do* when the filter asks
 * for rejected cards — placed before On hold, which stays right-most
 * (DB-P3-18) — or the nine pipeline stages.
 */
export function boardColumnDefs(opts: { pipeline?: boolean; wontDo?: boolean }): BoardColumnDef[] {
  if (opts.pipeline) return [...PIPELINE_COLUMNS];
  if (!opts.wontDo) return [...BOARD_COLUMNS];
  const hold = BOARD_COLUMNS.findIndex((d) => d.id === "on_hold");
  return [...BOARD_COLUMNS.slice(0, hold), WONT_DO_COLUMN, ...BOARD_COLUMNS.slice(hold)];
}

/** The cards some column in `defs` shows: a lane counts only what its cells hold. */
export function onColumns<C extends { status: string }>(
  cards: readonly C[],
  defs: readonly BoardColumnDef[],
): C[] {
  return cards.filter((c) => defs.some((d) => d.states.includes(c.status as CardStatus)));
}

/** The board: which columns are full, which are chips, and what each holds. */
export function boardModel<C extends ColumnCardLike>(input: BoardModelInput<C>): BoardModel<C> {
  const defs = boardColumnDefs(input);
  const columns: ColumnView<C>[] = [];
  const chips: ColumnView<C>[] = [];
  for (const def of defs) {
    const all = input.cards.filter((c) => def.states.includes(c.status as CardStatus));
    if (def.onlyWithCards && all.length === 0) continue;
    const shown = input.visible ? all.filter((c) => input.visible?.has(c.id)) : all;
    const mode = input.sort?.[def.id] ?? defaultSort(def);
    const points = all.reduce((n, c) => n + (typeof c.estimate === "number" ? c.estimate : 0), 0);
    const limit = limitOf(def, all, input);
    const view: ColumnView<C> = {
      id: def.id,
      label: def.label,
      states: [...def.states],
      empty: def.empty,
      queue: def.queue,
      cards: sortColumn(shown, mode, input.now),
      count: all.length,
      points,
      pointsText: pointsText(points),
      ...(limit ? { limit } : {}),
      countTone: def.states.includes("parked") && all.length > 0 ? "parked" : "",
    };
    const folded = input.collapsed?.has(def.id) ?? false;
    const opened = input.expanded?.has(def.id) ?? false;
    if (folded || (all.length === 0 && !opened)) chips.push(view);
    else columns.push(view);
  }
  return { columns, chips };
}

/**
 * Focus after a stream frame (DB-P3-15): the focused card keeps focus, and is
 * scrolled into view only when its column changed; no other card scrolls.
 * `before` and `after` map card ids to their column ids.
 */
export function focusAfterFrame(
  focusedId: string | null | undefined,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): { id: string; scroll: boolean } | null {
  if (!focusedId || !after.has(focusedId)) return null;
  return { id: focusedId, scroll: before.get(focusedId) !== after.get(focusedId) };
}

/** Pipeline stages is kept per browser (§2.4.1, §3 per-browser settings). */
export const PIPELINE_KEY = "sekhemet-pipeline";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readPipeline(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(PIPELINE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writePipeline(storage: StorageLike | undefined, on: boolean): void {
  try {
    storage?.setItem(PIPELINE_KEY, on ? "on" : "off");
  } catch {
    // A browser that blocks storage keeps the choice for this page only.
  }
}

/**
 * A person's column choices — each column's sort, the columns folded into
 * chips and the empty ones opened — kept per browser like Pipeline stages,
 * one set for the board and one for Pipeline stages, so a reload shows the
 * columns a page that stayed open shows (DB-P3-16).
 */
export const COLUMN_CHOICES_KEY = "sekhemet-board-columns";

export interface ColumnChoices {
  sort: Record<string, SortMode>;
  collapsed: Set<string>;
  expanded: Set<string>;
}

const SORT_MODES: ReadonlySet<string> = new Set<SortMode>(["priority", "wait", "recent"]);

function storedChoices(storage: StorageLike | undefined): Record<string, unknown> {
  try {
    const raw = storage?.getItem(COLUMN_CHOICES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function readColumnChoices(
  storage: StorageLike | undefined,
  pipeline: boolean,
): ColumnChoices {
  const mine = storedChoices(storage)[pipeline ? "pipeline" : "board"];
  const m = (mine && typeof mine === "object" ? mine : {}) as Record<string, unknown>;
  const sort: Record<string, SortMode> = {};
  if (m.sort && typeof m.sort === "object") {
    for (const [col, mode] of Object.entries(m.sort as Record<string, unknown>)) {
      if (typeof mode === "string" && SORT_MODES.has(mode)) sort[col] = mode as SortMode;
    }
  }
  return { sort, collapsed: new Set(ids(m.collapsed)), expanded: new Set(ids(m.expanded)) };
}

export function writeColumnChoices(
  storage: StorageLike | undefined,
  pipeline: boolean,
  choices: ColumnChoices,
): void {
  try {
    const all = storedChoices(storage);
    all[pipeline ? "pipeline" : "board"] = {
      sort: { ...choices.sort },
      collapsed: [...choices.collapsed],
      expanded: [...choices.expanded],
    };
    storage?.setItem(COLUMN_CHOICES_KEY, JSON.stringify(all));
  } catch {
    // A browser that blocks storage keeps the choices for this page only.
  }
}
