import { execFile, execFileSync } from "node:child_process";
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
  ExemplarStore,
  LspPool,
  PlaybookRegistry,
  SkillsRegistry,
  useFileEvidenceStore,
} from "@sekhemet/context";
import { LearningGuard, harvestExemplars } from "@sekhemet/eval";
import {
  DeterministicGateRunner,
  RemoteGateRunner,
  compileEvidence,
  loadGatesConfig,
  npmRegistry,
  readTls,
} from "@sekhemet/gates";
import {
  type CardRecord,
  type CardStatus,
  type CardStore,
  PluginManager,
  ServiceContainer,
  cardClassOf,
  pruneRetention,
} from "@sekhemet/kernel";
import {
  type CardRunResult,
  CardRunner,
  type TurnResult,
  calibratedStepBudget,
} from "@sekhemet/loop";
import {
  type CacheSummary,
  type LocalInferenceAdapter,
  type MemoryWatchdog,
  type ThroughputStats,
  checkExecutionHeadroom,
  readSwapUsedBytes,
} from "@sekhemet/models";
import { type SpidrSliceKind, scoreDifficulty, stepBudgetForDifficulty } from "@sekhemet/planner";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { isAirgapped, mirrorRegistry } from "./airgap.js";
import { readSettings } from "./integrations.js";
import { learnFromAttempt } from "./learning/reflect.js";
import type { LearningStore } from "./learning/store.js";
import { withLicenseGate } from "./license_gate.js";
import { buildReproRecord } from "./repro.js";
import { workerWebDocs } from "./research/service.js";
import { Tracer, traced } from "./tracing.js";
import { withTrailerGate } from "./trailer_gate.js";
import { hookEngineFor } from "./user_hooks.js";
import { PR_EVENT, openPullRequestViaApp } from "./wave2_github.js";
import { githubAppFromEnv } from "./wave2_server.js";

/** The repo's trace store, or none when it cannot be opened (tracing never blocks a card). */
function openTracer(repoPath: string): Tracer | undefined {
  try {
    return Tracer.forRepo(repoPath);
  } catch {
    return undefined;
  }
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
}

/**
 * The repository's project row (K14): every card created without one joins
 * it, and the board scopes to it (B8).
 */
export async function ensureRepoProject(cardStore: CardStore, repoPath: string) {
  return cardStore.ensureProject({ rootPath: repoPath, name: basename(repoPath) || repoPath });
}

/**
 * Retention (K27): prune context packs, observations and transcripts of
 * cards closed more than 30 days ago. Evidence is never pruned.
 */
