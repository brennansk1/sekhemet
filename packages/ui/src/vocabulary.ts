/**
 * The dashboard's language, in one place (FRONTEND_DESIGN §2.3).
 *
 * Every label a person reads is derived here, from the same inputs, by pure
 * functions. The server calls them to enrich `/api/board`, publishes the tables
 * as `/vocab.json`, and serves this compiled module to the browser, so a label
 * is never re-derived by hand in a template. Internal enums (`oscillation_detected`,
 * `in_progress`, `story`) stop here: they may appear in mono in evidence detail
 * and ledger rows, and nowhere else.
 *
 * This module must stay free of runtime imports: the browser loads it as-is.
 */
import type { CardRecord, CardStatus } from "@sekhemet/kernel";

// ---------------------------------------------------------------------------
// Issue types (DEC-31): what a person reads for a card's kind and change
// ---------------------------------------------------------------------------

/**
 * The older display ids a card's planner title suffix maps to (`(SPIDR: …)`).
 * Internal: nothing shows them; a card is shown by its issue type.
 */
export type CardKind = "contract" | "storage" | "flow" | "rules" | "research" | "ui" | "wiring";

/** The standard issue types Jira, Linear and GitHub use (DEC-31). */
export type IssueType = "story" | "task" | "bug" | "spike" | "epic";

export const ISSUE_TYPE_LABELS: Record<IssueType, { label: string; tooltip: string }> = {
  story: { label: "Story", tooltip: "New behaviour a person can use." },
  task: {
    label: "Task",
    tooltip:
      "Work that adds no behaviour: a refactor, an upgrade, pinning today's behaviour, or a review.",
  },
  bug: { label: "Bug", tooltip: "A defect, fixed with a test that reproduces it first." },
  spike: { label: "Spike", tooltip: "A question answered by research or throwaway code." },
  epic: { label: "Epic", tooltip: "A larger piece of work that holds issues." },
};

export function issueTypeLabel(type: string): string {
  return ISSUE_TYPE_LABELS[type as IssueType]?.label ?? humanize(type);
}

/**
 * A card's issue type (DEC-31, NAMING's map): an epic or initiative is an
 * *Epic*; a spike or research card a *Spike*; otherwise its change decides —
 * a fix is a *Bug*, a refactor, upgrade or characterization a *Task*, a
 * review card or a card of the `task` tier a *Task*, and new behaviour (the
 * default) a *Story*. An older
 * card with no stored kind is read from its title's `(SPIDR: …)` suffix.
 */
export function issueTypeOf(card: {
  tier?: string;
  kind?: string;
  change?: string;
  title?: string;
}): IssueType {
  if (card.tier === "epic" || card.tier === "initiative") return "epic";
  const legacy = card.kind ? [] : parseTitle(card.title ?? "").kinds;
  if (card.kind === "spike" || card.kind === "research" || legacy[0] === "research") return "spike";
  if (card.change === "fix") return "bug";
  if (card.change === "refactor" || card.change === "upgrade" || card.change === "characterize")
    return "task";
  if (card.kind === "review" || card.tier === "task") return "task";
  return "story";
}

const SPIDR_KINDS: Record<string, CardKind> = {
  interface: "contract",
  interfaces: "contract",
  data: "storage",
  path: "flow",
  paths: "flow",
  rule: "rules",
  rules: "rules",
  spike: "research",
  visual: "ui",
  integration: "wiring",
};

const SPIDR_SUFFIX = /\s*\(SPIDR:([^)]*)\)\s*$/i;

/**
 * Strip the planner's `(SPIDR: …)` suffix into at most two kind tags.
 *
 * The first kind is the primary one. Unknown slice names are dropped rather
 * than shown raw: a tag nobody can explain is noise.
 */
export function parseTitle(raw: string): { title: string; kinds: CardKind[] } {
  const text = String(raw ?? "");
  const match = SPIDR_SUFFIX.exec(text);
  if (!match) return { title: text.trim(), kinds: [] };
  const kinds: CardKind[] = [];
  for (const part of (match[1] ?? "").split(/\s*(?:&|\/|,|\+|\band\b)\s*/i)) {
    const kind = SPIDR_KINDS[part.trim().toLowerCase()];
    if (kind && !kinds.includes(kind)) kinds.push(kind);
  }
  return { title: text.slice(0, match.index).trim(), kinds: kinds.slice(0, 2) };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Board order. Parked sits far right so the human's queue is never scrolled away. */
export const BOARD_COLUMN_ORDER: CardStatus[] = [
  "backlog",
  "ready",
  "planning",
  "in_progress",
  "verify",
  "review",
  "done",
  "parked",
  "rejected",
];

/**
 * One name per state. The column heading, the stored value, the error
 * message and the design all use it: a user who reads `verify` in a stop
 * reason must be able to find the column called Verify. Earlier drafts used
 * Working, Checking and Closed here, which is how the product ended up with
 * three vocabularies for one machine and cost the user the ability to search
 * for what an error told them.
 */
const COLUMN_LABELS: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  in_progress: "In progress",
  verify: "Verify",
  review: "Review",
  done: "Done",
  parked: "Parked",
  rejected: "Rejected",
};

/** What an empty column is for, shown at its top instead of "No cards". */
export const COLUMN_EMPTY: Record<CardStatus, string> = {
  backlog: "Ideas and split-off work.",
  ready: "Cards whose dependencies are done.",
  planning: "The planning model is writing plans and tests.",
  in_progress: "No agent running.",
  verify: "Nothing being checked.",
  review: "Nothing waiting for you.",
  done: "Accepted cards appear here.",
  parked: "Nothing parked.",
  rejected: "Nothing rejected.",
};

export function columnLabel(status: string): string {
  return COLUMN_LABELS[status as CardStatus] ?? humanize(status);
}

/**
 * A stored state in plain words, for Status and plain mode (dashboard §2.8.13,
 * DB-P5-2): no column jargon, no stop-reason code.
 */
const PLAIN_STATUS: Record<CardStatus, string> = {
  backlog: "Not started",
  ready: "Ready to start",
  planning: "Being planned",
  in_progress: "Being built",
  verify: "Being checked",
  review: "Waiting for review",
  done: "Done",
  parked: "On hold",
  rejected: "Won't do",
};

export function plainStatus(status: string): string {
  return PLAIN_STATUS[status as CardStatus] ?? humanize(status);
}

