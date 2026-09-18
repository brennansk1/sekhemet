import { performance } from "node:perf_hooks";
import type { ProcessSandbox } from "@sekhemet/sandbox";
import { parseErrorToGateFailure } from "./parser.js";
import type {
  BoundsCheckOptions,
  BoundsCheckResult,
  GateFailure,
  GateResult,
  GateRung,
  GateRunner,
} from "./types.js";

export class DeterministicGateRunner implements GateRunner {
  constructor(private sandbox: ProcessSandbox) {}

  public checkBounds(options: BoundsCheckOptions): BoundsCheckResult {
    const maxFiles = options.maxFiles ?? 3;
    const maxLines = options.maxLines ?? 200;
    const totalLines = options.linesAdded + options.linesRemoved;

    if (options.filesTouched.length > maxFiles) {
      return {
        passed: false,
        failure: {
          rung: "bounds",
          exitCode: 1,
          errorExcerpt: `Exceeded file limit: touched ${options.filesTouched.length} files (limit: ${maxFiles}): ${options.filesTouched.join(", ")}`,
          suggestedFixFiles: options.filesTouched,
        },
      };
    }

    if (totalLines > maxLines) {
      return {
        passed: false,
        failure: {
          rung: "bounds",
          exitCode: 1,
          errorExcerpt: `Exceeded LOC diff limit: ${totalLines} diff lines (limit: ${maxLines}) across ${options.filesTouched.length} files`,
          suggestedFixFiles: options.filesTouched,
        },
      };
    }

    return { passed: true };
  }

  public async runCustomCommandGate(
    rung: GateRung,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<GateResult> {
    const start = performance.now();
    const result = await this.sandbox.execute(command, args, {
      allowedPaths: [cwd],
      allowNetwork: false,
      timeoutMs: 60000,
      cwd,
    });

    const durationMs = Math.round(performance.now() - start);

    if (result.exitCode === 0) {
      return { passed: true, failures: [], durationMs };
    }

    const failure = parseErrorToGateFailure(rung, result.exitCode, result.stderr || result.stdout);

    return {
      passed: false,
      failures: [failure],
      durationMs,
    };
  }

  public async runGates(rungs: GateRung[], cwd: string): Promise<GateResult> {
    const start = performance.now();
    const failures: GateFailure[] = [];

    for (const rung of rungs) {
      const cmd = "pnpm";
      let args: string[] = [];

      if (rung === "typecheck") {
        args = ["typecheck"];
      } else if (rung === "test") {
        args = ["test"];
      } else if (rung === "lint") {
        args = ["lint"];
      } else {
        continue;
      }

      const rungRes = await this.runCustomCommandGate(rung, cmd, args, cwd);
      if (!rungRes.passed) {
        failures.push(...rungRes.failures);
        // Short-circuit on first failing gate
        break;
      }
    }

    const durationMs = Math.round(performance.now() - start);
    return {
      passed: failures.length === 0,
      failures,
      durationMs,
    };
  }
}
