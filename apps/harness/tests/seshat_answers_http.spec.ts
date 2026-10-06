import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import {
  type OvernightRunner,
  resolveRunProfile,
  runOvernightBench,
  scheduleOvernight,
} from "@sekhemet/eval";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import type { InferenceRequest, LocalInferenceAdapter, ToolCall } from "@sekhemet/models";
import { ASSUMPTION_EVENTS, GoalStore, appendPlannerEvent } from "@sekhemet/planner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearningStore } from "../src/learning/store.js";
import { recordLedgerRun } from "../src/ledger_evidence.js";
import { PmStore } from "../src/pm/store.js";
import { startDashboardServer } from "../src/server.js";
import { pageWriteHeaders } from "./page_headers.js";

/**
 * Seshat's answers through the dashboard's own routes (planner-pm P6,
 * PM_CONTRACT §3; FINISH_LINE_PLAN C2d, FINDINGS_C1 TST-01): a real server
 * on port 0 over an on-disk ledger, a person's message posted to
 * `POST /api/pm/messages` as the panel posts it, and the reply read back
 * from `GET /api/pm/thread`. Seshat's model is a stand-in at the adapter
 * boundary that records what it is sent and answers what the test scripts;
 * an answer the ledger gives must not reach it. No model is loaded.
 */

let repo: string;
let db: DatabaseSync;
let log: EventLog;
let store: CardStore;
let pm: PmStore;
let server: { port: number; close: () => Promise<void> };
let base: string;
let seen: InferenceRequest[];
let say: () => { text?: string; toolCalls?: ToolCall[] };

const standIn = (): LocalInferenceAdapter => ({
  modelId: "planner-model",
  supportedArms: ["arm_a_flat"],
  contextWindow: { contextTokens: 16_384, maxTokens: 1200 },
  generate: async (req) => {
    seen.push(req);
    const r = say();
    return {
      text: r.text ?? "",
      toolCalls: r.toolCalls ?? [],
      usage: { promptTokens: 1, completionTokens: 1, durationMs: 1 },
    };
  },
});

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "sek-seshat-http-"));
  mkdirSync(join(repo, ".sekhemet"), { recursive: true });
  db = new DatabaseSync(join(repo, ".sekhemet", "events.db"));
  initSchema(db);
  log = new EventLog(db);
  store = new CardStore(db, log);
  pm = new PmStore(log);
  seen = [];
  say = () => ({ text: "Noted." });
  server = await startDashboardServer({
    db,
    log,
    boardService: new BoardServiceImpl(store),
    cardStore: store,
    repoPath: repo,
    port: 0,
    streamIntervalMs: 1000,
    pressureLevel: () => 1,
    pmModel: "planner-model",
    pmAdapter: standIn,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  await server.close();
  db.close();
  rmSync(repo, { recursive: true, force: true });
});

interface Reply {
  id: string;
  role: string;
  text: string;
  cites?: Record<string, string>[];
  proposals?: {
    id?: string;
    state?: string;
    kind: string;
    cardId?: string;
    summary?: string;
    patch?: Record<string, unknown>;
    cards?: { acceptanceCriteria?: string[] }[];
  }[];
}

const thread = async (): Promise<Reply[]> =>
  ((await (await fetch(`${base}/api/pm/thread`)).json()) as { messages: Reply[] }).messages;

/** The panel's send, then Seshat's reply to it, read back from the thread. */
async function ask(text: string, context: Record<string, string> = {}): Promise<Reply> {
  const before = (await thread()).filter((m) => m.role === "pm").length;
  const sent = await fetch(`${base}/api/pm/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
    body: JSON.stringify({ text, context }),
  });
  expect(sent.status).toBe(200);
  for (let i = 0; i < 400; i++) {
    const replies = (await thread()).filter((m) => m.role === "pm");
    if (replies.length > before) return replies.at(-1) as Reply;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Seshat did not reply to: ${text}`);
}

