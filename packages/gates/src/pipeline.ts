import { performance } from "node:perf_hooks";
import { type BuiltinGateContext, runBuiltinGates } from "./builtin.js";
import { DEFAULT_PROJECT_CONFIG, GatesConfigTamperError } from "./config.js";
import { RERUN_GATES, gateCopy } from "./copy.js";
import { FAILURES_SHOWN, finalizeFailures, rankFailures } from "./rank.js";
import { checkBounds } from "./runner.js";
import type {
  CompleteGateFailure,
  GateDefinition,
  GateFailure,
  GateLayer,
  GateResult,
  GateRung,
  GateRunner,
  RunGatesOptions,
  RungOutcome,
  ToolAppliedCount,
  ToolAppliedRecord,
} from "./types.js";

/**
 * One gate pipeline (gates rules 8-9, 20; T1).
 *
 * Every gate — declared, project, integrity, bounds, built-in layers and
 * external results — runs as a stage of this one pipeline with one result
 * shape, and failures are ranked and capped once, at the end. A stage that
 * throws is `unavailable`, never absent and never a pass (fail closed); the
 * one exception is a changed `gates.toml`, which aborts the verification
 * (GT-1).
 */

/** What one stage reports: its gates' outcomes and failures, and what does not fail the card. */
export interface StageReport {
  outcomes: RungOutcome[];
  failures: GateFailure[];
  advisories?: string[];
  /** Harness defects found while running (an incomplete failure, filled in). */
  defects?: string[];
}

/** What the stages before this one found, for a stage that runs only once they pass. */
export interface PipelineSoFar {
  passed: boolean;
}

export interface GateStage {
  /** The gate id this stage reports under when it throws. */
  id: string;
  rung: GateRung;
  layer: GateLayer;
  /** A non-blocking stage that cannot run is an advisory, not a failure (default true). */
  blocking?: boolean;
  run(soFar: PipelineSoFar): Promise<StageReport>;
}

export interface PipelineOptions {
  /** The worktree the gates judged, for ranking by the import graph. */
  cwd: string;
  /** Failures handed to the model (default 3, rule 20). */
  limit?: number;
}

export interface PipelineResult extends GateResult {
  rungResults: RungOutcome[];
  /** The failures shown to the model: complete, ranked and capped once. */
  failures: CompleteGateFailure[];
  /** Every failure, complete and ranked, before the cap: for wrappers and the evidence. */
  allFailures: CompleteGateFailure[];
  advisories: string[];
  defects: string[];
}

function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n").find((l) => l.trim()) ?? "it threw";
}

/** The outcome and failure of a gate that could not produce a verdict (rule 9). */
export function unavailableGate(
  gate: string,
  rung: GateRung,
  layer: GateLayer,
  reason: string,
  minimalRepro: string = RERUN_GATES,
): { outcome: RungOutcome; failure: GateFailure } {
  return {
    outcome: {
      gate,
      rung,
      layer,
      passed: false,
      exitCode: -1,
      durationMs: 0,
      unavailable: true,
      reason,
    },
    failure: {
      rung,
      gate,
      layer,
      exitCode: -1,
      errorExcerpt: `${gate} not run: ${reason}`,
      suggestedFixFiles: [],
      location: { file: "." },
      expected: `${gate} to run and report a result`,
      actual: reason,
      minimalRepro,
      suggestedAction: gateCopy.gateNotRun(gate),
      notRun: true,
    },
  };
}

/**
 * An outcome that did not pass, whose failures are all "could not run", is
 * `unavailable` with the first one's reason: one rule for every gate, so a
 * scanner, a declared gate and a project gate that could not run look the
 * same in the evidence (GT-T1-2, GT-T1-3).
 */
function markUnavailable(outcomes: RungOutcome[], failures: readonly GateFailure[]): RungOutcome[] {
  return outcomes.map((o) => {
    // A gate that did not run never records a pass (GT-T1-11).
    if (o.skipped && o.passed) return { ...o, passed: false };
    if (o.passed || o.skipped || o.unavailable) return o;
    const own = failures.filter((f) => f.gate === o.gate);
    if (own.length === 0 || !own.every((f) => f.notRun === true)) return o;
    return { ...o, unavailable: true, reason: o.reason ?? own[0]?.actual ?? "it could not run" };
  });
}

