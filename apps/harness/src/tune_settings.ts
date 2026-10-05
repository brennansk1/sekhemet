import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_LOAD_SECONDS,
  type ItemScore,
  type RunSettings,
  type ScreenRunner,
  type ScreeningItem,
  type ScreeningSet,
  compareOnItems,
  readQuickScores,
  scoreItem,
  settingsWords,
  wilcoxonSignedRankLess,
} from "@sekhemet/eval";
import type { EventLog } from "@sekhemet/kernel";
import {
  MODEL_ROLES,
  ModelRegistry,
  type ModelRole,
  type RoleSettingValues,
  dec42HostCheck,
  readHostFreeRatio,
  readSwapUsedBytes,
} from "@sekhemet/models";
import type { BenchmarkEnv } from "./benchmark_cmd.js";
import { roleModelName } from "./model_access.js";
import { settingsTunedLine } from "./pm/standup.js";
import { acquireRunnerLease, leaseRefusal } from "./runner_lease.js";

/**
 * Find best settings (measurement rule 38, NEW-measurement-7; W18 G3):
 * `sekhemet tune settings --role <role>` and the Benchmark section's card.
 * For one role and one model it screens candidate run-level settings on a
 * small hard subset of the role's quick screen by successive halving, then
 * compares the survivor with the settings the role runs at now on the whole
 * screen by the exact sign test, and says *best combination*, *cheaper*
 * (not established) or *no clear difference* by PROMPT_STANDARD rule 35.4.
 *
 * Before any load it checks DEC-42's host limits and takes the runner lease;
 * the model loads once inside a measurement run (DEC-45) and is unloaded at
 * the end, even on failure. Stop keeps every scored item. The result is one
 * `measure/settings_tuned` event. Nothing is applied but by a person's press
 * (`TuneService.apply`). The bare `sekhemet tune` stays the stopping-policy
 * replay (`tune.ts`, MS-T8-11).
 */

export const MEASURE_SETTINGS_TUNED = "measure/settings_tuned";

/** Items the halving runs on, per role: the hardest of its screen (rule 38). */
export const HARD_SUBSET: Partial<Record<ModelRole, number>> = { worker: 4, reviewer: 5 };

/**
 * The candidate values per role (design values from the research digest,
 * MODEL_SETTINGS_2026-10 §2–3): each changes one value of the incumbent,
 * among the values a run applies without its own load (rule 39).
 */
export const TUNE_SPACE: Partial<Record<ModelRole, readonly RunSettings[]>> = {
  worker: [
    { temperature: 0.2 },
    { temperature: 0.6 },
    { temperature: 1 },
    { reasoningPolicy: "off" },
    { reasoningPolicy: "surgical" },
    { method: "strict" },
    { evidenceGate: "on" },
  ],
  // R3c's arms among them; the Review model reviews at temperature 0.
  reviewer: [
    { reasoningLevel: "low", reasoningCapTokens: 2048 },
    { reasoningLevel: "medium", reasoningCapTokens: 4096 },
    { reasoningLevel: "medium", reasoningCapTokens: 8192 },
    { reasoningLevel: "high", reasoningCapTokens: 8192 },
  ],
};

const ROLE_WORDS: Record<ModelRole, string> = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/** A Find best settings refusal before anything loads (MS-N7-1, -2). */
export class TuneRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuneRefusal";
  }
}

export interface TuneCandidate {
  id: string;
  /** The values it changes from the incumbent; empty for the incumbent. */
  override: RunSettings;
  /** The values it runs at, in full where known (the incumbent's are the role's now). */
  values: RunSettings;
  incumbent?: boolean;
  words: string;
}

const defined = (v: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));

/** A candidate's id from what it changes: `temperature-0.2`; the incumbent is `current`. */
export function candidateId(override: RunSettings): string {
  const parts = Object.entries(defined(override)).map(([k, v]) => `${k}-${String(v)}`);
  return parts.length ? parts.join("+") : "current";
}

