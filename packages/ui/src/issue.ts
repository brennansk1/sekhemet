/**
 * The issue page: working with the agent (dashboard §2.6, NEW-dashboard-8,
 * DEC-34). Its pure half, shared by the page and the tests:
 *
 * - the tabs (`ISSUE_TABS`, `issueTab`) — Activity, Checks, Changes and AI
 *   review, then the run's Steps and the Plan (DB-N8-1);
 * - the acceptance criteria with each one's check state (`criteriaChecks`),
 *   read from the latest attempt's test gates: a criterion is proven by a
 *   staged test case that names its id (planner-pm PM-P1-17);
 * - the agent's state and the controls it offers (`agentPanel`, DB-N8-2),
 *   in DEC-34's words for an AI teammate's state;
 * - the Activity timeline (`activityItems`, DB-N8-1, DB-N8-3): the agent's
 *   plan, progress and questions and the people's messages, in time order;
 * - the line comments a send-back carries (DB-N8-4), validated by the
 *   server's own rule (`triage.ts` `sendBack`).
 *
 * The browser loads the compiled module as `/app/lib/issue.js`.
 */
import {
  BOARD_COLUMNS,
  type EventLike,
  boardColumnOf,
  columnLabel,
  eventSentence,
  gateLabel,
  plural,
  stepPhrase,
} from "./vocabulary.js";

/** Every word of the issue page's own parts. */
export const ISSUE_COPY = {
  description: "Description",
  noDescription: "No description yet. The agent works from the title and the acceptance criteria.",
  criteria: "Acceptance criteria",
  noCriteria: "No acceptance criteria yet.",
  criterionState: {
    pass: "Passing",
    fail: "Failing",
    none: "Not checked yet",
    unproven: "Not proven while the tests fail",
  },
  criteriaNotRun: "Checked when the agent's work runs its tests.",
  criteriaNoTestGate: "No test check ran on the latest attempt, so no criterion is proven yet.",
  agent: "Agent",
  aiBadge: "AI",
  aiBadgeLabel: "AI teammate",
  checks: "Checks",
  messageLabel: "Message the agent — it reads this at its next step",
  messageEmpty: "Write a message first.",
  send: "Send",
  sent: "Sent. The agent reads it at its next step.",
  notRunning:
    "The agent isn't running, so there is no one to message. Hand it back to give it a note.",
  controls: {
    pause: "Pause",
    take_over: "Take over",
    hand_back: "Hand back",
    submit: "Run checks on my work",
  },
  handBackNote: "Note for the agent (optional)",
  handBackConfirm: "Hand back",
  cancel: "Cancel",
  pauseAsked: "Pausing at the end of this step.",
  takeOverWhileRunning:
    "Pausing first: the agent stops at the end of this step, then Take over is yours.",
  tookOver: (path: string) =>
    `Taken over. Work in ${path}; Run checks on my work when you're done.`,
  handedBack: "Handed back. The agent resumes with your note.",
  checksPassed: "Your work passed the checks and is in review.",
  checksFailed: (n: number) => `Your work failed the checks: ${plural(n, "failure")}.`,
  activityEmpty: "Nothing yet. The agent's plan, its progress and your messages appear here.",
  everyEntry: "Every ledger entry",
  answer: "Answer",
  answered: (label: string) => `Answered: ${label}`,
  lineComment: {
    heading: "Line comments",
    hint: "Select a line in the diff to comment on it, or name the file and line here. Send back carries every comment to the agent's next attempt.",
    file: "File",
    line: "Line",
    text: "Comment",
    add: "Add comment",
    remove: (label: string) => `Remove the comment on ${label}`,
    none: "No line comments yet.",
    carried: (n: number) => `Send back carries ${plural(n, "line comment")}.`,
    sendBack: (n: number) => `Send back with ${plural(n, "line comment")}`,
  },
  aiReviewEmpty:
    "No AI review yet. Seshat reviews the diff against what it has learned about you once the checks pass.",
} as const;

export type IssueTabId = "activity" | "checks" | "changes" | "ai_review" | "steps" | "plan";

/** DB-N8-1: the tabs, in order, with their keys. */
export const ISSUE_TABS: readonly { id: IssueTabId; label: string; key: string }[] = [
  { id: "activity", label: "Activity", key: "1" },
  { id: "checks", label: "Checks", key: "2" },
  { id: "changes", label: "Changes", key: "3" },
  { id: "ai_review", label: "AI review", key: "4" },
  { id: "steps", label: "Steps", key: "5" },
  { id: "plan", label: "Plan", key: "6" },
];

