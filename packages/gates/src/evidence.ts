import { createHash } from "node:crypto";
import type { GateFailure, GateResult, RungOutcome } from "./types.js";

/** Model and sampling settings a result was produced under. */
export interface RunSettings {
  modelId: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  contextTokens?: number;
  toolArm: string;
  harnessCommit?: string;
}

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Everything a human needs to accept or return a card, in one object.
 *
 * The Review column is only as good as this bundle: without the diff, the full
 * per-gate outcomes and the settings the run used, "accept" is a judgement made
 * on a summary rather than on evidence.
 */
export interface EvidenceBundle {
  id: string;
  cardId: string;
  attempt: number;
  createdAt: string;

  /** Unified diff of everything the card changed. */
  diff: string;
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;

  /** Complete per-gate outcomes, including gates that were skipped. */
  rungResults: RungOutcome[];
  failures: GateFailure[];
  passed: boolean;

  turnsUsed: number;
  stopReason: string;
  checkpointShas: string[];
  tokens: TokenTotals;
  durationMs: number;

  /** A number without its settings is not admissible. */
  settings: RunSettings;
  /** Hash of the gates.toml the run was verified against. */
  gatesConfigSha256: string;
  /** Findings that do not fail the card: mutation survivors, unverified dependencies (G13, G15). */
  advisories?: string[];
  /** The transcript of this attempt (G11's trajectory reference). */
  trajectoryRef?: string;
}

export interface CompileEvidenceParams {
  cardId: string;
  attempt: number;
  diff: string;
  filesTouched: string[];
  linesAdded: number;
  linesRemoved: number;
  gateResult: GateResult;
  turnsUsed: number;
  stopReason: string;
  checkpointShas: string[];
  tokens: TokenTotals;
  durationMs: number;
  settings: RunSettings;
  gatesConfigSha256: string;
  advisories?: string[];
  trajectoryRef?: string;
}

/** Deterministic evidence id, so the same run always yields the same reference. */
function evidenceId(cardId: string, attempt: number, diff: string): string {
  return `ev_${createHash("sha256").update(`${cardId}:${attempt}:${diff}`).digest("hex").slice(0, 10)}`;
}

export function compileEvidence(params: CompileEvidenceParams): EvidenceBundle {
  return {
    id: evidenceId(params.cardId, params.attempt, params.diff),
    cardId: params.cardId,
    attempt: params.attempt,
    createdAt: new Date().toISOString(),
    diff: params.diff,
    filesTouched: params.filesTouched,
    linesAdded: params.linesAdded,
    linesRemoved: params.linesRemoved,
    rungResults: params.gateResult.rungResults ?? [],
    failures: params.gateResult.failures,
    passed: params.gateResult.passed,
    turnsUsed: params.turnsUsed,
    stopReason: params.stopReason,
    checkpointShas: params.checkpointShas,
    tokens: params.tokens,
    durationMs: params.durationMs,
    settings: params.settings,
    gatesConfigSha256: params.gatesConfigSha256,
    ...(params.advisories?.length ? { advisories: params.advisories } : {}),
    ...(params.trajectoryRef ? { trajectoryRef: params.trajectoryRef } : {}),
  };
}

/** Render a bundle as the compact summary shown in a terminal or review pane. */
export function summarizeEvidence(bundle: EvidenceBundle): string {
  const gates = bundle.rungResults
    .map((r) => `${r.skipped ? "-" : r.passed ? "PASS" : "FAIL"} ${r.gate}`)
    .join("  ");

  return [
    `Evidence ${bundle.id} — card ${bundle.cardId} attempt ${bundle.attempt}`,
    `Result: ${bundle.passed ? "PASSED" : "FAILED"} (${bundle.stopReason}) in ${bundle.turnsUsed} turns, ${bundle.durationMs}ms`,
    `Diff: ${bundle.filesTouched.length} file(s), +${bundle.linesAdded}/-${bundle.linesRemoved}`,
    `Gates: ${gates || "(none run)"}`,
    `Model: ${bundle.settings.modelId} temp=${bundle.settings.temperature ?? "default"} arm=${bundle.settings.toolArm}`,
    `Tokens: ${bundle.tokens.promptTokens} prompt / ${bundle.tokens.completionTokens} completion`,
    `gates.toml: ${bundle.gatesConfigSha256.slice(0, 12)}`,
  ].join("\n");
}
