import { createHash } from "node:crypto";
import { canonicalJson } from "@sekhemet/kernel";
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
  /** Tracked harness files differed from that commit (MD-M4-2). */
  harnessDirty?: boolean;
  /** A hash of the harness's built `dist` directories: what actually ran (MD-M4-2). */
  harnessDistSha?: string;
  /** Where the Worker thought (off | surgical | all): a result is only comparable within one policy. */
  thinking?: string;
  /** The Worker's working method (baseline | strict). */
  workerMethod?: string;
  /** The evidence-gated commit switch (off | on), worker-loop rule 29a. */
  evidenceGate?: string;
  /** The confinement the card ran under (seatbelt | bubblewrap | none), SEC-21. */
  isolation?: string;
  /** The tool arm: the fixed set per class or progressive loading (worker-loop WL-M2-5). */
  toolSet?: string;
  /** The prompt budget W, fixed for the attempt (worker-loop rule 22, WL-M3-5). */
  promptBudgetTokens?: number;
}

/**
 * One step as the evidence records it (worker-loop WL-T3-1, WL-M3-4,
 * WL-M2-5): enough to compute a run's per-arm pass rate, tokens and format
 * errors from the evidence alone.
 */
export interface StepEvidence {
  step: number;
  /** The pass@k sample the step belongs to, from 1. */
  sample: number;
  phase?: string;
  promptTokens: number;
  thinkingTokens?: number;
  answerTokens?: number;
  finishReason?: string;
  /** Tool-call format errors: an attempted call that did not parse, or an unknown tool. */
  formatErrors: number;
  /** 1 when the reply held no tool call and no attempt at one (prose only). */
  proseOnly: number;
  /** The reply was cut off by a cap: which part, and the cap. */
  truncated?: { cut: string; capTokens: number };
  /** Prompt tokens the server served from its cache, and evaluated (models MD-M4-4). */
  cachedPromptTokens?: number;
  evaluatedPromptTokens?: number;
  /** With speculative decoding: tokens drafted and accepted (MD-M4-4). */
  draftTokens?: number;
  draftAcceptedTokens?: number;
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
  /** Touched files that run outside the sandbox later (SEC-32). */
  executesLater?: string[];
  /** Per-step phase, tokens, finish reason and format errors (WL-T3-1, WL-M3-4, WL-M2-5). */
  steps?: StepEvidence[];
  /** Steps each pass@k sample used, in order; each had its own step budget (WL-T3-13). */
  sampleSteps?: number[];
  /** Detail stored with the stop reason: which budget ran out, or which hook vetoed (rule 31a). */
  stopDetail?: Record<string, unknown>;
  /**
   * The card worktree's `<head>:<tree>` when the gates ran: what was
   * reviewed, which Accept compares with the branch it merges (review-git
   * §2.5.1, RG-S5-6).
   */
  repoState?: string;
  /** Extension facts for this card: hooks that failed to load, skills left out or cut (EXT-10, EXT-22a, EXT-25). */
  extensions?: ExtensionEvidence;
  /** The card's own configuration layer, `section.key = value` per line (surface SUR-40). */
  configOverrides?: string[];
}

/** What the card's extensions did not do as written (extensibility EXT-10, EXT-22a, EXT-25). */
export interface ExtensionEvidence {
  /** Each hooks file that failed to load, with its error. */
  hookErrors?: string[];
  /** Skills left out of the prompt because the card lacks a tool they need. */
  skillsOmitted?: { name: string; missingTools: string[] }[];
  /** Skill bodies cut to their `budget_tokens` at a section boundary. */
  skillsTruncated?: {
    name: string;
    budgetTokens: number;
    keptTokens: number;
    originalTokens: number;
  }[];
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
  steps?: StepEvidence[];
  sampleSteps?: number[];
  stopDetail?: Record<string, unknown>;
  repoState?: string;
  extensions?: ExtensionEvidence;
  configOverrides?: string[];
}

/**
 * Deterministic evidence id, so the same record always yields the same
 * reference. It covers the bundle's structural record (SEC-51): card,
 * attempt and diff, each gate's outcome, the stop reason, the files and
 * line counts, the checkpoints, the settings and the `gates.toml` hash — so
 * two bundles with different verdicts never share an id. Excerpts (failure
 * messages, a skipped gate's reason, command lines) are left out: they are
 * the erasable part, and erasing a secret in one leaves the id unchanged.
 */
function evidenceId(params: CompileEvidenceParams): string {
  const structural = {
    cardId: params.cardId,
    attempt: params.attempt,
    diff: params.diff,
    passed: params.gateResult.passed,
    gates: (params.gateResult.rungResults ?? []).map((r) => ({
      gate: r.gate,
      rung: r.rung,
      layer: r.layer,
      passed: r.passed,
      exitCode: r.exitCode,
      skipped: r.skipped === true,
    })),
    stopReason: params.stopReason,
    filesTouched: params.filesTouched,
    linesAdded: params.linesAdded,
    linesRemoved: params.linesRemoved,
    checkpointShas: params.checkpointShas,
    settings: params.settings,
    gatesConfigSha256: params.gatesConfigSha256,
  };
  return `ev_${createHash("sha256").update(canonicalJson(structural)).digest("hex").slice(0, 10)}`;
}

export function compileEvidence(params: CompileEvidenceParams): EvidenceBundle {
  return {
    id: evidenceId(params),
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
    ...(executesLater(params.filesTouched).length
      ? { executesLater: executesLater(params.filesTouched) }
      : {}),
    ...(params.trajectoryRef ? { trajectoryRef: params.trajectoryRef } : {}),
    ...(params.steps ? { steps: params.steps } : {}),
    ...(params.sampleSteps ? { sampleSteps: params.sampleSteps } : {}),
    ...(params.stopDetail ? { stopDetail: params.stopDetail } : {}),
    ...(params.repoState ? { repoState: params.repoState } : {}),
    ...(params.extensions && Object.values(params.extensions).some((v) => v && v.length > 0)
      ? { extensions: params.extensions }
      : {}),
    ...(params.configOverrides?.length ? { configOverrides: params.configOverrides } : {}),
  };
}

/**
 * Files that run outside the sandbox later — on the user's next commit, in
 * their editor, or when a trusted hook or MCP server loads (security item 41,
 * SEC-32). A diff touching one is flagged for the person reviewing it.
 */
const EXECUTES_LATER: readonly RegExp[] = [
  /^\.githooks\//i,
  /^\.husky\//i,
  /^\.pre-commit-config\.ya?ml$/i,
  /(^|\/)\.gitattributes$/i,
  /^\.gitmodules$/i,
  /^\.vscode\//i,
  /^\.idea\//i,
  /^\.devcontainer\//i,
  /(^|\/)\.envrc$/i,
  /^\.github\/workflows\//i,
  /^\.sekhemet\/hooks\.toml$/i,
  /^\.sekhemet\/mcp\.json$/i,
  /^\.sekhemet\/skills\/[^/]+\/scripts\//i,
];

export function executesLater(files: readonly string[]): string[] {
  return files.filter((f) => EXECUTES_LATER.some((p) => p.test(f)));
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
