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
// Kinds (the SPIDR slice, renamed for people)
// ---------------------------------------------------------------------------

export type CardKind = "contract" | "storage" | "flow" | "rules" | "research" | "ui" | "wiring";

export const KIND_LABELS: Record<CardKind, { label: string; tooltip: string }> = {
  contract: { label: "Contract", tooltip: "Defines types and interfaces before behaviour." },
  storage: { label: "Storage", tooltip: "Persists or shapes data." },
  flow: { label: "Flow", tooltip: "Implements a working path end to end." },
  rules: { label: "Rules", tooltip: "Adds validation, invariants or edge cases." },
  research: { label: "Research", tooltip: "Removes an unknown; produces notes and a probe test." },
  ui: { label: "UI", tooltip: "Builds something a person sees." },
  wiring: { label: "Wiring", tooltip: "Connects finished parts." },
};

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

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as CardKind]?.label ?? humanize(kind);
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

const COLUMN_LABELS: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  planning: "Planning",
  in_progress: "Working",
  verify: "Checking",
  review: "Review",
  done: "Done",
  parked: "Parked",
  rejected: "Closed",
};

/** What an empty column is for, shown at its top instead of "No cards". */
export const COLUMN_EMPTY: Record<CardStatus, string> = {
  backlog: "Ideas and split-off work.",
  ready: "Cards whose dependencies are done.",
  planning: "The Planner is writing plans and tests.",
  in_progress: "No Worker running.",
  verify: "Nothing being checked.",
  review: "Nothing waiting for you.",
  done: "Accepted cards appear here.",
  parked: "Nothing parked.",
  rejected: "Nothing closed.",
};

