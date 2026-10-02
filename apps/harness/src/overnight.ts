import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadGatesConfig, runBuiltinGates } from "@sekhemet/gates";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import { signalGroup, trackGroup, untrackGroup } from "@sekhemet/sandbox";
import { plural } from "@sekhemet/ui";
import type { QueueReport } from "./execute.js";
import { type GovernanceLimits, mayRun, recordUsage } from "./governance.js";
import { INJECTION_RECORD, injectionCurrentFor } from "./injection.js";
import { pendingM0 } from "./m0_path.js";
import { sendPush } from "./notify.js";
import { postConventionDrift } from "./onboard.js";
import { tickRecurring } from "./recurring.js";
import { reservationNow } from "./reservation.js";
import { type Window, mayUseMachine, parseHours } from "./scheduler.js";
import { overnightPlanLine } from "./wave2.js";

/**
 * `sekhemet overnight`: run the queue unattended, in rounds, for as long as
 * the machine is free and every breaker holds (H21 with H23).
 *
 * Each round is one `sekhemet queue` child with the user's queue flags, so a
 * crash or out-of-memory kill ends a round, not the night. Between rounds the
 * scheduler and the breakers decide whether to continue; the energy of each
 * round goes on the ledger; failures in a row count across rounds.
 */

export interface OvernightOptions {
  repoPath: string;
  log: EventLog;
  cardStore: CardStore;
  hours: string;
  limits: GovernanceLimits;
  /** Stop at this local time ("07:00"), if given. */
  until?: string;
  idleMinutes?: number;
  /** Flags passed to each `sekhemet queue` round. */
  queueArgs: string[];
  /** Injectable for tests. Exit code 124: the round exceeded its wall-clock limit. */
  runQueue?: (args: string[]) => Promise<number>;
  /** Each round's wall-clock limit (runtime item 17, RUN-11); default 3 hours. */
  roundLimitMs?: number;
  /** The nightly offline vulnerability scan (item 20, RUN-17); injectable for tests. */
  vulnScan?: (repoPath: string) => Promise<VulnScanResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxRounds?: number;
  say?: (line: string) => void;
  /** Skip the end-of-night mutation step (E16) and the deferred mutants (GT-N5-5). */
  skipMutation?: boolean;
  /** The deferred mutants' nightly run (GT-N5-5); injectable for tests. */
  nightlyMutation?: (
    repoPath: string,
    log: EventLog,
  ) => Promise<import("./mutation_step.js").NightlyMutationRun[]>;
  /** The Worker the queue will run; unattended runs need its injection pass (SEC-37b). */
  worker?: { modelId: string; quant: string };
  /** Where injection-fixture passes are recorded (default: the user directory). */
  injectionRecord?: string;
  /**
   * Run one Worker's pending M0 protocol (MS-M9-6), stopping at a clean point
   * when `shouldStop` says so; injectable for tests. Default: `runM0` on the
   * one measurement path, the Worker resolved through the roster.
   */
  runM0?: (worker: string, shouldStop: () => boolean) => Promise<"done" | "stopped" | "no tasks">;
  /**
   * The Worker's model server, owned by the night (item 17, RUN-18a): made
   * sure of before each round — started once, attached to afterwards — so a
   * round's queue adopts the running server instead of loading the weights
   * again; released when the rounds end. Absent for a Worker with no managed
   * server (an Ollama model keeps itself warm).
   */
  modelServer?: { ensureRunning(): Promise<void>; unload?(): Promise<void> };
  /**
   * The overnight benchmark (models rule 20b, MD-N3-4/5): `first` runs the
   * ones a person put first, before the queue; `after` the rest, once the
   * backlog is done and the night's model server is released. Each checks
   * its own window, with no idle exception. Returns the lines it said.
   */
  benchmark?: (phase: "first" | "after") => Promise<string[]>;
}

/**
 * The night's hold on a Worker adapter that runs its own server (a managed
 * llama-server, RUN-18a); undefined for one that does not.
 */
export function nightModelServer(adapter: unknown): OvernightOptions["modelServer"] {
  const a = adapter as { ensureRunning?: () => Promise<void>; unload?: () => Promise<void> };
  if (typeof a?.ensureRunning !== "function") return undefined;
  return {
    ensureRunning: () => (a.ensureRunning as () => Promise<void>).call(a),
    unload: () => (typeof a.unload === "function" ? a.unload.call(a) : Promise.resolve()),
  };
}

export interface VulnScanResult {
  passed: boolean;
  /** Why nothing was scanned (no lockfile, no scanner): never reported as a pass. */
  skipped?: string;
  findings?: string[];
}

