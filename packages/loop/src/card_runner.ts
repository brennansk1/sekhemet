import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TurnHistoryItem } from "@sekhemet/context";
import { PrefixStabilityGuard } from "@sekhemet/context";
import type {
  GateDefinition,
  GateFailure,
  GateResult,
  GateRung,
  GateRunner,
} from "@sekhemet/gates";
import {
  DEFAULT_GATES,
  type EvidenceBundle,
  type GatesConfig,
  type RedFirstStatus,
  type RedFirstVerdict,
  type RunSettings,
  type StagedTestRecord,
  type StepEvidence,
  type TestOrigin,
  type TestStrengthRecord,
  buildRepairRedCheck,
  checkTestStrength,
  closeQuarantine,
  compileEvidence,
  judgeRedFirst,
  loadGatesConfig,
  onlyNotRun,
  passingTests,
  quarantinedTests,
  setQuarantinePolicy,
  testOrigins,
  upgradeTestList,
  verificationRungs,
} from "@sekhemet/gates";
import {
  type AgentRole,
  BlobStore,
  type BudgetDetail,
  type CardDossier,
  type CardRecord,
  type CardStatus,
  type CardStore,
  type CheckpointRecord,
  type GateStatus,
  STOP_REASONS,
  canonicalPayloadHash,
  cardClassOf,
  cardKind,
  defaultSecondsBudget,
  serializeContextPack,
} from "@sekhemet/kernel";
import { type ToolArm, candidateSettings, harnessProvenance } from "@sekhemet/models";
import {
  EgressProxy,
  ProcessSandbox,
  allowlistWarnings,
  cardAllowlist,
  generatorAllowlist,
  matchesGlob,
  mergeNetworkConfigs,
  tagUntrusted,
} from "@sekhemet/sandbox";
import { type GitSyncAdapter, type RebaseResult, resolvedPath } from "@sekhemet/sync";
import { CardExecutionSessionImpl } from "./session.js";
import type {
  ExecutionStopReason,
  ParkDiagnosis,
  PromptRecord,
  ReplanRequest,
  SessionOptions,
  TurnResult,
} from "./types.js";

/** The attempt row's letter for a tool arm (kernel `attempts.tool_arm`). */
const ARM_LETTER: Record<ToolArm, "A" | "B" | "C"> = {
  arm_a_flat: "A",
  arm_b_json: "B",
  arm_c_sketch: "C",
};

/** Board operations the runner needs, kept as an interface to avoid a cycle. */
export interface CardLifecycle {
  /**
   * Move the card. May throw when the board refuses the move (back-pressure,
   * a WIP limit): the runner catches that and holds the card instead.
   */
  transition(cardId: string, to: CardStatus, reason?: string): Promise<void>;
  recordSteps?(cardId: string, stepsUsed: number): Promise<void>;
  /**
   * Hold the card where it stands with a reason, awaiting `awaiting` (the
   * board's typed `holdCard`, kernel rule 24). Without it the runner writes
   * `blockedReason` through `store`.
   */
  hold?(cardId: string, reason: string, awaiting: CardStatus): Promise<void>;
  /**
   * Asked once a card passes, with its attempt closed and its evidence
   * recorded, before it moves to Review (review-git RG-P8-1): a reason means
   * the card waits in Verify for the AI review, which moves it on, and the
   * reason is its `blockedReason`; undefined moves it to Review now.
   */
  awaitReview?(cardId: string): Promise<string | undefined>;
}

/**
 * The card-store operations the runner persists through (defects 2 and 8,
 * K28, integration review item 6). `CardStore` satisfies it.
 */
export type CardRunStore = Pick<
  CardStore,
  | "recordCheckpoint"
  | "getCheckpoints"
  | "updateCard"
  | "recordEvent"
  | "recordDossierEntry"
  | "getDossier"
> &
  Partial<Pick<CardStore, "runs" | "cardEvents" | "depthProfiles">>;

/**
 * Whether a card's text is untrusted by its origin, not its link (S9; B4.9
 * part 2, M3): `import` once an import created or changed it (the ledger's
 * `card/imported`), whatever its `externalRef` says now.
 */
export async function untrustedOriginOf(
  store: Partial<Pick<CardStore, "cardEvents">>,
  cardId: string,
): Promise<"import" | undefined> {
  if (!store.cardEvents) return undefined;
  try {
    return (await store.cardEvents(cardId, ["card/imported"])).length > 0 ? "import" : undefined;
  } catch {
    // Unreadable: the strict reading, never the lax one.
    return "import";
  }
}

/** Difficulty 1..10 as the design's XS..XL scale (K25). */
export function difficultyLabel(difficulty: number | undefined): string {
  if (difficulty === undefined) return "unknown";
  if (difficulty <= 2) return "XS";
  if (difficulty <= 4) return "S";
  if (difficulty <= 6) return "M";
  if (difficulty <= 8) return "L";
  return "XL";
}

/** Emitted as the run progresses, so the CLI and dashboard can follow along. */
export interface RunProgressEvent {
  type: "turn" | "checkpoint" | "gate" | "status";
  cardId: string;
  message: string;
  turn?: number;
}

/** What the fail-to-pass check found before any work (G12). */
export interface FailToPassReport {
  /**
   * By the red/green rule of the card's `change` (gates rule 6b, GT-N8-2):
   * `fails`: red on the base, as a feature or fix card's must be.
   * `green`: green on the base, a characterize, refactor or upgrade card's proof.
   * `vacuous`: green where red was required, so the tests cannot measure this card.
   * `refused`: red where green was required, or a build that already succeeds.
   * `unknown`: the gates could not run; the card proceeds.
   */
  status: RedFirstStatus;
  tests: string[];
  detail: string;
  /** The stop a refusal ends the card with (rule 6b). */
  stopReason?: RedFirstVerdict["stopReason"];
  /** The acceptance tests' strength, judged before any work (rules 6, 6a, 32a; NEW-gates-6). */
  testStrength?: TestStrengthRecord;
}

/**
 * Whether a card's scope covers a file (GT-N2-2): an empty scope covers the
 * whole repository, as does a root directory (`.`, `./`); otherwise an entry
 * names the file, or is a glob or a directory that holds it.
 */
function scopeCovers(scope: readonly string[], file: string): boolean {
  if (scope.length === 0) return true;
  return scope.some((raw) => {
    const entry = raw.trim().replace(/^\.\//, "");
    if (entry === "" || entry === "." || entry === "/") return true;
    if (entry.endsWith("/")) return file.startsWith(entry);
    return entry === file || matchesGlob(file, entry);
  });
}

/**
 * The project's test gate, as the strength checks run it: its first blocking
 * test gate, else the default. Undefined with `[gate_host]`: the tests run on
 * the gate host, not here.
 */
export function projectTestGate(config: GatesConfig): GateDefinition | undefined {
  if (config.project.gateHost) return undefined;
  return (
    config.gates.find((g) => g.rung === "test" && g.blocking) ??
    DEFAULT_GATES.find((g) => g.rung === "test")
  );
}

/**
 * The verification settings a card's session is built with, from the
 * project's gates.toml: the rungs, autofix and style fixes, protection, size
 * limits, built-in layers and state directory. One function for the card run
 * and every check that must verify as it does (GT-T1-1), so the two cannot
 * drift apart.
 */
export function verificationSessionOptions(
  config: GatesConfig,
  options: {
    repoRoot: string;
    restricted: boolean;
    /** The card's scope: a changelog entry is demanded only when it holds CHANGELOG.md (GT-N2-2). */
    scope?: readonly string[] | undefined;
  },
): Pick<SessionOptions, "autofixCommand" | "styleFixCommands" | "protectedGlobs"> & {
  gateRungs: GateRung[];
  bounds: { maxFiles: number; maxLines: number; maxToolAppliedLines: number };
  builtinGates: GatesConfig["project"];
  stateDir: string;
  acceptanceTestGate?: GateDefinition;
} {
  const testGate = projectTestGate(config);
  return {
    // The acceptance tests alone and an upgrade's kept tests run through the
    // project's test gate on this machine (GT-TQ-3, GT-TQ-11); with a gate
    // host they are not run here, and the evidence says why.
    ...(testGate ? { acceptanceTestGate: testGate } : {}),
    // Verify against every blocking gate the project declares (lint included,
    // as the spec requires). Under --restricted only the static layer runs:
    // executing the repo's tests would execute its code (S12).
    gateRungs: verificationRungs(config.gates, options.restricted),
    ...(config.project.autofix ? { autofixCommand: config.project.autofix } : {}),
    // One style-fix process with every selected rule (gates rule 34b,
    // GT-N3-5), not one process per rule.
    ...(config.project.styleFix && (config.project.styleFixRules?.length ?? 0) > 0
      ? {
          styleFixCommands: [
            [
              ...config.project.styleFix,
              ...(config.project.styleFixRules ?? []).map((rule) => `--only=${rule}`),
            ],
          ],
        }
      : {}),
    // The project's declared protection and size limits (defect 5, G10).
    protectedGlobs: config.project.protected,
    bounds: {
      maxFiles: config.project.maxFiles,
      maxLines: config.project.maxDiffLines,
      // GT-BF-5: tool-applied lines under their own bound, the value in force.
      maxToolAppliedLines: config.project.maxToolAppliedLines,
    },
    // The built-in security, hygiene and robustness layers (G3). A card
    // whose scope does not hold CHANGELOG.md is told about a missing entry,
    // never failed for an edit it may not make (gates rule 17, GT-N2-2).
    builtinGates:
      options.scope &&
      !scopeCovers(options.scope, "CHANGELOG.md") &&
      config.project.changelog !== false
        ? { ...config.project, changelog: "advisory" }
        : config.project,
    stateDir: join(options.repoRoot, ".sekhemet"),
  };
}

export interface CardRunOptions extends Omit<SessionOptions, "cardId"> {
  card: CardRecord;
  /**
   * A build-repair card's declared build command (gates rule 6b, DEC-43): its
   * red check is this command failing on the base, run confined with no
   * network, instead of tests that cannot run on a base that does not build.
   */
  buildRepair?: { command: string; args: string[]; timeoutMs?: number } | undefined;
  /**
   * Who wrote the card's acceptance tests, named explicitly for every staged
   * file (the frozen suite passes `external`, so its measurement never
   * changes). Unset, each file's origin is its own (`testOrigins`, lead
   * ruling): `card` — a Planner, test-author or PM carry-over `test/staged`
   * record matches its SHA-256, or the card's own diff wrote it — whose
   * tests red-at-an-assertion and stub-kill may stop; `external` otherwise —
   * the frozen suite's, a person's or a repository's tests, which need only
   * fail on the base.
   */
  acceptanceTestsOrigin?: "card" | "external" | undefined;
  /** Hooks files that failed to load, each with its error, for the evidence (EXT-10). */
  hookErrors?: string[] | undefined;
  /** The card's configuration layer as `section.key = value` lines, for the evidence (SUR-40). */
  configOverrides?: string[] | undefined;
  repoRoot: string;
  syncAdapter: GitSyncAdapter;
  lifecycle?: CardLifecycle | undefined;
  baseBranch?: string | undefined;
  /** Agent attribution written into checkpoint commit trailers. */
  agentModel?: string | undefined;
  agentHarness?: string | undefined;
  coAuthors?: string[] | undefined;
  onProgress?: ((event: RunProgressEvent) => void) | undefined;
  /**
   * Called once per completed turn with the full turn, so a caller can record
   * it (the harness appends a `card/step` ledger event the dashboard follows
   * live). Awaited; a throw is swallowed so recording can never fail a card.
   */
  onTurn?: ((cardId: string, turn: TurnResult) => Promise<void> | void) | undefined;
  /**
   * Prepare the worktree after checkout, before the first turn.
   *
   * Contract-first projects use this to stage the card's own acceptance tests:
   * a gate must measure the card it is gating, so suites belonging to later
   * cards must not be present to fail it.
   */
  onWorktreeReady?: ((worktreePath: string) => Promise<void> | void) | undefined;
  /** Skip worktree creation when the caller has already prepared one. */
  useExistingWorktree?: boolean | undefined;

  /**
   * Which attempt at this card this run is (1 for the first). Stamped into
   * the evidence and its id, so retries never overwrite or pose as first
   * attempts (integration review item 9).
   */
  attempt?: number | undefined;
  /**
   * Where checkpoints, actuals, holds, parks and the dossier are persisted.
   * The harness passes its `CardStore`.
   */
  store?: CardRunStore | undefined;
  /** Commit a checkpoint every N steps when files changed (default 5; 0 disables). */
  checkpointEvery?: number | undefined;
  /** Token budget for this run; defaults to `card.tokenBudget` (L22). */
  tokenBudget?: number | undefined;
  /** Wall-clock budget in seconds; defaults to `card.secondsBudget` (L22). */
  secondsBudget?: number | undefined;
  /** Clock, injectable for tests. */
  now?: (() => number) | undefined;
  /**
   * Run the staged acceptance tests before any work and refuse to start the
   * card when they already pass (G12). Default on for a fresh start.
   */
  verifyFailToPass?: boolean | undefined;
  /**
   * Resume a card that stopped on memory pressure from its last checkpoint
   * (H17). Default on when `store` is given.
   */
  resume?: boolean | undefined;
  /** Stops the card with `human_abort` before its next turn (L25). */
  signal?: AbortSignal | undefined;
  /**
   * pass@k with gate selection (G25): draw up to this many independent
   * samples from the same starting tree, taking the first that passes.
   * Default 1.
   */
  samples?: number | undefined;
  /** Temperatures for samples 2..k, cycled (design: 0.4-0.7). */
  sampleTemperatures?: number[] | undefined;
  /**
   * Cross-validate attempts (G26): keep sampling to a second passing
   * implementation and run each against the other's tests; disagreement
   * sends the card back to the planner.
   */
  crossValidate?: boolean | undefined;
  /** This run is a fork of an earlier attempt at a step (H18). */
  forkedFrom?: { attemptId: string; step: number } | undefined;
  /**
   * Start from this checkpoint instead of the card's start (H18 fork, H19
   * rewind): the worktree is reset to `gitRef`, the step counter continues
   * from `step`, and the earlier steps are replayed from the log into the
   * Worker's history.
   */
  startFrom?: { step: number; gitRef: string; attemptId?: string } | undefined;
}

export interface CardRunResult {
  cardId: string;
  passed: boolean;
  stopReason: ExecutionStopReason;
  turns: TurnResult[];
  evidence: EvidenceBundle;
  checkpointShas: string[];
  worktreePath: string;
  finalStatus: CardStatus;
  /** What the Worker learned (working memory lines and fixed-after-struggle failures). */
  lessons: { lines: string[]; struggles: { text: string; edits: number }[] };
  /** Playbook rule ids that were in the prompt. */
  rulesUsed: string[];
  attempt: number;
  /** Tokens and seconds this run spent. */
  tokensUsed: number;
  secondsUsed: number;
  /** Set when the board refused a move and the card was held with a reason (defect 1). */
  held?: { reason: string; wanted: CardStatus };
  /** Set when the card was parked (repair rung 4, or vacuous tests). */
  parked?: ParkDiagnosis;
  /** Set when the card stopped at repair rung 3 for a new plan (L15). */
  replan?: ReplanRequest;
  /** The fail-to-pass check at card start (G12), when it ran. */
  failToPass?: FailToPassReport;
  /** The checkpoint this run resumed from (H17). */
  resumedFrom?: { step: number; gitRef: string };
  /** Tokens output condensing removed from what the Worker saw (runtime RUN-47). */
  condensedTokensSaved?: number;
}

/** A rebase conflict as the git adapter reports it (Y6, RG-N1). */
type RebaseConflict = Extract<RebaseResult, { ok: false }>["failure"];

/** Checkpoint statuses by why the checkpoint was taken. */
const AGENT_ROLES: readonly AgentRole[] = [
  "lead-driver",
  "delegator",
  "implementer",
  "architect",
  "test-author",
  "relay-finisher",
];

/** Test files, for cross-validation (G26). */
const TEST_FILE =
  /(^|\/)(tests?|__tests__)\/|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(py|go)$|^test_.*\.py$/;

/**
 * Stop classification — resumable, checkpointed, parking, verifiable, halted —
 * is read from the one stop-reason table, `STOP_REASONS` in the kernel
 * (worker-loop rule 31, WL-T3-2). A breaker that stops a card at its cap and
 * then lets it continue into Verify is not a breaker, so budget stops park
 * unless the gates ran (L22).
 */

/** Longest dossier line shown to the Worker. */
const DOSSIER_LINE_CHARS = 400;
/** Dossier lines shown to the Worker at most (newest kept). */
const DOSSIER_MAX_LINES = 12;

/** Render the dossier as prompt lines, the directives that matter most first. */
/**
 * Which AI review entries a retry reads (review-git RG-P8-9): the model's own
 * `unmet` and `unclear` findings that cite a checked `(file:line)`. The
 * `met` findings, the coverage line, a `not_reviewed` reason, a skipped
 * criterion's uncited entry and the fail-only `no test:` check (the
 * acceptance tests are protected: the Agent cannot act on it) stay on the
 * card for Review and Seshat, not in the Coding model's context. An older
 * review's entry (another verdict) is kept as it always was.
 */
function reviewForRetry(e: { verdict?: string | undefined; text: string }): boolean {
  if (e.verdict === "unmet" || e.verdict === "unclear")
    return /\((?:[\w@.-]+\/)*[\w@.-]+:\d+\)\s*$/.test(e.text) && !/^no test:/i.test(e.text.trim());
  return e.verdict !== "met" && e.verdict !== "coverage" && e.verdict !== "not_reviewed";
}

export function dossierPromptLines(dossier: CardDossier): string[] {
  const clip = (t: string) =>
    t.length > DOSSIER_LINE_CHARS ? `${t.slice(0, DOSSIER_LINE_CHARS)}…` : t;
  const lines: { seq: number; text: string }[] = [];
  for (const e of dossier.sendBacks)
    lines.push({ seq: e.seq, text: `Sent back by the reviewer: ${clip(e.text)}` });
  for (const e of dossier.reviews) {
    if (!reviewForRetry(e)) continue;
    lines.push({
      seq: e.seq,
      text: `Review finding${e.verdict ? ` (${e.verdict})` : ""}: ${clip(e.text)}`,
    });
  }
  for (const t of dossier.questions) {
    for (const a of t.answers)
      lines.push({
        seq: a.seq,
        text: `Q: ${clip(t.question.text)} A (${a.actor}): ${clip(a.text)}`,
      });
  }
  for (const e of dossier.unthreadedAnswers)
    lines.push({ seq: e.seq, text: `Answer (${e.actor}): ${clip(e.text)}` });
  for (const e of dossier.research)
    lines.push({
      seq: e.seq,
      // Research carries web text: tagged as untrusted (S9).
      text: `Research: ${tagUntrusted(clip(e.text), e.sources?.[0] ?? "research")}`,
    });
  for (const e of dossier.notes)
    lines.push({ seq: e.seq, text: `Note from attempt ${e.attempt ?? "?"}: ${clip(e.text)}` });
  for (const e of dossier.lessons) lines.push({ seq: e.seq, text: `Lesson: ${clip(e.text)}` });
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const l of lines.sort((a, b) => a.seq - b.seq)) {
    if (seen.has(l.text)) continue;
    seen.add(l.text);
    unique.push(l.text);
  }
  return unique.slice(-DOSSIER_MAX_LINES);
}

