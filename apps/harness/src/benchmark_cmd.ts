import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCH_EVENTS,
  type BenchRun,
  BenchmarkRefusal,
  type CacheKey,
  type Combination,
  type CombinationResult,
  type FitCheck,
  HOURS_PER_COMBINATION,
  MEASURE_BENCHMARKED,
  type NightEstimate,
  type OvernightRunner,
  type OvernightSets,
  type QuickResult,
  type RoleScore,
  type RunFingerprint,
  type RunProfile,
  type ScreenEstimate,
  type ScreenRunner,
  type ScreeningSets,
  type Throughput,
  type WindowState,
  benchmarkRuns,
  benchmarkedResult,
  cacheKeyString,
  combinationId,
  combinationResults,
  defaultOvernightPicks,
  estimateNight,
  estimateScreen,
  modelFor,
  morningReport,
  newRunId,
  quickBenchmark,
  quickEvents,
  readQuickScores,
  runDefinition,
  runOvernightBench,
  scheduleOvernight,
} from "@sekhemet/eval";
import {
  loadFrozenSuite,
  loadScreeningSets,
  recordedThroughput,
  resolveRunProfile,
  verifyAsset,
} from "@sekhemet/eval";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { MODEL_ROLES, type ModelRole, hostFingerprintHash } from "@sekhemet/models";
import {
  type SuiteRunnerDeps,
  suiteOvernightRunner,
  suiteScreenRunner,
} from "./benchmark_runner.js";
import { effectiveConfig } from "./config_apply.js";
import { type BenchmarkLease, type ModelAccess, sharedModelAccess } from "./model_access.js";
import { workerContextVersion } from "./qualify.js";
import { reservationNow } from "./reservation.js";
import { acquireRunnerLease, leaseRefusal } from "./runner_lease.js";
import { isReserved, parseHours } from "./scheduler.js";
import { modelRegistry } from "./wave2.js";

/**
 * `sekhemet benchmark` and the service the Configuration page shares with it
 * (measurement NEW-measurement-5, MS-N5-1–12; models rule 20b, MD-N3-4/5;
 * PM_CONTRACT §3 *Configuration*, the two-tier benchmark).
 *
 * - The **quick** tier starts now, under the runner lease (a second runner
 *   is refused, naming the holder), and only after its estimate was shown.
 * - The **overnight** tier is queued; `overnight` runs it through the hook
 *   before its queue (a benchmark the person put first) and after it (the
 *   default: the backlog goes first), only inside the overnight window — the
 *   complement of `[machine] reserved_hours`, narrowed by `overnight_hours` —
 *   never while reserved, not even when the person is idle, and never while
 *   a card holds the runner.
 * - Start and stop are ledger events (`measure/benchmark_started`,
 *   `measure/benchmark_stopped`); every model run goes through
 *   `measurementRun` (Smart Swap's `withMeasurementRun`, DEC-45).
 * - Nothing here assigns a model (DB-N6-13).
 */

// ── the overnight window (models rule 20b, MD-N3-4) ─────────────────────

export interface OvernightWindow extends WindowState {
  /** When the next window opens (ms), when closed now. */
  nextStart?: number;
  /** Tonight's (or the current) window as the page shows it, e.g. "22:00–03:00". */
  label?: string;
  start?: string;
  end?: string;
  hours?: number;
}

const MINUTE = 60_000;
const hhmm = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * Whether the overnight benchmark may run now (MD-N3-4): outside the
 * reserved hours and inside `overnight_hours` when set, with no reserve-now
 * and no card holding the runner. There is no idle exception (rule 20b).
 */
