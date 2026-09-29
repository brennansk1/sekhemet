import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { type BoardServiceImpl, legalPath } from "@sekhemet/board";
import {
  type CondensingSummary,
  ExemplarStore,
  LSP_RESIDENT_CAP_BYTES,
  LspPool,
  PlaybookRegistry,
  SkillsRegistry,
  mergeCondensing,
  summarizeCondensing,
  useFileEvidenceStore,
} from "@sekhemet/context";
import { LearningGuard, type RunProfile, harvestExemplars } from "@sekhemet/eval";
import {
  DeterministicGateRunner,
  type SourceIndex,
  compileEvidence,
  loadGatesConfig,
  npmRegistry,
} from "@sekhemet/gates";
import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  type DependencyReason,
  type EventLog,
  type RetentionReport,
  cardClassOf,
} from "@sekhemet/kernel";
import {
  type CardRunResult,
  CardRunner,
  type FailToPassReport,
  type ToolCallEvent,
  type TurnResult,
  calibratedStepBudget,
} from "@sekhemet/loop";
import {
  type CacheSummary,
  type LocalInferenceAdapter,
  type MemoryWatchdog,
  type ModelEntry,
  ModelRegistry,
  type ServerProps,
  type ThroughputStats,
  checkExecutionHeadroom,
  readSwapUsedBytes,
  thinkingPolicyFromEnv,
} from "@sekhemet/models";
import { type SpidrSliceKind, scoreDifficulty, stepBudgetForDifficulty } from "@sekhemet/planner";
import { confinedSandbox, mergeNetworkConfigs, policyFetch } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { integrationBranch } from "./accept.js";
import { isAirgapped, mirrorRegistry } from "./airgap.js";
import { baselineInput, cardGateRunner, gateBaseBranch } from "./card_gates.js";
import { cardOneTests, cardZeroSteps, withoutCardOneStaging } from "./card_zero.js";
import {
  lastPauseSeq,
  messageLabel,
  pendingPause,
  recordDelivered,
  undeliveredMessages,
} from "./collaborate.js";
import { configOverrideLines, networkConfigs } from "./config_apply.js";
import { egressEvent } from "./egress_event.js";
import type { evidenceSummary } from "./evidence_summary.js";
import {
  decideEgress,
  egressRecorder,
  githubTransport,
  remoteDestination,
} from "./github_transport.js";
import { readSettings } from "./integrations.js";
import { RULE_SIGNAL_MINIMUM, learnFromAttempt } from "./learning/reflect.js";
import { playbookRuleOf, standingErrorCode } from "./learning/scoping.js";
import { type LearningStore, RULES_PER_PROMPT } from "./learning/store.js";
import { recordLedgerRun } from "./ledger_evidence.js";
import { withLiveGate } from "./live_gate.js";
import { loadBaseline, recordBaselineShrink } from "./onboard.js";
import { buildReproRecord } from "./repro.js";
import { workerWebDocs } from "./research/service.js";
import { Tracer, toolCallSpan, traced } from "./tracing.js";
import { hookEngineFor } from "./user_hooks.js";
import { cardVision } from "./vision_check.js";
import { PR_EVENT, openPullRequestViaApp, prBody } from "./wave2_github.js";
import { loadRepoSkills, untrustedFiles } from "./workspace_trust.js";

/** The repo's trace store, or none when it cannot be opened (tracing never blocks a card). */
function openTracer(repoPath: string): Tracer | undefined {
  try {
    return Tracer.forRepo(repoPath);
  } catch {
    return undefined;
  }
}

/**
 * Whether the registry marks the Worker model script-capable (WL-M2-4): only
 * then is `run_script` offered. An unreadable registry means no.
 */
export function workerScriptCapable(modelId: string, registryPath?: string): boolean {
  try {
    return new ModelRegistry(registryPath).get(modelId)?.scriptCapable === true;
  } catch {
    return false;
  }
}

/** SEKHEMET_THINKING=off|surgical|all; anything else is the default, off. */
export function thinkingPolicy(): "off" | "surgical" | "all" {
  return thinkingPolicyFromEnv();
}

export interface ExecutionContext {
  repoPath: string;
  restrictedMode: boolean;
  cardStore: CardStore;
  boardService: BoardServiceImpl;
  log?: (line: string) => void;
  /**
   * Awaited after every Worker turn, between steps. The queue uses it to
   * answer PM messages: it is the one point where the Worker can be unloaded
   * without losing work, because the next step starts from the worktree.
   */
  afterTurn?: (cardId: string, turn: TurnResult) => Promise<void>;
  /** The learning store: active rules go into the prompt, outcomes come back. */
  learning?: LearningStore;
  /** Rules learned this run from verified signals: in force for the run. */
  runRules?: Set<string>;
  /**
   * The run's one resolved settings object (measurement MS-M9-4): its
   * switches are what the card runs with, and it is written into every
   * attempt's reproducibility record. Absent, the switches come from the
   * environment as before.
   */
  runProfile?: RunProfile;
  /** The measured run that prepared this repository, when one did (review M5). */
  measurement?: { purpose: string; by: string; createdAt: string };
  /**
   * Gates rule 6a (lead ruling): the staged acceptance tests' origin for this
   * run — a benchmark names them external, as the frozen suite does — set on
   * the run, never in the process's environment (B4.1 half-B review).
   */
  acceptanceTestsOrigin?: "external";
  /** One paragraph on who is on the team right now (from the residency plan). */
  teamNote?: () => string;
  /**
   * Route a Worker question the card's contract cannot answer to the team.
   * `questionEntryId` is the question's dossier entry, so an answer filed
   * later (`QueuedWorkerQuestions`) threads under it.
   */
  askTeam?: (
    cardId: string,
    question: string,
    meta: { questionEntryId?: string },
  ) => Promise<string | undefined>;
  /**
   * The memory watchdog (M20). While it says to pause, no new turn starts:
   * the runner waits for pressure to fall, then stops the card resumably
   * with `memory_pressure` if it does not.
   */
  watchdog?: Pick<MemoryWatchdog, "shouldPauseTurns" | "waitUntilBelow">;
  /** How long a paused card waits for the watchdog before it stops. Default 120 s. */
  watchdogWaitMs?: number;
  /**
   * How long an ask-tier command waits for a person's answer on the
   * dashboard's decision queue (K20, S8) before it is refused. Default 60 s;
   * 0 refuses at once but still records the request.
   */
  approvalTimeoutMs?: number;
  /** `false` skips the per-turn swap-growth headroom check (the watchdog still applies). */
  headroomCheck?: boolean;
  /** One language-server pool per run, for the symbol tools on non-TS files (C2). */
  lspPool?: LspPool;
  /** Decoded tokens as they stream, for the dashboard's live step view (M2). */
  onToken?: (cardId: string, delta: string) => void;
  /**
   * Loads a qualified vision model for the visual gate's checklist (GT-N4-2),
   * on its first question. Absent, a qualified model is named in the
   * evidence as not loadable in this run.
   */
  loadVisionModel?: (model: string) => Promise<LocalInferenceAdapter>;
  /** The registry's vision models; default the model registry's (tests pass their own). */
  visionModels?: () => ModelEntry[];
  /**
   * Teams TEAM-16: why the Agent may no longer work on this issue for the
   * person it works for (their level was lowered while it ran), checked
   * between steps; the card then stops as a person's stop would. Absent in
   * Solo, where the one person may always.
   */
  agentRefusal?: (cardId: string) => Promise<string | undefined>;
}

/**
 * The vision checklist for a card's visual layer (GT-N4-2): only a vision
 * model the registry records as qualified answers it; otherwise the evidence
 * says why none did. An unreadable registry qualifies none.
 */
