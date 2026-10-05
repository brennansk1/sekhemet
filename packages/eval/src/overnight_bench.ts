import { randomBytes } from "node:crypto";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import {
  type BakeOffEvidence,
  MODEL_ROLES,
  type ModelRole,
  ROLE_EVALUATION_SET,
} from "@sekhemet/models";
import {
  MEASURE_BENCHMARKED,
  type SettingsCombination,
  combinationFromRecord,
  combinationId,
  combinationRecord,
  compareOnItems,
  modelFor,
  parseSettingsText,
  runSettingsRefusal,
  settingsWords,
} from "./combination_bench.js";
import type { BenchRun, Combination, ItemScore, PairedComparison } from "./combination_types.js";
import { type RunProfile, runProfileHash } from "./run_profile.js";
import { clopperPearson, describeDetectable, minDetectableDifference } from "./stats.js";

/**
 * The overnight tier of the combination benchmark (measurement rule 37,
 * MS-N5-9–12; scheduling: models rule 20b, MD-N3-4/5). For each picked
 * combination: the full frozen suite at least twice with fixed seeds, and
 * once each role's full evaluation set where it is built, in
 * **counterbalanced blocks** — all of one combination's cards for a run,
 * then the next's, the order reversed on the second run (A, B, C, C, B, A) —
 * with one model swap per block and none within one. Combinations are
 * compared only on cards both ran, by the paired exact test at 0.05.
 *
 * It keeps every completed card on the ledger (`measure/benchmark_item`), so
 * a run stopped at the window's end resumes the next night from the card
 * where it stopped, in the same block order; a run whose harness build,
 * context version or qualification changed in between is discarded and
 * restarted, saying why. It never assigns anything (MS-N5-11). It is the
 * bake-off `assignments.ts` requires for a baseline or default change.
 */

export const BENCH_EVENTS = {
  started: "measure/benchmark_started",
  stopped: "measure/benchmark_stopped",
  item: "measure/benchmark_item",
} as const;

/** About two suite runs, the planning measure and the role sets (rule 37, the plan's machine time). */
export const HOURS_PER_COMBINATION = 5;
export const MAX_OVERNIGHT_COMBINATIONS = 3;

export type StopReason = "done" | "person" | "window_end" | "reserved" | "failed";

// ── blocks (MS-N5-10) ───────────────────────────────────────────────────

export interface Block {
  index: number;
  /** 1-based run; each run has its own fixed seed. */
  run: number;
  combinationId: string;
}

/** A, B, C on the first run, C, B, A on the second, alternating after. */
export function planBlocks(combinationIds: readonly string[], runs = 2): Block[] {
  const out: Block[] = [];
  for (let run = 1; run <= runs; run++) {
    const order = run % 2 === 1 ? [...combinationIds] : [...combinationIds].reverse();
    for (const id of order) out.push({ index: out.length, run, combinationId: id });
  }
  return out;
}

// ── the estimate and the default picks (MS-N5-9, DB-N6-11) ──────────────

export interface NightEstimate {
  hoursNeeded: number;
  /** Hours of tonight's window left for the benchmark. */
  available: number;
  fitsTonight: number;
  /** Nights until all finish; undefined when no window hour is left for it. */
  nights?: number;
  line: string;
}

/**
 * How many picked combinations fit tonight's window (MS-N5-9): from about 5
 * hours each (or recorded throughput), after the night's backlog unless the
 * person put the benchmark first, and on which night all finish.
 */
export function estimateNight(o: {
  combinations: number;
  hoursPerCombination: number;
  windowHours: number;
  backlogHours?: number;
  benchmarkFirst?: boolean;
  /** The window as the page shows it, e.g. "22:00–03:00". */
  windowLabel?: string;
}): NightEstimate {
  const hoursNeeded = Math.round(o.combinations * o.hoursPerCombination * 10) / 10;
  const available = Math.max(
    0,
    o.windowHours - (o.benchmarkFirst ? 0 : Math.max(0, o.backlogHours ?? 0)),
  );
  const fitsTonight = Math.min(
    o.combinations,
    Math.floor(available / o.hoursPerCombination + 1e-9),
  );
  const nights = available > 0 ? Math.max(1, Math.ceil(hoursNeeded / available - 1e-9)) : undefined;
  const label = `Tonight${o.windowLabel ? ` ${o.windowLabel}` : ""} (${Math.round(o.windowHours * 10) / 10} h)`;
  const finish =
    nights === undefined
      ? "no window hour is left for it after the backlog"
      : nights === 1
        ? "all finish tonight"
        : `all ${o.combinations} finish on night ${nights}`;
  return {
    hoursNeeded,
    available,
    fitsTonight,
    ...(nights !== undefined ? { nights } : {}),
    line: `${label}: ${fitsTonight} of ${o.combinations} combination${o.combinations === 1 ? "" : "s"} ${fitsTonight === 1 ? "fits" : "fit"}; ${finish} (about ${o.hoursPerCombination} h each).`,
  };
}