/** The card view's tabs before the issue page, so an old link lands on its content. */
const TAB_ALIASES: Record<string, IssueTabId> = {
  evidence: "checks",
  thread: "activity",
  files: "changes",
  review: "ai_review",
};

/** The tab a route names; Activity when it names none. */
export function issueTab(route: string | undefined): IssueTabId {
  if (!route) return "activity";
  if (ISSUE_TABS.some((t) => t.id === route)) return route as IssueTabId;
  return TAB_ALIASES[route] ?? "activity";
}

// ---------------------------------------------------------------------------
// Acceptance criteria and their check state (DB-N8-1)
// ---------------------------------------------------------------------------

export type CriterionState = "pass" | "fail" | "none";

export interface CriterionCheck {
  id?: string;
  text: string;
  state: CriterionState;
  stateText: string;
}

interface RungLike {
  rung: string;
  passed: boolean;
  skipped?: boolean;
  unavailable?: boolean;
}

interface FailureLike {
  rung?: string;
  gate?: string;
  errorExcerpt?: string;
  expected?: string;
  actual?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names the criterion id as a whole token (`x.c1` is not in `x.c10`). */
function names(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9._-])${escapeRegExp(id)}($|[^A-Za-z0-9_-])`).test(text);
}

export function criteriaChecks(
  card: { acceptanceCriteria?: readonly string[]; criterionIds?: readonly string[] },
  evidence:
    | { passed: boolean; rungResults?: readonly RungLike[]; failures?: readonly FailureLike[] }
    | null
    | undefined,
): { items: CriterionCheck[]; passing: number; total: number; summary: string; note?: string } {
  const texts = card.acceptanceCriteria ?? [];
  const ids = card.criterionIds ?? [];
  const ran = (evidence?.rungResults ?? []).filter(
    (r) => r.rung === "test" && !r.skipped && !r.unavailable,
  );
  let note: string | undefined;
  let stateOf: (id: string | undefined) => CriterionState;
  let noneText: string = ISSUE_COPY.criterionState.none;
  if (!evidence) {
    note = ISSUE_COPY.criteriaNotRun;
    stateOf = () => "none";
  } else if (ran.length === 0) {
    note = ISSUE_COPY.criteriaNoTestGate;
    stateOf = () => "none";
  } else if (ran.every((r) => r.passed)) {
    stateOf = () => "pass";
  } else {
    const said = (evidence.failures ?? [])
      .filter((f) => (f.rung ?? "test") === "test")
      .map((f) => [f.gate, f.expected, f.actual, f.errorExcerpt].filter(Boolean).join("\n"))
      .join("\n");
    noneText = ISSUE_COPY.criterionState.unproven;
    stateOf = (id) => (id && names(said, id) ? "fail" : "none");
  }
  const items = texts.map((text, i): CriterionCheck => {
    const id = ids[i];
    const state = stateOf(id);
    return {
      ...(id ? { id } : {}),
      text,
      state,
      stateText: state === "none" ? noneText : ISSUE_COPY.criterionState[state],
    };
  });
  const passing = items.filter((i) => i.state === "pass").length;
  if (texts.length === 0) note = ISSUE_COPY.noCriteria;
  return {
    items,
    passing,
    total: items.length,
    summary: `${passing} / ${items.length}`,
    ...(note ? { note } : {}),
  };
}

// ---------------------------------------------------------------------------
// The agent's state and controls (DB-N8-2)
// ---------------------------------------------------------------------------

export type AgentState = "working" | "pausing" | "paused" | "taken_over" | "checking" | "idle";
export type AgentControl = "pause" | "take_over" | "hand_back" | "submit";

/** DEC-34's words for an AI teammate's state: queued, working, needs you, paused, done, failed. */
export type AgentLabel = "queued" | "working" | "needs you" | "paused" | "done" | "failed" | "";

export interface AgentPanel {
  state: AgentState;
  label: AgentLabel;
  sentence: string;
  controls: AgentControl[];
  /** DB-N8-2: the message box for the agent is offered. */
  messageBox: boolean;
}

interface SeqEvent {
  seq?: number;
  type: string;
  payload?: unknown;
}

const lastSeq = (events: readonly SeqEvent[], type: string) =>
  events.reduce((n, e) => (e.type === type && (e.seq ?? 0) > n ? (e.seq ?? 0) : n), 0);

/** How many of a card's ledger entries the issue page reads (the server's page limit). */
export const ISSUE_EVENTS_LIMIT = 1000;

/**
 * The issue page's ledger read: the card's newest entries, so the agent's
 * state (a pause, a take-over, the latest move) is in it however long the run
 * — a reload and a page that stayed open read the same state (DB-P3-16).
 */
export function issueEventsUrl(cardId: string): string {
  return `/api/events?card=${encodeURIComponent(cardId)}&order=desc&limit=${ISSUE_EVENTS_LIMIT}`;
}

/** Entries in ledger order, as Activity and the agent's state read them. */
export function oldestFirst<E extends { seq?: number }>(events: readonly E[]): E[] {
  return [...events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function agentPanel(
  card: { status: string; stopReason?: string | null; stepsUsed?: number; stepBudget?: number },
  events: readonly SeqEvent[],
): AgentPanel {
  const moved = lastSeq(events, "card/status_changed");
  const used = card.stepsUsed ?? 0;
  const next = used + 1;
  const of = card.stepBudget ? ` of ${card.stepBudget}` : "";
  if (card.status === "in_progress") {
    if (lastSeq(events, "card/taken_over") > moved) {
      return {
        state: "taken_over",
        label: "paused",
        sentence:
          "Taken over by a person. Work in the issue's worktree; the agent's work so far is on its branch.",
        controls: ["submit", "hand_back"],
        messageBox: false,
      };
    }
    // The stored stop reason stays `paused` into the next run until it stops,
    // so the pause counts only when it was recorded after the latest move.
    const pausedAt = events.reduce((n, e) => {
      const patch = (e.payload as { patch?: { stopReason?: string } } | undefined)?.patch;
      return e.type === "card/updated" && patch?.stopReason === "paused" && (e.seq ?? 0) > n
        ? (e.seq ?? 0)
        : n;
    }, 0);
    if (card.stopReason === "paused" && pausedAt > moved) {
      return {
        state: "paused",
        label: "paused",
        sentence: `Paused after step ${used}. Its branch and checkpoint are kept; hand it back to resume from there.`,
        controls: ["hand_back", "take_over"],
        messageBox: false,
      };
    }
    if (lastSeq(events, "card/pause_requested") > moved) {
      return {
        state: "pausing",
        label: "working",
        sentence: `Pausing at the end of step ${next}.`,
        controls: ["take_over"],
        messageBox: true,
      };
    }
    return {
      state: "working",
      label: "working",
      sentence: `The agent is working on step ${next}${of}.`,
      controls: ["pause", "take_over"],
      messageBox: true,
    };
  }
  if (card.status === "verify") {
    return {
      state: "checking",
      label: "working",
      sentence: "The checks are running on the agent's work.",
      controls: [],
      messageBox: false,
    };
  }
  const idle: Record<string, [AgentLabel, string]> = {
    ready: ["queued", "Queued: the agent starts this issue when a slot is free."],
    planning: ["queued", "Queued: the planning model is preparing this issue for the agent."],
    review: ["needs you", "The agent's work is waiting for your review."],
    parked: ["needs you", "On hold until a person unparks it."],
    done: ["done", "Done. The agent's work is merged."],
  };
  const [label, sentence] = idle[card.status] ?? ["", "The agent isn't working on this issue."];
  return { state: "idle", label, sentence, controls: [], messageBox: false };
}

// ---------------------------------------------------------------------------
// Activity (DB-N8-1, DB-N8-3)
// ---------------------------------------------------------------------------

export interface CardMessageLike {
  id: string;
  seq?: number;
  kind: "message" | "hand_back" | string;
  principal?: string;
  principalName?: string;
  text: string;
  postedAt: string;
  reachedStep?: number;
}

export interface DecisionLike {
  id: string;
  cardId?: string;
  source?: string;
  category?: string;
  question: string;
  options: readonly { label: string }[];
  policy?: string;
  defaultIndex?: number;
  createdAt?: string;
}

export interface ActivityQuestion {
  id: string;
  source: string;
  options: { index: number; label: string; isDefault: boolean }[];
  /** The agent carries on with the default while it waits (a safe default). */
  continuing: boolean;
  line: string;
}

export interface ActivityItem {
  key: string;
  at: string;
  kind: "event" | "plan" | "steps" | "checks" | "message" | "hand_back" | "question";
  who: string;
  /** An AI teammate: shown with the AI badge. */
  ai: boolean;
  text: string;
  quote?: string;
  meta?: string;
  tone: "pass" | "fail" | "parked" | "neutral";
  /** The first and last step a steps row covers, for its link to Steps. */
  steps?: [number, number];
  question?: ActivityQuestion;
}

export interface ActivityEvent extends EventLike {
  createdAt?: string;
}

/** Shown from the messages list (their text is private), or bookkeeping. */
const NEVER = new Set(["card/message", "card/handed_back", "card/message_delivered"]);

/** Events Activity shows unless every entry is asked for. */
const BRIEF = new Set([
  "card/created",
  "card/status_changed",
  "card/accepted",
  "card/repair_plan",
  "card/step",
  "card/pause_requested",
  "card/taken_over",
  "card/review",
  "decision/answered",
  "decision/default_applied",
]);

interface StepPayload {
  turn?: number;
  calls?: { name: string; target?: string }[];
  gate?: { passed: boolean; failed?: string[]; errors?: number };
}

function boardLabel(status: string): string {
  const id = boardColumnOf(status);
  return BOARD_COLUMNS.find((c) => c.id === id)?.label ?? columnLabel(status);
}

function movedText(p: Record<string, unknown>): string {
  const from = String(p.fromStatus ?? "");
  const to = String(p.toStatus ?? "");
  const [a, b] = [boardLabel(from), boardLabel(to)];
  return a === b
    ? `moved from ${columnLabel(from)} to ${columnLabel(to)}`
    : `moved from ${a} to ${b}`;
}

function personActor(e: ActivityEvent): string {
  return eventSentence(e).actor;
}

export function activityItems(input: {
  cardId: string;
  events: readonly ActivityEvent[];
  messages: readonly CardMessageLike[];
  decisions: readonly DecisionLike[];
  /** Every ledger entry, not only the ones Activity calls out. */
  all?: boolean;
}): ActivityItem[] {
  const out: (ActivityItem & { order: number })[] = [];
  let order = 0;
  const push = (item: ActivityItem) => out.push({ ...item, order: order++ });
  // A run of plain steps, shown as one row; `as` keeps it from narrowing to null,
  // since `flush` assigns it from a closure.
  let run = null as { from: number; to: number; at: string; key: string; phrase: string } | null;
  const flush = () => {
    if (!run) return;
    push({
      key: run.key,
      at: run.at,
      kind: "steps",
      who: ISSUE_COPY.agent,
      ai: true,
      text: `took ${run.from === run.to ? `step ${run.from}` : `steps ${run.from}–${run.to}`} · last ${run.phrase}`,
      tone: "neutral",
      steps: [run.from, run.to],
    });
    run = null;
  };
  const events = [...input.events].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  for (const e of events) {
    if (NEVER.has(e.type)) continue;
    if (!input.all && !BRIEF.has(e.type)) continue;
    const at = e.createdAt ?? "";
    const key = `ev${e.seq ?? order}`;
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "card/step") {
      const s = p as StepPayload;
      const turn = s.turn ?? 0;
      const note = s.calls?.find((c) => c.name === "note" && c.target)?.target;
      const plain = !note && !s.gate;
      if (plain) {
        const phrase = stepPhrase({ turn, calls: s.calls ?? [] });
        if (run && run.to === turn - 1) run = { ...run, to: turn, phrase };
        else {
          flush();
          run = { from: turn, to: turn, at, key, phrase };
        }
        continue;
      }
      flush();
      if (note) {
        push({
          key: `${key}n`,
          at,
          kind: "plan",
          who: ISSUE_COPY.agent,
          ai: true,
          text: "noted its plan",
          quote: note,
          tone: "neutral",
          steps: [turn, turn],
        });
      }
      if (s.gate) {
        const failed = [...new Set((s.gate.failed ?? []).map(gateLabel))];
        const errors = s.gate.errors ? ` · ${plural(s.gate.errors, "error")}` : "";
        push({
          key: `${key}g`,
          at,
          kind: "checks",
          who: ISSUE_COPY.checks,
          ai: false,
          text: s.gate.passed
            ? `passed on step ${turn}`
            : `ran on step ${turn}: ${failed.join(", ") || "Checks"} failed${errors}`,
          tone: s.gate.passed ? "pass" : "fail",
          steps: [turn, turn],
        });
      }
      continue;
    }
    flush();
    if (e.type === "card/pause_requested") {
      push({
        key,
        at,
        kind: "event",
        who: personActor(e),
        ai: false,
        text: "asked the agent to pause at its next step",
        tone: "parked",
      });
      continue;
    }
    if (e.type === "card/taken_over") {
      push({
        key,
        at,
        kind: "event",
        who: personActor(e),
        ai: false,
        text: "took the issue over",
        tone: "neutral",
      });
      continue;
    }
    const s = eventSentence(e);
    const text =
      e.type === "card/status_changed" && s.verb === "moved"
        ? movedText(p)
        : [s.verb.replace(/ (on|for)$/, ""), s.rest].filter(Boolean).join(" ");
    push({
      key,
      at,
      kind: "event",
      who: s.actor,
      ai: false,
      text,
      ...(s.quote ? { quote: s.quote } : {}),
      tone: s.tone === "pass" || s.tone === "fail" || s.tone === "parked" ? s.tone : "neutral",
    });
  }
  flush();
  for (const m of input.messages) {
    const hand = m.kind === "hand_back";
    push({
      key: `msg${m.id}`,
      at: m.postedAt,
      kind: hand ? "hand_back" : "message",
      who: m.principalName?.trim() || "A person",
      ai: false,
      text: hand ? "handed the issue back to the agent" : "wrote to the agent",
      ...(m.text ? { quote: m.text } : {}),
      meta:
        m.reachedStep !== undefined
          ? `Seen by the agent at step ${m.reachedStep}`
          : "Not read yet: the agent reads it at its next step",
      tone: "neutral",
    });
  }
  for (const d of input.decisions) {
    if (d.cardId !== input.cardId) continue;
    const def = d.defaultIndex !== undefined ? d.options[d.defaultIndex]?.label : undefined;
    const continuing = d.policy === "safe_default" && def !== undefined;
    push({
      key: `dec${d.id}`,
      at: d.createdAt ?? "",
      kind: "question",
      who: ISSUE_COPY.agent,
      ai: true,
      text: d.category === "permission" ? "asked for permission" : "asked a question",
      quote: d.question,
      tone: "neutral",
      question: {
        id: d.id,
        source: d.source ?? "kernel",
        options: d.options.map((o, index) => ({
          index,
          label: o.label,
          isDefault: index === d.defaultIndex,
        })),
        continuing,
        line: continuing
          ? `Default: ${def}. The agent continues with it unless you answer.`
          : def !== undefined
            ? `Default: ${def}. The agent waits for your answer.`
            : "The agent waits for your answer.",
      },
    });
  }
  const time = (s: string) => {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
  };
  return out
    .sort((a, b) => time(a.at) - time(b.at) || a.order - b.order)
    .map(({ order: _order, ...item }) => item);
}

// ---------------------------------------------------------------------------
// Line comments carried by Send back (DB-N8-4)
// ---------------------------------------------------------------------------

export interface LineComment {
  file: string;
  line: number;
  text: string;
}

/** The server's rule for a line comment (`triage.ts` `sendBack`), word for word. */
export function lineCommentProblem(c: {
  file?: string;
  line?: number;
  text?: string;
}): string | undefined {
  if (!c.file?.trim() || !Number.isInteger(c.line) || (c.line ?? 0) < 1 || !c.text?.trim()) {
    return "A line comment names its file and line (1 or more) and says something";
  }
  return undefined;
}

export function lineCommentLabel(c: LineComment): string {
  return `${c.file}:${c.line}`;
}

/** Add a comment; a second one on the same line joins the first. */
export function addLineComment(
  comments: readonly LineComment[],
  c: { file?: string; line?: number; text?: string },
): { comments: LineComment[]; problem?: string } {
  const problem = lineCommentProblem(c);
  if (problem) return { comments: [...comments], problem };
  const next: LineComment = {
    file: String(c.file).trim(),
    line: Number(c.line),
    text: String(c.text).trim(),
  };
  const same = comments.findIndex((x) => x.file === next.file && x.line === next.line);
  if (same >= 0) {
    return {
      comments: comments.map((x, i) =>
        i === same ? { ...x, text: `${x.text}\n${next.text}` } : x,
      ),
    };
  }
  return { comments: [...comments, next] };
}

export function removeLineComment(comments: readonly LineComment[], index: number): LineComment[] {
  return comments.filter((_, i) => i !== index);
}

/** The body of `POST /api/cards/:id/return`: the reason, and the comments when there are any. */
export function sendBackBody(
  reason: string,
  comments: readonly LineComment[],
): { reason: string; comments?: LineComment[] } {
  return { reason: reason.trim(), ...(comments.length ? { comments: [...comments] } : {}) };
}
