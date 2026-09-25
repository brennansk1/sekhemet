import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  type M0QueueRun,
  productCardRunner,
  recordM0Result,
  runWithTimeout,
} from "../src/m0_path.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=T", ...a], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A workspace as the benchmark leaves it: detached at C-1, the test patch staged. */
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "sek-m0-ws-"));
  dirs.push(ws);
  git(ws, "init", "-q", "-b", "trunk");
  writeFileSync(join(ws, "add.js"), "module.exports = (a, b) => a - b;\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "C-1");
  git(ws, "checkout", "-q", "--detach");
  writeFileSync(join(ws, "test.js"), "require('./add')\n");
  git(ws, "add", "test.js");
  return ws;
}

const task = {
  id: "fix/add 1",
  repoCommit: "HEAD",
  issueDescription: "add() subtracts instead of adding.\nFix add.js.",
  failToPassTests: ["node test.js"],
  passToPassTests: [],
  scopeFiles: ["add.js"],
};

describe("M0 on the product's card execution (MS-M9-1)", () => {
  it("commits the test patch to main, puts one Ready card on the board, runs the queue, and reads the evidence", async () => {
    const ws = workspace();
    const calls: { repo: string; argv: string[] }[] = [];
    const runQueue: M0QueueRun = async (repo, argv) => {
      calls.push({ repo, argv });
      // The board the queue will read.
      const db = new DatabaseSync(join(repo, ".sekhemet", "events.db"), { readOnly: true });
      const cards = db.prepare("select id, status, title, spec, step_budget from cards").all();
      db.close();
      expect(cards).toEqual([
        {
          id: "m0_fix_add_1",
          status: "ready",
          title: "add() subtracts instead of adding.",
          spec: task.issueDescription,
          step_budget: 50,
        },
      ]);
      // The queue's work: two attempts, accepted onto main.
      const ev = join(repo, ".sekhemet", "evidence");
      mkdirSync(ev, { recursive: true });
      const step = (formatErrors: number, proseOnly: number) => ({
        step: 1,
        sample: 1,
        promptTokens: 1,
        formatErrors,
        proseOnly,
      });
      writeFileSync(
        join(ev, "ev_1.json"),
        JSON.stringify({ cardId: "m0_fix_add_1", attempt: 1, steps: [step(0, 0), step(1, 0)] }),
      );
      writeFileSync(
        join(ev, "ev_2.json"),
        JSON.stringify({ cardId: "m0_fix_add_1", attempt: 2, steps: [step(0, 1), step(0, 0)] }),
      );
      writeFileSync(
        join(repo, ".sekhemet", "queue_report.json"),
        JSON.stringify({
          entries: [1, 2].map((attempt) => ({
            cardId: "m0_fix_add_1",
            attempt,
            passed: attempt === 2,
            accepted: attempt === 2,
            stopReason: attempt === 2 ? "gates_passed" : "gates_failed",
            turns: 2,
            durationMs: 1,
            promptTokens: 100,
            completionTokens: 10,
          })),
        }),
      );
      writeFileSync(join(repo, "add.js"), "module.exports = (a, b) => a + b;\n");
      git(repo, "commit", "-q", "-am", "accepted");
      return { timedOut: false };
    };
    const run = await productCardRunner({ worker: "cyber-tiel", runQueue })({
      workspacePath: ws,
      task,
      stepBudget: 50,
      attempt: 1,
      temperature: 0,
    });
    expect(calls[0]?.argv).toEqual([
      "--worker",
      "cyber-tiel",
      "--max-turns",
      "50",
      "--auto-accept",
    ]);
    expect(git(ws, "log", "--format=%s", "main")).toBe("accepted\nm0: the task's test patch\nC-1");
    expect(readFileSync(join(ws, ".git", "info", "exclude"), "utf8")).toContain(".sekhemet/");
    // The workspace carries the measurement marker its queue's --auto-accept needs (review M5).
    expect(
      JSON.parse(readFileSync(join(ws, ".sekhemet", "measurement.json"), "utf8")),
    ).toMatchObject({
      purpose: "m0",
    });
    expect(run).toEqual({
      stopReason: "gates_passed",
      turnsUsed: 4,
      promptTokens: 200,
      completionTokens: 20,
      steps: [
        { formatErrors: 0, proseOnly: 0 },
        { formatErrors: 1, proseOnly: 0 },
        { formatErrors: 0, proseOnly: 1 },
        { formatErrors: 0, proseOnly: 0 },
      ],
    });
  });

  it("names a queue that timed out or wrote no report", async () => {
    const timedOut = productCardRunner({
      worker: "w",
      runQueue: async () => ({ timedOut: true }),
      timeoutMs: 30 * 60_000,
    });
    await expect(
      timedOut({ workspacePath: workspace(), task, stepBudget: 50, attempt: 1, temperature: 0 }),
    ).resolves.toMatchObject({ stopReason: "timed out after 30 min", steps: [] });
    const silent = productCardRunner({ worker: "w", runQueue: async () => ({ timedOut: false }) });
    await expect(
      silent({ workspacePath: workspace(), task, stepBudget: 50, attempt: 1, temperature: 0 }),
    ).resolves.toMatchObject({ stopReason: "not run: the queue wrote no report" });
  });
  it("refuses a workspace that is a linked worktree: its main is the source repository's", async () => {
    const src = workspace();
    git(src, "commit", "-q", "-m", "patch");
    const linked = join(mkdtempSync(join(tmpdir(), "sek-m0-linked-")), "wt");
    dirs.push(dirname(linked));
    git(src, "worktree", "add", "-q", "--detach", linked);
    const run = productCardRunner({ worker: "w", runQueue: async () => ({ timedOut: false }) });
    await expect(
      run({ workspacePath: linked, task, stepBudget: 50, attempt: 1, temperature: 0 }),
    ).rejects.toThrow(/needs a cloned workspace/);
  });
});