/** The incumbent first, then each candidate that changes something (rule 38). */
export function candidatesFor(role: ModelRole, incumbent: RunSettings): TuneCandidate[] {
  const now = defined(incumbent) as RunSettings;
  const out: TuneCandidate[] = [
    { id: "current", override: {}, values: now, incumbent: true, words: "the current settings" },
  ];
  for (const variant of TUNE_SPACE[role] ?? []) {
    const changes = Object.entries(variant).some(
      ([k, v]) => (now as Record<string, unknown>)[k] !== v,
    );
    if (!changes) continue;
    out.push({
      id: candidateId(variant),
      override: { ...variant },
      values: { ...now, ...variant },
      words: settingsWords(variant),
    });
  }
  return out;
}

/**
 * The hard subset (rule 38): the screen's items this model scored lowest
 * first (a recorded score under 1), then the unrecorded by the longest
 * reference time, then the ones it solved; `HARD_SUBSET[role]` of them.
 */
export function hardSubset(
  role: ModelRole,
  set: ScreeningSet,
  recorded: readonly ItemScore[] = [],
): ScreeningItem[] {
  const scoreOf = new Map(recorded.map((r) => [r.id, r.score]));
  const rank = (i: ScreeningItem) => {
    const s = scoreOf.get(i.id);
    return s === undefined ? 1 : s < 1 ? 0 : 2;
  };
  const ordered = set.items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        rank(a.item) - rank(b.item) ||
        (scoreOf.get(a.item.id) ?? 0) - (scoreOf.get(b.item.id) ?? 0) ||
        (b.item.referenceSeconds ?? 0) - (a.item.referenceSeconds ?? 0) ||
        a.index - b.index,
    )
    .map((x) => x.item);
  return ordered.slice(0, HARD_SUBSET[role] ?? Math.min(5, ordered.length));
}

/**
 * Successive halving's rungs (η = 2): every candidate on 1 item, the better
 * half on 2, then 4, … until one candidate is left or the subset is used up
 * (MS-N7-3: 7 candidates on 4 items run 7, 4, then 2).
 */
export function halvingRungs(
  candidates: number,
  items: number,
): { items: number; candidates: number }[] {
  const rungs: { items: number; candidates: number }[] = [];
  let n = candidates;
  let budget = 1;
  while (n > 1 && items > 0) {
    const it = Math.min(budget, items);
    rungs.push({ items: it, candidates: n });
    if (it >= items) break;
    n = Math.ceil(n / 2);
    budget *= 2;
  }
  return rungs;
}

export type TuneVerdict = "best" | "cheaper" | "no_clear_difference" | "worse" | "partial";

/**
 * The survivor against the incumbent on the whole screen (MS-N7-4,
 * PROMPT_STANDARD 35.4): best on a resolved gain; worse on a resolved loss;
 * cheaper when unresolved and its seconds per item are lower by a one-sided
 * paired Wilcoxon at 0.05; otherwise no clear difference.
 */
export function settingsVerdict(
  survivor: { items: readonly ItemScore[]; seconds: readonly number[] },
  incumbent: { items: readonly ItemScore[]; seconds: readonly number[] },
): {
  verdict: Exclude<TuneVerdict, "partial">;
  comparison: { better: number; worse: number; ties: number; p: number };
  wilcoxonP?: number;
} {
  const c = compareOnItems(
    "worker",
    { model: "survivor", items: survivor.items },
    { model: "incumbent", items: incumbent.items },
  );
  const comparison = { better: c.better, worse: c.worse, ties: c.ties, p: c.p };
  if (!c.indistinguishable) return { verdict: c.better > c.worse ? "best" : "worse", comparison };
  const theirs = new Map(incumbent.items.map((i, k) => [i.id, incumbent.seconds[k]]));
  const diffs = survivor.items.flatMap((i, k) => {
    const a = survivor.seconds[k];
    const b = theirs.get(i.id);
    return a === undefined || b === undefined ? [] : [a - b];
  });
  const wilcoxonP = wilcoxonSignedRankLess(diffs);
  return {
    verdict: wilcoxonP < 0.05 ? "cheaper" : "no_clear_difference",
    comparison,
    wilcoxonP,
  };
}

