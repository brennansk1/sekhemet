import { performance } from "node:perf_hooks";
import { type ProcessSandbox, matchesGlob } from "@sekhemet/sandbox";
import {
  DEFAULT_GATES,
  DEFAULT_PROJECT_CONFIG,
  loadGatesConfig,
  verifyGatesConfig,
} from "./config.js";
import { gateCopy } from "./copy.js";
import { parseErrorToGateFailure } from "./parser.js";
import { type ParseContext, defaultParserRegistry } from "./parsers.js";
import { FAILURES_SHOWN, completeFailures, rankFailures } from "./rank.js";
import type {
  BoundsCheckOptions,
  BoundsCheckResult,
  GateDefinition,
  GateFailure,
  GateLayer,
  GateResult,
  GateRung,
  GateRunner,
  GatesConfig,
  RungOutcome,
} from "./types.js";

export interface GateRunnerOptions {
  /** Repo root used to locate `.sekhemet/gates.toml`. */
  repoRoot?: string;
  /** Pinned config hash; when set, a changed gates.toml aborts the run. */
  expectedConfigSha256?: string;
  /** Stop after the first blocking failure instead of collecting every gate. */
  failFast?: boolean;
  /**
   * Maximum failures handed back per run (default 3). The cap that reaches the
   * model is applied once more, over every gate's failures together, by
   * `finalizeFailures` (rule 20, F14).
   */
  maxFailuresReported?: number;
}

/**
 * The card-size gate (design: 3 files, 200 changed lines by default).
 *
 * A standalone function so the loop can run it on the measured diff at every
 * verification; the runner method delegates here.
 */
export function checkBounds(options: BoundsCheckOptions): BoundsCheckResult {
  const maxFiles = options.maxFiles ?? DEFAULT_PROJECT_CONFIG.maxFiles;
  const maxLines = options.maxLines ?? DEFAULT_PROJECT_CONFIG.maxDiffLines;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error(
      `Bounds limits must be positive integers (files ${maxFiles}, lines ${maxLines})`,
    );
  }
  if (options.linesAdded < 0 || options.linesRemoved < 0) {
    throw new Error("Diff line counts cannot be negative");
  }
  const totalLines = options.linesAdded + options.linesRemoved;
  const minimalRepro = `git diff --numstat ${options.base ?? "main"}`;
  const location = { file: options.filesTouched[0] ?? "." };

  if (options.filesTouched.length > maxFiles) {
    return {
      passed: false,
      failure: {
        rung: "bounds",
        gate: "bounds",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `Exceeded file limit: touched ${options.filesTouched.length} files (limit: ${maxFiles}): ${options.filesTouched.join(", ")}`,
        suggestedFixFiles: options.filesTouched,
        location,
        expected: `at most ${maxFiles} files changed`,
        actual: `${options.filesTouched.length} files changed`,
        minimalRepro,
        suggestedAction: gateCopy.boundsFiles(
          String(options.filesTouched.length),
          String(maxFiles),
        ),
      },
    };
  }

  if (totalLines > maxLines) {
    return {
      passed: false,
      failure: {
        rung: "bounds",
        gate: "bounds",
        layer: "hygiene",
        exitCode: 1,
        errorExcerpt: `Exceeded LOC diff limit: ${totalLines} diff lines (limit: ${maxLines}) across ${options.filesTouched.length} files`,
        suggestedFixFiles: options.filesTouched,
        location,
        expected: `at most ${maxLines} diff lines`,
        actual: `${totalLines} diff lines`,
        minimalRepro,
        suggestedAction: gateCopy.boundsLines(String(totalLines), String(maxLines)),
      },
    };
  }

  return { passed: true };
}

/**
 * Parse `git diff --numstat` output into per-file line deltas. Binary files
 * ("-\t-\tpath") count as touched with zero lines.
 */
export function parseNumstat(text: string): { file: string; added: number; removed: number }[] {
  const out: { file: string; added: number; removed: number }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, add, del, rawFile] = m as unknown as [string, string, string, string];
    // Renames print as "old => new" or "dir/{old => new}"; count the new path.
    const file = rawFile.includes("=>")
      ? rawFile.replace(/\{[^}]*=> ([^}]*)\}/, "$1").replace(/^.* => /, "")
      : rawFile;
    out.push({
      file: file.replace(/\/\//g, "/"),
      added: add === "-" ? 0 : Number(add),
      removed: del === "-" ? 0 : Number(del),
    });
  }
  return out;
}

