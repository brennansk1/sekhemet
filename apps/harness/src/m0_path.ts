import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  type EvalBenchmarkResult,
  type M0Report,
  type ProductCardRun,
  type ProductCardRunner,
  formatM0Report,
  queueInvocation,
  resolveRunProfile,
  runM0Protocol,
  synthesizeTasksFromHistory,
} from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { writeMeasurementMarker } from "./measure_cmd.js";

/**
 * The M0 protocol on the product's card execution (measurement rule 9,
 * MS-M9-1, MS-M9-6). Each attempt's workspace — a clone at C-1 with the
 * task's test patch staged — becomes a small project: the patch is committed
 * to `main`, the task becomes one Ready card, and `sekhemet queue` runs it
 * with the shipped defaults and `--auto-accept` in place of the person, so
 * the oracle judges what the product accepted. The steps' format errors come
 * from the evidence, for the valid-tool-call rate.
 */

/** Runs the product's queue in a repository; tests pass a scripted one. */
export type M0QueueRun = (
  repo: string,
  argv: string[],
  timeoutMs: number,
  env?: Record<string, string>,
) => Promise<{ timedOut: boolean }>;

const HARNESS_CLI = join(dirname(fileURLToPath(import.meta.url)), "index.js");

/**
 * Run a command with a timeout. On timeout it sends SIGTERM, waits up to
 * `graceMs` for the process to exit, then SIGKILL, and resolves only once
 * the process has exited, so a stopped queue never outlives its caller.
 */
export function runWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  options: { graceMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ timedOut: boolean; code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: options.env ?? process.env });
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      kill = setTimeout(() => child.kill("SIGKILL"), options.graceMs ?? 30_000);
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      resolve({ timedOut, code, signal });
    });
    child.on("error", () => {
      clearTimeout(timer);
      if (kill) clearTimeout(kill);
      resolve({ timedOut, code: null, signal: null });
    });
  });
}

const realQueue: M0QueueRun = async (repo, argv, timeoutMs, env) => {
  const r = await runWithTimeout(
    process.execPath,
    [HARNESS_CLI, "queue", "--repo", repo, ...argv],
    timeoutMs,
    { env: { ...process.env, ...env } },
  );
  return { timedOut: r.timedOut };
};

const git = (cwd: string, ...a: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.email=m0@sekhemet.local",
      "-c",
      "user.name=Sekhemet M0",
      ...a,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();

/** A card id the board accepts, from a task id. */
const cardIdFor = (taskId: string) => `m0_${taskId.replace(/[^A-Za-z0-9_-]+/g, "_")}`;

export function productCardRunner(o: {
  worker: string;
  runQueue?: M0QueueRun;
  /** The queue's timeout per attempt; 30 minutes by default. */
  timeoutMs?: number;
}): ProductCardRunner {
  const timeoutMs = o.timeoutMs ?? 30 * 60_000;
  return async ({ workspacePath: ws, task, stepBudget }): Promise<ProductCardRun> => {
    // A linked worktree shares its branches with the source repository:
    // `main` there is the person's own, and acceptance would merge into it.
    if (!statSync(join(ws, ".git")).isDirectory()) {
      throw new Error(
        `m0 on the product path needs a cloned workspace, not a linked worktree (${ws}): its main is the source repository's`,
      );
    }
    // The test patch is staged by the benchmark; commit only it, onto main,
    // so the card's worktree starts from C-1 with its oracle present.
    git(ws, "checkout", "-q", "-B", "main");
    const staged = git(ws, "diff", "--cached", "--name-only");
    if (staged) git(ws, "commit", "-q", "-m", "m0: the task's test patch");
    // The board lives in the workspace; keep it out of the project's history.
    const exclude = join(ws, ".git", "info", "exclude");
    mkdirSync(dirname(exclude), { recursive: true });
    const excluded = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
    if (!excluded.includes(".sekhemet/")) appendFileSync(exclude, "\n.sekhemet/\n");

    // The mark that lets this workspace's queue take --auto-accept (review M5).
    writeMeasurementMarker(ws, "m0", "sekhemet m0");
    const cardId = cardIdFor(task.id);
    mkdirSync(join(ws, ".sekhemet"), { recursive: true });
    const db = new DatabaseSync(join(ws, ".sekhemet", "events.db"));
    try {
      initSchema(db);
      await new CardStore(db, new EventLog(db)).createCard(
        {
          id: cardId,
          tier: "task",
          title: (task.issueDescription.split("\n")[0] ?? task.id).trim().slice(0, 120),
          spec: task.issueDescription,
          status: "ready",
          scopeFiles: task.scopeFiles ?? [],
          stepBudget,
          acceptanceCriteria: task.failToPassTests.map((t) => `\`${t}\` passes`),
        },
        "harness",
      );
    } finally {
      db.close();
    }

    // The same invocation the suite runner builds from a RunProfile (MS-M9-1):
    // the Worker, the budget arm, acceptance in place of the person.
    const profile = resolveRunProfile({
      env: process.env,
      argv: ["--worker", o.worker, "--max-turns", String(stepBudget), "--auto-accept"],
      envRoles: true,
    });
    const invocation = queueInvocation(profile, ws);
    const { timedOut } = await (o.runQueue ?? realQueue)(
      ws,
      invocation.args.slice(3),
      timeoutMs,
      invocation.env,
    );
    const steps = stepsFromEvidence(ws, cardId);
    const reportFile = join(ws, ".sekhemet", "queue_report.json");
    if (timedOut || !existsSync(reportFile)) {
      return {
        stopReason: timedOut
          ? `timed out after ${Math.round(timeoutMs / 60_000)} min`
          : "not run: the queue wrote no report",
        turnsUsed: 0,
        promptTokens: 0,
        completionTokens: 0,
        steps,
      };
    }
    const entries = (
      JSON.parse(readFileSync(reportFile, "utf8")) as {
        entries: {
          cardId: string;
          attempt: number;
          stopReason: string;
          turns: number;
          promptTokens: number;
          completionTokens: number;
        }[];
      }
    ).entries
      .filter((e) => e.cardId === cardId)
      .sort((a, b) => a.attempt - b.attempt);
    return {
      stopReason: entries.at(-1)?.stopReason ?? "not run by the queue",
      turnsUsed: entries.reduce((n, e) => n + e.turns, 0),
      promptTokens: entries.reduce((n, e) => n + e.promptTokens, 0),
      completionTokens: entries.reduce((n, e) => n + e.completionTokens, 0),
      steps,
    };
  };
}

/** Every step of every attempt the evidence recorded for a card, in attempt order. */
function stepsFromEvidence(ws: string, cardId: string): ProductCardRun["steps"] {
  const dir = join(ws, ".sekhemet", "evidence");
  if (!existsSync(dir)) return [];
  const bundles: { attempt: number; steps: { formatErrors?: number; proseOnly?: number }[] }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("ev_") || !f.endsWith(".json")) continue;
    try {
      const b = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        cardId?: string;
        attempt?: number;
        steps?: { formatErrors?: number; proseOnly?: number }[];
      };
      if (b.cardId === cardId) bundles.push({ attempt: b.attempt ?? 1, steps: b.steps ?? [] });
    } catch {
      // A partial bundle is skipped.
    }
  }
  return bundles
    .sort((a, b) => a.attempt - b.attempt)
    .flatMap((b) =>
      b.steps.map((st) => ({ formatErrors: st.formatErrors ?? 0, proseOnly: st.proseOnly ?? 0 })),
    );
}