/**
 * The default picks (MS-N5-9, DB-N6-11): the top combinations the quick tier
 * could not separate — the best and those indistinguishable from it — at
 * most three; none when the best was separated from every other.
 */
export function defaultOvernightPicks(
  results: readonly { combinationId: string; value: number; indistinguishableFrom: string[] }[],
  max = MAX_OVERNIGHT_COMBINATIONS,
): string[] {
  const ranked = [...results].sort((a, b) => b.value - a.value);
  const top = ranked[0];
  if (!top || top.indistinguishableFrom.length === 0) return [];
  const tied = new Set(top.indistinguishableFrom);
  return [top, ...ranked.slice(1).filter((r) => tied.has(r.combinationId))]
    .slice(0, max)
    .map((r) => r.combinationId);
}

// ── scheduling and the run's state, from the ledger ─────────────────────

interface StartedPayload {
  runId: string;
  tier: "quick" | "overnight";
  state: "queued" | "running";
  combinations: { id: string; models: Record<string, string> }[];
  host: string;
  benchmarkFirst?: boolean;
  estimateSeconds?: number;
  build?: string;
  contextVersion?: string;
  qualification?: string;
  restartRun?: number;
  reason?: string;
}

interface StoppedPayload {
  runId: string;
  tier: "quick" | "overnight";
  reason: StopReason;
  partial: boolean;
  completed: number;
  total: number;
  cursor?: { block: number; item: number };
}

interface ItemPayload {
  runId: string;
  run: number;
  block: number;
  combinationId: string;
  role: string;
  item: string;
  score: number;
  seconds: number;
  seed: number;
}

export const newRunId = () => `bench_${randomBytes(6).toString("hex")}`;

/** A combination as recorded: each role's model, and its settings (rule 39). */
const modelsOf = (c: SettingsCombination) => combinationRecord(c);

/** A run's combinations back from the ids and models its start recorded, settings included. */
export function combinationFromModels(models: Record<string, string>): SettingsCombination {
  return combinationFromRecord(models);
}

/**
 * Queue an overnight benchmark (MS-N5-9, MD-N3-4): recorded with the
 * person's principal; it starts only at the first moment of the overnight
 * window with the runner free. Up to three combinations.
 */
export async function scheduleOvernight(
  log: EventLog,
  o: {
    combinations: SettingsCombination[];
    host: string;
    /** The person who queued it; resolved to the install's person on a solo install. */
    principal?: string;
    benchmarkFirst?: boolean;
    estimateSeconds?: number;
    runId?: string;
  },
): Promise<{ runId: string; combinationIds: string[] }> {
  if (o.combinations.length === 0) throw new Error("Pick at least one combination to compare.");
  if (o.combinations.length > MAX_OVERNIGHT_COMBINATIONS)
    throw new Error(
      `The overnight benchmark compares at most ${MAX_OVERNIGHT_COMBINATIONS} combinations (rule 37); ${o.combinations.length} were picked.`,
    );
  // MS-N8-1: a value a run cannot apply is refused before anything is queued.
  for (const c of o.combinations) {
    const refusal = runSettingsRefusal(c);
    if (refusal) throw refusal;
  }
  const runId = o.runId ?? newRunId();
  const combinations = o.combinations.map((c) => ({
    id: combinationId(c, o.host),
    models: modelsOf(c),
  }));
  await log.append({
    actor: "human",
    ...(o.principal ? { principal: o.principal } : {}),
    type: BENCH_EVENTS.started,
    payload: {
      runId,
      tier: "overnight",
      state: "queued",
      combinations,
      host: o.host,
      benchmarkFirst: o.benchmarkFirst === true,
      ...(o.estimateSeconds !== undefined ? { estimateSeconds: o.estimateSeconds } : {}),
    } satisfies StartedPayload,
  });
  return { runId, combinationIds: combinations.map((c) => c.id) };
}

interface RunRecord {
  runId: string;
  started: EventRecord<StartedPayload>[];
  stops: EventRecord<StoppedPayload>[];
  items: EventRecord<ItemPayload>[];
  /** seq-ordered start and stop events. */
  timeline: EventRecord[];
}

