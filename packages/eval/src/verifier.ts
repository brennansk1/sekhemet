import { performance } from "node:perf_hooks";
import { DeterministicGateRunner, type GateRung, parseErrorToGateFailure } from "@sekhemet/gates";
import { ProcessSandbox } from "@sekhemet/sandbox";
import type {
  CommandSpec,
  SyntheticTask,
  TestOutcome,
  TestRunRecord,
  VerificationSnapshot,
} from "./types.js";

/** Token in a `testCommand` argv replaced by the individual test selector. */
export const TEST_PLACEHOLDER = "{test}";

const DEFAULT_SETUP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 60_000;

/**
 * Exit codes that mean the command never reached a test.
 *
 * Distinguishing these from an ordinary non-zero exit is what keeps a broken
 * fixture from being recorded as a legitimately failing test — and therefore
 * from satisfying the fail-to-pass precondition by accident.
 */
const INFRASTRUCTURE_EXIT_CODES = new Set([124, 126, 127]);

/**
 * Split a command line into argv, honouring single and double quotes.
 *
 * Used when a test entry is itself a complete command rather than a selector
 * substituted into a template.
 */
export function parseCommandLine(line: string): CommandSpec {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let quoted = false;

  for (const char of line) {
    if (quote !== "") {
      if (char === quote) quote = "";
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      quoted = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (current.length > 0 || quoted) {
        tokens.push(current);
        current = "";
        quoted = false;
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0 || quoted) tokens.push(current);

  const [command, ...args] = tokens;
  if (command === undefined || command.length === 0) {
    throw new Error(`Cannot parse an empty command line: "${line}"`);
  }
  return { command, args };
}

/**
 * Resolve one test selector to a concrete argv.
 *
 * With a template, `{test}` is substituted wherever it appears; a template with
 * no placeholder gets the selector appended, which is what most runners want
 * (`vitest run <file>`). With no template the selector is the command.
 */
export function resolveTestCommand(test: string, template?: CommandSpec | undefined): CommandSpec {
  if (!template) return parseCommandLine(test);
  const hasPlaceholder = template.args.some((arg) => arg.includes(TEST_PLACEHOLDER));
  const args = template.args.map((arg) => arg.split(TEST_PLACEHOLDER).join(test));
  return { command: template.command, args: hasPlaceholder ? args : [...args, test] };
}

function classify(exitCode: number): TestOutcome {
  if (exitCode === 0) return "pass";
  return INFRASTRUCTURE_EXIT_CODES.has(exitCode) ? "error" : "fail";
}

export interface CommandOutcome {
  exitCode: number;
  durationMs: number;
  errorExcerpt: string;
}

export interface TestVerifierOptions {
  sandbox?: ProcessSandbox | undefined;
  gateRunner?: DeterministicGateRunner | undefined;
  /** Overrides the gate runner's own ceiling; omit to use the standard gate path. */
  testTimeoutMs?: number | undefined;
  setupTimeoutMs?: number | undefined;
  /** Dependency installation generally needs egress; tests never do. */
  allowSetupNetwork?: boolean | undefined;
}

/**
 * Runs a task's test oracle against a workspace and records the verdict.
 *
 * Every test is a real subprocess under the sandbox, and its verdict is its
 * real exit code. This is the component the previous harness did not have: a
 * benchmark that never runs the fail-to-pass tests is measuring whether the
 * model emitted a tool call, not whether it fixed anything.
 */
export class TestVerifier {
  private readonly sandbox: ProcessSandbox;
  private readonly gateRunner: DeterministicGateRunner;

  constructor(private readonly options: TestVerifierOptions = {}) {
    this.sandbox = options.sandbox ?? new ProcessSandbox();
    this.gateRunner = options.gateRunner ?? new DeterministicGateRunner(this.sandbox);
  }

  /**
   * Execute one command in the workspace.
   *
   * The default path delegates to {@link DeterministicGateRunner.runCustomCommandGate}
   * so a failing test is parsed into the same typed failure the executor sees.
   * A custom timeout or network grant falls through to the sandbox directly,
   * because the gate runner fixes both.
   */
  public async runCommand(
    spec: CommandSpec,
    cwd: string,
    settings: {
      rung: GateRung;
      timeoutMs?: number | undefined;
      allowNetwork?: boolean | undefined;
    },
  ): Promise<CommandOutcome> {
    const allowNetwork = settings.allowNetwork ?? false;

    if (!allowNetwork && settings.timeoutMs === undefined) {
      const gate = await this.gateRunner.runCustomCommandGate(
        settings.rung,
        spec.command,
        spec.args,
        cwd,
      );
      const failure = gate.failures[0];
      return {
        exitCode: gate.passed ? 0 : (failure?.exitCode ?? 1),
        durationMs: gate.durationMs,
        errorExcerpt: failure?.errorExcerpt ?? "",
      };
    }

    const start = performance.now();
    const result = await this.sandbox.execute(spec.command, spec.args, {
      allowedPaths: [cwd],
      allowNetwork,
      timeoutMs: settings.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS,
      cwd,
    });
    const durationMs = Math.round(performance.now() - start);

    if (result.exitCode === 0) return { exitCode: 0, durationMs, errorExcerpt: "" };

    const failure = parseErrorToGateFailure(
      settings.rung,
      result.exitCode,
      result.stderr || result.stdout,
    );
    return { exitCode: result.exitCode, durationMs, errorExcerpt: failure.errorExcerpt };
  }

  /** Run one test selector and record its verdict. */
  public async runTest(
    workspacePath: string,
    test: string,
    template?: CommandSpec | undefined,
  ): Promise<TestRunRecord> {
    let spec: CommandSpec;
    try {
      spec = resolveTestCommand(test, template);
    } catch (error) {
      return {
        test,
        outcome: "error",
        exitCode: 127,
        durationMs: 0,
        errorExcerpt: error instanceof Error ? error.message : String(error),
      };
    }

    const outcome = await this.runCommand(spec, workspacePath, {
      rung: "test",
      ...(this.options.testTimeoutMs !== undefined
        ? { timeoutMs: this.options.testTimeoutMs }
        : {}),
    });

    const record: TestRunRecord = {
      test,
      outcome: classify(outcome.exitCode),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
    };
    if (outcome.errorExcerpt) record.errorExcerpt = outcome.errorExcerpt;
    return record;
  }

  private async runSuite(
    workspacePath: string,
    tests: string[],
    template?: CommandSpec | undefined,
  ): Promise<TestRunRecord[]> {
    const records: TestRunRecord[] = [];
    for (const test of tests) {
      records.push(await this.runTest(workspacePath, test, template));
    }
    return records;
  }

  /** Run the full oracle — fail-to-pass then pass-to-pass — against one workspace. */
  public async snapshot(workspacePath: string, task: SyntheticTask): Promise<VerificationSnapshot> {
    const start = performance.now();
    const failToPass = await this.runSuite(workspacePath, task.failToPassTests, task.testCommand);
    const passToPass = await this.runSuite(workspacePath, task.passToPassTests, task.testCommand);
    return {
      failToPass,
      passToPass,
      durationMs: Math.round(performance.now() - start),
    };
  }

  /** Run a task's setup commands. The first non-zero exit aborts the sequence. */
  public async runSetup(
    workspacePath: string,
    commands: CommandSpec[],
  ): Promise<{ ok: boolean; failure?: string }> {
    for (const spec of commands) {
      const outcome = await this.runCommand(spec, workspacePath, {
        rung: "parse",
        timeoutMs: this.options.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
        allowNetwork: this.options.allowSetupNetwork ?? true,
      });
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          failure: `setup command "${spec.command} ${spec.args.join(" ")}" exited ${outcome.exitCode}: ${outcome.errorExcerpt}`,
        };
      }
    }
    return { ok: true };
  }
}

/**
 * The fail-to-pass precondition: the bug must be demonstrably present.
 *
 * Every fail-to-pass test must genuinely fail (not merely error), and every
 * pass-to-pass test must already pass. A task that does not satisfy this is not
 * known-solvable and its result is not admissible.
 */
export function preconditionViolations(snapshot: VerificationSnapshot): string[] {
  const violations: string[] = [];
  for (const record of snapshot.failToPass) {
    if (record.outcome === "fail") continue;
    violations.push(
      record.outcome === "pass"
        ? `fail-to-pass test already passes before the agent runs: ${record.test}`
        : `fail-to-pass test could not be executed (exit ${record.exitCode}): ${record.test}`,
    );
  }
  for (const record of snapshot.passToPass) {
    if (record.outcome === "pass") continue;
    violations.push(
      `pass-to-pass test does not pass before the agent runs (exit ${record.exitCode}): ${record.test}`,
    );
  }
  return violations;
}

/** Every test in the snapshot passed. */
export function allPassing(snapshot: VerificationSnapshot): boolean {
  return [...snapshot.failToPass, ...snapshot.passToPass].every((r) => r.outcome === "pass");
}