/**
 * Record an M0 run (MS-M9-6): always a `measure/m0` event, which the
 * Machine view reads; below the pivot rate, also a dated section at the top
 * of the harness's `SUITE_RUNS.md` and a notice to the owner. The harness
 * records and reports the condition; it never narrows the product's scope
 * itself — that is the owner's decision (rule 28a, O20).
 */
export async function recordM0Result(
  report: M0Report,
  o: {
    log: EventLog;
    worker: string;
    harnessRoot?: string;
    notify?: (title: string, message: string) => Promise<void>;
    at?: string;
  },
): Promise<void> {
  const v = report.validToolCalls;
  await o.log.append({
    actor: "harness",
    type: "measure/m0",
    payload: {
      worker: o.worker,
      taskCount: report.taskCount,
      budgets: report.budgets.map((b) => ({
        stepBudget: b.stepBudget,
        mean: b.mean,
        runs: b.runs,
      })),
      ...(v ? { validToolCalls: v } : {}),
    },
  });
  if (!v?.pivot) return;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const line = `Valid tool calls ${v.valid}/${v.steps} = ${pct(v.rate)} (95% CI ${pct(v.interval.low)}-${pct(v.interval.high)}) on the M0 protocol, below the 70% pivot rate.`;
  const decision =
    "Whether to narrow the product to planning and review assistance: the owner decides (O20); the product's scope is unchanged until then.";
  const file = o.harnessRoot ? join(o.harnessRoot, "docs", "reference", "SUITE_RUNS.md") : "";
  if (file && existsSync(file)) {
    const text = readFileSync(file, "utf8");
    const section = `## M0 pivot condition — ${o.worker}, ${o.at ?? new Date().toISOString().slice(0, 10)}\n\n${line} ${decision} (measurement rule 28a, MS-M9-6)\n\n---\n\n`;
    const at = text.indexOf("---\n\n");
    writeFileSync(
      file,
      at === -1 ? `${text}\n${section}` : `${text.slice(0, at + 5)}${section}${text.slice(at + 5)}`,
    );
  }
  await o.notify?.(`M0 pivot condition: ${o.worker}`, `${line} ${decision}`);
}

// ------------------------------------------ MS-M9-6: M0 pending, run overnight

/** A Worker adopted or re-qualified, whose M0 protocol has not run since. */
export const M0_PENDING = "m0/pending";

