import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_STEP_BUDGET } from "@sekhemet/kernel";

/**
 * Guardrails for every self-improvement loop (E5, E8, E17; design
 * "Rigorous guardrails across all loops"): changes are measured on the
 * frozen suites before they land, bounded in size, applied one at a time,
 * and rolled back automatically when the live pass rate drops over the
 * next 10 cards.
 */

function readJson<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

// ------------------------------------------------ E5: frozen regression gate

export interface SuiteScore {
  suite: string;
  passed: number;
  total: number;
}

export interface RegressionGateResult {
  accepted: boolean;
  perSuite: { suite: string; baseline: number; candidate: number; delta: number }[];
  reason: string;
}

/**
 * Accept a learning change only if no frozen suite (Chronicle, the
 * Trifecta fixtures) loses more than `tolerance` passing cards and the
 * total does not drop. `runSuite` runs one suite with the change applied
 * (`candidate`) or not (`baseline`), for example through `sekhemet queue`
 * on the fixture.
 */
export async function runFrozenRegressionGate(options: {
  suites: string[];
  runSuite: (suite: string, variant: "baseline" | "candidate") => Promise<SuiteScore>;
  tolerance?: number;
  baseline?: SuiteScore[];
}): Promise<RegressionGateResult> {
  const tolerance = options.tolerance ?? 0;
  const perSuite: RegressionGateResult["perSuite"] = [];
  for (const suite of options.suites) {
    const base =
      options.baseline?.find((b) => b.suite === suite) ??
      (await options.runSuite(suite, "baseline"));
    const cand = await options.runSuite(suite, "candidate");
    perSuite.push({
      suite,
      baseline: base.passed,
      candidate: cand.passed,
      delta: cand.passed - base.passed,
    });
  }
  const worst = perSuite.find((p) => p.delta < -tolerance);
  const total = perSuite.reduce((a, p) => a + p.delta, 0);
  if (worst) {
    return {
      accepted: false,
      perSuite,
      reason: `${worst.suite} lost ${-worst.delta} passing card(s) (${worst.baseline} -> ${worst.candidate})`,
    };
  }
  if (total < 0)
    return {
      accepted: false,
      perSuite,
      reason: `the frozen suites lost ${-total} card(s) in total`,
    };
  return {
    accepted: true,
    perSuite,
    reason:
      total > 0
        ? `gained ${total} card(s) with no suite regressing`
        : "no regression on any frozen suite",
  };
}

// --------------------------------- E17: automatic rollback over a 10-card window

export interface LearningChange {
  id: string;
  kind: "rule" | "skill" | "budget" | "prompt" | "tool" | "route";
  description: string;
  activatedAt: string;
  /** Pass rate over the window before activation. */
  baselinePassRate: number;
  baselineCards: number;
  status: "watching" | "kept" | "rolled_back";
  outcomes: boolean[];
  resolvedAt?: string;
  reason?: string;
}

export interface GuardState {
  history: { cardId: string; passed: boolean; at: string }[];
  changes: LearningChange[];
}

export class LearningGuard {
  private state: GuardState;

  constructor(
    private readonly path: string,
    private readonly options: { window?: number; maxDrop?: number; now?: () => Date } = {},
  ) {
    this.state = readJson(path, { history: [], changes: [] });
  }

