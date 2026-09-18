import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { BoardServiceImpl } from "@sekhemet/board";
import { PlaybookRegistry, SkillsRegistry, useFileEvidenceStore } from "@sekhemet/context";
import { DeterministicGateRunner, loadGatesConfig } from "@sekhemet/gates";
import type { CardRecord, CardStatus, CardStore } from "@sekhemet/kernel";
import { type CardRunResult, CardRunner, type TurnResult } from "@sekhemet/loop";
import {
  type CacheSummary,
  type LocalInferenceAdapter,
  type MemoryWatchdog,
  type ThroughputStats,
  checkExecutionHeadroom,
  readSwapUsedBytes,
} from "@sekhemet/models";
import { ProcessSandbox } from "@sekhemet/sandbox";
import { NodeGitSyncAdapter } from "@sekhemet/sync";
import { readSettings } from "./integrations.js";
import { learnFromAttempt } from "./learning/reflect.js";
import type { LearningStore } from "./learning/store.js";

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
  card: CardRecord,
  model: LocalInferenceAdapter,
  managerGuidance?: string,
  options: ExecuteCardOptions = {},
): Promise<CardRunResult> {
  const log = ctx.log ?? ((line: string) => console.log(line));
  const attempt = options.attempt ?? nextAttemptNumber(ctx.repoPath, card.id);
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
  const gateRunner = new DeterministicGateRunner(sandbox, {
    repoRoot: ctx.repoPath,
    expectedConfigSha256: gatesConfig.sha256,
  });
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
  const baselineSwap = readSwapUsedBytes();
  const runner = new CardRunner({
    card,
    repoRoot: ctx.repoPath,
    worktreePath,
    stepBudget: card.stepBudget,
    modelAdapter: model,
    gateRunner,
    syncAdapter: gitAdapter,
    scopeFiles: card.scopeFiles,
    agentRole: "implementer",
    agentHarness: "sekhemet",
    attempt,
    // Checkpoints, actuals, holds, parks and the dossier persist here.
    store: ctx.cardStore,
    // The agent's own commands are confined as strictly as the gates (defect 3).
    requireConfinement: ctx.restrictedMode,
    // --restricted is a read-only audit: no run_cmd, no writes, static gates (S12).
    restricted: ctx.restrictedMode,
    ...(options.signal ? { signal: options.signal } : {}),
    // Stop before the host does: a paused card resumes, an OOM takes the
    // machine. The watchdog's pause is checked before every turn.
    memoryProbe: () => {
      if (ctx.watchdog?.shouldPauseTurns()) {
        return {
          ok: false,
          reason: "the memory watchdog is holding new turns (critical pressure)",
        };
      }
      return checkExecutionHeadroom(baselineSwap, {});
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
      await ctx.cardStore.recordEvent({
        type: "card/step",
        cardId,
        actor: "executor",
        payload: stepEventPayload(cardId, turn),
      });
      await ctx.afterTurn?.(cardId, turn);
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

  const result = await runner.run();
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
 * Worker questions queued for Merit while it was not resident (the hardware
 * decides: a question never forces a model swap on its own). Once Merit's
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
   * The answer is the first reply from Merit after the question.
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
  // Review has room again: cards held on back-pressure move now.
  await releaseHeldCards(ctx).catch(() => []);
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

/** A review finding (Merit's or the Reviewer's), as `learning/review.ts` returns it. */
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