export function visionForCard(ctx: ExecutionContext): ReturnType<typeof cardVision> {
  let models: ModelEntry[];
  try {
    models = ctx.visionModels ? ctx.visionModels() : new ModelRegistry().visionModels();
  } catch (err) {
    return {
      visionNotRun: `the model registry could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return cardVision(models, ctx.loadVisionModel);
}

/**
 * The ask permission tier (S8, defect 4): a decision request a person
 * answers on the dashboard (`POST /api/decisions/:id`). Allowed only on an
 * explicit "allow"; no answer in time is a refusal.
 */
export function decisionApprover(
  cardStore: Pick<CardStore, "runs">,
  cardId: string,
  timeoutMs: number,
  pollMs = 1000,
) {
  return async (request: {
    tool: string;
    reason: string;
    targetPath?: string | undefined;
    command?: string | undefined;
  }): Promise<boolean> => {
    const what = request.command ?? request.targetPath ?? request.tool;
    const decision = await cardStore.runs.requestDecision({
      cardId,
      kind: "permission",
      question: `Allow ${request.tool}: ${what}?`,
      context: request.reason,
      options: ["deny", "allow"],
      recommendationIndex: 0,
    });
    const answer = await cardStore.runs.awaitDecision(decision.id, { timeoutMs, pollMs });
    return answer === 1;
  };
}

/** Options for one run of `executeCard`. */
export interface ExecuteCardOptions {
  /**
   * Which attempt at this card this is. Default: one past the attempt in the
   * card's latest evidence, so a retry in a later queue run never poses as
   * attempt 1 (integration review item 9).
   */
  attempt?: number;
  /** Stops the card before its next turn with `human_abort` (L25). */
  signal?: AbortSignal;
  /** A cap on the card's step budget (`queue --max-turns`), applied after planning. */
  maxSteps?: number;
  /** The card's slot lease number, its server slot (RUN-35, models rule 20i). */
  serverSlot?: number;
  /**
   * Smart Swap's step boundary (models rule 20e, C8): the residency
   * scheduler's `beginStep` for the queue the card runs on. Each step waits
   * for it and ends it, so a decided swap drains at the boundary.
   */
  beginStep?: () => Promise<() => void>;
  /**
   * review-git RG-P8-1: asked when the card passes, before it moves to
   * Review. A reason keeps it in Verify, waiting for the AI review
   * (`ReviewFlow.decide`); undefined moves it on.
   */
  reviewFirst?: (cardId: string) => Promise<string | undefined>;
}

/**
 * The repository's project row (K14): every card created without one joins
 * it, and the board scopes to it (B8).
 */
export async function ensureRepoProject(cardStore: CardStore, repoPath: string) {
  return cardStore.ensureProject({ rootPath: repoPath, name: basename(repoPath) || repoPath });
}

/** The attempt after the one in the card's latest evidence bundle (1 when none). */
export function nextAttemptNumber(repoPath: string, cardId: string): number {
  try {
    const latest = JSON.parse(
      readFileSync(join(repoPath, ".sekhemet", "evidence", `latest-${cardId}.json`), "utf8"),
    ) as { attempt?: unknown };
    const n = typeof latest.attempt === "number" ? Math.floor(latest.attempt) : 0;
    return n >= 1 ? n + 1 : 1;
  } catch {
    return 1;
  }
}

/** What a tool call acted on, in a few characters: a path, a command, a note. */
function callTarget(args: Record<string, unknown> | undefined): string | undefined {
  const a = args ?? {};
  const pick = a.path ?? a.file ?? a.command ?? a.cmd ?? a.message ?? a.query;
  if (pick === undefined || pick === null) return undefined;
  const text = typeof pick === "string" ? pick : JSON.stringify(pick);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * The `card/step` ledger payload for one turn (FRONTEND_DESIGN §2.6): enough
 * for the dashboard to say "Step 5 of 32 · editing src/hasher.ts" live and to
 * render the Steps tab before the transcript is written at the end.
 */
export function stepEventPayload(cardId: string, turn: TurnResult) {
  return {
    id: cardId,
    turn: turn.turnIndex,
    calls: turn.toolCalls.map((c, i) => {
      const target = callTarget(c.arguments as Record<string, unknown> | undefined);
      const obs = turn.observations[i];
      return {
        name: c.name,
        ...(target !== undefined ? { target } : {}),
        ...(obs ? { ok: obs.ok, summary: String(obs.summary ?? "").slice(0, 200) } : {}),
      };
    }),
    ...(turn.gateResult
      ? {
          gate: {
            passed: turn.gateResult.passed,
            failed: [...new Set(turn.gateResult.failures.map((f) => String(f.gate ?? f.rung)))],
            errors: turn.gateResult.failures.length,
          },
        }
      : {}),
    ...(turn.usage ? { usage: turn.usage } : {}),
    ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    // The stored prompt this step's request carried (K11, K26).
    ...(turn.contextPackId ? { contextPackId: turn.contextPackId } : {}),
    // Per-zone tokens, prefix hashes and pressure of that prompt (C14, C20).
    ...(turn.contextReport ? { context: turn.contextReport } : {}),
  };
}

/**
 * Run one card end to end on a caller-supplied model.
 *
 * The model is a parameter rather than created here so a queue of cards can
 * share one resident checkpoint. Reloading per card costs ~258s on the
 * reference machine, which across six cards alone exceeds the 18-minute
 * Chronicle budget.
 */
export async function executeCard(
  ctx: ExecutionContext,
  inputCard: CardRecord,
  model: LocalInferenceAdapter,
  managerGuidance?: string,
  options: ExecuteCardOptions = {},
): Promise<CardRunResult> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  // Rule 10: a measured run's fixed sampling seed, on the card's model; set
  // on every card, so a seed never carries over to one that names none, and
  // refused when the model cannot take one (review minor 2).
  const seed = ctx.runProfile?.switches.seed;
  const setSeed = (model as { setSeed?: (n: number | undefined) => void }).setSeed;
  if (seed !== undefined && typeof setSeed !== "function")
    throw new Error(
      `the RunProfile fixes the sampling seed at ${seed}, but ${model.modelId} cannot take one`,
    );
  setSeed?.call(model, seed);
  // Pulled through Planning (B2): difficulty scored (K25), budget set from
  // this repo's measured history (L21), then the runner moves it on.
  let card = await pullThroughPlanning(ctx, inputCard, model.modelId, log).catch(() => inputCard);
  // DS-P2-3: card one's test is the Worker's to write, in its scope: never
  // staged, protected or checked red-first, whatever an older plan said.
  card = withoutCardOneStaging(card);
  if (options.maxSteps && options.maxSteps > 0 && card.stepBudget > options.maxSteps) {
    card = { ...card, stepBudget: options.maxSteps };
  }
  // The attempts table (K16) and the evidence files both count attempts.
  const attempt =
    options.attempt ??
    Math.max(
      nextAttemptNumber(ctx.repoPath, card.id),
      ctx.cardStore.runs.nextAttemptNumber(card.id),
    );
  // Masked and condensed observations persist under the main repository, so
  // recall(ref) still works after a restart and after the worktree is gone (C6).
  useFileEvidenceStore(ctx.repoPath);
  // The Planner's repair plan is what attempt 2 runs on; keep it in the ledger
  // so the card's Plan tab can show what the Worker was told.
  if (managerGuidance) {
    try {
      await ctx.cardStore.recordEvent({
        type: "card/repair_plan",
        cardId: card.id,
        actor: "planner",
        payload: { id: card.id, plan: managerGuidance, attempt },
      });
    } catch {
      // A ledger hiccup must not cost the retry.
    }
  }
  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);
  const gatesConfig = loadGatesConfig(ctx.repoPath);
  // The declared gates wrapped by the project gates, composed in one place
  // with `sekhemet gate <card>` (gates rule 8, T1).
  // The onboarding baseline (gates rule 15a, GT-BF-2): only failures the
  // card added count, and a baselined diagnostic it removed shrinks the
  // baseline once the card is accepted.
  const ledger = {
    getEventsByTypes: (types: string[]) => ctx.cardStore.eventsOfType(types),
    append: (p: { actor: string; type: string; payload: unknown }) =>
      ctx.cardStore.recordLedgerEvent(p),
  };
  const baseline = await loadBaseline(ledger).catch(() => undefined);
  // DB-N2-10: each check announced to the card's live gate file as it starts,
  // so the dashboard's badge names the running check (*Running Tests…*).
  const gateRunner = withLiveGate(
    cardGateRunner({
      repoPath: ctx.repoPath,
      gatesConfig,
      restricted: ctx.restrictedMode,
      card: withoutCardOneStaging(inputCard),
      ...(baseline
        ? {
            ...baselineInput(baseline),
            onBaselineShrink: (gone, gates) => recordBaselineShrink(ledger, gone, card.id, gates),
          }
        : {}),
    }),
    ctx.repoPath,
    card.id,
  );
  // C10 with S9: skills pinned in the user directory's lock, never one the
  // repository ships (SEC-31).
  const skills = loadRepoSkills(ctx.repoPath);
  const playbook = new PlaybookRegistry(ctx.repoPath);
  // Learned rules the human approved join the seeded playbook for this card,
  // in memory only (never written to playbook.toml). Kind and path match at
  // the card boundary; the error pattern and trigger gate stay scopes, so a
  // rule rides in the prompt only while its error and gate stand (context
  // rule 24b). Rules in force are rotated across comparable cards, and the
  // decision is on the ledger for their paired credit (CX-N4-6).
  if (ctx.learning) {
    const errorCode = standingErrorCode(ctx.cardStore.runs, card.id);
    const inForce = await ctx.learning.activeFor("worker", card, {
      ...(ctx.runRules ? { runRules: ctx.runRules } : {}),
      ...(errorCode ? { errorCode } : {}),
      measurement: ctx.measurement !== undefined,
      limit: Number.POSITIVE_INFINITY,
    });
    const rotated = await ctx.learning
      .rotate(
        inForce,
        { id: card.id, projectId: basename(ctx.repoPath), cardClass: cardClassOf(card) },
        Math.max(attempt, ctx.cardStore.runs.nextAttemptNumber(card.id)),
        { measurement: ctx.measurement !== undefined },
      )
      // The cap applies before the rotation (inside `rotate`): a rule the cap
      // cuts is neither with nor withheld; the credit's treatment arm reads
      // the attempt record's rule ids, the rules a step really carried.
      .catch(() => ({ inPrompt: inForce.slice(0, RULES_PER_PROMPT), withheld: [] as string[] }));
    for (const rule of rotated.inPrompt) {
      playbook.addTransientRule(playbookRuleOf(rule, card.title));
    }
  }

  const worktreePath = join(ctx.repoPath, ".sekhemet", "worktrees", card.id);
  const webDocs = await workerWebDocs(ctx.repoPath).catch(() => undefined);
  // DS-P2-1, -2: card zero's generator steps may reach their registry — never
  // on an air-gapped install, where nothing leaves the machine.
  const zeroSteps = cardZeroSteps(card);
  const declaredSteps =
    zeroSteps && isAirgapped(ctx.repoPath) ? { ...zeroSteps, registry: undefined } : zeroSteps;
  const hooks = hookEngineFor(ctx.repoPath);
  const hookEngine = hooks.engine;
  // S9: the repository's configuration that is not trusted does not run; say so.
  const untrustedConfig = untrustedFiles(ctx.repoPath);
  if (untrustedConfig.length > 0) {
    log(`   not trusted, so not run: ${untrustedConfig.join(", ")} (see \`sekhemet dev trust\`)`);
  }
  const baselineSwap = readSwapUsedBytes();
  // A rewind or fork the human asked for (H18, H19) sets where this run starts.
  const start = await pendingStartPoint(ctx.cardStore, card.id).catch(() => undefined);
  // Stop requests from the dashboard or `sekhemet abort` (L25) arrive through
  // the ledger; only those made after this run started count.
  const abort = new AbortController();
  options.signal?.addEventListener("abort", () => abort.abort(options.signal?.reason), {
    once: true,
  });
  const startedAtSeq =
    (await ctx.cardStore.cardEvents(card.id, [CONTROL_EVENTS.abortRequested])).at(-1)?.seq ?? 0;
  // WL-N10-1, -2: a person's messages, notes and pause reach the run through
  // the ledger too; messages no step has carried yet reach the first one.
  const pauseSinceSeq = await lastPauseSeq(ctx.cardStore, card.id).catch(() => 0);
  const handedIds = new Set<string>();
  /** Handed to the runner, recorded as delivered once a step's prompt has carried them. */
  let carried: string[] = [];
  const handMessages = async () => {
    const waiting = await undeliveredMessages(ctx.cardStore, card.id).catch(() => []);
    for (const m of waiting.filter((w) => !handedIds.has(w.id))) {
      runner.deliverMessage(m.text, messageLabel(m));
      handedIds.add(m.id);
      carried.push(m.id);
    }
  };
  // H22: spans for the card, each turn and each model call (.sekhemet/traces.db).
  const tracer = openTracer(ctx.repoPath);
  const cardSpan = tracer?.start("card.run", {
    "sekhemet.card.id": card.id,
    "sekhemet.attempt": attempt,
  });
  let turnStartedMs = Date.now();
  const tracedModel = tracer && cardSpan ? traced(model, tracer, () => cardSpan.context) : model;
  // RUN-45: each tool call becomes a span under its step's span, written when
  // the step's span is (the step ends after its calls).
  const toolCallsByStep = new Map<number, ToolCallEvent[]>();
  const nets = networkConfigs(ctx.repoPath);
  const networkPolicy = mergeNetworkConfigs(nets.user, nets.project);
  const runner = new CardRunner({
    onToolCall: (event) => {
      const list = toolCallsByStep.get(event.turnIndex) ?? [];
      list.push(event);
      toolCallsByStep.set(event.turnIndex, list);
    },
    card,
    repoRoot: ctx.repoPath,
    ...(options.serverSlot !== undefined ? { serverSlot: options.serverSlot } : {}),
    ...(options.beginStep ? { beginStep: options.beginStep } : {}),
    // RG-S5-14: cut from, rebased onto and diffed against the integration branch.
    baseBranch: gateBaseBranch(ctx.repoPath, gatesConfig),
    worktreePath,
    stepBudget: card.stepBudget,
    modelAdapter: tracedModel,
    gateRunner,
    // GT-M6-5: the project gates wrapped around the runner above, as the
    // wrappers name themselves, so the Worker's `note` can name one as wrong.
    projectGateIds: gateRunner.gateIds ?? [],
    syncAdapter: gitAdapter,
    scopeFiles: card.scopeFiles,
    // DS-P2-3: card one's deliverable is the test itself, so its Worker is
    // the test's author — an implementer may never write a test file — and
    // its scope (the test) bounds what it writes.
    agentRole: cardOneTests(card).length > 0 ? "test-author" : "implementer",
    agentHarness: "sekhemet",
    attempt,
    // A checkpoint after every step that wrote something: rewind and fork
    // (H18, H19) can then return to any step, not only every fifth.
    checkpointEvery: 1,
    // Checkpoints, actuals, holds, parks and the dossier persist here.
    store: ctx.cardStore,
    // The agent's own commands are confined as strictly as the gates (defect 3).
    requireConfinement: ctx.restrictedMode,
    // --restricted is a read-only audit: no run_cmd, no writes, static gates (S12).
    restricted: ctx.restrictedMode,
    // New dependencies are checked against the npm registry (existence, age),
    // answers cached under .sekhemet; offline it degrades to an advisory (S10).
    // Air-gapped: only mirrored packages exist (X10).
    // Registry lookups are the harness's own requests: through the one
    // network policy, each recorded on the ledger (security item 32, SEC-14).
    registry: isAirgapped(ctx.repoPath)
      ? mirrorRegistry(ctx.repoPath)
      : npmRegistry(ctx.repoPath, {
          fetchImpl: policyFetch(networkPolicy, {
            purpose: "supply-chain",
            // A lookup whose record fails fails too (security item 33).
            record: (r) =>
              ctx.cardStore.recordEvent({ ...egressEvent(r), cardId: card.id, actor: "system" }),
          }) as typeof fetch,
        }),
    // The card's sandboxed commands: the policy narrowed by gates.toml (item 30).
    networkPolicy,
    // GT-N4-2: the vision checklist only on a qualified vision model.
    vision: visionForCard(ctx),
    // Ask-tier commands wait for a person on the decision queue (S8, K20).
    onApproval: decisionApprover(ctx.cardStore, card.id, ctx.approvalTimeoutMs ?? 60_000),
    signal: abort.signal,
    ...(start?.startFrom ? { startFrom: start.startFrom } : {}),
    ...(start?.forkedFrom ? { forkedFrom: start.forkedFrom } : {}),
    // Stop before the host does: a paused card resumes, an OOM takes the
    // machine. The watchdog's pause is checked before every turn.
    memoryProbe: () => {
      // WL-N7-2: the language servers are a tenant the guard counts: over
      // their cap they are trimmed before the turn (they restart on demand).
      void (ctx.lspPool ?? runLspPool())
        .enforceResidentCap(LSP_RESIDENT_CAP_BYTES)
        .then((r) => {
          if (r.trimmed) {
            log(`   language servers held ${Math.round(r.residentBytes / 1024 ** 2)} MB: trimmed`);
          }
        })
        .catch(() => undefined);
      if (ctx.watchdog?.shouldPauseTurns()) {
        return {
          ok: false,
          reason: "the memory watchdog is holding new turns (critical pressure)",
        };
      }
      // Tests (and hosts whose swap moves for other reasons) can turn the
      // swap-growth check off; the watchdog above still applies.
      return ctx.headroomCheck === false ? { ok: true } : checkExecutionHeadroom(baselineSwap, {});
    },
    // A retry after a manager review re-attaches to the existing worktree, so
    // the worker resumes from its own last state rather than from scratch.
    useExistingWorktree: existsSync(worktreePath),
    ...(managerGuidance ? { managerGuidance } : {}),
    ...(ctx.teamNote ? { teamNote: ctx.teamNote() } : {}),
    ...(ctx.askTeam
      ? {
          askTeam: (q: string, meta?: { questionEntryId?: string }) =>
            ctx.askTeam?.(card.id, q, meta ?? {}) ?? Promise.resolve(undefined),
        }
      : {}),
    skillsRegistry: skills,
    // SUR-40: the card's own configuration layer, listed in its evidence.
    ...(configOverrideLines(card.configOverrides).length > 0
      ? { configOverrides: configOverrideLines(card.configOverrides) }
      : {}),
    // EXT-10: a hooks file that failed to load is named on the card's evidence.
    ...(hooks.errors.length > 0 ? { hookErrors: hooks.errors } : {}),
    // K12: the project's lifecycle hooks (.sekhemet/hooks.toml).
    hooks: hookEngine,
    // L10 tier 3: the library's official web docs, when web access is on.
    ...(webDocs ? { webDocs } : {}),
    // DS-P2-1, gates rule 12: card zero's generator steps are the tool's lines.
    ...(declaredSteps ? { declaredSteps } : {}),
    // C13: passing runs of this card's class, as worked examples.
    exemplarStore: new ExemplarStore(join(ctx.repoPath, ".sekhemet", "exemplars")),
    // C2: one language-server pool for the whole run (servers are pooled
    // across cards and shut down when idle).
    lspPool: ctx.lspPool ?? runLspPool(),
    // C19: the Worker's prompt carries the core tools' contracts and a
    // one-line index of the rest, which `tool_search` loads on demand. Every
    // turn used to carry all thirty schemas, and a card that never leaves
    // read/edit/check paid prefill for the other twenty-five on every step.
    // M2 (worker-loop rule 11): progressive by default; the RunProfile's
    // `fixed` arm offers the class's tool set at once.
    progressiveTools: (ctx.runProfile?.switches.toolArm ?? "progressive") === "progressive",
    // WL-M2-4: `run_script` only for a Worker the registry marks script-capable.
    scriptCapable: workerScriptCapable(model.modelId),
    // Where the Worker thinks: off (default), surgical or all. An experiment
    // setting until the frozen suite picks one; recorded in every bundle.
    thinking: ctx.runProfile?.switches.thinking ?? thinkingPolicy(),
    // The Worker's working method: baseline (default) or strict.
    workerMethod:
      ctx.runProfile?.switches.workerMethod ??
      (process.env.SEKHEMET_WORKER_METHOD === "strict" ? "strict" : "baseline"),
    // Worker-loop rule 29a: the evidence-gated commit, off unless named.
    evidenceGate:
      ctx.runProfile?.switches.evidenceGate ??
      (process.env.SEKHEMET_EVIDENCE_GATE === "on" ? "on" : "off"),
    // Gates rule 6a (lead ruling): the frozen suite names its staged tests
    // external, so its measurement never changes with a record; unnamed,
    // each staged file's origin is its own.
    ...(ctx.acceptanceTestsOrigin === "external" ||
    process.env.SEKHEMET_ACCEPTANCE_ORIGIN === "external"
      ? { acceptanceTestsOrigin: "external" as const }
      : {}),
    // M2: decoded tokens go to the card's live file, which the dashboard
    // streams while the step is still generating.
    onToken: ctx.onToken
      ? (d: string) => ctx.onToken?.(card.id, d)
      : liveTokenWriter(ctx.repoPath, card.id),
    playbookRegistry: playbook,
    lifecycle: {
      // Persist the real step count, or the board reports 0/32 for a card that
      // exhausted its budget.
      recordSteps: async (id, stepsUsed) => {
        await ctx.cardStore.updateCard(id, { stepsUsed });
      },
      transition: async (id, to, reason) => {
        const current = await ctx.cardStore.getCard(id);
        if (!current || current.status === to) return;
        await ctx.boardService.transitionCard({
          cardId: id,
          fromStatus: current.status,
          toStatus: to,
          actor: "executor",
          reason: reason ?? `the agent's run moved the issue to ${to}`,
        });
      },
      // A move the board refuses (back-pressure, WIP) holds the card with its
      // reason; `releaseHeldCards` retries it when Review drains (defect 1).
      hold: async (id, reason, awaiting) => {
        await ctx.boardService.holdCard(id, reason, "executor", awaiting);
      },
      ...(options.reviewFirst ? { awaitReview: options.reviewFirst } : {}),
    },
    onWorktreeReady: async (path) => {
      // Stage this card's acceptance tests: the oracle for THIS card is present
      // and failing before work begins, and later cards' suites are not there
      // to fail it.
      const staged = card.acceptanceTests ?? [];
      if (staged.length === 0) return;
      const testsDir = join(path, "tests");
      if (!existsSync(testsDir)) mkdirSync(testsDir, { recursive: true });
      for (const name of staged) {
        const from = join(ctx.repoPath, "acceptance", name);
        if (existsSync(from)) {
          copyFileSync(from, join(testsDir, name));
          log(`   staged acceptance test: tests/${name}`);
          // Gates rule 6a (lead ruling): the staged file by path and SHA-256.
          // Taken from the repository's acceptance/ directory, its author is
          // the repository's: only a Planner, test-author or PM carry-over
          // record for the same content makes it the card's own.
          await ctx.cardStore
            .recordEvent({
              type: "test/staged",
              cardId: card.id,
              actor: "executor",
              payload: {
                cardId: card.id,
                path: `tests/${name}`,
                sha256: createHash("sha256")
                  .update(readFileSync(join(testsDir, name)))
                  .digest("hex"),
                author: "repository",
              },
            })
            .catch(() => undefined);
        }
      }
    },
    // One ledger event per turn, so the board and the Steps tab follow a
    // running card live instead of waiting for the transcript at the end.
    onTurn: async (cardId, turn) => {
      if (tracer && cardSpan) {
        const t = tracer.start("card.turn", {}, cardSpan.context);
        t.record.startNs = BigInt(turnStartedMs) * 1_000_000n;
        t.set({
          "sekhemet.card.id": cardId,
          "sekhemet.turn.tools": turn.toolCalls?.map((c) => c.name).join(",") ?? "",
          ...(turn.stopReason ? { "sekhemet.stop_reason": turn.stopReason } : {}),
        }).end("ok");
        for (const call of toolCallsByStep.get(turn.turnIndex) ?? []) {
          toolCallSpan(tracer, t.context, call);
        }
        toolCallsByStep.delete(turn.turnIndex);
        turnStartedMs = Date.now();
      }
      await ctx.cardStore.recordEvent({
        type: "card/step",
        cardId,
        actor: "executor",
        payload: stepEventPayload(cardId, turn),
        // The typed columns (K4): the step row and its attempt.
        attemptId: turn.attemptId,
        stepId: turn.stepId,
      });
      await ctx.afterTurn?.(cardId, turn);
      // WL-N10-1: the messages this step's prompt carried, shown with the step.
      if (carried.length > 0) {
        const reached = carried;
        carried = [];
        await recordDelivered(ctx.cardStore, cardId, reached, turn.turnIndex).catch(
          () => undefined,
        );
      }
      await handMessages();
      const stop = await pendingAbort(ctx.cardStore, cardId, startedAtSeq).catch(() => undefined);
      if (stop !== undefined && !abort.signal.aborted) {
        log(`   stop requested: ${stop}`);
        abort.abort(stop);
      }
      // TEAM-16: the Agent does only what its person may; lowered, it stops here.
      const refused = await ctx.agentRefusal?.(cardId).catch(() => undefined);
      if (refused !== undefined && !abort.signal.aborted) {
        log(`   stopped: ${refused}`);
        abort.abort(refused);
      }
      const pause = await pendingPause(ctx.cardStore, cardId, pauseSinceSeq).catch(() => undefined);
      if (pause !== undefined) {
        log(`   pause requested by ${pause}`);
        runner.pause(pause);
      }
      // Between steps is where a card can wait out memory pressure without
      // losing work; if it does not fall, the next turn stops resumably.
      if (ctx.watchdog?.shouldPauseTurns()) {
        log("   memory watchdog: pausing new turns until pressure falls");
        const calm = await ctx.watchdog.waitUntilBelow("critical", ctx.watchdogWaitMs ?? 120_000);
        log(calm ? "   memory watchdog: resuming" : "   memory watchdog: still critical");
      }
    },
    onProgress: (event) => {
      const prefix = event.turn ? `  [turn ${event.turn}]` : "  ";
      log(`${prefix} ${event.type}: ${event.message}`);
    },
  });

  await handMessages();
  const result = await runner.run().catch((err) => {
    cardSpan?.set({ "error.message": String(err).slice(0, 300) }).end("error");
    tracer?.close();
    throw err;
  });
  cardSpan
    ?.set({
      "sekhemet.passed": result.passed,
      "sekhemet.turns": result.turns.length,
      ...(result.stopReason ? { "sekhemet.stop_reason": String(result.stopReason) } : {}),
    })
    .end(result.passed ? "ok" : "error");
  tracer?.close();
  await recordReproducibility(
    ctx,
    card.id,
    attempt,
    model,
    gatesConfig.sha256,
    result.turns[0]?.contextReport?.metrics.prefixHash,
  ).catch((err) =>
    log(`   reproducibility record not written: ${err instanceof Error ? err.message : err}`),
  );
  learnFromOutcome(ctx, card, result, log);
  if (result.failToPass)
    log(`   fail-to-pass: ${result.failToPass.status} (${result.failToPass.detail})`);
  if (result.resumedFrom) {
    log(
      `   resumed from checkpoint ${result.resumedFrom.gitRef.slice(0, 10)} at step ${result.resumedFrom.step}`,
    );
  }
  if (result.held) log(`   held (wanted ${result.held.wanted}): ${result.held.reason}`);
  if (result.parked) log(`   parked (${result.parked.stopReason}): ${result.parked.suggestion}`);
  if (result.replan) log(`   re-plan requested: ${result.replan.summary.slice(0, 200)}`);
  if (ctx.learning) {
    try {
      // A candidate that restates a rule the playbook already has (by fact
      // key, not wording) would only duplicate it in the window: drop it.
      const guarded = unlessPlaybookCovers(ctx.learning, playbook);
      // Probation is off until the owner allows it (O15, measurement rule 6,
      // MS-T8-15): a candidate waits for a person's approval, and nothing
      // learned here reaches a later card of the run.
      const proposed = await learnFromAttempt(guarded, card, result, attempt, {
        outcomes: () => ctx.cardStore.runs.readAttemptOutcomes(),
        onInsufficient: (key, n) =>
          log(
            `   learning: insufficient data for ${key} (${n} of ${RULE_SIGNAL_MINIMUM} occurrences)`,
          ),
      });
      if (proposed > 0)
        log(`   learning: ${proposed} candidate rule(s) from this attempt, waiting for approval`);
    } catch {
      // Learning is a side channel; it must never fail a card.
    }
  }
  return result;
}

/**
 * H24: what decided this attempt (model file and quant, runtime, prompt, tool
 * schema, playbook, active rules, gates, harness commit, host), on the ledger
 * as `card/repro`, beside the evidence as `repro-<card>-<attempt>.json`, and
 * inside the latest evidence bundle as `reproducibility`.
 */
async function recordReproducibility(
  ctx: ExecutionContext,
  cardId: string,
  attempt: number,
  model: LocalInferenceAdapter,
  gatesSha: string,
  promptSha: string | undefined,
): Promise<void> {
  // MD-M4-3: the running server's own report, never the adapter's intent.
  const server = await (
    model as { serverProps?: () => Promise<ServerProps | undefined> }
  ).serverProps?.();
  const record = buildReproRecord({
    cardId,
    attempt,
    model,
    repoPath: ctx.repoPath,
    gatesSha,
    ...(server ? { server } : {}),
    activeRules: [...(ctx.runRules ?? [])],
    ...(promptSha ? { promptSha } : {}),
    ...(ctx.runProfile ? { runProfile: ctx.runProfile } : {}),
    ...(ctx.measurement ? { measurement: ctx.measurement } : {}),
  });
  const dir = join(ctx.repoPath, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `repro-${cardId}-${attempt}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  const latest = join(dir, `latest-${cardId}.json`);
  if (existsSync(latest)) {
    const bundle = JSON.parse(readFileSync(latest, "utf8")) as Record<string, unknown>;
    if (bundle.attempt === attempt || bundle.attempt === undefined) {
      writeFileSync(latest, `${JSON.stringify({ ...bundle, reproducibility: record }, null, 2)}\n`);
    }
  }
  await ctx.cardStore.recordEvent({
    type: "card/repro",
    cardId,
    actor: "harness",
    payload: record as unknown as Record<string, unknown>,
  });
}

let sharedLspPool: LspPool | undefined;
/** The process's language-server pool (one per run, C2). */
export function runLspPool(): LspPool {
  sharedLspPool ??= new LspPool();
  return sharedLspPool;
}

/** Where a running card's decoded tokens are written for the dashboard (M2). */
export function liveTokenPath(repoPath: string, cardId: string): string {
  return join(repoPath, ".sekhemet", "live", `${cardId}.txt`);
}

/**
 * A buffered writer of streamed tokens to the card's live file: flushed
 * every 250 ms, and the file restarts at each new generation (a gap of
 * over two seconds), so it always shows the step being decoded.
 */
export function liveTokenWriter(repoPath: string, cardId: string): (delta: string) => void {
  const path = liveTokenPath(repoPath, cardId);
  let buffer = "";
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    if (!buffer) return;
    try {
      mkdirSync(join(repoPath, ".sekhemet", "live"), { recursive: true });
      appendFileSync(path, buffer);
    } catch {
      // The live view is best effort.
    }
    buffer = "";
  };
  return (delta: string) => {
    const now = Date.now();
    if (now - last > 2000) {
      try {
        mkdirSync(join(repoPath, ".sekhemet", "live"), { recursive: true });
        writeFileSync(path, "");
      } catch {
        // Best effort.
      }
    }
    last = now;
    buffer += delta;
    timer ??= setTimeout(flush, 250);
  };
}

/**
 * What a finished card teaches the harness itself: a passing run becomes an
 * exemplar for its class (E11, C13), and every outcome feeds the learning
 * guard, which rolls back a learned change (a rule, a budget) whose window
 * shows the pass rate falling (E17).
 */
export function learnFromOutcome(
  ctx: ExecutionContext,
  card: CardRecord,
  result: CardRunResult,
  log: (line: string) => void = () => {},
): void {
  const dot = join(ctx.repoPath, ".sekhemet");
  try {
    harvestExemplars(
      new ExemplarStore(join(dot, "exemplars")),
      [
        {
          id: card.id,
          tier: card.tier,
          title: card.title,
          scopeFiles: card.scopeFiles,
          passed: result.passed,
          tokens: result.tokensUsed,
          turns: result.turns.map((t) => ({
            turn: t.turnIndex,
            action: t.toolCalls.map((c) => c.name).join(", ") || "(no tool calls)",
            result: t.observations.map((o) => o.summary).join(" | "),
            calls: t.toolCalls.length,
            observations: t.observations.length,
          })),
        },
      ],
      // Rule 20: five complete passing cards in a class before any is offered.
      { poolPath: join(dot, "exemplar_pool.json") },
    );
  } catch {
    // An exemplar is a convenience; never a reason to fail a card.
  }
  try {
    const guard = new LearningGuard(join(dot, "learning_guard.json"));
    const decision = guard.observe(card.id, result.passed);
    // Advisory only (measurement rule 18): the window is reported, and a
    // rollback waits for a paired suite run that shows a loss.
    const change = decision.flagged ?? decision.insufficient;
    if (change) {
      log(`   learning guard: ${change.kind} ${change.id}: ${change.reason ?? ""}`);
      void ctx.cardStore
        .recordEvent({
          // A drop is flagged; a window with no history is not a flag (review minor).
          type: decision.flagged ? "learning/flagged" : "learning/insufficient",
          cardId: card.id,
          actor: "system",
          payload: {
            change: change.id,
            kind: change.kind,
            status: change.status,
            reason: change.reason ?? "",
          },
        })
        .catch(() => undefined);
    }
  } catch {
    // The guard's own file is the only state; a failure costs one observation.
  }
}

/**
 * The learning store as `learnFromAttempt` sees it: `propose` first asks the
 * playbook whether a rule already states the same fact (`coveringRule`, by
 * fact key), and proposes nothing when one does (integration review A3).
 */
export function unlessPlaybookCovers(
  learning: LearningStore,
  playbook: Pick<PlaybookRegistry, "coveringRule">,
): LearningStore {
  const guarded = Object.create(learning) as LearningStore;
  guarded.propose = async (rule) =>
    playbook.coveringRule(rule.text) ? undefined : learning.propose(rule);
  return guarded;
}

// ---------------------------------------------------------------------------
// Runner control: abort (L25), rewind (H19), fork (H18), resume (H17)
// ---------------------------------------------------------------------------

/** Ledger events that steer a card's next run. */
export const CONTROL_EVENTS = {
  abortRequested: "card/abort_requested",
  rewound: "card/rewound",
  forkRequested: "card/fork_requested",
} as const;

/**
 * Ask the process running a card to stop it before its next turn (L25).
 * The dashboard and `sekhemet abort` write this; the runner's `onTurn`
 * polls for it, since the queue runs in another process.
 */
export async function requestAbort(
  cardStore: CardStore,
  cardId: string,
  reason: string,
  actor = "human",
): Promise<void> {
  if (!(await cardStore.getCard(cardId))) throw new Error(`Issue not found: ${cardId}`);
  await cardStore.recordEvent({
    type: CONTROL_EVENTS.abortRequested,
    cardId,
    actor,
    payload: { id: cardId, reason: reason.trim() || "stopped by a person" },
  });
}

/** An abort requested after `sinceSeq`, if any. */
async function pendingAbort(
  cardStore: CardStore,
  cardId: string,
  sinceSeq: number,
): Promise<string | undefined> {
  const events = await cardStore.cardEvents(cardId, [CONTROL_EVENTS.abortRequested]);
  const last = events.filter((e) => e.seq > sinceSeq).at(-1);
  return last ? String((last.payload as { reason?: string }).reason ?? "stopped") : undefined;
}

/** The step's checkpoint commit at or before `step`, from the attempt's step rows or the checkpoints. */
async function checkpointAtOrBefore(
  cardStore: CardStore,
  cardId: string,
  step: number,
  attemptId?: string,
): Promise<{ step: number; gitRef: string; attemptId?: string } | undefined> {
  const attempts = cardStore.runs.listAttempts(cardId);
  const attempt = attemptId ? attempts.find((a) => a.id === attemptId) : attempts.at(-1);
  if (attempt) {
    const pinned = cardStore.runs
      .listSteps(attempt.id)
      .filter((s) => s.gitRef && s.stepIndex <= step)
      .at(-1);
    if (pinned?.gitRef) {
      return { step: pinned.stepIndex, gitRef: pinned.gitRef, attemptId: attempt.id };
    }
  }
  const cp = (await cardStore.getCheckpoints(cardId)).filter((c) => c.step <= step).at(-1);
  return cp
    ? { step: cp.step, gitRef: cp.gitRef, ...(attempt ? { attemptId: attempt.id } : {}) }
    : undefined;
}

/**
 * Put a card's worktree back to its checkpoint at or before `step` (H19) or
 * branch a new attempt from it (H18). The state being left is kept under
 * `refs/sekhemet/...`, so nothing is lost; the card returns to Ready and its
 * next run continues from that step with the earlier steps replayed.
 */
async function moveCardBack(
  ctx: ExecutionContext,
  cardId: string,
  step: number,
  kind: "rewind" | "fork",
  attemptId?: string,
): Promise<{ step: number; gitRef: string; preservedRef: string }> {
  const card = await ctx.cardStore.getCard(cardId);
  if (!card) throw new Error(`Issue not found: ${cardId}`);
  if (card.status === "done") throw new Error(`${cardId} is done; reopen it before a ${kind}`);
  const point = await checkpointAtOrBefore(ctx.cardStore, cardId, step, attemptId);
  if (!point) throw new Error(`${cardId} has no checkpoint at or before step ${step}`);
  const worktree = join(ctx.repoPath, ".sekhemet", "worktrees", cardId);
  if (!existsSync(worktree)) throw new Error(`${cardId} has no worktree to ${kind}`);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: worktree, encoding: "utf8", timeout: 30_000 }).trim();
  // Keep what is being left: the attempt's head (fork) or the pre-rewind state.
  git("add", "-A");
  let head = git("rev-parse", "HEAD");
  try {
    git(
      "-c",
      "user.name=Sekhemet",
      "-c",
      "user.email=sekhemet@localhost",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      `sekhemet: state before ${kind} to step ${point.step}`,
    );
    head = git("rev-parse", "HEAD");
  } catch {
    // Nothing uncommitted: HEAD already is the state being left.
  }
  const preservedRef = `refs/sekhemet/${kind}/${cardId}/${Date.now()}`;
  git("update-ref", preservedRef, head);
  git("reset", "--hard", point.gitRef);
  git("clean", "-fdq");

  if (card.status !== "ready") {
    try {
      await ctx.boardService.transitionCard({
        cardId,
        fromStatus: card.status,
        toStatus: "ready",
        actor: "human",
        reason: `${kind} to step ${point.step}`,
      });
    } catch {
      // A card that cannot go straight back to Ready keeps its column; the
      // next run still starts from the checkpoint.
    }
  }
  await ctx.cardStore.updateCard(cardId, { stepsUsed: point.step, blockedReason: null }, "human");
  await ctx.cardStore.recordEvent({
    type: kind === "fork" ? CONTROL_EVENTS.forkRequested : CONTROL_EVENTS.rewound,
    cardId,
    actor: "human",
    payload: {
      id: cardId,
      step: point.step,
      gitRef: point.gitRef,
      preservedRef,
      ...(point.attemptId ? { attemptId: point.attemptId } : {}),
    },
  });
  return { step: point.step, gitRef: point.gitRef, preservedRef };
}

/** Rewind a card to its checkpoint at or before `step` (H19). */
export function rewindCard(ctx: ExecutionContext, cardId: string, step: number) {
  return moveCardBack(ctx, cardId, step, "rewind");
}

/**
 * Fork an attempt at `step` (H18): the attempt's work is kept under a ref,
 * and the card's next run is a new attempt that starts from that step.
 */
export function forkCard(ctx: ExecutionContext, cardId: string, step: number, attemptId?: string) {
  return moveCardBack(ctx, cardId, step, "fork", attemptId);
}

/**
 * A rewind or fork not yet consumed by a run: the latest such event after
 * the card's last attempt started.
 */
async function pendingStartPoint(cardStore: CardStore, cardId: string) {
  const events = await cardStore.cardEvents(cardId, [
    CONTROL_EVENTS.rewound,
    CONTROL_EVENTS.forkRequested,
    "attempt/started",
  ]);
  const last = events.at(-1);
  if (!last || last.type === "attempt/started") return undefined;
  const p = last.payload as { step: number; gitRef: string; attemptId?: string };
  return {
    startFrom: {
      step: p.step,
      gitRef: p.gitRef,
      ...(p.attemptId ? { attemptId: p.attemptId } : {}),
    },
    ...(last.type === CONTROL_EVENTS.forkRequested && p.attemptId
      ? { forkedFrom: { attemptId: p.attemptId, step: p.step } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Planning (B2, K25, L21), rollup (B7), explain (B12)
// ---------------------------------------------------------------------------

const SLICE_KINDS = new Set(["spike", "interface", "data", "path", "rule"]);

/**
 * The Planner's difficulty score for a card, 1–10, from its measurable shape
 * (planner `scoreDifficulty`): what `pullThroughPlanning` records, and what
 * the board asks for when an unscored card enters Planning (kernel rule 27,
 * K-N5-1).
 */
export function plannerDifficulty(card: CardRecord, historicalFailureRate?: number): number {
  const slice = cardClassOf(card).toLowerCase();
  const scored = scoreDifficulty({
    slice: (SLICE_KINDS.has(slice) ? slice : "path") as SpidrSliceKind,
    fileCount: Math.max(1, card.scopeFiles.length),
    ...(historicalFailureRate !== undefined ? { historicalFailureRate } : {}),
  }).value;
  return Math.max(1, Math.min(10, Math.round(scored)));
}

/**
 * Whether the card still carries the step budget it was given for want of one
 * (WL-T3-11): created without an explicit `stepBudget` (the card/created
 * event records it) and its stored budget not changed since. Decided from the
 * record, never from the value — suite cards set the default's value, 40,
 * explicitly — and against the stored card, not the caller's copy, which the
 * queue may have capped (--max-turns, a tune policy).
 */
async function stepBudgetDefaulted(
  ctx: ExecutionContext,
  cardId: string,
  storedBudget: number | undefined,
): Promise<boolean> {
  const [created] = await ctx.cardStore.cardEvents(cardId, ["card/created"]);
  const p = created?.payload as { stepBudget?: number; stepBudgetDefaulted?: boolean } | undefined;
  return p?.stepBudgetDefaulted === true && p.stepBudget === storedBudget;
}

/**
 * Pull a Ready card through Planning (B2, design: "Ready -> Planning:
 * planner claims; Planning -> InProgress: plan + criteria approved"). The
 * Planning entry condition is a scored difficulty, so an unscored card is
 * scored here from its shape and this repo's measured failure rate (K25);
 * its step budget is then moved toward what passing attempts of its class
 * used (L21, at most 15% per calibration), or set from the difficulty when
 * the card was created without a step budget and nothing is measured yet.
 */
export async function pullThroughPlanning(
  ctx: ExecutionContext,
  card: CardRecord,
  modelId: string,
  log: (line: string) => void = () => {},
): Promise<CardRecord> {
  if (card.status !== "ready") return card;
  const cardClass = cardClassOf(card);
  const measured = ctx.cardStore.runs.competence(cardClass, modelId);
  const patch: { difficulty?: number; stepBudget?: number } = {};
  if (card.difficulty === undefined) {
    patch.difficulty = plannerDifficulty(
      card,
      measured.attempts >= 3 ? 1 - measured.passRate : undefined,
    );
  }
  const decision = calibratedStepBudget(card.stepBudget, measured);
  const storedBudget = (await ctx.cardStore.getCard(card.id))?.stepBudget;
  if (decision.changed) patch.stepBudget = decision.budget;
  else if (measured.attempts === 0 && (await stepBudgetDefaulted(ctx, card.id, storedBudget))) {
    patch.stepBudget = stepBudgetForDifficulty(patch.difficulty ?? card.difficulty ?? 4);
  }
  const updated =
    Object.keys(patch).length > 0
      ? await ctx.cardStore.updateCard(card.id, patch, "planner")
      : card;
  if (patch.stepBudget !== undefined) {
    const from = decision.changed ? card.stepBudget : (storedBudget ?? card.stepBudget);
    await ctx.cardStore
      .recordEvent({
        type: "card/budget_set",
        cardId: card.id,
        actor: "planner",
        payload: {
          id: card.id,
          from,
          to: patch.stepBudget,
          reason: decision.changed ? decision.reason : "set from difficulty (nothing measured yet)",
        },
      })
      .catch(() => undefined);
    log(`   budget ${from} -> ${patch.stepBudget} steps`);
  }
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: "ready",
    toStatus: "planning",
    actor: "planner",
    reason: "the Planning model claims the issue",
  });
  // A cap the caller put on its copy (the queue's --max-turns) still holds
  // for this run; the stored budget is the planner's.
  const capped = storedBudget !== undefined && card.stepBudget < storedBudget;
  const run =
    capped && patch.stepBudget !== undefined && card.stepBudget < patch.stepBudget
      ? { ...updated, stepBudget: card.stepBudget }
      : updated;
  return { ...run, status: "planning" };
}

/**
 * Parent rollup with an integration gate (B7, design: "A parent card is
 * done only when every child is done and the parent's own integration gate
 * passes on the merged result"). Runs every declared gate on the main
 * repository once the last child is accepted; passing moves the parent to
 * Done by the legal route, failing sends it to Planning with the failures.
 */
export async function rollupParent(
  ctx: ExecutionContext,
  parentId: string,
): Promise<{ status: "not_ready" | "passed" | "failed"; children: number; failures?: string[] }> {
  const parent = await ctx.cardStore.getCard(parentId);
  const children = await ctx.cardStore.listCards({ parentId });
  if (!parent || children.length === 0) return { status: "not_ready", children: children.length };
  if (parent.status === "done" || children.some((c) => c.status !== "done")) {
    return { status: "not_ready", children: children.length };
  }
  const gatesConfig = loadGatesConfig(ctx.repoPath);
  const rungs = [...new Set(gatesConfig.gates.filter((g) => g.blocking).map((g) => g.rung))];
  // The integration gate runs on the integration branch as Accept left it,
  // in a scratch checkout: Accept never writes the person's (review-git §2.5.2).
  const result = await new NodeGitSyncAdapter(ctx.repoPath).withScratchCheckout(
    integrationBranch(ctx.repoPath),
    (cwd) =>
      // The pinned gates.toml is the project's (read from the repository
      // root, as the runner reads it); the gates run in the scratch checkout.
      new DeterministicGateRunner(confinedSandbox(ctx.restrictedMode), {
        repoRoot: ctx.repoPath,
        expectedConfigSha256: gatesConfig.sha256,
      }).runGates(rungs, cwd),
  );
  const failures = result.failures.map(
    (f) => `[${f.gate ?? f.rung}] ${f.errorExcerpt.split("\n")[0]}`,
  );
  // The parent's evidence is the integration run (what Review reads).
  const attempt = nextAttemptNumber(ctx.repoPath, parentId);
  const evidence = compileEvidence({
    cardId: parentId,
    attempt,
    diff: "",
    filesTouched: [],
    linesAdded: 0,
    linesRemoved: 0,
    gateResult: result,
    turnsUsed: 0,
    stopReason: result.passed ? "gate_passed" : "repair_exhausted",
    checkpointShas: [],
    tokens: { promptTokens: 0, completionTokens: 0 },
    durationMs: result.durationMs,
    settings: { modelId: "integration-gate", toolArm: "none" },
    gatesConfigSha256: gatesConfig.sha256,
  });
  const dir = join(ctx.repoPath, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(dir, `${evidence.id}.json`), body);
  writeFileSync(join(dir, `latest-${parentId}.json`), body);
  // The integration run is the parent's attempt, on the ledger with its
  // stop reason and evidence: Verify and Review read them there (K-S4-6, K-S7-7).
  await recordLedgerRun(ctx.cardStore, {
    cardId: parentId,
    modelId: "integration-gate",
    passed: result.passed,
    stopReason: result.passed ? "gate_passed" : "repair_exhausted",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    secondsUsed: Math.round(result.durationMs / 1000),
  });
  await ctx.cardStore.recordEvent({
    type: "card/rollup",
    cardId: parentId,
    actor: "gate",
    payload: {
      id: parentId,
      children: children.map((c) => c.id),
      passed: result.passed,
      failures,
      evidenceId: evidence.id,
    },
  });
  const move = async (to: CardStatus, reason: string) => {
    const current = (await ctx.cardStore.getCard(parentId)) as CardRecord;
    for (const step of legalPath(current.status, to) ?? []) {
      const now = (await ctx.cardStore.getCard(parentId)) as CardRecord;
      await ctx.boardService.transitionCard({
        cardId: parentId,
        fromStatus: now.status,
        toStatus: step,
        actor: "harness",
        reason,
      });
    }
  };
  if (result.passed) {
    await move("done", `rollup: all ${children.length} children done; integration checks passed`);
    return { status: "passed", children: children.length };
  }
  await move("planning", "rollup: integration checks failed on the merged result").catch(
    () => undefined,
  );
  await ctx.cardStore
    .updateCard(
      parentId,
      { blockedReason: `integration checks failed: ${failures.slice(0, 3).join("; ")}` },
      "gate",
    )
    .catch(() => undefined);
  return { status: "failed", children: children.length, failures };
}

/**
 * Why a card is where it is, in plain sentences (B12 "explain"): its
 * column, what holds it, why it stopped, what failed, what it waits on,
 * and the smallest next action.
 */
export async function explainCard(ctx: ExecutionContext, cardId: string): Promise<string[]> {
  const card = await ctx.cardStore.getCard(cardId);
  if (!card) throw new Error(`Issue not found: ${cardId}`);
  const lines = [`${card.id} is in ${card.status}.`];
  const waiting = ctx.cardStore.waitingOn(card.id);
  if (waiting.length > 0) lines.push(`It waits on ${waiting.join(", ")}, not done yet.`);
  if (card.hold?.kind === "backpressure") {
    lines.push(`Held, waiting for ${card.hold.awaiting}: ${card.hold.reason}.`);
  } else if (card.hold?.kind === "awaitingMerge" && card.hold.dismissed) {
    lines.push(
      `Its accept was dismissed: pull request #${card.hold.pr} has new commits; it waits for a new decision.`,
    );
  } else if (card.hold?.kind === "awaitingMerge") {
    lines.push(`Accepted; waits for pull request #${card.hold.pr} to merge.`);
  }
  if (card.blockedReason) lines.push(`Blocked: ${card.blockedReason}.`);
  if (card.stopReason) lines.push(`Its last attempt stopped with ${card.stopReason}.`);
  const attempts = ctx.cardStore.runs.listAttempts(card.id);
  if (attempts.length > 0) {
    const last = attempts.at(-1);
    lines.push(
      `${attempts.length} attempt(s); the last used ${last?.tokensUsed ?? 0} tokens in ${Math.round(last?.secondsUsed ?? 0)} s.`,
    );
  }
  try {
    const ev = JSON.parse(
      readFileSync(join(ctx.repoPath, ".sekhemet", "evidence", `latest-${card.id}.json`), "utf8"),
    ) as { passed?: boolean; failures?: { gate?: string; rung?: string; errorExcerpt?: string }[] };
    const first = ev.failures?.[0];
    if (!ev.passed && first) {
      lines.push(
        `First failing check: ${first.gate ?? first.rung}: ${String(first.errorExcerpt ?? "").split("\n")[0]}.`,
      );
    }
  } catch {
    // No evidence yet.
  }
  const parked = (await ctx.cardStore.cardEvents(card.id, ["card/parked"])).at(-1);
  if (parked)
    lines.push(`Park diagnosis: ${(parked.payload as { suggestion?: string }).suggestion ?? ""}`);
  if (card.status === "parked" || card.stopReason) {
    // P14: the diagnosis, what was tried, and the smallest unblocking action.
    const { diagnoseEscalation } = await import("@sekhemet/planner");
    const d = diagnoseEscalation(
      card,
      await ctx.cardStore.cardEvents(card.id, ["gate/result", "card/step", "attempt/started"]),
    );
    lines.push(`Escalation (${d.category}): ${d.diagnosis} Tried: ${d.tried.join("; ")}.`);
    lines.push(`Smallest unblocking action: ${d.smallestHumanAction}`);
  }
  const next =
    waiting.length > 0
      ? `Finish ${waiting[0]} first.`
      : card.status === "review"
        ? "Accept it or return it with a reason."
        : card.status === "parked"
          ? "Unblock it (answer, split or re-plan), then move it to Ready."
          : card.hold?.kind === "backpressure"
            ? "It moves on its own when Review has room."
            : card.status === "ready"
              ? "Run the queue."
              : undefined;
  if (next) lines.push(`Next: ${next}`);
  return lines;
}