export function overnightWindow(o: {
  now: Date;
  reservedHours: string;
  overnightHours?: string;
  reservedNow?: boolean;
  cardRunning?: boolean;
}): OvernightWindow {
  const reserved = parseHours(o.reservedHours);
  const narrowed = o.overnightHours ? parseHours(o.overnightHours) : undefined;
  const inWindow = (t: Date) => !isReserved(reserved, t) && (!narrowed || isReserved(narrowed, t));
  const t0 = new Date(Math.floor(o.now.getTime() / MINUTE) * MINUTE);
  const scan = (from: Date, want: boolean, limitMin: number, step = 1): Date | undefined => {
    for (let m = 0; m <= limitMin; m++) {
      const t = new Date(from.getTime() + step * m * MINUTE);
      if (inWindow(t) === want) return t;
    }
    return undefined;
  };
  const open = inWindow(t0);
  const week = 7 * 24 * 60;
  const start = open
    ? new Date((scan(t0, false, 24 * 60, -1)?.getTime() ?? t0.getTime() - MINUTE) + MINUTE)
    : scan(t0, true, week);
  const end = start ? scan(start, false, week) : undefined;
  const shape =
    start && end
      ? {
          start: hhmm(start),
          end: hhmm(end),
          label: `${hhmm(start)}–${hhmm(end)}`,
          hours: Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10) / 10,
        }
      : {};
  if (o.reservedNow)
    return {
      open: false,
      reason: "reserved",
      why: "a person has reserved the machine now",
      ...shape,
    };
  if (o.cardRunning)
    return { open: false, reason: "reserved", why: "a card holds the runner", ...shape };
  if (open)
    return {
      open: true,
      why: "inside the overnight window",
      ...(end ? { endsAt: end.getTime() } : {}),
      ...shape,
    };
  const why =
    narrowed && !isReserved(reserved, t0)
      ? `outside [machine] overnight_hours (${o.overnightHours})`
      : `the reserved hours ${o.reservedHours} are on; the benchmark never runs inside them, even when the machine is idle`;
  return {
    open: false,
    reason: "window_end",
    why,
    ...(start ? { nextStart: start.getTime() } : {}),
    ...shape,
  };
}

// ── the service ─────────────────────────────────────────────────────────

export interface BenchmarkEnv {
  repoPath: string;
  log: EventLog;
  /** This host's fingerprint hash. */
  host: string;
  sets: () => ScreeningSets;
  overnightSets: () => OvernightSets;
  machine: () => { reservedHours: string; overnightHours?: string };
  fit: (role: ModelRole, model: string) => FitCheck;
  cacheKey: (role: ModelRole, model: string, setHash: string) => CacheKey;
  throughput: () => Promise<Throughput>;
  runProfile: (c: Combination) => RunProfile;
  /** Smart Swap's `withMeasurementRun` (DEC-45): the policy bypassed, models unloaded after. */
  measurementRun: <T>(run: () => Promise<T>) => Promise<T>;
  /** Runs real screening items; absent until it is wired to a model (MS-N5-1's targets). */
  screenRunner?: () => ScreenRunner;
  overnightRunner?: () => OvernightRunner;
  fingerprint: () => RunFingerprint;
  now?: () => Date;
  /** Hours of tonight's backlog (MS-N5-9); default none. */
  backlogHours?: () => Promise<number>;
  /** Recorded hours per combination; default about 5 (rule 37). */
  hoursPerCombination?: () => Promise<number>;
  /** A card holds the runner (the overnight process's own rounds never overlap it). */
  cardRunning?: () => boolean;
  /** Take the runner lease for a quick run; default the repository's lease, kind `benchmark`. */
  lease?: () => { release: () => void } | { holder: string };
  /** A run changed: streamed as a `config` event `{ kind: "benchmark", run }`. */
  onChange?: (run: BenchRun) => void;
}

export class BenchmarkNotFound extends Error {
  constructor(runId: string) {
    super(`No benchmark run ${runId}.`);
    this.name = "BenchmarkNotFound";
  }
}

const ROLE_NAMES: Record<ModelRole, string> = {
  worker: "Worker",
  planner: "Planner",
  reviewer: "Reviewer",
  researcher: "Researcher",
};

/** The quick benchmark's copy (MS-N5-4a, DB-N6-9). */
export const QUICK_TIER_COPY =
  "The quick benchmark shows speed, fit and large differences; the overnight benchmark settles close calls.";

interface Live {
  stop: boolean;
  progress?: BenchRun["progress"];
}

export class BenchmarkService {
  private readonly live = new Map<string, Live>();

  constructor(private readonly env: BenchmarkEnv) {}

  private now(): Date {
    return this.env.now?.() ?? new Date();
  }

  /** The combination's key roles for the end-to-end cache. */
  private async cachedKeys(combination: Combination): Promise<Set<string>> {
    const cached = new Set((await readQuickScores(this.env.log)).map((s) => s.key));
    const sets = this.env.sets();
    const out = new Set<string>();
    for (const role of MODEL_ROLES) {
      const model = modelFor(combination, role);
      const hash = sets.roles[role].hash;
      if (!model || !hash) continue;
      const key = cacheKeyString(this.env.cacheKey(role, model, hash));
      if (cached.has(key)) out.add(`${role}\0${model}`);
    }
    return out;
  }