/**
 * Run the stages in order and rank once (rules 8, 9, 20). The verdict passes
 * only when no stage reported a failure; a blocking stage that throws is an
 * unavailable failure, and a non-blocking one an advisory.
 */
export async function runGatePipeline(
  stages: readonly GateStage[],
  options: PipelineOptions,
): Promise<PipelineResult> {
  const start = performance.now();
  const outcomes: RungOutcome[] = [];
  const failures: GateFailure[] = [];
  const advisories: string[] = [];
  const defects: string[] = [];
  for (const stage of stages) {
    let report: StageReport;
    try {
      report = await stage.run({ passed: failures.length === 0 });
    } catch (err) {
      // A changed gates.toml is not a gate that could not run: it aborts.
      if (err instanceof GatesConfigTamperError) throw err;
      const reason = firstLine(err);
      const { outcome, failure } = unavailableGate(stage.id, stage.rung, stage.layer, reason);
      outcomes.push(outcome);
      if (stage.blocking === false) advisories.push(`${stage.id} unavailable: ${reason}`);
      else failures.push(failure);
      continue;
    }
    outcomes.push(...report.outcomes);
    failures.push(...report.failures);
    advisories.push(...(report.advisories ?? []));
    defects.push(...(report.defects ?? []));
  }
  const all = finalizeFailures(failures, {
    limit: Number.POSITIVE_INFINITY,
    cwd: options.cwd,
    onIncomplete: (d) => defects.push(d),
  });
  const limit = options.limit ?? FAILURES_SHOWN;
  return {
    passed: failures.length === 0,
    // Ranked and capped once, after every gate has reported (rule 20).
    failures: rankFailures(all, limit, options.cwd),
    allFailures: all,
    rungResults: markUnavailable(outcomes, failures),
    advisories,
    defects,
    durationMs: Math.round(performance.now() - start),
  };
}

/**
 * The rungs a card is verified on: every blocking gate the project declares;
 * under --restricted only the static layer, since running the repository's
 * tests would run its code (S12). One function for the card run and
 * `sekhemet gate`, so both verify the same rungs (GT-T1-1).
 */
export function verificationRungs(
  gates: readonly GateDefinition[],
  restricted: boolean,
): GateRung[] {
  return [
    ...new Set(
      gates.filter((g) => g.blocking && (!restricted || g.layer === "static")).map((g) => g.rung),
    ),
  ];
}

// --- Stages -----------------------------------------------------------------

/**
 * The declared gates of `gates.toml` (and the project gates that wrap the
 * runner), for the requested rungs. The runner hands back every failure; the
 * pipeline caps.
 */
export function declaredStage(
  runner: GateRunner,
  rungs: GateRung[],
  cwd: string,
  runOptions?: RunGatesOptions,
): GateStage {
  return {
    id: rungs.length === 1 ? (rungs[0] as string) : "gates",
    rung: rungs[0] ?? "test",
    layer: "functional",
    run: async () => {
      const id = rungs.length === 1 ? (rungs[0] as string) : "gates";
      const rung = rungs[0] ?? "test";
      const r = (await (runOptions
        ? runner.runGates(rungs, cwd, runOptions)
        : runner.runGates(rungs, cwd))) as Partial<GateResult> | null | undefined;
      // A reply the pipeline cannot read is no verdict: never a pass (rule 9).
      if (
        !r ||
        typeof r !== "object" ||
        typeof r.passed !== "boolean" ||
        !Array.isArray(r.failures) ||
        (r.rungResults !== undefined && !Array.isArray(r.rungResults))
      ) {
        const { outcome, failure } = unavailableGate(
          id,
          rung,
          "functional",
          "the runner's reply was malformed (no verdict or no list of failures)",
        );
        return { outcomes: [outcome], failures: [failure] };
      }
      let outcomes = [...(r.rungResults ?? [])];
      const failures = [...r.failures];
      // A failed verdict with nothing named is not a pass either (fail closed):
      // each gate that did not pass, or the stage itself, is unavailable. So is
      // an inconsistent reply that says it passed while an outcome failed.
      const failedOutcome = outcomes.some((o) => !o.passed && !o.skipped);
      if ((!r.passed || failedOutcome) && failures.length === 0) {
        const reason = "the runner reported a failure without naming one";
        const failed = outcomes.filter((o) => !o.passed && !o.skipped);
        const gates =
          failed.length > 0 ? failed : [{ gate: id, rung, layer: "functional" as const }];
        for (const g of gates) {
          const { outcome, failure } = unavailableGate(g.gate, g.rung, g.layer, reason);
          outcomes = [...outcomes.filter((o) => o.gate !== g.gate), outcome];
          failures.push(failure);
        }
      }
      // A flaky test is reported to the person, never charged to the Worker
      // (rule 34, GT-N3-4).
      const advisories = outcomes.flatMap((o) =>
        (o.quarantined ?? []).map(
          (q) =>
            `flaky test quarantined until the tree changes: ${q.test} failed, then ${q.rerun}. First run: ${q.firstRun.split("\n").slice(0, 3).join(" ")}`,
        ),
      );
      return {
        outcomes,
        failures,
        ...(advisories.length > 0 ? { advisories } : {}),
        ...(r.defects ? { defects: r.defects } : {}),
      };
    },
  };
}

