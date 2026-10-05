import {
  type OvernightVerdict,
  overnightVerdict,
  parseSettingsText,
  settingsWords,
} from "@sekhemet/eval";
import type { CardRecord, CardStore, EventLog, EventRecord } from "@sekhemet/kernel";
import { MODEL_ROLES } from "@sekhemet/models";
import { EstimationModel } from "@sekhemet/planner";
import { sprintDaysLeft, stopReasonLabel } from "@sekhemet/ui";
import type { Audience } from "./audience.js";
import { namedDecisions } from "./decisions.js";
import { burnupFromEvents } from "./metrics.js";
import type { Cycle } from "./types.js";

/**
 * Seshat's one standup (planner-pm §2.7.8, PM-P6-3, -14): the same builder
 * for the chat (`/status`, "standup?"), the daily standup the notifier posts
 * to Slack and push, and the CLI's answer. *Done* holds only the issues done
 * since the person's previous standup; *Next up* the Ready issues in the
 * order the queue will take them, each with its estimate's range and basis;
 * an overnight benchmark finished since then is said in plain words, and so
 * is a Find best settings run (measurement MS-N7-6). The
 * text is plain (§2.8.9): issues by title, checks and stops in the words a
 * person reads, never a stop code or an id in backticks.
 */

/** The ledger event marking a standup given in the chat (the notifier's `pm/notify` marks its own). */
export const STANDUP_GIVEN = "pm/standup_given";

export interface StandupItem {
  id: string;
  title: string;
}

/** What one standup says, gathered from the ledger for one person (`standupFacts`). */
export interface StandupFacts {
  /** When this person's previous standup was given; the last 24 hours when none was. */
  since?: string;
  done: StandupItem[];
  inFlight: (StandupItem & { step?: number; budget?: number })[];
  review: (StandupItem & { waitingHours?: number })[];
  /** Each decision waiting, naming its person, in plain words (PM-N9-5). */
  decisions: string[];
  /** Issues stopped short, with the stop in a person's words. */
  stopped: (StandupItem & { why: string })[];
  /** The next Ready issues in the queue's order, each with its estimate. */
  next: (StandupItem & { estimate?: string })[];
  /** The active sprint's pace: "Sprint 12: 13 of 21 points done, 4 days left." */
  sprint?: string;
  /** An overnight benchmark finished since the previous standup (PM-P6-14). */
  benchmark?: string;
  /** Each Find best settings run finished since then, in plain words (MS-N7-6). */
  settings?: string[];
  /** "Based on: board at 09:02 · ledger #212." */
  basedOn?: string;
}

/** A card's title as a person reads it: the planner's SPIDR suffix dropped. */
export function plainTitle(c: Pick<CardRecord, "title">): string {
  return c.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");
}

const hours = (h: number) =>
  h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h * 10) / 10}h`;

const joinList = (xs: readonly string[]) => xs.join("; ");

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Sep 27, 09:00": a standup's time as a person reads it. */
function when(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const month = d.toLocaleString("en-US", { month: "short" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${month} ${d.getDate()}, ${hh}:${mm}`;
}

/**
 * The standup's lines, in the three-heading shape (§2.8.2, *Done · In
 * flight · Needs you*) and then *Next up*. `extra` lines (the forecast, the
 * requirements, the checks nothing enforces) come after them, before the
 * benchmark and the basis.
 */
