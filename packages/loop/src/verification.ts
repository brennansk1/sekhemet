import {
  type BuiltinGateContext,
  DeterministicGateRunner,
  type GateDefinition,
  type GateRung,
  type GateRunner,
  type GateStage,
  type PackageGateRunner,
  type PipelineResult,
  type ToolAppliedRecord,
  type VisualGateContext,
  acceptanceCommand,
  boundsStage,
  builtinStage,
  declaredStage,
  runAcceptanceTests,
  runChangeKindChecks,
  runGatePipeline,
  unavailableGate,
  workspaceStage,
} from "@sekhemet/gates";
import type { CardChange, CardGateChecks } from "@sekhemet/kernel";
import { type ProcessSandbox, confinedSandbox } from "@sekhemet/sandbox";
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
  bounds?: { maxFiles: number; maxLines: number; maxToolAppliedLines?: number };
  /**
   * Lines a declared mechanical tool applied (`rename_symbol`), per file:
   * counted against `maxToolAppliedLines`, never the Worker's bound, and the
   * card must then pass the typecheck and the full suite (rule 12, GT-BF-3).
   */
  toolApplied?: ToolAppliedRecord | undefined;
  /** The built-in layers (rule 3) and what they need beyond the tree. */
  builtin?: Pick<BuiltinGateContext, "project" | "registry" | "stateDir" | "gates">;
  /** A read-only audit: no mutation and no visual layer (S12), and no package gates. */
  restricted?: boolean;
  /**
   * What runs the per-package gates of a workspace (gates rule 34a,
   * review-git RG-N3-1): default the declared-gate runner, confined with no
   * network; `false` runs none.
   */
  packageGates?: PackageGateRunner | false;
  /**
   * The card verified: its id names its nightly mutation queue (GT-N5-5);
   * its `change` chooses the refactor surface or upgrade checks (GT-TQ-8,
   * GT-TQ-11); what it declares to its gates reaches the visual layer
   * (GT-N4-4, GT-N4-6); a research card's claims report meets the claim gate
   * (GT-N5-3).
   */
  card?: VerifiedCard | undefined;
  /**
   * The project's test gate, run through its JUnit path in `sandbox`: the
   * acceptance tests alone for the acceptance-test mutation score (GT-TQ-3)
   * and an upgrade's kept tests (GT-TQ-11). Absent (a gate host, a runner
   * with no JUnit path), neither runs here and the evidence says why.
   */
  acceptance?: { testGate: GateDefinition; sandbox?: ProcessSandbox | undefined } | undefined;
  /** The vision checklist for the visual layer, or why it does not run (GT-N4-2). */
  vision?: Pick<VisualGateContext, "vision" | "visionNotRun"> | undefined;
}

/** What a card's verification reads from the card itself. */
export interface VerifiedCard {
  id: string;
  change?: CardChange | undefined;
  scopeFiles?: readonly string[] | undefined;
  gateChecks?: CardGateChecks | undefined;
  /** A research card: its claims report is checked (GT-N5-3). */
  research?: boolean | undefined;
}

/** A research card is one labelled `research` (X7). */
export function isResearchLabelled(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((l) => l.toLowerCase() === "research");
}

/** Every path the diff touches, a deleted file's too (its exports are surface removed). */
function touchedPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ b/") || l.startsWith("--- a/")) out.add(l.slice(6));
  }
  return [...out].sort();
}

/**
 * The checks particular to the card's `change` as a stage: a refactor's
 * exported surface and an upgrade's kept tests (gates rule 6b, GT-TQ-8,
 * GT-TQ-11). An upgrade's tests run the project's code: never in an audit.
 */
function changeKindStage(
  input: CardVerificationInput,
  base: string,
  diff: string | undefined,
): GateStage | undefined {
  const card = input.card;
  const change = card?.change;
  if (!card || (change !== "refactor" && change !== "upgrade")) return undefined;
  if (change === "upgrade" && input.restricted) return undefined;
  return {
    id: change === "refactor" ? "refactor-surface" : "upgrade-tests",
    rung: "test",
    layer: "functional",
    run: async () =>
      runChangeKindChecks({
        root: input.root,
        base,
        change,
        scope: card.scopeFiles ?? [],
        // GT-TQ-8: the files the change touches are judged with its scope.
        changed: diff === undefined ? undefined : touchedPaths(diff),
        surfaceChange: card.gateChecks?.surfaceChange,
        keptTests: card.gateChecks?.keptTests,
        ...(input.acceptance
          ? {
              testGate: input.acceptance.testGate,
              sandbox: input.acceptance.sandbox ?? confinedSandbox(false),
            }
          : {}),
      }),
  };
}

/**
 * Run the staged acceptance tests alone (GT-TQ-3): true only when every one
 * ran and passed. Undefined when they cannot be run alone here.
 */
