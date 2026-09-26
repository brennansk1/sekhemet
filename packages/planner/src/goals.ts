import type { CardRecord, EventRecord } from "@sekhemet/kernel";
import { EstimationModel } from "./estimation.js";
import { type PlannerLedger, appendPlannerEvent, plannerEvents } from "./ledger.js";
import { type PersistPlanResult, persistPlan } from "./persist.js";
import type { SpidrFeaturePlanner } from "./planner.js";
import { scoreWsjf } from "./prioritization.js";
import { type PlanDiff, type ReplanTrigger, replanSession } from "./sessions.js";
import { splitSentences } from "./text.js";
import type { SpidrPlan } from "./types.js";

/**
 * Goals and live project management (P17-P22, design "Goals and live
 * project management"). A goal is an outcome with checkable criteria that
 * the planner pursues until every criterion is met and verified, or it
 * reports honestly that it cannot. Goals live in the ledger (`goal/*`
 * events) and are rebuilt by projection.
 */
export type CriterionKind = "gate" | "metric" | "human";
export type CriterionStatus = "unmet" | "met" | "unverifiable";

export interface GoalCriterion {
  id: string;
  text: string;
  kind: CriterionKind;
  check?: { gateRef?: string; metricQuery?: string };
  status: CriterionStatus;
  /** Was met at some point (a regression is met -> unmet). */
  everMet?: boolean;
}

export type GoalState = "draft" | "active" | "blocked" | "met" | "abandoned";

export interface Goal {
  id: string;
  workspaceId: string;
  projectIds: string[];
  statement: string;
  criteria: GoalCriterion[];
  budget: { tokens: number; hours: number; deadline?: string };
  /** The current strategy: the epic that holds its plan, and the plan version. */
  strategy: string;
  state: GoalState;
  /** WSJF inputs at the goal level (P21). */
  value?: { userBusinessValue: number; timeCriticality: number; riskReduction: number };
  onlyActive?: boolean;
  assumptions: string[];
  diagnosis?: string;
  strategiesTried: number;
  createdAt: string;
  /**
   * The environment's fingerprint at the last evaluation — lockfiles and
   * toolchain versions, hashed by the caller (PM-N4-4). A different one at
   * the next evaluation fires `environment_changed`.
   */
  environment?: string;
}

export const GOAL_EVENTS = {
  created: "goal/created",
  approved: "goal/approved",
  updated: "goal/updated",
  replanned: "goal/replanned",
  stopped: "goal/stopped",
  /** A person marked a `human` criterion met or not (PM-N4-3). */
  criterionMarked: "goal/criterion_marked",
} as const;

// ------------------------------------------------------------- criteria (P17)

const GATE_WORDS =
  /\b(tests? pass|test suite|typecheck|type-check|lint|build|gate|compiles?|ci (is )?green)\b/i;
const METRIC =
  /\b(coverage|latency|p9[59]|p50|throughput|size|errors?|findings?|time|score)\b[^.]*?(\d+(?:\.\d+)?)\s*(%|ms|s|kb|mb|x)?/i;

function gateRefOf(text: string): string {
  if (/lint/i.test(text)) return "lint";
  if (/type-?check|compiles?/i.test(text)) return "typecheck";
  if (/build/i.test(text)) return "build";
  return "unit";
}

function metricQueryOf(text: string): string | undefined {
  const m = METRIC.exec(text);
  if (!m) return undefined;
  const name = (m[1] as string).toLowerCase();
  const below = /\b(below|under|less than|at most|<|no more than|zero|no )\b/i.test(text);
  return `${name} ${below ? "<=" : ">="} ${m[2]}${m[3] ?? ""}`;
}

