import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  type PlaybookRegistry,
  type SkillsRegistry,
  type TurnHistoryItem,
  buildFullPromptPack,
  compactHistory,
  maskOlderObservations,
  retrieveMaskedObservation,
} from "@sekhemet/context";
import type { GateFailure, GateResult } from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { type ToolCall, checkExecutionHeadroom, readSwapUsedBytes } from "@sekhemet/models";
import type { ExecutionResult } from "@sekhemet/sandbox";
import { apiHints } from "./api_surface.js";
import { OscillationDetector } from "./detector.js";
import { type LadderState, RepairLadder, type RungPolicy } from "./ladder.js";
import type { ToolObservation } from "./observation.js";
import { buildRepoMap } from "./repo_map.js";
import { TOOL_CATALOG } from "./tool_catalog.js";
import { ToolExecutor } from "./tools.js";
import type {
  CardExecutionSession,
  ExecutionStopReason,
  SessionOptions,
  TurnResult,
} from "./types.js";
import { WorkingMemory } from "./working_memory.js";

/** Turns of tool output kept verbatim before older ones are masked to pointers. */
const VERBATIM_TURN_WINDOW = 2;
/** Turns kept individually before older ones are compacted. */
const COMPACT_AFTER = 8;

/** Tools whose success means a scope file now has content. */
const WRITE_TOOLS = new Set([
  "write_file",
  "edit",
  "replace_lines",
  "replace_symbol_body",
  "insert_after_symbol",
]);

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
  /** Every failure from the last verification, ranked; the prompt shows several. */
  private lastGateFailures: GateFailure[] = [];
  /** The last `check` result, and whether a file was written after it. */
  private lastCheck: GateResult | undefined;
  private writtenSinceCheck = true;
  /** Facts from gate results that survive resets (see working_memory.ts). */
  private memory = new WorkingMemory();
  private compactedTurns = 0;
  private repairAttempts = 0;
  private repoMapCache: string | undefined;
  private lastSystemPrompt = "";
  private emptyTurns = 0;
  private ladder: RepairLadder;
  private filesWritten = new Set<string>();
  /** A stall has already been converted into one verification run. */
  private forcedVerification = false;
  /** Swap in use when the card started, to detect growth caused by this run. */
  private baselineSwap = readSwapUsedBytes();
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

  /**
   * The source lines at each failure location, as the file stands now.
   *
   * "src/verifier.ts:20:7 TS2375" is a coordinate; a small model often cannot
   * turn it back into the offending code and loops on `check` instead. Showing
   * the line itself (with two lines either side) is what it needs to act.
   */
  private failureCode(failures: GateFailure[]): string {
    const blocks: string[] = [];
    const seen = new Set<string>();
    for (const f of failures) {
      const file = f.location?.file;
      const line = f.location?.line;
      if (!file || !line) continue;
      const abs = isAbsolute(file) ? file : join(this.options.worktreePath, file);
      const rel = relative(this.options.worktreePath, abs);
      const key = `${rel}:${line}`;
      if (seen.has(key) || rel.startsWith("..") || !existsSync(abs)) continue;
      seen.add(key);
      try {
        const lines = readFileSync(abs, "utf8").split("\n");
        const from = Math.max(1, line - 2);
        const to = Math.min(lines.length, line + 2);
        const body = [];
        for (let n = from; n <= to; n++) {
          body.push(`${n === line ? ">" : " "}${String(n).padStart(4)} | ${lines[n - 1] ?? ""}`);
        }
        blocks.push(`${rel}:${line}\n${body.join("\n")}`);
      } catch {
        // An unreadable file just goes without an excerpt.
      }
      if (blocks.length >= 3) break;
    }
    // A wrong member name is a knowledge gap, not a typo: name the real ones.
    const hints = apiHints(
      this.options.worktreePath,
      failures.map((f) => f.errorExcerpt),
    );
    if (hints.length > 0) blocks.push(hints.join("\n"));
    return blocks.join("\n\n");
  }

  /**
   * Run the card's gates as a non-terminal self-check and describe the result.
   *
   * The failures also become the session's standing failure, so the prompt's
   * failure zone and the re-check after the next edit work from them. Without
   * that, run 4's db card saw its errors only in a truncated history line and
   * called `check` five times in a row until the loop detector stopped it.
   */
  private async checkObservation(): Promise<ToolObservation> {
    if (!this.writtenSinceCheck && this.lastCheck && !this.lastCheck.passed) {
      return {
        tool: "check",
        ok: false,
        summary: "no change since the last check",
        content: `Nothing has changed since your last check, so the same failures stand. Checking again cannot change the result: edit the code first.\n${this.lastCheck.failures
          .map(
            (f, i) =>
              `${i + 1}. ${f.errorExcerpt.split("\n")[0]}${f.suggestedAction ? `\n   fix: ${f.suggestedAction}` : ""}`,
          )
          .join("\n")}${(() => {
          const code = this.failureCode(this.lastCheck.failures);
          return code ? `\n\nThe code at those lines:\n${code}` : "";
        })()}`,
      };
    }
    const result = await this.runVerification();
    this.lastCheck = result;
    this.writtenSinceCheck = false;
    if (result.passed) {
      return {
        tool: "check",
        ok: true,
        summary: "all gates pass",
        content: "All gates pass. The card is complete.",
      };
    }
    this.lastGateFailure = result.failures[0];
    this.lastGateFailures = result.failures;
    const lines = result.failures.map((f, i) => {
      const where = f.location
        ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ""} `
        : "";
      const action = f.suggestedAction ? `\n   fix: ${f.suggestedAction}` : "";
      return `${i + 1}. [${f.gate ?? f.rung}] ${where}${f.errorExcerpt.split("\n")[0]}${action}`;
    });
    const code = this.failureCode(result.failures);
    if (code) lines.push(`\nThe code at those lines:\n${code}`);
    return {
      tool: "check",
      ok: false,
      summary: `gates failing: ${[...new Set(result.failures.map((f) => f.gate ?? f.rung))].join(", ")}`,
      content: `Gates failing (not submitted — keep working):\n${lines.join("\n")}`,
    };
  }

  /**
   * Bring a compacted observation back in full. Compaction is only safe if it
   * is reversible: Claude Code can re-read what it summarised, and so can the
   * Worker, by the EvidenceRef in the placeholder.
   */
  private recallObservation(ref: unknown): ToolObservation {
    const text = typeof ref === "string" ? retrieveMaskedObservation(ref.trim()) : undefined;
    return text === undefined
      ? {
          tool: "recall",
          ok: false,
          summary: "unknown ref",
          content: `No compacted observation has the ref ${String(ref)}. Copy the EvidenceRef exactly as shown.`,
        }
      : { tool: "recall", ok: true, summary: `recalled ${text.length} chars`, content: text };
  }

  /**
   * History as the prompt sees it. Past COMPACT_AFTER turns, or as soon as the
   * prompt had to be reduced, older turns fold into one compacted entry; at
   * the tightest level only the compacted index and the last turn remain.
   */
  private compactedHistory(level: number): TurnHistoryItem[] {
    const keep = level >= 4 ? 1 : level >= 1 ? 3 : 6;
    if (this.history.length <= COMPACT_AFTER && level === 0) return this.history;
    const { turns, compacted } = compactHistory(this.history, keep, { cardId: this.cardId });
    this.compactedTurns = Math.max(this.compactedTurns, compacted);
    return turns;
  }

  /** How many turns the prompt has folded into a compacted entry, for evidence. */
  public getCompactedTurns(): number {
    return this.compactedTurns;
  }

  /** Scope-relative paths written during this card. */
  public getFilesWritten(): string[] {
    return [...this.filesWritten].sort();
  }

  /** True when every declared scope file has been written at least once. */
  public isScopeComplete(): boolean {
    return this.filesWritten.size > 0 && this.pendingScopeFiles().length === 0;
  }

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

  /**
   * Acceptance tests and current scope-file contents, for the prompt.
   *
   * Capped per file so a large scope file cannot crowd out the rest of the
   * context; anything larger is left for read_file with a line range.
   */
  private pinnedFiles(): { path: string; content: string; label: string }[] {
    const MAX_CHARS = 6000;
    const pinned: { path: string; content: string; label: string }[] = [];

    const add = (path: string, label: string): void => {
      try {
        const content = this.tools.readRaw(path);
        if (content.length <= MAX_CHARS) pinned.push({ path, content, label });
      } catch {
        if (label === "scope file") pinned.push({ path, content: "", label });
      }
    };

    for (const name of this.card.acceptanceTests ?? []) add(`tests/${name}`, "acceptance test");
    for (const path of this.options.scopeFiles ?? []) add(path, "scope file");
    return pinned;
  }

  /** Declared scope files not yet written during this card. */
  private pendingScopeFiles(): string[] {
    const scope = this.options.scopeFiles ?? [];
    return scope.filter((f) => !this.filesWritten.has(f.replace(/^\.\//, "")));
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
  /** Tool schemas sent alongside the prompt; they count against the window too. */
  private toolDefinitions() {
    const catalog = this.options.tools ?? TOOL_CATALOG;
    return catalog.map((t) => ({
      name: t.name,
      description: t.summary,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          t.parameters.map((p) => [
            p.name,
            {
              type: p.type,
              description: p.description,
              ...(p.type === "array" ? { items: { type: "string" } } : {}),
            },
          ]),
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    }));
  }

  /** The request budget in tokens, if the adapter's window is known. */
  private promptBudget(): number | undefined {
    if (this.options.promptTokenBudget !== undefined) return this.options.promptTokenBudget;
    const window = this.options.modelAdapter.contextWindow;
    // A margin for tokenizer disagreement with the character estimate below.
    return window ? window.contextTokens - window.maxTokens - 256 : undefined;
  }

  /**
   * Build a prompt that fits the model's window, reducing context in stages.
   *
   * A long card's history grows every turn; on a live run the ledger card's
   * request reached 8,224 tokens against an 8,192 window at turn 32 and the
   * server rejected it. Reductions go from least to most informative lost:
   * fewer verbatim turns, then the repo map, then the pinned scope files (the
   * agent can read_file them), then all but the last turn, then trimmed tests.
   */
  private buildPrompt(): { systemPrompt: string; prompt: string; reduction: number } {
    const budget = this.promptBudget();
    const toolChars = JSON.stringify(this.toolDefinitions()).length;
    // Code tokenizes denser than prose; ~3.2 chars per token errs on the safe side.
    const estimate = (p: { systemPrompt: string; prompt: string }): number =>
      Math.ceil((p.systemPrompt.length + p.prompt.length + toolChars) / 3.2);

    let last: { systemPrompt: string; prompt: string } | undefined;
    for (let level = 0; level <= 5; level++) {
      last = this.buildPromptAt(level);
      if (budget === undefined || estimate(last) <= budget) return { ...last, reduction: level };
    }
    return { ...(last as { systemPrompt: string; prompt: string }), reduction: 6 };
  }

  private buildPromptAt(level: number): { systemPrompt: string; prompt: string } {
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
      ...(level >= 2 ? {} : { repoMap: this.repoMap() }),
      pinnedFiles: this.pinnedFiles()
        .filter((f) => level < 3 || f.label !== "scope file")
        .map((f) =>
          level >= 5 && f.content.length > 4000
            ? {
                ...f,
                content: `${f.content.slice(0, 4000)}\n… (truncated to fit the context window)`,
              }
            : f,
        ),
      // Per-card, so it rides in the volatile zone: in the system zone it would
      // both break the cacheable prefix and overrun that zone's budget.
      ...(this.options.managerGuidance ? { managerGuidance: this.options.managerGuidance } : {}),
      activeSkills: skills,
      playbookRules,
      recentTurns: maskOlderObservations(
        this.compactedHistory(level),
        level >= 1 ? 1 : VERBATIM_TURN_WINDOW,
      ),
      // The catalog is what tells the model these tools exist at all.
      tools: this.options.tools ?? TOOL_CATALOG,
      // What it has already done, and what remains. An agent with no record of
      // its own progress repeats its last successful action indefinitely.
      ...(this.filesWritten.size > 0 ||
      this.tools.getReadFiles().length > 0 ||
      this.memory.lines().length > 0
        ? {
            completedWork: [
              ...[...this.filesWritten].sort().map((f) => `wrote ${f}`),
              // Listing what was already read is what stops the agent spending
              // its budget re-reading files it has in front of it.
              ...this.tools.getReadFiles().map((f) => `read ${f} (do not re-read)`),
              ...this.memory.lines(),
            ],
          }
        : {}),
      ...(this.pendingScopeFiles().length > 0
        ? { openTodos: this.pendingScopeFiles() }
        : { readyToVerify: this.filesWritten.size > 0 }),
      // The card's own contract. Without it the model has only a title to work
      // from and invents the rest — which is exactly what it does.
      ...(this.card.spec ? { goal: this.card.spec } : {}),
      ...(this.card.acceptanceCriteria?.length
        ? { acceptanceCriteria: this.card.acceptanceCriteria }
        : {}),
      ...(this.lastGateFailure ? { gateFailure: this.lastGateFailure } : {}),
      ...(this.lastGateFailures.length > 1
        ? { otherGateFailures: this.lastGateFailures.slice(1) }
        : {}),
      ...(this.lastGateFailures.length > 0
        ? { failureCode: this.failureCode(this.lastGateFailures) }
        : {}),
    });

    return pack;
  }

  public async executeTurn(): Promise<TurnResult> {
    // Check headroom before spending a turn: stopping here is resumable,
    // letting the host run out of memory is not.
    // Enabled by the CLI and eval harness for real runs; unit tests with mock
    // adapters leave it off so their outcome does not depend on host swap.
    if (this.options.memoryGuard) {
      const verdict = checkExecutionHeadroom(this.baselineSwap, this.options.memoryGuard);
      if (!verdict.ok) {
        this.history.push({
          turn: this.stepsUsed,
          action: "memory guard",
          result: `Execution paused: ${verdict.reason}`,
        });
        return {
          turnIndex: this.stepsUsed,
          toolCalls: [],
          observations: [],
          stopReason: "memory_pressure",
        };
      }
    }

    this.stepsUsed++;
    const turnIndex = this.stepsUsed;

    const { systemPrompt, prompt } = this.buildPrompt();
    this.lastSystemPrompt = systemPrompt;

    const response = await this.options.modelAdapter.generate({
      systemPrompt,
      prompt,
      // Names travel with the request so the parser can recognise a call in
      // whatever syntax the model chose to emit it.
      // Real JSON Schema, so servers with native tool calling can constrain
      // the call format instead of leaving the model to improvise one.
      tools: this.toolDefinitions(),
      toolArm: this.options.toolArm ?? "arm_a_flat",
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    });

    const toolCalls = response.toolCalls;

    // A turn that produced no actionable call is a stall signal in its own right:
    // tell the model plainly rather than silently burning the step budget.
    if (toolCalls.length === 0) {
      this.emptyTurns++;
      // Show the model what it actually said. A bare "no tool calls" gives it
      // nothing to correct; quoting its own reply and the expected form does.
      const said = response.text.trim().replace(/\s+/g, " ").slice(0, 240);
      this.history.push({
        turn: turnIndex,
        action: "(no tool calls)",
        result: `No tool call could be parsed from your reply${
          said ? `, which began: "${said}"` : " (it was empty)"
        }. Reply with a tool call only, for example: edit(path="src/file.ts", search="exact old text", replace="new text") or write_file(path="src/file.ts", content="...") or finish_card().`,
      });
      const result: TurnResult = {
        turnIndex,
        toolCalls: [],
        observations: [],
        usage: response.usage,
        rawText: response.text,
      };
      if (this.emptyTurns >= 3) result.stopReason = "no_progress";
      else if (this.stepsUsed >= this.stepBudget) result.stopReason = "budget_exhausted";
      return result;
    }
    this.emptyTurns = 0;

    const repoStateHash = await this.currentRepoStateHash();
    if (this.oscillationDetector.recordAndCheck(toolCalls, repoStateHash)) {
      // A stalled agent that has already written every declared scope file has
      // done the work and merely cannot tell that it is finished. Discarding
      // that is the worst available outcome: verify it instead. If the gates
      // pass the card is done; if they fail, the typed failure is exactly the
      // feedback the agent was unable to obtain for itself.
      const scopeComplete = this.filesWritten.size > 0 && this.pendingScopeFiles().length === 0;

      if (scopeComplete && !this.forcedVerification) {
        this.forcedVerification = true;
        this.oscillationDetector.reset();

        const forced = await this.runVerification();
        this.history.push({
          turn: turnIndex,
          action: "forced verification",
          result: forced.passed
            ? "Repeated actions detected; verification was run and PASSED."
            : `Repeated actions detected; verification was run and FAILED: ${
                forced.failures[0]?.errorExcerpt ?? "unknown failure"
              }`,
        });

        if (forced.passed) {
          this.isFinished = true;
          this.ladder.reset();
          return {
            turnIndex,
            toolCalls,
            observations: [],
            usage: response.usage,
            gateResult: forced,
            stopReason: "gate_passed",
          };
        }

        this.lastGateFailure = forced.failures[0];
        this.lastGateFailures = forced.failures;
        this.activeRung = this.ladder.recordFailure();
        return {
          turnIndex,
          toolCalls,
          observations: [],
          usage: response.usage,
          gateResult: forced,
        };
      }

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
      // `check` runs the real gates without ending the card: the agent was
      // spending most of its turns trying to self-verify with shell commands.
      const observation =
        call.name === "check"
          ? await this.checkObservation()
          : call.name === "recall"
            ? this.recallObservation(call.arguments.ref)
            : await this.tools.execute(call);
      observations.push(observation);

      if (observation.ok && WRITE_TOOLS.has(call.name)) {
        const path = call.arguments.path;
        if (typeof path === "string") this.filesWritten.add(path.replace(/^\.\//, ""));
        this.writtenSinceCheck = true;
        if (typeof path === "string") this.memory.noteWrite(path);
      }
    }

    this.history.push({
      turn: turnIndex,
      action: toolCalls.map((c) => c.name).join(", "),
      result: observations.map((o) => o.content).join("\n---\n"),
    });

    let gateResult: GateResult | undefined;
    let stopReason: ExecutionStopReason | undefined;

    // Re-check after every edit while a failure is outstanding. Without it the
    // agent edited blind: Chronicle's ledger card fixed the one error it was
    // shown, then spent 25 turns re-reading files while seven more stood, and
    // ran out of budget without ever verifying again. This is feedback, not a
    // submission: it does not climb the repair ladder.
    const wroteThisTurn = toolCalls.some(
      (c, i) => WRITE_TOOLS.has(c.name) && observations[i]?.ok === true,
    );
    const checkedThisTurn = toolCalls.some((c) => c.name === "check");

    // A passing check with nothing written after it is a finished card: asking
    // for a separate finish_card only costs a turn.
    if (checkedThisTurn && this.lastCheck?.passed && !this.writtenSinceCheck) {
      this.isFinished = true;
      this.lastGateFailure = undefined;
      this.lastGateFailures = [];
      this.ladder.reset();
      this.activeRung = undefined;
      gateResult = this.lastCheck;
      stopReason = "gate_passed";
    }
    if (
      !stopReason &&
      !this.tools.wantsFinish() &&
      this.lastGateFailure &&
      wroteThisTurn &&
      !checkedThisTurn
    ) {
      const recheck = await this.runVerification();
      if (recheck.passed) {
        this.isFinished = true;
        this.lastGateFailure = undefined;
        this.lastGateFailures = [];
        this.ladder.reset();
        this.activeRung = undefined;
        this.history.push({
          turn: turnIndex,
          action: "re-check after edit",
          result: "All gates pass.",
        });
        gateResult = recheck;
        stopReason = "gate_passed";
      } else {
        this.lastGateFailure = recheck.failures[0];
        this.lastGateFailures = recheck.failures;
        this.history.push({
          turn: turnIndex,
          action: "re-check after edit",
          result: `Still failing (${recheck.failures.length} shown): ${recheck.failures
            .map((f) => f.errorExcerpt.split("\n")[0])
            .join(" | ")}`,
        });
      }
    }

    if (!stopReason && this.tools.wantsFinish()) {
      gateResult = await this.runVerification();

      if (gateResult.passed) {
        this.isFinished = true;
        this.lastGateFailure = undefined;
        this.lastGateFailures = [];
        this.ladder.reset();
        this.activeRung = undefined;
        stopReason = "gate_passed";
      } else {
        // The repair cycle: surface the typed failure so the next prompt carries
        // it, and let the agent keep working rather than ending the card here.
        this.repairAttempts++;
        this.lastGateFailure = gateResult.failures[0];
        this.lastGateFailures = gateResult.failures;

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

    const result: TurnResult = {
      turnIndex,
      toolCalls,
      observations,
      usage: response.usage,
      rawText: response.text,
    };
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
    const autofix = this.options.autofixCommand;
    const scope = this.options.scopeFiles ?? [];
    if (autofix && autofix.length > 0 && scope.length > 0) {
      const [command, ...args] = autofix as [string, ...string[]];
      // Best effort: a formatter failure is reported by the lint gate itself.
      await this.tools.runCommandRaw(command, [...args, ...scope]).catch(() => undefined);
    }
    // Purely stylistic rules the formatter will not fix, one rule per run.
    for (const argv of scope.length > 0 ? (this.options.styleFixCommands ?? []) : []) {
      const [command, ...args] = argv as [string, ...string[]];
      if (!command) continue;
      await this.tools.runCommandRaw(command, [...args, ...scope]).catch(() => undefined);
    }
    const rungs = this.options.gateRungs ?? ["typecheck", "test"];
    const result = await this.options.gateRunner.runGates(rungs, this.tools.root);
    this.memory.observe(result);
    return result;
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