/**
 * Retry the moves held cards were waiting for (defect 1, B4). Called when
 * Review drains (an accept, a return, a park): the oldest hold goes first,
 * and a card that was held on its way to Verify with passing evidence
 * continues to Review, as it would have without the hold. Returns the ids
 * released.
 */
export async function releaseHeldCards(ctx: ExecutionContext): Promise<string[]> {
  const released: string[] = [];
  for (const card of await ctx.boardService.listHeld()) {
    // The typed hold names the state it awaits (kernel rule 24, K-N3-1).
    const wanted = card.hold?.kind === "backpressure" ? card.hold.awaiting : undefined;
    if (!wanted) continue;
    let ok = false;
    try {
      ok = await ctx.boardService.releaseHeld(card.id, wanted, "executor");
    } catch {
      continue;
    }
    if (!ok) continue;
    released.push(card.id);
    if (wanted === "verify" && latestEvidencePassed(ctx.repoPath, card.id)) {
      try {
        await ctx.boardService.transitionCard({
          cardId: card.id,
          fromStatus: "verify",
          toStatus: "review",
          actor: "executor",
          reason: "released from hold: checks passed",
        });
      } catch (err) {
        await ctx.boardService
          .holdCard(
            card.id,
            `review refused (${err instanceof Error ? err.message : String(err)})`,
            "executor",
            "review",
          )
          .catch(() => undefined);
      }
    }
  }
  return released;
}