async function card(id: string, title: string, extra: Partial<CardRecord> = {}) {
  await store.createCard({
    id,
    tier: "task",
    title,
    status: "ready",
    ...(extra as Record<string, unknown>),
  } as Parameters<CardStore["createCard"]>[0]);
  if (extra.stopReason) await store.updateCard(id, { stopReason: extra.stopReason });
}
const move = (id: string, to: CardRecord["status"]) =>
  store.updateCardStatus(id, to, "test", "harness", { override: true });

/** No stop code, and no id in backticks: the plain mode. */
function expectPlain(text: string) {
  expect(text).not.toMatch(/`[^`]+`/);
  expect(text).not.toMatch(
    /\b(budget_exhausted|repair_exhausted|memory_pressure|oscillation_detected|no_progress|gate_passed)\b/,
  );
}

describe("what Seshat knows, over HTTP", () => {
  it("PM-P6-1: 'what's our goal?' and 'what did you assume?' are answered from the goal store and the assumption log, citing them, with no model", async () => {
    const c = await store.createCard({ tier: "task", title: "Ledger", status: "ready" });
    await new GoalStore({ store, log }).create({
      id: "goal_http",
      workspaceId: "w",
      projectIds: [],
      statement: "Chronicle is usable over HTTP",
      criteria: [
        { id: "crit_1", text: "Reads work", kind: "human", status: "met" },
        { id: "crit_2", text: "Writes work", kind: "human", status: "unmet" },
      ],
      budget: { tokens: 1, hours: 1 },
      strategy: "epic_1",
      state: "active",
      assumptions: ["one user at a time"],
      strategiesTried: 0,
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    await appendPlannerEvent(
      { store, log },
      ASSUMPTION_EVENTS.logged,
      {
        id: "asm_utc",
        cardId: c.id,
        category: "data_format",
        statement: "Timestamps are stored in UTC",
        basis: "the project's other tables do",
        excerpt: "store the time",
        createdAt: new Date().toISOString(),
      },
      { cardId: c.id },
    );
    const goal = await ask("What's our goal?");
    expect(goal.text).toContain("Chronicle is usable over HTTP");
    expect(goal.text).toContain("1 of 2 criteria met");
    expect(goal.cites).toEqual([{ goalId: "goal_http", label: "Goal goal_http" }]);
    const assumed = await ask("What did you assume?");
    expect(assumed.text).toContain("Timestamps are stored in UTC");
    expect(assumed.text).toContain("one user at a time");
    expect(assumed.cites).toEqual(
      expect.arrayContaining([
        { assumptionId: "asm_utc", cardId: c.id, label: "Assumption asm_utc" },
        { goalId: "goal_http", label: "Goal goal_http" },
      ]),
    );
    expect(seen).toEqual([]);
  });

  it("PM-P6-2: asked about an issue the Reviewer reviewed, Seshat's snapshot holds the latest findings and the reply cites the one it names", async () => {
    const c = await store.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const old = await store.recordDossierEntry({
      cardId: c.id,
      kind: "review",
      actor: "reviewer",
      verdict: "unmet",
      modelId: "review-model",
      text: "Criterion 1 is unmet at src/ledger.ts:3: the old review.",
    });
    await store.recordDossierEntry({
      cardId: c.id,
      kind: "review",
      actor: "reviewer",
      verdict: "coverage",
      text: "Read 1 of 1 file.",
    });
    const finding = await store.recordDossierEntry({
      cardId: c.id,
      kind: "review",
      actor: "reviewer",
      verdict: "unclear",
      modelId: "review-model",
      text: "Criterion 2 is unclear at src/ledger.ts:12: the empty ledger is left out.",
    });
    say = () => ({
      text: `Ledger (\`${c.id}\`) has one open finding, ${finding.entryId}: the empty ledger is left out.`,
    });
    const reply = await ask("What did the AI review say about the ledger?");
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("<review_findings>");
    expect(prompt).toContain(
      `\`${c.id}\` finding \`${finding.entryId}\`, unclear: Criterion 2 is unclear`,
    );
    expect(prompt).not.toContain(old.entryId);
    expect(reply.cites).toEqual(
      expect.arrayContaining([
        { findingId: finding.entryId, cardId: c.id, label: `AI review of ${c.id}` },
      ]),
    );
  });

  it("PM-P6-6: asked why an issue failed, the reply names the stop reason, the step, the failing check and its file:line, and cites the evidence id", async () => {
    const c = await store.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const bundle = {
      id: "ev_7f3a",
      cardId: c.id,
      attempt: 2,
      passed: false,
      stopReason: "oscillation_detected",
      turnsUsed: 8,
      failures: [
        {
          gate: "typecheck",
          rung: "typecheck",
          location: { file: "tests/hasher.spec.ts", line: 25 },
          errorExcerpt: "TS2353: Object literal may only specify known properties",
        },
      ],
    };
    const body = JSON.stringify(bundle);
    mkdirSync(join(repo, ".sekhemet", "evidence"), { recursive: true });
    writeFileSync(join(repo, ".sekhemet", "evidence", "ev_7f3a.json"), body);
    await recordLedgerRun(store, {
      cardId: c.id,
      modelId: "cyber-tiel",
      passed: false,
      stopReason: "oscillation_detected",
      evidenceId: "ev_7f3a",
      path: ".sekhemet/evidence/ev_7f3a.json",
      body,
    });
    say = () => ({ text: "It looped; I'd send it back with a note about the test's input shape." });
    const reply = await ask("Why did the ledger issue fail?");
    expect(seen[0]?.prompt).toContain("<failure_evidence>");
    expect(reply.text).toContain("stopped on Looping at step 8");
    expect(reply.text).toContain("the first failing check was Types, at tests/hasher.spec.ts:25");
    expect(reply.text).toContain("Evidence `ev_7f3a`, attempt 2");
    expect(reply.cites).toEqual(
      expect.arrayContaining([{ evidenceId: "ev_7f3a", cardId: c.id, label: "Evidence ev_7f3a" }]),
    );
  });

  it("PM-P6-15: a profile statement with no new evidence fades below 0.2 and is left out of Seshat's prompt; a fresh one is in it", async () => {
    await store.createCard({ tier: "task", title: "Ledger", status: "ready" });
    const learning = new LearningStore(log);
    const week = 7 * 24 * 3_600_000;
    await learning.observe(
      {
        statement: "Prefers tables over prose",
        category: "communication",
        source: "edits",
        evidence: "x",
        key: "tables",
      },
      Date.now() - 10 * week,
    );
    await learning.observe({
      statement: "Prefers short answers",
      category: "communication",
      source: "edits",
      evidence: "y",
      key: "short",
    });
    await ask("How is the ledger issue doing?");
    const prompt = seen[0]?.prompt ?? "";
    expect(prompt).toContain("Prefers short answers");
    expect(prompt).not.toContain("Prefers tables over prose");
    // The Learning page shows the faded statement's strength lowered by its decay.
    const learned = (await (await fetch(`${base}/api/learning`)).json()) as {
      profile: { statement: string; strength: number; recordedStrength?: number }[];
    };
    const faded = learned.profile.find((p) => p.statement === "Prefers tables over prose");
    expect(faded?.strength).toBeCloseTo(0.3 * 0.9 ** 10, 2);
    expect(faded?.strength).toBeLessThan(0.2);
    expect(faded?.recordedStrength).toBe(0.3);
  });
});