/** Each item's fixed seed, the same for every candidate (rule 10). */
const seedOf = (item: string) =>
  Number.parseInt(createHash("sha256").update(item).digest("hex").slice(0, 7), 16);

/**
 * DEC-42's reading before a load: swap in use, and the share of memory free
 * as the host reports it — `memory_pressure -Q`'s free percentage on macOS
 * (the reading CLAUDE.md names), MemAvailable on Linux, else the free share.
 */
export function dec42HostReading(): { swapUsedBytes: number; freeRatio: number } {
  return { swapUsedBytes: readSwapUsedBytes() ?? 0, freeRatio: readHostFreeRatio() };
}

// ── one run ─────────────────────────────────────────────────────────────

/** One candidate's measured items. */
export interface CandidateResult {
  id: string;
  values: RunSettings;
  override: RunSettings;
  incumbent: boolean;
  items: { id: string; score: number; seconds: number }[];
  score?: number;
  secondsPerItem?: number;
}

export interface TuneResult {
  runId: string;
  role: ModelRole;
  model: string;
  candidates: CandidateResult[];
  rungs: { items: number; candidates: string[] }[];
  incumbent: string;
  survivor?: string;
  comparison?: { better: number; worse: number; ties: number; p: number };
  wilcoxonP?: number;
  verdict: TuneVerdict;
  adopted?: RunSettings;
  partial: boolean;
  eventSeq: number;
}

export interface TuneInput {
  log: EventLog;
  runId: string;
  role: ModelRole;
  model: string;
  host: string;
  set: ScreeningSet;
  candidates: TuneCandidate[];
  subset: ScreeningItem[];
  runner: ScreenRunner;
  measurementRun: <T>(run: () => Promise<T>) => Promise<T>;
  principal?: string;
  shouldStop?: () => boolean;
  onProgress?: (p: { rung: number; candidatesLeft: number; done: number }) => void;
}

class Stopped extends Error {}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** A record of values as the ledger takes them: numbers, choices and switches only. */
const recordValues = (v: RunSettings): Record<string, string | number | boolean> =>
  defined(v) as Record<string, string | number | boolean>;

/**
 * Screen the candidates (MS-N7-3), compare the survivor with the incumbent
 * (MS-N7-4) and record it (MS-N7-6); a Stop keeps what was scored and
 * records the run partial (MS-N7-5). The caller has checked DEC-42's limits
 * and holds the runner lease (MS-N7-2).
 */