/** The layer a rung belongs to, for an outcome with no gate to say. */
const LAYER_OF_RUNG: Record<GateRung, GateLayer> = {
  parse: "static",
  typecheck: "static",
  lint: "static",
  test: "functional",
  bounds: "hygiene",
  hygiene: "hygiene",
  visual: "visual",
  security: "security",
  robustness: "robustness",
};

export class DeterministicGateRunner implements GateRunner {
  private config: GatesConfig | undefined;
  /** Defects found while completing parser output during the current run. */
  private defects: string[] = [];

  constructor(
    private sandbox: ProcessSandbox,
    private options: GateRunnerOptions = {},
  ) {}

  /**
   * Resolve the gate configuration, re-verifying its hash when one is pinned.
   *
   * Re-verification happens per run rather than once at load: a gates file that
   * can be edited mid-card turns verification into whatever the agent decides
   * it should be.
   */
  public resolveConfig(cwd: string): GatesConfig {
    const root = this.options.repoRoot ?? cwd;
    if (this.options.expectedConfigSha256) {
      return verifyGatesConfig(root, this.options.expectedConfigSha256);
    }
    if (!this.config) this.config = loadGatesConfig(root);
    return this.config;
  }

  public checkBounds(options: BoundsCheckOptions): BoundsCheckResult {
    return checkBounds(options);
  }

  /** Execute one declared gate and parse its output into typed failures. */
  public async runGate(
    gate: GateDefinition,
    cwd: string,
  ): Promise<{
    outcome: RungOutcome;
    failures: GateFailure[];
  }> {
    const start = performance.now();
    const minimalRepro = [gate.command, ...gate.args].join(" ");
    let result: Awaited<ReturnType<ProcessSandbox["execute"]>>;
    try {
      result = await this.sandbox.execute(gate.command, gate.args, {
        allowedPaths: [cwd],
        allowNetwork: false,
        timeoutMs: gate.timeoutMs,
        cwd,
      });
    } catch (err) {
      // Fail closed (rule 9): a gate that could not start is not a pass, and
      // it is never silently absent.
      const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
      return {
        outcome: {
          gate: gate.id,
          rung: gate.rung,
          layer: gate.layer,
          passed: false,
          exitCode: -1,
          durationMs: Math.round(performance.now() - start),
        },
        failures: [
          {
            rung: gate.rung,
            gate: gate.id,
            layer: gate.layer,
            exitCode: -1,
            errorExcerpt: `${gate.id} not run: ${reason}`,
            suggestedFixFiles: [],
            location: { file: "." },
            expected: `${gate.id} to run and exit 0`,
            actual: reason || "the gate could not start",
            minimalRepro,
            suggestedAction: gateCopy.gateNotRun(gate.id),
            notRun: true,
          },
        ],
      };
    }
    const durationMs = Math.round(performance.now() - start);
    // The sandbox says the program never started (a missing binary): not run,
    // never a failure the model is charged with (gates rule 9).
    if (result.notStarted) {
      const reason = (result.stderr.split("\n").find((l) => l.trim()) ?? "").trim();
      return {
        outcome: {
          gate: gate.id,
          rung: gate.rung,
          layer: gate.layer,
          passed: false,
          exitCode: result.exitCode,
          durationMs,
        },
        failures: [
          {
            rung: gate.rung,
            gate: gate.id,
            layer: gate.layer,
            exitCode: result.exitCode,
            errorExcerpt: `${gate.id} not run: ${reason || `${gate.command} did not start`}`,
            suggestedFixFiles: [],
            location: { file: "." },
            expected: `${gate.id} to run and exit 0`,
            actual: reason || `${gate.command} did not start`,
            minimalRepro,
            suggestedAction: gateCopy.gateNotRun(gate.id),
            notRun: true,
          },
        ],
      };
    }

    const outcome: RungOutcome = {
      gate: gate.id,
      rung: gate.rung,
      layer: gate.layer,
      passed: result.exitCode === 0,
      exitCode: result.exitCode,
      durationMs,
    };

    if (result.exitCode === 0) return { outcome, failures: [] };

    const ctx: ParseContext = {
      gate,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      minimalRepro,
      cwd,
    };

    // A parser that leaves a field empty is a harness defect: the gap is
    // filled and recorded, never thrown mid-turn.
    const failures = completeFailures(defaultParserRegistry.parse(ctx), (d) =>
      this.defects.push(`the ${gate.parser} parser: ${d}`),
    );
    if (result.timedOut) {
      for (const f of failures) {
        f.actual = `timed out after ${gate.timeoutMs}ms`;
      }
    }

    return { outcome, failures };
  }