/** Propose criteria from a goal statement: one per clause, with a check kind. */
export function proposeCriteria(statement: string): GoalCriterion[] {
  // One criterion per list item: split sentences on commas, semicolons and
  // a list-final "and"; clauses inside an item stay together.
  const clauses = splitSentences(statement)
    .flatMap((sentence) => sentence.replace(/[.!]+$/, "").split(/\s*;\s*|,\s*(?:and\s+)?/))
    .map((c) => c.trim())
    .filter((c) => c.length > 3);
  return clauses.map((text, i): GoalCriterion => {
    const id = `crit_${i + 1}`;
    const metric = metricQueryOf(text);
    if (metric)
      return { id, text, kind: "metric", check: { metricQuery: metric }, status: "unmet" };
    if (GATE_WORDS.test(text)) {
      return { id, text, kind: "gate", check: { gateRef: gateRefOf(text) }, status: "unmet" };
    }
    return { id, text, kind: "human", status: "unmet" };
  });
}

// ---------------------------------------------------------------- the store

export class GoalStore {
  constructor(private readonly ledger: PlannerLedger) {}

  public async all(): Promise<Goal[]> {
    const events = await plannerEvents(this.ledger, Object.values(GOAL_EVENTS));
    const goals = new Map<string, Goal>();
    for (const e of events) {
      const p = e.payload as { goal?: Goal; id?: string; patch?: Partial<Goal> };
      if (e.type === GOAL_EVENTS.created && p.goal) {
        goals.set(p.goal.id, p.goal);
        continue;
      }
      const g = p.id ? goals.get(p.id) : undefined;
      if (g && p.patch) Object.assign(g, p.patch);
    }
    return [...goals.values()];
  }

  public async get(id: string): Promise<Goal | undefined> {
    return (await this.all()).find((g) => g.id === id);
  }

  /**
   * A person marks a `human` criterion met or not (PM-N4-3): recorded as
   * `goal/criterion_marked` with their principal, read at the next evaluation.
   */
  public async markHuman(
    goalId: string,
    criterionId: string,
    met: boolean,
    principal: string,
  ): Promise<void> {
    if (!principal) throw new Error("A criterion is marked by a person; no principal was given");
    const goal = await this.get(goalId);
    if (!goal) throw new Error(`No goal ${goalId}`);
    const criterion = goal.criteria.find((c) => c.id === criterionId);
    if (!criterion || criterion.kind !== "human") {
      throw new Error(
        `Goal ${goalId} has no human criterion ${criterionId}; only a human criterion is marked by a person`,
      );
    }
    await this.ledger.log.append({
      actor: "human",
      type: GOAL_EVENTS.criterionMarked,
      payload: { goalId, criterionId, met },
      principal,
    });
  }

  /** The latest person's mark of each human criterion of a goal (`evaluateGoal`'s `humanMarks`). */
  public async humanMarks(goalId: string): Promise<Record<string, boolean>> {
    const marks: Record<string, boolean> = {};
    for (const e of await plannerEvents(this.ledger, [GOAL_EVENTS.criterionMarked])) {
      const p = e.payload as { goalId: string; criterionId: string; met: boolean };
      if (p.goalId === goalId && e.actor === "human") marks[p.criterionId] = p.met;
    }
    return marks;
  }

  public async create(goal: Goal): Promise<void> {
    await appendPlannerEvent(this.ledger, GOAL_EVENTS.created, { goal });
  }

  /** `extra` is recorded beside the patch (a replan's triggers, reason and diff) and never folded into the goal. */
  public async patch(
    id: string,
    patch: Partial<Goal>,
    type: string = GOAL_EVENTS.updated,
    extra: Record<string, unknown> = {},
  ): Promise<Goal> {
    await appendPlannerEvent(this.ledger, type, { ...extra, id, patch });
    return (await this.get(id)) as Goal;
  }
}

// ------------------------------------------------------------- intake (P18)

export interface GoalIntake {
  goal: Goal;
  plan: SpidrPlan;
  restatement: string;
  /** Present when every criterion is human-checked: ask for a checkable one. */
  unverifiableWarning?: string;
}

