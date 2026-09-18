import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateResult } from "@sekhemet/gates";
import {
  type EvidenceBundle,
  type GatesConfig,
  type RunSettings,
  compileEvidence,
  loadGatesConfig,
} from "@sekhemet/gates";
import type {
  AgentRole,
  CardDossier,
  CardRecord,
  CardStatus,
  CardStore,
  CheckpointRecord,
  GateStatus,
} from "@sekhemet/kernel";
import type { GitSyncAdapter } from "@sekhemet/sync";
import { CardExecutionSessionImpl } from "./session.js";
import type {
  ExecutionStopReason,
  ParkDiagnosis,
  ReplanRequest,
  SessionOptions,
  TurnResult,
} from "./types.js";

/** Board operations the runner needs, kept as an interface to avoid a cycle. */
export interface CardLifecycle {
  /**
   * Move the card. May throw when the board refuses the move (back-pressure,
   * a WIP limit): the runner catches that and holds the card instead.
   */
  transition(cardId: string, to: CardStatus): Promise<void>;
  recordSteps?(cardId: string, stepsUsed: number): Promise<void>;
  /**
   * Hold the card where it stands with a reason (the board's `holdCard`).
   * Without it the runner writes `blockedReason` through `store`.
   */
  hold?(cardId: string, reason: string): Promise<void>;
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
>;

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
   * `fails`: the staged tests fail against the untouched code, as they must.
   * `vacuous`: they already pass, so they cannot measure this card.
   * `unknown`: the gates could not run; the card proceeds.
   */
  status: "fails" | "vacuous" | "unknown";
  tests: string[];
  detail: string;
}

export interface CardRunOptions extends Omit<SessionOptions, "cardId"> {
  card: CardRecord;
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
}

/** Checkpoint statuses by why the checkpoint was taken. */
const AGENT_ROLES: readonly AgentRole[] = [
  "lead-driver",
  "delegator",
  "implementer",
  "architect",
  "test-author",
  "relay-finisher",
];

/** Stops a checkpoint must capture, so the card can resume from its last state. */
const SUSPENDING_STOPS = new Set<ExecutionStopReason>([
  "memory_pressure",
  "human_abort",
  "token_budget_exhausted",
  "time_budget_exhausted",
  "budget_exhausted",
  "replan_requested",
  "done_pending_gates",
  "quota_suspended",
]);

/** Stops that park the card for a human with a diagnosis (L15 rung 4). */
const PARKING_STOPS = new Set<ExecutionStopReason>(["repair_exhausted", "capability_ceiling"]);

/** Longest dossier line shown to the Worker. */
const DOSSIER_LINE_CHARS = 400;
/** Dossier lines shown to the Worker at most (newest kept). */
const DOSSIER_MAX_LINES = 12;

