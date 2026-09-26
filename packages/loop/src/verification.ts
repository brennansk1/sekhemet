import {
  type BuiltinGateContext,
  type GateRung,
  type GateRunner,
  type GateStage,
  type PipelineResult,
  boundsStage,
  builtinStage,
  declaredStage,
  runGatePipeline,
  unavailableGate,
} from "@sekhemet/gates";
import {
  integrityFailures,
  scanDiffIntegrity,
  worktreeDiff,
  worktreeNumstat,
} from "./integrity.js";

/**
 * A card's verification as one gate pipeline (gates rule 8, T1): the card
 * run and `sekhemet gate <card>` both call this, so they give the same
 * verdict and the same gate outcomes on the same tree (GT-T1-1).
 */
export interface CardVerificationInput {
  /** The card's worktree. */
  root: string;
  /** The integration branch the card's change is judged against. */
  base: string;
  rungs: GateRung[];
  /** The declared gates, wrapped by the project gates. */
  runner: GateRunner;
  /** The acceptance tests the harness staged, repository-relative: not the card's writing. */
  staged: readonly string[];
  /** The integrity gate (rule 13); default on. */
  integrity?: boolean;
  /** The card-size gate (rule 12), when the card runs under bounds. */
  bounds?: { maxFiles: number; maxLines: number };
  /** The built-in layers (rule 3) and what they need beyond the tree. */
  builtin?: Pick<BuiltinGateContext, "project" | "registry" | "stateDir" | "gates">;
  /** A read-only audit: no mutation and no visual layer (S12). */
  restricted?: boolean;
}

/** A staged acceptance test's path as the diff names it. */
export function stagedTestPath(test: string): string {
  return test.startsWith("tests/") ? test : `tests/${test}`;
}

/** The integrity gate as a stage: a pass bought by switching a check off is not a pass. */
function integrityStage(diff: string | undefined, staged: string[], base: string): GateStage {
  return {
    id: "integrity",
    rung: "hygiene",
    layer: "hygiene",
    run: async () => {
      if (diff === undefined) {
        const { outcome, failure } = unavailableGate(
          "integrity",
          "hygiene",
          "hygiene",
          "git could not produce the diff",
          `git diff ${base}`,
        );
        return { outcomes: [outcome], failures: [failure] };
      }
      const failures = integrityFailures(scanDiffIntegrity(diff, staged), base);
      return {
        outcomes: [
          {
            gate: "integrity",
            rung: "hygiene",
            layer: "hygiene",
            passed: failures.length === 0,
            exitCode: failures.length === 0 ? 0 : 1,
            durationMs: 0,
          },
        ],
        failures,
      };
    },
  };
}

export async function verifyCardTree(input: CardVerificationInput): Promise<PipelineResult> {
  const { root, base, runner } = input;
  const staged = input.staged.map(stagedTestPath);
  // One read of the diff for every gate that judges it; undefined when git
  // cannot produce it, and then those gates are unavailable.
  const diff = worktreeDiff(root, base);
  const stages: GateStage[] = [declaredStage(runner, input.rungs, root)];
  if (input.integrity !== false) stages.push(integrityStage(diff, staged, base));
  if (input.bounds) {
    stages.push(
      boundsStage({
        base,
        perFile: worktreeNumstat(root, base),
        staged,
        maxFiles: input.bounds.maxFiles,
        maxLines: input.bounds.maxLines,
      }),
    );
  }
  if (input.builtin) {
    const project = input.restricted
      ? { ...input.builtin.project, mutation: false }
      : input.builtin.project;
    stages.push(
      builtinStage({
        ...input.builtin,
        root,
        base,
        diff,
        project,
        harnessOwned: staged,
        visual: !input.restricted,
        runTests: async () => (await runner.runGates(["test"], root)).passed,
      }),
    );
  }
  return runGatePipeline(stages, { cwd: root });
}