/**
 * `/goal <statement>`: restate the outcome, propose criteria with check
 * kinds, estimate the budget from the competence model, list assumptions.
 * The goal is saved as a draft; nothing runs until `approveGoal`.
 */
export async function intakeGoal(
  ledger: PlannerLedger,
  planner: SpidrFeaturePlanner,
  statement: string,
  options: { workspaceId?: string; projectIds?: string[]; now?: Date; deadline?: string } = {},
): Promise<GoalIntake> {
  const now = options.now ?? new Date();
  const id = `goal_${now.getTime().toString(36)}`;
  const criteria = proposeCriteria(statement);
  const plan = await planner.decomposeSpec({
    parentId: `epic_${id}`,
    parentTier: "epic",
    spec: statement,
  });
  const estimator = EstimationModel.fromCards(await ledger.store.listCards());
  const estimates = plan.stories.map((s) => estimator.estimateStory(s));
  const tokens = estimates.reduce((a, e) => a + e.tokensRange[1], 0);
  const seconds = estimates.reduce((a, e) => a + e.secondsRange[1], 0);
  const allHuman = criteria.length > 0 && criteria.every((c) => c.kind === "human");
  const goal: Goal = {
    id,
    workspaceId: options.workspaceId ?? "default",
    projectIds: options.projectIds ?? [],
    statement,
    criteria: allHuman ? criteria.map((c) => ({ ...c, status: "unverifiable" })) : criteria,
    budget: {
      tokens,
      hours: Math.round((seconds / 3600) * 10) / 10,
      ...(options.deadline ? { deadline: options.deadline } : {}),
    },
    strategy: "",
    state: "draft",
    assumptions: plan.ambiguity.assumptions.map((a) => a.statement),
    strategiesTried: 0,
    createdAt: now.toISOString(),
  };
  await new GoalStore(ledger).create(goal);
  return {
    goal,
    plan,
    restatement: `Outcome: ${statement.replace(/\s+/g, " ").trim()} Criteria: ${criteria
      .map((c) => `[${c.kind}] ${c.text}`)
      .join("; ")}. Budget: ${goal.budget.tokens} tokens, ${goal.budget.hours}h (upper estimate).`,
    ...(allHuman
      ? {
          unverifiableWarning:
            "Every criterion needs a person to check it. Add at least one criterion a gate or a metric can verify.",
        }
      : {}),
  };
}

/**
 * Human approval of the criteria: the goal becomes active and strategy v1
 * (its plan of cards, under an epic) is created. Refused while every
 * criterion is unverifiable.
 */
export async function approveGoal(
  ledger: PlannerLedger,
  planner: SpidrFeaturePlanner,
  goalId: string,
): Promise<{ goal: Goal; plan: PersistPlanResult }> {
  const store = new GoalStore(ledger);
  const goal = await store.get(goalId);
  if (!goal) throw new Error(`No goal ${goalId}`);
  if (goal.state !== "draft") throw new Error(`Goal ${goalId} is ${goal.state}, not a draft`);
  if (goal.criteria.every((c) => c.status === "unverifiable")) {
    throw new Error(
      "Refusing to start a goal no gate or metric can verify; add a checkable criterion.",
    );
  }
  const epicId = `epic_${goal.id}`;
  if (!(await ledger.store.getCard(epicId))) {
    await ledger.store.createCard({
      id: epicId,
      tier: "epic",
      title: goal.statement,
      status: "in_progress",
    });
  }
  const plan = await planner.decomposeSpec({
    parentId: epicId,
    parentTier: "epic",
    spec: goal.statement,
  });
  const persisted = await persistPlan(ledger, plan, { epicId });
  const updated = await store.patch(
    goalId,
    { state: "active", strategy: `${epicId}@v${persisted.version}`, strategiesTried: 1 },
    GOAL_EVENTS.approved,
  );
  return { goal: updated, plan: persisted };
}

// --------------------------------------------------------- the goal loop (P19)

