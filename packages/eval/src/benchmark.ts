import { performance } from "node:perf_hooks";
import { DeterministicGateRunner, type GateRung } from "@sekhemet/gates";
import { CardExecutionSessionImpl } from "@sekhemet/loop";
import type { LocalInferenceAdapter, ToolArm } from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { InstrumentedAdapter } from "./instrumentation.js";
import {
  DEFAULT_STEP_BUDGET,
  DEFAULT_TOOL_ARM,
  type SamplingPlan,
  buildBenchmarkSettings,
  resolveSamplingPlan,
} from "./settings.js";
import type {
  BenchmarkOptions,
  BenchmarkSettings,
  EvalBenchmarkResult,
  EvalHarness,
  SyntheticTask,
  TaskAttemptResult,
  TaskBenchmarkResult,
  VerificationSnapshot,
} from "./types.js";
import { TestVerifier, allPassing, preconditionViolations } from "./verifier.js";
import { EphemeralWorkspace } from "./workspace.js";

/**
 * The benchmark oracle is the task's own fail-to-pass suite. The in-loop gate
 * rungs are a different thing entirely: they are what the *agent* gets to check
 * itself against before declaring the card finished.
 */
const DEFAULT_GATE_RUNGS: GateRung[] = ["test"];

interface RunContext {
  plan: SamplingPlan;
  settings: BenchmarkSettings;
  gateRunner: DeterministicGateRunner;
  verifier: TestVerifier;
  stepBudget: number;
  gateRungs: GateRung[];
  toolArm: ToolArm;
  defaultRepoPath: string;
  options: BenchmarkOptions;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyAttempt(taskId: string, attempt: number, temperature: number): TaskAttemptResult {
  return {
    taskId,
    attempt,
    passed: false,
    temperature,
    durationMs: 0,
    turnsUsed: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    inferenceCalls: 0,
    stopReason: "not_started",
    workspacePath: "",
    flippedToPassing: [],
    stillFailing: [],
    regressed: [],
  };
}

/**
 * The real benchmark harness.
 *
 * Every task is executed by the actual card loop, in its own isolated checkout,
 * and judged solely by running its tests before and after. A task passes when
 * — and only when — every fail-to-pass test failed beforehand and passes
 * afterwards, and no pass-to-pass test regressed. Emitting a tool call, or
 * calling `finish_card`, earns nothing.
 */
export class BenchmarkHarness implements EvalHarness {
  /**
   * Run a full suite and report pass@1 and pass@k.
   *
   * `options` is optional only for call-site convenience; the settings it
   * resolves to are recorded in full on the result either way.
   */
  public async runBenchmark(
    tasks: SyntheticTask[],
    modelAdapter: LocalInferenceAdapter,
    options: BenchmarkOptions = {},
  ): Promise<EvalBenchmarkResult> {
    const start = performance.now();
    const context = this.prepare(modelAdapter, options);

    const results: TaskBenchmarkResult[] = [];
    for (const [index, task] of tasks.entries()) {
      options.onProgress?.({ kind: "task_start", taskId: task.id, index, total: tasks.length });
      const result = await this.executeTask(task, modelAdapter, context);
      results.push(result);
      options.onProgress?.({ kind: "task_end", result });
    }

    const passedFirst = results.filter((r) => r.passedFirstAttempt).length;
    const passedAny = results.filter((r) => r.passed).length;
    const totalTokens = results.reduce((sum, r) => sum + r.totalTokens, 0);

    return {
      taskCount: tasks.length,
      passAt1: tasks.length > 0 ? passedFirst / tasks.length : 0,
      passAtK: tasks.length > 0 ? passedAny / tasks.length : 0,
      totalTokens,
      totalTimeMs: Math.round(performance.now() - start),
      tasks: results,
      settings: context.settings,
    };
  }

  /** Run one task in isolation, with the same semantics as a full suite run. */
  public async runTask(
    task: SyntheticTask,
    modelAdapter: LocalInferenceAdapter,
    options: BenchmarkOptions = {},
  ): Promise<TaskBenchmarkResult> {
    return this.executeTask(task, modelAdapter, this.prepare(modelAdapter, options));
  }