  /** MS-N5-1, DB-N6-9: minutes per role for the roles not cached; runs nothing. */
  public async estimateQuick(combination: Combination): Promise<ScreenEstimate> {
    const sets = this.env.sets();
    const cached = await this.cachedKeys(combination);
    const measurable = MODEL_ROLES.filter((r) => {
      const m = modelFor(combination, r);
      return m && sets.roles[r].state === "ready";
    });
    const allCached = measurable.every((r) => cached.has(`${r}\0${modelFor(combination, r)}`));
    let endToEndCached = false;
    if (allCached && measurable.length) {
      const id = combinationId(combination, this.env.host);
      endToEndCached = (await quickEvents(this.env.log)).some((e) => {
        const r = benchmarkedResult(e);
        return r?.combinationId === id && r.endToEnd !== undefined;
      });
    }
    return estimateScreen(combination, {
      sets,
      throughput: await this.env.throughput(),
      cached: (role, model) => cached.has(`${role}\0${model}`),
      endToEndCached,
      fit: this.env.fit,
    });
  }

  /** MS-N5-9: tonight's window and how many picked combinations fit it. */
  public async estimateOvernight(
    count: number,
    benchmarkFirst = false,
  ): Promise<NightEstimate & { window: OvernightWindow }> {
    const m = this.env.machine();
    const window = overnightWindow({
      now: this.now(),
      reservedHours: m.reservedHours,
      ...(m.overnightHours ? { overnightHours: m.overnightHours } : {}),
    });
    const est = estimateNight({
      combinations: count,
      hoursPerCombination: (await this.env.hoursPerCombination?.()) ?? HOURS_PER_COMBINATION,
      windowHours: window.hours ?? 0,
      backlogHours: (await this.env.backlogHours?.()) ?? 0,
      benchmarkFirst,
      ...(window.label ? { windowLabel: window.label } : {}),
    });
    return { ...est, window };
  }

  /**
   * Start a quick screen now (PM_CONTRACT *Start*): refused, before anything
   * loads, for a model that does not fit (with the GB it needs), when no
   * screening runner is wired, and while another runner holds the lease.
   */
  public async startQuick(
    combination: Combination,
    principal?: string,
  ): Promise<{ run: BenchRun; estimateSeconds: number; finished: Promise<QuickResult> }> {
    for (const role of MODEL_ROLES) {
      const model = modelFor(combination, role);
      if (!model) continue;
      const fit = this.env.fit(role, model);
      if (!fit.fits)
        throw new BenchmarkRefusal(
          `${model} does not fit this machine for the ${ROLE_NAMES[role]}: it needs ${fit.needsGb ?? "more"} GB, so it is not loaded or run.`,
          fit.needsGb,
        );
    }
    const runnerOf = this.env.screenRunner;
    if (!runnerOf)
      throw new BenchmarkRefusal(
        "The screening runner is not wired on this build: the quick benchmark runs real models, and its runner arrives with the first measured model load (MS-N5-1).",
      );
    const estimate = await this.estimateQuick(combination);
    const lease = (
      this.env.lease ?? (() => acquireRunnerLease(this.env.repoPath, { kind: "benchmark" }))
    )();
    if ("holder" in lease)
      throw new BenchmarkRefusal(
        typeof lease.holder === "string" ? lease.holder : leaseRefusal(lease.holder),
      );
    const runId = newRunId();
    const id = combinationId(combination, this.env.host);
    try {
      await this.env.log.append({
        actor: "human",
        ...(principal ? { principal } : {}),
        type: BENCH_EVENTS.started,
        payload: {
          runId,
          tier: "quick",
          state: "running",
          combinations: [{ id, models: modelsOf(combination) }],
          host: this.env.host,
          estimateSeconds: estimate.estimateSeconds,
        },
      });
    } catch (err) {
      lease.release();
      throw err;
    }
    const live: Live = { stop: false };
    this.live.set(runId, live);
    const total = estimate.toMeasure.reduce(
      (s, r) => s + this.env.sets().roles[r.role].items.length,
      0,
    );
    const finished = (async () => {
      try {
        const result = await quickBenchmark(combination, {
          log: this.env.log,
          sets: this.env.sets(),
          runner: runnerOf(),
          cacheKey: this.env.cacheKey,
          fit: this.env.fit,
          runProfile: this.env.runProfile(combination),
          host: this.env.host,
          measurementRun: this.env.measurementRun,
          now: () => this.now().getTime(),
          shouldStop: () => live.stop,
          onProgress: (p) => {
            live.progress = { ...p, combinationId: id };
            void this.notify(runId);
          },
        });
        const measured = result.itemRuns.length;
        await this.env.log.append({
          actor: "harness",
          type: BENCH_EVENTS.stopped,
          payload: {
            runId,
            tier: "quick",
            reason: live.stop ? "person" : "done",
            partial: result.partial,
            completed: measured,
            total: Math.max(total, measured),
          },
        });
        return result;
      } catch (err) {
        await this.env.log
          .append({
            actor: "harness",
            type: BENCH_EVENTS.stopped,
            payload: { runId, tier: "quick", reason: "failed", partial: true, completed: 0, total },
            private: { error: err instanceof Error ? err.message : String(err) },
          })
          .catch(() => undefined);
        throw err;
      } finally {
        this.live.delete(runId);
        lease.release();
        void this.notify(runId);
      }
    })();
    // A caller that does not await the run still sees its failure recorded.
    finished.catch(() => undefined);
    const run = (await this.run(runId)) as BenchRun;
    return { run, estimateSeconds: estimate.estimateSeconds, finished };
  }