export type GoalReplanTrigger =
  | "rung3_failure"
  | "criterion_regressed"
  | "budget_forecast_over_cap"
  | "environment_changed"
  | "card_advances_nothing";

export interface GoalEvaluation {
  goal: Goal;
  criteria: GoalCriterion[];
  triggers: { trigger: GoalReplanTrigger; detail: string }[];
  spentTokens: number;
  forecastTokens: number;
}

/** `name op value` against measured values, e.g. `coverage >= 80%`. */
export function checkMetric(query: string, values: Record<string, number>): boolean | undefined {
  const m = /^(\S+)\s*(<=|>=|<|>|==)\s*([\d.]+)/.exec(query.trim());
  if (!m) return undefined;
  const v = values[m[1] as string];
  if (v === undefined) return undefined;
  const t = Number(m[3]);
  switch (m[2]) {
    case "<=":
      return v <= t;
    case ">=":
      return v >= t;
    case "<":
      return v < t;
    case ">":
      return v > t;
    default:
      return v === t;
  }
}

/**
 * Re-evaluate every criterion (on every card close and on a timer) and
 * detect the replan triggers. Pure over its inputs; `recordEvaluation`
 * writes the changes.
 */
export function evaluateGoal(
  goal: Goal,
  input: {
    cards: readonly CardRecord[];
    events: readonly EventRecord[];
    metrics?: Record<string, number>;
    humanMarks?: Record<string, boolean>;
    environmentChanged?: boolean;
    /** What changed, for the trigger's detail (a lockfile, a toolchain version). */
    environmentDetail?: string;
    estimator?: EstimationModel;
  },
): GoalEvaluation {
  const epicId = goal.strategy.split("@")[0] ?? "";
  const cards = input.cards.filter((c) => c.parentId === epicId);
  const lastGate = new Map<string, string>();
  for (const e of input.events) {
    if (e.type !== "gate/result") continue;
    // The kernel's record says `passed` (`GateResultRecord`); `status` is an older writer's shape.
    const p = e.payload as { gate?: string; status?: string; passed?: boolean };
    if (!p.gate) continue;
    lastGate.set(
      p.gate,
      typeof p.passed === "boolean" ? (p.passed ? "passed" : "failed") : (p.status ?? "unknown"),
    );
  }
  const criteria = goal.criteria.map((c): GoalCriterion => {
    let met: boolean | undefined;
    if (c.kind === "gate" && c.check?.gateRef) {
      const s = lastGate.get(c.check.gateRef);
      met = s === undefined ? undefined : s === "pass" || s === "passed";
    } else if (c.kind === "metric" && c.check?.metricQuery) {
      met = checkMetric(c.check.metricQuery, input.metrics ?? {});
    } else if (c.kind === "human") {
      met = input.humanMarks?.[c.id];
    }
    if (met === undefined) return c;
    return { ...c, status: met ? "met" : "unmet", everMet: c.everMet || met };
  });
  const triggers: GoalEvaluation["triggers"] = [];
  for (const c of cards) {
    if (c.stopReason === "repair_exhausted" || c.stopReason === "capability_ceiling") {
      triggers.push({
        trigger: "rung3_failure",
        detail: `${c.id} failed at rung 3 (${c.stopReason})`,
      });
    }
  }
  for (const c of criteria) {
    const before = goal.criteria.find((x) => x.id === c.id);
    if ((before?.status === "met" || before?.everMet) && c.status === "unmet") {
      triggers.push({
        trigger: "criterion_regressed",
        detail: `"${c.text}" regressed after being met`,
      });
    }
  }
  const spentTokens = cards.reduce((a, c) => a + (c.tokensUsed ?? 0), 0);
  const estimator = input.estimator ?? EstimationModel.fromCards(input.cards);
  const remaining = cards
    .filter((c) => c.status !== "done" && c.status !== "rejected")
    .reduce(
      (a, c) =>
        a +
        estimator.estimate({
          tier: c.tier,
          labels: c.labels,
          difficulty: c.difficulty ?? 5,
          basePackTokens: 2_000,
          stepBudget: c.stepBudget,
        }).tokens,
      0,
    );
  const forecastTokens = spentTokens + remaining;
  if (goal.budget.tokens > 0 && forecastTokens > goal.budget.tokens) {
    triggers.push({
      trigger: "budget_forecast_over_cap",
      detail: `forecast ${forecastTokens} tokens exceeds the ${goal.budget.tokens}-token cap`,
    });
  }
  if (input.environmentChanged) {
    triggers.push({
      trigger: "environment_changed",
      detail: input.environmentDetail ?? "a dependency or the environment changed",
    });
  }
  const unmetRefs = new Set(criteria.filter((c) => c.status !== "met").map((c) => c.id));
  for (const c of cards) {
    const refs = (c.labels ?? []).filter((l) => l.startsWith("criterion:")).map((l) => l.slice(10));
    if (refs.length > 0 && !refs.some((r) => unmetRefs.has(r)) && c.status !== "done") {
      triggers.push({
        trigger: "card_advances_nothing",
        detail: `${c.id} advances no unmet criterion`,
      });
    }
  }
  return { goal, criteria, triggers, spentTokens, forecastTokens };
}