export async function pruneRunData(cardStore: CardStore, repoPath: string, now = Date.now()) {
  const cards = await cardStore.listCards();
  return pruneRetention(
    repoPath,
    cards.map((c) => ({
      id: c.id,
      status: c.status,
      updatedAt: c.updatedAt,
      packIds: cardStore.runs.contextPackIds(c.id),
    })),
    { now },
  );
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
  // Pulled through Planning (B2): difficulty scored (K25), budget set from
  // this repo's measured history (L21), then the runner moves it on.
  let card = await pullThroughPlanning(ctx, inputCard, model.modelId, log).catch(() => inputCard);
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
  // Restricted mode refuses to execute where the OS cannot confine the
  // subprocess, rather than quietly running the agent unsandboxed.
  const sandbox = new ProcessSandbox({ requireConfinement: ctx.restrictedMode });
  // X20, X26: every verification also runs the licence register gate and
  // the commit-trailer contract on the card's branch.
  const gateRunner = withTrailerGate(
    withLicenseGate(
      // G24: a separate, mutually authenticated gate host when gates.toml
      // names one; this machine's sandbox otherwise.
      gatesConfig.project.gateHost
        ? new RemoteGateRunner(
            gatesConfig.project.gateHost.url,
            readTls(gatesConfig.project.gateHost),
            {
              expectedConfigSha256: gatesConfig.sha256,
              repoRoot: ctx.repoPath,
            },
          )
        : new DeterministicGateRunner(sandbox, {
            repoRoot: ctx.repoPath,
            expectedConfigSha256: gatesConfig.sha256,
          }),
      ctx.repoPath,
    ),
  );
  const skills = new SkillsRegistry();
  skills.loadFromDirectory(join(ctx.repoPath, ".sekhemet", "skills"));
  const playbook = new PlaybookRegistry(ctx.repoPath);
  // Learned rules the human approved join the seeded playbook for this card,
  // in memory only (never written to playbook.toml). Their pattern is the
  // card's own title, so matchRules selects them here; an error-scoped rule
  // keeps its scope, so it rides in the prompt only while its error stands.
  for (const rule of (await ctx.learning?.activeFor("worker", card, ctx.runRules)) ?? []) {
    playbook.addTransientRule({
      id: rule.id,
      pattern: card.title,
      instruction: rule.text,
      ...(rule.scope?.errorPattern ? { errorPattern: rule.scope.errorPattern } : {}),
    });
  }

  const worktreePath = join(ctx.repoPath, ".sekhemet", "worktrees", card.id);
  const webDocs = await workerWebDocs(ctx.repoPath).catch(() => undefined);
  // K9/K10: this card's services in one container, and the project's
  // plugins (.sekhemet/plugins) mounted on it; they may add services and
  // lifecycle hooks, and everything they register is undone after the card.
  const hookEngine = hookEngineFor(ctx.repoPath).engine;
  const container = new ServiceContainer();
  container.register("ctx.cards", ctx.cardStore);
  container.register("ctx.board", ctx.boardService);
  container.register("ctx.hooks", hookEngine);
  container.register("ctx.gates", gateRunner);
  container.register("ctx.llm", model);
  container.register("ctx.sandbox", sandbox);
  const plugins = new PluginManager(container, hookEngine);
  const loaded = await plugins.loadFromDirectory(join(ctx.repoPath, ".sekhemet", "plugins"));
  if (loaded.mounted.length > 0) log(`   plugins: ${loaded.mounted.map((p) => p.name).join(", ")}`);
  for (const e of loaded.errors) log(`   plugin not mounted: ${e}`);
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
  // H22: spans for the card, each turn and each model call (.sekhemet/traces.db).
  const tracer = openTracer(ctx.repoPath);
  const cardSpan = tracer?.start("card.run", {
    "sekhemet.card.id": card.id,
    "sekhemet.attempt": attempt,
  });
  let turnStartedMs = Date.now();
  const tracedModel = tracer && cardSpan ? traced(model, tracer, () => cardSpan.context) : model;
  const runner = new CardRunner({
    card,
    repoRoot: ctx.repoPath,
    worktreePath,
    stepBudget: card.stepBudget,
    modelAdapter: tracedModel,
    gateRunner,
    syncAdapter: gitAdapter,
    scopeFiles: card.scopeFiles,
    agentRole: "implementer",
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
    registry: isAirgapped(ctx.repoPath) ? mirrorRegistry(ctx.repoPath) : npmRegistry(ctx.repoPath),
    // Ask-tier commands wait for a person on the decision queue (S8, K20).
    onApproval: decisionApprover(ctx.cardStore, card.id, ctx.approvalTimeoutMs ?? 60_000),
    signal: abort.signal,
    ...(start?.startFrom ? { startFrom: start.startFrom } : {}),
    ...(start?.forkedFrom ? { forkedFrom: start.forkedFrom } : {}),
    // Stop before the host does: a paused card resumes, an OOM takes the
    // machine. The watchdog's pause is checked before every turn.
    memoryProbe: () => {
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
    // K12: the project's lifecycle hooks (.sekhemet/hooks.toml).
    hooks: hookEngine,
    // L10 tier 3: the library's official web docs, when web access is on.
    ...(webDocs ? { webDocs } : {}),
    // C13: passing runs of this card's class, as worked examples.
    exemplarStore: new ExemplarStore(join(ctx.repoPath, ".sekhemet", "exemplars")),
    // C2: one language-server pool for the whole run (servers are pooled
    // across cards and shut down when idle).
    lspPool: ctx.lspPool ?? runLspPool(),
    // C19: the Worker's prompt carries the core tools' contracts and a
    // one-line index of the rest, which `tool_search` loads on demand. Every
    // turn used to carry all thirty schemas, and a card that never leaves
    // read/edit/check paid prefill for the other twenty-five on every step.
    progressiveTools: true,
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
      transition: async (id, to) => {
        const current = await ctx.cardStore.getCard(id);
        if (!current || current.status === to) return;
        await ctx.boardService.transitionCard({
          cardId: id,
          fromStatus: current.status,
          toStatus: to,
          actor: "executor",
          reason: `card runner advanced card to ${to}`,
        });
      },
      // A move the board refuses (back-pressure, WIP) holds the card with its
      // reason; `releaseHeldCards` retries it when Review drains (defect 1).
      hold: async (id, reason) => {
        await ctx.boardService.holdCard(id, reason, "executor");
      },
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
      const stop = await pendingAbort(ctx.cardStore, cardId, startedAtSeq).catch(() => undefined);
      if (stop !== undefined && !abort.signal.aborted) {
        log(`   stop requested: ${stop}`);
        abort.abort(stop);
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

  const result = await runner
    .run()
    .finally(() => plugins.unmountAll())
    .catch((err) => {
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
  await recordReproducibility(ctx, card.id, attempt, model, gatesConfig.sha256).catch((err) =>
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
      const proposed = await learnFromAttempt(guarded, card, result, attempt, (id) =>
        ctx.runRules?.add(id),
      );
      if (proposed > 0) log(`   learning: ${proposed} candidate rule(s) from this attempt`);
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
): Promise<void> {
  const record = buildReproRecord({
    cardId,
    attempt,
    model,
    repoPath: ctx.repoPath,
    gatesSha,
    activeRules: [...(ctx.runRules ?? [])],
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
    harvestExemplars(new ExemplarStore(join(dot, "exemplars")), [
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
        })),
      },
    ]);
  } catch {
    // An exemplar is a convenience; never a reason to fail a card.
  }
  try {
    const guard = new LearningGuard(join(dot, "learning_guard.json"));
    const decision = guard.observe(card.id, result.passed);
    if (decision.rollback) {
      const change = decision.rollback;
      log(`   learning guard: rolling back ${change.kind} ${change.id} (${change.reason ?? ""})`);
      if (change.kind === "rule") void ctx.learning?.update(change.id, { status: "retired" });
      void ctx.cardStore
        .recordEvent({
          type: "learning/rolled_back",
          cardId: card.id,
          actor: "system",
          payload: { change: change.id, kind: change.kind, reason: change.reason ?? "" },
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
  if (!(await cardStore.getCard(cardId))) throw new Error(`Card not found: ${cardId}`);
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
  if (!card) throw new Error(`Card not found: ${cardId}`);
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
 * Pull a Ready card through Planning (B2, design: "Ready -> Planning:
 * planner claims; Planning -> InProgress: plan + criteria approved"). The
 * Planning entry condition is a scored difficulty, so an unscored card is
 * scored here from its shape and this repo's measured failure rate (K25);
 * its step budget is then moved toward what passing attempts of its class
 * used (L21, at most 15% per calibration), or set from the difficulty when
 * the card still carries the schema default and nothing is measured yet.
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
    const slice = cardClass.toLowerCase();
    const scored = scoreDifficulty({
      slice: (SLICE_KINDS.has(slice) ? slice : "path") as SpidrSliceKind,
      fileCount: Math.max(1, card.scopeFiles.length),
      ...(measured.attempts >= 3 ? { historicalFailureRate: 1 - measured.passRate } : {}),
    }).value;
    patch.difficulty = Math.max(1, Math.min(10, Math.round(scored)));
  }
  const decision = calibratedStepBudget(card.stepBudget, measured);
  if (decision.changed) patch.stepBudget = decision.budget;
  else if (measured.attempts === 0 && card.stepBudget === 50) {
    patch.stepBudget = stepBudgetForDifficulty(patch.difficulty ?? card.difficulty ?? 4);
  }
  const updated =
    Object.keys(patch).length > 0
      ? await ctx.cardStore.updateCard(card.id, patch, "planner")
      : card;
  if (patch.stepBudget !== undefined) {
    await ctx.cardStore
      .recordEvent({
        type: "card/budget_set",
        cardId: card.id,
        actor: "planner",
        payload: {
          id: card.id,
          from: card.stepBudget,
          to: patch.stepBudget,
          reason: decision.changed ? decision.reason : "set from difficulty (nothing measured yet)",
        },
      })
      .catch(() => undefined);
    log(`   budget ${card.stepBudget} -> ${patch.stepBudget} steps`);
  }
  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: "ready",
    toStatus: "planning",
    actor: "planner",
    reason: "planner claims the card",
  });
  return { ...updated, status: "planning" };
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
  const gateRunner = new DeterministicGateRunner(
    new ProcessSandbox({ requireConfinement: ctx.restrictedMode }),
    { repoRoot: ctx.repoPath, expectedConfigSha256: gatesConfig.sha256 },
  );
  const rungs = [...new Set(gatesConfig.gates.filter((g) => g.blocking).map((g) => g.rung))];
  const result = await gateRunner.runGates(rungs, ctx.repoPath);
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
    await move("done", `rollup: all ${children.length} children done; integration gate passed`);
    return { status: "passed", children: children.length };
  }
  await move("planning", "rollup: integration gate failed on the merged result").catch(
    () => undefined,
  );
  await ctx.cardStore
    .updateCard(
      parentId,
      { blockedReason: `integration gate failed: ${failures.slice(0, 3).join("; ")}` },
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
  if (!card) throw new Error(`Card not found: ${cardId}`);
  const lines = [`${card.id} is in ${card.status}.`];
  const waiting = ctx.cardStore.waitingOn(card.id);
  if (waiting.length > 0) lines.push(`It waits on ${waiting.join(", ")}, not done yet.`);
  if (card.blockedReason) lines.push(`Held or blocked: ${card.blockedReason}.`);
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
        `First failing gate: ${first.gate ?? first.rung}: ${String(first.errorExcerpt ?? "").split("\n")[0]}.`,
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
          : card.blockedReason?.startsWith("held:")
            ? "It moves on its own when Review has room."
            : card.status === "ready"
              ? "Run the queue."
              : undefined;
  if (next) lines.push(`Next: ${next}`);
  return lines;
}

/** The column a held card was waiting for, from its `held: <column> refused (...)` reason. */
export function heldTarget(blockedReason: string | undefined | null): CardStatus | undefined {
  const m = /^held:\s*(in_progress|verify|review|parked|planning|ready|done)\b/.exec(
    blockedReason ?? "",
  );
  return m?.[1] as CardStatus | undefined;
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
    const wanted = heldTarget(card.blockedReason);
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
          reason: "released from hold: gates passed",
        });
      } catch (err) {
        await ctx.boardService
          .holdCard(card.id, `review refused (${err instanceof Error ? err.message : String(err)})`)
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

/**
 * Squash a reviewed card onto main and mark it done.
 *
 * Only a card in Review can be accepted: the harness verifies, a person accepts.
 */
export async function acceptCard(
  ctx: ExecutionContext,
  card: CardRecord,
  actor = "human",
): Promise<string> {
  if (card.status !== "review") {
    throw new Error(
      `Card ${card.id} is in '${card.status}'. Only a card in Review can be accepted.`,
    );
  }

  const gitAdapter = new NodeGitSyncAdapter(ctx.repoPath);

  // With "GitHub PR on accept" on, a person's Accept opens a pull request
  // instead of merging locally, so the team's normal review and CI apply.
  // The queue's --auto-accept (actor "harness") always merges locally: the
  // benchmark needs later cards to build on earlier ones.
  if (actor !== "harness" && readSettings(ctx.repoPath).githubPrOnAccept) {
    const url = await openPullRequest(ctx, card, gitAdapter.branchNameFor(card.id, card.title));
    await ctx.boardService.transitionCard({
      cardId: card.id,
      fromStatus: card.status,
      toStatus: "done",
      actor,
      reason: `accepted: pull request ${url}`,
    });
    await ctx.cardStore
      .recordEvent({
        type: "card/accepted",
        cardId: card.id,
        actor,
        payload: { id: card.id, pr: url },
      })
      .catch(() => undefined);
    await gitAdapter.removeWorktree(card.id);
    // Review has room again: cards held on back-pressure move now.
    await releaseHeldCards(ctx).catch(() => []);
    return url;
  }

  const sha = await gitAdapter.squashAndMerge(
    card.id,
    "main",
    `feat(${card.id}): ${card.title}`,
    {
      "Agent-Model": card.modelRoute?.executor ?? "local",
      "Agent-Harness": "sekhemet",
      "Agent-Role": "implementer",
      GateStatus: "pass",
    },
    card.title,
  );

  await ctx.boardService.transitionCard({
    cardId: card.id,
    fromStatus: card.status,
    toStatus: "done",
    actor,
    reason: "accepted by operator",
  });
  // The merge commit, on the ledger: Done tiles and the card's Thread show it.
  try {
    await ctx.cardStore.recordEvent({
      type: "card/accepted",
      cardId: card.id,
      actor,
      payload: { id: card.id, sha },
    });
  } catch {
    // The merge already happened; a missing ledger line must not undo it.
  }
  await gitAdapter.removeWorktree(card.id);
  // Stacked cards built on this one rebase onto main now it has landed (Y7);
  // a child that conflicts is reported, never forced.
  const restacked = await gitAdapter.restackChildren(card.id, "main").catch(() => []);
  for (const r of restacked) {
    await ctx.cardStore
      .recordEvent({
        type: "card/restacked",
        cardId: card.id,
        actor,
        payload: { branch: r.cardBranch, ok: r.ok, ...(r.files ? { conflicts: r.files } : {}) },
      })
      .catch(() => undefined);
  }
  // Review has room again: cards held on back-pressure move now.
  await releaseHeldCards(ctx).catch(() => []);
  // The last child accepted: roll the parent up through its integration gate (B7).
  if (card.parentId) await rollupParent(ctx, card.parentId).catch(() => undefined);
  return sha;
}

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
  failToPass?: "fails" | "vacuous" | "unknown";
  /** The checkpoint step a memory-pressure stop resumed from (H17). */
  resumedFromStep?: number;
  /** The card stopped at repair rung 3 for a new plan (L15). */
  replanRequested?: boolean;
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
}

/** A review finding (Seshat's or the Reviewer's), as `learning/review.ts` returns it. */
export interface ReviewFinding {
  severity: string;
  note: string;
}

/**
 * Record a review of a passing card in its dossier (one entry, one line per
 * finding). The verdict is the strongest severity, so the Review surface and
 * the card's next attempt see "likely_send_back" first.
 */
export async function recordReview(
  cardStore: Pick<CardStore, "recordDossierEntry">,
  cardId: string,
  findings: ReviewFinding[],
  actor = "reviewer",
): Promise<void> {
  if (findings.length === 0) return;
  const verdict = findings.some((f) => f.severity === "likely_send_back")
    ? "likely_send_back"
    : "consider";
  await cardStore.recordDossierEntry({
    cardId,
    kind: "review",
    actor,
    verdict,
    text: findings.map((f) => `- [${f.severity}] ${f.note}`).join("\n"),
  });
}

/** Persist a queue scorecard where the dashboard and a human can both find it. */
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
    return { path, content: existsSync(abs) ? readFileSync(abs, "utf8").slice(0, 8000) : "" };
  });
}

/**
 * Infer which cards each card builds on.
 *
 * A card depends on another when its spec or criteria name that card's scope
 * file ("use openDatabase from src/db.ts"), and every card depends on a
 * contract card that owns a shared types file. Explicit `dependsOn` is honoured
 * too. Running a card before its prerequisite has merged only spends its
 * budget against an empty file — a live run lost two cards that way.
 */
export function inferDependencies(cards: CardRecord[]): Map<string, string[]> {
  const owner = new Map<string, string>();
  for (const card of cards) for (const file of card.scopeFiles) owner.set(file, card.id);

  const contractCards = cards.filter((c) => c.scopeFiles.some((f) => /(^|\/)types\.ts$/.test(f)));

  const deps = new Map<string, string[]>();
  for (const card of cards) {
    const text = `${card.spec ?? ""}\n${(card.acceptanceCriteria ?? []).join("\n")}`;
    const found = new Set<string>(card.dependsOn ?? []);
    for (const [file, id] of owner) {
      if (id !== card.id && text.includes(file)) found.add(id);
    }
    for (const contract of contractCards) {
      if (contract.id !== card.id) found.add(contract.id);
    }
    deps.set(card.id, [...found]);
  }
  return deps;
}

/**
 * Push the card's branch and open a pull request whose body is the evidence.
 * Uses the user's own git remote and `gh` login; Sekhemet holds no token.
 */
async function openPullRequest(
  ctx: ExecutionContext,
  card: CardRecord,
  branch: string,
): Promise<string> {
  const run = promisify(execFile);
  await run("git", ["push", "-u", "origin", `${branch}:${branch}`], {
    cwd: ctx.repoPath,
    timeout: 120_000,
  });
  // The GitHub App path (Y12, Y14-Y16): a draft PR, check runs per gate,
  // SARIF, then the queue advances it; the gh CLI below is the fallback.
  const app = githubAppFromEnv();
  const appRepo = /^([\w.-]+)\/([\w.-]+)$/.exec(process.env.SEKHEMET_GITHUB_REPO ?? "");
  if (app && appRepo) {
    const headSha = (
      await run("git", ["rev-parse", branch], { cwd: ctx.repoPath, timeout: 10_000 })
    ).stdout.trim();
    const pr = await openPullRequestViaApp(
      app,
      ctx.repoPath,
      { owner: appRepo[1] as string, repo: appRepo[2] as string },
      card,
      branch,
      headSha,
    );
    await ctx.cardStore
      .recordEvent({
        type: PR_EVENT,
        cardId: card.id,
        actor: "harness",
        payload: { ...pr, repo: { owner: appRepo[1], repo: appRepo[2] } },
      })
      .catch(() => undefined);
    return pr.url;
  }
  const title = card.title.replace(/\s*\(SPIDR:[^)]*\)\s*$/, "");
  let gates = "";
  try {
    const ev = JSON.parse(
      readFileSync(join(ctx.repoPath, ".sekhemet", "evidence", `latest-${card.id}.json`), "utf8"),
    ) as { rungResults?: { gate: string; passed: boolean; durationMs?: number }[] };
    gates = (ev.rungResults ?? [])
      .map(
        (r) => `- ${r.passed ? "✓" : "✗"} ${r.gate}${r.durationMs ? ` (${r.durationMs} ms)` : ""}`,
      )
      .join("\n");
  } catch {
    // No evidence file: the body says so rather than inventing results.
  }
  const body = [
    card.spec ?? "",
    card.acceptanceCriteria?.length
      ? `### Done when\n${card.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    `### Gates\n${gates || "_No evidence file was found for this card._"}`,
    `_Implemented by the Sekhemet Worker and accepted in the dashboard. Card \`${card.id}\`._`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { stdout } = await run(
    "gh",
    ["pr", "create", "--head", branch, "--base", "main", "--title", title, "--body", body],
    { cwd: ctx.repoPath, timeout: 60_000 },
  );
  return stdout.trim().split("\n").at(-1) ?? "";
}