  /** Queue an overnight comparison (MS-N5-9): up to 3 combinations, with tonight's fit. */
  public async scheduleOvernight(
    combinations: Combination[],
    principal: string | undefined,
    o: { benchmarkFirst?: boolean },
  ): Promise<{ run: BenchRun; estimate: NightEstimate & { window: OvernightWindow } }> {
    for (const c of combinations)
      for (const role of MODEL_ROLES) {
        const model = modelFor(c, role);
        if (!model) continue;
        const fit = this.env.fit(role, model);
        if (!fit.fits)
          throw new BenchmarkRefusal(
            `${model} does not fit this machine for the ${ROLE_NAMES[role]}: it needs ${fit.needsGb ?? "more"} GB.`,
            fit.needsGb,
          );
      }
    const estimate = await this.estimateOvernight(combinations.length, o.benchmarkFirst);
    const { runId } = await scheduleOvernight(this.env.log, {
      combinations,
      host: this.env.host,
      ...(principal ? { principal } : {}),
      benchmarkFirst: o.benchmarkFirst === true,
      estimateSeconds: Math.round(estimate.hoursNeeded * 3600),
    });
    const run = (await this.run(runId)) as BenchRun;
    void this.notify(runId);
    return { run, estimate };
  }

  /**
   * A person's Stop (DB-N6-10): a running run ends at its current item's end
   * with every result kept, marked partial; a queued overnight run is stopped
   * for good. Stopping a finished run changes nothing.
   */
  public async stop(runId: string, principal?: string): Promise<{ run: BenchRun }> {
    const live = this.live.get(runId);
    if (live) {
      live.stop = true;
      return { run: (await this.run(runId)) as BenchRun };
    }
    const run = await this.run(runId);
    if (!run) throw new BenchmarkNotFound(runId);
    if (run.state === "queued" || run.state === "running") {
      await this.env.log.append({
        actor: "human",
        ...(principal ? { principal } : {}),
        type: BENCH_EVENTS.stopped,
        payload: {
          runId,
          tier: run.tier,
          reason: "person",
          partial: (run.progress?.done ?? 0) > 0,
          completed: run.progress?.done ?? 0,
          total: run.progress?.total ?? 0,
        },
      });
      void this.notify(runId);
    }
    return { run: (await this.run(runId)) as BenchRun };
  }

  /** Every run, with live progress and each overnight run's schedule (DB-N6-10). */
  public async runs(): Promise<BenchRun[]> {
    const m = this.env.machine();
    const window = overnightWindow({
      now: this.now(),
      reservedHours: m.reservedHours,
      ...(m.overnightHours ? { overnightHours: m.overnightHours } : {}),
    });
    const hours = (await this.env.hoursPerCombination?.()) ?? HOURS_PER_COMBINATION;
    return (await benchmarkRuns(this.env.log)).map((r) => {
      const live = this.live.get(r.runId);
      const out: BenchRun = {
        ...r,
        ...(live ? { state: "running" as const } : {}),
        ...(live?.progress ? { progress: live.progress } : {}),
      };
      if (r.tier === "overnight" && window.start && window.end)
        out.schedule = {
          window: { start: window.start, end: window.end },
          fitsTonight: Math.min(r.combinations.length, Math.floor((window.hours ?? 0) / hours)),
          ...(window.nextStart ? { nextStart: new Date(window.nextStart).toISOString() } : {}),
        };
      return out;
    });
  }