// ----------------------------------------------------------- honest stop (P22)

export interface GoalVerdict {
  state: GoalState;
  diagnosis?: string;
}

/**
 * `met` only when every criterion is met and verified; `blocked` with a
 * written diagnosis when strategies or budget are exhausted; otherwise
 * still active. Never partial completion reported as done.
 */
export function goalVerdict(
  evaluation: GoalEvaluation,
  options: { maxStrategies?: number; budgetExhausted?: boolean } = {},
): GoalVerdict {
  const { criteria, goal } = evaluation;
  const unverifiable = criteria.filter((c) => c.status === "unverifiable");
  const unmet = criteria.filter((c) => c.status === "unmet");
  if (criteria.length > 0 && unmet.length === 0 && unverifiable.length === 0)
    return { state: "met" };
  const exhausted =
    options.budgetExhausted === true ||
    goal.strategiesTried >= (options.maxStrategies ?? 3) ||
    (goal.budget.tokens > 0 && evaluation.spentTokens >= goal.budget.tokens);
  if (!exhausted) return { state: "active" };
  const met = criteria.filter((c) => c.status === "met");
  const smallest =
    unverifiable.length > 0
      ? `Check "${unverifiable[0]?.text}" yourself, or give it a gate or metric.`
      : unmet[0]?.kind === "human"
        ? `Mark "${unmet[0].text}" if it holds.`
        : `Decide whether "${unmet[0]?.text}" is still required, or raise the budget for one more strategy.`;
  return {
    state: "blocked",
    diagnosis: [
      `Met: ${met.map((c) => c.text).join("; ") || "none"}.`,
      `Not met: ${[...unmet, ...unverifiable].map((c) => `${c.text} (${c.status})`).join("; ")}.`,
      `Tried: ${goal.strategiesTried} strateg${goal.strategiesTried === 1 ? "y" : "ies"}, ${evaluation.spentTokens} tokens of ${goal.budget.tokens}.`,
      `Smallest unblocking action: ${smallest}`,
    ].join(" "),
  };
}

/** A goal trigger as the Replan session names it. */
const REPLAN_TRIGGER: Record<GoalReplanTrigger, ReplanTrigger> = {
  rung3_failure: "rung3_failure",
  criterion_regressed: "criterion_regressed",
  budget_forecast_over_cap: "budget_forecast",
  environment_changed: "scope_change",
  card_advances_nothing: "no_criterion_advanced",
};

/** What a goal's re-plan asks for; the caller's replanner decides how it reaches the board. */
export interface GoalReplanRequest {
  goalId: string;
  epicId: string;
  spec: string;
  reason: string;
  trigger: ReplanTrigger;
}