/** Render the dossier as prompt lines, the directives that matter most first. */
export function dossierPromptLines(dossier: CardDossier): string[] {
  const clip = (t: string) =>
    t.length > DOSSIER_LINE_CHARS ? `${t.slice(0, DOSSIER_LINE_CHARS)}…` : t;
  const lines: { seq: number; text: string }[] = [];
  for (const e of dossier.sendBacks)
    lines.push({ seq: e.seq, text: `Sent back by the reviewer: ${clip(e.text)}` });
  for (const e of dossier.reviews)
    lines.push({
      seq: e.seq,
      text: `Review finding${e.verdict ? ` (${e.verdict})` : ""}: ${clip(e.text)}`,
    });
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
      text: `Research: ${clip(e.text)}${e.sources?.length ? ` [${e.sources.slice(0, 2).join(", ")}]` : ""}`,
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
export class CardRunner {
  private config: GatesConfig;
  private session: CardExecutionSessionImpl | undefined;
  private pendingAbort: string | undefined;

  constructor(private options: CardRunOptions) {
    // Pin the gate configuration at card start. Every later verification
    // re-checks this hash, so an agent cannot rewrite its own gates mid-card.
    this.config = loadGatesConfig(options.repoRoot);
  }

  public get gatesConfigSha256(): string {
    return this.config.sha256;
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
  private writeEvidence(evidence: EvidenceBundle): void {
    try {
      const dir = join(this.options.repoRoot, ".sekhemet", "evidence");
      mkdirSync(dir, { recursive: true });
      const body = `${JSON.stringify(evidence, null, 2)}\n`;
      writeFileSync(join(dir, `${evidence.id}.json`), body, "utf8");
      // Stable per-card pointer to the latest attempt.
      writeFileSync(join(dir, `latest-${evidence.cardId}.json`), body, "utf8");
    } catch {
      // Evidence loss must never fail a card.
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
        }),
      );
      writeFileSync(join(dir, `${cardId}-${stamp}.jsonl`), `${lines.join("\n")}\n`, "utf8");
    } catch {
      // Transcript loss must never fail a card.
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
   * The checkpoint a memory-pressure stop left behind, if this card should
   * resume from it (H17).
   */
  private async resumePoint(): Promise<{ step: number; gitRef: string } | undefined> {
    const { card, store } = this.options;
    if (!store || this.options.resume === false) return undefined;
    if (card.stopReason !== "memory_pressure") return undefined;
    try {
      const checkpoints = await store.getCheckpoints(card.id);
      const last = checkpoints.at(-1);
      return last ? { step: last.step, gitRef: last.gitRef } : undefined;
    } catch {
      return undefined;
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
      return true;
    } catch {
      return false;
    }
  }

  /** G12: the staged acceptance tests must fail before any work is done. */
  private async failToPass(worktreePath: string): Promise<FailToPassReport> {
    const tests = (this.options.card.acceptanceTests ?? []).map((t) =>
      t.startsWith("tests/") ? t : `tests/${t}`,
    );
    let result: GateResult;
    try {
      result = await this.options.gateRunner.runGates(["test"], worktreePath);
    } catch (err) {
      return { status: "unknown", tests, detail: `gates could not run: ${refusalReason(err)}` };
    }
    if (result.passed) {
      return {
        status: "vacuous",
        tests,
        detail: `${tests.join(", ")} already pass against the untouched implementation, so they cannot tell whether this card did anything.`,
      };
    }
    const first = result.failures[0]?.errorExcerpt.split("\n")[0] ?? "failing";
    return {
      status: "fails",
      tests,
      detail: `${result.failures.length} failure(s); first: ${first}`,
    };
  }

  /** Move the card, holding it with a recorded reason when the board refuses. */
  private async move(to: CardStatus): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { card, lifecycle, store } = this.options;
    if (!lifecycle) return { ok: true };
    try {
      await lifecycle.transition(card.id, to);
      return { ok: true };
    } catch (err) {
      const reason = `${to} refused (${refusalReason(err)})`;
      try {
        if (lifecycle.hold) await lifecycle.hold(card.id, reason);
        else await store?.updateCard(card.id, { blockedReason: `held: ${reason}` }, "executor");
      } catch {
        // The hold is best effort; the result still carries the reason.
      }
      this.emit({ type: "status", cardId: card.id, message: `held: ${reason}` });
      return { ok: false, reason };
    }
  }

  public async run(): Promise<CardRunResult> {
    const started = this.now();
    const { card, syncAdapter, lifecycle, store } = this.options;
    const attempt = Math.max(1, Math.floor(this.options.attempt ?? 1));
    const checkpointShas: string[] = [];

    const resumeFrom = await this.resumePoint();
    const worktreePath = this.options.useExistingWorktree
      ? this.options.worktreePath
      : await syncAdapter.createWorktree(card.id, this.options.baseBranch ?? "main", card.title);

    let resumedFrom: { step: number; gitRef: string } | undefined;
    if (resumeFrom && this.restore(worktreePath, resumeFrom.gitRef)) {
      resumedFrom = resumeFrom;
      this.emit({
        type: "status",
        cardId: card.id,
        message: `resuming from checkpoint ${resumeFrom.gitRef.slice(0, 10)} at step ${resumeFrom.step}`,
      });
    }

    await this.options.onWorktreeReady?.(worktreePath);
    this.emit({ type: "status", cardId: card.id, message: `worktree ready at ${worktreePath}` });

    // G12: a fresh card's acceptance tests must fail before work begins.
    let failToPass: FailToPassReport | undefined;
    const fresh = !resumedFrom && !this.options.useExistingWorktree && attempt === 1;
    if (
      fresh &&
      !this.options.restricted &&
      this.options.verifyFailToPass !== false &&
      (card.acceptanceTests?.length ?? 0) > 0
    ) {
      failToPass = await this.failToPass(worktreePath);
      this.emit({ type: "status", cardId: card.id, message: `fail-to-pass: ${failToPass.status}` });
      if (failToPass.status === "vacuous") {
        return this.finishVacuous(worktreePath, attempt, started, failToPass);
      }
    }

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

    // Everything the team recorded about this card reaches this attempt.
    let dossierLines: string[] = [];
    if (store) {
      try {
        dossierLines = dossierPromptLines(await store.getDossier(card.id));
      } catch {
        // A dossier read failure costs context, not the card.
      }
    }

    const session = new CardExecutionSessionImpl({
      // Verify against every blocking gate the project declares (lint included,
      // as the spec requires), unless the caller chose specific rungs.
      // Under --restricted only the static layer runs: executing the repo's
      // tests would execute its code (S12).
      gateRungs: [
        ...new Set(
          this.config.gates
            .filter((g) => g.blocking && (!this.options.restricted || g.layer === "static"))
            .map((g) => g.rung),
        ),
      ],
      ...(this.config.project.autofix ? { autofixCommand: this.config.project.autofix } : {}),
      ...(this.config.project.styleFix && this.config.project.styleFixRules
        ? {
            styleFixCommands: this.config.project.styleFixRules.map((rule) => [
              ...(this.config.project.styleFix as string[]),
              `--only=${rule}`,
            ]),
          }
        : {}),
      // The project's declared protection and size limits (defect 5, G10).
      protectedGlobs: this.config.project.protected,
      bounds: {
        maxFiles: this.config.project.maxFiles,
        maxLines: this.config.project.maxDiffLines,
      },
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
      ...this.options,
      ...(resumedFrom
        ? {
            startStep: resumedFrom.step,
            priorLessons: [
              ...(this.options.priorLessons ?? []),
              `resumed after a memory-pressure stop at step ${resumedFrom.step}`,
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

    const turns: TurnResult[] = [];
    let tokens = 0;
    let stopReason: ExecutionStopReason = "budget_exhausted";
    let lastGateResult: GateResult | undefined;
    const tokenBudget = this.options.tokenBudget ?? card.tokenBudget;
    const secondsBudget = this.options.secondsBudget ?? card.secondsBudget;
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
        this.now() - started >= secondsBudget * 1000
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
              : `time budget spent: ${Math.round((this.now() - started) / 1000)}s/${secondsBudget}s`,
        });
        break;
      }

      let turn: TurnResult;
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
        stopReason = "error";
        break;
      }
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

      if (turn.stopReason) {
        stopReason = turn.stopReason;
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
      }
    }

    // A stop that suspends the card keeps its partial work in a checkpoint:
    // that is what a memory-pressure resume (H17) restarts from.
    if (SUSPENDING_STOPS.has(stopReason) && session.getWriteCount() > lastCheckpointWrites) {
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
    const mayVerify =
      stopReason !== "human_abort" &&
      stopReason !== "memory_pressure" &&
      stopReason !== "quota_suspended" &&
      stopReason !== "time_budget_exhausted" &&
      stopReason !== "replan_requested" &&
      stopReason !== "scope_violation";
    if (!lastGateResult && session.isScopeComplete() && mayVerify) {
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
      ...(failToPass ? { failToPass } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
    });
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
      suggestion: `Rewrite ${failToPass.tests.join(", ")} so they fail until this card's behaviour exists; as staged they pass already.`,
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
  }): Promise<CardRunResult> {
    const { card, syncAdapter, lifecycle, store } = this.options;
    const { turns, stopReason, session, attempt } = params;

    this.writeTranscript(card.id, turns);
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
    } catch {
      // No measurable diff (no worktree yet): the evidence says so by being empty.
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

    const settings: RunSettings = {
      modelId: this.options.modelAdapter.modelId,
      toolArm: this.options.toolArm ?? "arm_a_flat",
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    };

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
    });
    this.writeEvidence(evidence);

    const passed = stopReason === "gate_passed" && gateResult.passed;
    const tokensUsed = promptTokens + completionTokens;
    const secondsUsed = Math.round(durationMs / 1000);

    // What this attempt learned goes into the card's dossier for the next one.
    if (store && session) {
      const writes: Promise<unknown>[] = [];
      for (const note of session.getNotes()) {
        if (note.startsWith("Asked: ")) continue; // recorded as a question already
        writes.push(
          store.recordDossierEntry({ cardId: card.id, kind: "note", text: note, attempt }),
        );
      }
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

    // The final column. Every finished card enters Verify first: that is the
    // column the state machine routes through, and it is where back-pressure
    // is applied. Only then does a passing card move to Review for a human.
    // A refused move holds the card with its reason (defect 1); it never
    // throws out of the runner.
    let finalStatus: CardStatus = card.status;
    let held: { reason: string; wanted: CardStatus } | undefined;
    let parked = params.parkWith;
    let replan: ReplanRequest | undefined;

    if (params.heldBeforeStart) {
      held = { reason: params.heldBeforeStart, wanted: "in_progress" };
    } else if (parked) {
      // Vacuous tests: parked before any work.
      const moved = await this.move("parked");
      finalStatus = moved.ok ? "parked" : card.status;
      if (!moved.ok) held = { reason: moved.reason, wanted: "parked" };
    } else {
      finalStatus = "in_progress";
      if (PARKING_STOPS.has(stopReason) && session) {
        parked = session.getParkDiagnosis(stopReason as "repair_exhausted" | "capability_ceiling");
        const moved = await this.move("parked");
        if (moved.ok) finalStatus = "parked";
        else held = { reason: moved.reason, wanted: "parked" };
      } else if (stopReason === "replan_requested" && session) {
        replan = session.getReplanRequest();
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
          if (passed) {
            const toReview = await this.move("review");
            if (toReview.ok) finalStatus = "review";
            else held = { reason: toReview.reason, wanted: "review" };
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
            : null;
      try {
        await store.updateCard(
          card.id,
          {
            stopReason,
            tokensUsed: (card.tokensUsed ?? 0) + tokensUsed,
            secondsUsed: (card.secondsUsed ?? 0) + secondsUsed,
            evidenceId: evidence.id,
            stepsUsed: params.stepsUsed,
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
      ...(held ? { held } : {}),
      ...(parked ? { parked } : {}),
      ...(replan ? { replan } : {}),
      ...(params.failToPass ? { failToPass: params.failToPass } : {}),
      ...(params.resumedFrom ? { resumedFrom: params.resumedFrom } : {}),
    };
  }
}
