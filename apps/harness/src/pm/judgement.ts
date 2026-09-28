import {
  type CardRecord,
  type CardStore,
  type EventLog,
  type EventRecord,
  STOP_REASONS,
} from "@sekhemet/kernel";
import {
  type CapabilityModel,
  type CapabilityVerdict,
  HORIZON_PASS,
  capabilityModelOf,
  capabilityVerdict,
} from "@sekhemet/planner";
import type { ProposalDraft } from "./agent.js";
import { cardsNamed } from "./knowledge.js";
import { burnupFromEvents, flowMetrics } from "./metrics.js";
import { SPLIT_BY_CRITERIA_COPY, splitNotRetrySummary, sprintBetSummary } from "./pm_copy.js";
import {
  APPLY_BENCHMARK_ACTION,
  allEvents,
  estimationUnit,
  plainTitle,
  stopWords,
  stoppedCards,
} from "./standup.js";
import type { Cycle, PmCite } from "./types.js";

/**
 * Seshat's judgement, made by code from the ledger (planner-pm P6, §2.8.2,
 * §2.8.10): what is at risk and what is not (PM-P6-7), the next sprint's bet
 * sized to 85% of the last three sprints (PM-P6-8), a split — never a retry —
 * for an issue over the Coding model's 80% size horizon (PM-P6-9), and the
 * Configuration action that applies a benchmark's result (PM-P6-14). The
 * small local Planning model gets the same rules in its skill; these answers
 * and the guard on its proposals (`guardProposals`) hold whatever it writes.
 * Seshat proposes; a person decides (DEC-36).
 */

export type JudgementQuestion = "at_risk" | "plan_sprint" | "retry" | "apply_benchmark";

