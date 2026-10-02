/**
 * The board tile as a pure model (dashboard §2.4.4, P3: DB-P3-2, 4–8). The
 * page (`web/tile.js`) turns this into markup; every word a tile shows is
 * decided here, from the card and its server-derived `display`.
 *
 * The browser loads the compiled module as `/app/lib/tiles.js`.
 */
import { initials } from "./account.js";
import type { IconName } from "./icons.js";
import { type Estimation, formatPoints, priorityOf, showsPoints } from "./pm.js";
import {
  type BoardColumnId,
  type CardDisplay,
  ISSUE_TYPE_LABELS,
  type IssueType,
  type StatusMark,
  type Tone,
  boardColumnOf,
  formatWait,
  issueTypeOf,
  parseTitle,
  shortId,
} from "./vocabulary.js";

/** The subset of a board card a tile reads. */
export interface TileCardLike {
  id: string;
  status: string;
  title?: string;
  tier?: string;
  kind?: string;
  change?: string;
  /** The issue key (`CHR-12`, kernel rule 5), once the kernel assigns one. */
  key?: string;
  estimate?: number;
  priority?: number;
  labels?: string[];
  epicId?: string;
  owner?: string;
  delegate?: { kind: string; id?: string };
  blockedReason?: string;
  stepsUsed?: number;
  stepBudget?: number;
  hold?: { kind: string; pr?: number; dismissed?: boolean };
  display?: Partial<CardDisplay>;
}

export interface TileContext {
  now: number;
  /** The board's epics (`/api/board`'s `epics`), for the epic chip. */
  epics?: readonly { id: string; title: string }[];
  /** The Agent waits at a step boundary while Seshat replies (PM_DESIGN §2.5). */
  pmPaused?: boolean;
  /** Preferences → Estimation, the project's (DB-N7-2): points only with story points. */
  estimation?: Estimation;
}

export interface TileStatus {
  text: string;
  tone: Tone;
  mark: StatusMark;
  /** In review for more than two hours: amber. */
  old: boolean;
  /** Longer than one line: it wraps, and the labels give way (DB-P3-7). */
  wraps: boolean;
}

export interface TileModel {
  id: string;
  column: BoardColumnId | "wont_do" | undefined;
  key: string;
  type: { icon: IconName; label: string };
  points?: string;
  /** A person's avatar: a monogram, with the name as its words. */
  owner?: { initials: string; name: string };
  /** Who builds it, as a text chip; the Agent never has an avatar (DB-P3-5). */
  delegate?: { text: string; worker: boolean };
  title: string;
  /** 0 is *No priority*: no glyph. */
  priority: number;
  epic?: { id: string; title: string };
  labels: string[];
  moreLabels: string[];
  /** Absent when the badge would only restate the column (DB-P3-8). */
  status?: TileStatus;
  /** Fail tone, link icon, *Blocked* and the cause (DB-P3-6). */
  blocker?: { text: string };
  /** Work item age, on In progress and In review. */
  age?: string;
  /** Check pips beside the status. No step counter: that is the issue's (DB-N7-3). */
  pips: boolean;
}

/** The type icon and word (DEC-31): the standard issue types; containers by their tier. */
const TYPE_ICONS: Record<IssueType, IconName> = {
  story: "type-story",
  task: "type-task",
  bug: "type-bug",
  spike: "type-spike",
  epic: "layers",
};

function typeOf(card: TileCardLike): { icon: IconName; label: string } {
  if (card.tier === "initiative") return { icon: "layers", label: "Initiative" };
  const type = (card.display?.type as IssueType | undefined) ?? issueTypeOf(card);
  return {
    icon: TYPE_ICONS[type] ?? "type-story",
    label: ISSUE_TYPE_LABELS[type]?.label ?? "Story",
  };
}

/** One line at the narrowest column (200 px) holds about this many characters. */
const ONE_LINE = 30;
const REVIEW_OLD_MS = 2 * 3600_000;

function since(iso: string | undefined, now: number): number | undefined {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? now - t : undefined;
}