async function runRecords(log: EventLog): Promise<Map<string, RunRecord>> {
  const events = await log.getEventsByTypes([
    BENCH_EVENTS.started,
    BENCH_EVENTS.stopped,
    BENCH_EVENTS.item,
  ]);
  const runs = new Map<string, RunRecord>();
  for (const e of events) {
    const id = (e.payload as { runId: string }).runId;
    let r = runs.get(id);
    if (!r) {
      r = { runId: id, started: [], stops: [], items: [], timeline: [] };
      runs.set(id, r);
    }
    if (e.type === BENCH_EVENTS.started) r.started.push(e as EventRecord<StartedPayload>);
    else if (e.type === BENCH_EVENTS.stopped) r.stops.push(e as EventRecord<StoppedPayload>);
    else r.items.push(e as EventRecord<ItemPayload>);
    if (e.type !== BENCH_EVENTS.item) r.timeline.push(e);
  }
  return runs;
}

/** Whether a stop ends the run for good: done, a person's Stop, a failure, or any quick stop. */
function final(stop: StoppedPayload): boolean {
  return (
    stop.tier === "quick" ||
    stop.reason === "done" ||
    stop.reason === "person" ||
    stop.reason === "failed"
  );
}

/**
 * Every benchmark run's state from the ledger (DB-N6-10, PM_CONTRACT
 * `BenchmarkRun`): queued, running, stopped (results kept), done or failed.
 * An overnight run stopped at the window's end or by a reservation is queued
 * again for the next night.
 */
export async function benchmarkRuns(log: EventLog): Promise<BenchRun[]> {
  const out: BenchRun[] = [];
  for (const r of (await runRecords(log)).values()) {
    const first = r.started[0]?.payload;
    if (!first) continue;
    const last = r.timeline.at(-1);
    const lastStop = r.stops.at(-1)?.payload;
    let state: BenchRun["state"] = "queued";
    if (last?.type === BENCH_EVENTS.started)
      state = (last.payload as StartedPayload).state === "running" ? "running" : "queued";
    else if (lastStop)
      state =
        lastStop.reason === "done"
          ? "done"
          : lastStop.reason === "failed"
            ? "failed"
            : final(lastStop)
              ? "stopped"
              : "queued";
    out.push({
      runId: r.runId,
      tier: first.tier,
      combinations: first.combinations.map((c) => c.id),
      state,
      partial: r.stops.some((s) => s.payload.partial) && state !== "done",
      ...(lastStop
        ? {
            progress: {
              done: lastStop.completed,
              total: lastStop.total,
              elapsedSeconds: 0,
            },
          }
        : {}),
    });
  }
  return out;
}

/** The run's start record: its combinations, host and whether the benchmark goes first. */
export async function runDefinition(
  log: EventLog,
  runId: string,
): Promise<StartedPayload | undefined> {
  return (await runRecords(log)).get(runId)?.started[0]?.payload;
}

// ── the night (MS-N5-10, MS-N5-12, MD-N3-4/5) ───────────────────────────

export interface OvernightCard {
  id: string;
  role: ModelRole;
}

/** Each role's full evaluation set (rule 29): the suite for the Worker, twice; the others once. */
export interface OvernightSets {
  roles: Record<
    ModelRole,
    { state: "ready" | "not_built"; reason?: string; cards: OvernightCard[]; runs: number }
  >;
}

export interface OvernightRunner {
  /** One swap at a block's start, bypassing Smart Swap's C1–C10 (rule 20b, MD-N14-40). */
  swapTo(combination: Combination, block: Block): Promise<void>;
  /** One card with a fixed seed; `cutAtWindowEnd` when the window ended during it. */
  runCard(input: {
    combination: Combination;
    card: OvernightCard;
    run: number;
    seed: number;
    deadline?: number;
  }): Promise<{ passed: boolean; seconds: number; cutAtWindowEnd?: boolean }>;
  /** Unload what it loaded; called when the night's run ends, inside the measurement run. */
  release?(): Promise<void>;
}

export interface WindowState {
  open: boolean;
  why: string;
  /** Why it is closed: the window ended, or the machine is reserved. */
  reason?: "window_end" | "reserved";
  /** When the window closes (ms), for the card's deadline. */
  endsAt?: number;
}

/** The build, context version and qualification a run is comparable under (models rule 20b). */
export interface RunFingerprint {
  build: string;
  contextVersion: string;
  qualification: string;
}