  public async run(runId: string): Promise<BenchRun | undefined> {
    return (await this.runs()).find((r) => r.runId === runId);
  }

  /** PM_CONTRACT *Results*: runs, the latest result per combination and tier, and the cached role scores. */
  public async results(): Promise<{
    runs: BenchRun[];
    results: CombinationResult[];
    roleScores: RoleScore[];
  }> {
    const roleScores = (await readQuickScores(this.env.log)).map(
      ({ key: _k, setHash: _s, seq: _q, ...s }) => s,
    );
    return { runs: await this.runs(), results: await combinationResults(this.env.log), roleScores };
  }

  /** One combination's results of both tiers over time. */
  public async history(id: string): Promise<CombinationResult[]> {
    return (await this.env.log.getEventsByTypes([MEASURE_BENCHMARKED]))
      .map(benchmarkedResult)
      .filter((r): r is CombinationResult => r?.combinationId === id);
  }

  /**
   * One phase of the night for `overnight` (models rule 20b): `first` runs
   * the queued runs a person put first, before the queue; `after` runs every
   * run still queued, after the night's backlog. Returns what it said.
   */
  public async runNight(
    phase: "first" | "after",
    o: { say?: (line: string) => void } = {},
  ): Promise<string[]> {
    const lines: string[] = [];
    const say = (l: string) => {
      lines.push(l);
      o.say?.(l);
    };
    const queued = (await benchmarkRuns(this.env.log)).filter(
      (r) =>
        r.tier === "overnight" &&
        (r.state === "queued" || r.state === "running") &&
        !this.live.has(r.runId),
    );
    for (const r of queued) {
      const def = await runDefinition(this.env.log, r.runId);
      if (phase === "first" && !def?.benchmarkFirst) continue;
      const runner = this.env.overnightRunner?.();
      if (!runner) {
        say(
          `Overnight benchmark ${r.runId}: the overnight runner is not wired on this build; it stays queued.`,
        );
        continue;
      }
      const live: Live = { stop: false };
      this.live.set(r.runId, live);
      try {
        await runOvernightBench({
          log: this.env.log,
          runId: r.runId,
          runner,
          sets: this.env.overnightSets(),
          host: this.env.host,
          now: () => this.now().getTime(),
          window: () => this.window(),
          fingerprint: this.env.fingerprint(),
          runProfileFor: this.env.runProfile,
          measurementRun: this.env.measurementRun,
          shouldStop: () => live.stop,
          say,
        });
      } finally {
        this.live.delete(r.runId);
        void this.notify(r.runId);
      }
    }
    return lines;
  }

  /** The window now, with a reserve-now read from the ledger each time (RUN-58). */
  private async window(): Promise<WindowState> {
    const m = this.env.machine();
    const now = this.now();
    return overnightWindow({
      now,
      reservedHours: m.reservedHours,
      ...(m.overnightHours ? { overnightHours: m.overnightHours } : {}),
      reservedNow: (await reservationNow(this.env.log, now)).reserved,
      cardRunning: this.env.cardRunning?.() ?? false,
    });
  }

  private async notify(runId: string): Promise<void> {
    if (!this.env.onChange) return;
    const run = await this.run(runId).catch(() => undefined);
    if (run) this.env.onChange(run);
  }
}

const modelsOf = (c: Combination): Record<string, string> =>
  Object.fromEntries(
    MODEL_ROLES.flatMap((r) => {
      const m = modelFor(c, r);
      return m ? [[r, m]] : [];
    }),
  );

/** The interface (c) exports: start a quick screen through a service. */
export function startQuick(
  service: BenchmarkService,
  combination: Combination,
  principal?: string,
): ReturnType<BenchmarkService["startQuick"]> {
  return service.startQuick(combination, principal);
}

// ── the real environment ────────────────────────────────────────────────