function latestEvidencePassed(repoPath: string, cardId: string): boolean {
  try {
    const ev = JSON.parse(
      readFileSync(join(repoPath, ".sekhemet", "evidence", `latest-${cardId}.json`), "utf8"),
    ) as { passed?: boolean; stopReason?: string };
    return ev.passed === true || ev.stopReason === "gate_passed";
  } catch {
    return false;
  }
}

/**
 * Worker questions queued for Seshat while it was not resident (the hardware
 * decides: a question never forces a model swap on its own). Once Seshat's
 * batch has answered one, the answer is filed in the card's dossier under
 * the question's entry, so the card's next attempt reads it as
 * "Q: ... A (manager): ...". This replaces handing answers over as lessons.
 */
export class QueuedWorkerQuestions {
  private pending: { cardId: string; messageId: string; questionEntryId?: string }[] = [];

  public add(cardId: string, messageId: string, questionEntryId?: string): void {
    this.pending.push({ cardId, messageId, ...(questionEntryId ? { questionEntryId } : {}) });
  }

  public get size(): number {
    return this.pending.length;
  }

  /**
   * File every answered question's answer; unanswered ones stay queued.
   * The answer is the first reply from Seshat after the question.
   */
  public async fileAnswers(
    thread: { id: string; seq: number; role: string; state: string; text: string }[],
    cardStore: Pick<CardStore, "recordDossierEntry">,
  ): Promise<number> {
    let filed = 0;
    const still: typeof this.pending = [];
    for (const q of this.pending) {
      const asked = thread.find((m) => m.id === q.messageId);
      const reply = asked
        ? thread.find((m) => m.role === "pm" && m.seq > asked.seq && m.state === "done")
        : undefined;
      if (!asked || asked.state !== "done" || !reply?.text.trim()) {
        still.push(q);
        continue;
      }
      try {
        await cardStore.recordDossierEntry({
          cardId: q.cardId,
          kind: "answer",
          actor: "manager",
          text: reply.text.slice(0, 2000),
          ...(q.questionEntryId ? { inReplyTo: q.questionEntryId } : {}),
        });
        filed++;
      } catch {
        still.push(q);
      }
    }
    this.pending = still;
    return filed;
  }
}

