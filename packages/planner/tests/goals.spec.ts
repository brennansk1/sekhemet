import { DatabaseSync } from "node:sqlite";
import { type CardRecord, CardStore, EventLog, initSchema } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import {
  GoalStore,
  type PlannerLedger,
  SpidrFeaturePlanner,
  approveGoal,
  ceremoniesDue,
  checkMetric,
  computeSignals,
  evaluateGoal,
  goalVerdict,
  intakeGoal,
  processProfileFromConfig,
  proposeCriteria,
  rankGoals,
  runGoalLoop,
  triggeredResponses,
} from "../src/index.js";
import type { Goal } from "../src/index.js";

function ledger(): PlannerLedger {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const log = new EventLog(db);
  return { log, store: new CardStore(db, log) };
}

const STATEMENT =
  "Users can sign in with a password, the test suite passes, and coverage is at least 80%.";

describe("P17: goal record and criteria", () => {
  it("proposes one criterion per clause with its check kind", () => {
    const c = proposeCriteria(STATEMENT);
    expect(c.map((x) => x.kind)).toEqual(["human", "gate", "metric"]);
    expect(c[1]?.check?.gateRef).toBe("unit");
    expect(c[2]?.check?.metricQuery).toBe("coverage >= 80%");
    expect(checkMetric("coverage >= 80%", { coverage: 85 })).toBe(true);
    expect(checkMetric("latency <= 200ms", { latency: 250 })).toBe(false);
    expect(checkMetric("x >= 1", {})).toBeUndefined();
  });
});

describe("P18: /goal intake needs approval before anything runs", () => {
  it("saves a draft with budget and criteria; approval creates strategy v1", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, STATEMENT, { now: new Date("2026-09-19T00:00:00Z") });
    expect(intake.goal.state).toBe("draft");
    expect(intake.goal.budget.tokens).toBeGreaterThan(0);
    expect(intake.restatement).toContain("[gate]");
    expect(await l.store.listCards()).toHaveLength(0);
    const { goal, plan } = await approveGoal(l, planner, intake.goal.id);
    expect(goal.state).toBe("active");
    expect(goal.strategy).toBe(`epic_${goal.id}@v1`);
    expect(plan.created.length).toBeGreaterThan(0);
    await expect(approveGoal(l, planner, intake.goal.id)).rejects.toThrow(/not a draft/);
  });

  it("refuses to start a goal only a human can check", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, "The app feels delightful to use.");
    expect(intake.unverifiableWarning).toMatch(/gate or a metric/);
    await expect(approveGoal(l, planner, intake.goal.id)).rejects.toThrow(/verify/);
  });
});

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1",
  workspaceId: "w",
  projectIds: [],
  statement: "s",
  criteria: [
    { id: "c1", text: "tests pass", kind: "gate", check: { gateRef: "unit" }, status: "met", everMet: true },
    { id: "c2", text: "coverage", kind: "metric", check: { metricQuery: "coverage >= 80" }, status: "unmet" },
  ],
  budget: { tokens: 100_000, hours: 2 },
  strategy: "epic_g1@v1",
  state: "active",
  assumptions: [],
  strategiesTried: 1,
  createdAt: "",
  ...over,
});

const card = (over: Partial<CardRecord>): CardRecord => ({
  id: "x",
  tier: "story",
  title: "x",
  status: "ready",
  scopeFiles: [],
  stepBudget: 20,
  stepsUsed: 0,
  createdAt: "2026-09-19T00:00:00Z",
  updatedAt: "2026-09-19T00:00:00Z",
  parentId: "epic_g1",
  ...over,
});

describe("P19: goal loop and replan triggers", () => {
  it("detects rung-3 failures, regressions and budget forecasts over the cap", () => {
    const ev = evaluateGoal(goal(), {
      cards: [
        card({ id: "a", status: "parked", stopReason: "repair_exhausted", tokensUsed: 90_000 }),
        card({ id: "b", difficulty: 9 }),
      ],
      events: [{ type: "gate/result", payload: { gate: "unit", status: "fail" } } as never],
      metrics: { coverage: 85 },
    });
    expect(ev.criteria.map((c) => c.status)).toEqual(["unmet", "met"]);
    expect(ev.triggers.map((t) => t.trigger).sort()).toEqual([
      "budget_forecast_over_cap",
      "criterion_regressed",
      "rung3_failure",
    ]);
  });

  it("runGoalLoop replans on a trigger and records a new strategy version", async () => {
    const l = ledger();
    const planner = new SpidrFeaturePlanner();
    const intake = await intakeGoal(l, planner, STATEMENT);
    const { goal: g } = await approveGoal(l, planner, intake.goal.id);
    const first = (await l.store.listCards()).find((c) => c.parentId === `epic_${g.id}`);
    await l.store.updateCard(first?.id as string, { stopReason: "repair_exhausted" });
    const r = await runGoalLoop(l, planner, g.id);
    expect(r.replanned).toBe(true);
    const after = await new GoalStore(l).get(g.id);
    expect(after?.strategy).toBe(`epic_${g.id}@v2`);
    expect(after?.strategiesTried).toBe(2);
  });
});