  public async runCustomCommandGate(
    rung: GateRung,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<GateResult> {
    const gate: GateDefinition = {
      id: rung,
      rung,
      layer: "functional",
      command,
      args,
      timeoutMs: 180_000,
      parser: "generic",
      blocking: true,
    };

    const start = performance.now();
    const { outcome, failures } = await this.runGate(gate, cwd);
    return {
      passed: failures.length === 0,
      failures,
      durationMs: Math.round(performance.now() - start),
      rungResults: [outcome],
    };
  }

  /**
   * Run the requested rungs and return the complete result set.
   *
   * Every gate runs by default rather than stopping at the first failure: the
   * Review surface needs the whole picture to assemble evidence, and an agent
   * repairing one rung at a time cannot see that two rungs share a root cause.
   */
  public async runGates(rungs: GateRung[], cwd: string): Promise<GateResult> {
    const start = performance.now();
    this.defects = [];
    const config = this.resolveConfig(cwd);

    const requested = new Set(rungs);
    const selected =
      rungs.length > 0
        ? config.gates.filter((g) => requested.has(g.rung))
        : config.gates.filter((g) => g.blocking);

    // A requested rung with no declared gate falls back to the built-in default.
    for (const rung of requested) {
      if (!selected.some((g) => g.rung === rung)) {
        const fallback = DEFAULT_GATES.find((g) => g.rung === rung);
        if (fallback) selected.push({ ...fallback });
      }
    }

    const failures: GateFailure[] = [];
    const rungResults: RungOutcome[] = [];

    // A requested rung with neither a declared gate nor a default is never
    // silently absent: the evidence records that it did not run, and how to
    // declare one.
    for (const rung of requested) {
      if (selected.some((g) => g.rung === rung)) continue;
      rungResults.push({
        gate: rung,
        rung,
        layer: LAYER_OF_RUNG[rung],
        passed: false,
        exitCode: -1,
        durationMs: 0,
        skipped: true,
        reason: `no gate is declared for the ${rung} rung: add a [[gate]] with rung = "${rung}" to .sekhemet/gates.toml`,
      });
    }

    for (const gate of selected) {
      const { outcome, failures: gateFailures } = await this.runGate(gate, cwd);
      rungResults.push(outcome);
      failures.push(...gateFailures);

      if (!outcome.passed && gate.blocking && this.options.failFast) {
        // Remaining gates are recorded as skipped so the evidence is honest
        // about what was and was not measured.
        for (const skipped of selected.slice(selected.indexOf(gate) + 1)) {
          rungResults.push({
            gate: skipped.id,
            rung: skipped.rung,
            layer: skipped.layer,
            passed: false,
            exitCode: -1,
            durationMs: 0,
            skipped: true,
          });
        }
        break;
      }
    }

    // A failure reported inside a protected test must not send the agent to
    // edit that test: it cannot (the permission engine denies it), so the
    // suggestion is a dead end that burns turns. Point it at the implementation.
    for (const failure of failures) {
      const onlyProtected =
        failure.suggestedFixFiles.length > 0 &&
        failure.suggestedFixFiles.every((f) =>
          config.project.protected.some((pattern) => matchesGlob(f, pattern)),
        );
      if (onlyProtected) {
        const where = failure.suggestedFixFiles.join(", ");
        failure.suggestedFixFiles = [];
        failure.suggestedAction = gateCopy.protectedTest(where);
      }
    }

    return {
      passed: failures.length === 0,
      // Hand back only the highest-leverage failures, in dependency order
      // (rule 20): fixing the first usually clears the rest.
      failures: rankFailures(failures, this.options.maxFailuresReported ?? FAILURES_SHOWN, cwd),
      ...(this.defects.length > 0 ? { defects: [...this.defects] } : {}),
      durationMs: Math.round(performance.now() - start),
      rungResults,
    };
  }
}

export { parseErrorToGateFailure };