/** Accept lives in `accept.ts` (review-git §2.5); re-exported for existing callers. */
export { acceptCard } from "./accept.js";

/**
 * After a parent is accepted (review-git §2.5.5, NEW-review-git-2): each
 * stacked child rebases onto the integration branch and re-runs its gates on
 * the rebased branch, in a scratch checkout; the result is the child's
 * evidence. A child in Review whose gates now fail goes back to the Worker
 * (Ready) with the failures; one that conflicts is reported, never forced.
 */
export async function restackAfterAccept(
  ctx: ExecutionContext,
  parent: CardRecord,
  target: string,
): Promise<void> {
  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);
  const restacked = await gitAdapter.restackChildren(parent.id, target).catch(() => []);
  for (const r of restacked) {
    const childId = /\/([^/]+?)(?:-[^/]*)?$/.exec(r.cardBranch)?.[1];
    const child = (await ctx.cardStore.listCards({ parentId: parent.id })).find(
      (c) =>
        c.id === childId || r.cardBranch.endsWith(`/${c.id}`) || r.cardBranch.includes(`/${c.id}-`),
    );
    await ctx.cardStore
      .recordEvent({
        type: "card/restacked",
        cardId: parent.id,
        actor: "harness",
        payload: {
          branch: r.cardBranch,
          ok: r.ok,
          ...(child ? { child: child.id } : {}),
          ...(r.files ? { conflicts: r.files } : {}),
        },
      })
      .catch(() => undefined);
    if (!r.ok || !child) continue;
    await regateRestackedChild(ctx, child, r.cardBranch).catch(() => undefined);
  }
}