describe("Seshat's judgement, over HTTP", () => {
  it("PM-P6-7: 'what's at risk?' lists what is at risk with its basis, and one issue that is not, with why", async () => {
    await card("c_broke", "Hasher", { stopReason: "repair_exhausted" });
    await move("c_broke", "parked");
    await card("c_mem", "Tamper check", { stopReason: "memory_pressure" });
    await move("c_mem", "parked");
    const reply = await ask("What's at risk?");
    expect(reply.text).toMatch(/One thing at risk:\n1\. Hasher: stopped: Couldn't fix\./);
    expect(reply.text).toMatch(/Not at risk: Tamper check, paused/);
    expect(reply.text).toMatch(/Based on:/);
    expectPlain(reply.text);
    expect(reply.cites?.map((c) => c.cardId)).toEqual(["c_broke", "c_mem"]);
    expect(seen).toEqual([]);
  });

  it("PM-P6-8: asked to plan the next sprint, Seshat bets at most 85% of the last three sprints' mean, states the basis, and changes nothing until applied", async () => {
    const plus = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    for (const [i, n] of [5, 4, 3].entries()) {
      const cycle = await pm.createCycle({
        name: `Sprint ${i + 1}`,
        startsOn: plus(-1),
        endsOn: plus(i + 1),
        state: "closed",
      });
      for (let k = 0; k < n; k++) {
        await card(`c_s${i}_${k}`, `Done ${i}.${k}`, { cycleId: cycle.id });
        await move(`c_s${i}_${k}`, "done");
      }
    }
    for (let k = 0; k < 5; k++) await card(`c_next_${k}`, `Next ${k}`);
    const reply = await ask("Plan the next sprint");
    expect(reply.text).toMatch(
      /For Sprint 4 I suggest betting 3 issues, no more than 3: 85% of the 4 issues a sprint completed on average over the last 3 sprints \(Sprint 3: 3, Sprint 2: 4, Sprint 1: 5\)/,
    );
    const p = reply.proposals?.[0];
    expect(p?.kind).toBe("create_cycle");
    expect((p?.patch?.cardIds as string[]).length).toBe(3);
    expect(p?.summary).toMatch(/Why: 85% of the 4 issues/);
    expect((await pm.cycles()).length).toBe(3);
  });

  it("PM-P6-9: asked to retry an issue over the Worker's 80% size horizon, Seshat proposes a split by its criteria, not a retry", async () => {
    const rows: [number, number, boolean][] = [
      [2, 10, true],
      [3, 15, true],
      [2, 20, true],
      [3, 25, true],
      [4, 30, true],
      [3, 35, true],
      [2, 40, true],
      [4, 45, true],
      [3, 50, true],
      [4, 55, false],
      [3, 60, true],
      [4, 70, true],
      [5, 80, false],
      [4, 90, true],
      [5, 100, false],
      [5, 110, false],
      [4, 120, false],
      [5, 130, true],
      [6, 140, false],
      [5, 150, false],
      [6, 160, false],
      [6, 180, false],
      [5, 190, false],
      [6, 200, false],
    ];
    for (const [i, [difficulty, lines, passed]] of rows.entries()) {
      const id = `m_${i}`;
      await card(id, id, { kind: "implement", difficulty } as Partial<CardRecord>);
      const a = await store.runs.startAttempt({ cardId: id, attemptNumber: 1, modelId: "w" });
      await store.runs.finishAttempt({
        attemptId: a.id,
        status: passed ? "passed" : "failed",
        stopReason: passed ? "gate_passed" : "repair_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
        linesAdded: lines,
      });
      await move(id, passed ? "done" : "parked");
    }
    await card("c_big", "Export everything", {
      kind: "implement",
      difficulty: 4,
      estimate: 8,
      acceptanceCriteria: [
        "exports CSV",
        "exports JSON",
        "streams large tables",
        "reports progress",
      ],
      stopReason: "repair_exhausted",
    } as Partial<CardRecord>);
    await move("c_big", "parked");
    const reply = await ask("Can we retry it?", { cardId: "c_big" });
    expect(reply.text).toMatch(
      /I'd split Export everything, not retry it: about \d+ changed lines is over the \d+ lines the Coding model passes 80% of the time/,
    );
    const [p] = reply.proposals ?? [];
    expect(p?.kind).toBe("split_card");
    expect(p?.cardId).toBe("c_big");
    expect(p?.cards?.map((c) => c.acceptanceCriteria)).toEqual([
      ["exports CSV", "exports JSON"],
      ["streams large tables", "reports progress"],
    ]);
    expect((await store.getCard("c_big"))?.status).toBe("parked");
  });

  it("PM-P6-14: an overnight benchmark finished since the last standup is in the next standup in plain words, model ids only in a link to Configuration; asked to apply it, Seshat names the Configuration action and assigns nothing", async () => {
    const clock = { t: 0 };
    const cards = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, role: "worker" as const }));
    const { runId } = await scheduleOvernight(log, {
      combinations: [
        { worker: "wa", planner: "pp" },
        { worker: "wc", planner: "pp" },
      ],
      host: "h",
    });
    const runner: OvernightRunner = {
      swapTo: async () => undefined,
      runCard: async ({ combination }) => ({ passed: combination.worker === "wa", seconds: 1 }),
    };
    await runOvernightBench({
      log,
      runId,
      runner,
      sets: {
        roles: {
          worker: { state: "ready", runs: 2, cards },
          planner: { state: "not_built", runs: 1, cards: [] },
          reviewer: { state: "not_built", runs: 1, cards: [] },
          researcher: { state: "not_built", runs: 1, cards: [] },
        },
      },
      host: "h",
      now: () => {
        clock.t += 1000;
        return clock.t;
      },
      window: () => ({ open: true, why: "open" }),
      fingerprint: { build: "b", contextVersion: "c", qualification: "q" },
      runProfileFor: () => resolveRunProfile({ env: {}, argv: [] }),
      measurementRun: (run) => run(),
    });
    const standup = await ask("/status");
    expect(standup.text).toMatch(
      /Overnight benchmark \(finished\): \[Coding model wa · Planning model pp\]\(#\/configuration\/models\) did best/,
    );
    expect(standup.text).toMatch(/assigned nothing/);
    const outsideLinks = standup.text.replace(/\[[^\]]*\]\(#\/configuration\/models\)/g, "");
    expect(outsideLinks).not.toMatch(/\b(wa|wc|pp)\b/);
    const apply = await ask("Apply the benchmark's best combination");
    expect(apply.text).toMatch(/Configuration › Models/);
    expect(apply.text).toMatch(/Assign/);
    expect(apply.proposals ?? []).toHaveLength(0);
    expect(await log.getEventsByTypes(["models/assigned"])).toHaveLength(0);
  });
});