/** A round's default wall-clock limit (RUN-11). */
export const ROUND_LIMIT_MS = 3 * 60 * 60 * 1000;
/** Exit code of a round killed at its limit, as `timeout(1)` reports it. */
export const ROUND_TIMED_OUT = 124;

export interface OvernightSummary {
  rounds: number;
  cardsRun: number;
  passed: number;
  stoppedBecause: string;
}

function untilTime(spec: string | undefined, from: Date): Date | undefined {
  const m = spec ? /^(\d{1,2}):(\d{2})$/.exec(spec) : null;
  if (!m) return undefined;
  const t = new Date(from);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t.getTime() <= from.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * One round: `sekhemet queue` as a child in its own process group, killed —
 * the whole tree, the model server it started included — when it passes its
 * wall-clock limit (RUN-11): SIGTERM, then SIGKILL after a grace period.
 */
function defaultRunQueue(repoPath: string, limitMs: number): (args: string[]) => Promise<number> {
  // SEKHEMET_CLI names the CLI entry when this process was not started by it.
  const cli = process.env.SEKHEMET_CLI ?? process.argv[1] ?? "";
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "queue", "--repo", repoPath, ...args], {
        stdio: "inherit",
        detached: true,
        env: { ...process.env, SEKHEMET_OVERNIGHT_ROUND: "1" },
      });
      trackGroup(child.pid);
      let timedOut = false;
      let kill: NodeJS.Timeout | undefined;
      const limit = setTimeout(() => {
        timedOut = true;
        if (child.pid === undefined) return;
        signalGroup(child.pid, "SIGTERM");
        kill = setTimeout(() => {
          if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
        }, 5_000);
      }, limitMs);
      const done = (code: number) => {
        clearTimeout(limit);
        if (kill) clearTimeout(kill);
        // The group may outlive its leader: take the rest with it.
        if (child.pid !== undefined) signalGroup(child.pid, "SIGKILL");
        untrackGroup(child.pid);
        resolve(timedOut ? ROUND_TIMED_OUT : code);
      };
      child.on("exit", (code) => done(code ?? 1));
      child.on("error", () => done(1));
    });
}

/**
 * The nightly full offline vulnerability scan (item 20, RUN-17): osv-scanner
 * over the repository's lockfiles, through the gates' own confined runner. A
 * repository with nothing to scan, or a host without the scanner, is recorded
 * as skipped, never as a pass.
 */
async function defaultVulnScan(repoPath: string): Promise<VulnScanResult> {
  const cfg = loadGatesConfig(repoPath);
  const r = await runBuiltinGates({
    root: repoPath,
    base: "HEAD",
    diff: "",
    project: cfg.project,
    gates: ["osv"],
  });
  const outcome = r.outcomes.find((o) => o.gate === "osv");
  const failures = r.failures.filter((f) => f.gate === "osv");
  const notRun = failures.find((f) => f.notRun);
  const findings = failures.filter((f) => !f.notRun).map((f) => f.actual || f.errorExcerpt);
  const skipped = outcome?.skipped
    ? (outcome.reason ?? "not run")
    : notRun
      ? notRun.actual || notRun.errorExcerpt || "not run"
      : outcome
        ? undefined
        : "the scan did not run";
  return {
    passed: skipped === undefined && outcome?.passed === true && findings.length === 0,
    ...(skipped ? { skipped } : {}),
    ...(findings.length > 0 ? { findings } : {}),
  };
}

function defaultRunM0(
  opts: OvernightOptions,
): (worker: string, shouldStop: () => boolean) => Promise<"done" | "stopped" | "no tasks"> {
  return async (worker, shouldStop) => {
    const { describeModel } = await import("./model_access.js");
    const { modelRegistry } = await import("./wave2.js");
    const { runM0 } = await import("./m0_path.js");
    return runM0(
      { repoPath: opts.repoPath, log: opts.log },
      {
        worker,
        adapter: describeModel(worker, "worker", { registry: modelRegistry() }),
        shouldStop,
        ...(opts.say ? { print: opts.say } : {}),
      },
    );
  };
}

function readReport(repoPath: string): QueueReport | undefined {
  try {
    return JSON.parse(
      readFileSync(join(repoPath, ".sekhemet", "queue_report.json"), "utf8"),
    ) as QueueReport;
  } catch {
    return undefined;
  }
}