/** Re-run a restacked child's blocking gates on its rebased branch (RG-N2-1, RG-N2-2). */
export async function regateRestackedChild(
  ctx: ExecutionContext,
  child: CardRecord,
  branch: string,
): Promise<{ passed: boolean; failures: string[] }> {
  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);
  const gatesConfig = loadGatesConfig(ctx.repoPath);
  const rungs = [...new Set(gatesConfig.gates.filter((g) => g.blocking).map((g) => g.rung))];
  const worktree = join(ctx.repoPath, ".sekhemet", "worktrees", child.id);
  const run = async (cwd: string) =>
    new DeterministicGateRunner(confinedSandbox(ctx.restrictedMode), {
      repoRoot: ctx.repoPath,
      expectedConfigSha256: gatesConfig.sha256,
    }).runGates(rungs, cwd);
  const result = existsSync(worktree)
    ? await run(worktree)
    : await gitAdapter.withScratchCheckout(branch, run);
  const failures = result.failures.map(
    (f) => `[${f.gate ?? f.rung}] ${f.errorExcerpt.split("\n")[0]}`,
  );
  const attempt = nextAttemptNumber(ctx.repoPath, child.id);
  const evidence = {
    ...compileEvidence({
      cardId: child.id,
      attempt,
      diff: "",
      filesTouched: [],
      linesAdded: 0,
      linesRemoved: 0,
      gateResult: result,
      turnsUsed: 0,
      stopReason: result.passed ? "gate_passed" : "integration_failed",
      checkpointShas: [],
      tokens: { promptTokens: 0, completionTokens: 0 },
      durationMs: result.durationMs,
      settings: { modelId: "restack-gate", toolArm: "none" },
      gatesConfigSha256: gatesConfig.sha256,
    }),
    // What the gates ran on: the rebased branch (RG-S5-6 reads it at accept).
    repoState: `${gitAdapter.revParse(`refs/heads/${branch}`)}:${gitAdapter.revParse(`refs/heads/${branch}^{tree}`)}`,
  };
  const dir = join(ctx.repoPath, ".sekhemet", "evidence");
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(join(dir, `${evidence.id}.json`), body);
  writeFileSync(join(dir, `latest-${child.id}.json`), body);
  await recordLedgerRun(ctx.cardStore, {
    cardId: child.id,
    modelId: "restack-gate",
    passed: result.passed,
    stopReason: result.passed ? "gate_passed" : "integration_failed",
    evidenceId: evidence.id,
    path: join(".sekhemet", "evidence", `${evidence.id}.json`),
    body,
    secondsUsed: Math.round(result.durationMs / 1000),
  });
  if (!result.passed) {
    await ctx.cardStore
      .recordDossierEntry({
        cardId: child.id,
        kind: "lesson",
        actor: "gate",
        // Model-facing (a dossier lesson the Worker reads): wording frozen by
        // PROMPT_STANDARD until a suite A/B; DEC-31 governs person-facing text.
        text: `After its parent was accepted and it was rebased, these gates failed: ${failures.join("; ")}`.slice(
          0,
          2000,
        ),
      })
      .catch(() => undefined);
    const now = await ctx.cardStore.getCard(child.id);
    // RG-N2-2: never left in Review with failing gates.
    if (now?.status === "review") {
      await ctx.boardService.transitionCard({
        cardId: child.id,
        fromStatus: "review",
        toStatus: "ready",
        actor: "harness",
        reason:
          `restacked onto the integration branch; checks failed: ${failures.join("; ")}`.slice(
            0,
            1000,
          ),
      });
    }
  }
  return { passed: result.passed, failures };
}