/**
 * The default board's columns (dashboard §2.4.1, NAMING): five professional
 * columns over the nine stored states, the same mapping the Jira export uses,
 * plus On hold only while a card is parked. Rejected is not a column: it is
 * the *Won't do* filter. Pipeline stages shows the nine stored states instead.
 */
export type BoardColumnId = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "on_hold";

export interface BoardColumnDef {
  id: string;
  label: string;
  states: CardStatus[];
  /** What the column is for, shown when it is empty. */
  empty: string;
  /** A person's queue: sorted by wait, longest first, and pinned in view. */
  queue: boolean;
  /** Shown only while it holds cards (On hold). */
  onlyWithCards: boolean;
}

export const BOARD_COLUMNS: readonly BoardColumnDef[] = [
  {
    id: "backlog",
    label: "Backlog",
    states: ["backlog"],
    empty: "Ideas and split-off work.",
    queue: false,
    onlyWithCards: false,
  },
  {
    id: "todo",
    label: "To do",
    states: ["ready", "planning"],
    empty: "Cards whose dependencies are done, and cards being planned.",
    queue: false,
    onlyWithCards: false,
  },
  {
    id: "in_progress",
    label: "In progress",
    states: ["in_progress", "verify"],
    empty: "No agent running.",
    queue: false,
    onlyWithCards: false,
  },
  {
    id: "in_review",
    label: "In review",
    states: ["review"],
    empty: "Nothing waiting for you.",
    queue: true,
    onlyWithCards: false,
  },
  {
    id: "done",
    label: "Done",
    states: ["done"],
    empty: "Accepted cards appear here.",
    queue: false,
    onlyWithCards: false,
  },
  {
    id: "on_hold",
    label: "On hold",
    states: ["parked"],
    empty: "Nothing parked.",
    queue: true,
    onlyWithCards: true,
  },
];

/** *Won't do*: the rejected cards, a filter rather than a column. */
export const WONT_DO_COLUMN: BoardColumnDef = {
  id: "wont_do",
  label: "Won't do",
  states: ["rejected"],
  empty: "Nothing rejected.",
  queue: false,
  onlyWithCards: true,
};

/** Pipeline stages (`⇧V`): one column per stored state, named as stored. */
export const PIPELINE_COLUMNS: readonly BoardColumnDef[] = BOARD_COLUMN_ORDER.map((s) => ({
  id: s,
  label: COLUMN_LABELS[s],
  states: [s],
  empty: COLUMN_EMPTY[s],
  queue: s === "review" || s === "parked",
  onlyWithCards: false,
}));