export function standupLines(f: StandupFacts, extra: readonly string[] = []): string[] {
  const needs = f.review.length + f.decisions.length + f.stopped.length;
  const since = f.since ? `Since the last standup (${when(f.since)})` : "Since yesterday";
  const lines = [
    `${since}: ${count(f.done.length, "issue")} done, ${needs} waiting on you, ${count(f.inFlight.length, "issue")} in flight.`,
  ];
  lines.push(
    f.done.length
      ? `Done: ${joinList(f.done.map((c) => c.title))}.`
      : `Done: nothing since ${f.since ? "the last standup" : "yesterday"}.`,
  );
  lines.push(
    f.inFlight.length
      ? `In flight: ${joinList(
          f.inFlight.map((c) =>
            c.step !== undefined && c.budget
              ? `${c.title} (step ${c.step} of ${c.budget})`
              : c.title,
          ),
        )}.`
      : "In flight: nothing is running.",
  );
  const needsYou = [
    ...f.review.map(
      (c) =>
        `${c.title} waits for your review${c.waitingHours !== undefined ? ` (${hours(c.waitingHours)})` : ""}`,
    ),
    ...f.decisions.map((d) => d.replace(/[.\s]+$/, "")),
    ...f.stopped.map((c) => `${c.title} stopped: ${c.why}`),
  ];
  lines.push(needsYou.length ? `Needs you: ${joinList(needsYou)}.` : "Needs you: nothing.");
  if (f.next.length) {
    lines.push(
      `Next up: ${f.next.map((c) => (c.estimate ? `${c.title} (${c.estimate})` : c.title)).join(", then ")}.`,
    );
  }
  if (f.sprint) lines.push(f.sprint);
  lines.push(...extra.filter(Boolean));
  if (f.benchmark) lines.push(f.benchmark);
  if (f.settings) lines.push(...f.settings);
  if (f.basedOn) lines.push(f.basedOn);
  return lines;
}

/** The issues a standup names, for the chat's links to them (§2.7.8: each line a linked card). */
export function standupCardIds(f: StandupFacts): string[] {
  return [
    ...new Set([...f.done, ...f.inFlight, ...f.review, ...f.stopped, ...f.next].map((c) => c.id)),
  ];
}

/**
 * Facts for a standup without the ledger (a snapshot built by hand): the
 * board's columns only, nothing known as done since a previous standup.
 */
export function boardOnlyFacts(cards: readonly CardRecord[]): StandupFacts {
  const item = (c: CardRecord): StandupItem => ({ id: c.id, title: plainTitle(c) });
  const by = (s: string) => cards.filter((c) => c.status === s);
  return {
    done: [],
    inFlight: [...by("in_progress"), ...by("verify")].map((c) => ({
      ...item(c),
      step: c.stepsUsed,
      budget: c.stepBudget,
    })),
    review: by("review").map(item),
    decisions: [],
    stopped: stoppedCards(cards).map((c) => ({ ...item(c), why: stopWords(c) })),
    next: [...by("ready")]
      .sort((a, b) => (a.priority || 9) - (b.priority || 9))
      .slice(0, 3)
      .map(item),
  };
}

/** Issues stopped short of passing, not running again, and not done. */
export function stoppedCards(cards: readonly CardRecord[]): CardRecord[] {
  return cards.filter(
    (c) =>
      c.stopReason &&
      c.stopReason !== "gate_passed" &&
      !["done", "rejected", "in_progress", "verify"].includes(c.status),
  );
}

/** A card's stop as a person reads it (DEC-31): "Out of steps", never `budget_exhausted`. */
export function stopWords(c: Pick<CardRecord, "stopReason">): string {
  return stopReasonLabel(c.stopReason).short;
}

/** Every event of these types, page by page, so a long ledger is never cut short. */
export async function allEvents(log: EventLog, types: string[]): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  for (let from = 1; ; ) {
    const page = await log.getEventsByTypes(types, from, 10_000);
    out.push(...page);
    if (page.length < 10_000) break;
    from = (page[page.length - 1]?.seq ?? from) + 1;
  }
  return out;
}

/**
 * When this person's previous standup was given: in the chat
 * (`pm/standup_given`) or by a channel that sent it (`pm/notify`, kind
 * standup, ok). Undefined when none was.
 */
