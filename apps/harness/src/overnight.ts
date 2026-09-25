import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CardStore, EventLog } from "@sekhemet/kernel";
import type { QueueReport } from "./execute.js";
import { type GovernanceLimits, mayRun, recordUsage } from "./governance.js";
import { INJECTION_RECORD, injectionCurrentFor } from "./injection.js";
import { pendingM0 } from "./m0_path.js";
import { sendPush } from "./notify.js";
import { postConventionDrift } from "./onboard.js";
import { tickRecurring } from "./recurring.js";
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
  /** Injectable for tests. */
  runQueue?: (args: string[]) => Promise<number>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  maxRounds?: number;
  say?: (line: string) => void;
  /** Skip the end-of-night mutation step (E16). */
  skipMutation?: boolean;
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
}

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

function defaultRunQueue(repoPath: string): (args: string[]) => Promise<number> {
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [process.argv[1] ?? "", "queue", "--repo", repoPath, ...args],
        {
          stdio: "inherit",
        },
      );
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
}

function defaultRunM0(
  opts: OvernightOptions,
): (worker: string, shouldStop: () => boolean) => Promise<"done" | "stopped" | "no tasks"> {
  return async (worker, shouldStop) => {
    const { ModelRoster } = await import("@sekhemet/models");
    const { modelRegistry } = await import("./wave2.js");
    const { runM0 } = await import("./m0_path.js");
    return runM0(
      { repoPath: opts.repoPath, log: opts.log },
      {
        worker,
        adapter: new ModelRoster({ registry: modelRegistry() }).resolve(worker, "worker"),
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
  const runQueue = opts.runQueue ?? defaultRunQueue(opts.repoPath);
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
  const windowOver = (): boolean =>
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
      summary.stoppedBecause = "no Ready cards left";
      break;
    }
    const slot = mayUseMachine(windows, {
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
    say(`Round ${summary.rounds}: ${ready} Ready card(s); ${slot.why}.`);
    // M25: the window's batched plan, one model load per batch.
    say(
      overnightPlanLine(
        windows,
        await opts.cardStore.listCards({ status: "ready" as never }),
        now(),
      ),
    );
    const started = Date.now();
    const before = readReport(opts.repoPath)?.startedAt;
    await runQueue(opts.queueArgs);
    const report = readReport(opts.repoPath);
    await recordUsage(opts.log, Date.now() - started, { round: summary.rounds });
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
  say(
    `Overnight done: ${summary.rounds} round(s), ${summary.passed}/${summary.cardsRun} card(s) passed; stopped: ${summary.stoppedBecause}.`,
  );
  await sendPush(
    opts.repoPath,
    {
      event: "run_report",
      title: "Overnight run finished",
      message: `${summary.passed}/${summary.cardsRun} passed in ${summary.rounds} round(s). Stopped: ${summary.stoppedBecause}.`,
      priority: summary.passed < summary.cardsRun ? 4 : 3,
    },
    { log: opts.log },
  ).catch(() => undefined);
  return summary;
}