/**
 * The card-size gate on the measured diff (rule 12): the lines the Worker
 * wrote, the staged acceptance tests excluded. `perFile` undefined means git
 * could not say, and the gate is unavailable — never passed.
 *
 * Lines a declared mechanical tool applied (`toolApplied`: a rename, a
 * codemod, a formatter, a lockfile update) are taken out of the Worker's
 * count and counted against `maxToolAppliedLines` instead (GT-BF-3,
 * GT-BF-5); a file only the tool changed is not one of the Worker's files.
 */
export function boundsStage(options: {
  base: string;
  perFile: readonly { file: string; added: number; removed: number }[] | undefined;
  staged?: readonly string[];
  maxFiles: number;
  maxLines: number;
  maxToolAppliedLines?: number;
  toolApplied?: ToolAppliedRecord | undefined;
}): GateStage {
  return {
    id: "bounds",
    rung: "bounds",
    layer: "hygiene",
    run: async () => {
      if (!options.perFile) {
        const { outcome, failure } = unavailableGate(
          "bounds",
          "bounds",
          "hygiene",
          "git could not produce the diff",
          `git diff ${options.base}`,
        );
        return { outcomes: [outcome], failures: [failure] };
      }
      const staged = new Set(options.staged ?? []);
      const limit = options.maxToolAppliedLines ?? DEFAULT_PROJECT_CONFIG.maxToolAppliedLines;
      const byTool = options.toolApplied?.files ?? {};
      const toolFiles: Record<string, number> = {};
      // The tool's own record (lines it changed) for the files it counted, so
      // a later `sekhemet gate` can count them the same way.
      const recorded: Record<string, number> = {};
      const own: { file: string; added: number; removed: number }[] = [];
      for (const f of options.perFile) {
        if (staged.has(f.file)) continue;
        // A line the tool changed is one removed and one added in the diff.
        const n = byTool[f.file] ?? 0;
        const toolAdded = Math.min(f.added, n);
        const toolRemoved = Math.min(f.removed, n);
        if (toolAdded + toolRemoved > 0) {
          toolFiles[f.file] = toolAdded + toolRemoved;
          recorded[f.file] = n;
        }
        const added = f.added - toolAdded;
        const removed = f.removed - toolRemoved;
        if (added + removed > 0 || (n === 0 && f.added + f.removed === 0)) {
          own.push({ file: f.file, added, removed });
        }
      }
      const toolLines = Object.values(toolFiles).reduce((a, b) => a + b, 0);
      const tool = options.toolApplied?.tool;
      const toolApplied: ToolAppliedCount = {
        ...(tool && toolLines > 0 ? { tool, files: recorded } : {}),
        lines: toolLines,
        limit,
      };
      const failures: GateFailure[] = [];
      const verdict = checkBounds({
        base: options.base,
        filesTouched: own.map((f) => f.file),
        linesAdded: own.reduce((n, f) => n + f.added, 0),
        linesRemoved: own.reduce((n, f) => n + f.removed, 0),
        maxFiles: options.maxFiles,
        maxLines: options.maxLines,
      });
      if (verdict.failure) failures.push(verdict.failure);
      if (toolLines > limit) {
        const name = tool ?? "a mechanical tool";
        const files = Object.keys(toolFiles).sort();
        failures.push({
          rung: "bounds",
          gate: "bounds",
          layer: "hygiene",
          exitCode: 1,
          errorExcerpt: `Exceeded tool-applied line limit: ${name} applied ${toolLines} diff lines (limit: ${limit}) across ${files.length} files`,
          suggestedFixFiles: files,
          location: { file: files[0] ?? "." },
          expected: `at most ${limit} tool-applied diff lines`,
          actual: `${name} applied ${toolLines} diff lines`,
          minimalRepro: `git diff --numstat ${options.base}`,
          suggestedAction: gateCopy.boundsToolApplied(name, String(toolLines), String(limit)),
        });
      }
      return {
        outcomes: [
          {
            gate: "bounds",
            rung: "bounds",
            layer: "hygiene",
            passed: failures.length === 0,
            exitCode: failures.length === 0 ? 0 : 1,
            durationMs: 0,
            toolApplied,
            ...(toolLines > 0
              ? {
                  note: `${toolLines} tool-applied lines by ${tool ?? "a mechanical tool"} (limit ${limit}), not counted against max_diff_lines; the typecheck and the full suite must pass`,
                }
              : {}),
          },
        ],
        failures,
      };
    },
  };
}