export async function previousStandup(
  log: EventLog,
  person: string,
): Promise<{ at: string; seq: number } | undefined> {
  let last: { at: string; seq: number } | undefined;
  for (const e of await allEvents(log, [STANDUP_GIVEN, "pm/notify"])) {
    const p = (e.payload ?? {}) as { to?: string; kind?: string; ok?: boolean };
    if (p.to !== undefined && p.to !== person) continue;
    if (e.type === "pm/notify" && !(p.kind === "standup" && p.ok)) continue;
    if (!last || e.seq > last.seq) last = { at: e.createdAt, seq: e.seq };
  }
  return last;
}

/** Record that a standup was given to this person in the chat, so the next one starts after it. */
export async function recordStandupGiven(log: EventLog, person: string): Promise<void> {
  await log.append({ actor: "harness", type: STANDUP_GIVEN, payload: { to: person } });
}

/**
 * The project's estimation unit (Preferences → Estimation, DEC-31, DB-N7-2):
 * points only when every project the cards belong to is set to story points;
 * issues otherwise, the default.
 */
export async function estimationUnit(
  log: EventLog,
  projects: readonly (string | undefined)[],
): Promise<"points" | "issues"> {
  const settings = new Map<string, string>();
  for (const e of await allEvents(log, ["project/settings_changed"])) {
    const p = (e.payload ?? {}) as { project?: string; estimation?: string };
    if (p.project && typeof p.estimation === "string") settings.set(p.project, p.estimation);
  }
  const ids = [...new Set(projects.filter((p): p is string => !!p))];
  if (ids.length === 0)
    return settings.size > 0 && [...settings.values()].every((v) => v === "points")
      ? "points"
      : "issues";
  return ids.every((id) => settings.get(id) === "points") ? "points" : "issues";
}

/** A Ready issue's estimate, as a range with its basis (planner-pm rule 3). */
function estimateOf(model: EstimationModel, c: CardRecord): string {
  const e = model.estimate({
    tier: c.tier,
    labels: c.labels,
    difficulty: c.difficulty ?? 5,
    basePackTokens: 2_000,
    stepBudget: c.stepBudget,
  });
  const lo = Math.max(1, Math.round(e.secondsRange[0] / 60));
  const hi = Math.max(lo, Math.round(e.secondsRange[1] / 60));
  const basis =
    e.basis.kind === "measured"
      ? `from ${count(e.basis.samples ?? 0, "finished issue")}`
      : "a prior, nothing measured yet";
  return `${lo}-${hi} min, ${basis}`;
}

/** The active sprint's pace in plain words, from the burn-up (B4.6). */
function sprintPace(
  cycles: readonly Cycle[],
  events: readonly EventRecord[],
  now: Date,
  unit: "points" | "issues",
  canSee?: (project: string | undefined) => boolean,
): string | undefined {
  const today = now.toISOString().slice(0, 10);
  const active =
    cycles.find((c) => c.state === "active") ??
    cycles.find((c) => c.state !== "closed" && c.startsOn <= today && today <= c.endsOn);
  if (!active) return undefined;
  const b = burnupFromEvents(events, {
    cycle: active,
    now,
    unit,
    ...(canSee ? { canSee } : {}),
  });
  const last = b.days.at(-1);
  if (!last || last.scope === 0) return undefined;
  // STA-01: the board's and Status's count, today included.
  const left = sprintDaysLeft(active, now.getTime());
  const word = unit === "points" ? "points" : "issues";
  return `${active.name}: ${last.done} of ${last.scope} ${word} done, ${count(left, "day")} left.`;
}

const ROLE_WORDS: Record<string, string> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/** Where a person assigns models (dashboard §2.16): the only place a model id appears. */
export const CONFIGURATION_MODELS = "#/configuration/models";

/** A combination as a link to Configuration: its model ids appear only inside it (PM-P6-14). */
function combinationLink(models: Record<string, string>): string {
  const text = MODEL_ROLES.filter((r) => models[r])
    .map((r) => {
      const settings = models[`${r}.settings`];
      return `${ROLE_WORDS[r]} ${models[r]}${settings ? ` (${settingsWords(parseSettingsText(settings))})` : ""}`;
    })
    .join(" · ");
  return `[${text}](${CONFIGURATION_MODELS})`;
}