export interface PendingM0 {
  worker: string;
  combination: string;
  reason: string;
  at: string;
}

/**
 * Record that a Worker needs the M0 protocol (the lead's ruling on MS-M9-6):
 * it takes hours, so the overnight run does it rather than blocking the day.
 */
export async function recordM0Pending(
  log: EventLog,
  p: { worker: string; combination: string; reason: string },
): Promise<void> {
  await log.append({ actor: "harness", type: M0_PENDING, payload: p });
}

/** Pending M0 per Worker: the latest pending event not followed by an M0 result for it. */
export function pendingFromEvents(
  events: readonly { type: string; payload: unknown; createdAt?: string }[],
): PendingM0[] {
  const pending = new Map<string, PendingM0>();
  for (const e of events) {
    const p = e.payload as { worker?: string; combination?: string; reason?: string };
    if (!p?.worker) continue;
    if (e.type === M0_PENDING) {
      pending.delete(p.worker);
      pending.set(p.worker, {
        worker: p.worker,
        combination: p.combination ?? "",
        reason: p.reason ?? "",
        at: e.createdAt ?? "",
      });
    } else if (e.type === "measure/m0") {
      pending.delete(p.worker);
    }
  }
  return [...pending.values()];
}

export async function pendingM0(log: EventLog): Promise<PendingM0[]> {
  return pendingFromEvents(await log.getEventsByTypes([M0_PENDING, "measure/m0"]));
}

/** The same, read straight from a repository's ledger (for `doctor`, which opens no kernel). */
export function pendingM0InRepo(repoPath: string): PendingM0[] {
  const file = join(repoPath, ".sekhemet", "events.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT type, payload FROM events WHERE type IN (?, ?) ORDER BY seq")
      .all(M0_PENDING, "measure/m0") as { type: string; payload: string }[];
    return pendingFromEvents(rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload) })));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Run the M0 protocol for one Worker on the one measurement path, shared by
 * `sekhemet m0` and the overnight run. Progress is kept after every run in
 * `.sekhemet/m0/progress-<worker>.json`, so a protocol stopped at the
 * window's end resumes where it stopped; only a complete protocol is
 * recorded (and clears the pending event).
 */
export async function runM0(
  k: { repoPath: string; log: EventLog },
  o: {
    worker: string;
    adapter: LocalInferenceAdapter;
    runs?: number;
    budgets?: number[];
    maxCommits?: number;
    shouldStop?: () => boolean;
    print?: (line: string) => void;
    notify?: (title: string, message: string) => Promise<void>;
  },
): Promise<"done" | "stopped" | "no tasks"> {
  const print = o.print ?? ((l: string) => console.log(l));
  const synth = await synthesizeTasksFromHistory(k.repoPath, { maxCommits: o.maxCommits ?? 200 });
  print(
    `Synthesized ${synth.tasks.length} fail-to-pass task(s) from ${synth.scanned} candidate commit(s); ${synth.rejected.length} rejected.`,
  );
  if (synth.tasks.length === 0) return "no tasks";
  const dir = join(k.repoPath, ".sekhemet", "m0");
  mkdirSync(dir, { recursive: true });
  const progressFile = join(dir, `progress-${o.worker.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  const taskKey = synth.tasks.map((t) => t.id).join(",");
  type Done = { budget: number; run: number; result: EvalBenchmarkResult };
  let resume: Done[] = [];
  try {
    const saved = JSON.parse(readFileSync(progressFile, "utf8")) as {
      taskKey: string;
      done: Done[];
    };
    // A different task set is a different protocol: start again.
    if (saved.taskKey === taskKey) resume = saved.done;
  } catch {
    resume = [];
  }
  if (resume.length) print(`Resuming M0 for ${o.worker}: ${resume.length} run(s) already done.`);
  const done = [...resume];
  const report = await runM0Protocol({
    tasks: synth.tasks,
    adapter: o.adapter,
    runs: o.runs ?? 3,
    budgets: o.budgets ?? [50, 150],
    resume,
    ...(o.shouldStop ? { shouldStop: o.shouldStop } : {}),
    onRun: (budget, run, result) => {
      done.push({ budget, run, result });
      writeFileSync(progressFile, `${JSON.stringify({ taskKey, done })}\n`);
    },
    benchmark: {
      harnessRepoPath: k.repoPath,
      defaultRepoPath: k.repoPath,
      workspaceMode: "clone",
      runCard: productCardRunner({ worker: o.worker }),
    },
  });
  if (report.partial) {
    print(`M0 for ${o.worker} paused after ${done.length} run(s); it resumes where it stopped.`);
    return "stopped";
  }
  print(formatM0Report(report));
  await recordM0Result(report, {
    log: k.log,
    worker: o.worker,
    harnessRoot: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
    ...(o.notify ? { notify: o.notify } : {}),
  });
  const out = join(dir, "latest.json");
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  rmSync(progressFile, { force: true });
  print(`Report: ${out}`);
  return "done";
}