  private get window(): number {
    return this.options.window ?? 10;
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** The change being watched, if any: only one at a time (bounded). */
  public watching(): LearningChange | undefined {
    return this.state.changes.find((c) => c.status === "watching");
  }

  public changes(): LearningChange[] {
    return [...this.state.changes];
  }

  /**
   * Start watching a change. Refused while another change is still inside
   * its window, so an outcome is always attributable to one change.
   */
  public activate(change: {
    id: string;
    kind: LearningChange["kind"];
    description: string;
  }): LearningChange {
    const current = this.watching();
    if (current) {
      throw new Error(`Change ${current.id} is still being measured; one change at a time.`);
    }
    const recent = this.state.history.slice(-this.window);
    const rec: LearningChange = {
      ...change,
      activatedAt: this.now(),
      baselinePassRate: recent.length ? recent.filter((h) => h.passed).length / recent.length : 1,
      baselineCards: recent.length,
      status: "watching",
      outcomes: [],
    };
    this.state.changes.push(rec);
    writeJson(this.path, this.state);
    return rec;
  }

  /**
   * Record one card outcome. When the watched change has seen `window`
   * cards, it is kept or, if the pass rate dropped by more than `maxDrop`,
   * rolled back: the returned decision tells the caller to undo it.
   */
  public observe(
    cardId: string,
    passed: boolean,
  ): { rollback?: LearningChange; kept?: LearningChange } {
    this.state.history.push({ cardId, passed, at: this.now() });
    const w = this.watching();
    let result: { rollback?: LearningChange; kept?: LearningChange } = {};
    if (w) {
      w.outcomes.push(passed);
      if (w.outcomes.length >= this.window) {
        const rate = w.outcomes.filter(Boolean).length / w.outcomes.length;
        const drop = w.baselinePassRate - rate;
        w.resolvedAt = this.now();
        if (drop > (this.options.maxDrop ?? 0.1)) {
          w.status = "rolled_back";
          w.reason = `pass rate ${(rate * 100).toFixed(0)}% over ${w.outcomes.length} cards vs ${(w.baselinePassRate * 100).toFixed(0)}% before`;
          result = { rollback: w };
        } else {
          w.status = "kept";
          w.reason = `pass rate ${(rate * 100).toFixed(0)}% held (baseline ${(w.baselinePassRate * 100).toFixed(0)}%)`;
          result = { kept: w };
        }
      }
    }
    writeJson(this.path, this.state);
    return result;
  }
}

// -------------------------------------------- E8: budgets within +-15%, rollback

export interface BudgetPolicy {
  stepBudget: number;
  maxFailedChecks: number;
}

/** Move `current` toward `recommended`, each field by at most `maxChange` (15%). */
export function boundPolicyChange(
  current: BudgetPolicy,
  recommended: BudgetPolicy,
  maxChange = 0.15,
): BudgetPolicy & { clamped: boolean } {
  let clamped = false;
  const step = (cur: number, rec: number, min: number): number => {
    const hi = Math.floor(cur * (1 + maxChange));
    const lo = Math.ceil(cur * (1 - maxChange));
    const v = Math.min(hi, Math.max(lo, rec));
    if (v !== rec) clamped = true;
    return Math.max(min, v);
  };
  const stepBudget = step(current.stepBudget, recommended.stepBudget, 1);
  // A count of 1-3 cannot move by 15%: allow one step either way.
  const f = current.maxFailedChecks;
  const r = recommended.maxFailedChecks;
  const maxFailedChecks = Math.max(1, r > f ? f + 1 : r < f ? f - 1 : f);
  if (maxFailedChecks !== r) clamped = true;
  return { stepBudget, maxFailedChecks, clamped };
}

export interface AppliedBudget {
  id: string;
  policy: BudgetPolicy;
  previous: BudgetPolicy;
  appliedAt: string;
  status: "active" | "rolled_back";
  reason: string;
}

/**
 * The applied stopping policy (E8), with history, so a change is
 * reversible. `apply` bounds the move to 15% and registers it with the
 * guard; `rollback` restores the previous policy.
 */
export class BudgetPolicyStore {
  private state: { current: BudgetPolicy; applied: AppliedBudget[] };

  constructor(
    private readonly path: string,
    defaults: BudgetPolicy = { stepBudget: DEFAULT_STEP_BUDGET, maxFailedChecks: 3 },
  ) {
    this.state = readJson(path, { current: defaults, applied: [] as AppliedBudget[] });
  }

  public current(): BudgetPolicy {
    return { ...this.state.current };
  }

  public history(): AppliedBudget[] {
    return [...this.state.applied];
  }

  public apply(
    recommended: BudgetPolicy,
    reason: string,
    guard?: LearningGuard,
    now: Date = new Date(),
  ): AppliedBudget {
    const previous = this.current();
    const next = boundPolicyChange(previous, recommended);
    const entry: AppliedBudget = {
      id: `budget_${now.getTime().toString(36)}`,
      policy: { stepBudget: next.stepBudget, maxFailedChecks: next.maxFailedChecks },
      previous,
      appliedAt: now.toISOString(),
      status: "active",
      reason: next.clamped ? `${reason} (clamped to +-15%)` : reason,
    };
    guard?.activate({
      id: entry.id,
      kind: "budget",
      description: `steps ${previous.stepBudget}->${entry.policy.stepBudget}, failed checks ${previous.maxFailedChecks}->${entry.policy.maxFailedChecks}`,
    });
    this.state.current = entry.policy;
    this.state.applied.push(entry);
    writeJson(this.path, this.state);
    return entry;
  }

  public rollback(id: string): BudgetPolicy {
    const entry = this.state.applied.find((a) => a.id === id);
    if (!entry || entry.status !== "active") throw new Error(`No active budget change ${id}`);
    entry.status = "rolled_back";
    this.state.current = entry.previous;
    writeJson(this.path, this.state);
    return this.current();
  }
}