export { evidenceSummary } from "./evidence_summary.js";

export interface QueueEntry {
  cardId: string;
  /** 1 for the worker's first attempt, 2 for the retry after a manager plan. */
  attempt: number;
  passed: boolean;
  accepted: boolean;
  stopReason: string;
  turns: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  /** The move the board refused, when the card was held (defect 1). */
  held?: string;
  /** Why the card was parked for a person (repair rung 4, vacuous tests). */
  parked?: string;
  /** The fail-to-pass check at card start (G12). */
  failToPass?: FailToPassReport["status"];
  /** The checkpoint step a memory-pressure stop resumed from (H17). */
  resumedFromStep?: number;
  /** The card stopped at repair rung 3 for a new plan (L15). */
  replanRequested?: boolean;
  /** Tokens output condensing removed from what the Worker saw (runtime item 32, RUN-47). */
  condensedTokensSaved?: number;
  /** The same per tool, beside the raw tool-output tokens (context CX-N5-3). */
  condensing?: CondensingSummary;
}

export interface QueueReport {
  startedAt: string;
  model: string;
  entries: QueueEntry[];
  passAt1: number;
  /** Cards passing after at most one manager-guided retry. */
  passAfterEscalation: number;
  managerModel?: string;
  modelSwaps: number;
  totalDurationMs: number;
  /** Prefill and decode speed per model (M3), from `ThroughputMeter.all()`. */
  throughput?: ThroughputStats[];
  /** The Worker's prefix-cache reuse (M18), from `PrefixCacheMonitor.summary()`. */
  cache?: CacheSummary;
  /** The memory watchdog's level at the end of the run (M20). */
  memory?: { level: string; reason: string };
  /** Retention at the run's start: every blob pruned, with its card (RUN-57). */
  retention?: RetentionReport;
  /** Written part-way through the run; the final report has no such mark. */
  partial?: boolean;
  /** Condensing's savings over the run, in total and per tool, beside the raw tokens (CX-N5-3). */
  condensing?: CondensingSummary;
  /** Each model's load time, apart from the cards' time (MS-T7-1): `ThroughputMeter.loads()`. */
  modelLoads?: {
    modelId: string;
    loadMs?: { count: number; totalMs: number; firstMs: number };
    spawnToHealthyMs?: { count: number; totalMs: number; firstMs: number };
  }[];
}

/** Persist a queue scorecard where the dashboard and a human can both find it. */
/**
 * The queue's report so far, written after every entry (review M4): a run
 * the suite runner's timeout stops still leaves the record of every card it
 * finished. `partial` marks it until the queue writes its final report.
 */
export function recordQueueProgress(
  repoPath: string,
  so: Pick<QueueReport, "startedAt" | "model" | "entries" | "modelSwaps" | "totalDurationMs"> & {
    managerModel?: string | undefined;
    modelLoads?: QueueReport["modelLoads"];
  },
): string {
  const cards = [...new Set(so.entries.map((e) => e.cardId))];
  const firstTry = so.entries.filter((e) => e.attempt === 1 && e.passed).length;
  const eventually = cards.filter((id) =>
    so.entries.some((e) => e.cardId === id && e.passed),
  ).length;
  return writeQueueReport(
    repoPath,
    withRunCondensing({
      startedAt: so.startedAt,
      model: so.model,
      ...(so.managerModel ? { managerModel: so.managerModel } : {}),
      entries: so.entries,
      passAt1: cards.length ? firstTry / cards.length : 0,
      passAfterEscalation: cards.length ? eventually / cards.length : 0,
      modelSwaps: so.modelSwaps,
      totalDurationMs: so.totalDurationMs,
      ...(so.modelLoads?.length ? { modelLoads: so.modelLoads } : {}),
      partial: true,
    }),
  );
}

/** The ledger event a queue run's report is (runtime item 34b, RUN-56). */
export const QUEUE_REPORTED = "queue/reported";

/** A queue run's start (dashboard DB-N2-11): its issues, model and process. */
export const QUEUE_STARTED = "queue/started";

export interface QueueStarted {
  /** The same instant as its report's `startedAt`, which ends it. */
  startedAt: string;
  cards: string[];
  model: string;
  /** The `queue` process, so a run whose process died is not shown as running. */
  pid: number;
}

/** Record a queue run's start: Runs shows it as running until its report lands. */
export async function recordQueueStarted(log: EventLog, started: QueueStarted): Promise<void> {
  await log.append({ actor: "harness", type: QUEUE_STARTED, payload: { ...started } });
}

/**
 * Record a finished run's report (RUN-56): one `queue/reported {report}`
 * event — the record — then the files, a cache written from the event.
 */
export async function recordQueueReport(
  log: EventLog,
  repoPath: string,
  report: QueueReport,
): Promise<string> {
  const full = withRunCondensing(report);
  await log.append({ actor: "harness", type: QUEUE_REPORTED, payload: { report: full } });
  return writeQueueReport(repoPath, full);
}

/** Every recorded run report, oldest first, from the ledger. */
export async function queueReportsFromLedger(log: EventLog): Promise<QueueReport[]> {
  return (await log.getEventsByTypes([QUEUE_REPORTED])).map(
    (e) => (e.payload as { report: QueueReport }).report,
  );
}

/**
 * Rebuild `runs/<startedAt>.json` and `queue_report.json` from the ledger
 * where they are missing (kernel rule 16: a cache is safe to delete).
 * Returns how many files it wrote.
 */