export async function tuneSettings(input: TuneInput): Promise<TuneResult> {
  const { role, model, set } = input;
  const scored = new Map<string, Map<string, { score: number; seconds: number }>>(
    input.candidates.map((c) => [c.id, new Map()]),
  );
  const rungs: TuneResult["rungs"] = [];
  let done = 0;
  let rungAt = 0;
  let alive = input.candidates;
  const runOne = async (c: TuneCandidate, item: ScreeningItem) => {
    const mine = scored.get(c.id) as Map<string, { score: number; seconds: number }>;
    const have = mine.get(item.id);
    if (have) return have;
    if (input.shouldStop?.()) throw new Stopped();
    const r = await input.runner.runItem({
      role,
      model,
      item,
      capSeconds: set.capSeconds,
      settings: { ...c.override, seed: seedOf(item.id) },
    });
    const v = { score: scoreItem(r.outcome), seconds: r.seconds };
    mine.set(item.id, v);
    done++;
    input.onProgress?.({ rung: rungAt, candidatesLeft: alive.length, done });
    return v;
  };
  const meanOver = (c: TuneCandidate, items: readonly ScreeningItem[]) => {
    const mine = scored.get(c.id) as Map<string, { score: number; seconds: number }>;
    const xs = items.map((i) => mine.get(i.id)).filter((x) => x !== undefined);
    return { score: mean(xs.map((x) => x.score)), seconds: mean(xs.map((x) => x.seconds)) };
  };
  const order = new Map(input.candidates.map((c, i) => [c.id, i]));
  const better = (items: readonly ScreeningItem[]) => (a: TuneCandidate, b: TuneCandidate) => {
    const x = meanOver(a, items);
    const y = meanOver(b, items);
    return (
      y.score - x.score ||
      x.seconds - y.seconds ||
      Number(b.incumbent === true) - Number(a.incumbent === true) ||
      (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
    );
  };

  let verdict = "partial" as TuneVerdict;
  let survivor: TuneCandidate | undefined;
  let outcome: ReturnType<typeof settingsVerdict> | undefined;
  let failure: unknown;
  try {
    await input.measurementRun(async () => {
      try {
        await input.runner.load(role, model);
        const plan = halvingRungs(alive.length, input.subset.length);
        for (const [k, g] of plan.entries()) {
          rungAt = k + 1;
          const items = input.subset.slice(0, g.items);
          // Item by item, every candidate on it: the candidates interleave (rule 10).
          for (const item of items) for (const c of alive) await runOne(c, item);
          rungs.push({ items: g.items, candidates: alive.map((c) => c.id) });
          const keep = k === plan.length - 1 ? 1 : (plan[k + 1]?.candidates ?? 1);
          alive = [...alive].sort(better(items)).slice(0, keep);
        }
        survivor = alive[0] ?? input.candidates[0];
        const incumbent = input.candidates[0] as TuneCandidate;
        if (survivor && !survivor.incumbent) {
          // The whole screen, paired with the incumbent (rule 35).
          for (const item of set.items) {
            await runOne(survivor, item);
            await runOne(incumbent, item);
          }
          const of = (c: TuneCandidate) => {
            const mine = scored.get(c.id) as Map<string, { score: number; seconds: number }>;
            const rows = set.items.map((i) => ({
              id: i.id,
              ...(mine.get(i.id) ?? { score: 0, seconds: 0 }),
            }));
            return {
              items: rows.map((r) => ({ id: r.id, score: r.score })),
              seconds: rows.map((r) => r.seconds),
            };
          };
          outcome = settingsVerdict(of(survivor), of(incumbent));
          verdict = outcome.verdict;
        } else verdict = "no_clear_difference";
      } finally {
        await input.runner.release?.();
      }
    });
  } catch (err) {
    if (!(err instanceof Stopped)) failure = err;
    verdict = "partial";
  }
  const partial = verdict === "partial";
  const candidates: CandidateResult[] = input.candidates.map((c) => {
    const items = [...(scored.get(c.id) ?? new Map()).entries()].map(([id, v]) => ({
      id,
      score: v.score,
      seconds: v.seconds,
    }));
    return {
      id: c.id,
      values: c.incumbent ? c.values : c.override,
      override: c.override,
      incumbent: c.incumbent === true,
      items,
      ...(items.length
        ? {
            score: round3(mean(items.map((i) => i.score))),
            secondsPerItem: Math.round(mean(items.map((i) => i.seconds)) * 10) / 10,
          }
        : {}),
    };
  });
  const adopted =
    !partial && (verdict === "best" || verdict === "cheaper") && survivor
      ? { ...survivor.override }
      : undefined;
  const event = await input.log.append({
    actor: input.principal ? "human" : "harness",
    ...(input.principal ? { principal: input.principal } : {}),
    type: MEASURE_SETTINGS_TUNED,
    payload: {
      runId: input.runId,
      kind: "find_best",
      role,
      model,
      host: input.host,
      ...(set.hash ? { setHash: set.hash } : {}),
      candidates: candidates.map((c) => ({
        id: c.id,
        values: recordValues(c.values),
        items: c.items,
        ...(c.score !== undefined ? { score: c.score } : {}),
        ...(c.secondsPerItem !== undefined ? { secondsPerItem: c.secondsPerItem } : {}),
      })),
      rungs,
      incumbent: "current",
      ...(!partial && survivor ? { survivor: survivor.id } : {}),
      ...(!partial && outcome ? { comparison: outcome.comparison } : {}),
      ...(!partial && outcome?.wilcoxonP !== undefined ? { wilcoxonP: outcome.wilcoxonP } : {}),
      verdict,
      ...(adopted ? { adopted: recordValues(adopted) } : {}),
      partial,
    },
  });
  if (failure) throw failure;
  return {
    runId: input.runId,
    role,
    model,
    candidates,
    rungs,
    incumbent: "current",
    ...(!partial && survivor ? { survivor: survivor.id } : {}),
    ...(!partial && outcome ? { comparison: outcome.comparison } : {}),
    ...(!partial && outcome?.wilcoxonP !== undefined ? { wilcoxonP: outcome.wilcoxonP } : {}),
    verdict,
    ...(adopted ? { adopted } : {}),
    partial,
    eventSeq: event.seq,
  };
}

// ── the service the page and the terminal share ─────────────────────────

/** A Find best settings run as the page reads it (PM_CONTRACT §3). */
export interface TuneRun {
  runId: string;
  role: ModelRole;
  model: string;
  state: "running" | "done" | "stopped" | "failed";
  rung?: number;
  candidatesLeft?: number;
  verdict?: TuneVerdict;
  survivor?: { id: string; values: RunSettings; words: string };
  /**
   * The setting to settle overnight against the current one (MS-N7-8): the
   * survivor, or when the current settings survived, the best other candidate.
   */
  contender?: { id: string; values: RunSettings; words: string };
  comparison?: { better: number; worse: number; ties: number; p: number };
  wilcoxonP?: number;
  adopted?: RunSettings;
  applied?: boolean;
  partial: boolean;
  date: string;
  error?: string;
}

interface TunedPayload {
  runId: string;
  kind: string;
  role: ModelRole;
  model: string;
  candidates: { id: string; values: RunSettings; score?: number }[];
  survivor?: string;
  comparison?: TuneRun["comparison"];
  wilcoxonP?: number;
  verdict: TuneVerdict;
  adopted?: RunSettings;
  partial: boolean;
}

interface TuneLive {
  runId: string;
  role: ModelRole;
  model: string;
  stop: boolean;
  started: string;
  rung?: number;
  candidatesLeft?: number;
  error?: string;
}

/** Find best settings for the page and the terminal (rule 38). */
export class TuneService {
  private readonly live = new Map<string, TuneLive>();
  private readonly failed = new Map<string, TuneLive>();

  constructor(private readonly env: BenchmarkEnv) {}

  private now(): Date {
    return this.env.now?.() ?? new Date();
  }

  /** The role's set, refused when it is not built (MS-N7-1). */
  private setFor(role: ModelRole): ScreeningSet {
    const set = this.env.sets().roles[role];
    if (set.state !== "ready" || !set.hash)
      throw new TuneRefusal(
        `The ${ROLE_WORDS[role]}'s screen is not built, so its settings cannot be tuned yet: ${set.reason ?? "its set is missing"}.`,
      );
    if (!TUNE_SPACE[role]?.length)
      throw new TuneRefusal(
        `Find best settings has no candidate settings for the ${ROLE_WORDS[role]} yet; it tunes the Coding and Review models.`,
      );
    return set;
  }

  /** Each role: whether Find best settings can tune it, and why not (MS-N7-1). */
  public roleStates(): Record<ModelRole, { tunable: boolean; reason?: string }> {
    const out = {} as Record<ModelRole, { tunable: boolean; reason?: string }>;
    for (const role of ROLES) {
      try {
        this.setFor(role);
        out[role] = { tunable: true };
      } catch (err) {
        out[role] = { tunable: false, reason: (err as Error).message };
      }
    }
    return out;
  }

  private candidates(role: ModelRole, model: string): TuneCandidate[] {
    return candidatesFor(role, this.env.incumbent?.(role, model) ?? {});
  }

  /** The candidates and the minutes it would take (MS-N7-1); runs nothing. */
  public async estimate(
    role: ModelRole,
    model: string,
  ): Promise<{
    role: ModelRole;
    model: string;
    candidates: { id: string; values: RunSettings; words: string }[];
    minutes: number;
    refused?: string;
  }> {
    let set: ScreeningSet;
    try {
      set = this.setFor(role);
    } catch (err) {
      return { role, model, candidates: [], minutes: 0, refused: (err as Error).message };
    }
    const candidates = this.candidates(role, model);
    const subset = Math.min(HARD_SUBSET[role] ?? 5, set.items.length);
    const plan = halvingRungs(candidates.length, subset);
    let runs = 0;
    let before = 0;
    for (const g of plan) {
      runs += g.candidates * (g.items - before);
      before = g.items;
    }
    // The final comparison at worst: both on the rest of the screen, the incumbent catching up.
    runs += 2 * Math.max(0, set.items.length - before) + Math.max(0, before - 1);
    const t = await this.env.throughput();
    const per = Math.min(t.secondsPerItem(role, model)?.seconds ?? set.capSeconds, set.capSeconds);
    const load = t.loadSeconds(model)?.seconds ?? DEFAULT_LOAD_SECONDS;
    return {
      role,
      model,
      candidates: candidates.map((c) => ({
        id: c.id,
        values: c.incumbent ? c.values : c.override,
        words: c.words,
      })),
      minutes: Math.round(((runs * per + load) / 60) * 10) / 10,
    };
  }

  /**
   * Start a run (MS-N7-1, -2): refused before anything loads for a role
   * whose screen is not built, a host over DEC-42's limits, or another run
   * holding the runner; then the run, its lease released at its end.
   */
  public async start(
    role: ModelRole,
    model: string,
    principal?: string,
  ): Promise<{ run: TuneRun; finished: Promise<TuneResult> }> {
    const set = this.setFor(role);
    const candidates = this.candidates(role, model);
    const runnerOf = this.env.screenRunner;
    if (!runnerOf)
      throw new TuneRefusal("The screening runner is not wired on this build, so nothing can run.");
    const reading = await (this.env.hostReading ?? dec42HostReading)();
    const host = dec42HostCheck(reading);
    if (!host.ok)
      throw new TuneRefusal(
        `Not started: ${host.reason}. A model loads only while swap is under 4 GB and at least 60% of memory is free.`,
      );
    const lease = (
      this.env.lease ?? (() => acquireRunnerLease(this.env.repoPath, { kind: "benchmark" }))
    )();
    if ("holder" in lease)
      throw new TuneRefusal(
        typeof lease.holder === "string" ? lease.holder : leaseRefusal(lease.holder),
      );
    const runId = `tune_${randomBytes(6).toString("hex")}`;
    const live: TuneLive = { runId, role, model, stop: false, started: this.now().toISOString() };
    this.live.set(runId, live);
    const recorded = (await readQuickScores(this.env.log, { role, model })).at(-1)?.items ?? [];
    const finished = (async () => {
      try {
        return await tuneSettings({
          log: this.env.log,
          runId,
          role,
          model,
          host: this.env.host,
          set,
          candidates,
          subset: hardSubset(role, set, recorded),
          runner: runnerOf(),
          measurementRun: this.env.measurementRun,
          ...(principal ? { principal } : {}),
          shouldStop: () => live.stop,
          onProgress: (p) => {
            live.rung = p.rung;
            live.candidatesLeft = p.candidatesLeft;
          },
        });
      } catch (err) {
        this.failed.set(runId, {
          ...live,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        this.live.delete(runId);
        lease.release();
      }
    })();
    finished.catch(() => undefined);
    return { run: this.liveRun(live), finished };
  }

  private liveRun(l: TuneLive): TuneRun {
    return {
      runId: l.runId,
      role: l.role,
      model: l.model,
      state: "running",
      ...(l.rung !== undefined ? { rung: l.rung } : {}),
      ...(l.candidatesLeft !== undefined ? { candidatesLeft: l.candidatesLeft } : {}),
      partial: false,
      date: l.started,
    };
  }

  /** A person's Stop (MS-N7-5): the run ends at its current item's end, keeping what it scored. */
  public async stop(runId: string): Promise<{ run: TuneRun | undefined }> {
    const live = this.live.get(runId);
    if (live) live.stop = true;
    return { run: await this.run(runId) };
  }

  /** Every run, newest first: the running ones, then the recorded ones. */
  public async runs(filter: { role?: ModelRole } = {}): Promise<TuneRun[]> {
    const events = await this.env.log.getEventsByTypes([
      MEASURE_SETTINGS_TUNED,
      "models/settings_changed",
    ]);
    const out: TuneRun[] = [...this.live.values()].map((l) => this.liveRun(l));
    for (const e of events) {
      if (e.type !== MEASURE_SETTINGS_TUNED) continue;
      const p = e.payload as TunedPayload;
      if (p.kind !== "find_best") continue;
      const surv = p.candidates.find((c) => c.id === p.survivor);
      const others = p.candidates
        .filter((c) => c.id !== "current" && c.score !== undefined)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const contender = surv && surv.id !== "current" ? surv : others[0];
      const failed = this.failed.get(p.runId);
      const adoptedKeys = Object.keys(p.adopted ?? {})
        .sort()
        .join(",");
      const applied =
        p.adopted !== undefined &&
        events.some((x) => {
          if (x.type !== "models/settings_changed" || x.seq < e.seq) return false;
          const c = x.payload as { model: string; role: string; action: string; keys: string[] };
          return (
            c.model === p.model &&
            c.role === p.role &&
            c.action === "set" &&
            [...c.keys].sort().join(",") === adoptedKeys
          );
        });
      out.push({
        runId: p.runId,
        role: p.role,
        model: p.model,
        state: failed ? "failed" : p.partial ? "stopped" : "done",
        verdict: p.verdict,
        ...(surv
          ? {
              survivor: {
                id: surv.id,
                values: surv.id === "current" ? {} : surv.values,
                words: surv.id === "current" ? "the current settings" : settingsWords(surv.values),
              },
            }
          : {}),
        ...(contender && !p.partial
          ? {
              contender: {
                id: contender.id,
                values: contender.values,
                words: settingsWords(contender.values),
              },
            }
          : {}),
        ...(p.comparison ? { comparison: p.comparison } : {}),
        ...(p.wilcoxonP !== undefined ? { wilcoxonP: p.wilcoxonP } : {}),
        ...(p.adopted ? { adopted: p.adopted, applied } : {}),
        partial: p.partial,
        date: e.createdAt,
        ...(failed?.error ? { error: failed.error } : {}),
      });
    }
    const runs = filter.role ? out.filter((r) => r.role === filter.role) : out;
    return runs.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  public async run(runId: string): Promise<TuneRun | undefined> {
    return (await this.runs()).find((r) => r.runId === runId);
  }

  /**
   * Apply (MS-N7-7): a best or cheaper run's adopted values become the
   * person's values for the model in that role, recorded with their
   * principal; refused for a run with nothing to apply.
   */
  public async apply(
    runId: string,
    principal: string,
  ): Promise<{ run: TuneRun; applied: RunSettings; needsVerifying: boolean }> {
    const run = await this.run(runId);
    if (!run) throw new TuneRefusal(`No Find best settings run ${runId}.`);
    if (run.state === "running")
      throw new TuneRefusal("This run is still going: apply it when it ends.");
    if (run.partial || run.verdict === "partial")
      throw new TuneRefusal("This run stopped before a verdict, so it has nothing to apply.");
    if (!run.adopted || Object.keys(run.adopted).length === 0)
      throw new TuneRefusal(
        "No clear difference: this run found nothing better than the current settings, so there is nothing to apply.",
      );
    const values = run.adopted as RoleSettingValues;
    if (!this.env.applySettings)
      throw new TuneRefusal("Apply is not wired on this build: no settings were changed.");
    const { needsVerifying } = this.env.applySettings(run.model, run.role, values, principal);
    await this.env.log.append({
      actor: "human",
      principal,
      type: "models/settings_changed",
      payload: {
        model: run.model,
        role: run.role,
        action: "set",
        keys: Object.keys(values),
        needsVerifying,
        principal,
      },
    });
    return { run: (await this.run(runId)) as TuneRun, applied: run.adopted, needsVerifying };
  }
}

// ── `sekhemet tune settings` ────────────────────────────────────────────

const flag = (args: readonly string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The one role type (MD-N4-1). */
const ROLES: readonly ModelRole[] = MODEL_ROLES;

/**
 * `sekhemet tune settings --role <role> [--model <id>] [--yes]` and
 * `sekhemet tune settings --apply <runId>` (rule 38). Without `--yes` it
 * shows the candidates and the estimate and runs nothing. Returns the exit
 * code.
 */
export async function tuneSettingsCommand(
  args: readonly string[],
  env: BenchmarkEnv,
  print: (line: string) => void,
  principal: string,
): Promise<number> {
  const svc = new TuneService(env);
  const usage =
    "Usage: sekhemet tune settings --role worker|reviewer [--model <id>] [--yes]\n       sekhemet tune settings --apply <runId>";
  try {
    const applyId = flag(args, "--apply");
    if (args.includes("--apply")) {
      if (!applyId) {
        print(usage);
        return 2;
      }
      const out = await svc.apply(applyId, principal);
      print(
        `Applied ${settingsWords(out.applied)} to the ${ROLE_WORDS[out.run.role]}'s settings for ${out.run.model}.${out.needsVerifying ? " The role needs verifying on this machine before the agent uses it: Configuration › Models › Verify now." : ""}`,
      );
      return 0;
    }
    const role = flag(args, "--role") as ModelRole | undefined;
    if (!role || !ROLES.includes(role)) {
      print(usage);
      return 2;
    }
    const model =
      flag(args, "--model") ?? roleModelName(role, undefined, { registry: new ModelRegistry() });
    if (!model) {
      print(`No ${ROLE_WORDS[role]} is assigned: name one with --model <id>.`);
      return 1;
    }
    const est = await svc.estimate(role, model);
    if (est.refused) {
      print(est.refused);
      return 1;
    }
    print(
      `Find best settings for the ${ROLE_WORDS[role]} ${model}: ${est.candidates.length} settings to try, the current ones included:`,
    );
    for (const c of est.candidates) print(`  ${c.words}`);
    print(
      `It takes about ${est.minutes} min, one load included: successive halving on the hardest items, then the best against the current settings on the whole screen.`,
    );
    if (!args.includes("--yes")) {
      print("Nothing has been loaded. Run it with --yes to start Find best settings.");
      return 0;
    }
    const started = await svc.start(role, model, principal);
    print(`Find best settings run ${started.run.runId} started.`);
    const onInt = () => void svc.stop(started.run.runId);
    process.once("SIGINT", onInt);
    try {
      const r = await started.finished;
      print(
        settingsTunedLine({
          role,
          model,
          verdict: r.verdict,
          ...(r.adopted ? { adopted: r.adopted } : {}),
          ...(r.comparison ? { comparison: r.comparison } : {}),
        }),
      );
      if (r.adopted) print(`Apply it with: sekhemet tune settings --apply ${r.runId}`);
    } finally {
      process.removeListener("SIGINT", onInt);
    }
    return 0;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