function statusOf(card: TileCardLike, ctx: TileContext): TileStatus | undefined {
  const d = card.display ?? {};
  const early = card.status === "backlog" || card.status === "ready";
  // A plain Backlog or Ready card has no badge; a waiting one has the blocker flag.
  if (d.quiet || (early && d.mark === "blocked")) return undefined;
  const entered = since(d.enteredColumnAt, ctx.now);
  const held = card.status === "review" && card.hold?.kind === "awaitingMerge";
  const dismissed = held && card.hold?.dismissed === true;
  let text = d.statusLine ?? "";
  if (ctx.pmPaused && card.status === "in_progress") {
    text = "Paused for Seshat";
  } else if (dismissed) {
    // TEAM-24: the triage bar's words, short.
    text = `Accept dismissed · PR #${card.hold?.pr ?? "?"} has new commits`;
  } else if (held) {
    text = `Accepted · PR #${card.hold?.pr ?? "?"} open`;
  } else if (card.status === "review" && entered !== undefined) {
    text = `Waiting ${formatWait(entered)}`;
  }
  if (!text) return undefined;
  return {
    text,
    tone: d.tone ?? "neutral",
    mark: d.mark ?? "none",
    old: card.status === "review" && !held && entered !== undefined && entered > REVIEW_OLD_MS,
    wraps: text.length > ONE_LINE,
  };
}

/**
 * The planner's criteria-approval hold (planner-pm PM-N7-5) names the CLI
 * command that lifts it; on the board it points to the card's own Approve
 * (the card view's approval block) instead (DB-P3-12).
 */
const APPROVAL_HOLD_CLI =
  /(Waiting on a person's approval of its criteria): sekhemet approve \S+?\.(?=\s|$)/g;

function boardWords(reason: string): string {
  return reason.replace(APPROVAL_HOLD_CLI, "$1: open the issue to approve them.");
}

function blockerOf(card: TileCardLike): { text: string } | undefined {
  const causes: string[] = [];
  const reason = card.blockedReason ? boardWords(card.blockedReason).trim() : undefined;
  if (reason) causes.push(reason);
  const waits = card.display?.waitsOn ?? [];
  if (waits.length > 0) {
    const more = waits.length > 1 ? ` +${waits.length - 1}` : "";
    causes.push(`waits on ${waits[0]?.title ?? ""}${more}`);
  }
  return causes.length ? { text: ["Blocked", ...causes].join(" · ") } : undefined;
}

/** Everything one tile shows, in words (§2.4.4). */
export function tileModel(card: TileCardLike, ctx: TileContext): TileModel {
  const d = card.display ?? {};
  const column = boardColumnOf(card.status);
  const status = statusOf(card, ctx);
  const labels = status?.wraps ? [] : (card.labels ?? []);
  const points = formatPoints(card.estimate);
  const epic = card.epicId ? ctx.epics?.find((e) => e.id === card.epicId) : undefined;
  const model: TileModel = {
    id: card.id,
    column,
    key: card.key ?? d.shortId ?? shortId(card.id),
    type: typeOf(card),
    title: d.title ?? parseTitle(card.title ?? "").title,
    priority: priorityOf(card.priority),
    labels: labels.slice(0, 2),
    moreLabels: labels.slice(2),
    pips: (d.mark === "pips" || d.mark === "wait") && (d.evidence?.gates.length ?? 0) > 0,
  };
  if (points !== "None" && showsPoints(ctx.estimation)) model.points = points;
  if (card.owner) {
    const name = d.ownerName?.trim();
    model.owner = name
      ? { initials: initials(name), name }
      : { initials: "?", name: "An unnamed person" };
  }
  if (card.delegate?.kind === "worker") model.delegate = { text: "Agent", worker: true };
  else if (card.delegate?.kind === "person")
    model.delegate = { text: d.delegateName?.trim() || "A person", worker: false };
  if (epic) model.epic = { id: epic.id, title: parseTitle(epic.title).title };
  if (status) model.status = status;
  const blocker = blockerOf(card);
  if (blocker) model.blocker = blocker;
  if (column === "in_progress" || column === "in_review") {
    const age = since(d.startedAt ?? d.enteredColumnAt, ctx.now);
    if (age !== undefined) model.age = formatWait(age);
  }
  return model;
}