/** A question Seshat's judgement answers from the ledger, or undefined. */
export function judgementQuestion(text: string): JudgementQuestion | undefined {
  const t = text.trim();
  // The board's question, whole ("what's at risk?"); one about a named thing
  // ("anything at risk in the cart?") is a judgement for the model.
  if (
    /^(?:so\s+)?(?:what(?:'s|’s| is| are)?|which (?:issues|things) are|is anything|anything|are any (?:issues|things))\s+(?:currently\s+|now\s+)?at[- ]risk(?:\s+(?:now|today|right now|this sprint))?\s*[?.!]*$/i.test(
      t,
    ) ||
    /^(?:risks?|at[- ]risk)\s*\??$/i.test(t)
  )
    return "at_risk";
  if (
    /\bplan\b[^?]*\b(?:next|new|upcoming|coming)\s+(?:sprint|cycle|iteration)\b/i.test(t) ||
    /\b(?:size|bet (?:on|for)?)\b[^?]*\b(?:next|new)\s+(?:sprint|cycle)\b/i.test(t)
  )
    return "plan_sprint";
  if (
    /\b(?:apply|use|switch to|assign|adopt|take)\b[^?]*\b(?:benchmark(?:'s)?|best combination|winning combination|winner)\b/i.test(
      t,
    )
  )
    return "apply_benchmark";
  if (/\b(?:retry|re-?run|try (?:it|this|that) again|run (?:it|this|that) again)\b/i.test(t))
    return "retry";
  return undefined;
}

/** What a judgement answer says and proposes. */
export interface JudgementAnswer {
  text: string;
  proposals: ProposalDraft[];
  cites: PmCite[];
}

const FROM_LEDGER = "\n\n_Answered from the ledger without loading a model._";

const hours = (h: number) =>
  h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : `${Math.round(h * 10) / 10}h`;

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// --- PM-P6-7: at risk, with the basis, and what is not ---------------------

/** The 85th percentile of the finished issues' cycle times, and how many there were. */
function p85(hoursList: readonly number[]): { hours: number; n: number } | undefined {
  if (hoursList.length < 5) return undefined;
  const sorted = [...hoursList].sort((a, b) => a - b);
  const at = sorted[Math.min(sorted.length - 1, Math.ceil(0.85 * sorted.length) - 1)] ?? 0;
  return { hours: at, n: sorted.length };
}

/** A stop that is a pause, not a defect (the machine or a person stopped it): it resumes as it was. */
function isPause(c: CardRecord): boolean {
  const row = STOP_REASONS[c.stopReason as keyof typeof STOP_REASONS];
  return row?.class === "environment" || row?.class === "human_abort";
}

export interface RiskItem {
  card: CardRecord;
  basis: string;
}

/**
 * What is at risk and why, and what is not and why (PM-P6-7): an issue in
 * flight older than 85% of finished issues took, or one stopped short by a
 * defect (with how many attempts failed), is at risk; an issue in flight
 * under that mark, one paused rather than failed, or the next Ready issue
 * with nothing in its way, is not.
 */
export function atRisk(
  cards: readonly CardRecord[],
  flow: { cycleTime: { hours: number }[]; wipAge: { cardId: string; hours: number }[] },
  failedAttempts: ReadonlyMap<string, number>,
): { atRisk: RiskItem[]; notAtRisk: RiskItem[]; mark?: { hours: number; n: number } } {
  const mark = p85(flow.cycleTime.map((c) => c.hours));
  const age = new Map(flow.wipAge.map((w) => [w.cardId, w.hours]));
  const risky: RiskItem[] = [];
  const safe: RiskItem[] = [];
  const failed = (c: CardRecord) => failedAttempts.get(c.id) ?? 0;
  for (const c of cards.filter((x) => x.status === "in_progress" || x.status === "verify")) {
    const h = age.get(c.id);
    if (h === undefined || !mark) continue;
    if (h > mark.hours) {
      risky.push({
        card: c,
        basis: `open ${hours(h)}; 85% of finished issues took under ${hours(mark.hours)}${failed(c) ? `, and ${count(failed(c), "attempt")} failed` : ""}`,
      });
    } else {
      safe.push({
        card: c,
        basis: `open ${hours(h)}, under the ${hours(mark.hours)} that 85% of finished issues took`,
      });
    }
  }
  for (const c of stoppedCards(cards)) {
    if (isPause(c)) {
      safe.push({
        card: c,
        basis: `paused (${stopWords(c)}), not stopped by a defect; it resumes as it was`,
      });
      continue;
    }
    risky.push({
      card: c,
      basis: `stopped: ${stopWords(c)}${failed(c) ? `, after ${count(failed(c), "failed attempt")}` : ""}`,
    });
  }
  if (safe.length === 0) {
    const next = cards.find(
      (c) => c.status === "ready" && !stoppedCards([c]).length && (c.dependsOn ?? []).length === 0,
    );
    if (next) safe.push({ card: next, basis: "Ready, with nothing it waits on" });
  }
  return { atRisk: risky, notAtRisk: safe, ...(mark ? { mark } : {}) };
}

async function atRiskAnswer(
  deps: { cardStore: CardStore; log: EventLog },
  cards: readonly CardRecord[],
): Promise<JudgementAnswer> {
  const flow = await flowMetrics(deps.log, 90);
  const visible = new Set(cards.map((c) => c.id));
  const failedAttempts = new Map<string, number>();
  for (const o of deps.cardStore.runs.readAttemptOutcomes()) {
    if (!o.passed && visible.has(o.cardId))
      failedAttempts.set(o.cardId, (failedAttempts.get(o.cardId) ?? 0) + 1);
  }
  const r = atRisk(
    cards,
    // PM-N9-8: only the issues the asker can see are judged or counted.
    {
      cycleTime: flow.cycleTime.filter((c) => visible.has(c.cardId)),
      wipAge: flow.wipAge.filter((w) => visible.has(w.cardId)),
    },
    failedAttempts,
  );
  const name = (c: CardRecord) => plainTitle(c);
  const lines: string[] = [];
  if (r.atRisk.length === 0) lines.push("Nothing is at risk.");
  else {
    lines.push(`${r.atRisk.length === 1 ? "One thing" : `${r.atRisk.length} things`} at risk:`);
    r.atRisk.forEach((x, i) => lines.push(`${i + 1}. ${name(x.card)}: ${x.basis}.`));
  }
  lines.push(
    r.notAtRisk.length
      ? `Not at risk: ${r.notAtRisk
          .slice(0, 2)
          .map((x) => `${name(x.card)}, ${x.basis}`)
          .join("; ")}.`
      : "Not at risk: nothing else is in flight or Ready to call safe.",
  );
  lines.push(
    r.mark
      ? `Based on: the cycle times of ${count(r.mark.n, "finished issue")} and the board now.`
      : "Based on: the board now. Fewer than 5 issues have finished, so no issue's age is judged against the others yet.",
  );
  const named = [...r.atRisk, ...r.notAtRisk.slice(0, 2)].map((x) => ({ cardId: x.card.id }));
  return { text: `${lines.join("\n")}${FROM_LEDGER}`, proposals: [], cites: named };
}

// --- PM-P6-8: the next sprint's bet -----------------------------------------

/** The share of the recent mean a sprint's bet may take (planner-pm §2.8.2, PM-P6-8). */
export const SPRINT_BET_SHARE = 0.85;
/** How many closed sprints the bet averages. */
export const SPRINT_BET_WINDOW = 3;

export interface SprintCapacity {
  unit: "points" | "issues";
  /** The last closed sprints the mean is over, newest first, with what each completed. */
  basis: { cycle: Cycle; completed: number }[];
  mean: number;
  /** The largest bet: 85% of the mean, rounded down. */
  cap: number;
}

/**
 * What the next sprint may bet (PM-P6-8): 85% of the mean completed over
 * the last three closed sprints, in points — or in issues when the
 * project's estimation is off (Preferences, DEC-31). Undefined before any
 * sprint has closed: there is no basis yet.
 */
export async function sprintCapacity(
  log: EventLog,
  cycles: readonly Cycle[],
  cards: readonly CardRecord[],
  now = new Date(),
): Promise<SprintCapacity | undefined> {
  const closed = cycles
    .filter((c) => c.state === "closed")
    .sort((a, b) => b.endsOn.localeCompare(a.endsOn))
    .slice(0, SPRINT_BET_WINDOW);
  if (closed.length === 0) return undefined;
  const unit = await estimationUnit(
    log,
    cards.map((c) => c.projectId),
  );
  const events = await allEvents(log, ["card/created", "card/status_changed", "card/updated"]);
  // PM-N9-8: only the projects of the issues the asker can see are counted.
  const projects = new Set(cards.map((c) => c.projectId));
  const canSee = (project: string | undefined) => projects.has(project);
  const basis = closed.map((cycle) => ({
    cycle,
    completed: burnupFromEvents(events, { cycle, now, unit, canSee }).days.at(-1)?.done ?? 0,
  }));
  const mean = basis.reduce((n, b) => n + b.completed, 0) / basis.length;
  return { unit, basis, mean, cap: Math.floor(SPRINT_BET_SHARE * mean + 1e-9) };
}

/** An issue's size in the bet's unit: its points (1 when unestimated), or 1 issue. */
export function sizeIn(unit: "points" | "issues", c: Pick<CardRecord, "estimate">): number {
  return unit === "points" && typeof c.estimate === "number" && c.estimate > 0 ? c.estimate : 1;
}

/** The basis of a bet in words: "85% of the 21.3 points ... (Sprint 1: 20, ...)". */
export function capacityBasis(c: SprintCapacity): string {
  const mean = Math.round(c.mean * 10) / 10;
  const over =
    c.basis.length === SPRINT_BET_WINDOW
      ? `the last ${SPRINT_BET_WINDOW} sprints`
      : `the ${c.basis.length === 1 ? "one sprint" : `${c.basis.length} sprints`} closed so far`;
  const each = c.basis.map((b) => `${b.cycle.name}: ${b.completed}`).join(", ");
  return `${Math.round(SPRINT_BET_SHARE * 100)}% of the ${mean} ${c.unit} a sprint completed on average over ${over} (${each})${c.unit === "issues" ? "; estimation is off, so the bet counts issues" : ""}`;
}

/** The issues a bet takes, in order, until the next would pass the cap. */
export function fillBet(
  candidates: readonly CardRecord[],
  cap: number,
  unit: "points" | "issues",
): { in: CardRecord[]; out: CardRecord[]; size: number } {
  const taken: CardRecord[] = [];
  const left: CardRecord[] = [];
  let size = 0;
  for (const c of candidates) {
    const n = sizeIn(unit, c);
    if (size + n <= cap) {
      taken.push(c);
      size += n;
    } else left.push(c);
  }
  return { in: taken, out: left, size };
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

async function planSprintAnswer(
  deps: { repoPath: string; cardStore: CardStore; log: EventLog },
  cards: readonly CardRecord[],
  cycles: readonly Cycle[],
  now = new Date(),
): Promise<JudgementAnswer | undefined> {
  const cap = await sprintCapacity(deps.log, cycles, cards, now);
  // Before any sprint has closed there is no measured basis: the first
  // sprint is the Planning model's conversation with the person.
  if (!cap) return undefined;
  const open = new Set(cycles.filter((c) => c.state !== "closed").map((c) => c.id));
  const work = cards.filter(
    (c) =>
      (c.tier === "story" || c.tier === "task") &&
      (c.status === "ready" || c.status === "backlog") &&
      !(c.cycleId && open.has(c.cycleId)),
  );
  const { orderForQueue, topGoalEpic } = await import("../wave2.js");
  const epic = await topGoalEpic({ store: deps.cardStore, log: deps.log }, cards).catch(
    () => undefined,
  );
  const ready = orderForQueue(
    deps.repoPath,
    work.filter((c) => c.status === "ready"),
    epic,
    now,
  ).ordered;
  const backlog = work
    .filter((c) => c.status === "backlog")
    .sort((a, b) => (a.priority || 9) - (b.priority || 9));
  const bet = fillBet([...ready, ...backlog], cap.cap, cap.unit);
  const last = [...cycles].sort((a, b) => b.endsOn.localeCompare(a.endsOn))[0];
  const length = cap.basis[0]
    ? Math.max(
        1,
        Math.round(
          (Date.parse(cap.basis[0].cycle.endsOn) - Date.parse(cap.basis[0].cycle.startsOn)) /
            86_400_000,
        ),
      )
    : 14;
  const start = Math.max(
    Date.parse(day(now.getTime())),
    last ? Date.parse(last.endsOn) + 86_400_000 : 0,
  );
  const name = `Sprint ${cycles.length + 1}`;
  const startsOn = day(start);
  const endsOn = day(start + length * 86_400_000);
  const basis = capacityBasis(cap);
  const unitWord = cap.unit === "points" ? "points" : "issues";
  const sizeOf = (c: CardRecord) => (cap.unit === "points" ? ` (${sizeIn("points", c)})` : "");
  const lines = [
    `For ${name} I suggest betting ${bet.size} ${unitWord}, no more than ${cap.cap}: ${basis}.`,
    bet.in.length
      ? `In: ${bet.in.map((c) => `${plainTitle(c)}${sizeOf(c)}`).join(", ")}.`
      : `Nothing fits under ${cap.cap} ${unitWord}.`,
  ];
  if (bet.out.length)
    lines.push(
      `Out for now, over the bet: ${bet.out
        .slice(0, 5)
        .map((c) => `${plainTitle(c)}${sizeOf(c)}`)
        .join(", ")}.`,
    );
  lines.push("Applying the proposal plans the sprint; nothing changes until you do.");
  const proposals: ProposalDraft[] = bet.in.length
    ? [
        {
          kind: "create_cycle",
          patch: { name, startsOn, endsOn, cardIds: bet.in.map((c) => c.id) },
          why: basis,
          summary: sprintBetSummary(name, startsOn, endsOn, bet.size, unitWord, basis),
        },
      ]
    : [];
  return {
    text: `${lines.join("\n")}${FROM_LEDGER}`,
    proposals,
    cites: bet.in.map((c) => ({ cardId: c.id })),
  };
}

// --- PM-P6-9: split, never retry, over the size horizon ---------------------

/**
 * Whether an issue is over its kind's measured 80% size horizon (PM-P6-9):
 * its changed-line estimate is past the horizon at its difficulty, or the
 * fit reaches 80% at no size there (the horizon is below zero lines). A kind
 * with no fit (under 10 attempts, PM-N3-3) is never judged over it.
 */
export function overHorizon(
  model: CapabilityModel,
  card: Pick<CardRecord, "kind" | "difficulty">,
): CapabilityVerdict | undefined {
  const v = capabilityVerdict(model, {
    kind: card.kind ?? "implement",
    difficulty: card.difficulty ?? 5,
  });
  if (v.horizon !== undefined) return v.lines > v.horizon ? v : undefined;
  const k = model.kinds[card.kind ?? "implement"];
  const belowAtAnySize =
    !!k?.fit &&
    !k.rough &&
    v.predicted !== undefined &&
    v.predicted < HORIZON_PASS &&
    k.fit.lines < 0;
  return belowAtAnySize ? v : undefined;
}

/** Why an issue is split rather than retried, in a person's words (PM-P6-9). */
export function horizonWhy(v: CapabilityVerdict): string {
  return v.horizon !== undefined
    ? `about ${v.lines} changed lines is over the ${v.horizon} lines the Coding model passes 80% of the time for this kind of issue, and a retry does not change its size`
    : `at this difficulty the Coding model passes this kind of issue under 80% of the time at any size (about ${Math.round((v.predicted ?? 0) * 100)}% for about ${v.lines} changed lines), and a retry does not change that`;
}

/**
 * A split of an issue by its own criteria, when it has two or more: each
 * part carries only its half (planner-pm PM-P1-7), for the one pipeline to
 * plan when a person applies it. Undefined when the criteria cannot be cut.
 */
export function splitByCriteria(card: CardRecord, why: string): ProposalDraft | undefined {
  const criteria = card.acceptanceCriteria ?? [];
  if (criteria.length < 2) return undefined;
  const half = Math.ceil(criteria.length / 2);
  const groups = [criteria.slice(0, half), criteria.slice(half)];
  const title = plainTitle(card);
  const points = typeof card.estimate === "number" && card.estimate > 0 ? card.estimate : undefined;
  const parts = groups.map((own, i) => ({
    title: SPLIT_BY_CRITERIA_COPY.title(title, i + 1, groups.length),
    spec: SPLIT_BY_CRITERIA_COPY.spec(card.spec ?? title, own),
    acceptanceCriteria: own,
    scopeFiles: card.scopeFiles,
    ...(points ? { estimate: Math.max(1, Math.ceil(points / groups.length)) } : {}),
  }));
  return {
    kind: "split_card",
    cardId: card.id,
    cards: parts,
    why,
    summary: splitNotRetrySummary(title, parts.length, why),
  };
}

async function retryAnswer(
  deps: { cardStore: CardStore; log: EventLog },
  cards: readonly CardRecord[],
  text: string,
  inView?: string,
): Promise<JudgementAnswer | undefined> {
  const card = cards.find((c) => c.id === inView) ?? cardsNamed(text, cards)[0];
  if (!card) return undefined;
  const model = await capabilityModelOf({ store: deps.cardStore, log: deps.log });
  const v = overHorizon(model, card);
  // Within the horizon, whether to retry is a judgement for the model.
  if (!v) return undefined;
  const why = horizonWhy(v);
  const split = splitByCriteria(card, why);
  const title = plainTitle(card);
  const text2 = split
    ? `I'd split ${title}, not retry it: ${why}. I've proposed two parts, each with only its own criteria.`
    : `I'd split ${title}, not retry it: ${why}. It has fewer than two criteria to divide, so tell me where to cut it and I'll propose the parts.`;
  return {
    text: `${text2}${FROM_LEDGER}`,
    proposals: split ? [split] : [],
    cites: [{ cardId: card.id }],
  };
}

// --- The answer, and the guard on the model's proposals ---------------------

/** Seshat's judgement answer for a question it recognises, from the ledger; else undefined. */
export async function judgementAnswer(
  kind: JudgementQuestion,
  deps: { repoPath: string; cardStore: CardStore; log: EventLog },
  view: { cards: readonly CardRecord[]; cycles: readonly Cycle[] },
  message: { text: string; cardId?: string | undefined },
): Promise<JudgementAnswer | undefined> {
  if (kind === "at_risk") return atRiskAnswer(deps, view.cards);
  if (kind === "plan_sprint") return planSprintAnswer(deps, view.cards, view.cycles);
  if (kind === "retry") return retryAnswer(deps, view.cards, message.text, message.cardId);
  return {
    text: `Applying a benchmark's result is a person's choice, never mine: to use it, ${APPLY_BENCHMARK_ACTION}. The standup names the combination that did best, or says when there was no clear difference.${FROM_LEDGER}`,
    proposals: [],
    cites: [],
  };
}

/**
 * The model's proposals held to the judgement rules (PM-P6-8, -9), whatever
 * the small model wrote: a sprint it plans is cut to 85% of the last three
 * sprints' mean, with that basis; a retry (a move back to Ready, or an
 * unpark) of an issue that failed and is over the 80% size horizon becomes
 * a split. Returns the proposals and a note for each change.
 */
export async function guardProposals(
  proposals: readonly ProposalDraft[],
  deps: { cardStore: CardStore; log: EventLog },
  view: { cards: readonly CardRecord[]; cycles: readonly Cycle[] },
): Promise<{ proposals: ProposalDraft[]; notes: string[] }> {
  const out: ProposalDraft[] = [];
  const notes: string[] = [];
  const byId = new Map(view.cards.map((c) => [c.id, c]));
  let model: CapabilityModel | undefined;
  let cap: SprintCapacity | undefined | null = null;
  for (const p of proposals) {
    if (p.kind === "create_cycle" && Array.isArray(p.patch?.cardIds)) {
      if (cap === null) cap = await sprintCapacity(deps.log, view.cycles, view.cards);
      if (!cap) {
        out.push(p);
        continue;
      }
      const ids = (p.patch?.cardIds as string[]).filter((id) => byId.has(id));
      const bet = fillBet(
        ids.map((id) => byId.get(id) as CardRecord),
        cap.cap,
        cap.unit,
      );
      const basis = capacityBasis(cap);
      const name = String(p.patch?.name ?? "the sprint");
      const unitWord = cap.unit === "points" ? "points" : "issues";
      if (bet.out.length) {
        notes.push(
          `I cut ${name} to ${bet.size} ${unitWord}, no more than ${cap.cap}: ${basis}. Left out: ${bet.out.map((c) => plainTitle(c)).join(", ")}.`,
        );
      }
      out.push({
        ...p,
        patch: { ...p.patch, cardIds: bet.in.map((c) => c.id) },
        why: basis,
        summary: sprintBetSummary(
          name,
          String(p.patch?.startsOn ?? ""),
          String(p.patch?.endsOn ?? ""),
          bet.size,
          unitWord,
          basis,
        ),
      });
      continue;
    }
    const card = p.cardId ? byId.get(p.cardId) : undefined;
    const retry =
      card &&
      (p.kind === "unpark" || (p.kind === "move_card" && p.patch?.status === "ready")) &&
      !!card.stopReason &&
      card.stopReason !== "gate_passed";
    if (card && retry) {
      model ??= await capabilityModelOf({ store: deps.cardStore, log: deps.log });
      const v = overHorizon(model, card);
      if (v) {
        const why = horizonWhy(v);
        const split = splitByCriteria(card, why);
        if (split) out.push(split);
        notes.push(
          `I did not propose retrying ${plainTitle(card)}: ${why}.${split ? " I proposed a split instead." : " It should be split; tell me where to cut it."}`,
        );
        continue;
      }
    }
    out.push(p);
  }
  return { proposals: out, notes };
}

// --- PM-P6-12: a sprint's close, measured -------------------------------------

/** The ledger event recording Seshat's measures when a sprint closes (PM-P6-12). */
export const SPRINT_MEASURED = "pm/sprint_measured";

export interface SprintMeasures {
  cycleId: string;
  /**
   * The 85% forecast made from the throughput before the sprint started,
   * for the issues it held then, and whether it held: all of them done by
   * its 85% date. `undecided` while work remains and that date has not come;
   * `no_forecast` with under five days of history.
   */
  forecast: { state: "held" | "missed" | "undecided" | "no_forecast"; p85Date?: string };
  /** Forecast calibration so far: of the decided forecasts of closed sprints, how many held. */
  calibration: { held: number; decided: number };
  /** Seshat's proposals decided during the sprint. */
  proposals: { applied: number; discarded: number; acceptanceRate?: number };
  /** Issues Seshat planned whose first attempt ran during the sprint. */
  planned: { issues: number; passedFirstTry: number; rate?: number };
  /** Fields people edited after Seshat's applied proposal set them, during the sprint. */
  editedAfterSeshat: number;
}

/** A seeded generator, so a recorded forecast replays to the same numbers. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

/**
 * Seshat's measures for a closing sprint (planner-pm rule 16, PM-P6-12),
 * from the ledger alone: forecast calibration, proposal acceptance, the
 * first-attempt pass rate of the issues it planned, and how many fields
 * people edited after it changed them.
 */
export async function sprintMeasures(
  deps: { cardStore: CardStore; log: EventLog },
  cycle: Cycle,
  closedAt: Date,
): Promise<SprintMeasures> {
  const { monteCarloForecast } = await import("./metrics.js");
  const from = Date.parse(cycle.startsOn.slice(0, 10));
  const to = closedAt.getTime();
  const inWindow = (e: EventRecord) => {
    const t = Date.parse(e.createdAt);
    return t >= from && t <= to;
  };
  const cardEvents = await allEvents(deps.log, [
    "card/created",
    "card/status_changed",
    "card/updated",
  ]);
  // The sprint's issues, their state at its start, and when each was done.
  const cycleOf = new Map<string, string | null>();
  const statusAtStart = new Map<string, string>();
  const doneAt = new Map<string, number>();
  const dailyDone = new Map<string, number>();
  for (const e of cardEvents) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : (e.cardId ?? "");
    if (!id) continue;
    const t = Date.parse(e.createdAt);
    if (e.type === "card/created") {
      cycleOf.set(id, typeof p.cycleId === "string" ? p.cycleId : null);
      if (t < from) statusAtStart.set(id, String(p.status ?? "backlog"));
    } else if (e.type === "card/updated") {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      if ("cycleId" in patch)
        cycleOf.set(id, typeof patch.cycleId === "string" ? patch.cycleId : null);
    } else if (e.type === "card/status_changed" && typeof p.toStatus === "string") {
      if (t < from) statusAtStart.set(id, p.toStatus);
      if (p.toStatus === "done") {
        doneAt.set(id, t);
        if (t < from) {
          const d = day(t);
          dailyDone.set(d, (dailyDone.get(d) ?? 0) + 1);
        }
      }
    }
  }
  const issues = [...cycleOf].filter(([, c]) => c === cycle.id).map(([id]) => id);
  const remaining = issues.filter((id) => statusAtStart.get(id) !== "done").length;
  const days = [...dailyDone.keys()].sort();
  const history: number[] = [];
  if (days[0]) {
    for (let t = Date.parse(days[0]); t < from; t += 86_400_000)
      history.push(dailyDone.get(day(t)) ?? 0);
  }
  const fc = monteCarloForecast(history, remaining, 2000, seeded(cycle.id));
  let forecast: SprintMeasures["forecast"] = { state: "no_forecast" };
  if (fc && remaining > 0) {
    const due = from + fc.p85Days * 86_400_000;
    const done = issues.map((id) => doneAt.get(id));
    const allDone = done.every((t) => t !== undefined);
    const last = Math.max(...done.map((t) => t ?? 0));
    const state = allDone
      ? last <= due + 86_400_000
        ? "held"
        : "missed"
      : due < to
        ? "missed"
        : "undecided";
    forecast = { state, p85Date: day(due) };
  }
  // Calibration: this sprint with every earlier closed sprint's record.
  const earlier = (await deps.log.getEventsByTypes([SPRINT_MEASURED])).map(
    (e) => e.payload as SprintMeasures,
  );
  const decided = [
    ...earlier.filter((m) => m.cycleId !== cycle.id).map((m) => m.forecast),
    forecast,
  ].filter((f) => f.state === "held" || f.state === "missed");
  // Proposals: which were Seshat's, which were decided in the sprint.
  const pmEvents = await allEvents(deps.log, ["pm/reply", "pm/proposal_state"]);
  const kinds = new Map<
    string,
    { kind: string; cardId?: string; patch?: Record<string, unknown> }
  >();
  let applied = 0;
  let discarded = 0;
  const planned = new Set<string>();
  /** card → field → the seq Seshat's applied proposal set it at. */
  const setBySeshat = new Map<string, Map<string, number>>();
  const setField = (card: string, field: string, seq: number) => {
    const m = setBySeshat.get(card) ?? new Map<string, number>();
    m.set(field, seq);
    setBySeshat.set(card, m);
  };
  for (const e of pmEvents) {
    if (e.type === "pm/reply") {
      for (const p of (
        e.payload as {
          proposals?: {
            id: string;
            kind: string;
            cardId?: string;
            patch?: Record<string, unknown>;
          }[];
        }
      ).proposals ?? [])
        kinds.set(p.id, p);
      continue;
    }
    const p = e.payload as { proposalId: string; state: string; cardIds?: string[] };
    const prop = kinds.get(p.proposalId);
    if (!prop) continue;
    if (p.state === "applied") {
      if (inWindow(e)) applied++;
      if (prop.kind === "create_card" || prop.kind === "split_card") {
        for (const id of p.cardIds ?? []) {
          planned.add(id);
          for (const f of [
            "title",
            "spec",
            "acceptanceCriteria",
            "estimate",
            "priority",
            "labels",
            "scopeFiles",
          ])
            setField(id, f, e.seq);
        }
      } else if (prop.cardId && prop.patch) {
        for (const f of Object.keys(prop.patch)) setField(prop.cardId, f, e.seq);
      }
    } else if (p.state === "discarded" && inWindow(e)) discarded++;
  }
  // People's edits after Seshat's change: a person's update, later than the apply.
  let edited = 0;
  const counted = new Set<string>();
  for (const e of cardEvents) {
    if (e.type !== "card/updated" || !inWindow(e)) continue;
    if (e.actor === "planner" || e.actor === "harness" || e.actor === "worker") continue;
    const p = (e.payload ?? {}) as { id?: string; patch?: Record<string, unknown> };
    const id = p.id ?? e.cardId ?? "";
    const fields = setBySeshat.get(id);
    if (!fields) continue;
    for (const f of Object.keys(p.patch ?? {})) {
      const at = fields.get(f);
      const key = `${id}\0${f}\0${at}`;
      if (at !== undefined && e.seq > at && !counted.has(key)) {
        counted.add(key);
        edited++;
      }
    }
  }
  // First attempts of Seshat's issues that ran during the sprint.
  const firsts = deps.cardStore.runs
    .readAttemptOutcomes()
    .filter(
      (o) =>
        o.attemptNumber === 1 &&
        o.builtBy.kind !== "person" &&
        planned.has(o.cardId) &&
        Date.parse(o.completedAt) >= from &&
        Date.parse(o.completedAt) <= to,
    );
  const passed = firsts.filter((o) => o.passed).length;
  const rate = (a: number, n: number) => (n > 0 ? { rate: Math.round((a / n) * 100) / 100 } : {});
  return {
    cycleId: cycle.id,
    forecast,
    calibration: {
      held: decided.filter((f) => f.state === "held").length,
      decided: decided.length,
    },
    proposals: {
      applied,
      discarded,
      ...(applied + discarded > 0
        ? { acceptanceRate: Math.round((applied / (applied + discarded)) * 100) / 100 }
        : {}),
    },
    planned: { issues: firsts.length, passedFirstTry: passed, ...rate(passed, firsts.length) },
    editedAfterSeshat: edited,
  };
}

/** Record a closing sprint's measures on the ledger, once per sprint (PM-P6-12). */
export async function recordSprintClose(
  deps: { cardStore: CardStore; log: EventLog },
  cycle: Cycle,
  closedAt = new Date(),
): Promise<SprintMeasures | undefined> {
  const seen = (await deps.log.getEventsByTypes([SPRINT_MEASURED])).some(
    (e) => (e.payload as { cycleId?: string }).cycleId === cycle.id,
  );
  if (seen) return undefined;
  const m = await sprintMeasures(deps, cycle, closedAt);
  await deps.log.append({ actor: "harness", type: SPRINT_MEASURED, payload: m });
  return m;
}