export async function rebuildRunCaches(repoPath: string, log: EventLog): Promise<number> {
  const reports = await queueReportsFromLedger(log);
  const dir = join(repoPath, ".sekhemet");
  let written = 0;
  for (const report of reports) {
    const file = join(dir, "runs", `${report.startedAt.replace(/[:.]/g, "-")}.json`);
    if (existsSync(file)) continue;
    mkdirSync(join(dir, "runs"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    written++;
  }
  const latest = reports.at(-1);
  if (latest && !existsSync(join(dir, "queue_report.json"))) {
    writeFileSync(join(dir, "queue_report.json"), `${JSON.stringify(latest, null, 2)}\n`, "utf8");
    written++;
  }
  return written;
}

/** What condensing removed from a card's observations, per tool (CX-N5-3); nothing when none was condensed. */
function condensingOf(turns: CardRunResult["turns"]): { condensing?: CondensingSummary } {
  const items = turns.flatMap((t) =>
    t.observations.flatMap((o) =>
      o.condensing
        ? [
            {
              tool: o.tool,
              rawTokens: o.condensing.rawTokens,
              savedTokens: o.condensing.savedTokens,
            },
          ]
        : [],
    ),
  );
  return items.length > 0 ? { condensing: summarizeCondensing(items) } : {};
}

/** A run's condensing savings from its entries, when any entry carries them (CX-N5-3). */
function withRunCondensing(report: QueueReport): QueueReport {
  if (report.condensing) return report;
  const parts = report.entries.flatMap((e) => (e.condensing ? [e.condensing] : []));
  return parts.length > 0 ? { ...report, condensing: mergeCondensing(parts) } : report;
}

/** One card's line in a queue run's report. */
export function queueEntryOf(
  cardId: string,
  attempt: number,
  result: CardRunResult,
  accepted: boolean,
): QueueEntry {
  return {
    cardId,
    attempt,
    passed: result.passed,
    accepted,
    stopReason: result.stopReason,
    turns: result.evidence.turnsUsed,
    durationMs: result.evidence.durationMs,
    promptTokens: result.evidence.tokens.promptTokens,
    completionTokens: result.evidence.tokens.completionTokens,
    // RUN-47: what output condensing removed from what the Worker saw.
    ...(result.condensedTokensSaved !== undefined
      ? { condensedTokensSaved: result.condensedTokensSaved }
      : {}),
    // CX-N5-3: the same, per tool, beside the raw tool-output tokens.
    ...condensingOf(result.turns),
    ...(result.held ? { held: `${result.held.wanted}: ${result.held.reason}` } : {}),
    ...(result.parked ? { parked: result.parked.suggestion } : {}),
    ...(result.failToPass ? { failToPass: result.failToPass.status } : {}),
    ...(result.resumedFrom ? { resumedFromStep: result.resumedFrom.step } : {}),
    ...(result.replan ? { replanRequested: true } : {}),
  };
}

export function writeQueueReport(repoPath: string, report: QueueReport): string {
  const dir = join(repoPath, ".sekhemet");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, "queue_report.json");
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  // Keep every run, not just the latest: the Runs view compares them.
  try {
    const runs = join(dir, "runs");
    mkdirSync(runs, { recursive: true });
    const stamp = report.startedAt.replace(/[:.]/g, "-");
    writeFileSync(join(runs, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch {
    // History is a convenience; the latest report above is the record.
  }
  return path;
}

/**
 * Collect the evidence a manager needs to diagnose a failed card: its
 * acceptance tests and the scope files exactly as the worker left them.
 */
export function collectCardFiles(
  worktreePath: string,
  card: CardRecord,
): { path: string; content: string }[] {
  const paths = [...(card.acceptanceTests ?? []).map((t) => `tests/${t}`), ...card.scopeFiles];
  return paths.map((path) => {
    const abs = join(worktreePath, path);
    // Whole: the re-plan's allocator caps each file to the Planner's window (CX-N3-8).
    return { path, content: existsSync(abs) ? readFileSync(abs, "utf8") : "" };
  });
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` names `file`: its path, or its path without the extension (`src/db`, `src/db.js`). */
function namesModule(text: string, file: string): boolean {
  if (text.includes(file)) return true;
  const stem = file.replace(SOURCE_EXT, "");
  if (stem === file || !stem.includes("/")) return false;
  // Not followed by another extension (`src/export.json` is not `src/export.ts`);
  // a sentence's full stop still ends a name.
  return new RegExp(`(?:^|[^\\w/.-])${escapeRe(stem)}(?:\\.[cm]?[jt]sx?)?(?!\\.?[\\w/-])`).test(
    text,
  );
}

/** Where a card's acceptance test lives in the repository (`tests/<name>` or as written). */
function testPaths(card: CardRecord, index: SourceIndex | undefined): string[] {
  const listed = new Set(index?.files() ?? []);
  return (card.acceptanceTests ?? []).flatMap((t) =>
    [t, `tests/${t}`].filter((p) => listed.has(p)).slice(0, 1),
  );
}

/** The strongest reason first, when one card has several for the same prerequisite. */
const REASON_RANK: Record<string, number> = { declared: 0, named: 1, imported: 2 };

/**
 * Infer which cards each card builds on, and why (planner-pm NEW-planner-pm-8).
 *
 * A card waits on another only when it declares `dependsOn` it (`declared`);
 * when its spec, criteria or acceptance tests name — or the tests import — a
 * module in the other card's scope (`named`); or when the source index (T2)
 * shows its own scope importing such a module (`imported`) (PM-N8-1). Never
 * because the other card owns a types file: running a card before a
 * prerequisite it really uses has merged spends its budget against an empty
 * file, but a blanket edge serialises cards that could run in either order
 * (PM-N8-3). A file both cards own is an overlap, which the queue serialises
 * on its own, not a dependency.
 */
export function inferDependencyReasons(
  cards: CardRecord[],
  options: { index?: SourceIndex } = {},
): Map<string, DependencyReason[]> {
  const owners = new Map<string, string[]>();
  for (const card of cards)
    for (const file of card.scopeFiles) owners.set(file, [...(owners.get(file) ?? []), card.id]);
  const ids = new Set(cards.map((c) => c.id));
  const index = options.index;
  const listed = new Set(index?.files() ?? []);
  const imports = (files: string[]): Set<string> => {
    const present = files.filter((f) => listed.has(f));
    if (!index || present.length === 0) return new Set();
    const graph = index.importGraph(present);
    return new Set(present.flatMap((f) => [...(graph.get(f) ?? [])]));
  };

  const out = new Map<string, DependencyReason[]>();
  for (const card of cards) {
    const found = new Map<string, DependencyReason["source"]>();
    const add = (id: string, source: DependencyReason["source"]) => {
      if (id === card.id) return;
      const had = found.get(id);
      if (had === undefined || (REASON_RANK[source] ?? 9) < (REASON_RANK[had] ?? 9))
        found.set(id, source);
    };
    for (const d of card.dependsOn ?? []) add(d, "declared");
    const own = new Set(card.scopeFiles);
    const text = `${card.spec ?? ""}\n${(card.acceptanceCriteria ?? []).join("\n")}`;
    const tests = testPaths(card, index);
    const testText = tests
      .map((t) => {
        try {
          return readFileSync(join(index?.root ?? "", t), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    const testImports = imports(tests);
    const scopeImports = imports(card.scopeFiles);
    for (const [file, owning] of owners) {
      if (own.has(file)) continue;
      for (const id of owning) {
        if (!ids.has(id) || id === card.id) continue;
        if (namesModule(text, file) || namesModule(testText, file) || testImports.has(file))
          add(id, "named");
        else if (scopeImports.has(file)) add(id, "imported");
      }
    }
    out.set(
      card.id,
      [...found]
        .map(([dependsOnId, source]) => ({ dependsOnId, source }))
        .sort((a, b) => a.dependsOnId.localeCompare(b.dependsOnId)),
    );
  }
  return out;
}

/** Each card's prerequisites, without the reasons (`inferDependencyReasons`). */
export function inferDependencies(
  cards: CardRecord[],
  options: { index?: SourceIndex } = {},
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, list] of inferDependencyReasons(cards, options))
    out.set(
      id,
      list.map((r) => r.dependsOnId),
    );
  return out;
}

/**
 * Write the inferred prerequisites as checked edges with their reason
 * (K15, B5, PM-N8-2): an edge that would close a cycle is refused and
 * returned, never forced. The reason is read back by
 * `CardStore.getDependencyReasons` and served on `GET /api/cards/<id>`.
 */
export async function recordDependencies(
  store: Pick<CardStore, "addDependency" | "getDependencyReasons" | "removeDependency">,
  cards: CardRecord[],
  options: { index?: SourceIndex; actor?: string } = {},
): Promise<{ cardId: string; dependsOnId: string; why: string }[]> {
  const skipped: { cardId: string; dependsOnId: string; why: string }[] = [];
  // A card's `dependsOn` holds every recorded edge; only a declared or planner
  // edge is its own statement, the rest are re-derived here.
  const stated = cards.map((c) => {
    const derived = new Set(
      store
        .getDependencyReasons(c.id)
        .filter((r) => r.source !== "declared" && r.source !== "planner")
        .map((r) => r.dependsOnId),
    );
    return derived.size > 0
      ? { ...c, dependsOn: (c.dependsOn ?? []).filter((d) => !derived.has(d)) }
      : c;
  });
  const inferred = inferDependencyReasons(stated, options);
  // PM-N8-3 on an upgraded ledger: an edge the retired types-file rule wrote
  // (`inferred`) holds only while today's rules still infer it; a declared,
  // named, imported or planner edge is never swept.
  for (const card of cards) {
    const now = new Set((inferred.get(card.id) ?? []).map((r) => r.dependsOnId));
    for (const old of store.getDependencyReasons(card.id)) {
      if (old.source === "inferred" && !now.has(old.dependsOnId)) {
        await store.removeDependency(card.id, old.dependsOnId, options.actor ?? "harness");
      }
    }
  }
  for (const [id, list] of inferred) {
    for (const r of list) {
      await store
        .addDependency(id, r.dependsOnId, r.source, options.actor ?? "harness")
        .catch((err) => {
          skipped.push({
            cardId: id,
            dependsOnId: r.dependsOnId,
            why: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }
  return skipped;
}

/** Earlier attempts of the card that did not pass: what was tried and abandoned (RG-S5-18). */
export function abandonedAttempts(
  store: CardStore,
  cardId: string,
): { attempt: number; stopReason: string }[] {
  const attempts = store.runs.listAttempts(cardId);
  return attempts
    .slice(0, -1)
    .filter((a) => a.stopReason && a.stopReason !== "gate_passed")
    .map((a) => ({ attempt: a.attemptNumber, stopReason: String(a.stopReason) }));
}

/**
 * Pull-request-on-accept (integrations item 15): resolve the GitHub transport
 * first — the App, else the user's own `gh` login, saying which is missing
 * (INT-15) — and decide the API host and the remote's host by the network
 * policy (B4.9 review B1), all before anything is pushed; then push the card
 * branch to the configured remote, the push recorded as `harness/egress`,
 * and open a draft against the integration branch whose body is the
 * reviewed evidence and names the accepter (INT-12, INT-12a, INT-39). One
 * client and one lifecycle for both transports.
 */
export async function openPullRequest(
  ctx: ExecutionContext,
  card: CardRecord,
  branch: string,
  options: {
    base: string;
    remote: string;
    accepter?: string;
    evidence?: Parameters<typeof evidenceSummary>[1];
    /**
     * Teams TEAM-24: the pull request an accept new commits dismissed, still
     * open. The branch is pushed without force — the remote refuses it when
     * the pull request holds commits the verified branch lacks — and that
     * pull request is re-approved at the pushed head; none is opened.
     */
    existing?: { pr: number; url: string };
  },
): Promise<{ pr: number; url: string; headSha: string }> {
  const run = promisify(execFile);
  const record = egressRecorder(ctx.cardStore);
  const transport = await githubTransport(ctx.repoPath, record);
  const headSha = (
    await run("git", ["rev-parse", `refs/heads/${branch}`], { cwd: ctx.repoPath, timeout: 10_000 })
  ).stdout.trim();
  const apiUrl = transport.endpoints.apiUrl;
  // Nothing is pushed when the pull request cannot be opened: the API host
  // first, then the remote's own host, each refused offline (B1).
  await decideEgress(ctx.repoPath, record, apiUrl, {
    url: apiUrl,
    detail: `pull request on accept: ${card.id}`,
  });
  const remoteUrl = (
    await run("git", ["remote", "get-url", options.remote], { cwd: ctx.repoPath, timeout: 10_000 })
  ).stdout.trim();
  const dest = remoteDestination(remoteUrl);
  await decideEgress(ctx.repoPath, record, apiUrl, {
    url: dest.url,
    host: dest.host,
    detail: `git push ${options.remote} ${branch}:${branch} ${headSha}`,
    recordAllowed: true,
  });
  try {
    await run("git", ["push", "-u", options.remote, `${branch}:${branch}`], {
      cwd: ctx.repoPath,
      timeout: 120_000,
    });
  } catch (err) {
    if (!options.existing) throw err;
    throw new Error(
      `pull request #${options.existing.pr} has commits this issue's branch does not: bring them into the branch and verify it again before accepting (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
    );
  }
  if (options.existing) return { ...options.existing, headSha };
  let ev = options.evidence;
  if (!ev) {
    try {
      ev = JSON.parse(
        readFileSync(join(ctx.repoPath, ".sekhemet", "evidence", `latest-${card.id}.json`), "utf8"),
      ) as Parameters<typeof evidenceSummary>[1];
    } catch {
      // No evidence file: the body says so rather than inventing results.
    }
  }
  const body = prBody(card, ev, abandonedAttempts(ctx.cardStore, card.id), options.accepter);
  const pr = await openPullRequestViaApp(
    transport.client,
    ctx.repoPath,
    transport.repo,
    card,
    branch,
    headSha,
    undefined,
    { base: options.base, body, checks: transport.kind === "app" },
  );
  // The lifecycle (INT-12b) reads this record: a write that fails is not hidden.
  await ctx.cardStore.recordEvent({
    type: PR_EVENT,
    cardId: card.id,
    actor: "harness",
    payload: { ...pr, repo: transport.repo },
  });
  return { pr: pr.number, url: pr.url, headSha };
}