export interface OvernightInput {
  log: EventLog;
  runId: string;
  runner: OvernightRunner;
  sets: OvernightSets;
  host: string;
  now: () => number;
  /** The overnight window with the lease free and the machine not reserved (MD-N3-4); no idle exception. */
  window: () => WindowState | Promise<WindowState>;
  fingerprint: RunFingerprint;
  runProfileFor: (c: Combination) => RunProfile;
  /** Smart Swap's `withMeasurementRun` (DEC-45). */
  measurementRun: <T>(run: () => Promise<T>) => Promise<T>;
  /** A person's Stop (DB-N6-10): the run ends for good, its results kept. */
  shouldStop?: () => boolean;
  say?: (line: string) => void;
}

export interface OvernightOutcome {
  state: "done" | "stopped" | "queued";
  reason?: StopReason | "reserved" | "window_end";
  completed: number;
  total: number;
}

const itemKey = (run: number, combination: string, role: string, item: string) =>
  `${run}\0${combination}\0${role}\0${item}`;

function blockCards(sets: OvernightSets, c: Combination, run: number): OvernightCard[] {
  return MODEL_ROLES.flatMap((role) => {
    const set = sets.roles[role];
    return set.state === "ready" && modelFor(c, role) && run <= set.runs ? set.cards : [];
  });
}

const RESTART_REASONS: [keyof RunFingerprint, string, string][] = [
  ["build", "build_changed", "the harness build changed"],
  ["contextVersion", "context_version_changed", "the context version changed"],
  ["qualification", "qualification_changed", "a model's qualification changed"],
];

/** Items kept for the run: those a later restart of their run did not discard. */
function keptItems(r: RunRecord): EventRecord<ItemPayload>[] {
  return r.items.filter(
    (i) => !r.started.some((s) => s.payload.restartRun === i.payload.run && s.seq > i.seq),
  );
}

/**
 * One night of an overnight benchmark: starts only with the window open
 * (MD-N3-4), resumes from where the last night stopped, runs its blocks,
 * stops at the window's end or a reservation keeping every completed card
 * (MD-N3-5), and records the partial or final results (MS-N5-11).
 */
