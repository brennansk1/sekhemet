import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, type EventLog } from "@sekhemet/kernel";
import { describe, expect, it, vi } from "vitest";
import { openLocalLedger } from "../src/ledger_cmds.js";
import { startDashboardServer } from "../src/server.js";
import { type LedgerRow, cli, g2Dirs, ledgerRows } from "./support/g2_cli.js";
import { SCRIPTED_MODEL, type Turn, scriptEnv } from "./support/g2_model.js";
import { type G2Project, g2Project } from "./support/g2_project.js";

/**
 * The live signals and the goal loop through `sekhemet queue` (planner-pm
 * §2.11, §2.12; NEW-planner-pm-2, -4, -5; FINISH_LINE_PLAN C2d, FINDINGS_C1
 * TST-01): the built binary spawned in a real repository, its prelude
 * reading the on-disk ledger before any card runs, the Coding model a
 * scripted stand-in at the HTTP boundary qualified for this host
 * (`support/g2_project.ts`), so no model is loaded and nothing leaves the
 * machine. What happened long ago is written to the ledger with the test
 * process's clock set back, as it would have been written then.
 */

const HOUR = 3_600_000;
const FINISH: Turn[] = [[{ name: "finish_card", arguments: { summary: "done" } }]];

/** Write ledger events as of `msAgo` before now (the ledger stamps them with the clock). */
async function asOf<T>(msAgo: number, write: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - msAgo);
  try {
    return await write();
  } finally {
    vi.useRealTimers();
  }
}

async function project(seed: (store: CardStore, log: EventLog) => Promise<void>, files = {}) {
  return g2Project(g2Dirs(), {
    files: { "package.json": JSON.stringify({ name: "app", version: "0.1.0" }), ...files },
    cards: [],
    seed,
  });
}

/** `sekhemet <args>` in the project, the scripted model answering. */
async function run(p: G2Project, args: string[], worker: Turn[] = []) {
  const r = await cli(args, {
    cwd: p.repo,
    preload: p.preload,
    env: { ...p.env, ...scriptEnv(p.record, { worker }) },
    timeoutMs: 180_000,
  });
  return { status: r.status, out: r.stdout + r.stderr, rows: ledgerRows(p.repo) };
}
const queue = (p: G2Project, worker: Turn[] = []) =>
  run(p, ["queue", "--worker", SCRIPTED_MODEL], worker);

/** A Ready issue for the pass to run (the queue's prelude runs when there is one). */
async function readyIssue(p: G2Project, id: string): Promise<void> {
  const { db, log } = openLocalLedger(p.repo);
  try {
    await new CardStore(db, log).createCard({
      id,
      tier: "story",
      title: `Issue ${id}`,
      status: "ready",
      scopeFiles: [`src/${id}.ts`],
      acceptanceCriteria: ["works"],
    });
  } finally {
    db.close();
  }
}

const suggestions = (rows: LedgerRow[], cardId: string) =>
  rows
    .filter((r) => r.type === "suggestion/proposed" && r.cardId === cardId)
    .map((r) => r.payload as { kind: string; value: unknown });
/** Seshat's replies in the thread, with their proposals. */
const replies = (rows: LedgerRow[]) =>
  rows
    .filter((r) => r.type === "pm/reply")
    .map(
      (r) =>
        ({ ...r.payload, ...(r.private ?? {}) }) as {
          text?: string;
          proposals?: {
            kind: string;
            summary?: string;
            cardId?: string;
            patch?: Record<string, unknown>;
          }[];
        },
    );

async function attempt(store: CardStore, cardId: string, passed: boolean): Promise<void> {
  const a = await store.runs.startAttempt({
    cardId,
    attemptNumber: store.runs.nextAttemptNumber(cardId),
    modelId: "m",
  });
  await store.runs.finishAttempt({
    attemptId: a.id,
    status: passed ? "passed" : "failed",
    stopReason: passed ? "gate_passed" : "budget_exhausted",
    tokensUsed: 1,
    secondsUsed: 1,
  });
}

