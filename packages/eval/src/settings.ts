import { arch, platform } from "node:os";
import type { GateRung } from "@sekhemet/gates";
import type { ToolArm } from "@sekhemet/models";
import { headSha, isGitRepository, isWorkingTreeDirty } from "./git.js";
import type { BenchmarkOptions, BenchmarkSettings, SamplingSettings } from "./types.js";

/** pass@k is defined by the design for k in [2, 4] at T in [0.4, 0.7]. */
export const PASS_AT_K_MIN = 2;
export const PASS_AT_K_MAX = 4;
export const PASS_AT_K_TEMPERATURE_MIN = 0.4;
export const PASS_AT_K_TEMPERATURE_MAX = 0.7;

export const DEFAULT_PASS_AT_K_TEMPERATURE = 0.6;
/** A single sample is drawn near-greedily: variance is not wanted at k = 1. */
export const DEFAULT_SINGLE_SAMPLE_TEMPERATURE = 0.2;
export const DEFAULT_STEP_BUDGET = 50;
export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const DEFAULT_SUITE_VERSION = "sekhemet-eval-v1";
export const DEFAULT_TOOL_ARM: ToolArm = "arm_a_flat";
/** Recorded rather than omitted: an unstated setting is still a setting. */
export const UNDECLARED = "undeclared";

export interface SamplingPlan {
  passAtK: number;
  temperature: number;
}

/**
 * Validate k and T against the sweep the design defines.
 *
 * Out-of-range values throw rather than clamp. Silently sampling at a
 * temperature the caller did not ask for would make the recorded settings a
 * lie, which is the one thing the settings record exists to prevent.
 */
export function resolveSamplingPlan(options: BenchmarkOptions): SamplingPlan {
  const passAtK = options.passAtK ?? 1;

  if (!Number.isInteger(passAtK) || passAtK < 1) {
    throw new RangeError(`passAtK must be a positive integer, received ${String(options.passAtK)}`);
  }

  if (passAtK === 1) {
    return {
      passAtK: 1,
      temperature: options.temperature ?? DEFAULT_SINGLE_SAMPLE_TEMPERATURE,
    };
  }

  if (passAtK < PASS_AT_K_MIN || passAtK > PASS_AT_K_MAX) {
    throw new RangeError(
      `pass@k is defined for k in [${PASS_AT_K_MIN}, ${PASS_AT_K_MAX}], received ${passAtK}`,
    );
  }

  const temperature = options.temperature ?? DEFAULT_PASS_AT_K_TEMPERATURE;
  if (temperature < PASS_AT_K_TEMPERATURE_MIN || temperature > PASS_AT_K_TEMPERATURE_MAX) {
    throw new RangeError(
      `pass@${passAtK} requires a temperature in [${PASS_AT_K_TEMPERATURE_MIN}, ${PASS_AT_K_TEMPERATURE_MAX}], received ${temperature}`,
    );
  }

  return { passAtK, temperature };
}

export interface HarnessRevision {
  sha: string;
  dirty: boolean;
}

/**
 * Identify the harness build a result was produced by.
 *
 * A dirty tree is recorded as such: the sha alone no longer identifies the code
 * that ran, and a reader of the matrix has to know that.
 */
export function resolveHarnessRevision(repoPath: string): HarnessRevision {
  if (!isGitRepository(repoPath)) return { sha: UNDECLARED, dirty: false };
  try {
    return { sha: headSha(repoPath), dirty: isWorkingTreeDirty(repoPath) };
  } catch {
    return { sha: UNDECLARED, dirty: false };
  }
}

export interface SettingsInput {
  modelId: string;
  engine: string;
  toolArm: ToolArm;
  stepBudget: number;
  gateRungs: GateRung[];
  plan: SamplingPlan;
  harnessRepoPath: string;
  options: BenchmarkOptions;
}

/** Assemble the complete, required settings record for a benchmark run. */
export function buildBenchmarkSettings(input: SettingsInput): BenchmarkSettings {
  const revision = resolveHarnessRevision(input.harnessRepoPath);

  const sampling: SamplingSettings = {
    temperature: input.plan.temperature,
    ...(input.options.topP !== undefined ? { topP: input.options.topP } : {}),
    ...(input.options.topK !== undefined ? { topK: input.options.topK } : {}),
    ...(input.options.maxTokens !== undefined ? { maxTokens: input.options.maxTokens } : {}),
  };

  return {
    modelId: input.modelId,
    quant: input.options.quant ?? UNDECLARED,
    engine: input.engine,
    toolArm: input.toolArm,
    sampling,
    contextTokens: input.options.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    stepBudget: input.stepBudget,
    passAtK: input.plan.passAtK,
    gateRungs: [...input.gateRungs],
    suiteVersion: input.options.suiteVersion ?? DEFAULT_SUITE_VERSION,
    harnessCommitSha: revision.sha,
    harnessDirty: revision.dirty,
    hostPlatform: `${platform()}-${arch()}`,
    ...(input.options.hardwareTier !== undefined
      ? { hardwareTier: input.options.hardwareTier }
      : {}),
    timestamp: new Date().toISOString(),
  };
}