function acceptanceRunner(
  input: CardVerificationInput,
  root: string,
  staged: string[],
): (() => Promise<boolean>) | undefined {
  const a = input.acceptance;
  if (!a || staged.length === 0 || input.restricted) return undefined;
  if (!acceptanceCommand(a.testGate, staged, "report.xml", false)) return undefined;
  const sandbox = a.sandbox ?? confinedSandbox(false);
  return async () => {
    const r = await runAcceptanceTests(sandbox, root, a.testGate, staged, { bail: true });
    return (
      !("unavailable" in r) && r.results.length > 0 && r.results.every((x) => x.kind === "passed")
    );
  };
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
  // Tool-applied lines are held to the typecheck and the full suite (rule 12, GT-BF-3).
  const toolLines = Object.values(input.toolApplied?.files ?? {}).some((n) => n > 0);
  const rungs: GateRung[] = toolLines
    ? [...new Set<GateRung>([...input.rungs, "typecheck", "test"])]
    : input.rungs;
  const perFile = worktreeNumstat(root, base);
  const stages: GateStage[] = [];
  // In a workspace, the changed packages and their dependents run their own
  // gates first, in build order (rule 34a, GT-BF-4), inside the card's
  // verification (RG-N3-1). They run the project's code: never in an audit.
  // The declared runner runs them itself, first, through its verdict cache
  // and quarantine and every layer that wraps it — the baseline,
  // supersession (review M3) — and leaves their tests out of the declared
  // suite (review efficiency). A runner that does not (a gate host, a test
  // double) leaves them to the workspace stage after it.
  const changed = perFile?.map((f) => f.file) ?? [];
  const packaged = !input.restricted && input.packageGates !== false && changed.length > 0;
  let ranPackages = false;
  const declaredRunner: GateRunner = packaged
    ? {
        ...(runner.gateIds ? { gateIds: runner.gateIds } : {}),
        runGates: async (r, cwd, options) => {
          const res = await runner.runGates(r, cwd, options);
          if (res && typeof res === "object" && res.workspace) ranPackages = true;
          return res;
        },
      }
    : runner;
  stages.push(
    declaredStage(
      declaredRunner,
      rungs,
      root,
      packaged ? { workspace: { base, changed } } : undefined,
    ),
  );
  if (packaged && input.packageGates !== false) {
    const fallback = workspaceStage({
      root,
      changed,
      base,
      runner:
        input.packageGates ??
        new DeterministicGateRunner(confinedSandbox(false), {
          maxFailuresReported: Number.POSITIVE_INFINITY,
        }),
    });
    stages.push({
      ...fallback,
      run: async (soFar) => (ranPackages ? { outcomes: [], failures: [] } : fallback.run(soFar)),
    });
  }
  if (input.integrity !== false) stages.push(integrityStage(diff, staged, base));
  if (input.bounds) {
    stages.push(
      boundsStage({
        base,
        perFile,
        staged,
        maxFiles: input.bounds.maxFiles,
        maxLines: input.bounds.maxLines,
        ...(input.bounds.maxToolAppliedLines !== undefined
          ? { maxToolAppliedLines: input.bounds.maxToolAppliedLines }
          : {}),
        ...(input.toolApplied ? { toolApplied: input.toolApplied } : {}),
      }),
    );
  }
  const changeKind = changeKindStage(input, base, diff);
  if (changeKind) stages.push(changeKind);
  if (input.builtin) {
    const project = input.restricted
      ? { ...input.builtin.project, mutation: false }
      : input.builtin.project;
    const card = input.card;
    const checks = card?.gateChecks;
    const runAcceptance = acceptanceRunner(input, root, staged);
    const visualCard: BuiltinGateContext["visualCard"] = {
      ...(checks?.visualAssertions?.length ? { assertions: checks.visualAssertions } : {}),
      ...(checks?.allowOverlap?.length ? { allowOverlap: checks.allowOverlap } : {}),
      ...(input.vision?.vision ? { vision: input.vision.vision } : {}),
      ...(input.vision?.visionNotRun ? { visionNotRun: input.vision.visionNotRun } : {}),
    };
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
        // GT-TQ-3, GT-TQ-4: the acceptance-test score and stillborn mutants.
        ...(runAcceptance ? { runAcceptanceTests: runAcceptance } : {}),
        // Only with a declared typecheck: a rung with no gate is not run,
        // never a verdict that would make every mutant stillborn.
        ...(rungs.includes("typecheck")
          ? { runTypecheck: async () => (await runner.runGates(["typecheck"], root)).passed }
          : {}),
        ...(card ? { cardId: card.id } : {}),
        ...(card?.research ? { researchCardId: card.id } : {}),
        ...(Object.keys(visualCard ?? {}).length > 0 ? { visualCard } : {}),
      }),
    );
  }
  return runGatePipeline(stages, { cwd: root });
}
