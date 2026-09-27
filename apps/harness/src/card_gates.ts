import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BaselineEntry,
  type BaselinePartial,
  DeterministicGateRunner,
  type GateRunner,
  type GatesConfig,
  type PipelineResult,
  type RegistryLookup,
  RemoteGateRunner,
  type ToolAppliedRecord,
  type VisualGateContext,
  readTls,
  withBaseline,
} from "@sekhemet/gates";
import type { CardChange, CardGateChecks } from "@sekhemet/kernel";
import { isResearchLabelled, verificationSessionOptions, verifyCardTree } from "@sekhemet/loop";
import { type ProcessSandbox, confinedSandbox } from "@sekhemet/sandbox";
import { integrationBranch } from "./accept.js";
import { withArchitectureGate } from "./architecture_gate.js";
import {
  CARD_ONE_LABEL,
  cardOneTests,
  withCardOneGate,
  withoutCardOneStaging,
} from "./card_zero.js";
import { withLicenseGate } from "./license_gate.js";
import { withReachabilityGate } from "./reachability_gate.js";
import { withRegressionGate } from "./regression_gate.js";
import { withTrailerGate } from "./trailer_gate.js";

/**
 * The gates a card is verified by, composed in one place (gates rule 8, T1):
 * the declared gates — on the gate host when `[gate_host]` names one — wrapped
 * by the project gates. The card run and `sekhemet gate <card>` both use it.
 */
export interface CardGateInput {
  repoPath: string;
  gatesConfig: GatesConfig;
  restricted: boolean;
  card: {
    acceptanceTests?: string[] | undefined;
    spec?: string | undefined;
    acceptanceCriteria?: string[] | undefined;
    /** The card's scope: a changelog entry is demanded only when it holds CHANGELOG.md (GT-N2-2). */
    scopeFiles?: string[] | undefined;
    /** Base tests the card supersedes, their new versions staged (rule 25a, GT-BF-1). */
    supersedes?: string[] | undefined;
    /** The card's id, `change`, labels and declarations, as its run's verification reads them. */
    id?: string | undefined;
    change?: CardChange | undefined;
    labels?: string[] | undefined;
    gateChecks?: CardGateChecks | undefined;
  };
  /**
   * The onboarding baseline in force (gates rule 15a, GT-BF-2): the declared
   * gates count only failures absent from it. Empty or absent: every failure
   * counts.
   */
  baseline?: readonly BaselineEntry[] | undefined;
  /** The `gates.toml` hash the baseline was taken with: another hash, and it is not applied (minor 4). */
  baselineGatesSha256?: string | undefined;
  /** Files only partly readable at onboarding: a partial verdict on one is forgiven (GT-IX-1, M2). */
  baselinePartial?: readonly BaselinePartial[] | undefined;
  /**
   * Every judged run's shrink — the baselined diagnostics it no longer found,
   * possibly none, and the gates it judged (review M4).
   */
  onBaselineShrink?: ((gone: BaselineEntry[], gates: string[]) => void | Promise<void>) | undefined;
}

/** The card-gate inputs a baseline loaded from the ledger gives (`loadBaseline`). */
export function baselineInput(
  b: { entries: BaselineEntry[]; partial: BaselinePartial[]; gatesSha256?: string } | undefined,
): Pick<CardGateInput, "baseline" | "baselineGatesSha256" | "baselinePartial"> {
  if (!b) return {};
  return {
    baseline: b.entries,
    baselinePartial: b.partial,
    ...(b.gatesSha256 !== undefined ? { baselineGatesSha256: b.gatesSha256 } : {}),
  };
}

/** Whether the baseline was taken with the `gates.toml` in force (minor 4). */
function baselineCurrent(input: CardGateInput): boolean {
  return (
    input.baselineGatesSha256 === undefined ||
    input.baselineGatesSha256 === input.gatesConfig.sha256
  );
}

/**
 * The branch the project gates judge a card against (gates rule 16,
 * GT-N2-3): `[project] base_branch` in `gates.toml`, else the project's
 * integration branch (`[review] integration_branch`) — never a hard-coded
 * `main`.
 */
export function gateBaseBranch(repoPath: string, gatesConfig: GatesConfig): string {
  return gatesConfig.project.baseBranch ?? integrationBranch(repoPath);
}

/**
 * The declared gates read through the onboarding baseline (rule 15a,
 * GT-BF-2), innermost, so no project gate restates a pre-existing failure.
 */
function baselined(runner: GateRunner, input: CardGateInput): GateRunner {
  if (!input.baseline || input.baseline.length === 0) return runner;
  return withBaseline(runner, {
    baseline: input.baseline,
    gatesSha256: input.baselineGatesSha256,
    currentGatesSha256: input.gatesConfig.sha256,
    ...(input.onBaselineShrink && baselineCurrent(input)
      ? { onShrink: input.onBaselineShrink }
      : {}),
  });
}

/**
 * Card one's own functional gate in place of the unit gate (design-stage
 * DS-P2-3): the test the Worker wrote in the card's scope must run and fail
 * at an assertion. Any other card: the runner as it is.
 */
function cardOne(runner: GateRunner, input: CardGateInput, sandbox: ProcessSandbox): GateRunner {
  if (!input.card.labels?.includes(CARD_ONE_LABEL)) return runner;
  return withCardOneGate(runner, {
    sandbox,
    tests: cardOneTests(input.card),
    gate: input.gatesConfig.gates.find((g) => g.layer === "functional" && g.rung === "test"),
  });
}