/** Where the harness's own fixtures live (the screening sets, the frozen suite). */
const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** About two hours per 30-card suite run (the plan's machine time): four minutes a card. */
const HOURS_PER_BACKLOG_CARD = 4 / 60;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The benchmark's environment on this machine. `fit` is part (b)'s
 * `fitFor` over the scanned models (MS-N5-5) — without it every model is
 * taken to fit. The runners default to the frozen suite's machinery
 * (`benchmark_runner.ts`) with each role's model resolved as the queue
 * resolves it; tests pass scripted ones.
 */
export function defaultBenchmarkEnv(o: {
  repoPath: string;
  log: EventLog;
  cardStore?: CardStore;
  fit?: BenchmarkEnv["fit"];
  screenRunner?: BenchmarkEnv["screenRunner"];
  overnightRunner?: BenchmarkEnv["overnightRunner"];
  onChange?: BenchmarkEnv["onChange"];
  harnessRoot?: string;
  /** The one residency scheduler the benchmark loads through; the process's shared one by default. */
  modelAccess?: ModelAccess;
}): BenchmarkEnv {
  const root = o.harnessRoot ?? HARNESS_ROOT;
  const host = hostFingerprintHash();
  let registryCache: ReturnType<typeof modelRegistry> | undefined;
  const registry = () => {
    registryCache ??= modelRegistry();
    return registryCache;
  };
  const entry = (model: string) => registry().get(model);
  const runProfile = (c: Combination): RunProfile => {
    const base = resolveRunProfile({ env: process.env, argv: [] });
    return {
      ...base,
      roles: {
        worker: c.worker,
        manager: c.planner,
        ...(c.reviewer ? { reviewer: c.reviewer } : {}),
        ...(c.researcher ? { researcher: c.researcher } : {}),
      },
    };
  };
  // Models rule 20a (B4.1 half-B review): every model the benchmark loads goes
  // through the one residency scheduler, under the run's lease; while it runs
  // no other role loads, and it unloads only what it loaded.
  const access = () => o.modelAccess ?? sharedModelAccess();
  let lease: BenchmarkLease | undefined;
  const runnerDeps: SuiteRunnerDeps = {
    harnessRoot: root,
    workDir: join(o.repoPath, ".sekhemet", "benchmark-work"),
    // The combination's role assignment: each role's model, through the run's lease.
    adapterFor: (role, model) => {
      if (!lease)
        throw new Error(
          "A benchmark loads a model only inside its run, through the residency scheduler.",
        );
      return lease.load(role, model);
    },
    releaseModel: (role, model) => lease?.release(role, model) ?? Promise.resolve(),
    runProfile: (c) => (c ? runProfile(c) : resolveRunProfile({ env: process.env, argv: [] })),
  };
  return {
    repoPath: o.repoPath,
    log: o.log,
    host,
    sets: () => loadScreeningSets(root),
    overnightSets: () => {
      const suite = loadFrozenSuite(root);
      let planner: OvernightSets["roles"]["planner"] = {
        state: "not_built",
        runs: 1,
        cards: [],
        reason: "the planning measure needs the golden briefs labelled by a person",
      };
      try {
        verifyAsset(root, "golden-briefs");
        planner = {
          ...planner,
          reason: "the planning measure's runner is not wired on this build",
        };
      } catch {
        // stays not_built
      }
      return {
        roles: {
          worker: {
            state: "ready",
            runs: 2,
            cards: suite.tasks.map((t) => ({
              id: `${t.suite}/${t.cardId}`,
              role: "worker" as const,
            })),
          },
          planner,
          reviewer: { state: "not_built", runs: 1, cards: [], reason: "built in B4.8" },
          researcher: { state: "not_built", runs: 1, cards: [], reason: "built in B4.4" },
        },
      };
    },
    machine: () => {
      const m = effectiveConfig(o.repoPath).config.machine;
      return {
        reservedHours: m.reservedHours,
        ...(m.overnightHours ? { overnightHours: m.overnightHours } : {}),
      };
    },
    fit: o.fit ?? (() => ({ fits: true })),
    cacheKey: (_role, model, setHash) => {
      const e = entry(model);
      return {
        model,
        quantisation: e?.quant ?? "unknown",
        engine: e?.engine ?? "llama.cpp",
        settings: sha(
          JSON.stringify({
            context: e?.contextWindow ?? null,
            sampling: e?.sampling ?? null,
            template: e?.template?.checksum ?? null,
          }),
        ).slice(0, 16),
        host,
        contextVersion: workerContextVersion(),
        setHash,
      };
    },
    throughput: () => recordedThroughput(o.log),
    runProfile,
    measurementRun: (run) =>
      access().benchmarkRun(async (l) => {
        lease = l;
        try {
          return await run();
        } finally {
          lease = undefined;
        }
      }),
    // The frozen suite's machinery, card by card, with the combination's models.
    screenRunner: o.screenRunner ?? (() => suiteScreenRunner(runnerDeps)),
    overnightRunner: o.overnightRunner ?? (() => suiteOvernightRunner(runnerDeps)),
    fingerprint: () => {
      let build = "unknown";
      try {
        build = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      } catch {
        // not a git checkout: the build is unknown, and any later known build differs
      }
      const qualifications = registry()
        .list()
        .map((e) => [e.id, e.qualifications ?? []]);
      return {
        build: build.slice(0, 40) || "unknown",
        contextVersion: workerContextVersion(),
        qualification: sha(JSON.stringify(qualifications)).slice(0, 16),
      };
    },
    ...(o.cardStore
      ? {
          backlogHours: async () =>
            (await (o.cardStore as CardStore).listCards({ status: "ready" as never })).length *
            HOURS_PER_BACKLOG_CARD,
        }
      : {}),
    ...(o.onChange ? { onChange: o.onChange } : {}),
  };
}

// ── the command ─────────────────────────────────────────────────────────

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function combinationFrom(args: string[]): Combination | undefined {
  const worker = flag(args, "--worker");
  const planner = flag(args, "--planner");
  if (!worker || !planner) return undefined;
  const reviewer = flag(args, "--reviewer");
  const researcher = flag(args, "--researcher");
  return {
    worker,
    planner,
    ...(reviewer ? { reviewer } : {}),
    ...(researcher ? { researcher } : {}),
  };
}

/** `worker=a,planner=b[,reviewer=c][,researcher=d]` */
function parseCombination(spec: string): Combination | undefined {
  const kv = Object.fromEntries(
    spec.split(",").map((p) => p.split("=").map((x) => x.trim()) as [string, string]),
  );
  if (!kv.worker || !kv.planner) return undefined;
  return combinationFrom(Object.entries(kv).flatMap(([k, v]) => [`--${k}`, v]));
}

function estimateLines(e: ScreenEstimate, c: Combination): string[] {
  const lines = e.roles.map((r) => {
    const name = `${ROLE_NAMES[r.role]} ${r.model ?? "(none)"}`;
    switch (r.state) {
      case "cached":
        return `${name}: cached, not re-run`;
      case "not_measured":
        return `${name}: not measured yet (${r.reason})`;
      case "does_not_fit":
        return `${name}: needs ${r.needsGb ?? "more"} GB; not loaded`;
      default:
        return `${name}: ${r.minutes} min including ${r.loadMinutes} min to load${r.overTarget ? ` — over the ${r.targetMinutes}-minute target` : ""}`;
    }
  });
  lines.push(
    e.endToEnd.cached
      ? "End-to-end check: cached"
      : `End-to-end check: ${e.endToEnd.minutes} min${e.endToEnd.overTarget ? " — over the 10-minute target" : ""}`,
  );
  if (e.swapSecondsPerSwitch)
    lines.push(`The models cannot co-reside: about ${e.swapSecondsPerSwitch} s per role switch.`);
  lines.push(
    `Total for ${c.worker} + ${c.planner}: about ${e.totalMinutes} min${e.overTarget ? " (over target)" : ""}.`,
    QUICK_TIER_COPY,
  );
  return lines;
}

function resultLines(r: QuickResult): string[] {
  const lines = r.roles.map((s) => {
    const name = `${ROLE_NAMES[s.role as ModelRole] ?? s.role} ${s.model}`;
    if (s.state !== "measured" || !s.score)
      return `${name}: ${s.state === "partial" ? "partial — not scored on part of its set" : "not measured"}`;
    const sec = s.secondary;
    return `${name}: ${Math.round(s.score.value * 100) / 100} (${s.score.n} items, range ${s.score.low}–${s.score.high}${sec?.secondsPerItem !== undefined ? `; ${sec.secondsPerItem} s per item` : ""}${s.capped !== undefined ? `; ${s.capped} capped` : ""})`;
  });
  if (r.endToEnd)
    lines.push(
      `End-to-end check: ${r.endToEnd.passed}/${r.endToEnd.total} cards passed (beside the scores, not folded in).`,
    );
  for (const c of r.comparisons)
    lines.push(
      `${ROLE_NAMES[c.role as ModelRole] ?? c.role}: ${c.a} vs ${c.b} — ${c.indistinguishable ? "indistinguishable on the quick benchmark" : c.better > c.worse ? `${c.a} is better` : `${c.b} is better`} (${c.better} better, ${c.worse} worse, ${c.ties} tied; p = ${c.p.toFixed(3)})`,
    );
  if (r.partial)
    lines.push("Stopped: completed roles are kept and cached; the screen is recorded as partial.");
  return lines;
}

/**
 * `sekhemet benchmark estimate|quick|overnight|status|stop|report`. A quick
 * screen and an overnight queue both show their estimate and run nothing
 * without `--yes` (MS-N5-1, MS-N5-9). Returns the exit code.
 */
export async function benchmarkCommand(
  args: string[],
  env: BenchmarkEnv,
  print: (line: string) => void = (l) => console.log(l),
  principal?: string,
): Promise<number> {
  const [sub] = args;
  const service = new BenchmarkService(env);
  const usage =
    "Usage: sekhemet benchmark estimate|quick --worker <m> --planner <m> [--reviewer <m>] [--researcher <m>] [--yes]\n" +
    "       sekhemet benchmark overnight [--combination worker=<m>,planner=<m>[,...]]... [--first] [--yes]\n" +
    "       sekhemet benchmark status | stop <runId> | report";
  try {
    if (sub === "estimate" || sub === "quick") {
      const c = combinationFrom(args);
      if (!c) {
        print(usage);
        return 2;
      }
      const e = await service.estimateQuick(c);
      for (const l of estimateLines(e, c)) print(l);
      if (sub === "estimate") return 0;
      if (!args.includes("--yes")) {
        print("Nothing has been loaded. Run it with --yes to start the quick benchmark.");
        return 0;
      }
      const started = await service.startQuick(c, principal);
      print(`Quick benchmark ${started.run.runId} started.`);
      for (const l of resultLines(await started.finished)) print(l);
      return 0;
    }
    if (sub === "overnight") {
      const specs: string[] = [];
      args.forEach((a, i) => {
        if (a === "--combination" && args[i + 1]) specs.push(args[i + 1] as string);
      });
      let combinations = specs.map(parseCombination).filter((c): c is Combination => !!c);
      if (!specs.length) {
        // DB-N6-11: default to the top combinations the quick tier could not separate.
        const results = (await combinationResults(env.log)).filter((r) => r.tier === "quick");
        const picks = defaultOvernightPicks(
          results.map((r) => ({
            combinationId: r.combinationId,
            value: r.score?.value ?? 0,
            indistinguishableFrom: r.indistinguishableFrom,
          })),
        );
        combinations = results
          .filter((r) => picks.includes(r.combinationId))
          .map((r) => r.combination);
        if (!combinations.length) {
          print(
            "No quick results the quick tier could not separate; pick combinations with --combination.",
          );
          return 2;
        }
      }
      const first = args.includes("--first");
      const est = await service.estimateOvernight(combinations.length, first);
      print(est.line);
      if (!args.includes("--yes")) {
        print("Nothing has been queued. Run it with --yes to queue it for the overnight window.");
        return 0;
      }
      const q = await service.scheduleOvernight(combinations, principal, { benchmarkFirst: first });
      print(`Overnight benchmark ${q.run.runId} queued; it runs only inside the overnight window.`);
      return 0;
    }
    if (sub === "status") {
      const runs = await service.runs();
      if (!runs.length) print("No benchmark runs.");
      for (const r of runs)
        print(
          `${r.runId} ${r.tier} ${r.state}${r.partial ? " (partial)" : ""}${r.progress ? ` ${r.progress.done}/${r.progress.total}` : ""}`,
        );
      return 0;
    }
    if (sub === "stop") {
      const id = args[1];
      if (!id) {
        print(usage);
        return 2;
      }
      const { run } = await service.stop(id, principal);
      print(`${run.runId}: ${run.state}${run.partial ? ", results kept (partial)" : ""}.`);
      return 0;
    }
    if (sub === "report") {
      const text = await morningReport(env.log);
      print(text || "No overnight benchmark has run yet.");
      return 0;
    }
    print(usage);
    return 2;
  } catch (err) {
    print(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