describe("P22: honest stopping", () => {
  it("met only when every criterion is verified; blocked with a diagnosis when exhausted", () => {
    const allMet = goal({
      criteria: [{ id: "c1", text: "t", kind: "gate", check: { gateRef: "unit" }, status: "met" }],
    });
    expect(goalVerdict({ goal: allMet, criteria: allMet.criteria, triggers: [], spentTokens: 0, forecastTokens: 0 }).state).toBe("met");
    const g = goal({ strategiesTried: 3 });
    const v = goalVerdict({ goal: g, criteria: g.criteria, triggers: [], spentTokens: 50_000, forecastTokens: 0 });
    expect(v.state).toBe("blocked");
    expect(v.diagnosis).toContain("Met: tests pass.");
    expect(v.diagnosis).toContain("Not met: coverage (unmet)");
    expect(v.diagnosis).toContain("Smallest unblocking action");
    const partial = goal({ strategiesTried: 1 });
    expect(goalVerdict({ goal: partial, criteria: partial.criteria, triggers: [], spentTokens: 0, forecastTokens: 0 }).state).toBe("active");
  });
});

describe("P21: multiple goals ranked by WSJF", () => {
  it("ranks by cost of delay over remaining size; onlyActive wins", () => {
    const a = goal({ id: "a", strategy: "epic_a@v1", value: { userBusinessValue: 8, timeCriticality: 2, riskReduction: 0 } });
    const b = goal({ id: "b", strategy: "epic_b@v1", value: { userBusinessValue: 3, timeCriticality: 0, riskReduction: 0 } });
    const cards = [card({ id: "1", parentId: "epic_a", difficulty: 4 }), card({ id: "2", parentId: "epic_b", difficulty: 4 })];
    expect(rankGoals([a, b], cards).map((r) => r.goalId)).toEqual(["a", "b"]);
    const r = rankGoals([a, { ...b, onlyActive: true }], cards);
    expect(r[0]?.goalId).toBe("b");
    expect(r[0]?.why).toMatch(/only active goal/);
  });
});

describe("P16: process profiles", () => {
  it("reads the profile from config and says which ceremonies are due", () => {
    const scrum = processProfileFromConfig({ process: { profile: "scrum", cycle_days: 7 } });
    expect(scrum).toMatchObject({ name: "scrum", cycleDays: 7, commitment: "sprint_goal" });
    const now = new Date("2026-09-19T00:00:00Z");
    expect(
      ceremoniesDue(scrum, { now, cycleStart: new Date("2026-09-10T00:00:00Z"), closedSinceRetro: 0, intakePending: false }).map((c) => c.kind),
    ).toEqual(["planning", "retrospective"]);
    const shape = processProfileFromConfig({ process: { profile: "shape-up" } });
    expect(ceremoniesDue(shape, { now, closedSinceRetro: 0, intakePending: false }).map((c) => c.kind)).toEqual([
      "planning",
      "betting",
    ]);
    const kanban = processProfileFromConfig(undefined);
    expect(
      ceremoniesDue(kanban, { now, closedSinceRetro: 10, intakePending: true }).map((c) => c.kind),
    ).toEqual(["planning", "retrospective"]);
  });
});

describe("P20: seven live signals with thresholds and responses", () => {
  it("computes all seven and triggers the configured responses", () => {
    const now = new Date("2026-09-19T12:00:00Z");
    const ev = (type: string, cardId: string | undefined, payload: unknown, at: string) =>
      ({ type, cardId, payload, createdAt: at }) as never;
    const cards = [
      card({ id: "p1", status: "done", updatedAt: "2026-09-19T01:00:00Z" }),
      card({ id: "p2", status: "done", updatedAt: "2026-09-19T03:00:00Z" }),
      card({ id: "new1", status: "ready" }),
      card({ id: "blk", status: "parked", updatedAt: "2026-09-18T00:00:00Z" }),
      card({ id: "r1", status: "review" }),
      card({ id: "hot", status: "in_progress", scopeFiles: ["src/ledger.ts"] }),
    ];
    const fail = (i: number) => ev("gate/result", "hot", { status: "fail", excerpt: "src/ledger.ts:1 error" }, `2026-09-19T0${i}:00:00Z`);
    const readings = computeSignals({
      now,
      cards,
      events: [
        fail(1),
        fail(2),
        fail(3),
        ev("assumption/logged", undefined, { id: "as1" }, "2026-09-17T00:00:00Z"),
      ],
      originalPlanCardIds: ["p1", "p2", "blk", "r1"],
      reviewWip: 1,
    });
    expect(readings.map((r) => r.id)).toEqual([
      "burn_up",
      "scope_drift",
      "cycle_time",
      "blocked_time",
      "failure_concentration",
      "review_backlog",
      "risk_register",
    ]);
    const fired = triggeredResponses(readings).map((r) => `${r.id}:${r.response?.action}`);
    expect(fired).toEqual([
      "scope_drift:halt_aux_cards_and_ask",
      "blocked_time:escalate_blockers",
      "failure_concentration:resplit_hotspot",
      "review_backlog:backpressure_verify",
      "risk_register:dispatch_verification_spike",
    ]);
    expect(readings.find((r) => r.id === "failure_concentration")?.response?.targets).toEqual(["hot"]);
    expect(readings[0]?.detail).toMatch(/2 of 6 cards verified/);
  });
});