/**
 * The built-in layers (rule 3's security, hygiene and robustness layers, and
 * the visual layer). Mutation and the visual layer run only once every stage
 * before them passed: a change that does not build has nothing to mutate or
 * look at.
 */
export function builtinStage(ctx: BuiltinGateContext): GateStage {
  return {
    id: "builtin",
    rung: "security",
    layer: "security",
    run: async (soFar) => {
      const r = await runBuiltinGates({
        ...ctx,
        project: soFar.passed ? ctx.project : { ...ctx.project, mutation: false },
        visual: ctx.visual === true && soFar.passed,
      });
      return { outcomes: r.outcomes, failures: r.failures, advisories: r.advisories };
    },
  };
}

/** A result an external CI check reported for the card's branch (rule 35; kernel rule 37). */
export interface ExternalCheckResult {
  check: string;
  passed: boolean;
  headSha: string;
  url?: string;
}

/**
 * External CI results (GT-T1-12). A result counts only for the card's branch
 * head; it is advisory unless the gate standing for its check is declared
 * `blocking = true` in `gates.toml`. A result on another head is left out of
 * the verdict, and the advisories say why.
 */
export function externalStage(options: {
  results: readonly ExternalCheckResult[];
  gates: readonly GateDefinition[];
  headSha: string;
}): GateStage {
  return {
    id: "external",
    rung: "test",
    layer: "functional",
    run: async () => {
      const outcomes: RungOutcome[] = [];
      const failures: GateFailure[] = [];
      const advisories: string[] = [];
      for (const r of options.results) {
        const gate = options.gates.find((g) => g.external === r.check);
        if (r.headSha !== options.headSha) {
          advisories.push(
            `external check ${r.check} left out: it ran on ${r.headSha.slice(0, 12)}, the card's branch head is ${options.headSha.slice(0, 12)}`,
          );
          continue;
        }
        const id = gate?.id ?? r.check;
        const rung = gate?.rung ?? "test";
        const layer = gate?.layer ?? "functional";
        outcomes.push({
          gate: id,
          rung,
          layer,
          passed: r.passed,
          exitCode: r.passed ? 0 : 1,
          durationMs: 0,
          source: {
            kind: "external",
            check: r.check,
            headSha: r.headSha,
            ...(r.url ? { url: r.url } : {}),
          },
        });
        if (r.passed) continue;
        const blocking = gate?.blockingDeclared === true && gate.blocking;
        if (!blocking) {
          advisories.push(
            `external check ${r.check} failed (advisory: not declared blocking)${r.url ? ` ${r.url}` : ""}`,
          );
          continue;
        }
        failures.push({
          rung,
          gate: id,
          layer,
          exitCode: 1,
          errorExcerpt: `external check ${r.check} failed on ${r.headSha.slice(0, 12)}`,
          suggestedFixFiles: [],
          location: { file: "." },
          expected: `${r.check} to pass`,
          actual: `${r.check} failed${r.url ? ` (${r.url})` : ""}`,
          minimalRepro: gate ? [gate.command, ...gate.args].join(" ") : RERUN_GATES,
          suggestedAction: gateCopy.rerun(
            gate ? [gate.command, ...gate.args].join(" ") : RERUN_GATES,
          ),
        });
      }
      return { outcomes, failures, advisories };
    },
  };
}