export function columnLabel(status: string): string {
  return COLUMN_LABELS[status as CardStatus] ?? humanize(status);
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

const ACTOR_LABELS: Record<string, string> = {
  executor: "Worker",
  worker: "Worker",
  planner: "Planner",
  manager: "Planner",
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

export type GateState = "pass" | "fail" | "skipped" | "not_run" | "running";

export const GATE_STATE_LABELS: Record<GateState, string> = {
  pass: "Passed",
  fail: "Failed",
  skipped: "Skipped",
  not_run: "Not run",
  running: "Running",
};

/** SHA-256 of the empty string: what an absent gates.toml hashes to. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function isEmptyGateContract(sha: string | undefined): boolean {
  return sha === EMPTY_SHA256;
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "running" | "pass" | "fail" | "parked" | "blocked";

export interface StopReasonContext {
  /** The step the attempt stopped on. */
  step?: number;
  stepBudget?: number;
  repairs?: number;
  memoryPercent?: number;
}

/** Why an attempt stopped: a short label, a sentence, and the tone it carries. */
export function stopReasonLabel(
  reason: string | undefined,
  ctx: StopReasonContext = {},
): { short: string; sentence: string; tone: Tone } {
  switch (reason) {
    case "gate_passed":
      return {
        short: "Passed",
        sentence: ctx.step ? `All gates passed on step ${ctx.step}.` : "All gates passed.",
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
          ? `Tried ${ctx.repairs} repairs; the same gate kept failing.`
          : "Tried every repair; the same gate kept failing.",
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
        sentence: "Sekhemet failed, not the Worker. See the ledger entry.",
        tone: "fail",
      };
    case "scope_violation":
      return {
        short: "Out of scope",
        sentence: "Tried to edit a file this card may not touch.",
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
    default:
      return reason
        ? { short: humanize(reason), sentence: `Stopped: ${humanize(reason)}.`, tone: "neutral" }
        : { short: "Not run", sentence: "This card has not run yet.", tone: "neutral" };
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
    const state: GateState = !r ? "not_run" : r.skipped ? "skipped" : r.passed ? "pass" : "fail";
    const mine = state === "fail" ? failuresOf(id, rung ?? r?.rung) : [];
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
  const failed = (gates ?? gateSummary(evidence))
    .filter((g) => g.state === "fail")
    .map((g) => g.label);
  const stop = stopReasonLabel(evidence.stopReason);
  const head = failed.length ? `Failed ${joinWords(failed)}` : "Failed";
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
  /** `8 of 32 steps`, only once the card has started. */
  budgetText?: string;
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
}

/** The one line that states a card's current truth, in words (§2.5.1 row 3). */
export function statusLine(
  card: Pick<CardRecord, "status" | "stepsUsed" | "stepBudget">,
  ctx: DisplayContext = {},
): { text: string; tone: Tone; mark: StatusMark } {
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
      return { text: `Backlog · ${budget}`, tone: "neutral", mark: "none" };
    case "ready":
      if (/^returned:/.test(ctx.statusReason ?? "")) {
        return { text: "Sent back with your note", tone: "neutral", mark: "none" };
      }
      if (ev && !ev.passed) return { text: `${failText} · will retry`, tone: "fail", mark: "fail" };
      return { text: `Ready · ${budget}`, tone: "neutral", mark: "none" };
    case "planning":
      return { text: "Planner is writing the plan", tone: "neutral", mark: "planning" };
    case "in_progress":
      return card.stepsUsed > 0
        ? { text: `Step ${card.stepsUsed} of ${card.stepBudget}`, tone: "running", mark: "running" }
        : { text: `Starting · ${budget}`, tone: "running", mark: "running" };
    case "verify":
      if (!ev) return { text: "Running gates…", tone: "running", mark: "running" };
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
        text: since !== undefined ? `Accepted · ${formatWait(since)} ago` : "Accepted",
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
      return { text: "Closed", tone: "neutral", mark: "none" };
    default:
      return { text: columnLabel(card.status), tone: "neutral", mark: "none" };
  }
}

/** Everything the board and the review queue show about a card, derived once. */
export function describeCard(card: CardRecord, ctx: DisplayContext = {}): CardDisplay {
  const { title, kinds } = parseTitle(card.title);
  const line = statusLine(card, ctx);
  const ev = ctx.evidence;
  const started = card.stepsUsed > 0 && card.status !== "done";
  const display: CardDisplay = {
    title,
    kinds,
    shortId: shortId(card.id),
    stateLabel: columnLabel(card.status),
    statusLine: line.text,
    tone: line.tone,
    mark: line.mark,
    needsYou:
      card.status === "parked" || (card.status === "verify" && ev !== undefined && !ev.passed),
  };
  if (ev?.stopReason) display.stopLabel = stopReasonLabel(ev.stopReason).short;
  if (ctx.enteredColumnAt) display.enteredColumnAt = ctx.enteredColumnAt;
  if (ctx.waitsOn && ctx.waitsOn.length > 0) display.waitsOn = ctx.waitsOn;
  if (started) {
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
// Published tables
// ---------------------------------------------------------------------------

/** The label tables, published as `/vocab.json` for plugin panels. */
export function vocabularyTables(): Record<string, unknown> {
  const stops = [
    "gate_passed",
    "budget_exhausted",
    "oscillation_detected",
    "no_progress",
    "repair_exhausted",
    "memory_pressure",
    "quota_suspended",
    "error",
    "scope_violation",
    "capability_ceiling",
    "human_abort",
  ];
  return {
    kinds: KIND_LABELS,
    columns: Object.fromEntries(
      BOARD_COLUMN_ORDER.map((s) => [s, { label: columnLabel(s), empty: COLUMN_EMPTY[s] }]),
    ),
    columnOrder: BOARD_COLUMN_ORDER,
    gates: GATE_LABELS,
    gateStates: GATE_STATE_LABELS,
    stopReasons: Object.fromEntries(stops.map((r) => [r, stopReasonLabel(r)])),
    actors: ACTOR_LABELS,
  };
}

/** `oscillation_detected` -> `Oscillation detected`. The fallback for unknown enums. */
export function humanize(value: string): string {
  const text = String(value ?? "")
    .replace(/[_-]+/g, " ")
    .trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}