describe("recording M0 (MS-M9-6)", () => {
  const report = (valid: number) => ({
    taskCount: 2,
    budgets: [],
    results: [],
    stepStarved: [],
    validToolCalls: {
      valid,
      steps: 20,
      rate: valid / 20,
      interval: { low: 0.36, high: 0.81 },
      pivot: valid / 20 < 0.7,
    },
  });

  function ledger() {
    const d = mkdtempSync(join(tmpdir(), "sek-m0-log-"));
    dirs.push(d);
    const db = new DatabaseSync(join(d, "events.db"));
    initSchema(db);
    return { dir: d, log: new EventLog(db) };
  }

  it("below 70% records the pivot in SUITE_RUNS.md, on the ledger for the Machine view, and notifies the owner", async () => {
    const { dir, log } = ledger();
    mkdirSync(join(dir, "docs", "reference"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "reference", "SUITE_RUNS.md"),
      "# Frozen suite runs\n\nIntro.\n\n---\n\n## Older\n",
    );
    const notices: string[] = [];
    await recordM0Result(report(12), {
      log,
      worker: "cyber-tiel",
      harnessRoot: dir,
      notify: async (title, message) => {
        notices.push(`${title}: ${message}`);
      },
      at: "2026-09-25",
    });
    const events = await log.getEventsByTypes(["measure/m0"]);
    expect(events[0]?.payload).toMatchObject({
      worker: "cyber-tiel",
      validToolCalls: { rate: 0.6, pivot: true },
    });
    const runs = readFileSync(join(dir, "docs", "reference", "SUITE_RUNS.md"), "utf8");
    expect(runs).toMatch(
      /## M0 pivot condition — cyber-tiel, 2026-09-25\n\nValid tool calls 12\/20 = 60% \(95% CI 36%-81%\)/,
    );
    expect(runs.indexOf("M0 pivot")).toBeLessThan(runs.indexOf("## Older"));
    expect(notices[0]).toMatch(/M0 pivot condition: cyber-tiel/);
    expect(notices[0]).toMatch(/the owner decides \(O20\); the product's scope is unchanged/);
  });

  it("at or above 70% records the result and notifies no one", async () => {
    const { log } = ledger();
    const notices: string[] = [];
    await recordM0Result(report(18), {
      log,
      worker: "w",
      notify: async (t) => {
        notices.push(t);
      },
    });
    expect((await log.getEventsByTypes(["measure/m0"]))[0]?.payload).toMatchObject({
      validToolCalls: { pivot: false },
    });
    expect(notices).toEqual([]);
  });
});

describe("stopping a queue that ran past its timeout (review minor)", () => {
  it("waits for the process to exit after SIGTERM, and kills it when it will not", async () => {
    const started = Date.now();
    // Ignores SIGTERM: only SIGKILL ends it.
    const r = await runWithTimeout(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      300,
      { graceMs: 300 },
    );
    expect(r).toMatchObject({ timedOut: true, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(10_000);
    const quick = await runWithTimeout(process.execPath, ["-e", "process.exit(0)"], 10_000);
    expect(quick).toMatchObject({ timedOut: false, code: 0 });
  });
});