describe("sekhemet queue: the signals propose, never mutate", () => {
  it(
    "PM-N2-1, PM-N5-4, PM-N5-3: a blocker past its bound gets a priority proposal and no planner writes priority; a day-old unverified assumption proposes a spike; a falling pass rate is named under What's at risk",
    { timeout: 240_000 },
    async () => {
      const p = await project(async (store, log) => {
        await asOf(26 * HOUR, async () => {
          await store.createCard({
            id: "stuck",
            tier: "story",
            title: "Vendor import",
            status: "ready",
          });
          await store.updateCard("stuck", { priority: 3 }, "human");
          await new BoardServiceImpl(store).transitionCard({
            cardId: "stuck",
            fromStatus: "ready",
            toStatus: "parked",
            actor: "human",
            reason: "waiting on a vendor key",
          });
          await store.createCard({
            id: "epic_csv",
            tier: "epic",
            title: "CSV export",
            status: "in_progress",
          });
          // A high-risk assumption as the planner logs it at persist.
          await log.append({
            actor: "planner",
            type: "assumption/logged",
            cardId: "epic_csv",
            payload: {
              id: "asm_1",
              cardId: "epic_csv",
              category: "storage",
              statement: "Exports fit in memory.",
              basis: "default",
              excerpt: "CSV export",
              createdAt: new Date().toISOString(),
            },
          });
        });
        // One Ready issue, so the pass runs.
        await store.createCard({
          id: "next",
          tier: "story",
          title: "Next issue",
          status: "ready",
          scopeFiles: ["src/next.ts"],
          acceptanceCriteria: ["works"],
        });
        // The Worker passed 18 of its first 20 attempts, then 3 of its last 10.
        await store.createCard({
          id: "w",
          tier: "story",
          title: "Earlier work",
          status: "backlog",
        });
        for (let i = 0; i < 20; i++) await attempt(store, "w", i !== 5 && i !== 12);
        for (let i = 0; i < 10; i++) await attempt(store, "w", i < 3);
      });
      const r = await queue(p, FINISH);
      expect(r.status, r.out).toBe(0);
      // PM-N2-1: proposed Urgent; the card's priority is still the person's 3.
      expect(r.out).toMatch(/Suggested Urgent for stuck/);
      expect(suggestions(r.rows, "stuck")).toEqual([
        expect.objectContaining({ kind: "priority", value: 1 }),
      ]);
      const priorityWrites = r.rows.filter(
        (x) =>
          x.type === "card/updated" &&
          x.cardId === "stuck" &&
          "priority" in ((x.payload.patch as Record<string, unknown>) ?? {}),
      );
      expect(priorityWrites.map((x) => x.payload.patch)).toEqual([{ priority: 3 }]);
      // PM-N5-4: a verification spike proposed in Seshat's thread.
      const spikes = replies(r.rows)
        .flatMap((m) => m.proposals ?? [])
        .filter((x) => x.kind === "create_card");
      expect(spikes).toHaveLength(1);
      expect(spikes[0]?.summary).toMatch(/^Spike: verify/);
      // PM-N5-3: the Worker's last ten below its interval, named under What's at risk.
      expect(r.out).toMatch(/What's at risk: Possible model degradation/);
      // Once: a second pass proposes nothing new.
      await readyIssue(p, "next2");
      const again = await queue(p, FINISH);
      expect(
        replies(again.rows)
          .flatMap((m) => m.proposals ?? [])
          .filter((x) => x.kind === "create_card"),
      ).toHaveLength(1);
      expect(suggestions(again.rows, "stuck")).toHaveLength(1);
    },
  );

  it(
    "PM-N5-3: when Ready-to-Review's p95 passes 2.5 × its p50, a step-budget change is proposed for a Ready card above what finished cards needed, and nothing is changed",
    { timeout: 240_000 },
    async () => {
      const p = await project(async (store) => {
        const board = new BoardServiceImpl(store);
        // Four cards ran from Ready to Review: three took an hour, one ten; each was accepted.
        for (const [id, steps, took] of [
          ["f1", 6, 1],
          ["f2", 9, 1],
          ["f3", 12, 1],
          ["f4", 10, 10],
        ] as const) {
          await asOf(30 * HOUR, async () => {
            await store.createCard({ id, tier: "story", title: id, status: "ready" });
            await board.transitionCard({
              cardId: id,
              fromStatus: "ready",
              toStatus: "in_progress",
              actor: "harness",
              reason: "run",
            });
            await store.updateCard(id, { stepsUsed: steps }, "executor");
          });
          await asOf((30 - took) * HOUR, async () => {
            await board.transitionCard({
              cardId: id,
              fromStatus: "in_progress",
              toStatus: "verify",
              actor: "harness",
              reason: "x",
            });
            await board.transitionCard({
              cardId: id,
              fromStatus: "verify",
              toStatus: "review",
              actor: "harness",
              reason: "x",
            });
            await board.transitionCard({
              cardId: id,
              fromStatus: "review",
              toStatus: "done",
              actor: "human",
              reason: "accepted",
            });
          });
        }
        await store.createCard({
          id: "big",
          tier: "story",
          title: "Big card",
          status: "ready",
          stepBudget: 40,
          scopeFiles: ["src/big.ts"],
          acceptanceCriteria: ["works"],
        });
      });
      const r = await queue(p, FINISH);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(
        /Signal cycle_time: p50 1h, p95 10h over 4 cards -> adjust_step_budgets \(proposal\)/,
      );
      const proposals = replies(r.rows).flatMap((m) => m.proposals ?? []);
      expect(proposals).toContainEqual(
        expect.objectContaining({ kind: "update_card", cardId: "big", patch: { stepBudget: 12 } }),
      );
      // Proposed, not set: no write of the step budget.
      expect(
        r.rows.filter(
          (x) =>
            x.type === "card/updated" &&
            x.cardId === "big" &&
            "stepBudget" in ((x.payload.patch as Record<string, unknown>) ?? {}),
        ),
      ).toEqual([]);
    },
  );

  it(
    "PM-N5-2: three gate failures in one file propose a re-split along Interface or Data, and the card is not paused: the pass runs it",
    { timeout: 240_000 },
    async () => {
      const p = await project(async (store) => {
        await store.createCard({
          id: "pay",
          tier: "story",
          title: "Overtime pay",
          status: "ready",
          scopeFiles: ["src/pay.ts"],
          acceptanceCriteria: ["works"],
        });
        for (let i = 0; i < 3; i++) {
          const a = await store.runs.startAttempt({
            cardId: "pay",
            attemptNumber: store.runs.nextAttemptNumber("pay"),
            modelId: "m",
          });
          await store.runs.recordGateResult({
            attemptId: a.id,
            cardId: "pay",
            gate: "unit",
            layer: "static",
            passed: false,
            exitCode: 1,
            durationMs: 1,
            source: "local",
            failures: [{ gate: "unit", location: { file: "src/pay.ts" }, errorExcerpt: "x" }],
          });
        }
      });
      const before = ledgerRows(p.repo).filter((x) => x.type === "attempt/started").length;
      const r = await queue(p, FINISH);
      expect(r.status, r.out).toBe(0);
      expect(suggestions(r.rows, "pay")).toEqual([
        expect.objectContaining({ kind: "split", value: ["interface", "data"] }),
      ]);
      // Not paused: this pass started the card again.
      expect(r.rows.filter((x) => x.type === "attempt/started").length).toBe(before + 1);
      expect(
        r.rows.some(
          (x) =>
            x.type === "card/status_changed" &&
            x.cardId === "pay" &&
            x.payload.toStatus === "parked" &&
            /split|failure/i.test(String(x.payload.reason)),
        ),
      ).toBe(false);
    },
  );

  it(
    "PM-N5-1: cards added to a planned epic past 20% are held, and a decision asks whether the goal has grown",
    { timeout: 240_000 },
    async () => {
      const p = await project(async () => undefined);
      const planned = await run(p, [
        "plan",
        "Add a CSV export, an audit log and a settings page.",
        "--planner",
        "none",
        "--offline",
      ]);
      expect(planned.status, planned.out).toBe(0);
      const plan = planned.rows.find((x) => x.type === "plan/created")?.payload as {
        epicId: string;
        stories: { id: string }[];
      };
      expect(plan.stories.length).toBeGreaterThan(0);
      // A person adds cards to the epic after it was planned.
      const extra = Math.floor(plan.stories.length * 0.2) + 1;
      const { db, log } = openLocalLedger(p.repo);
      try {
        const store = new CardStore(db, log);
        for (let i = 0; i < extra; i++)
          await store.createCard({
            id: `aux${i}`,
            tier: "story",
            title: `Also ${i}`,
            status: "ready",
            parentId: plan.epicId,
            scopeFiles: [`src/aux${i}.ts`],
            acceptanceCriteria: ["works"],
            difficulty: 3,
          });
      } finally {
        db.close();
      }
      const r = await queue(p, FINISH);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(/Signal scope_drift: .* -> halt_aux_cards_and_ask \(decision\)/);
      // Held: none of them ran in this pass.
      const started = r.rows.filter((x) => x.type === "attempt/started").map((x) => x.cardId);
      for (let i = 0; i < extra; i++) expect(started).not.toContain(`aux${i}`);
      const asked = r.rows
        .filter((x) => x.type === "decision/requested")
        .map((x) => String(x.payload.question));
      expect(asked.some((q) => /^Has the goal grown\?/.test(q))).toBe(true);
    },
  );
});

describe("scope drift counts what the planner did not plan (PM-N5-1, C2d finding)", () => {
  it(
    "PM-N5-1: the planner's own characterize cards are part of the plan, so a plan that made them raises no scope_drift and holds nothing",
    { timeout: 240_000 },
    async () => {
      // Existing source no base test reaches: each story that changes it is
      // preceded by a characterize card the planner makes (PM-N6-2).
      const p = await project(async () => undefined, {
        "src/csv_export.ts":
          "export function csvExport(rows: string[]): string {\n  return rows.join(',');\n}\n",
        "src/audit_log.ts": "export function auditLog(line: string): string {\n  return line;\n}\n",
        "src/settings_page.ts":
          "export function settingsPage(): string {\n  return 'settings';\n}\n",
      });
      const planned = await run(p, [
        "plan",
        "Add a CSV export, an audit log and a settings page.",
        "--planner",
        "none",
        "--offline",
      ]);
      expect(planned.status, planned.out).toBe(0);
      const plan = planned.rows.find((x) => x.type === "plan/created")?.payload as {
        stories: { id: string }[];
      };
      const chars = planned.rows.filter(
        (x) => x.type === "card/created" && String(x.payload.id).endsWith("_char"),
      );
      // Enough of them to pass 20% of the plan if they were counted as added.
      expect(chars.length).toBeGreaterThan(plan.stories.length * 0.2);
      await readyIssue(p, "other");
      const r = await queue(p, FINISH);
      expect(r.status, r.out).toBe(0);
      expect(r.out).not.toMatch(/Signal scope_drift/);
      expect(
        r.rows.some(
          (x) =>
            x.type === "decision/requested" &&
            /^Has the goal grown\?/.test(String(x.payload.question)),
        ),
      ).toBe(false);
    },
  );
});

describe("sekhemet goal and the queue: the goal loop", () => {
  const GOAL = "Users can sign in, the test suite passes, and coverage is at least 80%.";

  /** A project with an active goal, set and approved from the command line. */
  async function activeGoal(): Promise<{ p: G2Project; id: string; rows: LedgerRow[] }> {
    const p = await project(async () => undefined, {
      "src/auth.ts": "export function login(user: string): boolean { return user.length > 0; }\n",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const intake = await run(p, ["goal", GOAL]);
    expect(intake.status, intake.out).toBe(0);
    const id = /Draft (\S+) saved/.exec(intake.out)?.[1] as string;
    expect(id).toBeTruthy();
    const approved = await run(p, ["goal", "approve", id]);
    expect(approved.status, approved.out).toBe(0);
    expect(approved.out).toMatch(new RegExp(`Goal ${id} is active`));
    return { p, id, rows: approved.rows };
  }

  it(
    "PM-N4-2, PM-N4-3: a metric read from the repository and a person's mark meet their criteria at the next evaluation",
    { timeout: 300_000 },
    async () => {
      const { p, id, rows } = await activeGoal();
      mkdirSync(join(p.repo, "coverage"), { recursive: true });
      writeFileSync(
        join(p.repo, "coverage", "coverage-summary.json"),
        JSON.stringify({ total: { lines: { pct: 86.5 } } }),
      );
      const human = rows
        .filter((x) => x.type.startsWith("goal/"))
        .map((x) => (x.payload as { goal?: { criteria?: { id: string; kind: string }[] } }).goal)
        .flatMap((g) => g?.criteria ?? [])
        .find((c) => c.kind === "human")?.id;
      expect(human).toBeTruthy();
      const marked = await run(p, ["goal", "mark", id, human as string, "met"]);
      expect(marked.status, marked.out).toBe(0);
      expect(marked.out).toContain("the next evaluation uses it");
      const before = await run(p, ["goal", "status"]);
      expect(before.out).toMatch(/ {3}\[metric\] .*\(unmet\)/);
      await readyIssue(p, "g1");
      const first = await queue(p, FINISH);
      expect(first.status, first.out).toBe(0);
      const after = await run(p, ["goal", "status"]);
      expect(after.out).toMatch(/x \[metric\] coverage is at least 80% \(met\)/);
      expect(after.out).toMatch(/x \[human\] Users can sign in \(met\)/);
    },
  );

  it(
    "PM-N4-4, PM-N4-5: a lockfile change between evaluations fires environment_changed and replans, and the diff and its one-paragraph reason are posted in Seshat's thread",
    { timeout: 300_000 },
    async () => {
      const { p, id } = await activeGoal();
      await readyIssue(p, "g1");
      const first = await queue(p, FINISH);
      expect(first.status, first.out).toBe(0);
      expect(first.rows.filter((x) => x.type === "goal/replanned")).toEqual([]);
      writeFileSync(join(p.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nzod: 4.0.0\n");
      await readyIssue(p, "g2");
      const second = await queue(p, FINISH);
      expect(second.status, second.out).toBe(0);
      const replanned = second.rows.filter((x) => x.type === "goal/replanned").at(-1)?.payload as {
        triggers: string[];
        reason: string;
      };
      expect(replanned?.triggers, second.out).toContain("environment_changed");
      expect(replanned.reason).toMatch(/pnpm-lock\.yaml changed/);
      expect(second.out).toMatch(new RegExp(`Goal ${id} replanned to v2`));
      const post = replies(second.rows).find((m) =>
        (m.text ?? "").includes("pnpm-lock.yaml changed"),
      );
      expect(post?.text).toMatch(/= \d+ unchanged/);
      expect(post?.text?.split("\n\n")[0]).not.toContain("\n");
    },
  );

  it(
    "PM-N4-1: the dashboard server re-evaluates every active goal when a card closes",
    { timeout: 180_000 },
    async () => {
      const { p, id } = await activeGoal();
      const { db, log } = openLocalLedger(p.repo);
      const store = new CardStore(db, log);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(store),
        cardStore: store,
        repoPath: p.repo,
        port: 0,
        streamIntervalMs: 10_000,
        pressureLevel: () => 1,
      });
      try {
        const updates = async () => (await log.getEventsByTypes(["goal/updated"])).length;
        const n0 = await updates();
        await store.createCard({ id: "closer", tier: "task", title: "Closer", status: "ready" });
        const board = new BoardServiceImpl(store);
        for (const [from, to] of [
          ["ready", "in_progress"],
          ["in_progress", "verify"],
          ["verify", "review"],
        ] as const) {
          await board.transitionCard({
            cardId: "closer",
            fromStatus: from,
            toStatus: to,
            actor: "harness",
            reason: "x",
          });
        }
        await board.transitionCard({
          cardId: "closer",
          fromStatus: "review",
          toStatus: "done",
          actor: "human",
          reason: "accepted",
        });
        // The server's goal ticker sees the close on its next minute.
        await vi.waitFor(async () => expect(await updates()).toBeGreaterThan(n0), {
          timeout: 90_000,
          interval: 1000,
        });
        const goals = (await (await fetch(`http://127.0.0.1:${server.port}/api/goals`)).json()) as {
          goals: { id: string; state: string }[];
        };
        expect(goals.goals.map((g) => g.id)).toContain(id);
      } finally {
        await server.close();
        db.close();
      }
    },
  );
});

describe("a decision's answer reaches the card that asked (PM-P2-7)", () => {
  it(
    "PM-P2-7: the Agent asks and goes on; a person answers from the dashboard while it runs; the answer reaches the card at its next step and the decision records deliveredAt, once",
    { timeout: 240_000 },
    async () => {
      const p = await project(async (store) => {
        await store.createCard({
          id: "card_ask",
          tier: "story",
          title: "Write a",
          status: "ready",
          scopeFiles: ["src/a.ts"],
          // Nothing in the card answers the question: it waits for a person.
          acceptanceCriteria: ["works"],
          stepBudget: 6,
        });
      });
      const worker: Turn[] = [
        [
          {
            name: "ask",
            arguments: {
              question: "Should a be exported as a default export?",
              assumption: "a stays a named export",
            },
          },
        ],
        [{ name: "read_file", arguments: { path: "src/a.ts" } }],
        [{ name: "read_file", arguments: { path: "src/a.ts" } }],
        [{ name: "finish_card", arguments: { summary: "done" } }],
      ];
      const { db, log } = openLocalLedger(p.repo);
      const store = new CardStore(db, log);
      const server = await startDashboardServer({
        db,
        log,
        boardService: new BoardServiceImpl(store),
        cardStore: store,
        repoPath: p.repo,
        port: 0,
        streamIntervalMs: 10_000,
        pressureLevel: () => 1,
      });
      const { slowWorkerPreload } = await import("./support/g3_slow_worker.js");
      const running = cli(["queue", "--worker", SCRIPTED_MODEL], {
        cwd: p.repo,
        preload: slowWorkerPreload(p.home, p.preload),
        env: {
          ...p.env,
          ...scriptEnv(p.record, { worker }),
          G3_WORKER_HOLD_AT: "2",
          G3_WORKER_DELAY_MS: "6000",
        },
        timeoutMs: 180_000,
      });
      const base = `http://127.0.0.1:${server.port}`;
      try {
        // The Agent's question, posted without stopping it.
        let id = "";
        await vi
          .waitFor(
            () => {
              const asked = ledgerRows(p.repo).find(
                (x) => x.type === "decision/requested" && x.payload.kind === "worker_question",
              );
              expect(asked?.payload.question).toBe("Should a be exported as a default export?");
              id = String(asked?.payload.id);
            },
            { timeout: 60_000, interval: 200 },
          )
          .catch(async (err: unknown) => {
            const r = await running;
            throw new Error(`${String(err)}\n${r.stdout}\n${r.stderr}`);
          });
        const { pageWriteHeaders } = await import("./page_headers.js");
        const answered = await fetch(`${base}/api/decisions/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
          body: JSON.stringify({ option: 1 }),
        });
        expect(answered.status, await answered.clone().text()).toBe(200);
        const done = await running;
        expect(done.stdout).toContain("turn: finish_card");
        expect(store.runs.getDecision(id)?.deliveredAt).toMatch(/^\d{4}-/);
        expect(await store.eventsOfType(["decision/delivered"])).toHaveLength(1);
        // It reached the Agent at its next step, as an observation.
        const { recorded } = await import("./support/g2_model.js");
        const prompts = recorded(p.record)
          .filter((x) => x.role === "worker")
          .map((x) => x.body.messages.map((m) => m.content).join("\n"));
        expect(prompts.some((t) => t.includes("contradicts your assumption"))).toBe(true);
      } finally {
        await server.close();
        db.close();
      }
    },
  );
});
