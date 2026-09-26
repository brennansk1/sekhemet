import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOAL_EVENTS,
  GoalStore,
  type PlannerLedger,
  SpidrFeaturePlanner,
  approveGoal,
  computeSignals,
  goalReplanReason,
  intakeGoal,
  runGoalLoop,
  workerDegradation,
} from "../src/index.js";

/** An on-disk SQLite file per ledger (DEFINITION_OF_DONE §2A). */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function ledger(): PlannerLedger {
  const dir = mkdtempSync(join(tmpdir(), "sek-live-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "events.db"));
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

/** A gate result as the kernel records it: `passed`, and failures located in files. */
async function gateResult(
  l: PlannerLedger,
  cardId: string,
  gate: string,
  passed: boolean,
  files: string[] = [],
): Promise<void> {
  const a = await l.store.runs.startAttempt({
    cardId,
    attemptNumber: l.store.runs.nextAttemptNumber(cardId),
    modelId: "m",
  });
  await l.store.runs.recordGateResult({
    attemptId: a.id,
    cardId,
    gate,
    layer: "static",
    passed,
    exitCode: passed ? 0 : 1,
    durationMs: 1,
    source: "local",
    failures: files.map((file) => ({ gate, location: { file }, errorExcerpt: "x" })),
  });
}

const GOAL =
  "Users can sign in with a password, the test suite passes, and coverage is at least 80%.";

describe("signals read the kernel's gate records (§2.12)", () => {
  it("counts failures by their located file and never counts a passing result (PM-N5-2)", async () => {
    const l = ledger();
    await l.store.createCard({
      id: "hot",
      tier: "story",
      title: "hot",
      status: "ready",
      scopeFiles: ["src/pay.ts"],
    });
    for (let i = 0; i < 3; i++) await gateResult(l, "hot", "unit", false, ["src/pay.ts"]);
    for (let i = 0; i < 5; i++) await gateResult(l, "hot", "lint", true);
    const readings = computeSignals({
      now: new Date(),
      cards: await l.store.listCards(),
      events: await l.log.getEventsByTypes(["gate/result"]),
      reviewWip: 3,
    });
    const hot = readings.find((r) => r.id === "failure_concentration");
    expect(hot?.value).toBe(3);
    expect(hot?.triggered).toBe(true);
    expect(hot?.detail).toContain("src/pay.ts");
    expect(hot?.response).toMatchObject({ action: "resplit_hotspot", mode: "proposal" });
    expect(hot?.response?.targets).toEqual(["hot"]);
  });

  it("answers blocked time with a proposal, never an automatic change (PM-N2-1)", async () => {
    const l = ledger();
    await l.store.createCard({ id: "b", tier: "story", title: "b", status: "backlog" });
    await l.store.updateCard("b", { blockedReason: "x" });
    const c = (await l.store.getCard("b")) as never as { updatedAt: string };
    const readings = computeSignals({
      now: new Date(Date.parse(c.updatedAt) + 13 * 3_600_000),
      cards: (await l.store.listCards()).map((x) => ({ ...x, status: "parked" as const })),
      events: [],
      reviewWip: 3,
    });
    const blocked = readings.find((r) => r.id === "blocked_time");
    expect(blocked?.triggered).toBe(true);
    expect(blocked?.response?.mode).toBe("proposal");
  });

  it("measures scope drift per planned epic over the cards no plan version made (PM-N5-1)", () => {
    const at = new Date().toISOString();
    const mk = (id: string, parentId: string, extra = {}) => ({
      id,
      tier: "story" as const,
      title: id,
      status: "ready" as const,
      scopeFiles: [],
      stepBudget: 10,
      stepsUsed: 0,
      createdAt: at,
      updatedAt: at,
      parentId,
      ...extra,
    });
    const cards = [
      mk("p1", "e1"),
      mk("p2", "e1"),
      mk("p3", "e1"),
      mk("p4", "e1"),
      mk("split", "e1", { split: "rules", splitDepth: 1 }),
      mk("aux1", "e1"),
      mk("aux2", "e1"),
      mk("other", "e2"),
    ];
    const readings = computeSignals({
      now: new Date(),
      cards,
      events: [],
      reviewWip: 3,
      plans: [{ epicId: "e1", originalCardIds: ["p1", "p2", "p3", "p4"], plannedCardIds: [] }],
    });
    const drift = readings.find((r) => r.id === "scope_drift");
    expect(drift?.value).toBe(0.5);
    expect(drift?.triggered).toBe(true);
    expect(drift?.response).toMatchObject({ action: "halt_aux_cards_and_ask", mode: "decision" });
    expect(drift?.response?.targets).toEqual(["aux1", "aux2"]);
    expect(drift?.epicId).toBe("e1");
  });
});

describe("possible Worker degradation (PM-N5-3)", () => {
  const record = (earlier: boolean[], recent: boolean[]) => [...earlier, ...recent];
  const n = (passes: number, total: number) => Array.from({ length: total }, (_, i) => i < passes);

  it("is named when the last 10 attempts pass below the lower bound of the Worker's 95% interval", () => {
    const d = workerDegradation(record(n(18, 20), n(3, 10)));
    expect(d?.degraded).toBe(true);
    expect(d?.recentRate).toBe(0.3);
    expect(d?.low).toBeGreaterThan(0.3);
    expect(d?.text).toMatch(/possible model degradation/i);
  });

  it("is not named inside the interval, or before there is a record to compare with", () => {
    expect(workerDegradation(record(n(18, 20), n(8, 10)))?.degraded).toBe(false);
    expect(workerDegradation(n(2, 10))).toBeUndefined();
  });
});

describe("the goal loop re-evaluates on the right inputs (NEW-planner-pm-4)", () => {
  it("marks a gate criterion from the kernel's gate record (`passed`)", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, GOAL);
    const { goal } = await approveGoal(l, planner, intake.goal.id);
    const card = (await l.store.listCards()).find((c) => c.parentId === `epic_${goal.id}`);
    await gateResult(l, card?.id as string, "unit", true);
    const r = await runGoalLoop(l, planner, goal.id, {
      metrics: { coverage: 85 },
      humanMarks: await new GoalStore(l).humanMarks(goal.id),
    });
    const byKind = Object.fromEntries(r.evaluation.criteria.map((c) => [c.kind, c.status]));
    expect(byKind.gate).toBe("met");
    expect(byKind.metric).toBe("met");
  });

  it("uses a person's mark of a human criterion at the next evaluation (PM-N4-3)", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, GOAL);
    const { goal } = await approveGoal(l, planner, intake.goal.id);
    const human = goal.criteria.find((c) => c.kind === "human");
    await new GoalStore(l).markHuman(goal.id, human?.id as string, true, "p_owner");
    const r = await runGoalLoop(l, planner, goal.id, {
      humanMarks: await new GoalStore(l).humanMarks(goal.id),
    });
    expect(r.evaluation.criteria.find((c) => c.id === human?.id)?.status).toBe("met");
  });

  it("fires environment_changed when the fingerprint moves, replans, and records why (PM-N4-4, -5)", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, GOAL);
    const { goal } = await approveGoal(l, planner, intake.goal.id);
    const first = await runGoalLoop(l, planner, goal.id, { environment: "sha-a" });
    expect(first.evaluation.triggers.map((t) => t.trigger)).not.toContain("environment_changed");
    expect((await new GoalStore(l).get(goal.id))?.environment).toBe("sha-a");
    const same = await runGoalLoop(l, planner, goal.id, { environment: "sha-a" });
    expect(same.replanned).toBe(false);
    const moved = await runGoalLoop(l, planner, goal.id, { environment: "sha-b" });
    expect(moved.evaluation.triggers.map((t) => t.trigger)).toContain("environment_changed");
    expect(moved.replanned).toBe(true);
    expect(moved.replan?.version).toBe(2);
    expect(moved.replan?.reason).toMatch(/environment/);
    expect(moved.replan?.reason.split("\n")).toHaveLength(1);
    const events = await l.log.getEventsByTypes([GOAL_EVENTS.replanned]);
    const p = events.at(-1)?.payload as { triggers?: string[]; reason?: string };
    expect(p.triggers).toContain("environment_changed");
    expect(p.reason).toBe(moved.replan?.reason);
  });

  it("replans through the caller's replanner when one is given (the Team setup's route, PM-N9-9)", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, GOAL);
    const { goal } = await approveGoal(l, planner, intake.goal.id);
    const calls: string[] = [];
    const r = await runGoalLoop(l, planner, goal.id, {
      environmentChanged: true,
      replan: async (req) => {
        calls.push(req.epicId);
        return {
          version: 7,
          diff: { added: [], removed: [], changed: [], unchanged: 0 },
          applied: false,
        };
      },
    });
    expect(calls).toEqual([`epic_${goal.id}`]);
    expect(r.replan?.version).toBe(7);
    expect((await new GoalStore(l).get(goal.id))?.strategy).toBe(`epic_${goal.id}@v7`);
  });

  it("writes the reason as one paragraph naming the goal, the triggers and the criteria", () => {
    const text = goalReplanReason(
      {
        statement: "Ship sign-in",
        criteria: [
          { id: "a", text: "tests pass", kind: "gate", status: "met" },
          { id: "b", text: "coverage at least 80%", kind: "metric", status: "unmet" },
        ],
      },
      [{ trigger: "environment_changed", detail: "pnpm-lock.yaml changed" }],
      3,
    );
    expect(text).toContain("Ship sign-in");
    expect(text).toContain("pnpm-lock.yaml changed");
    expect(text).toContain("coverage at least 80%");
    expect(text).not.toContain("\n");
  });
});
