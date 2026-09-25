import type { DeterministicGateRunner, GateRung } from "@sekhemet/gates";
import type { ExecutionStopReason } from "@sekhemet/loop";
import type { LocalInferenceAdapter, ToolArm } from "@sekhemet/models";
import type { ProcessSandbox } from "@sekhemet/sandbox";

/** A command invocation executed inside an ephemeral workspace. */
export interface CommandSpec {
  command: string;
  args: string[];
}

/** How an ephemeral workspace is cut from the source repository. */
export type WorkspaceMode = "worktree" | "clone";

/**
 * One benchmark task: a repository state plus an executable test oracle.
 *
 * `failToPassTests` and `passToPassTests` are the oracle, not decoration. Each
 * entry is either a complete command line, or a selector substituted into
 * `testCommand` wherever the literal token `{test}` appears. A task with no
 * fail-to-pass test has no oracle and can never pass.
 */
export interface SyntheticTask {
  id: string;
  /** The commit the agent starts from — C₋₁ for a fail-to-pass task. */
  repoCommit: string;
  issueDescription: string;
  failToPassTests: string[];
  passToPassTests: string[];
  /** Source repository each workspace is cut from. Defaults to the harness repo. */
  repoPath?: string | undefined;
  /** Argv template a test selector is substituted into. */
  testCommand?: CommandSpec | undefined;
  /** Run once after provisioning, before any test: dependency install, build. */
  setupCommands?: CommandSpec[] | undefined;
  /** Declared write scope handed to the executor's permission engine. */
  scopeFiles?: string[] | undefined;
  /** Overrides the suite-wide step budget for this task. */
  stepBudget?: number | undefined;
  /** The commit that fixed the issue — C₀. Recorded by task synthesis. */
  fixCommit?: string | undefined;
  /**
   * Test files taken from `commit` and applied on top of `repoCommit` in
   * every workspace (the SWE-bench test patch): a fix commit that adds its
   * test would otherwise have no oracle at C-1. The Worker sees them as the
   * card's acceptance tests.
   */
  testPatch?: { commit: string; files: string[] } | undefined;
}

/**
 * `error` means the command never got as far as running a test — a missing
 * binary, a timeout, a refused sandbox — and is deliberately distinct from
 * `fail`. A task whose oracle merely errors is not a task that is failing.
 */
export type TestOutcome = "pass" | "fail" | "error";

export interface TestRunRecord {
  test: string;
  outcome: TestOutcome;
  exitCode: number;
  durationMs: number;
  /** Typed excerpt from the gate failure parser when the test did not pass. */
  errorExcerpt?: string | undefined;
}

/** The oracle's verdict on a workspace at one point in time. */
export interface VerificationSnapshot {
  failToPass: TestRunRecord[];
  passToPass: TestRunRecord[];
  durationMs: number;
}

/** `loop_exited` means the session returned without setting a stop reason. */
export type AttemptStopReason = ExecutionStopReason | "loop_exited" | "not_started";

export type AttemptFailureReason =
  | "no_oracle"
  | "precondition_not_met"
  | "setup_failed"
  | "fail_to_pass_unfixed"
  | "pass_to_pass_regressed"
  | "workspace_error"
  | "agent_error";

/** One sample of one task, in its own isolated workspace. */
export interface TaskAttemptResult {
  taskId: string;
  /** 1-based. Attempt 1 is the pass@1 sample. */
  attempt: number;
  passed: boolean;
  temperature: number;
  durationMs: number;
  turnsUsed: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  inferenceCalls: number;
  stopReason: AttemptStopReason;
  workspacePath: string;
  /** Oracle state before the agent ran. Absent when provisioning failed. */
  before?: VerificationSnapshot | undefined;
  /** Oracle state after the agent ran. Absent when the attempt never got there. */
  after?: VerificationSnapshot | undefined;
  /** Fail-to-pass tests that failed before the agent ran and pass after it. */
  flippedToPassing: string[];
  /** Fail-to-pass tests still failing after the agent ran. */
  stillFailing: string[];
  /** Pass-to-pass tests the agent broke. */
  regressed: string[];
  failureReason?: AttemptFailureReason | undefined;
  error?: string | undefined;
  /**
   * Steps the product's card execution recorded, and those whose reply held
   * a well-formed call to an offered tool (no format error, not prose only):
   * the M0 protocol's valid-tool-call rate (measurement MS-M9-6).
   */
  toolCallSteps?: { steps: number; valid: number } | undefined;
}

/** One attempt as the product's card execution ran it (measurement MS-M9-1). */
export interface ProductCardRun {
  stopReason: string;
  turnsUsed: number;
  promptTokens: number;
  completionTokens: number;
  /** Per step, from the evidence (worker-loop WL-M2-5). */
  steps: { formatErrors: number; proseOnly: number }[];
}