export async function runOvernightBench(input: OvernightInput): Promise<OvernightOutcome> {
  const say = input.say ?? (() => undefined);
  const record = (await runRecords(input.log)).get(input.runId);
  const def = record?.started[0]?.payload;
  if (!record || !def) throw new Error(`No benchmark run ${input.runId} on this ledger.`);
  if (def.tier !== "overnight") throw new Error(`${input.runId} is not an overnight benchmark.`);
  const combos = def.combinations.map((c) => ({
    id: c.id,
    combination: combinationFromModels(c.models),
  }));
  const byId = new Map(combos.map((c) => [c.id, c.combination]));
  const runs = Math.max(
    1,
    ...MODEL_ROLES.map((r) =>
      input.sets.roles[r].state === "ready" ? input.sets.roles[r].runs : 1,
    ),
  );
  const blocks = planBlocks(
    combos.map((c) => c.id),
    runs,
  );
  const cardsOf = (b: Block) =>
    blockCards(input.sets, byId.get(b.combinationId) as Combination, b.run);
  const total = blocks.reduce((s, b) => s + cardsOf(b).length, 0);
  let kept = keptItems(record);
  const lastStop = record.stops.at(-1)?.payload;
  if (lastStop && final(lastStop))
    return {
      state: lastStop.reason === "done" ? "done" : "stopped",
      reason: lastStop.reason,
      completed: kept.length,
      total,
    };

  const completedKeys = () =>
    new Set(
      kept.map((i) =>
        itemKey(i.payload.run, i.payload.combinationId, i.payload.role, i.payload.item),
      ),
    );
  const cursorOf = (done: Set<string>) => {
    for (const b of blocks) {
      const cards = cardsOf(b);
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i] as OvernightCard;
        if (!done.has(itemKey(b.run, b.combinationId, card.role, card.id)))
          return { block: b.index, item: i };
      }
    }
    return undefined;
  };

  // MD-N3-4: nothing starts while the window is closed, the machine reserved or a card holds the runner.
  const w0 = await input.window();
  if (!w0.open) {
    say(`Overnight benchmark ${input.runId} is queued: ${w0.why}.`);
    return { state: "queued", reason: w0.reason ?? "window_end", completed: kept.length, total };
  }
  if (input.shouldStop?.()) return { state: "queued", completed: kept.length, total };

  // MD-N3-5: a run interrupted under another build, context or qualification is restarted.
  let restart: { run: number; reason: string } | undefined;
  const cursor0 = cursorOf(completedKeys());
  const previous = [...record.started]
    .reverse()
    .find((s) => s.payload.state === "running")?.payload;
  if (cursor0 && previous) {
    const run = (blocks[cursor0.block] as Block).run;
    const changed = RESTART_REASONS.find(([k]) => previous[k] !== input.fingerprint[k]);
    if (changed && kept.some((i) => i.payload.run === run)) {
      restart = { run, reason: changed[1] };
      say(
        `Overnight benchmark ${input.runId}: ${changed[2]} since the last night, so run ${run} is discarded and restarted (a run mixing two builds is not comparable).`,
      );
    }
  }
  await input.log.append({
    actor: "harness",
    type: BENCH_EVENTS.started,
    payload: {
      runId: input.runId,
      tier: "overnight",
      state: "running",
      combinations: def.combinations,
      host: def.host,
      build: input.fingerprint.build,
      contextVersion: input.fingerprint.contextVersion,
      qualification: input.fingerprint.qualification,
      ...(restart ? { restartRun: restart.run, reason: restart.reason } : {}),
    } satisfies StartedPayload,
  });
  if (restart) kept = kept.filter((i) => i.payload.run !== restart?.run);

  let reason: StopReason = "done";
  let stoppedAt: { block: number; item: number } | undefined;
  let firstCheck: WindowState | undefined = w0;
  await input.measurementRun(async () => {
    try {
      await night();
    } finally {
      await input.runner.release?.();
    }
  });
  async function night(): Promise<void> {
    const done = completedKeys();
    for (const b of blocks) {
      const combination = byId.get(b.combinationId) as Combination;
      const cards = cardsOf(b);
      let swapped = false;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i] as OvernightCard;
        if (done.has(itemKey(b.run, b.combinationId, card.role, card.id))) continue;
        if (input.shouldStop?.()) {
          reason = "person";
          stoppedAt = { block: b.index, item: i };
          return;
        }
        // The start's check serves the first card; every later card asks again.
        const w = firstCheck ?? (await input.window());
        firstCheck = undefined;
        if (!w.open) {
          reason = w.reason ?? "window_end";
          stoppedAt = { block: b.index, item: i };
          return;
        }
        if (!swapped) {
          await input.runner.swapTo(combination, b);
          swapped = true;
        }
        const r = await input.runner.runCard({
          combination,
          card,
          run: b.run,
          seed: b.run,
          ...(w.endsAt !== undefined ? { deadline: w.endsAt } : {}),
        });
        if (r.cutAtWindowEnd) {
          // Not completed: it runs again from its start next night.
          reason = "window_end";
          stoppedAt = { block: b.index, item: i };
          return;
        }
        const item = await input.log.append({
          actor: "harness",
          type: BENCH_EVENTS.item,
          payload: {
            runId: input.runId,
            run: b.run,
            block: b.index,
            combinationId: b.combinationId,
            role: card.role,
            item: card.id,
            score: r.passed ? 1 : 0,
            seconds: r.seconds,
            seed: b.run,
          } satisfies ItemPayload,
        });
        kept.push(item as EventRecord<ItemPayload>);
        done.add(itemKey(b.run, b.combinationId, card.role, card.id));
      }
    }
  }

  const partial = reason !== "done";
  await recordResults(input, combos, kept, partial);
  await input.log.append({
    actor: "harness",
    type: BENCH_EVENTS.stopped,
    payload: {
      runId: input.runId,
      tier: "overnight",
      reason,
      partial,
      completed: kept.length,
      total,
      ...(stoppedAt ? { cursor: stoppedAt } : {}),
    } satisfies StoppedPayload,
  });
  say(
    reason === "done"
      ? `Overnight benchmark ${input.runId} finished: ${kept.length}/${total} cards.`
      : `Overnight benchmark ${input.runId} stopped (${reason}) after ${kept.length}/${total} cards; ${reason === "person" ? "a person stopped it, and it does not resume" : "it resumes next night from where it stopped"}.`,
  );
  return {
    state: reason === "done" ? "done" : reason === "person" ? "stopped" : "stopped",
    reason,
    completed: kept.length,
    total,
  };
}

// ── results (MS-N5-10, MS-N5-11) ────────────────────────────────────────

interface RoleResult {
  role: ModelRole;
  model: string;
  state: "measured" | "partial" | "not_measured";
  items: ItemScore[];
  passes: number;
  n: number;
  seconds: number[];
}

