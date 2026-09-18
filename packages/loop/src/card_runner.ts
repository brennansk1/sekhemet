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
import type { CardRecord, CardStatus } from "@sekhemet/kernel";
import type { GitSyncAdapter } from "@sekhemet/sync";
import { CardExecutionSessionImpl } from "./session.js";
import type { SessionOptions, TurnResult } from "./types.js";

/** Board operations the runner needs, kept as an interface to avoid a cycle. */
export interface CardLifecycle {
  transition(cardId: string, to: CardStatus): Promise<void>;
  recordSteps?(cardId: string, stepsUsed: number): Promise<void>;
}

/** Emitted as the run progresses, so the CLI and dashboard can follow along. */
export interface RunProgressEvent {
  type: "turn" | "checkpoint" | "gate" | "status";
  cardId: string;
  message: string;
  turn?: number;
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
   * Prepare the worktree after checkout, before the first turn.
   *
   * Contract-first projects use this to stage the card's own acceptance tests:
   * a gate must measure the card it is gating, so suites belonging to later
   * cards must not be present to fail it.
   */
  onWorktreeReady?: ((worktreePath: string) => Promise<void> | void) | undefined;
  /** Skip worktree creation when the caller has already prepared one. */
  useExistingWorktree?: boolean | undefined;
}

export interface CardRunResult {
  cardId: string;
  passed: boolean;
  stopReason: string;
  turns: TurnResult[];
  evidence: EvidenceBundle;
  checkpointShas: string[];
  worktreePath: string;
  finalStatus: CardStatus;
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

  constructor(private options: CardRunOptions) {
    // Pin the gate configuration at card start. Every later verification
    // re-checks this hash, so an agent cannot rewrite its own gates mid-card.
    this.config = loadGatesConfig(options.repoRoot);
  }

  public get gatesConfigSha256(): string {
    return this.config.sha256;
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

  public async run(): Promise<CardRunResult> {
    const started = Date.now();
    const { card, syncAdapter, lifecycle } = this.options;
    const checkpointShas: string[] = [];

    const worktreePath = this.options.useExistingWorktree
      ? this.options.worktreePath
      : await syncAdapter.createWorktree(card.id, this.options.baseBranch ?? "main", card.title);

    await this.options.onWorktreeReady?.(worktreePath);
    this.emit({ type: "status", cardId: card.id, message: `worktree ready at ${worktreePath}` });
    await lifecycle?.transition(card.id, "in_progress");

    const session = new CardExecutionSessionImpl({
      ...this.options,
      cardId: card.id,
      card,
      worktreePath,
      syncAdapter,
    });

    const turns: TurnResult[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let stopReason = "budget_exhausted";
    let lastGateResult: GateResult | undefined = turns.at(-1)?.gateResult;

    while (session.getStepsUsed() < card.stepBudget) {
      const turn = await session.executeTurn();
      turns.push(turn);

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
          const sha = await syncAdapter.commitCheckpoint({
            cardId: card.id,
            step: turn.turnIndex,
            totalSteps: card.stepBudget,
            gateStatus: "pass",
            agentModel: this.options.agentModel ?? this.options.modelAdapter.modelId,
            agentHarness: this.options.agentHarness ?? "sekhemet",
            agentRole: this.options.agentRole ?? "implementer",
            ...(this.options.coAuthors ? { coAuthors: this.options.coAuthors } : {}),
          });
          checkpointShas.push(sha);
          this.emit({ type: "checkpoint", cardId: card.id, message: sha.slice(0, 10) });
        }
      }

      if (turn.stopReason) {
        stopReason = turn.stopReason;
        break;
      }
    }

    // An agent can do the work and still never declare itself finished — it
    // explores until the budget runs out. Discarding completed work because the
    // agent failed to announce it is the worst available outcome, so any
    // terminal stop with written scope and no gate run gets one verification.
    if (!lastGateResult && session.isScopeComplete()) {
      this.emit({
        type: "status",
        cardId: card.id,
        message: `stopped as ${stopReason} with scope complete — verifying anyway`,
      });

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
        const sha = await syncAdapter.commitCheckpoint({
          cardId: card.id,
          step: session.getStepsUsed(),
          totalSteps: card.stepBudget,
          gateStatus: "pass",
          agentModel: this.options.agentModel ?? this.options.modelAdapter.modelId,
          agentHarness: this.options.agentHarness ?? "sekhemet",
          agentRole: this.options.agentRole ?? "implementer",
          ...(this.options.coAuthors ? { coAuthors: this.options.coAuthors } : {}),
        });
        checkpointShas.push(sha);
        this.emit({ type: "checkpoint", cardId: card.id, message: sha.slice(0, 10) });
      }
    }

    this.writeTranscript(card.id, turns);
    await lifecycle?.recordSteps?.(card.id, session.getStepsUsed());

    // Bounds are checked against the real diff, which is why the git adapter
    // computes stats: the limit is meaningless without a measured diff.
    const stats = await syncAdapter.getDiffStats(card.id, this.options.baseBranch ?? "main");
    const diff = await syncAdapter.generateDiff(card.id, this.options.baseBranch ?? "main");

    const gateResult = lastGateResult ?? {
      passed: false,
      failures: [],
      durationMs: 0,
      rungResults: [],
    };

    for (const turn of turns) {
      promptTokens += turn.usage?.promptTokens ?? 0;
      completionTokens += turn.usage?.completionTokens ?? 0;
    }

    const settings: RunSettings = {
      modelId: this.options.modelAdapter.modelId,
      toolArm: this.options.toolArm ?? "arm_a_flat",
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
    };

    const evidence = compileEvidence({
      cardId: card.id,
      attempt: 1,
      diff,
      filesTouched: stats.filesTouched,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
      gateResult,
      turnsUsed: session.getStepsUsed(),
      stopReason,
      checkpointShas,
      tokens: { promptTokens, completionTokens },
      durationMs: Date.now() - started,
      settings,
      gatesConfigSha256: this.config.sha256,
    });

    const passed = stopReason === "gate_passed" && gateResult.passed;

    // Every finished card enters Verify first: that is the column the state
    // machine routes through, and it is where back-pressure is applied. Only
    // then does a passing card move to Review for a human — the harness
    // verifies, a person accepts.
    await lifecycle?.transition(card.id, "verify");
    if (passed) await lifecycle?.transition(card.id, "review");
    const finalStatus: CardStatus = passed ? "review" : "verify";

    return {
      cardId: card.id,
      passed,
      stopReason,
      turns,
      evidence,
      checkpointShas,
      worktreePath,
      finalStatus,
    };
  }
}