/** What a person does to use a benchmark's result: the Configuration action (PM-P6-14). */
export const APPLY_BENCHMARK_ACTION =
  "open Configuration › Models, choose the model for each role and select Assign";

/** An overnight benchmark's verdict in plain words for the standup (PM-P6-14). */
export function benchmarkLine(v: OvernightVerdict): string {
  const stopped =
    v.reason === "done"
      ? "finished"
      : v.reason === "person"
        ? "was stopped by a person"
        : "stopped at the window's end and resumes tonight";
  const [first] = v.leading;
  const result =
    v.outcome === "best" && first
      ? `${combinationLink(first)} did best on the Coding model's issues.`
      : v.outcome === "only_one" && first
        ? `it measured one combination, ${combinationLink(first)}, so there was nothing to compare.`
        : `there is no clear difference between the leading combinations: ${v.leading.map(combinationLink).join(" and ")}.`;
  return `Overnight benchmark (${stopped}): ${result} The benchmark assigned nothing; to use a result, ${APPLY_BENCHMARK_ACTION}.`;
}

/** Where a person applies a Find best settings result (dashboard §2.16 item 2). */
export const APPLY_SETTINGS_ACTION = "open Configuration › Benchmark and select Apply";

/**
 * A Find best settings run in plain words (measurement MS-N7-6): *the best
 * combination is …*, or *no clear difference*; never a model id, which
 * appears only on Configuration (PM-P6-14).
 */
export function settingsTunedLine(t: {
  role: string;
  model: string;
  verdict: string;
  adopted?: Readonly<Record<string, unknown>>;
  comparison?: { better: number; worse: number; ties: number; p: number };
}): string {
  const who = `Find best settings for the ${ROLE_WORDS[t.role] ?? t.role}`;
  const n = t.comparison ? t.comparison.better + t.comparison.worse + t.comparison.ties : 0;
  const words = settingsWords(t.adopted ?? {});
  switch (t.verdict) {
    case "best":
      return `${who}: the best combination is ${words} (higher on ${t.comparison?.better ?? 0} of ${n} ${t.role === "reviewer" ? "seeded defects" : "issues"}, p = ${(t.comparison?.p ?? 1).toFixed(3)}). Nothing was changed; to use it, ${APPLY_SETTINGS_ACTION}.`;
    case "cheaper":
      return `${who}: no clear difference in quality, and ${words} was faster (not established). Nothing was changed; to use it, ${APPLY_SETTINGS_ACTION}.`;
    case "partial":
      return `${who}: stopped before a verdict; what it measured is kept.`;
    default:
      return `${who}: no clear difference between the settings tried; the current settings stay, and the overnight benchmark can settle it.`;
  }
}

/**
 * The facts of one person's standup from the ledger (PM-P6-3, -14): the
 * issues done since their previous standup, what is in flight and needs
 * them, the next issues in the queue's order, the sprint's pace and an
 * overnight benchmark finished since then. Only the issues in `cards` —
 * those the person can see (PM-N9-8) — are named or counted.
 */