function roleResults(
  sets: OvernightSets,
  runs: number,
  id: string,
  c: Combination,
  kept: EventRecord<ItemPayload>[],
): RoleResult[] {
  return MODEL_ROLES.flatMap((role): RoleResult[] => {
    const model = modelFor(c, role);
    if (!model) return [];
    const set = sets.roles[role];
    const mine = kept.filter((i) => i.payload.combinationId === id && i.payload.role === role);
    const base = {
      role,
      model,
      items: [] as ItemScore[],
      passes: 0,
      n: 0,
      seconds: [] as number[],
    };
    if (set.state !== "ready" || mine.length === 0)
      return [{ ...base, state: "not_measured" as const }];
    const byCard = new Map<string, number[]>();
    for (const i of mine)
      byCard.set(i.payload.item, [...(byCard.get(i.payload.item) ?? []), i.payload.score]);
    const expected = set.cards.length * Math.min(set.runs, runs);
    const items = set.cards
      .filter((card) => byCard.has(card.id))
      .map((card) => {
        const xs = byCard.get(card.id) as number[];
        return { id: card.id, score: xs.reduce((s, x) => s + x, 0) / xs.length };
      });
    return [
      {
        role,
        model,
        state: mine.length >= expected ? ("measured" as const) : ("partial" as const),
        items,
        passes: mine.reduce((s, i) => s + i.payload.score, 0),
        n: mine.length,
        seconds: mine.map((i) => i.payload.seconds),
      },
    ];
  });
}

async function recordResults(
  input: OvernightInput,
  combos: { id: string; combination: Combination }[],
  kept: EventRecord<ItemPayload>[],
  partial: boolean,
): Promise<void> {
  const runs = Math.max(
    1,
    ...MODEL_ROLES.map((r) =>
      input.sets.roles[r].state === "ready" ? input.sets.roles[r].runs : 1,
    ),
  );
  const results = new Map(
    combos.map((c) => [c.id, roleResults(input.sets, runs, c.id, c.combination, kept)]),
  );
  for (const { id, combination } of combos) {
    const mine = results.get(id) ?? [];
    const comparisons: PairedComparison[] = [];
    const resolved: { role: string; better: string; worse: string; p: number }[] = [];
    const indistinguishable: { role: string; a: string; b: string; p: number }[] = [];
    for (const other of combos) {
      if (other.id === id) continue;
      for (const r of mine) {
        const o = (results.get(other.id) ?? []).find((x) => x.role === r.role);
        // Ranked only on the roles whose models differ, on cards both ran (rules 35, 37).
        if (!o || o.model === r.model || !r.items.length || !o.items.length) continue;
        const c = compareOnItems(
          r.role,
          { model: r.model, items: r.items },
          { model: o.model, items: o.items },
        );
        comparisons.push(c);
        if (c.indistinguishable)
          indistinguishable.push({ role: r.role, a: id, b: other.id, p: c.p });
        else
          resolved.push({
            role: r.role,
            better: c.better > c.worse ? id : other.id,
            worse: c.better > c.worse ? other.id : id,
            p: c.p,
          });
      }
    }
    const profile = input.runProfileFor(combination);
    await input.log.append({
      actor: "harness",
      type: MEASURE_BENCHMARKED,
      payload: {
        tier: "overnight",
        profileHash: runProfileHash(profile),
        host: input.host,
        combination: modelsOf(combination),
        partial,
        roles: mine.map((r) => {
          if (r.state === "not_measured") return { role: r.role, model: r.model, state: r.state };
          const ci = clopperPearson(r.passes, r.n);
          return {
            role: r.role,
            model: r.model,
            state: r.state,
            score: r.passes / r.n,
            low: ci.low,
            high: ci.high,
            items: r.items,
            secondary: {
              secondsPerItem: r.seconds.reduce((s, x) => s + x, 0) / r.seconds.length,
              fits: true,
            },
          };
        }),
        comparisons,
        resolved,
        indistinguishable,
      },
      private: { runProfile: profile as unknown as Record<string, unknown> },
    });
  }
}

// ── the bake-off and the morning report (MD-N10-1, MS-N5-11) ────────────

interface BenchmarkedRole {
  role: string;
  model: string;
  state: string;
  score?: number;
  low?: number;
  high?: number;
  items?: ItemScore[];
}

interface OvernightPayload {
  tier: "quick" | "overnight";
  host?: string;
  partial: boolean;
  combination?: Record<string, string>;
  roles: BenchmarkedRole[];
  comparisons: PairedComparison[];
  resolved?: { role?: string; better: string; worse: string; p: number }[];
  indistinguishable?: { role?: string; a: string; b: string; p: number }[];
}

/**
 * A recorded overnight benchmark as the bake-off evidence for one role
 * (models MD-N10-1): only a finished (not partial) overnight event whose
 * role was measured on its full evaluation set. A quick event never is.
 */
