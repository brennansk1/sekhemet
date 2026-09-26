import { join } from "node:path";
import {
  DeterministicGateRunner,
  type GateRunner,
  type GatesConfig,
  type PipelineResult,
  type RegistryLookup,
  RemoteGateRunner,
  readTls,
} from "@sekhemet/gates";
import { verificationSessionOptions, verifyCardTree } from "@sekhemet/loop";
import { confinedSandbox } from "@sekhemet/sandbox";
import { withArchitectureGate } from "./architecture_gate.js";
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
  };
}

export function cardGateRunner(input: CardGateInput): GateRunner {
  const { repoPath, gatesConfig, card } = input;
  // Restricted mode refuses to execute where the OS cannot confine the
  // subprocess, rather than quietly running the gates unsandboxed.
  const sandbox = confinedSandbox(input.restricted);
  // X20, X26: every verification also runs the licence register gate and
  // the commit-trailer contract on the card's branch — and refuses exports
  // the card added that nothing uses and nothing requires, which is how a
  // project decays one reasonable change at a time — and refuses a change
  // that breaks or removes a test main already guarantees, or an invariant
  // the project's brief declares.
  return withArchitectureGate(
    withRegressionGate(
      withReachabilityGate(
        withTrailerGate(
          withLicenseGate(
            // G24: a separate, mutually authenticated gate host when gates.toml
            // names one; this machine's sandbox otherwise.
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
            repoPath,
          ),
        ),
        // What asked for this card's work — its acceptance tests and its own
        // spec — makes an export reachable before the code that calls it exists.
        {
          tests: card.acceptanceTests ?? [],
          text: [card.spec ?? "", ...(card.acceptanceCriteria ?? [])].join("\n"),
        },
      ),
      { ownTests: card.acceptanceTests ?? [] },
    ),
    { briefPath: join(repoPath, ".sekhemet", "brief.md") },
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
  },
): Promise<PipelineResult> {
  const { gatesConfig, restricted } = input;
  // The card run's own verification settings (GT-T1-1): one source.
  const session = verificationSessionOptions(gatesConfig, { repoRoot: input.repoPath, restricted });
  return verifyCardTree({
    root: input.worktree,
    base: input.base,
    rungs: session.gateRungs,
    runner: input.runner ?? cardGateRunner(input),
    staged: input.card.acceptanceTests ?? [],
    bounds: session.bounds,
    builtin: {
      project: session.builtinGates,
      stateDir: session.stateDir,
      ...(input.registry ? { registry: input.registry } : {}),
    },
    restricted,
  });
}