describe("a proposal the board has moved past (PM-1)", () => {
  it("PM-1: when the issue changed after Seshat proposed a change to it, applying the proposal is refused and it is marked stale", async () => {
    await card("c_pay", "Overtime pay");
    say = () => ({
      text: "I suggest making it High.",
      toolCalls: [
        {
          id: "1",
          name: "propose_update_card",
          arguments: { card_id: "c_pay", priority: 2, reason: "it blocks payroll" },
        },
      ],
    });
    const reply = await ask("Should overtime pay go first?");
    const id = (reply.proposals ?? []).find((p) => p.kind === "update_card")?.id;
    expect(id).toBeTruthy();
    // Someone changes the issue's priority from the board meanwhile.
    const edited = await fetch(`${base}/api/cards/c_pay`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: JSON.stringify({ priority: 4 }),
    });
    expect(edited.status).toBe(200);
    const applied = await fetch(`${base}/api/pm/proposals/${id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await pageWriteHeaders(base)) },
      body: "{}",
    });
    expect(applied.status).toBe(409);
    expect(((await applied.json()) as { error: string }).error).toMatch(
      /Overtime pay changed since Seshat proposed this \(priority is now 4\)/,
    );
    expect((await store.getCard("c_pay"))?.priority).toBe(4);
    const listed = (await thread()).flatMap((m) => m.proposals ?? []);
    expect(listed.find((p) => p.id === id)?.state).toBe("stale");
  });
});