export function bakeOffEvidence(event: EventRecord, role: ModelRole): BakeOffEvidence | undefined {
  const p = event.payload as OvernightPayload;
  if (event.type !== MEASURE_BENCHMARKED || p.tier !== "overnight" || p.partial) return undefined;
  const r = p.roles.find((x) => x.role === role && x.state === "measured");
  if (!r) return undefined;
  return {
    id: event.id,
    host: p.host ?? "",
    role,
    model: r.model,
    tier: "overnight",
    evaluationSet: ROLE_EVALUATION_SET[role],
    date: event.createdAt,
  };
}

const ROLE_NAMES: Record<string, string> = {
  worker: "Worker",
  planner: "Planner",
  reviewer: "Reviewer",
  researcher: "Researcher",
};

const describeCombination = (models: Record<string, string> = {}) =>
  MODEL_ROLES.filter((r) => models[r])
    .map((r) => {
      const settings = models[`${r}.settings`];
      return `${ROLE_NAMES[r]} ${models[r]}${settings ? ` (${settingsWords(parseSettingsText(settings))})` : ""}`;
    })
    .join(" · ");

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pFmt = (p: number) => (p < 0.001 ? "p < 0.001" : `p = ${p.toFixed(3)}`);

/**
 * The latest overnight night the ledger records (optionally one run's, and
 * none older than `since`): its stop, the combinations' names and models,
 * and one row per combination benchmarked, best Worker pass rate first.
 */
async function lastNight(log: EventLog, o: { runId?: string; since?: number }) {
  const records = await runRecords(log);
  const stops = [...records.values()]
    .flatMap((r) => r.stops)
    .filter((s) => s.payload.tier === "overnight" && (!o.runId || s.payload.runId === o.runId))
    .sort((a, b) => a.seq - b.seq);
  const stop = stops.at(-1);
  if (!stop) return undefined;
  if (o.since !== undefined && Date.parse(stop.createdAt) < o.since) return undefined;
  const record = records.get(stop.payload.runId) as RunRecord;
  const nightStart =
    [...record.started].reverse().find((s) => s.seq < stop.seq && s.payload.state === "running")
      ?.seq ?? 0;
  const events = (await log.getEventsByTypes([MEASURE_BENCHMARKED], nightStart)).filter(
    (e) => e.seq < stop.seq && (e.payload as OvernightPayload).tier === "overnight",
  );
  if (!events.length) return undefined;
  const def = record.started[0]?.payload;
  const names = new Map(
    (def?.combinations ?? []).map((c) => [c.id, describeCombination(c.models)]),
  );
  const modelsById = new Map((def?.combinations ?? []).map((c) => [c.id, c.models]));
  const kept = keptItems(record).filter((i) => i.seq < stop.seq);
  const rows = events.map((e) => {
    const p = e.payload as OvernightPayload;
    const worker = p.roles.find((r) => r.role === "worker");
    const id = combinationId(combinationFromModels(p.combination ?? {}), p.host ?? "");
    const runsOf = kept.filter(
      (i) => i.payload.combinationId === id && i.payload.role === "worker",
    );
    const passes = runsOf.reduce((sum, i) => sum + i.payload.score, 0);
    return {
      id,
      p,
      worker,
      name: describeCombination(p.combination),
      passes,
      n: runsOf.length,
    };
  });
  rows.sort((a, b) => (b.worker?.score ?? -1) - (a.worker?.score ?? -1));
  return { stop, names, modelsById, rows };
}

/** The overnight benchmark's outcome for a standup (planner-pm PM-P6-14). */
export interface OvernightVerdict {
  runId: string;
  /** When the night stopped. */
  at: string;
  reason: StopReason;
  /**
   * `best`: the leading combination is resolved better than every other on
   * the Worker's cards; `no_clear_difference`: it is not (a tie or too few
   * runs to tell them apart); `only_one`: one combination was measured, so
   * there was nothing to compare.
   */
  outcome: "best" | "no_clear_difference" | "only_one";
  /** The best combination's models by role, or the leading ones'. */
  leading: Record<string, string>[];
}

/**
 * The latest overnight night as a verdict, not a table (PM-P6-14): the
 * combination whose Worker pass rate the night resolved better than every
 * other one's, or the leading combinations when it could not tell them
 * apart. It assigns nothing. Undefined when there is no night newer than
 * `since` (ms).
 */