export async function runOvernight(opts: OvernightOptions): Promise<OvernightSummary> {
  const say = opts.say ?? ((l: string) => console.log(l));
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const roundLimitMs = opts.roundLimitMs ?? ROUND_LIMIT_MS;
  const runQueue = opts.runQueue ?? defaultRunQueue(opts.repoPath, roundLimitMs);
  const windows: Window[] = parseHours(opts.hours);
  const stopAt = untilTime(opts.until, now());
  const state = { consecutiveFailures: 0 };
  const summary: OvernightSummary = { rounds: 0, cardsRun: 0, passed: 0, stoppedBecause: "" };
  let idleWaits = 0;
  // SEC-37b: an unattended run needs this Worker's injection-fixture pass.
  if (opts.worker) {
    const gate = injectionCurrentFor(opts.injectionRecord ?? INJECTION_RECORD, opts.worker);
    if (!gate.ok) {
      summary.stoppedBecause = gate.reason ?? "injection fixtures not passed";
      say(summary.stoppedBecause);
      return summary;
    }
  }
  // X2: the nightly convention drift check, posted to Seshat's thread.
  await postConventionDrift(opts.repoPath, opts.log).catch(() => []);

  // MS-M9-6: a Worker adopted or re-qualified owes the M0 protocol. It takes
  // hours, so it runs here, first, inside the window; at the window's end it
  // stops at a clean point and resumes next overnight.
  // RUN-58: a person's reservation, read from the ledger, stops the
  // benchmark as the reserved hours do — even when the person is idle.
  let reservedNow = (await reservationNow(opts.log, now())).reserved;
  const windowOver = (): boolean =>
    reservedNow ||
    (stopAt !== undefined && now() >= stopAt) ||
    !mayUseMachine(windows, {
      now: now(),
      ...(opts.idleMinutes !== undefined ? { idleMinutes: opts.idleMinutes } : {}),
    }).run;
  const runM0 = opts.runM0 ?? defaultRunM0(opts);
  for (const p of await pendingM0(opts.log)) {
    if (windowOver()) break;
    say(`M0 pending for ${p.worker} (${p.combination}): running it before the queue.`);
    const r = await runM0(p.worker, windowOver);
    if (r === "stopped") {
      summary.stoppedBecause = `M0 for ${p.worker} paused at the window's end; it resumes next overnight`;
      break;
    }
  }

  // Models rule 20b: a benchmark the person put first runs before the queue.
  if (!summary.stoppedBecause && opts.benchmark && !windowOver())
    await opts.benchmark("first").catch((err: unknown) => {
      say(`Overnight benchmark: ${err instanceof Error ? err.message : String(err)}.`);
    });

  while (!summary.stoppedBecause && summary.rounds < (opts.maxRounds ?? 100)) {
    if (stopAt && now() >= stopAt) {
      summary.stoppedBecause = `reached ${opts.until}`;
      break;
    }
    // X16: recurring templates that are due clone into Ready cards first.
    const recurring = await tickRecurring(opts.repoPath, opts.cardStore, opts.log, {
      now: now(),
      hours: opts.hours,
    }).catch(() => undefined);
    for (const f of recurring?.fired ?? [])
      say(`Recurring: ${f.template} -> ${f.cloneId} (${f.reason}).`);
    const ready = (await opts.cardStore.listCards({ status: "ready" as never })).length;
    if (ready === 0) {
      summary.stoppedBecause = "no Ready issues left";
      break;
    }
    // RUN-58: reserved from the dashboard or `sekhemet dev reserve`, read
    // from the ledger each round: nothing starts until it is released.
    const reservation = await reservationNow(opts.log, now());
    reservedNow = reservation.reserved;
    const slot = reservation.reserved
      ? {
          run: false,
          why: `the machine is reserved${reservation.until ? ` until ${reservation.until}` : " until released"}`,
          waitMinutes: 10,
        }
      : mayUseMachine(windows, {
          now: now(),
          ...(opts.idleMinutes !== undefined ? { idleMinutes: opts.idleMinutes } : {}),
        });
    if (!slot.run) {
      if (++idleWaits > 144) {
        summary.stoppedBecause = "the machine stayed in use";
        break;
      }
      say(`Waiting ${slot.waitMinutes} min: ${slot.why}.`);
      await sleep(slot.waitMinutes * 60_000);
      continue;
    }
    const verdict = await mayRun(opts.log, opts.limits, state);
    if (!verdict.ok) {
      summary.stoppedBecause = `${verdict.breaker} breaker: ${verdict.reason}`;
      break;
    }
    summary.rounds++;
    say(`Round ${summary.rounds}: ${plural(ready, "issue")} in To do; ${slot.why}.`);
    // M25: the window's batched plan, one model load per batch.
    say(
      overnightPlanLine(
        windows,
        await opts.cardStore.listCards({ status: "ready" as never }),
        now(),
      ),
    );
    // RUN-18a: the night's server, started on the first round and attached
    // to on every later one; the round's queue adopts it.
    if (opts.modelServer) {
      try {
        await opts.modelServer.ensureRunning();
      } catch (err) {
        say(
          `Model server: ${err instanceof Error ? err.message : String(err)}; the round starts its own.`,
        );
      }
    }
    const started = Date.now();
    const before = readReport(opts.repoPath)?.startedAt;
    const code = await runQueue(opts.queueArgs);
    const report = readReport(opts.repoPath);
    await recordUsage(opts.log, Date.now() - started, { round: summary.rounds });
    if (code === ROUND_TIMED_OUT) {
      // RUN-11: killed at its limit — one failure, and the night goes on.
      say(
        `Round ${summary.rounds} exceeded its wall-clock limit of ${Math.round(roundLimitMs / 60_000)} min: its process tree was killed; counted as one failure.`,
      );
      state.consecutiveFailures++;
      continue;
    }
    if (!report || report.startedAt === before) {
      // The round produced no report: count it as one failure, so a crash loop trips.
      state.consecutiveFailures++;
      continue;
    }
    for (const e of report.entries) {
      summary.cardsRun++;
      if (e.passed) {
        summary.passed++;
        state.consecutiveFailures = 0;
      } else {
        state.consecutiveFailures++;
      }
    }
  }
  if (!summary.stoppedBecause) summary.stoppedBecause = "round limit";
  // RUN-18a: the rounds are over; the weights leave memory now, not at exit.
  await opts.modelServer?.unload?.().catch(() => undefined);
  // Models rule 20b: by default the backlog goes first and the benchmark
  // takes the rest of the window; a tripped breaker stops it too.
  if (opts.benchmark && !/breaker/.test(summary.stoppedBecause))
    await opts.benchmark("after").catch((err: unknown) => {
      say(`Overnight benchmark: ${err instanceof Error ? err.message : String(err)}.`);
    });
  // E16: loop 10 on what the night accepted: mutants of accepted diffs
  // become advisory test proposals, while the machine is still free.
  if (summary.passed > 0 && !opts.skipMutation) {
    const { mutateAcceptedCards } = await import("./mutation_step.js");
    const runs = await mutateAcceptedCards(opts.repoPath, opts.cardStore, opts.log).catch(() => []);
    for (const r of runs)
      say(
        `Mutation ${r.cardId}: ${r.killed}/${r.total} killed${r.proposalCardId ? `, proposals on ${r.proposalCardId}` : ""}.`,
      );
  }
  // GT-N5-5: the mutants cards' verifications deferred past `mutation_max`
  // run now, and each full score goes onto its card's ledger.
  if (!opts.skipMutation) {
    const { runQueuedMutations } = await import("./mutation_step.js");
    const nightly = await (opts.nightlyMutation ?? runQueuedMutations)(
      opts.repoPath,
      opts.log,
    ).catch((err) => {
      say(`Nightly mutation: ${err instanceof Error ? err.message : String(err)}.`);
      return [];
    });
    for (const n of nightly) {
      say(
        n.measure
          ? `Nightly mutation ${n.cardId}: ${n.measure.killed}/${n.measure.total} killed (score ${n.measure.score ?? "not measured"}).`
          : `Nightly mutation ${n.cardId ?? n.queue}: not run (${n.skipped}).`,
      );
    }
  }
  // RUN-17: the full offline vulnerability scan, its result on the ledger.
  const scan = await (opts.vulnScan ?? defaultVulnScan)(opts.repoPath).catch(
    (err): VulnScanResult => ({
      passed: false,
      skipped: `the scan failed to run: ${err instanceof Error ? err.message : String(err)}`,
    }),
  );
  await opts.log.append({
    actor: "harness",
    type: "security/vulnerability_scan",
    payload: { scanner: "osv-scanner", offline: true, ...scan },
  });
  say(
    `Vulnerability scan: ${scan.skipped ? `skipped (${scan.skipped})` : scan.passed ? "no known vulnerabilities" : `${plural(scan.findings?.length ?? 0, "finding")}`}.`,
  );
  say(
    `Overnight done: ${plural(summary.rounds, "round")}, ${summary.passed}/${plural(summary.cardsRun, "issue")} passed; stopped: ${summary.stoppedBecause}.`,
  );
  await sendPush(
    opts.repoPath,
    {
      event: "run_report",
      title: "Overnight run finished",
      message: `${summary.passed}/${summary.cardsRun} passed in ${plural(summary.rounds, "round")}. Stopped: ${summary.stoppedBecause}.`,
      priority: summary.passed < summary.cardsRun ? 4 : 3,
    },
    { log: opts.log },
  ).catch(() => undefined);
  return summary;
}
