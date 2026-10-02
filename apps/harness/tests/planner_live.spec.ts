import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BoardServiceImpl } from "@sekhemet/board";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import {
  DecisionStore,
  GoalStore,
  SpidrFeaturePlanner,
  approveGoal,
  intakeGoal,
  latestPlan,
} from "@sekhemet/planner";
import { afterEach, describe, expect, it } from "vitest";
import { respondToSignals, startGoalTicker } from "../src/planner_live.js";
import { applyProposal } from "../src/pm/apply.js";
import { PmStore } from "../src/pm/store.js";
import {
  type RepoContext,
  planCommand,
  queuePrelude,
  replanOnRung3,
  runDevCommand,
} from "../src/wave2.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A real repository and an on-disk ledger where the harness keeps it (DEFINITION_OF_DONE §2A). */
function kernel(): RepoContext & { db: DatabaseSync } {
  const repoPath = mkdtempSync(join(tmpdir(), "sek-live-"));
  dirs.push(repoPath);
  const w = (rel: string, text: string) => {
    mkdirSync(dirname(join(repoPath, rel)), { recursive: true });
    writeFileSync(join(repoPath, rel), text);
  };
  w("src/auth.ts", "export function login(user: string): boolean { return user.length > 0; }\n");
  w("package.json", JSON.stringify({ name: "fixture", engines: { node: ">=22" } }));
  w("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repoPath, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e@x");
  git("config", "user.name", "E");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: init");
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const db = new DatabaseSync(join(repoPath, ".sekhemet", "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { repoPath, log, cardStore: new CardStore(db, log), db };
}

const quiet = { print: () => undefined };
const HOUR = 3_600_000;

async function readyCard(k: RepoContext, id: string, extra: Record<string, unknown> = {}) {
  await k.cardStore.createCard({
    id,
    tier: "story",
    title: id,
    status: "ready",
    scopeFiles: [`src/${id}.ts`],
    acceptanceCriteria: ["works"],
    ...extra,
  });
}

async function failIn(k: RepoContext, cardId: string, file: string) {
  const a = await k.cardStore.runs.startAttempt({
    cardId,
    attemptNumber: k.cardStore.runs.nextAttemptNumber(cardId),
    modelId: "m",
  });
  await k.cardStore.runs.recordGateResult({
    attemptId: a.id,
    cardId,
    gate: "unit",
    layer: "static",
    passed: false,
    exitCode: 1,
    durationMs: 1,
    source: "local",
    failures: [{ gate: "unit", location: { file }, errorExcerpt: "x" }],
  });
}

const suggestionsOn = (k: RepoContext & { db: DatabaseSync }, cardId: string) =>
  (
    k.db
      .prepare("SELECT payload FROM events WHERE type = 'suggestion/proposed' AND card_id = ?")
      .all(cardId) as { payload: string }[]
  ).map((r) => JSON.parse(r.payload) as { kind: string; value: unknown });

describe("signals propose, never mutate (NEW-planner-pm-2, -5)", () => {
  it("PM-N2-1: a blocker past its bound gets a priority suggestion; no planner writes priority", async () => {
    const k = kernel();
    await readyCard(k, "stuck");
    await k.cardStore.updateCard("stuck", { priority: 3 }, "human");
    await new BoardServiceImpl(k.cardStore).transitionCard({
      cardId: "stuck",
      fromStatus: "ready",
      toStatus: "parked",
      actor: "human",
      reason: "waiting on a vendor key",
    });
    const later = new Date(Date.now() + 13 * HOUR);
    const { lines } = await queuePrelude(k, [], { ...quiet, now: later, setup: "solo" });
    expect((await k.cardStore.getCard("stuck"))?.priority).toBe(3);
    expect(suggestionsOn(k, "stuck")).toEqual([
      expect.objectContaining({ kind: "priority", value: 1 }),
    ]);
    const plannerPriority = (
      k.db
        .prepare("SELECT payload FROM events WHERE type = 'card/updated' AND actor = 'planner'")
        .all() as { payload: string }[]
    ).filter((r) => r.payload.includes('"priority"'));
    expect(plannerPriority).toEqual([]);
    expect(lines.join("\n")).toMatch(/Suggested Urgent for stuck/);
  });

  it("PM-N5-2: three failures in one file propose a re-split along Interface or Data; the card keeps running", async () => {
    const k = kernel();
    await readyCard(k, "pay", { scopeFiles: ["src/pay.ts"] });
    for (let i = 0; i < 3; i++) await failIn(k, "pay", "src/pay.ts");
    const ready = await k.cardStore.listCards({ status: "ready" });
    const { ordered } = await queuePrelude(k, ready, { ...quiet, setup: "solo" });
    expect(suggestionsOn(k, "pay")).toEqual([
      expect.objectContaining({ kind: "split", value: ["interface", "data"] }),
    ]);
    expect((await k.cardStore.getCard("pay"))?.status).toBe("ready");
    expect(ordered.map((c) => c.id)).toContain("pay");
  });

  it("PM-N5-1: drift over 20% holds the added cards in Planning and asks whether the goal has grown", async () => {
    const k = kernel();
    const spec = "Add a CSV export, an audit log and a settings page.";
    const r = await planCommand(k, spec, quiet);
    const epicCards = await k.cardStore.listCards({ parentId: r.epicId });
    const plan = await latestPlan({ store: k.cardStore, log: k.log }, r.epicId);
    expect(plan?.stories.length).toBeGreaterThan(0);
    const extra = Math.floor((plan?.stories.length ?? 0) * 0.2) + 1;
    for (let i = 0; i < extra; i++)
      await readyCard(k, `aux${i}`, { parentId: r.epicId, difficulty: 3 });
    await readyCard(k, "owned", { parentId: r.epicId, owner: "p_priya" });
    const ready = await k.cardStore.listCards({ status: "ready" });
    const { ordered } = await queuePrelude(k, ready, { ...quiet, setup: "team" });
    // Held: out of this pass, in Planning when the board takes it there (its
    // WIP limit permitting), otherwise sitting out in Ready while the question is open.
    for (let i = 0; i < extra; i++) {
      expect(ordered.map((c) => c.id)).not.toContain(`aux${i}`);
      expect(["planning", "ready"]).toContain((await k.cardStore.getCard(`aux${i}`))?.status);
    }
    // Team setup: an issue someone owns is not held; its owner gets the suggestion (PM-N9-9).
    expect(ordered.map((c) => c.id)).toContain("owned");
    expect(suggestionsOn(k, "owned")).toEqual([
      expect.objectContaining({
        kind: "hold",
        value: expect.stringMatching(/^scope drift on .*: held until decision dec_/),
      }),
    ]);
    const decisions = new DecisionStore({ store: k.cardStore, log: k.log });
    const waiting = await decisions.waiting();
    const d = waiting.find((x) => x.request.id.startsWith("scope_drift_"));
    expect(d?.request.question).toMatch(/Has the goal grown\?/);
    // Still held on the next pass; answering releases them.
    const again = await queuePrelude(k, await k.cardStore.listCards({ status: "ready" }), {
      ...quiet,
      setup: "team",
    });
    expect(again.ordered.map((c) => c.id)).not.toContain("aux0");
    await decisions.answer(d?.id as string, 0, "human");
    const after = await queuePrelude(k, await k.cardStore.listCards({ status: "ready" }), {
      ...quiet,
      setup: "team",
    });
    expect(after.ordered.map((c) => c.id)).toContain("aux0");
    expect(epicCards.length).toBeGreaterThan(0);
  });

  it("PM-N5-4: an assumption unverified for over 24 h proposes a spike card in Seshat's thread, once", async () => {
    const k = kernel();
    const r = await planCommand(k, "Add a CSV export and an audit log.", quiet);
    // An assumption as the planner logs it at persist (persist.ts).
    await k.log.append({
      actor: "planner",
      type: "assumption/logged",
      cardId: r.epicId,
      payload: {
        id: "asm_1",
        cardId: r.epicId,
        category: "storage",
        statement: "Exports fit in memory.",
        basis: "default",
        excerpt: "CSV export",
        createdAt: new Date().toISOString(),
      },
    });
    const logged = await k.log.getEventsByTypes(["assumption/logged"]);
    const later = new Date(Date.now() + 25 * HOUR);
    await queuePrelude(k, [], { ...quiet, now: later, setup: "solo" });
    await queuePrelude(k, [], { ...quiet, now: later, setup: "solo" });
    const replies = (await new PmStore(k.log).thread()).filter((m) => m.role === "pm");
    const spikes = replies
      .flatMap((m) => m.proposals ?? [])
      .filter((p) => p.kind === "create_card");
    expect(spikes.length).toBe(logged.length);
    expect(spikes[0]?.summary).toMatch(/^Spike: verify/);
  });

  it("PM-N5-3: the Worker's last 10 attempts below its interval are named under What's at risk", async () => {
    const k = kernel();
    await k.cardStore.createCard({ id: "w", tier: "story", title: "w", status: "ready" });
    const attempt = async (passed: boolean) => {
      const a = await k.cardStore.runs.startAttempt({
        cardId: "w",
        attemptNumber: k.cardStore.runs.nextAttemptNumber("w"),
        modelId: "m",
      });
      await k.cardStore.runs.finishAttempt({
        attemptId: a.id,
        status: passed ? "passed" : "failed",
        stopReason: passed ? "gate_passed" : "budget_exhausted",
        tokensUsed: 1,
        secondsUsed: 1,
      });
    };
    for (let i = 0; i < 20; i++) await attempt(i !== 5 && i !== 12);
    for (let i = 0; i < 10; i++) await attempt(i < 3);
    const { lines } = await queuePrelude(k, [], { ...quiet, setup: "solo" });
    expect(lines.join("\n")).toMatch(/What's at risk: Possible model degradation/);
    const thread = await new PmStore(k.log).thread();
    expect(thread.some((m) => /What's at risk: Possible model degradation/.test(m.text))).toBe(
      true,
    );
  });
});

describe("PM-N5-3: congestion proposes a step-budget change a person applies", () => {
  it("proposes the budget finished cards needed for Ready cards above it; applying it sets it", async () => {
    const k = kernel();
    const board = new BoardServiceImpl(k.cardStore);
    for (const [id, steps] of [
      ["f1", 6],
      ["f2", 9],
      ["f3", 12],
    ] as const) {
      await k.cardStore.createCard({ id, tier: "story", title: id, status: "in_progress" });
      await k.cardStore.updateCard(id, { stepsUsed: steps }, "executor");
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
    }
    await readyCard(k, "big", { stepBudget: 40 });
    await readyCard(k, "small", { stepBudget: 8 });
    const reading = {
      id: "cycle_time" as const,
      value: 3.1,
      threshold: 2.5,
      triggered: true,
      detail: "p50 1h, p95 3.1h over 4 cards",
      response: { action: "adjust_step_budgets" as const, mode: "proposal" as const, targets: [] },
    };
    const out: string[] = [];
    const opts = { setup: "solo" as const, now: new Date(), say: (l: string) => out.push(l) };
    await respondToSignals(k, [reading], opts);
    await respondToSignals(k, [reading], opts);
    expect((await k.cardStore.getCard("big"))?.stepBudget).toBe(40);
    const pmStore = new PmStore(k.log);
    const proposals = (await pmStore.thread()).flatMap((m) => m.proposals ?? []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      kind: "update_card",
      cardId: "big",
      patch: { stepBudget: 12 },
    });
    expect(proposals[0]?.forOwner).toBeUndefined();
    await applyProposal(proposals[0] as never, {
      cardStore: k.cardStore,
      boardService: board,
      pmStore,
    });
    expect((await k.cardStore.getCard("big"))?.stepBudget).toBe(12);
  });

  it("PM-N9-9: in the Team setup, a step-budget proposal for someone else's card carries forOwner", async () => {
    const k = kernel();
    const board = new BoardServiceImpl(k.cardStore);
    for (const [id, steps] of [
      ["f1", 6],
      ["f2", 9],
      ["f3", 12],
    ] as const) {
      await k.cardStore.createCard({ id, tier: "story", title: id, status: "in_progress" });
      await k.cardStore.updateCard(id, { stepsUsed: steps }, "executor");
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
    }
    await readyCard(k, "big", { stepBudget: 40, owner: "p_priya" });
    const reading = {
      id: "cycle_time" as const,
      value: 3.1,
      threshold: 2.5,
      triggered: true,
      detail: "p50 1h, p95 3.1h over 4 cards",
      response: { action: "adjust_step_budgets" as const, mode: "proposal" as const, targets: [] },
    };
    await respondToSignals(k, [reading], { setup: "team", now: new Date(), say: () => undefined });
    const proposals = (await new PmStore(k.log).thread()).flatMap((m) => m.proposals ?? []);
    expect(proposals[0]).toMatchObject({ cardId: "big", forOwner: "p_priya" });
  });
});

describe("PM-P1-8: a rung-3 re-plan keeps the riskiest assumption and the original spec", () => {
  it("carries the riskiest card into the new plan and never removes it", async () => {
    const k = kernel();
    const spec = "Let users log in with a password and see their billing history.";
    const r = await planCommand(k, spec, quiet);
    expect((await k.cardStore.getCard(r.epicId))?.spec).toBe(spec);
    const cards = await k.cardStore.listCards({ parentId: r.epicId });
    const riskiest = cards.find((c) => /^Riskiest assumption/.test(c.title));
    expect(riskiest).toBeDefined();
    const failed = cards.find((c) => c.id !== riskiest?.id) as never;
    const before = (await k.cardStore.getCard(riskiest?.id as string))?.status;
    const note = await replanOnRung3(k, failed, "the session store is missing", { setup: "solo" });
    expect(note).toMatch(/to v2/);
    const plan = await latestPlan({ store: k.cardStore, log: k.log }, r.epicId);
    expect(plan?.stories.map((s) => s.id)).toContain(riskiest?.id);
    const replanned = (await k.log.getEventsByTypes(["plan/replanned"])).at(-1)?.payload as {
      diff: { removed: string[] };
    };
    expect(replanned.diff.removed).not.toContain(riskiest?.id);
    const after = await k.cardStore.getCard(riskiest?.id as string);
    expect(after?.status).toBe(before);
    expect(after?.blockedReason ?? "").not.toMatch(/Removed by replan/);
    // The re-plan and its diff are in Seshat's thread.
    const thread = await new PmStore(k.log).thread();
    expect(thread.some((m) => m.role === "pm" && /failed at rung 3/.test(m.text))).toBe(true);
  });
});

describe("the goal loop re-evaluates on the right events (NEW-planner-pm-4)", () => {
  const GOAL = "Users can sign in, the test suite passes, and coverage is at least 80%.";

  async function activeGoal(k: RepoContext) {
    const ledger = { store: k.cardStore, log: k.log };
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(ledger, planner, GOAL);
    const { goal } = await approveGoal(ledger, planner, intake.goal.id);
    return goal;
  }

  it("PM-N4-1: re-evaluates when a card closes, and hourly without a close", async () => {
    const k = kernel();
    const goal = await activeGoal(k);
    let clock = Date.now();
    const ticker = startGoalTicker(k, {
      everyMs: 3_600_000,
      now: () => clock,
      setup: "solo",
      planner: async () => new SpidrFeaturePlanner(),
    });
    try {
      const updates = async () => (await k.log.getEventsByTypes(["goal/updated"])).length;
      expect(await ticker.tick()).toBe("idle");
      const card = (await k.cardStore.listCards({ parentId: `epic_${goal.id}` }))[0];
      await k.cardStore.createCard({
        id: "closer",
        tier: "task",
        title: "c",
        status: "in_progress",
      });
      const board = new BoardServiceImpl(k.cardStore);
      for (const [from, to] of [
        ["in_progress", "verify"],
        ["verify", "review"],
      ] as const) {
        await board.transitionCard({
          cardId: "closer",
          fromStatus: from,
          toStatus: to,
          actor: "harness",
          reason: "gates passed",
        });
      }
      const n0 = await updates();
      expect(await ticker.tick()).toBe("idle");
      await board.transitionCard({
        cardId: "closer",
        fromStatus: "review",
        toStatus: "done",
        actor: "human",
        reason: "accepted",
      });
      expect(await ticker.tick()).toBe("closed");
      expect(await updates()).toBe(n0 + 1);
      expect(await ticker.tick()).toBe("idle");
      clock += HOUR;
      expect(await ticker.tick()).toBe("hourly");
      expect(await updates()).toBe(n0 + 2);
      expect(card).toBeDefined();
    } finally {
      ticker.stop();
    }
  });

  it("PM-N4-2, -3: a metric read from the repository and a person's mark meet their criteria", async () => {
    const k = kernel();
    const goal = await activeGoal(k);
    mkdirSync(join(k.repoPath, "coverage"));
    writeFileSync(
      join(k.repoPath, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 86.5 } } }),
    );
    const human = goal.criteria.find((c) => c.kind === "human");
    const out: string[] = [];
    expect(
      await runDevCommand("goal", ["mark", goal.id, human?.id as string, "met"], k, {
        print: (l) => out.push(l),
      }),
    ).toBe(0);
    await queuePrelude(k, [], { ...quiet, setup: "solo" });
    const after = await new GoalStore({ store: k.cardStore, log: k.log }).get(goal.id);
    expect(after?.criteria.find((c) => c.kind === "metric")?.status).toBe("met");
    expect(after?.criteria.find((c) => c.kind === "human")?.status).toBe("met");
  });

  it("PM-N4-4, -5: a lockfile change fires environment_changed, replans, and posts the diff and reason", async () => {
    const k = kernel();
    const goal = await activeGoal(k);
    await queuePrelude(k, [], { ...quiet, setup: "solo" });
    expect((await k.log.getEventsByTypes(["goal/replanned"])).length).toBe(0);
    writeFileSync(join(k.repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nzod: 4.0.0\n");
    const { lines } = await queuePrelude(k, [], { ...quiet, setup: "solo" });
    const replanned = (await k.log.getEventsByTypes(["goal/replanned"])).at(-1)?.payload as {
      triggers: string[];
      reason: string;
    };
    expect(replanned.triggers).toContain("environment_changed");
    expect(replanned.reason).toMatch(/pnpm-lock\.yaml changed/);
    expect(lines.join("\n")).toMatch(new RegExp(`Goal ${goal.id} replanned to v2`));
    const post = (await new PmStore(k.log).thread()).find(
      (m) => m.role === "pm" && m.text.includes("pnpm-lock.yaml changed"),
    );
    expect(post?.text).toMatch(/= \d+ unchanged/);
    expect(post?.text.split("\n\n")[0]).not.toContain("\n");
  });

  it("PM-N9-9: in the Team setup a goal re-plan that would remove an owned issue suggests it to the owner", async () => {
    const k = kernel();
    const goal = await activeGoal(k);
    const epicId = `epic_${goal.id}`;
    // An issue Priya owns that an earlier plan version made and the next one will not.
    const ledger = { store: k.cardStore, log: k.log };
    const v1 = await latestPlan(ledger, epicId);
    const ownedId = "owned_story";
    await k.cardStore.createCard({
      id: ownedId,
      tier: "story",
      title: "Export invoices as PDF",
      status: "ready",
      parentId: epicId,
      owner: "p_priya",
      acceptanceCriteria: ["a PDF downloads"],
    });
    await k.log.append({
      actor: "planner",
      type: "plan/replanned",
      payload: {
        epicId,
        version: 2,
        trigger: "manual",
        reason: "fixture",
        stories: [
          ...(v1?.stories ?? []),
          {
            id: ownedId,
            title: "Export invoices as PDF",
            slice: "path",
            scopeFiles: [],
            difficulty: 3,
            routing: "direct",
            dependsOn: [],
          },
        ],
        diff: { added: [ownedId], removed: [], changed: [] },
      },
    });
    const statusBefore = (await k.cardStore.getCard(ownedId))?.status;
    await queuePrelude(k, [], { ...quiet, setup: "team" });
    writeFileSync(join(k.repoPath, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nzod: 4.0.0\n");
    await queuePrelude(k, [], { ...quiet, setup: "team" });
    expect((await k.cardStore.getCard(ownedId))?.status).toBe(statusBefore);
    expect(suggestionsOn(k, ownedId)).toEqual([
      expect.objectContaining({
        kind: "remove",
        value: expect.stringMatching(/^Removed by the re-plan of /),
      }),
    ]);
  });
});