export async function overnightVerdict(
  log: EventLog,
  o: { runId?: string; since?: number } = {},
): Promise<OvernightVerdict | undefined> {
  const night = await lastNight(log, o);
  if (!night) return undefined;
  const measured = night.rows.filter((r) => typeof r.worker?.score === "number" && r.n > 0);
  const top = measured[0];
  if (!top) return undefined;
  const beats = new Set<string>();
  for (const { p } of night.rows) {
    for (const r of p.resolved ?? []) {
      if ((r.role ?? "worker") === "worker" && r.better === top.id) beats.add(r.worse);
    }
  }
  const others = measured.slice(1);
  const best = others.length > 0 && others.every((r) => beats.has(r.id));
  const modelsOf = (r: (typeof measured)[number]) =>
    night.modelsById.get(r.id) ?? (r.p.combination as Record<string, string>) ?? {};
  // The leaders: the top, and every combination not resolved worse than it.
  const leading = best ? [top] : [top, ...others.filter((r) => !beats.has(r.id))];
  return {
    runId: night.stop.payload.runId,
    at: night.stop.createdAt,
    reason: night.stop.payload.reason,
    outcome: others.length === 0 ? "only_one" : best ? "best" : "no_clear_difference",
    leading: leading.map(modelsOf),
  };
}

/**
 * The morning report (MS-N5-11): the latest overnight night's ranking with
 * intervals, which differences it resolved and which are still
 * indistinguishable, per pair and per role, with the smallest difference
 * detectable at 80% power; it assigns nothing. Empty when there is none, or
 * none newer than `since` (ms).
 */
export async function morningReport(
  log: EventLog,
  o: { runId?: string; since?: number } = {},
): Promise<string> {
  const night = await lastNight(log, o);
  if (!night) return "";
  const { stop, names, modelsById, rows } = night;
  const s = stop.payload;
  const lines = [
    `**Overnight benchmark** — ${
      s.reason === "done"
        ? "finished"
        : s.reason === "person"
          ? "stopped by a person; it does not resume"
          : "stopped at the window's end; it resumes tonight from where it stopped"
    } (${s.completed}/${s.total} cards).`,
    "Ranking by the Worker's frozen-suite pass rate, with its 95% interval (neither of two indistinguishable combinations is better):",
  ];
  rows.forEach((r, i) => {
    const w = r.worker;
    lines.push(
      w && typeof w.score === "number" && r.n > 0
        ? `${i + 1}. ${r.name} — ${r.passes}/${r.n} card runs passed (${pct(w.score)}, 95% CI ${pct(w.low ?? 0)}–${pct(w.high ?? 1)}; ${w.items?.length ?? 0} cards${w.state === "partial" ? ", partial" : ""})`
        : `${i + 1}. ${r.name} — not measured yet`,
    );
  });
  const seen = new Set<string>();
  const resolved: string[] = [];
  const tied: string[] = [];
  for (const { p } of rows) {
    for (const r of p.resolved ?? []) {
      const k = `${r.role}\0${[r.better, r.worse].sort().join("\0")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      resolved.push(
        `${names.get(r.better) ?? r.better} is better than ${names.get(r.worse) ?? r.worse} on the ${ROLE_NAMES[r.role ?? "worker"]}'s cards (${pFmt(r.p)})`,
      );
    }
    for (const r of p.indistinguishable ?? []) {
      const k = `${r.role}\0${[r.a, r.b].sort().join("\0")}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const role = r.role ?? "worker";
      const cmp = p.comparisons.find(
        (c) =>
          c.role === role &&
          c.a === modelsById.get(r.a)?.[role] &&
          c.b === modelsById.get(r.b)?.[role],
      );
      const paired = cmp ? cmp.better + cmp.worse + cmp.ties : 0;
      tied.push(
        `${names.get(r.a) ?? r.a} and ${names.get(r.b) ?? r.b} on the ${ROLE_NAMES[r.role ?? "worker"]}'s cards (${pFmt(r.p)}; ${describeDetectable(minDetectableDifference(paired), paired, "difference")})`,
      );
    }
  }
  lines.push(resolved.length ? `Resolved: ${resolved.join("; ")}.` : "Resolved: none yet.");
  if (tied.length) lines.push(`Still indistinguishable: ${tied.join("; ")}.`);
  const notMeasured = [
    ...new Set(
      rows.flatMap(({ p }) =>
        p.roles.filter((r) => r.state === "not_measured").map((r) => ROLE_NAMES[r.role] ?? r.role),
      ),
    ),
  ];
  if (notMeasured.length)
    lines.push(
      `Not measured: ${notMeasured.join(", ")} — their full evaluation sets are not built yet, so they are left out of every comparison.`,
    );
  lines.push(
    "The benchmark assigned nothing: applying a combination is your choice, on Configuration › Models.",
  );
  return lines.join("\n");
}