/** A re-plan's outcome: the new plan version and its diff; `applied` false when it went to owners as suggestions. */
export interface GoalReplanOutcome {
  version: number;
  diff: PlanDiff;
  applied: boolean;
  /** Cards whose change went to their owner as a suggestion (PM-N9-9). */
  suggested?: string[];
}

export type GoalReplanner = (request: GoalReplanRequest) => Promise<GoalReplanOutcome>;

/**
 * The one-paragraph reason a goal was re-planned (PM-N4-5): the goal, what
 * fired, and where its criteria stand. One line, no line breaks.
 */
export function goalReplanReason(
  goal: Pick<Goal, "statement" | "criteria">,
  triggers: readonly { trigger: GoalReplanTrigger; detail: string }[],
  version: number,
): string {
  const met = goal.criteria.filter((c) => c.status === "met").map((c) => c.text);
  const open = goal.criteria.filter((c) => c.status !== "met").map((c) => c.text);
  const flat = (t: string) => t.replace(/\s+/g, " ").trim();
  return flat(
    `The goal "${goal.statement}" moved to strategy v${version} because ${triggers
      .map((t) => t.detail)
      .join("; ")}. Met so far: ${met.join("; ") || "none"}. Still open: ${
      open.join("; ") || "none"
    }. The new plan keeps what still advances an open criterion and replaces the rest.`,
  );
}

/**
 * Evaluate, persist the criteria, apply the verdict, and replan on a
 * trigger (the goal loop, P19). Called on every card close, on every queue
 * pass and hourly while the daemon runs (PM-N4-1). `metrics` are read from
 * the log or the repository (PM-N4-2), `humanMarks` from the goal's events
 * (PM-N4-3); `environment` is the lockfile and toolchain fingerprint, and a
 * different one from the last evaluation's fires `environment_changed`
 * (PM-N4-4). A replan goes through `replan` when given — the harness's
 * route, which posts changes to an owned issue as suggestions in the Team
 * setup (§2.18.6) — and returns its diff and one-paragraph reason (PM-N4-5).
 */