  private prepare(modelAdapter: LocalInferenceAdapter, options: BenchmarkOptions): RunContext {
    const plan = resolveSamplingPlan(options);
    const sandbox = options.sandbox ?? new ProcessSandbox();
    const gateRunner = options.gateRunner ?? new DeterministicGateRunner(sandbox);

    const verifier = new TestVerifier({
      sandbox,
      gateRunner,
      ...(options.testTimeoutMs !== undefined ? { testTimeoutMs: options.testTimeoutMs } : {}),
      ...(options.setupTimeoutMs !== undefined ? { setupTimeoutMs: options.setupTimeoutMs } : {}),
      ...(options.allowSetupNetwork !== undefined
        ? { allowSetupNetwork: options.allowSetupNetwork }
        : {}),
    });

    const stepBudget = options.stepBudget ?? DEFAULT_STEP_BUDGET;
    const gateRungs = options.gateRungs ?? DEFAULT_GATE_RUNGS;
    const toolArm = options.toolArm ?? DEFAULT_TOOL_ARM;
    const harnessRepoPath = options.harnessRepoPath ?? process.cwd();

    const settings = buildBenchmarkSettings({
      modelId: modelAdapter.modelId,
      engine: options.engine ?? modelAdapter.constructor.name,
      toolArm,
      stepBudget,
      gateRungs,
      plan,
      harnessRepoPath,
      options,
    });

    return {
      plan,
      settings,
      gateRunner,
      verifier,
      stepBudget,
      gateRungs,
      toolArm,
      defaultRepoPath: options.defaultRepoPath ?? harnessRepoPath,
      options,
    };
  }

  /**
   * Draw up to k samples of one task, stopping at the first that passes.
   *
   * Attempt 1 is the pass@1 sample, so the two rates are reported from the same
   * run without conflating them.
   */
  private async executeTask(
    task: SyntheticTask,
    modelAdapter: LocalInferenceAdapter,
    context: RunContext,
  ): Promise<TaskBenchmarkResult> {
    const start = performance.now();
    const attempts: TaskAttemptResult[] = [];

    for (let attempt = 1; attempt <= context.plan.passAtK; attempt++) {
      context.options.onProgress?.({
        kind: "attempt_start",
        taskId: task.id,
        attempt,
        temperature: context.plan.temperature,
      });

      const result = await this.runAttempt(task, modelAdapter, context, attempt);
      attempts.push(result);
      context.options.onProgress?.({ kind: "attempt_end", result });

      if (result.passed) break;
      // A task with no usable oracle will not become solvable on a resample.
      if (result.failureReason === "no_oracle" || result.failureReason === "precondition_not_met") {
        break;
      }
    }

    return {
      taskId: task.id,
      passed: attempts.some((a) => a.passed),
      passedFirstAttempt: attempts[0]?.passed ?? false,
      attempts,
      durationMs: Math.round(performance.now() - start),
      totalTokens: attempts.reduce((sum, a) => sum + a.totalTokens, 0),
    };
  }