export async function standupFacts(deps: {
  repoPath: string;
  cardStore: CardStore;
  log: EventLog;
  cards: readonly CardRecord[];
  cycles: readonly Cycle[];
  audience: Audience;
  person: string;
  asker?: string | undefined;
  /** Whether `cards` is every card (no project hidden from the person). */
  whole: boolean;
  now?: Date;
}): Promise<StandupFacts> {
  const now = deps.now ?? new Date();
  const visible = new Map(deps.cards.map((c) => [c.id, c]));
  const item = (c: CardRecord): StandupItem => ({ id: c.id, title: plainTitle(c) });
  const previous = await previousStandup(deps.log, deps.person);
  const since = previous?.at;
  const from = since ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();
  // After the previous standup by the ledger's order; without one, the last 24 hours.
  const after = (e: EventRecord) => (previous ? e.seq > previous.seq : e.createdAt > from);
  const cardEvents = await allEvents(deps.log, [
    "card/created",
    "card/status_changed",
    "card/updated",
  ]);
  // Done since the previous standup: moved into Done after it, and still there.
  const done: StandupItem[] = [];
  const reviewSince = new Map<string, string>();
  for (const e of cardEvents) {
    if (e.type !== "card/status_changed") continue;
    const p = (e.payload ?? {}) as { id?: string; toStatus?: string };
    const id = p.id ?? e.cardId ?? "";
    const c = visible.get(id);
    if (!c) continue;
    if (p.toStatus === "review") reviewSince.set(id, e.createdAt);
    if (p.toStatus === "done" && after(e) && c.status === "done") {
      if (!done.some((d) => d.id === id)) done.push(item(c));
    }
  }
  const by = (s: string) => deps.cards.filter((c) => c.status === s);
  const decisions = await namedDecisions(
    { cardStore: deps.cardStore, log: deps.log },
    deps.audience,
    deps.asker,
    { plain: true },
  ).catch(() => []);
  // The next issues in the order the queue takes them (wave2 `orderForQueue`).
  const ready = by("ready").filter((c) => c.tier === "story" || c.tier === "task");
  const { orderForQueue, topGoalEpic } = await import("../wave2.js");
  const ledger = { store: deps.cardStore, log: deps.log };
  const epic = await topGoalEpic(ledger, deps.cards).catch(() => undefined);
  const ordered = ready.length ? orderForQueue(deps.repoPath, ready, epic, now).ordered : [];
  const estimator = EstimationModel.fromCards(deps.cards);
  const unit = await estimationUnit(
    deps.log,
    deps.cards.map((c) => c.projectId),
  );
  const canSee = deps.whole
    ? undefined
    : (project: string | undefined) => deps.cards.some((c) => c.projectId === project);
  const sprint = sprintPace(deps.cycles, cardEvents, now, unit, canSee);
  const verdict = await overnightVerdict(deps.log, { since: Date.parse(from) }).catch(
    () => undefined,
  );
  // MS-N7-6: each Find best settings run finished since the previous standup.
  const tuned = (await deps.log.getEventsByTypes(["measure/settings_tuned"]).catch(() => []))
    .filter((e) => after(e) && (e.payload as { kind?: string }).kind === "find_best")
    .map((e) =>
      settingsTunedLine(
        e.payload as {
          role: string;
          model: string;
          verdict: string;
          adopted?: Record<string, unknown>;
          comparison?: { better: number; worse: number; ties: number; p: number };
        },
      ),
    );
  const last = await deps.log.getLastEvent();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return {
    ...(since ? { since } : {}),
    done,
    inFlight: [...by("in_progress"), ...by("verify")].map((c) => ({
      ...item(c),
      step: c.stepsUsed,
      budget: c.stepBudget,
    })),
    review: by("review").map((c) => {
      const at = reviewSince.get(c.id);
      return {
        ...item(c),
        ...(at ? { waitingHours: (now.getTime() - Date.parse(at)) / 3_600_000 } : {}),
      };
    }),
    decisions,
    stopped: stoppedCards(deps.cards).map((c) => ({ ...item(c), why: stopWords(c) })),
    next: ordered.slice(0, 3).map((c) => ({ ...item(c), estimate: estimateOf(estimator, c) })),
    ...(sprint ? { sprint } : {}),
    ...(verdict ? { benchmark: benchmarkLine(verdict) } : {}),
    ...(tuned.length ? { settings: tuned } : {}),
    basedOn: `Based on: the board at ${hh}:${mm}${last ? ` and Activity log entry ${last.seq}` : ""}.`,
  };
}
