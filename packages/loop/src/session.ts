import {
  type PlaybookRegistry,
  type SkillsRegistry,
  type TurnHistoryItem,
  buildFullPromptPack,
  maskOlderObservations,
} from "@sekhemet/context";
import type { GateFailure, GateResult } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import type { ToolCall } from "@sekhemet/models";
import type { ExecutionResult } from "@sekhemet/sandbox";
import { OscillationDetector } from "./detector.js";
import { type LadderState, RepairLadder, type RungPolicy } from "./ladder.js";
import type { ToolObservation } from "./observation.js";
import { buildRepoMap } from "./repo_map.js";
import { ToolExecutor } from "./tools.js";
import type {
  CardExecutionSession,
  ExecutionStopReason,
  SessionOptions,
  TurnResult,
} from "./types.js";

/** Turns of tool output kept verbatim before older ones are masked to pointers. */
const VERBATIM_TURN_WINDOW = 2;

function synthesizeCard(options: SessionOptions): CardRecord {
  const now = new Date().toISOString();
  return {
    id: options.cardId,
    tier: "task",
    title: options.cardTitle ?? options.cardId,
    status: "in_progress",
    scopeFiles: options.scopeFiles ?? [],
    stepBudget: options.stepBudget,
    stepsUsed: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Drives one card to completion: prompt, act, observe, verify, repair.
 *
 * The defining property is that it is a *closed* loop. Every turn rebuilds the
 * prompt from what actually happened — tool observations, and the typed failure
 * from the last gate run — so the model can see the consequences of its own
 * edits. An agent that cannot observe its effects cannot converge, no matter how
 * capable the underlying model is.
 */
export class CardExecutionSessionImpl implements CardExecutionSession {
  public readonly cardId: string;
  private stepBudget: number;
  private stepsUsed = 0;
  private isFinished = false;
  private oscillationDetector: OscillationDetector;
  private tools: ToolExecutor;
  private card: CardRecord;

  private history: TurnHistoryItem[] = [];
  private lastGateFailure: GateFailure | undefined;
  private repairAttempts = 0;
  private repoMapCache: string | undefined;
  private lastSystemPrompt = "";
  private emptyTurns = 0;
  private ladder: RepairLadder;
  private activeRung: RungPolicy | undefined;

  constructor(private options: SessionOptions) {
    this.cardId = options.cardId;
    this.stepBudget = options.stepBudget;
    this.card = options.card ?? synthesizeCard(options);
    this.oscillationDetector = new OscillationDetector(options.oscillationThreshold ?? 3);
    this.ladder = new RepairLadder();
    this.tools = new ToolExecutor({
      worktreePath: options.worktreePath,
      scopeFiles: options.scopeFiles,
      agentRole: options.agentRole,
      allowNetwork: options.allowNetwork,
      commandTimeoutMs: options.commandTimeoutMs,
      onApproval: options.onApproval,
    });
  }

  public getStepsUsed(): number {
    return this.stepsUsed;
  }

  public getHistory(): TurnHistoryItem[] {
    return [...this.history];
  }

  public getLastGateFailure(): GateFailure | undefined {
    return this.lastGateFailure;
  }

  /** Current position in the repair ladder. */
  public getLadderState(): LadderState {
    return this.ladder.snapshot;
  }

  /** The system prompt sent on the last turn; byte-stability across turns is what makes it cacheable. */
  public getSystemPrompt(): string {
    return this.lastSystemPrompt;
  }

  /** Fingerprint of the worktree, when a git adapter is available. */
  private async currentRepoStateHash(): Promise<string> {
    if (!this.options.syncAdapter) return "";
    try {
      return await this.options.syncAdapter.getRepoStateHash(this.cardId);
    } catch {
      return "";
    }
  }

  private repoMap(): string {
    if (this.repoMapCache === undefined) {
      this.repoMapCache = buildRepoMap(this.tools.root, this.options.scopeFiles ?? []);
    }
    return this.repoMapCache;
  }

  /**
   * Assemble this turn's prompt from card contract, repo map, history and the
   * last gate failure.
   *
   * Older observations are masked to compact pointers rather than dropped, so
   * the model retains the shape of what it already tried without paying full
   * token cost for outputs it has finished acting on.
   */
  private buildPrompt(): { systemPrompt: string; prompt: string } {
    const skills =
      this.options.skillsRegistry?.resolveActiveSkills(
        this.card.title,
        this.options.scopeFiles ?? [],
      ) ?? [];

    const playbookRules =
      this.options.playbookRegistry
        ?.matchRules({
          cardTitle: this.card.title,
          scopeFiles: this.options.scopeFiles ?? [],
          ...(this.lastGateFailure ? { triggerGate: this.lastGateFailure.rung } : {}),
        })
        .map((r) => r.instruction) ?? [];

    // The active rung's directive rides alongside playbook rules so escalation
    // changes what the model is told to do, not merely how often it retries.
    if (this.activeRung && this.activeRung.rung !== "direct_repair") {
      playbookRules.unshift(this.activeRung.directive);
    }

    const pack = buildFullPromptPack({
      card: { ...this.card, stepsUsed: this.stepsUsed },
      repoMap: this.repoMap(),
      activeSkills: skills,
      playbookRules,
      recentTurns: maskOlderObservations(this.history, VERBATIM_TURN_WINDOW),
      ...(this.lastGateFailure ? { gateFailure: this.lastGateFailure } : {}),
    });

    return pack;
  }

  public async executeTurn(): Promise<TurnResult> {
    this.stepsUsed++;
    const turnIndex = this.stepsUsed;

    const { systemPrompt, prompt } = this.buildPrompt();
    this.lastSystemPrompt = systemPrompt;

    const response = await this.options.modelAdapter.generate({
      systemPrompt,
      prompt,
      toolArm: this.options.toolArm ?? "arm_a_flat",
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    });

    const toolCalls = response.toolCalls;

    // A turn that produced no actionable call is a stall signal in its own right:
    // tell the model plainly rather than silently burning the step budget.
    if (toolCalls.length === 0) {
      this.emptyTurns++;
      this.history.push({
        turn: turnIndex,
        action: "(no tool calls)",
        result:
          "No tool calls were parsed from your response. Respond with tool calls only — no prose.",
      });
      const result: TurnResult = {
        turnIndex,
        toolCalls: [],
        observations: [],
        usage: response.usage,
      };
      if (this.emptyTurns >= 3) result.stopReason = "no_progress";
      else if (this.stepsUsed >= this.stepBudget) result.stopReason = "budget_exhausted";
      return result;
    }
    this.emptyTurns = 0;

    const repoStateHash = await this.currentRepoStateHash();
    if (this.oscillationDetector.recordAndCheck(toolCalls, repoStateHash)) {
      this.history.push({
        turn: turnIndex,
        action: toolCalls.map((c) => c.name).join(", "),
        result: "Repeated identical actions detected; execution halted.",
      });
      return {
        turnIndex,
        toolCalls,
        observations: [],
        usage: response.usage,
        stopReason: "oscillation_detected",
      };
    }

    this.tools.resetFinish();
    const observations: ToolObservation[] = [];
    for (const call of toolCalls) {
      observations.push(await this.tools.execute(call));
    }

    this.history.push({
      turn: turnIndex,
      action: toolCalls.map((c) => c.name).join(", "),
      result: observations.map((o) => o.content).join("\n---\n"),
    });

    let gateResult: GateResult | undefined;
    let stopReason: ExecutionStopReason | undefined;

    if (this.tools.wantsFinish()) {
      gateResult = await this.runVerification();

      if (gateResult.passed) {
        this.isFinished = true;
        this.lastGateFailure = undefined;
        this.ladder.reset();
        this.activeRung = undefined;
        stopReason = "gate_passed";
      } else {
        // The repair cycle: surface the typed failure so the next prompt carries
        // it, and let the agent keep working rather than ending the card here.
        this.repairAttempts++;
        this.lastGateFailure = gateResult.failures[0];

        const policy = this.ladder.recordFailure();
        this.activeRung = policy;

        this.history.push({
          turn: turnIndex,
          action: "verification",
          result: `Gates FAILED (${this.ladder.describe(this.lastGateFailure)}): ${
            this.lastGateFailure?.errorExcerpt ?? "unknown failure"
          }`,
        });

        // A rung that resets context drops accumulated history so the next
        // attempt re-reads the tree instead of trusting a stale belief about it.
        if (policy.resetContext) {
          this.history = this.history.slice(-1);
          this.repoMapCache = undefined;
          this.oscillationDetector.reset();
        }

        if (this.ladder.exhausted) {
          stopReason = "repair_exhausted";
        }
      }
    }

    if (!stopReason && this.stepsUsed >= this.stepBudget) {
      stopReason = "budget_exhausted";
    }

    const result: TurnResult = { turnIndex, toolCalls, observations, usage: response.usage };
    if (gateResult) result.gateResult = gateResult;
    if (stopReason) result.stopReason = stopReason;
    return result;
  }

  /** Run the card to completion or to a stop condition, returning every turn taken. */
  public async run(): Promise<TurnResult[]> {
    const turns: TurnResult[] = [];
    while (!this.isFinished && this.stepsUsed < this.stepBudget) {
      const turn = await this.executeTurn();
      turns.push(turn);
      if (turn.stopReason && turn.stopReason !== "budget_exhausted") break;
      if (turn.stopReason === "budget_exhausted") break;
    }
    return turns;
  }

  public async runVerification(): Promise<GateResult> {
    const rungs = this.options.gateRungs ?? ["typecheck", "test"];
    return this.options.gateRunner.runGates(rungs, this.tools.root);
  }

  public async abort(reason: string): Promise<void> {
    this.isFinished = true;
    this.history.push({
      turn: this.stepsUsed,
      action: "abort",
      result: `Session aborted: ${reason}`,
    });
  }

  // --- Direct tool access ----------------------------------------------------
  // Used by harness code and tests that need typed values rather than the prose
  // observations the model consumes.

  public async readFile(relativePath: string): Promise<string> {
    return this.tools.readRaw(relativePath);
  }

  public async writeFile(relativePath: string, content: string): Promise<void> {
    this.tools.writeRaw(relativePath, content);
  }

  public async executeReadFile(
    relativePath: string,
    startLine?: number,
    endLine?: number,
  ): Promise<string> {
    const content = await this.readFile(relativePath);
    if (startLine === undefined && endLine === undefined) return content;
    const lines = content.split("\n");
    const start = Math.max(1, startLine ?? 1) - 1;
    const end = Math.min(lines.length, endLine ?? lines.length);
    return lines.slice(start, end).join("\n");
  }

  private unwrap(observation: ToolObservation): string {
    if (!observation.ok) throw new Error(observation.summary);
    return observation.content;
  }

  public async executeReplaceLines(
    relativePath: string,
    startLine: number,
    endLine: number,
    replacement: string,
  ): Promise<void> {
    this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "replace_lines",
        arguments: { path: relativePath, start: startLine, end: endLine, replacement },
      }),
    );
  }

  public async executeEdit(relativePath: string, search: string, replace: string): Promise<void> {
    this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "edit",
        arguments: { path: relativePath, search, replace },
      }),
    );
  }

  public async readSymbol(relativePath: string, symbolName: string): Promise<string> {
    return this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "read_symbol",
        arguments: { path: relativePath, symbol: symbolName },
      }),
    );
  }

  public async replaceSymbolBody(
    relativePath: string,
    symbolName: string,
    newBody: string,
  ): Promise<void> {
    this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "replace_symbol_body",
        arguments: { path: relativePath, symbol: symbolName, body: newBody },
      }),
    );
  }

  public async insertAfterSymbol(
    relativePath: string,
    symbolName: string,
    contentToInsert: string,
  ): Promise<void> {
    this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "insert_after_symbol",
        arguments: { path: relativePath, symbol: symbolName, content: contentToInsert },
      }),
    );
  }

  public async executeListDir(relPath = "."): Promise<string[]> {
    return this.tools.listDirNames(relPath);
  }

  public async executeFindFiles(pattern: string, relDir = "."): Promise<string[]> {
    return this.tools.findFileList(pattern, relDir);
  }

  public async executeGrepSearch(
    query: string,
    relDir = ".",
  ): Promise<{ file: string; line: number; content: string }[]> {
    return this.tools.grepMatches(query, relDir, false);
  }

  public async findReferences(
    symbolName: string,
    relDir = ".",
  ): Promise<{ file: string; line: number; content: string }[]> {
    return this.tools.grepMatches(symbolName, relDir, true);
  }

  public async executeRunCmd(command: string, args: string[] = []): Promise<ExecutionResult> {
    return this.tools.runCommandRaw(command, args);
  }

  public async executeNote(message: string): Promise<void> {
    await this.tools.execute({ id: "direct", name: "note", arguments: { message } });
  }

  public getNotes(): string[] {
    return this.tools.getNotes();
  }

  public async executeDocs(query: string): Promise<string> {
    const observation = await this.tools.execute({
      id: "direct",
      name: "docs",
      arguments: { query },
    });
    return observation.content;
  }
}