/**
 * M3: a person's reply in the card's thread to a Worker question: the newest
 * entry a person (`human`) wrote in reply to the question, or after it.
 */
async function personReply(
  store: Pick<CardStore, "getDossier">,
  cardId: string,
  questionEntryId: string | undefined,
): Promise<string | undefined> {
  const dossier = await store.getDossier(cardId).catch(() => undefined);
  if (!dossier) return undefined;
  const asked = dossier.entries.find((e) => e.entryId === questionEntryId)?.seq;
  const replies = dossier.entries.filter(
    (e) =>
      e.actor === "human" &&
      (e.kind === "answer" || e.kind === "note") &&
      ((questionEntryId !== undefined && e.inReplyTo === questionEntryId) ||
        (asked !== undefined && e.seq > asked)),
  );
  return replies.at(-1)?.text;
}

/** True for a board refusal the runner should absorb by holding the card. */
function refusalReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? `${code}: ${message}` : message;
}

/**
 * Drives one card end to end: worktree, turn loop, checkpoints, gates, evidence.
 *
 * This is the piece that was missing entirely — `sekhemet run` previously
 * executed a single turn and exited, so no amount of loop-internal correctness
 * could produce a finished card.
 */
/** A git-metadata refusal from the worktree preflight (SEC-2, SEC-3, SEC-6a). */
function isTampered(err: unknown): boolean {
  return (err as { reason?: string } | undefined)?.reason === "git_metadata_tampered";
}

/** The server-reported cache and draft counts of a step (models MD-M4-4). */
const stepUsage = (u: TurnResult["usage"]) => ({
  ...(u?.cachedPromptTokens !== undefined ? { cachedPromptTokens: u.cachedPromptTokens } : {}),
  ...(u?.evaluatedPromptTokens !== undefined
    ? { evaluatedPromptTokens: u.evaluatedPromptTokens }
    : {}),
  ...(u?.draftTokens !== undefined ? { draftTokens: u.draftTokens } : {}),
  ...(u?.draftAcceptedTokens !== undefined ? { draftAcceptedTokens: u.draftAcceptedTokens } : {}),
});

export class CardRunner {
  /** Set when the worktree preflight refused git: the card stops (SEC-2). */
  private tampered: string | undefined;
  private config: GatesConfig;
  private session: CardExecutionSessionImpl | undefined;
  private pendingAbort: string | undefined;
  /** The attempt row this run writes to (K16), when a store with `runs` is attached. */
  private attemptId: string | undefined;
  /** Step number -> step row id, so a checkpoint can be pinned to its step. */
  private stepIds = new Map<number, string>();
  private packIds: string[] = [];
  private transcriptPath: string | undefined;
  private egress: EgressProxy | undefined;
  /** Card zero's generator proxy (DS-P2-1, -2): its registry's hosts, for its declared steps only. */
  private generatorEgress: EgressProxy | undefined;
  private generatorPort: number | undefined;
  private rebaseFailure: string | undefined;
  /** WL-N10-1: messages that arrived before the session existed. */
  private pendingMessages: { text: string; from?: string }[] = [];
  /** WL-N10-2: a pause that arrived before the session existed. */
  private pendingPause: string | undefined;
  /** The step this run resumed from (0 for a fresh one), for `nextStep`. */
  private startStep = 0;
  /** RG-N1-2, RG-N1-3: a conflict that parks the card, and why. */
  private rebaseConflict: { conflict: RebaseConflict; route: "parked" | "unresolved" } | undefined;
  private crossValidation: string | undefined;
  private samplesTried = 1;

