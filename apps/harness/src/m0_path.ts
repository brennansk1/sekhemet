import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { M0Report, ProductCardRun, ProductCardRunner } from "@sekhemet/eval";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
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

const realQueue: M0QueueRun = async (repo, argv, timeoutMs) => {
  const r = await runWithTimeout(
    process.execPath,
    [HARNESS_CLI, "queue", "--repo", repo, ...argv],
    timeoutMs,
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

    const { timedOut } = await (o.runQueue ?? realQueue)(
      ws,
      ["--worker", o.worker, "--max-turns", String(stepBudget), "--auto-accept"],
      timeoutMs,
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