/** The default board's column for a stored state; `wont_do` for Rejected. */
export function boardColumnOf(status: string): BoardColumnId | "wont_do" | undefined {
  if (status === "rejected") return "wont_do";
  return BOARD_COLUMNS.find((c) => c.states.includes(status as CardStatus))?.id as
    | BoardColumnId
    | undefined;
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

// `executor` and `manager` are the pre-rename spellings, kept only so that
// events already in a ledger still render. Nothing writes them.
const ACTOR_LABELS: Record<string, string> = {
  worker: "Agent",
  executor: "Agent",
  planner: "Planning model",
  manager: "Planning model",
  researcher: "Research model",
  reviewer: "AI review",
  human: "You",
  harness: "Sekhemet",
  system: "Sekhemet",
};

export function actorLabel(actor: string): string {
  return ACTOR_LABELS[actor] ?? humanize(actor);
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

const GATE_LABELS: Record<string, string> = {
  parse: "Parse",
  typecheck: "Types",
  types: "Types",
  test: "Tests",
  unit: "Tests",
  tests: "Tests",
  lint: "Lint",
  bounds: "Size",
  size: "Size",
  visual: "Visual",
};

/** Gate id or rung -> the word a person reads. The id itself stays in mono. */
export function gateLabel(idOrRung: string): string {
  return GATE_LABELS[String(idOrRung).toLowerCase()] ?? humanize(idOrRung);
}

/** `unavailable`: the gate could not produce a verdict (gates rule 9) — not a pass, not a failure of the work. */
export type GateState = "pass" | "fail" | "unavailable" | "skipped" | "not_run" | "running";

export const GATE_STATE_LABELS: Record<GateState, string> = {
  pass: "Passed",
  fail: "Failed",
  unavailable: "Unavailable",
  skipped: "Skipped",
  not_run: "Not run",
  running: "Running",
};

/** SHA-256 of the empty string: what an absent gates.toml hashes to. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** What a run on the defaults records instead of a hash (gates GT-T1-10). */
const NO_GATES_CONFIG = "no gates.toml";

/** No gates.toml: the text a run records now, or the empty-string hash older bundles carry. */
export function isEmptyGateContract(sha: string | undefined): boolean {
  return sha === NO_GATES_CONFIG || sha === EMPTY_SHA256;
}

/**
 * The gate strip's warning for the brief's invariants the architecture gate
 * cannot check (gates GT-N1-1), from `/api/gates`' `invariants.notEnforced`:
 * each line, and the two forms it could be restated in. Undefined when there
 * are none.
 */
export function invariantsNotEnforced(
  notEnforced: readonly { line: string; restate: readonly string[] }[] | undefined,
): { label: string; heading: string; lines: string[]; forms: string[] } | undefined {
  if (!notEnforced || notEnforced.length === 0) return undefined;
  const n = notEnforced.length;
  return {
    label: `${n} ${n === 1 ? "invariant" : "invariants"} not enforced`,
    heading: "The architecture check cannot verify these lines of the brief.",
    lines: notEnforced.map((l) => l.line),
    forms: [...(notEnforced[0]?.restate ?? [])],
  };
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "running" | "pass" | "fail" | "parked" | "blocked";

/**
 * The glyph each state carries beside its colour (an `ICONS` name). The copper
 * of *Needs you* sits 7–10° of hue from the red ochre of a failure, so the two
 * are told apart by glyph and by lightness, never by hue alone (DEC-42,
 * dashboard §2.13.2). Running is the pulsing dot.
 */
export const STATE_GLYPHS = {
  running: "dot",
  pass: "check",
  fail: "x",
  parked: "pause",
  blocked: "link",
} as const satisfies Record<Exclude<Tone, "neutral">, string>;

export interface StopReasonContext {
  /** The step the attempt stopped on. */
  step?: number;
  stepBudget?: number;
  repairs?: number;
  memoryPercent?: number;
}

/** Why an attempt stopped: a short label, a sentence, and the tone it carries. */
/** SEC-21: the confinement a card ran under, as the card's Run facts show it. */
export function isolationLabel(isolation: string | undefined): {
  short: string;
  sentence: string;
  tone: Tone;
} {
  switch (isolation) {
    case "seatbelt":
      return { short: "Seatbelt", sentence: "Ran under the macOS sandbox.", tone: "neutral" };
    case "bubblewrap":
      return { short: "bubblewrap", sentence: "Ran under the Linux sandbox.", tone: "neutral" };
    case "srt":
      return {
        short: "sandbox-runtime",
        sentence: "Ran under Anthropic's sandbox-runtime (DEC-39).",
        tone: "neutral",
      };
    case "none":
      return {
        short: "Unconfined",
        sentence:
          "Ran with no sandbox because SEKHEMET_ALLOW_UNCONFINED=1 was set. Its commands could reach the whole machine.",
        tone: "parked",
      };
    default:
      return {
        short: "Not recorded",
        sentence: "This run did not record its sandbox.",
        tone: "neutral",
      };
  }
}

export function stopReasonLabel(
  reason: string | undefined,
  ctx: StopReasonContext = {},
): { short: string; sentence: string; tone: Tone } {
  switch (reason) {
    case "gate_passed":
      return {
        short: "Passed",
        sentence: ctx.step ? `All checks passed on step ${ctx.step}.` : "All checks passed.",
        tone: "pass",
      };
    case "budget_exhausted":
      return {
        short: "Out of steps",
        sentence: ctx.stepBudget
          ? `Used all ${ctx.stepBudget} budgeted steps without passing.`
          : "Used every budgeted step without passing.",
        tone: "fail",
      };
    case "oscillation_detected":
      return {
        short: "Looping",
        sentence: "Repeated the same actions without changing any file.",
        tone: "fail",
      };
    case "no_progress":
      return { short: "Stalled", sentence: "No file changed for 3 steps.", tone: "fail" };
    case "repair_exhausted":
      return {
        short: "Couldn't fix",
        sentence: ctx.repairs
          ? `Tried ${ctx.repairs} repairs; the same check kept failing.`
          : "Tried every repair; the same check kept failing.",
        tone: "fail",
      };
    case "memory_pressure":
      return {
        short: "Paused for memory",
        sentence: ctx.memoryPercent
          ? `Stopped safely at ${ctx.memoryPercent}% memory. Resumable.`
          : "Stopped safely before the system would swap. Resumable.",
        tone: "parked",
      };
    case "quota_suspended":
      return {
        short: "Paused for quota",
        sentence: "The model provider's limit was reached.",
        tone: "parked",
      };
    case "error":
      return {
        short: "Harness error",
        sentence: "Sekhemet failed, not the agent. See the issue's Activity.",
        tone: "fail",
      };
    case "scope_violation":
      return {
        short: "Out of scope",
        sentence: "Tried to edit a file this issue may not touch.",
        tone: "fail",
      };
    case "capability_ceiling":
      return {
        short: "Too hard for this model",
        sentence: "Needs a split or a stronger model.",
        tone: "fail",
      };
    case "human_abort":
      return { short: "Stopped by you", sentence: "You stopped this attempt.", tone: "neutral" };
    case "paused":
      return {
        short: "Paused by you",
        sentence: "Paused at a step boundary; hand it back with a note to resume, or take it over.",
        tone: "parked",
      };
    case "done_pending_gates":
      return {
        short: "Done, checks not run",
        sentence: "The agent finished, but the checks could not run to confirm it.",
        tone: "blocked",
      };
    case "token_budget_exhausted":
      return {
        short: "Out of tokens",
        sentence: "Spent the issue's token budget without passing.",
        tone: "fail",
      };
    case "time_budget_exhausted":
      return {
        short: "Out of time",
        sentence: "Spent the issue's time budget without passing.",
        tone: "fail",
      };
    case "replan_requested":
      return {
        short: "Needs a new plan",
        sentence: "Direct repairs did not work; the issue went back to Planning.",
        tone: "blocked",
      };
    case "rebase_conflict":
      return {
        short: "Conflicts with main",
        sentence:
          "Its changes conflict with work merged since it started, outside its scope or beyond its budget; a person decides.",
        tone: "blocked",
      };
    case "git_metadata_tampered":
      return {
        short: "Git files changed",
        sentence:
          "Stopped because the worktree's git files were changed in a way that could run a program. Nothing was committed; look at the named files before running it again.",
        tone: "blocked",
      };
    case "integration_failed":
      return {
        short: "Breaks on main",
        sentence: "Its checks passed alone but fail on top of the latest main.",
        tone: "fail",
      };
    case "vacuous_tests":
      return {
        short: "Tests already pass",
        sentence: "Its acceptance tests pass before any work, so they cannot measure it.",
        tone: "parked",
      };
    case "tests_not_red_for_reason":
      return {
        short: "Tests fail wrongly",
        sentence:
          "Its acceptance tests fail before any work, but on an error rather than an assertion.",
        tone: "parked",
      };
    case "base_not_green":
      return {
        short: "Tests fail on main",
        sentence:
          "Its tests must pass before any work, because it pins, restructures or upgrades existing code, but they fail.",
        tone: "parked",
      };
    case "gate_suspected":
      return {
        short: "Check in question",
        sentence: "The agent holds that a check, not its work, is wrong. A person decides which.",
        tone: "blocked",
      };
    case "hook_veto":
      return {
        short: "Stopped by a hook",
        sentence:
          "A project hook vetoed the next step. Change the hook or the issue, then unpark it.",
        tone: "blocked",
      };
    case "crashed":
      return {
        short: "Stopped mid-run",
        sentence:
          "Sekhemet stopped mid-attempt. The next run resumes from the last completed step.",
        tone: "parked",
      };
    default:
      // A reason with no words yet: the tile keeps its name; the sentence stays worded (DB-P5-2).
      return reason
        ? {
            short: humanize(reason),
            sentence: "It stopped before its checks passed.",
            tone: "neutral",
          }
        : { short: "Not run", sentence: "This issue has not run yet.", tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** Wait time: `45s`, `12m`, `2h 10m`, `3d 4h`. Always a unit, never a bare number. */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Duration of work: `0.4s`, `42s`, `22m 10s`, `1h 5m`. */
export function formatDuration(ms: number): string {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}s`;
  const s = Math.round(n / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Token counts: `180`, `2.1k`, `16.8k`, `1.2M`. */
export function formatTokens(n: number): string {
  const v = Math.max(0, Math.round(Number(n) || 0));
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${trim(v / 1000)}k`;
  return `${trim(v / 1_000_000)}M`;
}

/** `1 file`, `2 files`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `card_chron_hasher` -> `hasher`. The full id stays in tooltips and mono detail. */
export function shortId(id: string): string {
  return (
    String(id)
      .replace(/^card_/, "")
      .replace(/^[a-z]+_/, "") || String(id)
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** The subset of an evidence bundle presentation reads. */
export interface EvidenceLike {
  id?: string;
  passed: boolean;
  stopReason?: string;
  turnsUsed?: number;
  durationMs?: number;
  filesTouched?: string[];
  linesAdded?: number;
  linesRemoved?: number;
  rungResults?: {
    gate: string;
    rung: string;
    passed: boolean;
    skipped?: boolean;
    /** The gate could not run (gates rule 9). */
    unavailable?: boolean;
    durationMs?: number;
  }[];
  failures?: { gate?: string; rung: string; errorExcerpt?: string }[];
  gatesConfigSha256?: string;
}

export interface GateSummary {
  id: string;
  label: string;
  state: GateState;
  durationMs?: number;
  failures: number;
  /** Plain detail, e.g. the Size gate's `1 file · 18 lines`. */
  detail?: string;
  /** True for gates the harness computes rather than runs (Size). */
  derived?: boolean;
  /** First line of the first typed failure, for hover detail. */
  firstError?: string;
}

export interface GateLimits {
  maxFiles?: number;
  maxDiffLines?: number;
}

/**
 * Gates in execution order: configured gates first (in gates.toml order, so a
 * declared gate that never ran shows as "Not run" instead of vanishing), then
 * any extra gates the evidence reports, then the derived Size gate. There is no
 * synthetic Parse: a gate that did not run is not reported as passed.
 */
export function gateSummary(
  evidence: EvidenceLike | undefined,
  configured: { id: string; rung?: string }[] = [],
  limits: GateLimits = {},
): GateSummary[] {
  const results = evidence?.rungResults ?? [];
  const failures = evidence?.failures ?? [];
  const failuresOf = (id: string, rung?: string) =>
    failures.filter((f) => (f.gate ? f.gate === id : f.rung === (rung ?? id)));
  const firstLine = (list: { errorExcerpt?: string }[]) =>
    list[0]?.errorExcerpt?.split("\n")[0]?.trim().slice(0, 200);

  const out: GateSummary[] = [];
  const seen = new Set<string>();
  const push = (id: string, rung: string | undefined) => {
    if (seen.has(id)) return;
    seen.add(id);
    const r = results.find((x) => x.gate === id);
    const state: GateState = !r
      ? "not_run"
      : r.skipped
        ? "skipped"
        : r.passed
          ? "pass"
          : r.unavailable
            ? "unavailable"
            : "fail";
    const mine = state === "fail" || state === "unavailable" ? failuresOf(id, rung ?? r?.rung) : [];
    const first = firstLine(mine);
    out.push({
      id,
      label: gateLabel(rung ?? id),
      state,
      ...(r && !r.skipped && r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      failures: mine.length,
      ...(first ? { firstError: first } : {}),
    });
  };
  for (const g of configured) push(g.id, g.rung);
  for (const r of results) push(r.gate, r.rung);

  if (evidence && !seen.has("bounds") && evidence.filesTouched) {
    const files = evidence.filesTouched.length;
    const lines = (evidence.linesAdded ?? 0) + (evidence.linesRemoved ?? 0);
    const boundsList = failures.filter((f) => f.rung === "bounds");
    const boundsFailures = boundsList.length;
    const boundsFirst = firstLine(boundsList);
    const over =
      files > (limits.maxFiles ?? Number.POSITIVE_INFINITY) ||
      lines > (limits.maxDiffLines ?? Number.POSITIVE_INFINITY);
    out.push({
      id: "bounds",
      label: "Size",
      state: boundsFailures > 0 || over ? "fail" : "pass",
      failures: boundsFailures,
      detail: `${plural(files, "file")} · ${plural(lines, "line")}`,
      derived: true,
      ...(boundsFirst ? { firstError: boundsFirst } : {}),
    });
  }
  return out;
}

/** "Types and Tests", "Types, Tests and Lint". */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The outcome sentence under a card's title in Review, Peek and Card view.
 * "Passed on step 1 · 1.2s · 1 file, +18 −0" / "Failed Types and Tests · Looping on step 8".
 */
export function outcomeSentence(evidence: EvidenceLike, gates?: GateSummary[]): string {
  const step = evidence.turnsUsed;
  const time = evidence.durationMs !== undefined ? formatDuration(evidence.durationMs) : "";
  const files = evidence.filesTouched?.length ?? 0;
  const diff = `${plural(files, "file")}, +${evidence.linesAdded ?? 0} −${evidence.linesRemoved ?? 0}`;
  if (evidence.passed) {
    return [step ? `Passed on step ${step}` : "Passed", time, diff].filter(Boolean).join(" · ");
  }
  const summary = gates ?? gateSummary(evidence);
  const failed = summary.filter((g) => g.state === "fail").map((g) => g.label);
  const down = summary.filter((g) => g.state === "unavailable").map((g) => g.label);
  const stop = stopReasonLabel(evidence.stopReason);
  const head = [
    failed.length || !down.length ? (failed.length ? `Failed ${joinWords(failed)}` : "Failed") : "",
    down.length ? `${joinWords(down)} unavailable` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [head, step ? `${stop.short} on step ${step}` : stop.short].join(" · ");
}

// ---------------------------------------------------------------------------
// Card display (the `display` field on /api/board)
// ---------------------------------------------------------------------------

/** What the tile's left mark in row 3 shows. */
export type StatusMark =
  | "none"
  | "blocked"
  | "planning"
  | "running"
  | "pips"
  | "wait"
  | "parked"
  | "done"
  | "fail";

export interface CardDisplay {
  title: string;
  kinds: CardKind[];
  /** The issue type a person reads (DEC-31): Story, Task, Bug, Spike or Epic. */
  type: IssueType;
  shortId: string;
  stateLabel: string;
  statusLine: string;
  tone: Tone;
  mark: StatusMark;
  stopLabel?: string;
  enteredColumnAt?: string;
  waitsOn?: { id: string; title: string }[];
  /** True for cards in the Review queue's "Need you" group. */
  needsYou: boolean;
  /** The merge sha, once accepted. */
  acceptedSha?: string;
  /** `8 of 32 steps`, only once the card has started. */
  budgetText?: string;
  /**
   * The status line only restates the column and the budget (a plain Backlog
   * or Ready card): the board face shows no badge for it (DB-P3-8).
   */
  quiet?: true;
  /** When the card first entered In progress: the start of its work item age. */
  startedAt?: string;
  /** The owner's and a person delegate's names, as the ledger records them. */
  ownerName?: string;
  delegateName?: string;
  budgetRatio?: number;
  evidence?: {
    id?: string;
    passed: boolean;
    gates: GateSummary[];
    linesAdded: number;
    linesRemoved: number;
    files: number;
    stopReason?: string;
  };
}

export interface DisplayContext {
  now?: number;
  evidence?: EvidenceLike;
  /** When the card entered its current column, from its last status event. */
  enteredColumnAt?: string;
  /** Reason recorded on the transition into the current column. */
  statusReason?: string;
  /** Actor of the transition into the current column. */
  statusActor?: string;
  /** Unfinished cards this one depends on. */
  waitsOn?: { id: string; title: string }[];
  configuredGates?: { id: string; rung?: string }[];
  limits?: GateLimits;
  /** The latest `card/step` of a running card: what it is doing right now. */
  lastStep?: StepLike;
  /** The sha an accept merged as, from the `card/accepted` ledger event. */
  acceptedSha?: string;
  /** When the card first entered In progress (work item age, §2.4.4). */
  startedAt?: string;
  /** The owner's name, and a person delegate's, resolved from their principals. */
  ownerName?: string;
  delegateName?: string;
}

/** A tool call as the ledger and transcript record it. */
export interface CallLike {
  name: string;
  target?: string;
}

/** The subset of a `card/step` payload presentation reads. */
export interface StepLike {
  turn: number;
  calls?: CallLike[];
  gate?: { passed: boolean; failed?: string[] };
}

const CALL_VERBS: Record<string, string> = {
  write_file: "editing",
  edit_file: "editing",
  replace_in_file: "editing",
  apply_patch: "editing",
  create_file: "creating",
  read_file: "reading",
  list_files: "listing",
  search: "searching",
  grep: "searching",
  run_cmd: "running",
  check: "checking",
  run_tests: "running tests",
  finish_card: "finishing",
  note: "noting",
};

/** "editing src/hasher.ts", "running pnpm test", "finishing". */
export function callPhrase(call: CallLike): string {
  const verb = CALL_VERBS[call.name] ?? humanize(call.name).toLowerCase();
  if (call.name === "finish_card") return "asking for verification";
  if (call.name === "note") return call.target ? `noting "${call.target}"` : "noting";
  return call.target ? `${verb} ${call.target}` : verb;
}

/** The phrase for a step: its most telling call, preferring edits to reads. */
export function stepPhrase(step: StepLike): string {
  const calls = step.calls ?? [];
  const pick =
    calls.find((c) => /write|edit|create|patch|replace/.test(c.name)) ??
    calls.find((c) => c.name !== "finish_card") ??
    calls[0];
  return pick ? callPhrase(pick) : "thinking";
}

/** The one line that states a card's current truth, in words (§2.5.1 row 3). */
export function statusLine(
  card: Pick<CardRecord, "status" | "stepsUsed" | "stepBudget">,
  ctx: DisplayContext = {},
): { text: string; tone: Tone; mark: StatusMark; quiet?: true } {
  const now = ctx.now ?? Date.now();
  const ev = ctx.evidence;
  const budget = `${card.stepBudget}-step budget`;
  const since = ctx.enteredColumnAt ? now - Date.parse(ctx.enteredColumnAt) : undefined;
  const gates = ev ? gateSummary(ev, ctx.configuredGates, ctx.limits) : [];
  const failed = gates.filter((g) => g.state === "fail");
  const stop = stopReasonLabel(ev?.stopReason);
  const firstFail = failed[0];
  const failText = firstFail
    ? `${firstFail.label} failed · ${firstFail.failures > 0 ? plural(firstFail.failures, "error") : stop.short}`
    : `Failed · ${stop.short}`;
  const waits = ctx.waitsOn ?? [];

  if ((card.status === "backlog" || card.status === "ready") && waits.length > 0) {
    const first = waits[0] as { title: string };
    const more = waits.length > 1 ? ` +${waits.length - 1}` : "";
    return { text: `Waits on ${first.title}${more}`, tone: "blocked", mark: "blocked" };
  }

  switch (card.status) {
    case "backlog":
      return { text: `Backlog · ${budget}`, tone: "neutral", mark: "none", quiet: true };
    case "ready":
      if (/^returned:/.test(ctx.statusReason ?? "")) {
        return { text: "Sent back with your note", tone: "neutral", mark: "none" };
      }
      if (ev && !ev.passed) return { text: `${failText} · will retry`, tone: "fail", mark: "fail" };
      return { text: `Ready · ${budget}`, tone: "neutral", mark: "none", quiet: true };
    case "planning":
      // A card whose attempt failed comes back to Planning; nothing is
      // working on it until it is re-planned, so say what failed.
      if (ev && !ev.passed)
        return { text: `${failText} · needs a new plan`, tone: "fail", mark: "fail" };
      return { text: "Being planned", tone: "neutral", mark: "planning" };
    case "in_progress": {
      // What the agent is doing now. Its step count is the issue's, never the
      // board's (DEC-31, DB-N7-3): `budgetText` carries it to the issue.
      const step = ctx.lastStep;
      if (step) {
        const phrase = stepPhrase(step);
        return {
          text: `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`,
          tone: "running",
          mark: "running",
        };
      }
      return card.stepsUsed > 0
        ? { text: "Working", tone: "running", mark: "running" }
        : { text: "Starting", tone: "running", mark: "running" };
    }
    case "verify":
      if (!ev) return { text: "Running checks…", tone: "running", mark: "running" };
      if (!ev.passed) return { text: failText, tone: "fail", mark: "pips" };
      return { text: "Holding for review", tone: "neutral", mark: "pips" };
    case "review":
      return {
        text: since !== undefined ? `Waiting ${formatWait(since)}` : "Waiting for you",
        tone: "pass",
        mark: "wait",
      };
    case "done":
      return {
        text: [
          "Accepted",
          ctx.acceptedSha ? ctx.acceptedSha.slice(0, 7) : "",
          since !== undefined ? `${formatWait(since)} ago` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "neutral",
        mark: "done",
      };
    case "parked": {
      const note = /^parked:\s*(.+)$/s.exec(ctx.statusReason ?? "")?.[1]?.trim();
      if (note) return { text: note, tone: "parked", mark: "parked" };
      if (ev?.stopReason === "memory_pressure" || ev?.stopReason === "quota_suspended") {
        const at = ev.turnsUsed ? ` at step ${ev.turnsUsed}` : "";
        return { text: `${stop.short}${at}`, tone: "parked", mark: "parked" };
      }
      if (ev && !ev.passed)
        return { text: `${stop.short} · parked`, tone: "parked", mark: "parked" };
      return { text: note ?? "Parked", tone: "parked", mark: "parked" };
    }
    case "rejected":
      return { text: "Rejected", tone: "neutral", mark: "none" };
    default:
      return { text: columnLabel(card.status), tone: "neutral", mark: "none" };
  }
}

/**
 * The board's tag for a card's stored kind (PM-P1-10, DEC-26); `review` has
 * no tag yet. NAMING's full map, with UI and Wiring, is NEW-dashboard-2's.
 */
const STORED_KINDS: Partial<Record<NonNullable<CardRecord["kind"]>, CardKind>> = {
  interface: "contract",
  data: "storage",
  implement: "flow",
  rule: "rules",
  spike: "research",
  research: "research",
};

/** Everything the board and the review queue show about a card, derived once. */
export function describeCard(card: CardRecord, ctx: DisplayContext = {}): CardDisplay {
  const parsed = parseTitle(card.title);
  const title = parsed.title;
  // The stored kind decides; an older card's title suffix is read only when none is stored.
  const stored = card.kind ? STORED_KINDS[card.kind] : undefined;
  const kinds = card.kind ? (stored ? [stored] : []) : parsed.kinds;
  const line = statusLine(card, ctx);
  const ev = ctx.evidence;
  const started = card.stepsUsed > 0 && card.status !== "done";
  const display: CardDisplay = {
    title,
    kinds,
    type: issueTypeOf(card),
    shortId: shortId(card.id),
    stateLabel: columnLabel(card.status),
    statusLine: line.text,
    tone: line.tone,
    mark: line.mark,
    needsYou:
      card.status === "parked" || (card.status === "verify" && ev !== undefined && !ev.passed),
  };
  if (line.quiet) display.quiet = true;
  if (ev?.stopReason) display.stopLabel = stopReasonLabel(ev.stopReason).short;
  if (ctx.startedAt) display.startedAt = ctx.startedAt;
  if (ctx.ownerName) display.ownerName = ctx.ownerName;
  if (ctx.delegateName) display.delegateName = ctx.delegateName;
  if (ctx.enteredColumnAt) display.enteredColumnAt = ctx.enteredColumnAt;
  if (ctx.acceptedSha) display.acceptedSha = ctx.acceptedSha;
  if (ctx.waitsOn && ctx.waitsOn.length > 0) display.waitsOn = ctx.waitsOn;
  if (ctx.lastStep && card.status === "in_progress" && ctx.lastStep.turn > card.stepsUsed) {
    display.budgetText = `${ctx.lastStep.turn} of ${card.stepBudget} steps`;
    display.budgetRatio =
      card.stepBudget > 0 ? Math.min(1, ctx.lastStep.turn / card.stepBudget) : 0;
  } else if (started) {
    display.budgetText = `${card.stepsUsed} of ${card.stepBudget} steps`;
    display.budgetRatio = card.stepBudget > 0 ? Math.min(1, card.stepsUsed / card.stepBudget) : 0;
  }
  if (ev) {
    display.evidence = {
      ...(ev.id ? { id: ev.id } : {}),
      passed: ev.passed,
      gates: gateSummary(ev, ctx.configuredGates, ctx.limits),
      linesAdded: ev.linesAdded ?? 0,
      linesRemoved: ev.linesRemoved ?? 0,
      files: ev.filesTouched?.length ?? 0,
      ...(ev.stopReason ? { stopReason: ev.stopReason } : {}),
    };
  }
  return display;
}

// ---------------------------------------------------------------------------
// Ledger sentences (§2.4.5, Thread tab)
// ---------------------------------------------------------------------------

export interface EventLike {
  seq?: number;
  type: string;
  actor: string;
  cardId?: string;
  payload?: unknown;
  /** The event's private part, when the reader was given it (kernel rule 33). */
  private?: unknown;
}

/**
 * One ledger event as a sentence: `{actor} {verb} **{title}** {rest}`, plus an
 * optional quote (a send-back or park note, a repair plan). The title stays a
 * separate field so the page can bold and link it after escaping.
 */
export interface EventSentence {
  actor: string;
  verb: string;
  title?: string;
  rest?: string;
  quote?: string;
  tone: Tone;
}

export function eventSentence(
  event: EventLike,
  titleOf: (cardId: string) => string | undefined = () => undefined,
): EventSentence {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  // Chat, research and compute events carry their own ids, not a card's.
  const ownId = /^(pm|research|compute)\//.test(event.type);
  const id = event.cardId ?? (!ownId && typeof p.id === "string" ? p.id : undefined);
  const title = id ? (titleOf(id) ?? shortId(id)) : undefined;
  const actor = actorLabel(event.actor);
  const base = { actor, ...(title ? { title } : {}) };
  switch (event.type) {
    case "card/created": {
      const created = typeof p.title === "string" ? parseTitle(p.title).title : title;
      return { ...base, ...(created ? { title: created } : {}), verb: "created", tone: "neutral" };
    }
    case "card/status_changed": {
      const from = columnLabel(String(p.fromStatus ?? ""));
      const to = String(p.toStatus ?? "");
      const reason = typeof p.reason === "string" ? p.reason : "";
      const note = /^(returned|parked):\s*(.+)$/s.exec(reason)?.[2]?.trim();
      if (to === "done") return { ...base, verb: "accepted", rest: "into Done", tone: "pass" };
      if (reason.startsWith("returned")) {
        return {
          ...base,
          verb: "sent back",
          rest: "to Ready",
          ...(note ? { quote: note } : {}),
          tone: "neutral",
        };
      }
      if (to === "parked") {
        return { ...base, verb: "parked", ...(note ? { quote: note } : {}), tone: "parked" };
      }
      return {
        ...base,
        verb: "moved",
        rest: `from ${from} to ${columnLabel(to)}`,
        tone: "neutral",
      };
    }
    case "card/updated": {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      const keys = Object.keys(patch);
      if (keys.length === 1 && typeof patch.stepsUsed === "number") {
        return {
          ...base,
          actor: "Agent",
          verb: `finished step ${patch.stepsUsed} on`,
          tone: "neutral",
        };
      }
      return {
        ...base,
        verb: "updated",
        rest: keys.length ? `(${keys.map((k) => humanize(k).toLowerCase()).join(", ")})` : "",
        tone: "neutral",
      };
    }
    case "card/step": {
      const step = p as unknown as StepLike;
      const gate = step.gate
        ? step.gate.passed
          ? " · checks passed"
          : ` · ${(step.gate.failed ?? []).map(gateLabel).join(", ") || "checks"} failed`
        : "";
      return {
        ...base,
        verb: `took step ${step.turn ?? "?"} on`,
        rest: `· ${stepPhrase(step)}${gate}`,
        tone: step.gate ? (step.gate.passed ? "pass" : "fail") : "neutral",
      };
    }
    case "card/accepted": {
      const sha = typeof p.sha === "string" ? p.sha.slice(0, 7) : "";
      return { ...base, verb: "merged", rest: sha ? `to main as ${sha}` : "to main", tone: "pass" };
    }
    case "card/repair_plan":
      return {
        ...base,
        verb: "wrote a repair plan for",
        ...(typeof p.plan === "string" ? { quote: p.plan } : {}),
        tone: "neutral",
      };
    case "pm/message": {
      const text = typeof p.text === "string" ? p.text : "";
      return {
        ...base,
        actor: "You",
        verb: text.startsWith("/") ? "ran" : "asked Seshat",
        ...(text ? { quote: text.slice(0, 160) } : {}),
        tone: "neutral",
      };
    }
    case "pm/reply": {
      const text = typeof p.text === "string" ? p.text : "";
      const fromLedger = p.model === "ledger" || p.model === "command";
      return {
        ...base,
        actor: "Seshat",
        verb: fromLedger ? "answered from the ledger" : "replied",
        ...(text ? { quote: (text.split("\n").find((l) => l.trim()) ?? text).slice(0, 160) } : {}),
        tone: p.error ? "fail" : "neutral",
      };
    }
    case "pm/notify":
      return {
        ...base,
        actor: "Sekhemet",
        verb: p.ok === false ? "could not send" : "sent",
        rest: `a ${String(p.kind ?? "").replace(/_/g, " ")} notice via ${String(p.channel ?? "")}`,
        tone: p.ok === false ? "fail" : "neutral",
      };
    case "research/asked": {
      const asked = ((event.private ?? {}) as { question?: unknown }).question;
      return {
        ...base,
        actor: "Research model",
        verb: p.fromMemory ? "answered from memory" : p.deep ? "researched in depth" : "researched",
        // The question is private (it can carry a card's spec and a gate's
        // output): quoted, first line only, from the private part when given.
        ...(typeof asked === "string" && asked.trim()
          ? { quote: (asked.trim().split("\n")[0] ?? "").slice(0, 160) }
          : {}),
        rest: `· ${p.grounded ? `grounded, confidence ${Number(p.confidence ?? 0).toFixed(2)}` : "not grounded"} · ${(p.sources as unknown[] | undefined)?.length ?? 0} source(s)`,
        tone: p.grounded ? "pass" : "fail",
      };
    }
    case "card/repro":
      return {
        ...base,
        actor: "Sekhemet",
        verb: "recorded how it ran",
        rest: `(${String((p.model as { id?: string } | undefined)?.id ?? "model")}${(p.model as { quant?: string } | undefined)?.quant ? ` ${(p.model as { quant?: string }).quant}` : ""})`,
        tone: "neutral",
      };
    case "compute/usage":
      return {
        ...base,
        actor: "Sekhemet",
        verb: "used",
        rest: `${Number(p.kwh ?? 0).toFixed(3)} kWh over ${Math.round(Number(p.durationMs ?? 0) / 60000)} min`,
        tone: "neutral",
      };
    case "compute/breaker_tripped":
      return {
        ...base,
        actor: "Sekhemet",
        verb: `stopped unattended work (${String(p.breaker ?? "breaker")})`,
        ...(typeof p.reason === "string" ? { quote: p.reason } : {}),
        tone: "fail",
      };
    case "checkpoint/recorded":
      return {
        ...base,
        actor: "Sekhemet",
        verb: "checkpointed",
        rest: typeof p.step === "number" ? `at step ${p.step}` : "",
        tone: "neutral",
      };
    default:
      return {
        ...base,
        verb: humanize(event.type.replace(/\//g, " ")).toLowerCase(),
        tone: "neutral",
      };
  }
}

// ---------------------------------------------------------------------------
// Runs (§2.4.4)
// ---------------------------------------------------------------------------

export interface QueueEntryLike {
  cardId: string;
  attempt?: number;
  passed: boolean;
  accepted?: boolean;
  stopReason: string;
  turns: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

export interface RunLike {
  startedAt: string;
  model: string;
  managerModel?: string;
  entries: QueueEntryLike[];
  modelSwaps?: number;
  totalDurationMs: number;
}

export interface RunSummary {
  cards: number;
  firstTry: number;
  retried: number;
  passedAfterRetry: number;
  totalMs: number;
  failedMs: number;
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
  stops: { reason: string; label: string; tone: Tone; count: number }[];
  segments: {
    cardId: string;
    ms: number;
    share: number;
    tone: "pass" | "fail" | "parked";
    label: string;
  }[];
  overheadShare: number;
}

/** Everything the Runs scorecard shows, computed once and tested here. */
export function summarizeRun(run: RunLike): RunSummary {
  const entries = run.entries ?? [];
  const cards = new Set(entries.map((e) => e.cardId));
  const firstTry = entries.filter((e) => (e.attempt ?? 1) === 1 && e.passed).length;
  const retries = entries.filter((e) => (e.attempt ?? 1) > 1);
  const worked = entries.reduce((n, e) => n + e.durationMs, 0);
  const totalMs = Math.max(run.totalDurationMs ?? 0, worked);
  const failedMs = entries.filter((e) => !e.passed).reduce((n, e) => n + e.durationMs, 0);
  const promptTokens = entries.reduce((n, e) => n + e.promptTokens, 0);
  const completionTokens = entries.reduce((n, e) => n + e.completionTokens, 0);
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.stopReason, (counts.get(e.stopReason) ?? 0) + 1);
  const stops = [...counts]
    .map(([reason, count]) => {
      const l = stopReasonLabel(reason);
      return { reason, label: l.short, tone: l.tone, count };
    })
    .sort((a, b) =>
      a.reason === "gate_passed" ? -1 : b.reason === "gate_passed" ? 1 : b.count - a.count,
    );
  const segments = entries.map((e) => {
    const tone = e.passed
      ? ("pass" as const)
      : stopReasonLabel(e.stopReason).tone === "parked"
        ? ("parked" as const)
        : ("fail" as const);
    return {
      cardId: e.cardId,
      ms: e.durationMs,
      share: totalMs > 0 ? e.durationMs / totalMs : 0,
      tone,
      label: stopReasonLabel(e.stopReason).short,
    };
  });
  const used = segments.reduce((n, s) => n + s.share, 0);
  return {
    cards: cards.size,
    firstTry,
    retried: retries.length,
    passedAfterRetry: retries.filter((e) => e.passed).length,
    totalMs,
    failedMs,
    promptTokens,
    completionTokens,
    tokensPerSecond: totalMs > 0 ? completionTokens / (totalMs / 1000) : 0,
    stops,
    segments,
    overheadShare: Math.max(0, 1 - used),
  };
}

// ---------------------------------------------------------------------------
// Steps (§2.4.3) and machine checks (§2.4.6)
// ---------------------------------------------------------------------------

function callKey(c: CallLike): string {
  return `${c.name}|${c.target ?? ""}`;
}

/**
 * Where loop detection fired: the run of trailing steps that repeat actions
 * without changing a file. Returns 1-based turn numbers, or null.
 */
export function loopRange(
  steps: (StepLike & { stopReason?: string })[],
): { from: number; to: number; lastChange?: number; repeated: string } | null {
  const last = steps.at(-1);
  if (!last || last.stopReason !== "oscillation_detected") return null;
  const edits = (s: StepLike) =>
    (s.calls ?? []).some((c) => /write|edit|create|patch|replace/.test(c.name));
  let lastChangeIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s && edits(s)) {
      lastChangeIdx = i;
      break;
    }
  }
  // The loop is the tail after the last edit; if every step edits the same
  // file identically, the whole tail repeating the final signature is it.
  const sig = (s: StepLike) => (s.calls ?? []).map(callKey).join(",");
  const tailSig = sig(last);
  let fromIdx = steps.length - 1;
  while (fromIdx > 0 && sig(steps[fromIdx - 1] as StepLike) === tailSig) fromIdx--;
  if (lastChangeIdx >= 0 && lastChangeIdx < fromIdx) fromIdx = Math.min(fromIdx, lastChangeIdx + 1);
  const repeated =
    [...new Set((last.calls ?? []).map((c) => callPhrase(c)))].join(" and ") || "the same step";
  return {
    from: steps[fromIdx]?.turn ?? last.turn,
    to: last.turn,
    ...(lastChangeIdx >= 0 ? { lastChange: steps[lastChangeIdx]?.turn as number } : {}),
    repeated,
  };
}

/** A plain fix for a health check that is not passing. */
export function checkFixHint(name: string, status: string, detail = ""): string | undefined {
  if (status === "pass") return undefined;
  switch (name) {
    case "Skills registry":
      return "Create .sekhemet/skills/ to load skills.";
    case "Local inference socket":
      return status === "fail"
        ? "Start Ollama or llama-server, then re-run the checks."
        : "Pull or load a Coding model so the agent has one to use.";
    case "Sandbox confinement":
      return /WROTE OUTSIDE/.test(detail)
        ? "Stop: the sandbox let a command write outside its worktree. Do not run cards until this passes."
        : "Commands run unconfined on this system. Use restricted mode only where confinement exists.";
    case "Git worktree isolation":
      return "Run Sekhemet from inside a git repository with at least one commit.";
    case "Unified memory":
      return "Close other apps or unload an idle model. Cards resume below 85% memory.";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Published tables
// ---------------------------------------------------------------------------

/** A stop reason's row as the dashboard reads it: its class and next action (worker-loop rule 31). */
export interface StopReasonTableRow {
  class: string;
  nextAction: string;
}

/**
 * The label tables, published as `/vocab.json` for plugin panels. The stop
 * reasons, their classes and next actions come from the kernel's one
 * stop-reason table (`STOP_REASONS`, WL-T3-9), passed in by the server: this
 * module has no runtime imports, and keeps no list of reasons of its own.
 */
export function vocabularyTables(
  stopTable: Readonly<Record<string, StopReasonTableRow>>,
): Record<string, unknown> {
  const stops = Object.keys(stopTable);
  return {
    types: ISSUE_TYPE_LABELS,
    columns: Object.fromEntries(
      BOARD_COLUMN_ORDER.map((s) => [s, { label: columnLabel(s), empty: COLUMN_EMPTY[s] }]),
    ),
    columnOrder: BOARD_COLUMN_ORDER,
    gates: GATE_LABELS,
    gateStates: GATE_STATE_LABELS,
    stopReasons: Object.fromEntries(
      stops.map((r) => [
        r,
        {
          ...stopReasonLabel(r),
          class: stopTable[r]?.class,
          nextAction: stopTable[r]?.nextAction,
        },
      ]),
    ),
    stopClasses: Object.fromEntries(stops.map((r) => [r, stopTable[r]?.class])),
    actors: ACTOR_LABELS,
  };
}

/** `oscillation_detected` -> `Oscillation detected`. The fallback for unknown enums. */
export function humanize(value: string): string {
  const text = String(value ?? "")
    .replace(/([a-z])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/[_-]+/g, " ")
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