  /** One sample: provision, verify before, run the loop, verify after. */
  private async runAttempt(
    task: SyntheticTask,
    modelAdapter: LocalInferenceAdapter,
    context: RunContext,
    attempt: number,
  ): Promise<TaskAttemptResult> {
    const started = performance.now();
    const result = emptyAttempt(task.id, attempt, context.plan.temperature);

    if (task.failToPassTests.length === 0) {
      result.failureReason = "no_oracle";
      result.error = "Task declares no fail-to-pass tests; there is nothing to verify.";
      result.durationMs = Math.round(performance.now() - started);
      return result;
    }

    const options = context.options;
    let workspace: EphemeralWorkspace;
    try {
      workspace = EphemeralWorkspace.create({
        repoPath: task.repoPath ?? context.defaultRepoPath,
        commit: task.repoCommit,
        label: `${task.id}-a${attempt}`,
        ...(options.workspaceRoot !== undefined ? { root: options.workspaceRoot } : {}),
        ...(options.workspaceMode !== undefined ? { mode: options.workspaceMode } : {}),
        ...(options.linkPaths !== undefined ? { linkPaths: options.linkPaths } : {}),
        ...(options.keepWorkspaces !== undefined ? { keep: options.keepWorkspaces } : {}),
      });
    } catch (error) {
      result.failureReason = "workspace_error";
      result.error = describeError(error);
      result.durationMs = Math.round(performance.now() - started);
      return result;
    }

    result.workspacePath = workspace.path;

    try {
      if (task.setupCommands && task.setupCommands.length > 0) {
        const setup = await context.verifier.runSetup(workspace.path, task.setupCommands);
        if (!setup.ok) {
          result.failureReason = "setup_failed";
          result.error = setup.failure ?? "setup failed";
          return result;
        }
      }

      const before = await context.verifier.snapshot(workspace.path, task);
      result.before = before;

      const violations = preconditionViolations(before);
      if (violations.length > 0) {
        // Not a model failure: the task itself is not known-solvable.
        result.failureReason = "precondition_not_met";
        result.error = violations.join("; ");
        return result;
      }

      const adapter = new InstrumentedAdapter(modelAdapter, {
        temperature: context.plan.temperature,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });

      const session = new CardExecutionSessionImpl({
        cardId: `${task.id}#a${attempt}`,
        stepBudget: task.stepBudget ?? context.stepBudget,
        worktreePath: workspace.path,
        modelAdapter: adapter,
        gateRunner: context.gateRunner,
        // The card record carries no description field, and the prompt pack
        // renders the title verbatim, so the problem statement travels as the
        // title rather than being dropped on the floor.
        cardTitle: task.issueDescription.trim(),
        gateRungs: context.gateRungs,
        toolArm: context.toolArm,
        temperature: context.plan.temperature,
        ...(task.scopeFiles !== undefined ? { scopeFiles: task.scopeFiles } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      });

      try {
        const turns = await session.run();
        result.stopReason = turns.at(-1)?.stopReason ?? "loop_exited";
      } catch (error) {
        result.stopReason = "error";
        result.failureReason = "agent_error";
        result.error = describeError(error);
      }

      result.turnsUsed = session.getStepsUsed();
      result.promptTokens = adapter.promptTokens;
      result.completionTokens = adapter.completionTokens;
      result.totalTokens = adapter.totalTokens;
      result.inferenceCalls = adapter.inferenceCalls;

      const after = await context.verifier.snapshot(workspace.path, task);
      result.after = after;

      const flips = diffSnapshots(before, after);
      result.flippedToPassing = flips.flippedToPassing;
      result.stillFailing = flips.stillFailing;
      result.regressed = flips.regressed;

      result.passed = allPassing(after);
      if (result.passed) {
        result.failureReason = undefined;
        result.error = undefined;
      } else if (result.failureReason === undefined) {
        result.failureReason =
          result.stillFailing.length > 0 ? "fail_to_pass_unfixed" : "pass_to_pass_regressed";
      }

      return result;
    } finally {
      result.durationMs = Math.round(performance.now() - started);
      workspace.dispose();
    }
  }
}

/** Which specific tests moved, and in which direction. */
export function diffSnapshots(
  before: VerificationSnapshot,
  after: VerificationSnapshot,
): { flippedToPassing: string[]; stillFailing: string[]; regressed: string[] } {
  const beforeFailToPass = new Map(before.failToPass.map((r) => [r.test, r]));
  const beforePassToPass = new Map(before.passToPass.map((r) => [r.test, r]));

  const flippedToPassing = after.failToPass
    .filter((r) => r.outcome === "pass" && beforeFailToPass.get(r.test)?.outcome === "fail")
    .map((r) => r.test);

  const stillFailing = after.failToPass.filter((r) => r.outcome !== "pass").map((r) => r.test);

  const regressed = after.passToPass
    .filter((r) => r.outcome !== "pass" && beforePassToPass.get(r.test)?.outcome === "pass")
    .map((r) => r.test);

  return { flippedToPassing, stillFailing, regressed };
}