export function cardGateRunner(input: CardGateInput): GateRunner {
  const { repoPath, gatesConfig } = input;
  // DS-P2-3: card one's test is the Worker's, never a staged acceptance test.
  const card = withoutCardOneStaging(input.card);
  const base = gateBaseBranch(repoPath, gatesConfig);
  // Restricted mode refuses to execute where the OS cannot confine the
  // subprocess, rather than quietly running the gates unsandboxed.
  const sandbox = confinedSandbox(input.restricted);
  // X20, X26: every verification also runs the licence register gate and
  // the commit-trailer contract on the card's branch — and refuses exports
  // the card added that nothing uses and nothing requires, which is how a
  // project decays one reasonable change at a time — and refuses a change
  // that breaks or removes a test the base already guarantees, or an invariant
  // the project's brief declares.
  return withArchitectureGate(
    withRegressionGate(
      withReachabilityGate(
        withTrailerGate(
          withLicenseGate(
            // G24: a separate, mutually authenticated gate host when gates.toml
            // names one; this machine's sandbox otherwise.
            cardOne(
              baselined(
                gatesConfig.project.gateHost
                  ? new RemoteGateRunner(
                      gatesConfig.project.gateHost.url,
                      readTls(gatesConfig.project.gateHost),
                      {
                        expectedConfigSha256: gatesConfig.sha256,
                        repoRoot: repoPath,
                      },
                    )
                  : new DeterministicGateRunner(sandbox, {
                      repoRoot: repoPath,
                      expectedConfigSha256: gatesConfig.sha256,
                      // The verification caps once, after every gate and wrapper
                      // has reported (gates rule 20): the runner hands back
                      // everything, and the regression wrapper reads the whole list.
                      maxFailuresReported: Number.POSITIVE_INFINITY,
                    }),
                input,
              ),
              input,
              sandbox,
            ),
            repoPath,
            base,
          ),
          base,
        ),
        // What asked for this card's work — its acceptance tests, card one's
        // own test (DS-P2-3) and its spec — makes an export reachable before
        // the code that calls it exists.
        {
          tests: [...(card.acceptanceTests ?? []), ...cardOneTests(card)],
          text: [card.spec ?? "", ...(card.acceptanceCriteria ?? [])].join("\n"),
        },
        base,
        baselineCurrent(input) ? { baselinePartial: input.baselinePartial ?? [] } : {},
      ),
      {
        ownTests: card.acceptanceTests ?? [],
        base,
        ...(card.supersedes?.length ? { superseded: card.supersedes } : {}),
      },
    ),
    {
      briefPath: join(repoPath, ".sekhemet", "brief.md"),
      base,
      ...(baselineCurrent(input) ? { baselinePartial: input.baselinePartial ?? [] } : {}),
    },
  );
}

/**
 * `sekhemet gate <card>`: the card's verification, with the settings the
 * card run uses (the same rungs, integration branch, bounds and built-in
 * layers), so it gives the card run's verdict on the same tree (GT-T1-1).
 * Autofix and style fixes are not run: this judges the tree as it stands.
 */
export async function verifyCardWorktree(
  input: CardGateInput & {
    worktree: string;
    base: string;
    registry?: RegistryLookup;
    runner?: GateRunner;
    /** What a mechanical tool applied on the card's last run, from its evidence (GT-BF-3). */
    toolApplied?: ToolAppliedRecord | undefined;
    /** The vision checklist, or why it does not run (GT-N4-2). */
    vision?: Pick<VisualGateContext, "vision" | "visionNotRun"> | undefined;
  },
): Promise<PipelineResult> {
  const { gatesConfig, restricted } = input;
  // The card run's own verification settings (GT-T1-1): one source.
  const session = verificationSessionOptions(gatesConfig, {
    repoRoot: input.repoPath,
    restricted,
    scope: input.card.scopeFiles,
  });
  return verifyCardTree({
    root: input.worktree,
    base: input.base,
    rungs: session.gateRungs,
    runner: input.runner ?? cardGateRunner(input),
    staged: withoutCardOneStaging(input.card).acceptanceTests ?? [],
    bounds: session.bounds,
    ...(input.toolApplied ? { toolApplied: input.toolApplied } : {}),
    builtin: {
      project: session.builtinGates,
      stateDir: session.stateDir,
      ...(input.registry ? { registry: input.registry } : {}),
    },
    restricted,
    // What the card tells its gates, as in its run (GT-T1-1).
    ...(input.card.id
      ? {
          card: {
            id: input.card.id,
            change: input.card.change,
            scopeFiles: input.card.scopeFiles,
            gateChecks: input.card.gateChecks,
            research: isResearchLabelled(input.card.labels),
          },
        }
      : {}),
    ...(session.acceptanceTestGate ? { acceptance: { testGate: session.acceptanceTestGate } } : {}),
    ...(input.vision ? { vision: input.vision } : {}),
  });
}

/**
 * What a mechanical tool applied on a card's last run, from its latest
 * evidence bundle (GT-BF-3), so `sekhemet gate <card>` counts those lines as
 * the card run did. Undefined when there is none.
 */
export function lastToolApplied(repoPath: string, cardId: string): ToolAppliedRecord | undefined {
  try {
    const bundle = JSON.parse(
      readFileSync(join(repoPath, ".sekhemet", "evidence", `latest-${cardId}.json`), "utf8"),
    ) as { toolApplied?: { tool?: string; files?: Record<string, number> } };
    const t = bundle.toolApplied;
    return t?.tool && t.files ? { tool: t.tool, files: t.files } : undefined;
  } catch {
    return undefined;
  }
}