  private headOf(worktreePath: string): string | undefined {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf8",
      }).trim();
    } catch {
      return undefined;
    }
  }

  /**
   * G26: each passing implementation against the other's tests. Returns a
   * sentence naming the disagreement, or undefined when both hold.
   */
  private async crossValidate(
    worktreePath: string,
    a: string | undefined,
    b: string | undefined,
  ): Promise<string | undefined> {
    if (!a || !b) return undefined;
    const base = this.options.baseBranch ?? "main";
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    const testsOf = (sha: string) =>
      git("diff", "--name-only", `${base}...${sha}`)
        .split("\n")
        .filter((f) => f && TEST_FILE.test(f));
    const run = async (impl: string, testsFrom: string): Promise<string | undefined> => {
      const tests = testsOf(testsFrom);
      if (tests.length === 0) return undefined;
      this.restore(worktreePath, impl);
      for (const f of tests) {
        try {
          const content = git("show", `${testsFrom}:${f}`);
          mkdirSync(join(worktreePath, f, ".."), { recursive: true });
          writeFileSync(join(worktreePath, f), content);
        } catch {
          // Deleted on that side.
        }
      }
      const result = await this.options.gateRunner
        .runGates(["test"], worktreePath)
        .catch(() => undefined);
      try {
        git("checkout", "--", ".");
        git("clean", "-fdq");
      } catch {
        // Restored below regardless.
      }
      return result && !result.passed
        ? `the implementation of ${impl.slice(0, 8)} fails the tests of ${testsFrom.slice(0, 8)} (${result.failures[0]?.errorExcerpt.split("\n")[0] ?? "failing"})`
        : undefined;
    };
    const verdict = (await run(a, b)) ?? (await run(b, a));
    this.restore(worktreePath, a);
    return verdict;
  }
  /** One per runner: the system prompt must not drift within the card (C4). */
  private prefixGuard = new PrefixStabilityGuard();

  /** Y6 through the git adapter, when it supports it; the card's scope decides a conflict's route (RG-N1). */
  private async rebaseOntoIntegration(): Promise<RebaseResult | undefined> {
    const adapter = this.options.syncAdapter as GitSyncAdapter & {
      rebaseOntoIntegration?: (
        cardId: string,
        target?: string,
        scopeFiles?: string[],
      ) => Promise<RebaseResult>;
    };
    if (typeof adapter.rebaseOntoIntegration !== "function") return undefined;
    try {
      return await adapter.rebaseOntoIntegration(
        this.options.card.id,
        this.options.baseBranch ?? "main",
        this.options.scopeFiles ?? this.options.card.scopeFiles ?? [],
      );
    } catch {
      return undefined;
    }
  }

  /** RG-N1-1: leave an in-scope conflict in the worktree for the Worker, when the adapter can. */
  private stageRebaseConflict(): { preservedRef: string; files: string[] } | undefined {
    const adapter = this.options.syncAdapter as GitSyncAdapter & {
      stageRebaseConflict?: (
        cardId: string,
        target?: string,
      ) => { preservedRef: string; files: string[] };
    };
    if (typeof adapter.stageRebaseConflict !== "function") return undefined;
    try {
      return adapter.stageRebaseConflict(this.options.card.id, this.options.baseBranch ?? "main");
    } catch {
      return undefined;
    }
  }

  /** The files among `files` that still hold conflict markers. */
  private conflictMarked(worktreePath: string, files: string[]): string[] {
    return files.filter((f) => {
      const p = join(worktreePath, f);
      if (!existsSync(p)) return false;
      try {
        return /^(<{7}|>{7})( |$)/m.test(readFileSync(p, "utf8"));
      } catch {
        return false;
      }
    });
  }

  /** The conflict on the ledger, with its files and route (RG-N1). */
  private async recordRebaseConflict(
    conflict: RebaseConflict,
    staged: { preservedRef: string } | undefined,
  ): Promise<void> {
    const { card, store } = this.options;
    this.emit({ type: "status", cardId: card.id, message: `rebase conflict: ${conflict.message}` });
    await store
      ?.recordEvent({
        type: "card/rebase_conflict",
        cardId: card.id,
        actor: "executor",
        payload: {
          id: card.id,
          onto: conflict.onto,
          files: conflict.files,
          outOfScope: conflict.outOfScope,
          otherCards: conflict.otherCards ?? [],
          returnedToWorker: staged !== undefined,
          ...(staged ? { preservedRef: staged.preservedRef } : {}),
        },
      })
      .catch(() => undefined);
  }

  /**
   * RG-N1-3: the Worker's budget ended with the conflict unresolved — one
   * decision request naming both cards (never a side picked by the harness).
   */
  private async requestRebaseDecision(conflict: RebaseConflict): Promise<string | undefined> {
    const { card, store } = this.options;
    const runs = store?.runs;
    if (!runs) return undefined;
    const others = conflict.otherCards?.length ? conflict.otherCards : [];
    const against = others.length
      ? others.join(", ")
      : `the changes on ${conflict.onto} since this card started`;
    try {
      const open = runs
        .listDecisions("pending")
        .find((d) => d.cardId === card.id && d.kind === "rebase_conflict");
      if (open) return open.id;
      const d = await runs.requestDecision({
        cardId: card.id,
        kind: "rebase_conflict",
        question: `${card.id} and ${against} conflict in ${conflict.files.join(", ")}, and the Worker could not resolve it within its budget. Which change should give way?`,
        context: `${conflict.message}\n\n${conflict.excerpt}`.slice(0, 4000),
        options: [
          `Re-plan ${card.id} on top of ${conflict.onto}`,
          `Resolve the conflict by hand in ${card.id}'s worktree`,
          `Reject ${card.id}`,
        ],
        recommendationIndex: 0,
      });
      return d.id;
    } catch {
      return undefined;
    }
  }

  private egressPort: number | undefined;

  constructor(private options: CardRunOptions) {
    // SEC-19: under --restricted no hook or language server starts.
    if (options.restricted) this.options = { ...options, hooks: undefined, lspPool: undefined };
    // Pin the gate configuration at card start. Every later verification
    // re-checks this hash, so an agent cannot rewrite its own gates mid-card.
    this.config = loadGatesConfig(options.repoRoot);
  }

  public get gatesConfigSha256(): string {
    return this.config.sha256;
  }

  /**
   * A person's message for the Worker's next step (WL-N10-1). Before the
   * session exists it waits and reaches the first step.
   */
  public deliverMessage(text: string, from?: string): void {
    if (this.session) this.session.deliverMessage(text, from);
    else this.pendingMessages.push({ text, ...(from ? { from } : {}) });
  }

  /** The step the next prompt belongs to: where a delivered message lands (WL-N10-1). */
  public nextStep(): number {
    return (this.session?.getStepsUsed() ?? this.startStep) + 1;
  }

  /** WL-N10-2: stop at the next step boundary with the resumable `paused`. */
  public pause(by: string): void {
    this.pendingPause = by;
    this.session?.pause(by);
  }

  /** Stop the card before its next turn with `human_abort` (L25). */
  public async abort(reason: string): Promise<void> {
    this.pendingAbort = reason || "stopped by a person";
    await this.session?.abort(this.pendingAbort);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Persist the evidence bundle where the Review surface can find it.
   *
   * The bundle is what a human accepts or returns a card on. Building it and
   * then discarding it left the Review column with nothing behind it.
   */
  private writeEvidence(evidence: EvidenceBundle): { path: string; sha256: string } | undefined {
    try {
      const dir = join(this.options.repoRoot, ".sekhemet", "evidence");
      mkdirSync(dir, { recursive: true });
      const body = `${JSON.stringify(evidence, null, 2)}\n`;
      writeFileSync(join(dir, `${evidence.id}.json`), body, "utf8");
      // Stable per-card pointer to the latest attempt.
      writeFileSync(join(dir, `latest-${evidence.cardId}.json`), body, "utf8");
      return {
        path: join(".sekhemet", "evidence", `${evidence.id}.json`),
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    } catch {
      // Evidence loss must never fail a card.
      return undefined;
    }
  }

  /**
   * Persist every model reply and tool call for this attempt.
   *
   * "Model-visible means logged" (design K11): when a card stalls, the only
   * way to know whether the model reasoned badly, emitted an unparseable call,
   * or said nothing is to read what it actually produced.
   */
  private writeTranscript(cardId: string, turns: TurnResult[]): void {
    try {
      const dir = join(this.options.repoRoot, ".sekhemet", "transcripts");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const lines = turns.map((t) =>
        JSON.stringify({
          turn: t.turnIndex,
          rawText: t.rawText ?? "",
          toolCalls: t.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
          observations: t.observations.map((o) => ({ tool: o.tool, ok: o.ok, summary: o.summary })),
          gate: t.gateResult
            ? {
                passed: t.gateResult.passed,
                failures: t.gateResult.failures.map((f) => f.errorExcerpt),
              }
            : undefined,
          stopReason: t.stopReason,
          usage: t.usage,
          ...(t.contextPackId ? { contextPackId: t.contextPackId } : {}),
          ...(t.stepId ? { stepId: t.stepId } : {}),
        }),
      );
      const path = join(dir, `${cardId}-${stamp}.jsonl`);
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
      this.transcriptPath = path;
    } catch {
      // Transcript loss must never fail a card.
    }
  }

  /**
   * Store the exact prompt a request carries as a content-addressed context
   * pack (K11, K26). Throws when it cannot be stored, which stops the
   * request: nothing reaches a model that the log cannot reconstruct.
   */
  private logPrompt(record: PromptRecord): string {
    const blobs = new BlobStore(this.options.repoRoot);
    // The exact definitions sent, stored once per distinct set (kernel rule 17).
    const toolSchemas = record.toolDefinitions
      ? blobs.put(JSON.stringify(record.toolDefinitions))
      : undefined;
    const pack = serializeContextPack({
      cardId: this.options.card.id,
      ...(this.attemptId ? { attemptId: this.attemptId } : {}),
      step: record.step,
      modelId: this.options.modelAdapter.modelId,
      systemPrompt: record.systemPrompt,
      prompt: record.prompt,
      tools: record.tools,
      ...(record.reasoning ? { reasoning: record.reasoning } : {}),
      ...(toolSchemas ? { toolSchemas } : {}),
      ...(record.toolArm ? { toolArm: record.toolArm } : {}),
      thinking: this.options.thinking ?? "off",
      ...(record.reasoningBudgetTokens !== undefined
        ? { reasoningBudgetTokens: record.reasoningBudgetTokens }
        : {}),
      ...(record.maxTokens !== undefined ? { maxTokens: record.maxTokens } : {}),
      ...(record.temperature !== undefined ? { temperature: record.temperature } : {}),
      ...(record.purpose ? { purpose: record.purpose } : {}),
    });
    return blobs.put(pack);
  }

  /** The turn as a step row with its gate results (K17, K18); ids go back on the turn (K4). */
  private async recordStep(turn: TurnResult): Promise<void> {
    const runs = this.options.store?.runs;
    if (!runs || !this.attemptId) return;
    try {
      const step = await runs.recordStep({
        attemptId: this.attemptId,
        cardId: this.options.card.id,
        stepIndex: turn.turnIndex,
        calls: turn.toolCalls.map((c, i) => {
          const obs = turn.observations[i];
          const a = (c.arguments ?? {}) as Record<string, unknown>;
          const target = a.path ?? a.command ?? a.query ?? a.symbol;
          return {
            name: c.name,
            argumentHash: canonicalPayloadHash(c.arguments ?? {}),
            ...(typeof target === "string" ? { target: target.slice(0, 160) } : {}),
            ...(obs ? { ok: obs.ok, summary: String(obs.summary ?? "").slice(0, 200) } : {}),
          };
        }),
        ...(turn.contextPackId ? { contextPackId: turn.contextPackId } : {}),
        promptTokens: turn.usage?.promptTokens ?? 0,
        completionTokens: turn.usage?.completionTokens ?? 0,
        durationMs: turn.durationMs ?? 0,
        ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
        // WL-M3-4, WL-T3-1, WL-M2-5, WL-T3-13: the step's own facts.
        ...(turn.sample !== undefined ? { sample: turn.sample } : {}),
        ...(turn.phase ? { phase: turn.phase } : {}),
        ...(turn.finishReason ? { finishReason: turn.finishReason } : {}),
        ...(turn.usage?.thinkingTokens !== undefined
          ? { thinkingTokens: turn.usage.thinkingTokens }
          : {}),
        ...(turn.usage?.answerTokens !== undefined
          ? { answerTokens: turn.usage.answerTokens }
          : {}),
        ...(turn.formatErrors !== undefined ? { formatErrors: turn.formatErrors } : {}),
        ...(turn.proseOnly !== undefined ? { proseOnly: turn.proseOnly } : {}),
        // MD-M4-4: the server's cache and draft accounting for the step.
        ...stepUsage(turn.usage),
      });
      turn.attemptId = this.attemptId;
      turn.stepId = step.id;
      this.stepIds.set(turn.turnIndex, step.id);
      for (const r of turn.gateResult?.rungResults ?? []) {
        await runs.recordGateResult({
          attemptId: this.attemptId,
          cardId: this.options.card.id,
          stepId: step.id,
          gate: r.gate,
          layer: r.layer,
          passed: r.passed,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          failures: (turn.gateResult?.failures ?? []).filter((f) => (f.gate ?? f.rung) === r.gate),
          // K-N8-3: the Worker's gates run here, on this machine.
          source: "local",
        });
      }
    } catch (err) {
      this.emit({
        type: "status",
        cardId: this.options.card.id,
        message: `step ${turn.turnIndex} not recorded: ${refusalReason(err)}`,
      });
    }
  }

  private emit(event: RunProgressEvent): void {
    this.options.onProgress?.(event);
  }

  /**
   * Commit a checkpoint and record it in the database (defect 2, K28, Y3).
   * Mid-card checkpoints must never fail the card, so errors are reported
   * and swallowed; the final pass checkpoint keeps its old strictness.
   */
  private async checkpoint(
    step: number,
    gateStatus: GateStatus,
    checkpointShas: string[],
    strict = false,
  ): Promise<string | undefined> {
    const { card, syncAdapter, store } = this.options;
    const role = this.options.agentRole ?? "implementer";
    const agentRole: AgentRole = (AGENT_ROLES as readonly string[]).includes(role)
      ? (role as AgentRole)
      : "implementer";
    const agentModel = this.options.agentModel ?? this.options.modelAdapter.modelId;
    const agentHarness = this.options.agentHarness ?? "sekhemet";
    let sha: string;
    try {
      sha = await syncAdapter.commitCheckpoint({
        cardId: card.id,
        step,
        totalSteps: card.stepBudget,
        gateStatus,
        agentModel,
        agentHarness,
        agentRole,
        ...(this.options.coAuthors ? { coAuthors: this.options.coAuthors } : {}),
      });
    } catch (err) {
      // SEC-2: git metadata the harness did not write stops the card; no
      // further git runs in this worktree.
      if (isTampered(err)) {
        this.tampered = refusalReason(err);
        this.emit({ type: "status", cardId: card.id, message: `stopped: ${this.tampered}` });
        return undefined;
      }
      if (strict) throw err;
      this.emit({
        type: "status",
        cardId: card.id,
        message: `checkpoint failed: ${refusalReason(err)}`,
      });
      return undefined;
    }
    checkpointShas.push(sha);
    this.emit({
      type: "checkpoint",
      cardId: card.id,
      message: `${sha.slice(0, 10)} (${gateStatus})`,
    });
    const stepId = this.stepIds.get(step);
    if (stepId && store?.runs) {
      await store.runs.markStepCheckpoint(stepId, sha).catch(() => undefined);
    }
    if (store) {
      const record: CheckpointRecord = {
        cardId: card.id,
        step,
        gitRef: sha,
        gateStatus,
        agentModel,
        agentHarness,
        agentRole,
        createdAt: new Date().toISOString(),
      };
      try {
        await store.recordCheckpoint(record);
      } catch (err) {
        this.emit({
          type: "status",
          cardId: card.id,
          message: `checkpoint ${sha.slice(0, 10)} not recorded: ${refusalReason(err)}`,
        });
      }
    }
    return sha;
  }

  /**
   * Where this run starts (H17, H18, H19): an explicit fork or rewind point,
   * else the last checkpoint of a card whose previous run was cut short (a
   * resumable stop, or an attempt still marked running because the process
   * died), else the card's start.
   */
  private async resumePoint(): Promise<
    { step: number; gitRef: string; attemptId?: string } | undefined
  > {
    const { card, store } = this.options;
    if (this.options.startFrom) return this.options.startFrom;
    if (!store || this.options.resume === false) return undefined;
    const lastAttempt = store.runs?.listAttempts(card.id).at(-1);
    const crashed = lastAttempt?.status === "running";
    if (!crashed && !(card.stopReason && STOP_REASONS[card.stopReason].resumable)) return undefined;
    try {
      const checkpoints = await store.getCheckpoints(card.id);
      const last = checkpoints.at(-1);
      return last
        ? {
            step: last.step,
            gitRef: last.gitRef,
            ...(lastAttempt ? { attemptId: lastAttempt.id } : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The Worker's history up to `step`, replayed from the step rows of the
   * attempt being resumed or forked (H17: "session resume from the log").
   */
  private replayHistory(attemptId: string | undefined, step: number): TurnHistoryItem[] {
    const runs = this.options.store?.runs;
    if (!runs || !attemptId) return [];
    try {
      return runs
        .listSteps(attemptId)
        .filter((s) => s.stepIndex <= step)
        .map((s) => ({
          turn: s.stepIndex,
          action:
            s.calls.map((c) => (c.target ? `${c.name}(${c.target})` : c.name)).join(", ") ||
            "(no tool calls)",
          result:
            s.calls
              .map((c) => `${c.ok === false ? "failed" : "ok"}: ${c.summary ?? ""}`.trim())
              .join(" | ") || "(no observation recorded)",
        }));
    } catch {
      return [];
    }
  }

  /** Reset the worktree to a checkpoint commit. False when git refuses. */
  private restore(worktreePath: string, gitRef: string): boolean {
    if (!/^[0-9a-f]{7,64}$/i.test(gitRef)) return false;
    try {
      execFileSync("git", ["reset", "--hard", gitRef], {
        cwd: worktreePath,
        stdio: "ignore",
        timeout: 30_000,
      });
      // Files a later step created and never committed go too, except the
      // staged acceptance tests, which the harness put there.
      execFileSync("git", ["clean", "-fdq", "-e", "tests/"], {
        cwd: worktreePath,
        stdio: "ignore",
        timeout: 30_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * G12, rule 6b: the red-first check, judged by the red/green rule of the
   * card's `change` (GT-N8-2) — one table, never `kind` or `split`.
   */
  private async failToPass(worktreePath: string): Promise<FailToPassReport> {
    const tests = (this.options.card.acceptanceTests ?? []).map((t) =>
      t.startsWith("tests/") ? t : `tests/${t}`,
    );
    // A build-repair card: red is its build command failing on the base.
    const build = this.options.buildRepair;
    if (build) {
      const v = await buildRepairRedCheck(this.options.sandbox ?? new ProcessSandbox(), {
        ...build,
        cwd: worktreePath,
      });
      return {
        status: v.status,
        tests,
        detail: v.detail,
        ...(v.stopReason ? { stopReason: v.stopReason } : {}),
      };
    }
    // NEW-gates-6 (rules 6, 6a, 32a): the smell lint, red at an assertion
    // against a stub of the declared interface, and stub-kill, before any of
    // the Worker's budget is spent. A check that could not judge (no JUnit
    // path, a gate host) says so in the record and the gate run below decides.
    const strength = await this.checkStrength(worktreePath, tests);
    const withStrength = strength ? { testStrength: strength } : {};
    if (strength?.verdict.stopReason && strength.verdict.status) {
      return {
        status: strength.verdict.status,
        tests,
        detail: strength.verdict.detail,
        stopReason: strength.verdict.stopReason,
        ...withStrength,
      };
    }
    if (strength?.redAtAssertion.status === "red") {
      return { status: "fails", tests, detail: strength.verdict.detail, ...withStrength };
    }
    // A types-only card's acceptance test is a contract checked by the type
    // checker: `import type` and `expectTypeOf` are erased at runtime, so
    // under the test runner alone it passes against an empty file and the
    // card can never show red. Every such card in the first frozen-suite run
    // was refused as vacuous for exactly this reason. Its red check has to
    // include typecheck; the card is vacuous only if both already pass.
    const rungs: GateRung[] =
      cardKind(this.options.card) === "interface" ? ["test", "typecheck"] : ["test"];
    let result: GateResult;
    try {
      result = await this.options.gateRunner.runGates(rungs, worktreePath);
    } catch (err) {
      return {
        status: "unknown",
        tests,
        detail: `gates could not run: ${refusalReason(err)}`,
        ...withStrength,
      };
    }
    // Gates that could not start say nothing about the tests: not red, not green.
    const verdict = judgeRedFirst(
      this.options.card.change,
      { passed: result.passed, onlyNotRun: onlyNotRun(result) },
      tests,
    );
    if (verdict.status === "unknown") {
      return {
        status: "unknown",
        tests,
        detail: `gates could not run: ${result.failures[0]?.errorExcerpt.split("\n")[0] ?? ""}`,
        ...withStrength,
      };
    }
    if (verdict.status === "fails") {
      const first = result.failures[0]?.errorExcerpt.split("\n")[0] ?? "failing";
      return {
        status: "fails",
        tests,
        detail: `${result.failures.length} failure(s); first: ${first}`,
        ...withStrength,
      };
    }
    return {
      status: verdict.status,
      tests,
      detail: verdict.detail,
      ...(verdict.stopReason ? { stopReason: verdict.stopReason } : {}),
      ...withStrength,
    };
  }

  /**
   * Each staged test's origin (lead ruling): the explicit origin when the
   * caller names one, else `card` for a file a Planner, test-author or PM
   * carry-over `test/staged` record matches by SHA-256 or the card's own
   * diff wrote, `external` for the rest.
   */
  private async stagedTestOrigins(
    worktreePath: string,
    tests: string[],
  ): Promise<Record<string, TestOrigin>> {
    const { card } = this.options;
    const forced = this.options.acceptanceTestsOrigin;
    let staged: StagedTestRecord[] = [];
    let cardDiff: string[] = [];
    if (!forced) {
      const events = await (
        this.options.store?.cardEvents?.(card.id, ["test/staged"]) ?? Promise.resolve([])
      ).catch(() => []);
      staged = events
        .map((e) => e.payload as Partial<StagedTestRecord>)
        .filter(
          (p): p is StagedTestRecord =>
            typeof p?.path === "string" &&
            typeof p.sha256 === "string" &&
            typeof p.author === "string",
        );
      const base = this.options.baseBranch ?? "main";
      try {
        const git = (...args: string[]) =>
          execFileSync("git", args, {
            cwd: worktreePath,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          });
        const harness = new Set(tests);
        cardDiff = base.startsWith("-")
          ? []
          : [
              ...git("diff", "--name-only", "--no-renames", base, "--").split("\n"),
              ...git("ls-files", "--others", "--exclude-standard").split("\n"),
            ].filter((f) => f && !harness.has(f));
      } catch {
        cardDiff = [];
      }
    }
    return testOrigins({ root: worktreePath, tests, staged, cardDiff, forced });
  }

  /**
   * The card's gate runner, closing quarantine once its first verification
   * has run (rule 34): a later failure is the Worker's to fix, never
   * quarantined.
   */
  private closingQuarantine(worktreePath: string): GateRunner {
    const inner = this.options.gateRunner;
    return {
      ...(inner.gateIds ? { gateIds: inner.gateIds } : {}),
      runGates: async (rungs, cwd, runOptions) => {
        try {
          return await inner.runGates(rungs, cwd, runOptions);
        } finally {
          closeQuarantine(worktreePath);
        }
      },
    };
  }

  /**
   * GT-TQ-11: the tests an upgrade card keeps passing. Named on the card, they
   * stand; otherwise the project's tests that pass on the base are recorded on
   * the card (its `gateChecks.keptTests`, on the ledger) before any step. An
   * empty list, or a suite that cannot be read here, refuses the card.
   */
  private async upgradeKeptTests(
    worktreePath: string,
  ): Promise<{ tests: string[] } | { refused: string }> {
    const { card, store } = this.options;
    const named = card.gateChecks?.keptTests;
    let passingOnBase: string[] = [];
    if (!named?.length) {
      const testGate = projectTestGate(this.config);
      if (!testGate) {
        return {
          refused:
            "an upgrade card names no test to keep, and the project's tests cannot be listed here (a gate host runs them): name the tests it must keep",
        };
      }
      const base = await passingTests(
        this.options.sandbox ?? new ProcessSandbox(),
        worktreePath,
        testGate,
      );
      if ("unavailable" in base) {
        return {
          refused: `an upgrade card names no test to keep, and the project's passing tests could not be listed: ${base.unavailable}`,
        };
      }
      passingOnBase = base.tests;
    }
    const list = upgradeTestList({ ...(named?.length ? { named } : {}), passingOnBase });
    if (list.refused !== undefined) return { refused: list.refused };
    if (!named?.length) {
      // The card carries its kept list from here on: this run's
      // verification and every later one read it from the record.
      // A list that cannot be recorded is not kept: the store's error stands,
      // and the card does not start on a list only this run would know.
      card.gateChecks = { ...(card.gateChecks ?? {}), keptTests: list.tests };
      await store?.updateCard(card.id, { gateChecks: card.gateChecks }, "executor");
    }
    this.emit({
      type: "status",
      cardId: card.id,
      message: `upgrade keeps ${list.tests.length} test(s) passing`,
    });
    return { tests: list.tests };
  }

  /**
   * The acceptance tests' strength (NEW-gates-6), run through the project's
   * test gate in this machine's sandbox. Undefined when it cannot be judged
   * here: with `[gate_host]` the tests run on the gate host, and the gate run
   * alone decides red-first.
   */
  private async checkStrength(
    worktreePath: string,
    tests: string[],
  ): Promise<TestStrengthRecord | undefined> {
    const { card, store } = this.options;
    const testGate = projectTestGate(this.config);
    if (!testGate) return undefined;
    // DS-P14-3: the profile a person recorded for the card's project, read
    // by the kernel's one reader; unrecorded, the gate reads the default
    // and says so.
    const depth = store?.depthProfiles?.of(card.projectId);
    try {
      return await checkTestStrength({
        ...(depth?.recorded ? { profile: depth.profile } : {}),
        projectId: card.projectId,
        sandbox: this.options.sandbox ?? new ProcessSandbox(),
        root: worktreePath,
        testGate,
        tests,
        origin: this.options.acceptanceTestsOrigin ?? "external",
        origins: await this.stagedTestOrigins(worktreePath, tests),
        change: card.change,
        kind: cardKind(card),
      });
    } catch (err) {
      this.emit({
        type: "status",
        cardId: card.id,
        message: `test strength not judged: ${refusalReason(err)}`,
      });
      return undefined;
    }
  }

  /** Move the card, holding it with a recorded reason when the board refuses. */
  private async move(
    to: CardStatus,
    why?: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { card, lifecycle, store } = this.options;
    if (!lifecycle) return { ok: true };
    try {
      await lifecycle.transition(card.id, to, why);
      return { ok: true };
    } catch (err) {
      const reason = `${to} refused (${refusalReason(err)})`;
      try {
        if (lifecycle.hold) await lifecycle.hold(card.id, reason, to);
        else await store?.updateCard(card.id, { blockedReason: `held: ${reason}` }, "executor");
      } catch {
        // The hold is best effort; the result still carries the reason.
      }
      this.emit({ type: "status", cardId: card.id, message: `held: ${reason}` });
      return { ok: false, reason };
    }
  }

  /** When `run` began, on the ledger's clock (INT-11a). */
  private runStartedAt = new Date().toISOString();

  /**
   * The scope or acceptance-criteria change a tracker made to this card while
   * it ran (`sync/scope_changed`, integrations INT-11a), as the move's
   * reason naming the changed fields; undefined when there was none.
   */
  private async scopeChangedSince(startedAt: string): Promise<string | undefined> {
    const events = await this.options.store?.cardEvents?.(this.options.card.id, [
      "sync/scope_changed",
    ]);
    const changes = (events ?? []).filter((e) => e.createdAt >= startedAt);
    if (changes.length === 0) return undefined;
    const kinds = new Set<string>();
    const fields = new Set<string>();
    for (const e of changes) {
      const p = e.payload as { change?: string; fields?: string[] };
      if (p.change) kinds.add(p.change === "criteria" ? "acceptance criteria" : "scope");
      for (const f of p.fields ?? []) fields.add(f);
    }
    return `the tracker changed the card's ${[...kinds].join(" and ")} while it ran (${[...fields].join(", ")}): re-plan against the edited issue`;
  }

  public async run(): Promise<CardRunResult> {
    const started = this.now();
    // The ledger's clock, for events recorded during this run (INT-11a).
    this.runStartedAt = new Date().toISOString();
    const { card, syncAdapter, lifecycle, store } = this.options;
    const attempt = Math.max(1, Math.floor(this.options.attempt ?? 1));
    const checkpointShas: string[] = [];

    const resumeFrom = await this.resumePoint();
    // One spelling for a worktree, fresh or resumed (live-test F18): the
    // adapter hands back the resolved path, so a given path is resolved too.
    const worktreePath = this.options.useExistingWorktree
      ? resolvedPath(this.options.worktreePath)
      : // Y1: a subtask's worktree branches from its parent's branch.
        await syncAdapter.createWorktree(
          card.id,
          this.options.baseBranch ?? "main",
          card.title,
          card.parentId ?? null,
        );

    let resumedFrom: { step: number; gitRef: string } | undefined;
    if (resumeFrom && this.restore(worktreePath, resumeFrom.gitRef)) {
      resumedFrom = { step: resumeFrom.step, gitRef: resumeFrom.gitRef };
      this.startStep = resumeFrom.step;
      this.emit({
        type: "status",
        cardId: card.id,
        message: `resuming from checkpoint ${resumeFrom.gitRef.slice(0, 10)} at step ${resumeFrom.step}`,
      });
    }

    await this.options.onWorktreeReady?.(worktreePath);
    // K12: card/start (observe; a hook's message reaches the first prompt).
    const startHook = await this.options.hooks
      ?.emit("card/start", { cardId: card.id, data: { worktreePath, attempt } })
      .catch(() => undefined);
    this.emit({ type: "status", cardId: card.id, message: `worktree ready at ${worktreePath}` });

    // Rule 34: no quarantine begins during red-first; the card's first
    // verification opens it (below) and closes it once it has run.
    setQuarantinePolicy(worktreePath, undefined);
    setQuarantinePolicy(worktreePath, { open: false });
    // G12: a fresh card's acceptance tests must fail before work begins.
    let failToPass: FailToPassReport | undefined;
    const fresh = !resumedFrom && !this.options.useExistingWorktree && attempt === 1;
    // GT-TQ-11: an upgrade card records on itself the tests it must keep
    // passing — those it names, else the project's tests that pass on the
    // base — and does not start with none. Its verification runs them.
    if (fresh && card.change === "upgrade" && !this.options.restricted) {
      const kept = await this.upgradeKeptTests(worktreePath);
      if ("refused" in kept) {
        return this.finishRefused(worktreePath, attempt, started, {
          status: "refused",
          tests: [],
          detail: kept.refused,
          stopReason: "base_not_green",
        });
      }
    }
    if (
      fresh &&
      !this.options.restricted &&
      this.options.verifyFailToPass !== false &&
      ((card.acceptanceTests?.length ?? 0) > 0 || this.options.buildRepair)
    ) {
      failToPass = await this.failToPass(worktreePath);
      this.emit({ type: "status", cardId: card.id, message: `fail-to-pass: ${failToPass.status}` });
      if (failToPass.status === "vacuous") {
        return this.finishVacuous(worktreePath, attempt, started, failToPass);
      }
      if (failToPass.status === "refused") {
        return this.finishRefused(worktreePath, attempt, started, failToPass);
      }
    }

    // Rule 34: a flaky test may be quarantined at the card's first
    // verification only — a fresh attempt, before its first repair rung —
    // never one of its acceptance tests or a test its diff changed or added.
    setQuarantinePolicy(worktreePath, {
      open: fresh,
      never: (card.acceptanceTests ?? []).map((t) => (t.startsWith("tests/") ? t : `tests/${t}`)),
      base: this.options.baseBranch ?? "main",
    });

    const startMove = await this.move("in_progress");
    if (!startMove.ok) {
      return this.finish({
        worktreePath,
        attempt,
        started,
        turns: [],
        stopReason: "error",
        lastGateResult: undefined,
        checkpointShas,
        stepsUsed: 0,
        heldBeforeStart: startMove.reason,
        ...(failToPass ? { failToPass } : {}),
      });
    }

    // S5: with a network allowlist, the card's commands reach the network
    // only through an egress proxy that forwards allowlisted domains and logs
    // every request to the ledger.
    // Item 30: the user's policy narrowed by the repository's gates.toml.
    // With no policy the card is offline: nothing widens by default (SEC-13).
    const policy = this.options.networkPolicy ?? mergeNetworkConfigs({}, {});
    const allow = cardAllowlist(policy, this.config.project.networkAllow ?? []);
    // SEC-15b: a wildcard or upload-capable host is recorded on the card.
    for (const w of allowlistWarnings(allow)) {
      this.emit({
        type: "status",
        cardId: card.id,
        message: `network allowlist warning: ${w.host} — ${w.reason}`,
      });
      void store
        ?.recordEvent({ type: "card/egress_warning", cardId: card.id, actor: "system", payload: w })
        .catch(() => undefined);
    }
    if (allow.length > 0 && !this.options.allowNetwork && !this.options.restricted) {
      this.egress = new EgressProxy({
        allow,
        deny: policy.fetchDeny,
        onRequest: (r) => {
          void store
            ?.recordEvent({ type: "card/egress", cardId: card.id, actor: "system", payload: r })
            .catch(() => undefined);
        },
      });
      this.egressPort = await this.egress.start().catch(() => undefined);
    }
    // DS-P2-1, -2: card zero's generator steps — a person's Create project
    // approved that generator — reach its ecosystem's package registry and
    // nothing else, through a proxy of their own; every request recorded as
    // the card's egress. The card's other commands stay as the policy says.
    const registry = this.options.declaredSteps?.registry;
    const generatorHosts = registry ? generatorAllowlist(policy, registry) : [];
    if (generatorHosts.length > 0 && !this.options.allowNetwork && !this.options.restricted) {
      this.generatorEgress = new EgressProxy({
        allow: generatorHosts,
        deny: policy.fetchDeny,
        onRequest: (r) => {
          void store
            ?.recordEvent({
              type: "card/egress",
              cardId: card.id,
              actor: "system",
              payload: { ...r, via: "generator" },
            })
            .catch(() => undefined);
        },
      });
      this.generatorPort = await this.generatorEgress.start().catch(() => undefined);
    }

    // Everything the team recorded about this card reaches this attempt.
    let dossierLines: string[] = [];
    if (store) {
      try {
        dossierLines = dossierPromptLines(await store.getDossier(card.id));
      } catch {
        // A dossier read failure costs context, not the card.
      }
    }

    for (const m of startHook?.messages ?? []) dossierLines.push(`Project hook: ${m.content}`);
    // M3: an imported card's text is untrusted by origin, from the ledger.
    const untrustedOrigin = store ? await untrustedOriginOf(store, card.id) : undefined;

    // G25: pass@k with gate selection. Each sample starts from the same
    // tree and context; the first to pass the gates is taken. With
    // cross-validation (G26) sampling continues to a second pass, and each
    // passing implementation is run against the other's tests.
    // From the caller, else gates.toml [project] pass_at_k / cross_validate.
    const samples = Math.max(
      1,
      Math.floor(this.options.samples ?? this.config.project.passAtK ?? 1),
    );
    const temperatures = this.options.sampleTemperatures ?? [0.4, 0.55, 0.7];
    const baseRef = this.headOf(worktreePath);
    type Sample = {
      session: CardExecutionSessionImpl;
      turns: TurnResult[];
      stopReason: ExecutionStopReason;
      lastGateResult: GateResult | undefined;
      sha?: string;
      /** Rule 31a: which budget ran out, or which hook vetoed. */
      stopDetail?: Record<string, unknown>;
      /** When the sample started: its time budget runs from here (rule 21). */
      startedAt: number;
    };
    const tried: Sample[] = [];
    const runSample = async (
      sampleIndex: number,
      sampleTemperature: number | undefined,
      /** RG-N1-1: continue this session, within its remaining budgets. */
      continued?: { session: CardExecutionSessionImpl; tokens: number; startedAt: number },
    ): Promise<Sample> => {
      const session =
        continued?.session ??
        new CardExecutionSessionImpl({
          // The rungs, fixes, protection, limits and built-in layers, as
          // `sekhemet gate <card>` verifies them (GT-T1-1).
          ...verificationSessionOptions(this.config, {
            repoRoot: this.options.repoRoot,
            restricted: this.options.restricted === true,
            scope: this.options.card.scopeFiles,
          }),
          // GT-M6-5: the gates `note` may name as wrong, fixed for the attempt.
          suspectableGates: this.suspectableGates(),
          ...(this.egressPort ? { allowedDomains: allow, egressProxyPort: this.egressPort } : {}),
          ...(store
            ? {
                recordQuestion: async (q: string) =>
                  (
                    await store.recordDossierEntry({
                      cardId: card.id,
                      kind: "question",
                      text: q,
                      attempt,
                    })
                  ).entryId,
                // WL-N4-1/2: a question nothing answers now is posted to a person,
                // without stopping the Worker; its answer is read at step boundaries.
                ...(store.runs
                  ? {
                      postDecision: async (question: string, assumption: string) =>
                        (
                          await store.runs?.requestDecision({
                            cardId: card.id,
                            kind: "worker_question",
                            question,
                            context: `The Worker continues on its assumption: ${assumption}`,
                            options: [
                              `As assumed: ${assumption}`,
                              "Otherwise: see the card's thread",
                            ],
                            recommendationIndex: 0,
                          })
                        )?.id,
                      readDecision: async (id: string, questionEntryId?: string) => {
                        const d = store.runs?.getDecision(id);
                        if (!d) return undefined;
                        // M3: the person's own words, their reply in the card's
                        // thread to this question (written before or after the decision).
                        const reply =
                          d.status === "answered"
                            ? await personReply(store, card.id, questionEntryId)
                            : undefined;
                        return {
                          answered: d.status === "answered",
                          ...(d.selectedOptionIndex !== undefined
                            ? {
                                optionIndex: d.selectedOptionIndex,
                                option: d.options[d.selectedOptionIndex],
                              }
                            : {}),
                          ...(reply ? { reply } : {}),
                        };
                      },
                      // PM-P2-7: when the answer reached the Worker, on the ledger.
                      onAnswerDelivered: async (id: string) => {
                        await store.runs?.recordDecisionDelivered(id);
                      },
                    }
                  : {}),
                recordAnswer: async (a: string, questionEntryId: string | undefined) => {
                  await store.recordDossierEntry({
                    cardId: card.id,
                    kind: "answer",
                    text: a,
                    attempt,
                    ...(questionEntryId ? { inReplyTo: questionEntryId } : {}),
                  });
                },
              }
            : {}),
          ...(dossierLines.length > 0 ? { dossierLines } : {}),
          ...(untrustedOrigin ? { untrustedOrigin } : {}),
          // L11: a note reaches the card's thread (its dossier, on the ledger)
          // the moment the Worker writes it, not at the end of the attempt.
          ...(store
            ? {
                onNote: async (text: string) => {
                  if (text.startsWith("Asked: ")) return; // recorded as a question already
                  await store.recordDossierEntry({ cardId: card.id, kind: "note", text, attempt });
                  this.emit({
                    type: "status",
                    cardId: card.id,
                    message: `note: ${text.slice(0, 160)}`,
                  });
                },
              }
            : {}),
          prefixGuard: this.prefixGuard,
          // K11: every prompt is stored by hash before it is sent.
          onPrompt: (record: PromptRecord) => this.logPrompt(record),
          ...this.options,
          // DS-P2-1, -2: the declared steps' way out is the generator's proxy.
          ...(this.options.declaredSteps && this.generatorPort
            ? {
                declaredSteps: {
                  ...this.options.declaredSteps,
                  egressProxyPort: this.generatorPort,
                },
              }
            : {}),
          // Rule 34: the first verification closes quarantine behind it.
          gateRunner: this.closingQuarantine(worktreePath),
          // G25: each further sample draws at its own temperature.
          ...(sampleTemperature !== undefined ? { temperature: sampleTemperature } : {}),
          ...(resumedFrom && sampleIndex === 1
            ? {
                startStep: resumedFrom.step,
                priorHistory: this.replayHistory(resumeFrom?.attemptId, resumedFrom.step),
                priorLessons: [
                  ...(this.options.priorLessons ?? []),
                  this.options.forkedFrom
                    ? `forked from attempt ${this.options.forkedFrom.attemptId} at step ${resumedFrom.step}`
                    : this.options.startFrom
                      ? `rewound to the checkpoint at step ${resumedFrom.step}`
                      : `resumed after ${card.stopReason ?? "an interrupted run"} at step ${resumedFrom.step}`,
                ],
              }
            : {}),
          cardId: card.id,
          card,
          worktreePath,
          syncAdapter,
        });
      this.session = session;
      if (this.pendingAbort !== undefined) await session.abort(this.pendingAbort);
      if (this.pendingPause !== undefined) session.pause(this.pendingPause);
      for (const m of this.pendingMessages.splice(0)) session.deliverMessage(m.text, m.from);

      // The attempt as a row (K16): steps, gate results and evidence hang off it.
      if (store?.runs && sampleIndex === 1 && !continued) {
        try {
          this.attemptId = (
            await store.runs.startAttempt({
              cardId: card.id,
              // WL-N5-1: the real number, counting every earlier run of the card.
              attemptNumber: Math.max(attempt, store.runs.nextAttemptNumber(card.id)),
              modelId: this.options.modelAdapter.modelId,
              // The arm the steps are sent in (A3), as the session chooses it.
              toolArm:
                ARM_LETTER[
                  this.options.toolArm ?? this.options.modelAdapter.preferredToolArm ?? "arm_a_flat"
                ],
              ...(resumedFrom ? { resumedFromStep: resumedFrom.step } : {}),
              ...(this.options.forkedFrom ? { forkedFrom: this.options.forkedFrom } : {}),
            })
          ).id;
        } catch (err) {
          this.emit({
            type: "status",
            cardId: card.id,
            message: `attempt not recorded: ${refusalReason(err)}`,
          });
        }
      }

      const turns: TurnResult[] = [];
      let tokens = continued?.tokens ?? 0;
      let stopReason: ExecutionStopReason = "budget_exhausted";
      let lastGateResult: GateResult | undefined;
      const tokenBudget = this.options.tokenBudget ?? card.tokenBudget;
      // WL-T3-11: steps × 70 s when the card sets none; per sample (rule 21).
      const secondsBudget =
        this.options.secondsBudget ?? card.secondsBudget ?? defaultSecondsBudget(card.stepBudget);
      const sampleStarted = continued?.startedAt ?? this.now();
      let stopDetail: Record<string, unknown> | undefined;
      const every = this.options.checkpointEvery ?? 5;
      let lastCheckpointStep = session.getStepsUsed();
      let lastCheckpointWrites = 0;

      const budgetStop = (): ExecutionStopReason | undefined => {
        if (tokenBudget !== undefined && tokenBudget > 0 && tokens >= tokenBudget) {
          return "token_budget_exhausted";
        }
        if (
          secondsBudget !== undefined &&
          secondsBudget > 0 &&
          this.now() - sampleStarted >= secondsBudget * 1000
        ) {
          return "time_budget_exhausted";
        }
        return undefined;
      };

      while (session.getStepsUsed() < card.stepBudget) {
        if (this.options.signal?.aborted && this.pendingAbort === undefined) {
          await this.abort(String(this.options.signal.reason ?? "aborted"));
        }
        const overBudget = budgetStop();
        if (overBudget) {
          stopReason = overBudget;
          this.emit({
            type: "status",
            cardId: card.id,
            message:
              overBudget === "token_budget_exhausted"
                ? `token budget spent: ${tokens}/${tokenBudget}`
                : `time budget spent: ${Math.round((this.now() - sampleStarted) / 1000)}s/${secondsBudget}s`,
          });
          break;
        }

        let turn: TurnResult;
        const turnStarted = this.now();
        try {
          turn = await session.executeTurn();
        } catch (err) {
          // An inference or transport failure ends this card with a recorded
          // reason; it must not take the queue down with it. A single rejected
          // request on a live run previously killed the whole Chronicle gate.
          const message = err instanceof Error ? err.message : String(err);
          this.emit({
            type: "status",
            cardId: card.id,
            message: `stopped on error: ${message.slice(0, 300)}`,
          });
          // SEC-2: the per-turn fingerprint runs git in the worktree too.
          if (isTampered(err)) {
            this.tampered = message;
            stopReason = "git_metadata_tampered";
          } else {
            stopReason = "error";
          }
          break;
        }
        turn.durationMs = Math.max(0, this.now() - turnStarted);
        // C14/C20: the step's context-pack record and metrics ride on the turn.
        const report = session.getLastContextReport();
        if (report) turn.contextReport = report;
        const packId = session.getLastContextPackId();
        if (packId) {
          turn.contextPackId = packId;
          this.packIds.push(packId);
        }
        turn.sample = sampleIndex;
        await this.recordStep(turn);
        turns.push(turn);
        tokens += (turn.usage?.promptTokens ?? 0) + (turn.usage?.completionTokens ?? 0);
        try {
          await this.options.onTurn?.(card.id, turn);
        } catch {
          // Recording a step must never fail a card.
        }

        this.emit({
          type: "turn",
          cardId: card.id,
          turn: turn.turnIndex,
          message: turn.toolCalls.map((c) => c.name).join(", ") || "(no tool calls)",
        });

        if (turn.gateResult) {
          lastGateResult = turn.gateResult;
          this.emit({
            type: "gate",
            cardId: card.id,
            turn: turn.turnIndex,
            message: turn.gateResult.passed
              ? "gates PASSED"
              : `gates FAILED: ${turn.gateResult.failures[0]?.errorExcerpt ?? "unknown"}`,
          });

          // Checkpoint every gate-passing step, so a relay can resume from a
          // known-good state rather than replaying from the card's start.
          if (turn.gateResult.passed) {
            await this.checkpoint(turn.turnIndex, "pass", checkpointShas, true);
            lastCheckpointStep = session.getStepsUsed();
            lastCheckpointWrites = session.getWriteCount();
          }
        }
        if (this.tampered) {
          stopReason = "git_metadata_tampered";
          break;
        }

        if (turn.stopReason) {
          stopReason = turn.stopReason;
          if (turn.budget) stopDetail = { ...turn.budget };
          if (turn.hookVeto) stopDetail = { ...turn.hookVeto };
          if (turn.suspectedGate) stopDetail = { ...turn.suspectedGate };
          if (turn.repeatedCall) stopDetail = { repeated: turn.repeatedCall };
          // Rule 31: human_abort's next action is to see who stopped it.
          if (turn.abortedBy !== undefined) stopDetail = { by: turn.abortedBy };
          break;
        }

        // Mid-card checkpoints (Y3): every N steps with new writes, so a halted
        // or relayed card picks up partial work from git instead of restarting.
        if (
          every > 0 &&
          session.getStepsUsed() - lastCheckpointStep >= every &&
          session.getWriteCount() > lastCheckpointWrites
        ) {
          const status: GateStatus = lastGateResult && !lastGateResult.passed ? "fail" : "partial";
          await this.checkpoint(session.getStepsUsed(), status, checkpointShas);
          lastCheckpointStep = session.getStepsUsed();
          lastCheckpointWrites = session.getWriteCount();
          if (this.tampered) {
            stopReason = "git_metadata_tampered";
            break;
          }
        }
      }

      // A stop that suspends the card keeps its partial work in a checkpoint:
      // that is what a memory-pressure resume (H17) restarts from.
      if (STOP_REASONS[stopReason].checkpoints && session.getWriteCount() > lastCheckpointWrites) {
        await this.checkpoint(session.getStepsUsed(), "partial", checkpointShas);
        lastCheckpointWrites = session.getWriteCount();
      }

      // An agent can do the work and still never declare itself finished — it
      // explores until the budget runs out. Discarding completed work because the
      // agent failed to announce it is the worst available outcome, so any
      // terminal stop with written scope and no gate run gets one verification.
      // Not after a person stopped the card, and not past the time budget: those
      // stops are the point.
      // Nor under memory pressure: a typecheck and a test run are exactly the
      // allocations the halt was protecting the host from.
      if (!lastGateResult && session.isScopeComplete() && STOP_REASONS[stopReason].mayVerify) {
        this.emit({
          type: "status",
          cardId: card.id,
          message: `stopped as ${stopReason} with scope complete — verifying anyway`,
        });

        try {
          lastGateResult = await session.runVerification();
          this.emit({
            type: "gate",
            cardId: card.id,
            message: lastGateResult.passed
              ? "gates PASSED on forced verification"
              : `gates FAILED on forced verification: ${
                  lastGateResult.failures[0]?.errorExcerpt ?? "unknown"
                }`,
          });

          if (lastGateResult.passed) {
            stopReason = "gate_passed";
            await this.checkpoint(session.getStepsUsed(), "pass", checkpointShas, true);
            if (this.tampered) stopReason = "git_metadata_tampered";
          } else if (onlyNotRun(lastGateResult)) {
            // Only gates that could not run: not the Worker's failure (rule 9).
            stopReason = "done_pending_gates";
          }
        } catch (err) {
          stopReason = "done_pending_gates";
          this.emit({
            type: "status",
            cardId: card.id,
            message: `scope complete but the gates could not run: ${refusalReason(err)}`,
          });
        }
      } else if (
        !lastGateResult &&
        session.isScopeComplete() &&
        stopReason === "time_budget_exhausted"
      ) {
        // The work is written and unverified: say so rather than "out of time".
        stopReason = "done_pending_gates";
      }
      // Rule 31a: the loop ran to the step budget.
      if (stopReason === "budget_exhausted" && !stopDetail) {
        stopDetail = { budget: "steps", used: session.getStepsUsed(), of: card.stepBudget };
      }
      if (stopReason !== "budget_exhausted" && stopDetail?.budget !== undefined) {
        stopDetail = undefined;
      }
      return {
        session,
        turns,
        stopReason,
        lastGateResult,
        startedAt: sampleStarted,
        ...(stopDetail ? { stopDetail } : {}),
      };
    };

    const passing: Sample[] = [];
    const want = (this.options.crossValidate ?? this.config.project.crossValidate) ? 2 : 1;
    for (let k = 1; k <= samples; k++) {
      if (k > 1) {
        if (!baseRef || !this.restore(worktreePath, baseRef)) break;
        this.emit({
          type: "status",
          cardId: card.id,
          message: `pass@k: sample ${k} of ${samples}`,
        });
      }
      const sample = await runSample(
        k,
        k > 1 ? temperatures[(k - 2) % temperatures.length] : undefined,
      );
      tried.push(sample);
      if (sample.stopReason === "gate_passed" && sample.lastGateResult?.passed) {
        const sha = this.headOf(worktreePath);
        if (sha) sample.sha = sha;
        passing.push(sample);
        if (passing.length >= want) break;
      } else if (STOP_REASONS[sample.stopReason].endsSampling) {
        break;
      }
    }
    const picked = (passing[0] ?? tried[tried.length - 1]) as Sample;
    const session = picked.session;
    const turns = tried.flatMap((t) => t.turns);
    let stopReason = picked.stopReason;
    if (this.tampered) stopReason = "git_metadata_tampered";
    let lastGateResult = picked.lastGateResult;
    if (tried.length > 1 && picked.sha) this.restore(worktreePath, picked.sha);
    if (passing.length >= 2) {
      const disagreement = await this.crossValidate(worktreePath, passing[0]?.sha, passing[1]?.sha);
      if (disagreement) {
        this.crossValidation = disagreement;
        stopReason = "replan_requested";
      }
    }
    this.samplesTried = tried.length;

    // Y6: a passing card is rebased onto the integration branch before it
    // enters Verify, and the gates run again on the rebased tree. A conflict
    // inside the card's scope goes back to the Worker as typed failures,
    // within its remaining budget (RG-N1-1); outside it, the card parks
    // (RG-N1-2); unresolved at the end of the budget, it is one decision
    // request naming both cards (RG-N1-3).
    if (stopReason === "gate_passed" && !this.options.useExistingWorktree) {
      let rebase = await this.rebaseOntoIntegration();
      for (let round = 0; rebase && !rebase.ok && round < 3; round++) {
        const conflict = rebase.failure;
        this.rebaseFailure = conflict.message;
        this.rebaseConflict = { conflict, route: "parked" };
        stopReason = "rebase_conflict";
        const inScope = conflict.outOfScope.length === 0;
        const staged =
          inScope && session.getStepsUsed() < card.stepBudget
            ? this.stageRebaseConflict()
            : undefined;
        await this.recordRebaseConflict(conflict, staged);
        if (!staged) {
          if (inScope) this.rebaseConflict = { conflict, route: "unresolved" };
          break;
        }
        const typed: GateFailure[] = conflict.failures.map((f) => ({
          ...f,
          expected: `${conflict.onto}'s change and this card's change combined, with no conflict markers`,
          actual: `conflict markers in ${f.location.file}`,
        }));
        let failures = typed;
        let resolved = false;
        let otherStop = false;
        while (session.getStepsUsed() < card.stepBudget) {
          session.returnToWorker(
            failures,
            `Rebasing onto ${conflict.onto} conflicts in ${failures.map((f) => f.location?.file).join(", ")}. The files now hold ${conflict.onto}'s version with your change applied and conflict markers where the two clash: resolve each marked hunk, keeping what ${conflict.onto} added, then finish.`,
          );
          const tokensSoFar = turns.reduce(
            (n, t) => n + (t.usage?.promptTokens ?? 0) + (t.usage?.completionTokens ?? 0),
            0,
          );
          const cont = await runSample(1, undefined, {
            session,
            tokens: tokensSoFar,
            startedAt: picked.startedAt,
          });
          turns.push(...cont.turns);
          if (cont.lastGateResult) lastGateResult = cont.lastGateResult;
          const marked = this.conflictMarked(worktreePath, staged.files);
          if (marked.length === 0) {
            resolved = true;
            stopReason = cont.stopReason;
            break;
          }
          if (
            cont.stopReason !== "gate_passed" &&
            STOP_REASONS[cont.stopReason].class !== "budget_exhausted"
          ) {
            // Stopped for its own reason (a person, the host): that stop stands.
            stopReason = cont.stopReason;
            otherStop = true;
            break;
          }
          if (cont.stopReason !== "gate_passed") break;
          failures = typed.filter((f) => marked.includes(f.location?.file ?? ""));
        }
        if (!resolved) {
          if (!otherStop) this.rebaseConflict = { conflict, route: "unresolved" };
          else this.rebaseConflict = undefined;
          break;
        }
        this.rebaseConflict = undefined;
        this.rebaseFailure = undefined;
        if (stopReason !== "gate_passed") break;
        // The resolution sits on the integration branch; it may have moved again.
        rebase = await this.rebaseOntoIntegration();
      }
      if (stopReason === "gate_passed" && rebase?.ok && rebase.rebased) {
        this.emit({
          type: "status",
          cardId: card.id,
          message: "rebased onto the integration branch; re-verifying",
        });
        try {
          const again = await session.runVerification();
          lastGateResult = again;
          if (!again.passed) {
            // Only gates that could not run is not an integration failure (rule 9).
            stopReason = onlyNotRun(again) ? "done_pending_gates" : "integration_failed";
          }
        } catch {
          stopReason = "done_pending_gates";
        }
      }
    }

    return this.finish({
      worktreePath,
      attempt,
      started,
      turns,
      stopReason,
      lastGateResult,
      checkpointShas,
      stepsUsed: session.getStepsUsed(),
      session,
      // WL-T3-13: each sample had its own step budget; the evidence gives each one's steps.
      sampleSteps: tried.map((t) => t.session.getStepsUsed()),
      ...(picked.stopDetail && stopReason === picked.stopReason
        ? { stopDetail: picked.stopDetail }
        : {}),
      ...(failToPass ? { failToPass } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
    });
  }

  /**
   * Close the attempt row, index the evidence bundle (K19) and add the
   * outcome to the competence model (K21). Never fails the card.
   */
  private async closeAttempt(p: {
    passed: boolean;
    stopReason: ExecutionStopReason;
    tokensUsed: number;
    secondsUsed: number;
    evidence: EvidenceBundle;
    written: { path: string; sha256: string } | undefined;
    stepsUsed: number;
    rung?: 1 | 2 | 3 | 4;
    ruleIds?: string[];
    exemplarIds?: string[];
  }): Promise<void> {
    const runs = this.options.store?.runs;
    const { card } = this.options;
    if (!runs || !this.attemptId) return;
    const row = STOP_REASONS[p.stopReason];
    try {
      if (p.written) {
        await runs.recordEvidence({
          id: p.evidence.id,
          cardId: card.id,
          attemptId: this.attemptId,
          passed: p.passed,
          stopReason: p.stopReason,
          path: p.written.path,
          sha256: p.written.sha256,
          filesTouched: p.evidence.filesTouched,
          linesAdded: p.evidence.linesAdded,
          linesRemoved: p.evidence.linesRemoved,
          // GT-T1-9: the same slice hash the bundle carries.
          ...(p.evidence.trajectoryRef ? { trajectoryRef: p.evidence.trajectoryRef } : {}),
        });
      }
      await runs.finishAttempt({
        attemptId: this.attemptId,
        status: p.passed ? "passed" : row.halts ? "halted" : "failed",
        stopReason: p.stopReason,
        tokensUsed: p.tokensUsed,
        secondsUsed: p.secondsUsed,
        evidenceId: p.evidence.id,
        // WL-N5-1: the one attempt record every reader of outcomes uses.
        ...(p.rung ? { rung: p.rung } : {}),
        ...(p.ruleIds ? { ruleIds: p.ruleIds } : {}),
        ...(p.exemplarIds ? { exemplarIds: p.exemplarIds } : {}),
        steps: p.stepsUsed,
        cardClass: cardClassOf(card),
        projectId: basename(this.options.repoRoot),
        linesAdded: p.evidence.linesAdded,
      });
      // A halt says nothing about what the model can do; only outcomes count.
      if (row.measuresModel) {
        await runs.recordCompetence(
          {
            repoId: basename(this.options.repoRoot),
            cardClass: cardClassOf(card),
            filesTouchedCount: p.evidence.filesTouched.length,
            difficulty: difficultyLabel(card.difficulty),
            modelId: this.options.modelAdapter.modelId,
            // M9: the arm the card actually ran on, which is the registry's
            // measured one unless the caller chose. Recording a hardcoded
            // `arm_a_flat` made every competence row say the same thing.
            toolArm:
              this.options.toolArm ?? this.options.modelAdapter.preferredToolArm ?? "arm_a_flat",
            stepBudget: card.stepBudget,
            stepsUsed: p.stepsUsed,
            stopReason: p.stopReason,
            passed: p.passed,
            tokensUsed: p.tokensUsed,
            wallClockSeconds: p.secondsUsed,
          },
          // K-N6-4: a person-built attempt never counts toward a model.
          { attemptId: this.attemptId },
        );
      }
    } catch (err) {
      this.emit({
        type: "status",
        cardId: card.id,
        message: `attempt not closed: ${refusalReason(err)}`,
      });
    }
  }

  /**
   * Gates that passed in the card's Review snapshot (its latest passing
   * evidence) and fail now (G23), as a sentence; undefined when none.
   */
  private regressionAgainstReview(now: GateResult): string | undefined {
    const runs = this.options.store?.runs;
    if (!runs) return undefined;
    const snapshot = runs
      .listEvidence(this.options.card.id)
      .filter((e) => e.passed && e.id !== undefined)
      .at(-1);
    if (!snapshot) return undefined;
    const passedThen = new Set(
      runs
        .listGateResults(snapshot.attemptId)
        .filter((g) => g.passed)
        .map((g) => g.gate),
    );
    const failing = [
      ...new Set((now.rungResults ?? []).filter((r) => !r.passed && !r.skipped).map((r) => r.gate)),
    ].filter((g) => passedThen.has(g));
    return failing.length > 0
      ? `${failing.join(", ")} passed at Review (${snapshot.id}) and fail${failing.length === 1 ? "s" : ""} now`
      : undefined;
  }

  /**
   * What a budget stop should say to the person who set the budget (L22).
   *
   * "A diagnosis without a remedy is an unfinished stop reason": name the cap,
   * what it bought, and the one decision left — raise it, or split the card.
   */
  private budgetDiagnosis(
    stopReason: ExecutionStopReason,
    spent: { tokens: number; seconds: number; steps: number },
    detail?: BudgetDetail,
  ): string {
    const { card } = this.options;
    // Rule 31a, WL-T3-12: context pressure is not a step budget, and raising
    // the step budget cannot help it.
    if (detail?.budget === "context") {
      return `The prompt reached 95% of its budget: ${detail.zone} needed ${detail.tokens} tokens against a cap of ${detail.cap}. Split card ${card.id} or narrow its scope.`;
    }
    const scope = card.scopeFiles.length > 0 ? card.scopeFiles.join(", ") : "its declared scope";
    const remedy = `Raise the budget on card ${card.id}, or split it: ${spent.steps} steps over ${scope} were not enough.`;
    if (stopReason === "token_budget_exhausted") {
      const cap = this.options.tokenBudget ?? card.tokenBudget;
      return `Spent its token budget (${spent.tokens} of ${cap}) after ${spent.steps} steps without reaching the gates. ${remedy}`;
    }
    if (stopReason === "time_budget_exhausted") {
      const cap = this.options.secondsBudget ?? card.secondsBudget;
      return `Ran out of wall-clock time (${spent.seconds}s of ${cap}s) after ${spent.steps} steps without reaching the gates. ${remedy}`;
    }
    return `Used every step of its budget (${spent.steps} of ${card.stepBudget}) without declaring the work done. ${remedy}`;
  }

  /**
   * The person's next action for a parking stop that is neither a budget nor
   * the repair ladder (rule 31): the table's next action, with the detail
   * stored beside the reason. Undefined leaves the ladder's own diagnosis.
   */
  /**
   * The gates this runner knows of, by id: the declared gates and the project
   * gates the caller wraps around the runner. The session adds the gates it
   * runs itself (bounds, integrity, hooks, the built-in layers) from the same
   * sources that emit their ids (GT-M6-5).
   */
  private suspectableGates(): string[] {
    // Only the declared gates of the rungs this attempt verifies (and the
    // default gate for a requested rung the project did not declare), as the
    // runner selects them.
    const rungs = new Set(this.options.gateRungs ?? this.verifiedRungs());
    const declared = this.config.gates.filter((g) => rungs.has(g.rung));
    const defaults = DEFAULT_GATES.filter(
      (g) => rungs.has(g.rung) && !declared.some((d) => d.rung === g.rung),
    );
    return [
      ...new Set([
        ...declared.map((g) => g.id),
        ...defaults.map((g) => g.id),
        ...(this.options.projectGateIds ?? []),
      ]),
    ].sort();
  }

  /**
   * The rungs the card's verification runs: every blocking gate the project
   * declares (lint included, as the spec requires); under --restricted only
   * the static layer, since executing the repo's tests would execute its code
   * (S12).
   */
  private verifiedRungs(): GateRung[] {
    // The same rungs `sekhemet gate <card>` verifies (GT-T1-1).
    return verificationRungs(this.config.gates, this.options.restricted === true);
  }

  private parkDetail(
    stopReason: ExecutionStopReason,
    detail: Record<string, unknown> | undefined,
  ): string | undefined {
    const row = STOP_REASONS[stopReason];
    // The repair ladder's own stops keep the session's ladder diagnosis.
    if (row.class === "capability_ceiling" && row.mayVerify) return undefined;
    if (stopReason === "hook_veto" && detail) {
      return `Vetoed by ${String(detail.hook)}: ${String(detail.reason)}. ${row.nextAction}`;
    }
    if (stopReason === "gate_suspected" && detail) {
      return `The Worker suspects the ${String(detail.gate)} gate: ${String(detail.reason)}. ${row.nextAction}`;
    }
    if (stopReason === "git_metadata_tampered" && this.tampered) {
      return `${this.tampered.slice(0, 300)} ${row.nextAction}`;
    }
    return row.nextAction;
  }

  /** G12 refused the card: record why, park it, and return without a turn. */
  private async finishVacuous(
    worktreePath: string,
    attempt: number,
    started: number,
    failToPass: FailToPassReport,
  ): Promise<CardRunResult> {
    const { card } = this.options;
    const parked: ParkDiagnosis = {
      cardId: card.id,
      stopReason: "vacuous_tests",
      attempts: 0,
      replanned: false,
      failures: [],
      filesWritten: [],
      lessons: [],
      // The strength check names what is wrong (a stand-in, a smell); without
      // it, the tests passed on the untouched code.
      suggestion: failToPass.testStrength?.verdict.stopReason
        ? failToPass.detail
        : `Rewrite ${failToPass.tests.join(", ")} so they fail until this card's behaviour exists; as staged they pass already.`,
    };
    this.emit({ type: "status", cardId: card.id, message: `vacuous tests: ${failToPass.detail}` });
    return this.finish({
      worktreePath,
      attempt,
      started,
      turns: [],
      stopReason: "vacuous_tests",
      lastGateResult: undefined,
      checkpointShas: [],
      stepsUsed: 0,
      failToPass,
      parkWith: parked,
    });
  }

  /**
   * Rule 6b refused the card before any step: a characterize, refactor or
   * upgrade card's tests fail on the base, or a build-repair card's build
   * already succeeds. Record why, park it, and return without a turn.
   */
  private async finishRefused(
    worktreePath: string,
    attempt: number,
    started: number,
    failToPass: FailToPassReport,
  ): Promise<CardRunResult> {
    const { card } = this.options;
    // A green-first card's tests failing on the base, or a build-repair card
    // whose build already succeeds (not red).
    const stopReason = failToPass.stopReason ?? "base_not_green";
    const parked: ParkDiagnosis = {
      cardId: card.id,
      stopReason,
      attempts: 0,
      replanned: false,
      failures: [],
      filesWritten: [],
      lessons: [],
      suggestion: failToPass.detail,
    };
    this.emit({
      type: "status",
      cardId: card.id,
      message: `red-first refused: ${failToPass.detail}`,
    });
    return this.finish({
      worktreePath,
      attempt,
      started,
      turns: [],
      stopReason,
      lastGateResult: undefined,
      checkpointShas: [],
      stepsUsed: 0,
      failToPass,
      parkWith: parked,
    });
  }

  /**
   * Evidence, actuals, dossier and the final column move, for every way a
   * run can end.
   */
  private async finish(params: {
    worktreePath: string;
    attempt: number;
    started: number;
    turns: TurnResult[];
    stopReason: ExecutionStopReason;
    lastGateResult: GateResult | undefined;
    checkpointShas: string[];
    stepsUsed: number;
    session?: CardExecutionSessionImpl;
    failToPass?: FailToPassReport;
    resumedFrom?: { step: number; gitRef: string };
    heldBeforeStart?: string;
    parkWith?: ParkDiagnosis;
    sampleSteps?: number[];
    stopDetail?: Record<string, unknown>;
  }): Promise<CardRunResult> {
    const { card, syncAdapter, lifecycle, store } = this.options;
    const { turns, stopReason, session, attempt } = params;

    this.writeTranscript(card.id, turns);
    session?.dispose();
    await this.options.hooks
      ?.emit("card/end", { cardId: card.id, data: { stopReason, attempt: params.attempt } })
      .catch(() => undefined);
    await this.egress?.close().catch(() => undefined);
    await this.generatorEgress?.close().catch(() => undefined);
    await lifecycle?.recordSteps?.(card.id, params.stepsUsed);

    // Bounds are checked against the real diff, which is why the git adapter
    // computes stats: the limit is meaningless without a measured diff.
    let stats = { filesTouched: [] as string[], linesAdded: 0, linesRemoved: 0 };
    let diff = "";
    try {
      const rawStats = await syncAdapter.getDiffStats(card.id, this.options.baseBranch ?? "main");
      // Acceptance tests are staged by the harness, not written by the agent, so
      // they do not count against the card's size bounds. They stay in the diff.
      const staged = new Set((card.acceptanceTests ?? []).map((t) => `tests/${t}`));
      const own = (rawStats.perFile ?? []).filter((f) => !staged.has(f.file));
      stats = rawStats.perFile
        ? {
            filesTouched: own.map((f) => f.file),
            linesAdded: own.reduce((n, f) => n + f.added, 0),
            linesRemoved: own.reduce((n, f) => n + f.removed, 0),
          }
        : rawStats;
      diff = await syncAdapter.generateDiff(card.id, this.options.baseBranch ?? "main");
    } catch (err) {
      // No measurable diff (no worktree yet): the evidence says so by being empty.
      if (isTampered(err)) this.tampered = refusalReason(err);
    }

    const gateResult = params.lastGateResult ?? {
      passed: false,
      failures: [],
      durationMs: 0,
      rungResults: [],
    };

    let promptTokens = 0;
    let completionTokens = 0;
    for (const turn of turns) {
      promptTokens += turn.usage?.promptTokens ?? 0;
      completionTokens += turn.usage?.completionTokens ?? 0;
    }
    const durationMs = Math.max(0, this.now() - params.started);

    // E3: every setting the result depends on (quant, engine, sampling,
    // KV type, MTP, arm) and the commit it ran at.
    const settings: RunSettings = {
      ...candidateSettings(this.options.modelAdapter),
      modelId: this.options.modelAdapter.modelId,
      toolArm: this.options.toolArm ?? this.options.modelAdapter.preferredToolArm ?? "arm_a_flat",
      // MD-M4-2: the harness's own commit and built output, never the card's repository.
      // The short form evidence has always carried; `card/repro` keeps the full commit.
      harnessCommit:
        harnessProvenance().commit === "unknown"
          ? "unknown"
          : harnessProvenance().commit.slice(0, 12),
      harnessDirty: harnessProvenance().dirty,
      harnessDistSha: harnessProvenance().distSha,
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      thinking: this.options.thinking ?? "off",
      workerMethod: this.options.workerMethod ?? "baseline",
      // Rule 27 and WL-N9-4: every bundle records the evidence-gate switch.
      evidenceGate: this.options.evidenceGate ?? "off",
      isolation: (this.options.sandbox ?? new ProcessSandbox()).confinement,
      // WL-M2-5 and WL-M3-5: the tool arm and the attempt's prompt budget W.
      ...(session ? { toolSet: session.getToolSetArm() } : {}),
      ...(session?.getPromptBudget() !== undefined
        ? { promptBudgetTokens: session.getPromptBudget() }
        : {}),
    } as RunSettings;
    // WL-T3-1, WL-M3-4, WL-M2-5: every step's phase, tokens, finish reason,
    // format errors and prose-only replies.
    const steps: StepEvidence[] = turns.map((t) => ({
      step: t.turnIndex,
      sample: t.sample ?? 1,
      ...(t.phase ? { phase: t.phase } : {}),
      promptTokens: t.usage?.promptTokens ?? 0,
      ...(t.usage?.thinkingTokens !== undefined ? { thinkingTokens: t.usage.thinkingTokens } : {}),
      ...(t.usage?.answerTokens !== undefined ? { answerTokens: t.usage.answerTokens } : {}),
      ...(t.finishReason ? { finishReason: t.finishReason } : {}),
      formatErrors: t.formatErrors ?? 0,
      proseOnly: t.proseOnly ?? 0,
      ...(t.truncated ? { truncated: t.truncated } : {}),
      ...stepUsage(t.usage),
    }));

    // RG-S5-6: the state the gates ran on, which Accept compares with the branch.
    const repoState = await syncAdapter.getRepoStateHash(card.id).catch(() => undefined);
    const trajectoryRef =
      store?.runs && this.attemptId ? store.runs.trajectoryHash(this.attemptId) : undefined;
    const evidence = compileEvidence({
      cardId: card.id,
      attempt,
      diff,
      filesTouched: stats.filesTouched,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
      gateResult,
      turnsUsed: params.stepsUsed,
      stopReason,
      checkpointShas: params.checkpointShas,
      tokens: { promptTokens, completionTokens },
      durationMs,
      settings,
      gatesConfigSha256: this.config.sha256,
      // A test gap found at an advisory level goes to a person in Review,
      // never to the Worker (GT-TQ-12).
      ...((session?.getAdvisories().length ?? 0) +
        (params.failToPass?.testStrength?.testGaps.length ?? 0) >
      0
        ? {
            advisories: [
              ...(session?.getAdvisories() ?? []),
              ...(params.failToPass?.testStrength?.testGaps ?? []),
            ],
          }
        : {}),
      ...(params.failToPass?.testStrength ? { testStrength: params.failToPass.testStrength } : {}),
      // Rule 34: every test quarantined on the card, counted, for suite comparisons.
      quarantined: quarantinedTests(params.worktreePath),
      // GT-T1-9: the SHA-256 of the attempt's event-log slice, which the
      // ledger recomputes; the transcript is kept by path beside it.
      ...(trajectoryRef ? { trajectoryRef } : {}),
      ...(this.transcriptPath ? { transcriptPath: this.transcriptPath } : {}),
      ...(steps.length > 0 ? { steps } : {}),
      ...(params.sampleSteps ? { sampleSteps: params.sampleSteps } : {}),
      ...(params.stopDetail ? { stopDetail: params.stopDetail } : {}),
      ...(repoState ? { repoState } : {}),
      ...(this.options.configOverrides?.length
        ? { configOverrides: this.options.configOverrides }
        : {}),
      // EXT-10, EXT-22a, EXT-25: extension facts, left out when there are none.
      extensions: {
        ...(this.options.hookErrors?.length ? { hookErrors: this.options.hookErrors } : {}),
        ...(session && session.getSkillReport().omitted.length > 0
          ? { skillsOmitted: session.getSkillReport().omitted }
          : {}),
        ...(session && session.getSkillReport().truncated.length > 0
          ? { skillsTruncated: session.getSkillReport().truncated }
          : {}),
      },
    });
    const written = this.writeEvidence(evidence);

    const passed = stopReason === "gate_passed" && gateResult.passed;
    const tokensUsed = promptTokens + completionTokens;
    const secondsUsed = Math.round(durationMs / 1000);

    // What this attempt learned goes into the card's dossier for the next one.
    if (store && session) {
      const writes: Promise<unknown>[] = [];
      // Notes went to the dossier as they were written (L11, `onNote`).
      if (!passed) {
        for (const line of session.getLessons().lines.slice(0, 6)) {
          if (line.startsWith("from an earlier attempt:")) continue;
          writes.push(
            store.recordDossierEntry({ cardId: card.id, kind: "lesson", text: line, attempt }),
          );
        }
      }
      await Promise.allSettled(writes);
    }

    // The attempt is closed, with its stop reason on the ledger, before the
    // card moves: Verify takes a finished attempt (kernel rule 27, K-S4-6).
    await this.closeAttempt({
      passed,
      stopReason,
      tokensUsed,
      secondsUsed,
      evidence,
      written,
      stepsUsed: params.stepsUsed,
      ...(session
        ? {
            rung: session.getHighestRung(),
            ruleIds: session.getRulesUsed(),
            exemplarIds: session.getExemplarsUsed(),
          }
        : {}),
    });

    // The final column. Every finished card enters Verify first: that is the
    // column the state machine routes through, and it is where back-pressure
    // is applied. Only then does a passing card move to Review for a human.
    // A refused move holds the card with its reason (defect 1); it never
    // throws out of the runner.
    let finalStatus: CardStatus = card.status;
    let held: { reason: string; wanted: CardStatus } | undefined;
    let parked = params.parkWith;
    let replan: ReplanRequest | undefined;
    let regression: string | undefined;
    let reviewWait: string | undefined;

    if (params.heldBeforeStart) {
      held = { reason: params.heldBeforeStart, wanted: "in_progress" };
    } else if (parked) {
      // Vacuous tests: parked before any work.
      const moved = await this.move("parked");
      finalStatus = moved.ok ? "parked" : card.status;
      if (!moved.ok) held = { reason: moved.reason, wanted: "parked" };
    } else {
      finalStatus = "in_progress";
      // A budget stop parks the card (L22) only when it never reached the
      // gates. One that did has a verdict to re-plan against, and a typed
      // failure is worth more to the human than "out of budget".
      const row = STOP_REASONS[stopReason];
      const budgetStop = row.parks === "unless_gates_ran";
      const parks = row.parks === "yes" || (budgetStop && !params.lastGateResult);
      if (parks && session) {
        parked = session.getParkDiagnosis(
          stopReason,
          budgetStop
            ? this.budgetDiagnosis(
                stopReason,
                { tokens: tokensUsed, seconds: secondsUsed, steps: params.stepsUsed },
                params.stopDetail as BudgetDetail | undefined,
              )
            : this.parkDetail(stopReason, params.stopDetail),
        );
        const moved = await this.move("parked");
        if (moved.ok) finalStatus = "parked";
        else held = { reason: moved.reason, wanted: "parked" };
      } else if (stopReason === "paused") {
        // WL-N10-2: it keeps In Progress, its branch and its checkpoint until
        // a person hands it back or takes it over.
      } else if (stopReason === "rebase_conflict" && this.rebaseConflict && session) {
        // RG-N1-2 (outside the scope) and RG-N1-3 (unresolved): parked for a person.
        const { conflict, route } = this.rebaseConflict;
        const decision =
          route === "unresolved" ? await this.requestRebaseDecision(conflict) : undefined;
        parked = session.getParkDiagnosis(
          stopReason,
          route === "parked"
            ? `Rebasing onto ${conflict.onto} conflicts in ${conflict.outOfScope.join(", ")}, outside this card's scope (${conflict.files.join(", ")} in all); a person decides how the two changes combine.`
            : `The Worker's budget ended with the conflict in ${conflict.files.join(", ")} unresolved${decision ? `; decision ${decision} asks which change gives way` : ""}.`,
        );
        const moved = await this.move("parked");
        if (moved.ok) finalStatus = "parked";
        else held = { reason: moved.reason, wanted: "parked" };
      } else if (stopReason === "rebase_conflict") {
        const moved = await this.move("planning");
        if (moved.ok) finalStatus = "planning";
        else held = { reason: moved.reason, wanted: "planning" };
      } else if (stopReason === "replan_requested" && session) {
        replan =
          session.getReplanRequest() ??
          (this.crossValidation
            ? {
                cardId: card.id,
                attempts: this.samplesTried,
                failures: [],
                filesWritten: session.getFilesWritten(),
                lessons: [],
                summary: `Two passing attempts disagree: ${this.crossValidation}. The specification is ambiguous; re-plan the card.`,
              }
            : undefined);
        // A card that needs a new plan goes back to Planning, not to Verify.
        const moved = await this.move("planning");
        if (moved.ok) finalStatus = "planning";
        else held = { reason: moved.reason, wanted: "planning" };
      } else {
        const toVerify = await this.move("verify");
        if (!toVerify.ok) {
          held = { reason: toVerify.reason, wanted: "verify" };
        } else {
          finalStatus = "verify";
          const scope = passed ? await this.scopeChangedSince(this.runStartedAt) : undefined;
          if (scope) {
            // INT-11a: the tracker changed the scope or the criteria while the
            // card ran — the result answers the old question, so it is
            // re-planned against the edited issue instead of reviewed.
            const moved = await this.move("planning", scope);
            if (moved.ok) finalStatus = "planning";
            else held = { reason: moved.reason, wanted: "planning" };
          } else if (passed) {
            // RG-P8-1: the AI review reads the change before a person sees it.
            reviewWait = await lifecycle?.awaitReview?.(card.id);
            if (!reviewWait) {
              const toReview = await this.move("review");
              if (toReview.ok) finalStatus = "review";
              else held = { reason: toReview.reason, wanted: "review" };
            }
          } else if (params.lastGateResult) {
            // B2: the state machine's `Verify --> Planning: gate fail, replan`.
            // A card whose gates ran and failed needs a new plan, and Verify is
            // where that is decided; leaving it there makes Verify a place
            // cards accumulate rather than a transition they pass through.
            // G23 names the regression when one of them passed at Review.
            regression = this.regressionAgainstReview(gateResult);
            // K-N5-4: the move's recorded reason names each regressed gate
            // and the evidence it passed in.
            const moved = await this.move(
              "planning",
              regression ? `regression: ${regression}` : undefined,
            );
            if (moved.ok) finalStatus = "planning";
            else held = { reason: moved.reason, wanted: "planning" };
          }
        }
      }
    }

    if (parked && store) {
      try {
        await store.recordEvent({
          type: "card/parked",
          cardId: card.id,
          actor: "executor",
          payload: parked,
        });
      } catch {
        // The diagnosis also rides on blockedReason below.
      }
    }

    // The card record's actuals (defect 8): why it stopped, what it cost,
    // and where its evidence is. Tokens and seconds accumulate over attempts.
    if (store) {
      const blockedReason = held
        ? `held: ${held.reason}`
        : parked
          ? `parked: ${parked.suggestion}`
          : replan
            ? `re-plan requested: ${replan.summary.slice(0, 300)}`
            : regression
              ? `regression: ${regression}`
              : this.rebaseFailure
                ? `rebase conflict: ${this.rebaseFailure}`
                : (reviewWait ?? null);
      try {
        await store.updateCard(
          card.id,
          {
            stopReason,
            tokensUsed: (card.tokensUsed ?? 0) + tokensUsed,
            secondsUsed: (card.secondsUsed ?? 0) + secondsUsed,
            evidenceId: evidence.id,
            stepsUsed: params.stepsUsed,
            // The last context pack the Worker saw (K22, K26).
            ...(this.packIds.length > 0 ? { contextPackId: this.packIds.at(-1) as string } : {}),
            // A lifecycle hold already wrote its own reason.
            ...(held && lifecycle?.hold ? {} : { blockedReason }),
          },
          "executor",
        );
      } catch (err) {
        this.emit({
          type: "status",
          cardId: card.id,
          message: `actuals not recorded: ${refusalReason(err)}`,
        });
      }
    }

    return {
      cardId: card.id,
      passed,
      stopReason,
      turns,
      evidence,
      checkpointShas: params.checkpointShas,
      worktreePath: params.worktreePath,
      finalStatus,
      lessons: session?.getLessons() ?? { lines: [], struggles: [] },
      rulesUsed: session?.getRulesUsed() ?? [],
      attempt,
      tokensUsed,
      secondsUsed,
      ...(session ? { condensedTokensSaved: session.getCondensedTokensSaved() } : {}),
      ...(held ? { held } : {}),
      ...(parked ? { parked } : {}),
      ...(replan ? { replan } : {}),
      ...(params.failToPass ? { failToPass: params.failToPass } : {}),
      ...(params.resumedFrom ? { resumedFrom: params.resumedFrom } : {}),
    };
  }
}