/**
 * Runs one attempt in a prepared workspace through the product's card
 * execution, leaving its accepted result in the workspace for the oracle.
 */
export type ProductCardRunner = (input: {
  workspacePath: string;
  task: SyntheticTask;
  stepBudget: number;
  attempt: number;
  temperature: number;
}) => Promise<ProductCardRun>;

export interface TaskBenchmarkResult {
  taskId: string;
  /** True when any attempt passed — the pass@k sample for this task. */
  passed: boolean;
  /** True when the first attempt passed — the pass@1 sample for this task. */
  passedFirstAttempt: boolean;
  attempts: TaskAttemptResult[];
  durationMs: number;
  totalTokens: number;
}

export interface SamplingSettings {
  temperature: number;
  topP?: number | undefined;
  topK?: number | undefined;
  maxTokens?: number | undefined;
}

/**
 * The exact conditions one number was produced under.
 *
 * Required on every result by design: "a number without settings is not
 * admissible." A pass rate quoted without the model, quantisation, tool arm,
 * context size, step budget and harness revision that produced it is not a
 * measurement, and the type system is where that rule is cheapest to enforce.
 */
export interface BenchmarkSettings {
  modelId: string;
  quant: string;
  engine: string;
  toolArm: ToolArm;
  sampling: SamplingSettings;
  contextTokens: number;
  stepBudget: number;
  /** Samples drawn per task. 1 means pass@1 only. */
  passAtK: number;
  /** Gate rungs the executor verified against in-loop. */
  gateRungs: GateRung[];
  suiteVersion: string;
  harnessCommitSha: string;
  /** True when the harness tree carried uncommitted edits; the sha alone is then not reproducible. */
  harnessDirty: boolean;
  hostPlatform: string;
  hardwareTier?: string | undefined;
  /** ISO-8601, UTC. */
  timestamp: string;
}

export interface EvalBenchmarkResult {
  taskCount: number;
  passAt1: number;
  passAtK: number;
  totalTokens: number;
  totalTimeMs: number;
  tasks: TaskBenchmarkResult[];
  /** Not optional. See {@link BenchmarkSettings}. */
  settings: BenchmarkSettings;
}

export type BenchmarkProgressEvent =
  | { kind: "task_start"; taskId: string; index: number; total: number }
  | { kind: "attempt_start"; taskId: string; attempt: number; temperature: number }
  | { kind: "attempt_end"; result: TaskAttemptResult }
  | { kind: "task_end"; result: TaskBenchmarkResult };

export interface BenchmarkOptions {
  /** Samples per task. 1, or a value in [2, 4] for pass@k. */
  passAtK?: number | undefined;
  /** Sampling temperature. pass@k requires a value in [0.4, 0.7]. */
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  maxTokens?: number | undefined;
  contextTokens?: number | undefined;
  toolArm?: ToolArm | undefined;
  stepBudget?: number | undefined;
  quant?: string | undefined;
  engine?: string | undefined;
  hardwareTier?: string | undefined;
  suiteVersion?: string | undefined;
  /** Rungs the executor runs when it calls `finish_card`. Distinct from the oracle. */
  gateRungs?: GateRung[] | undefined;
  gateRunner?: DeterministicGateRunner | undefined;
  sandbox?: ProcessSandbox | undefined;
  /** Repo whose HEAD is recorded as the harness revision. Defaults to `process.cwd()`. */
  harnessRepoPath?: string | undefined;
  /** Source repo for tasks that declare none. Defaults to `harnessRepoPath`. */
  defaultRepoPath?: string | undefined;
  /** Parent directory for ephemeral workspaces. Defaults to the OS temp dir. */
  workspaceRoot?: string | undefined;
  workspaceMode?: WorkspaceMode | undefined;
  /** Paths symlinked from the source repo into each workspace, e.g. `node_modules`. */
  linkPaths?: string[] | undefined;
  /** Leave workspaces on disk for post-mortem inspection. */
  keepWorkspaces?: boolean | undefined;
  testTimeoutMs?: number | undefined;
  setupTimeoutMs?: number | undefined;
  /** Setup usually needs network (dependency install). Tests never do. */
  allowSetupNetwork?: boolean | undefined;
  onProgress?: ((event: BenchmarkProgressEvent) => void) | undefined;
  /**
   * Run each attempt through the product's card execution instead of an
   * in-process session (measurement rule 9, MS-M9-1). `sekhemet m0` always
   * passes one; the in-process session remains for this harness's own tests.
   */
  runCard?: ProductCardRunner | undefined;
}

export interface EvalHarness {
  runBenchmark(
    tasks: SyntheticTask[],
    modelAdapter: LocalInferenceAdapter,
    options?: BenchmarkOptions,
  ): Promise<EvalBenchmarkResult>;
}