export async function runGoalLoop(
  ledger: PlannerLedger,
  planner: SpidrFeaturePlanner,
  goalId: string,
  input: {
    metrics?: Record<string, number>;
    humanMarks?: Record<string, boolean>;
    environmentChanged?: boolean;
    /** The environment's fingerprint now (PM-N4-4). */
    environment?: string;
    /** What changed in the environment, named in the trigger's detail. */
    environmentDetail?: string;
    maxStrategies?: number;
    replan?: GoalReplanner;
  } = {},
): Promise<{
  evaluation: GoalEvaluation;
  verdict: GoalVerdict;
  replanned: boolean;
  replan?: GoalReplanOutcome & { reason: string };
}> {
  const store = new GoalStore(ledger);
  const goal = await store.get(goalId);
  if (!goal) throw new Error(`No goal ${goalId}`);
  const cards = await ledger.store.listCards();
  const events = await ledger.log.getEventsByTypes(["gate/result"]);
  const moved =
    input.environment !== undefined &&
    goal.environment !== undefined &&
    input.environment !== goal.environment;
  const evaluation = evaluateGoal(goal, {
    cards,
    events,
    ...(input.metrics ? { metrics: input.metrics } : {}),
    ...(input.humanMarks ? { humanMarks: input.humanMarks } : {}),
    environmentChanged: input.environmentChanged === true || moved,
    ...(input.environmentDetail ? { environmentDetail: input.environmentDetail } : {}),
  });
  const verdict = goalVerdict(
    evaluation,
    input.maxStrategies ? { maxStrategies: input.maxStrategies } : {},
  );
  const environment = input.environment !== undefined ? { environment: input.environment } : {};
  let replanned = false;
  let replan: (GoalReplanOutcome & { reason: string }) | undefined;
  if (verdict.state === "met" || verdict.state === "blocked") {
    await store.patch(
      goalId,
      {
        criteria: evaluation.criteria,
        state: verdict.state,
        ...environment,
        ...(verdict.diagnosis ? { diagnosis: verdict.diagnosis } : {}),
      },
      GOAL_EVENTS.stopped,
    );
  } else {
    await store.patch(goalId, { criteria: evaluation.criteria, ...environment });
    if (evaluation.triggers.length > 0 && goal.state === "active") {
      const epicId = goal.strategy.split("@")[0] as string;
      const first = evaluation.triggers[0]?.trigger as GoalReplanTrigger;
      const request: GoalReplanRequest = {
        goalId,
        epicId,
        spec: goal.statement,
        reason: evaluation.triggers.map((t) => t.detail).join("; "),
        trigger: REPLAN_TRIGGER[first],
      };
      const outcome: GoalReplanOutcome = input.replan
        ? await input.replan(request)
        : await replanSession(ledger, planner, { ...request, apply: true }).then((r) => ({
            version: r.version,
            diff: r.diff,
            applied: true,
          }));
      const reason = goalReplanReason(
        { statement: goal.statement, criteria: evaluation.criteria },
        evaluation.triggers,
        outcome.version,
      );
      await store.patch(
        goalId,
        { strategy: `${epicId}@v${outcome.version}`, strategiesTried: goal.strategiesTried + 1 },
        GOAL_EVENTS.replanned,
        {
          triggers: evaluation.triggers.map((t) => t.trigger),
          reason,
          applied: outcome.applied,
          diff: {
            added: outcome.diff.added.map((s) => s.id),
            removed: outcome.diff.removed.map((s) => s.id),
            changed: outcome.diff.changed.map((c) => c.id),
          },
          ...(outcome.suggested?.length ? { suggested: outcome.suggested } : {}),
        },
      );
      replanned = true;
      replan = { ...outcome, reason };
    }
  }
  return { evaluation, verdict, replanned, ...(replan ? { replan } : {}) };
}

// -------------------------------------------------------- many goals (P21)

export interface GoalRanking {
  goalId: string;
  score: number;
  why: string;
}

/**
 * Goal-level WSJF: cost of delay over the remaining job size (remaining
 * steps times mean difficulty of the goal's open cards). A goal marked
 * `onlyActive` wins outright. The first entry is the goal the scheduler
 * works this window, with the reason.
 */
export function rankGoals(goals: readonly Goal[], cards: readonly CardRecord[]): GoalRanking[] {
  const active = goals.filter((g) => g.state === "active");
  const only = active.find((g) => g.onlyActive);
  const rows = active.map((g): GoalRanking => {
    const epicId = g.strategy.split("@")[0];
    const open = cards.filter(
      (c) => c.parentId === epicId && c.status !== "done" && c.status !== "rejected",
    );
    const steps = open.reduce((a, c) => a + Math.max(1, c.stepBudget - c.stepsUsed), 0) || 1;
    const difficulty = open.length
      ? open.reduce((a, c) => a + (c.difficulty ?? 5), 0) / open.length
      : 1;
    const v = g.value ?? { userBusinessValue: 1, timeCriticality: 0, riskReduction: 0 };
    const score = scoreWsjf({ ...v, estimatedSteps: steps, difficulty });
    return {
      goalId: g.id,
      score: Number.isFinite(score) ? Math.round(score * 10_000) / 10_000 : 0,
      why: `WSJF (${v.userBusinessValue} + ${v.timeCriticality} + ${v.riskReduction}) / (${steps} steps x ${difficulty.toFixed(1)} difficulty)`,
    };
  });
  rows.sort((a, b) => b.score - a.score || a.goalId.localeCompare(b.goalId));
  if (only) {
    const i = rows.findIndex((r) => r.goalId === only.id);
    const [row] = rows.splice(i, 1) as [GoalRanking];
    rows.unshift({ ...row, why: `marked as the only active goal; ${row.why}` });
  }
  return rows;
}
