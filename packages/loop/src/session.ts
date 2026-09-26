import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  TOOL_SEARCH_NAME,
  type ToolInterfaceSpec,
  ToolLoader,
  type TurnHistoryItem,
  type WorkerPromptResult,
  buildRankedRepoMap,
  buildWorkerPrompt,
  condenseToolOutput,
  cardClassOf as contextCardClass,
  loadProjectConventions,
  retrieveMaskedObservation,
  runSubtask,
  workerCopy,
} from "@sekhemet/context";
import {
  DEFAULT_PROJECT_CONFIG,
  type GateFailure,
  type GateResult,
  type GateRung,
  RERUN_GATES,
  builtinGateIds,
  checkBounds,
  finalizeFailures,
  gateCopy,
  importGraph,
  onlyNotRun,
  runBuiltinGates,
} from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import {
  REASONING_BUDGET_TOKENS,
  type ReasoningDecision,
  checkExecutionHeadroom,
  looksLikeToolCallAttempt,
  readSwapUsedBytes,
  reasoningForStep,
} from "@sekhemet/models";
import { UNTRUSTED_CONTRACT, containsUntrusted, tagUntrusted } from "@sekhemet/sandbox";
import type { ExecutionResult } from "@sekhemet/sandbox";
import { apiHints } from "./api_surface.js";
import { OscillationDetector } from "./detector.js";
import {
  type EvidenceRecord,
  changedExportedSignatures,
  missingEvidence,
  readRanges,
  shownLineRanges,
} from "./evidence_gate.js";
import {
  integrityFailures,
  scanDiffIntegrity,
  worktreeDiff,
  worktreeNumstat,
} from "./integrity.js";
import { type LadderState, RepairLadder, type RungPolicy } from "./ladder.js";
import { type ToolObservation, fail } from "./observation.js";
import { PHASE_WRITE_TOOLS, phaseOf } from "./phase.js";
import { buildRepoMap, dataContracts } from "./repo_map.js";
import { splitLines, toLf } from "./text.js";
import {
  TOOL_CATALOG,
  cardClassFor,
  restrictedToolCatalog,
  toolsForClass,
} from "./tool_catalog.js";
import { toolDefinition } from "./tool_schema.js";
import { ToolExecutor } from "./tools.js";
import type {
  CardExecutionSession,
  ExecutionStopReason,
  ParkDiagnosis,
  ReplanRequest,
  SessionOptions,
  TurnResult,
} from "./types.js";
import { WorkingMemory } from "./working_memory.js";

/**
 * C19: the tools the Worker reaches for on nearly every card. Their contracts
 * stay in the prompt from the first turn; everything else is a name in the
 * index until `tool_search` loads it. Paying for the long tail of schemas on
 * every turn of every card is what progressive disclosure exists to stop.
 */
const PROGRESSIVE_CORE_TOOLS = ["read_file", "edit", "write_file", "check", "finish_card"];

/** Tools whose success means a scope file now has content. */
const WRITE_TOOLS = PHASE_WRITE_TOOLS;

/** Tokens kept free of the window for tokenizer disagreement (rule 22). */
const WINDOW_MARGIN_TOKENS = 256;

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
/**
 * One command, however its output is trimmed: `npx vitest run x 2>&1 | tail -30`
 * and `... | tail -60` are the same run.
 */
export function normaliseCommand(command: string): string {
  return command
    .replace(/^\s*cd\s+\S+\s*&&\s*/, "")
    .replace(/\s*2>&1/g, "")
    .replace(/\s*\|\s*(?:tail|head)(?:\s+-n)?\s+-?\d+\s*$/g, "")
    .replace(/\s+--no-colou?rs?\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A file's content after a write tool call, without writing it, for the
 * evidence-gated commit's signature check (WL-N9-2). Undefined when the call
 * would not apply or cannot change a signature (a symbol body, an insertion).
 */
function prospectiveContent(
  call: { name: string; arguments: Record<string, unknown> },
  before: string,
): string | undefined {
  const a = call.arguments;
  if (call.name === "write_file") return typeof a.content === "string" ? a.content : undefined;
  if (call.name === "edit") {
    if (typeof a.search !== "string" || typeof a.replace !== "string" || a.search === "") {
      return undefined;
    }
    // As the real edit does: match on LF-normalised text (review minor 4).
    const text = toLf(before);
    const search = toLf(a.search);
    const replace = toLf(a.replace);
    return text.split(search).length === 2 ? text.replace(search, () => replace) : undefined;
  }
  if (call.name === "replace_lines") {
    const start = Number(a.start);
    const end = Number(a.end);
    if (typeof a.replacement !== "string" || !(start >= 1) || !(end >= start)) return undefined;
    const lines = toLf(before).split("\n");
    lines.splice(start - 1, end - start + 1, ...toLf(a.replacement).split("\n"));
    return lines.join("\n");
  }
  return undefined;
}

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
  /** What the harness observed this attempt, for the evidence-gated commit (rule 29a). */
  private evidence: EvidenceRecord[] = [];
  /** The scope files the staged acceptance tests import (WL-N9-1), once per attempt. */
  private acceptanceImports: string[] | undefined;
  /** The worktree's import graph for WL-N9-2, until the next write changes it. */
  private importGraphCache: { files: string[]; graph: Map<string, Set<string>> } | undefined;
  /** A finish the evidence gate turned into a check that passed: the card ends gate_passed. */
  private evidenceCheckPassed = false;
  /**
   * The verification the evidence gate's check just ran, when it found only
   * gates that could not run or the runner threw: the normal finish path
   * reuses it rather than run the gates a second time (follow-up 1), so the
   * switch adds no gate run to an A/B's cost. Cleared by a write.
   */
  private finishVerification: { result: GateResult } | { error: unknown } | undefined;
  /** Facts from gate results that survive resets (see working_memory.ts). */
  private memory = new WorkingMemory();
  private compactedTurns = 0;
  private rulesUsed = new Set<string>();
  private repairAttempts = 0;
  private repoMapCache: string | undefined;
  private lastSystemPrompt = "";
  private emptyTurns = 0;
  private ladder: RepairLadder;
  private filesWritten = new Set<string>();
  /** A stall has already been converted into one verification run. */
  private forcedVerification = false;
  /** Set when a stall is first detected; delivered with the next observations. */
  private pendingStallWarning: string | undefined;
  /** Turns this session has sent, for the thinking policy. */
  private turnsTaken = 0;
  /** Whether the previous turn failed a check or the gates. */
  private lastTurnFailed = false;
  /** Strict method: each command's last run, keyed by its normalised text. */
  private commandRuns = new Map<string, { turn: number; effects: number; content: string }>();
  private lastCommandKey = "";
  /** Writes plus distinct commands run: anything that may have changed the tree. */
  private effects = 0;
  /** Swap in use when the card started, to detect growth caused by this run. */
  private baselineSwap = readSwapUsedBytes();
  private activeRung: RungPolicy | undefined;
  /** Set by `abort`; the next turn stops with `human_abort` without calling the model. */
  private abortReason: string | undefined;
  /** EXT-22a: skills left out of a prompt for missing tools, by name. */
  private skillsOmitted = new Map<string, { name: string; missingTools: string[] }>();
  /** EXT-25: skill bodies cut to their budget, by name. */
  private skillsTruncated = new Map<
    string,
    { name: string; budgetTokens: number; keptTokens: number; originalTokens: number }
  >();
  /** WL-N10-2: who paused the card; the next step boundary stops it resumably. */
  private pausedBy: string | undefined;
  /** A re-plan has been applied to this card (from the start, or in-loop). */
  private replanned: boolean;
  /** The plan an in-loop re-plan produced, shown with the manager's guidance. */
  private replanGuidance: string | undefined;
  private replanRequest: ReplanRequest | undefined;
  /** Successful writes this card, so the runner can tell when to checkpoint. */
  private writeCount = 0;
  /** The last prompt the allocator built (for the transcript and evidence). */
  private lastPrompt: WorkerPromptResult | undefined;
  /** Where the last request's prompt was logged (K11). */
  private lastContextPackId: string | undefined;
  private advisories: string[] = [];
  private conventions: string | undefined;
  private lastPackRecord: WorkerPromptResult["pack"] | undefined;
  private lastMetrics: WorkerPromptResult["metrics"] | undefined;
  /** Progressive tool loading (C19), when the card runs with `progressiveTools`. */
  private toolLoader: ToolLoader | undefined;
  /** The tools whose contracts are in the pinned system prompt under C19. */
  private coreToolSpecs: ToolInterfaceSpec[] | undefined;
  /** The prompt budget W, fixed for the attempt (rule 22, WL-M3-5). */
  private readonly promptBudgetW: number | undefined;
  /** What the step's response said about itself, attached to the step result. */
  private stepMeta: Pick<TurnResult, "finishReason" | "truncated" | "formatErrors" | "proseOnly"> =
    {};

  constructor(private options: SessionOptions) {
    // SEC-19: an audit starts no hook and no language server (both execute
    // configuration or code); the visual layer is off below.
    if (options.restricted) this.options = { ...options, hooks: undefined, lspPool: undefined };
    if (options.priorLessons?.length) this.memory.seed(options.priorLessons);
    this.cardId = options.cardId;
    this.stepBudget = options.stepBudget;
    this.card = options.card ?? synthesizeCard(options);
    // L13: the stall threshold is the design's, not the caller's.
    this.oscillationDetector = new OscillationDetector();
    this.ladder = new RepairLadder();
    this.replanned = options.replanned ?? options.managerGuidance !== undefined;
    // The staged acceptance tests are this card's oracle: always protected,
    // on top of whatever the project declares (or the defaults).
    const declared = options.protectedGlobs?.length
      ? options.protectedGlobs
      : DEFAULT_PROJECT_CONFIG.protected;
    const staged = (this.card.acceptanceTests ?? []).map((t) =>
      t.startsWith("tests/") ? t : `tests/${t}`,
    );
    this.tools = new ToolExecutor({
      worktreePath: options.worktreePath,
      scopeFiles: options.scopeFiles,
      agentRole: options.agentRole,
      allowNetwork: options.allowNetwork,
      commandTimeoutMs: options.commandTimeoutMs,
      onApproval: options.onApproval,
      requireConfinement: options.requireConfinement,
      sandbox: options.sandbox,
      protectedGlobs: [...new Set([...declared, ...staged])],
      requireReadBeforeEdit: options.requireReadBeforeEdit,
      readOnly: options.restricted === true,
      allowedDomains: options.allowedDomains,
      egressProxyPort: options.egressProxyPort,
      lspPool: this.options.lspPool,
      cardClass: cardClassFor(this.card),
      webDocs: options.webDocs,
      recallOffered: this.recallOffered(),
    });
    this.promptBudgetW = this.fixPromptBudget();
    if (options.progressiveTools) {
      this.toolLoader = new ToolLoader(this.catalog(), PROGRESSIVE_CORE_TOOLS);
      this.coreToolSpecs = this.toolLoader.visibleSpecs();
    }
    // H17: a resumed card continues its step count from the checkpoint.
    if (options.startStep !== undefined && options.startStep > 0) {
      this.stepsUsed = Math.floor(options.startStep);
      this.history.push(...(options.priorHistory ?? []));
      this.history.push({
        turn: this.stepsUsed,
        action: "resume",
        result: `Resumed from the checkpoint at step ${this.stepsUsed}. The files are as they were then; read what you need before editing.`,
      });
    }
  }

  /** Successful writes so far (the runner checkpoints when this moves). */
  public getWriteCount(): number {
    return this.writeCount;
  }

  /** The re-plan this card asked for, when it stopped with `replan_requested`. */
  public getReplanRequest(): ReplanRequest | undefined {
    return this.replanRequest;
  }

  public isReplanned(): boolean {
    return this.replanned;
  }

  /**
   * Why this card should be parked, for the human who picks it up (L15 rung 4,
   * L22 budget exhaustion).
   *
   * `suggestion` is where a stop reason names its next action. A caller that
   * knows more than the session does — the runner, which holds the budgets and
   * what they cost — supplies its own diagnosis instead.
   */
  public getParkDiagnosis(
    stopReason: ParkDiagnosis["stopReason"],
    diagnosis?: string,
  ): ParkDiagnosis {
    const failures = this.lastGateFailures.slice(0, 3).map((f) => ({
      gate: f.gate ?? f.rung,
      excerpt: f.errorExcerpt.split("\n")[0]?.slice(0, 300) ?? "",
      ...(f.location?.file
        ? { location: `${f.location.file}${f.location.line ? `:${f.location.line}` : ""}` }
        : {}),
    }));
    const first = failures[0];
    const suggestion =
      diagnosis ??
      (stopReason === "capability_ceiling"
        ? `A re-planned attempt also exhausted the repair ladder${first ? ` on ${first.gate}` : ""}. Split the card, give it to a stronger model, or fix ${first?.location ?? "the failing location"} by hand.`
        : first
          ? `Four repair rungs could not clear ${first.gate}${first.location ? ` at ${first.location}` : ""}. Re-plan the card or answer what the failure needs.`
          : "The repair ladder ran out without a typed failure; re-run the gates by hand.");
    return {
      cardId: this.cardId,
      stopReason,
      attempts: this.ladder.snapshot.totalAttempts,
      replanned: this.replanned,
      failures,
      filesWritten: this.getFilesWritten(),
      lessons: this.memory.lines(),
      suggestion,
    };
  }

  /**
   * Apply the ladder's verdict after a failed verification (L15).
   *
   * Rung 3 asks for a re-plan once per card: fulfilled in-loop when the
   * harness supplied `onReplan`, otherwise the card stops so the harness can
   * plan and retry. Rung 4 stops the card for parking; after a re-plan that is
   * the model's capability ceiling on this card.
   */
  private async applyLadder(
    policy: RungPolicy,
    turnIndex: number,
  ): Promise<ExecutionStopReason | undefined> {
    if (this.ladder.exhausted) {
      return this.replanned ? "capability_ceiling" : "repair_exhausted";
    }
    if (!policy.replan || this.replanned) return undefined;
    const failures = this.lastGateFailures.slice(0, 3);
    const request: ReplanRequest = {
      cardId: this.cardId,
      attempts: this.ladder.snapshot.totalAttempts,
      failures,
      filesWritten: this.getFilesWritten(),
      lessons: this.memory.lines(),
      summary: `Card ${this.cardId} failed verification ${this.ladder.snapshot.totalAttempts} time(s) through direct repair and a fresh context. Standing failure${failures.length === 1 ? "" : "s"}: ${
        failures.map((f) => f.errorExcerpt.split("\n")[0]).join(" | ") || "unknown"
      }. Files written: ${this.getFilesWritten().join(", ") || "none"}.`,
    };
    this.replanned = true;
    const plan = this.options.onReplan
      ? await this.options.onReplan(request).catch(() => undefined)
      : undefined;
    if (plan?.trim()) {
      this.replanGuidance = plan.trim();
      this.history.push({
        turn: turnIndex,
        action: "re-plan",
        result: "The planner produced a new plan for this card; it is shown above. Follow it.",
      });
      return undefined;
    }
    this.replanRequest = request;
    return "replan_requested";
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
      // Long gate output goes through the same condenser as run_cmd (C8):
      // error lines are protected, and the raw text stays recallable.
      content: this.tools.countCondensed(
        condenseToolOutput(`Gates failing (not submitted — keep working):\n${lines.join("\n")}`, {
          command: "check",
          exitCode: 1,
          cardId: this.cardId,
          turn: this.stepsUsed,
          recallOffered: this.recallOffered(),
        }),
      ).text,
    };
  }

  /**
   * The Worker asks instead of guessing (AutoDev's ask command, arXiv
   * 2403.08299). Unattended runs have no human to wait for, so the answer
   * comes from the card's own contract: spec, Done-when and the rules in
   * force, best matches first. When nothing covers it, the Worker is told to
   * take the most conservative reading the acceptance tests allow and to
   * record the assumption, which the human then sees in review.
   */
  private async askObservation(question: unknown): Promise<ToolObservation> {
    const q = typeof question === "string" ? question.trim() : "";
    if (!q)
      return {
        tool: "ask",
        ok: false,
        summary: "empty question",
        content: "Ask a specific question.",
      };
    const words = new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((w) => w.length > 3),
    );
    const sources = [
      ...(this.card.spec ?? "").split(/(?<=[.!?])\s+|\n+/).map((t) => ({ from: "spec", t })),
      ...(this.card.acceptanceCriteria ?? []).map((t) => ({ from: "done when", t })),
      ...(this.options.playbookRegistry?.getAllRules() ?? []).map((r) => ({
        from: "rule",
        t: r.instruction,
      })),
    ].filter((x) => x.t.trim().length > 0);
    const scored = sources
      .map((x) => ({
        ...x,
        score: x.t
          .toLowerCase()
          .split(/[^a-z0-9_]+/)
          .filter((w) => words.has(w)).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    this.tools
      .execute({ id: "ask-note", name: "note", arguments: { message: `Asked: ${q}` } })
      .catch(() => undefined);
    // Every question goes into the card's dossier, so the next attempt and
    // the reviewer see what was unclear (integration review item 6).
    const questionEntryId = await this.options.recordQuestion?.(q).catch(() => undefined);
    if (scored.length === 0 && this.options.askTeam) {
      // Not in the contract: ask the team. Seshat answers now if it is
      // resident; otherwise the question waits for its next turn on the host.
      const reply = await this.options
        .askTeam(q, questionEntryId ? { questionEntryId } : {})
        .catch(() => undefined);
      if (reply) {
        await this.options.recordAnswer?.(reply, questionEntryId).catch(() => undefined);
        return {
          tool: "ask",
          ok: true,
          summary: "answered by Seshat",
          content: `Seshat (project manager) answers: ${reply}`,
        };
      }
      return {
        tool: "ask",
        ok: true,
        summary: "queued for Seshat",
        content:
          'The contract does not answer that, and Seshat is not loaded right now; your question is queued for it. Proceed with the most conservative reading the acceptance tests allow and record the assumption with note("Assumed: ...").',
      };
    }
    if (scored.length === 0) {
      return {
        tool: "ask",
        ok: true,
        summary: "no answer in the contract",
        content:
          'Nothing in the card\'s spec, Done-when list or rules answers that. Take the most conservative reading that the acceptance tests allow, then record the assumption with note("Assumed: ...") so the reviewer sees it.',
      };
    }
    return {
      tool: "ask",
      ok: true,
      summary: `answered from ${scored.map((x) => x.from).join(", ")}`,
      content: `From the card's contract:\n${scored.map((x) => `- (${x.from}) ${x.t.trim()}`).join("\n")}`,
    };
  }

  /**
   * The thinking policy on top of the per-step default. Replays showed the
   * Worker writing before reading the test and guessing APIs, with thinking
   * off on every ordinary turn; the suite decides which of these wins.
   */
  private thinkingFor(base: ReasoningDecision): ReasoningDecision {
    const policy = this.options.thinking ?? "off";
    if (policy === "all") {
      return { reasoning: "high", reasoningBudgetTokens: REASONING_BUDGET_TOKENS.high };
    }
    const planning = this.turnsTaken === 0 || this.lastTurnFailed;
    if (policy === "surgical" && planning && base.reasoning === "off") {
      return reasoningForStep({ purpose: "planning" });
    }
    return base;
  }

  /**
   * The strict working method's refusals. Suite run 5's vault card spent its
   * last twelve turns re-running one test command, varying only `| tail -N`,
   * with no edit between; repetition is the small-model signature failure
   * (SWE-smith, arXiv:2504.21798). And a completion claimed over a failing
   * check is wrong by construction. Both are refused with what the model
   * needs to act on, never silently.
   */
  /** A `note` naming a gate this attempt does not run: one line, and nothing recorded. */
  private unknownGateRefusal(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): ToolObservation | undefined {
    const gate = call.arguments.gate;
    if (call.name !== "note" || gate === undefined) return undefined;
    const gates = this.suspectableGates();
    if (typeof gate === "string" && gates.includes(gate)) return undefined;
    return fail(
      "note",
      `unknown gate: ${String(gate)}`,
      workerCopy.unknownGate(String(gate), gates.join(", ") || "none"),
    );
  }

  /** The step record a call leaves for the evidence-gated commit: what ran, never what was said. */
  private recordEvidence(
    call: { name: string; arguments: Record<string, unknown> },
    observation: ToolObservation,
  ): void {
    if (!observation.ok) return;
    const path =
      typeof call.arguments.path === "string" ? call.arguments.path.replace(/^\.\//, "") : "";
    if (call.name === "read_file") {
      const m = /^read .+ lines (\d+)-(\d+) of (\d+)$/.exec(observation.summary);
      if (m && path) {
        // The lines the reply shows, not its summary: a long reply is clamped (review blocker 2).
        const lines = Number(m[3]);
        const requested = { from: Number(m[1]), to: Number(m[2]) };
        for (const [from, to] of shownLineRanges(observation.content, requested)) {
          this.evidence.push({ kind: "read", path, from, to, lines });
        }
      }
    } else if (WRITE_TOOLS.has(call.name) && path) {
      this.evidence.push({ kind: "write", path });
      this.importGraphCache = undefined;
    } else if (call.name === "find_references" && typeof call.arguments.symbol === "string") {
      const symbol = call.arguments.symbol;
      const file =
        typeof call.arguments.file === "string"
          ? call.arguments.file.replace(/^\.\//, "")
          : this.tools.declaringFile(symbol);
      if (file) this.evidence.push({ kind: "references", symbol, file });
    }
  }

  /**
   * Rule 29a: a write or a finish whose evidence is missing is answered with
   * what is missing and the call that supplies it; a finish runs the check
   * instead and returns its result (WL-N9-1 to 3).
   */
  private async evidencePostponement(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<ToolObservation | undefined> {
    const postponed = (content: string): ToolObservation => ({
      tool: call.name,
      ok: false,
      summary: workerCopy.evidencePostponed,
      content,
      deniedRule: "evidence_gate",
    });
    if (call.name === "finish_card") {
      if (!missingEvidence(this.evidence, { kind: "finish" })) return undefined;
      let check: ToolObservation;
      try {
        check = await this.checkObservation();
      } catch (error) {
        // Gates that throw are the normal finish path's to report (gates rule 9).
        this.finishVerification = { error };
        return undefined;
      }
      // Gates that could not run: finish normally, to done_pending_gates (review blocker 1).
      if (!this.lastCheck || onlyNotRun(this.lastCheck)) {
        if (this.lastCheck) this.finishVerification = { result: this.lastCheck };
        return undefined;
      }
      if (this.lastCheck.passed) {
        // The check the finish waited for passed: the card is done (review minor 6).
        this.evidenceCheckPassed = true;
        return { tool: "finish_card", ok: true, summary: check.summary, content: check.content };
      }
      return postponed(`${workerCopy.evidenceFinish}\n${check.content}`);
    }
    const rawPath = call.arguments.path;
    if (!WRITE_TOOLS.has(call.name) || typeof rawPath !== "string") return undefined;
    const path = rawPath.replace(/^\.\//, "");
    // A write outside the scope is the scope refusal's to answer (review minor 5).
    const scope = this.options.scopeFiles?.map((f) => f.replace(/^\.\//, ""));
    if (scope && !scope.includes(path)) return undefined;
    const missing = missingEvidence(this.evidence, {
      kind: "write",
      path,
      importedScopeFiles: this.importedScopeFiles(),
      signatureChanges: this.signatureChanges(call, path),
    });
    if (!missing) return undefined;
    if (missing.kind === "unread") {
      // Reads that each come back whole, under the clamp and the outline threshold.
      const calls = missing.files.flatMap((f) => {
        let source: string;
        try {
          source = this.tools.readRaw(f);
        } catch {
          return [workerCopy.readFileCall(f)];
        }
        const ranges = readRanges(source, f);
        const whole = ranges.length === 1 && splitLines(source).lines.length <= 200;
        return whole
          ? [workerCopy.readFileCall(f)]
          : ranges.map(([a, b]) => workerCopy.readFileRangeCall(f, String(a), String(b)));
      });
      return postponed(workerCopy.evidenceUnread(missing.files.join(", "), calls.join(", ")));
    }
    if (missing.kind === "importers") {
      return postponed(
        workerCopy.evidenceImporters(
          missing.symbol,
          missing.importers.join(", "),
          workerCopy.findReferencesCall(missing.symbol, missing.file),
        ),
      );
    }
    return undefined;
  }

  /** The scope files the staged acceptance tests import (WL-N9-1). */
  private importedScopeFiles(): string[] {
    if (this.acceptanceImports) return this.acceptanceImports;
    const tests = (this.card.acceptanceTests ?? []).map((t) =>
      t.startsWith("tests/") ? t : `tests/${t}`,
    );
    const scope = new Set((this.options.scopeFiles ?? []).map((f) => f.replace(/^\.\//, "")));
    const graph = importGraph(tests, this.tools.root, 50);
    const imported = new Set(tests.flatMap((t) => [...(graph.get(t) ?? [])]));
    this.acceptanceImports = [...imported].filter((f) => scope.has(f)).sort();
    return this.acceptanceImports;
  }

  /** Exported declarations of `path` whose signature this write changes, with their importers (WL-N9-2). */
  private signatureChanges(
    call: { name: string; arguments: Record<string, unknown> },
    path: string,
  ): { symbol: string; importers: string[] }[] {
    if (!/\.[cm]?[jt]sx?$/.test(path)) return [];
    let before: string;
    try {
      before = this.tools.readRaw(path);
    } catch {
      return [];
    }
    const after = prospectiveContent(call, before);
    if (after === undefined) return [];
    const changed = changedExportedSignatures(path, before, after);
    if (changed.length === 0) return [];
    const importers = this.importersOf(path);
    return changed.map((symbol) => ({ symbol, importers }));
  }

  /**
   * The worktree's source files that import `path`, from the import graph,
   * built once and kept until a write (review minor 7). At most 2,000 files.
   * Relative imports only: a package-name import (`@scope/pkg`) of a
   * workspace package is not resolved, so its importers are not named (a
   * known gap, worker-loop rule 29a's row).
   */
  private importersOf(path: string): string[] {
    if (!this.importGraphCache) {
      const files: string[] = [];
      const skip = new Set(["node_modules", "dist", ".git", ".sekhemet", "acceptance", "coverage"]);
      const walk = (dir: string): void => {
        for (const entry of readdirSync(join(this.tools.root, dir), { withFileTypes: true })) {
          if (files.length >= 2_000) return;
          const rel = dir ? `${dir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (!skip.has(entry.name)) walk(rel);
          } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
            files.push(rel);
          }
        }
      };
      walk("");
      this.importGraphCache = { files, graph: importGraph(files, this.tools.root, 2_000) };
    }
    const { files, graph } = this.importGraphCache;
    return files.filter((f) => f !== path && graph.get(f)?.has(path)).sort();
  }

  /** The evidence gate's fallback verification, once (follow-up 1). */
  private takeFinishVerification(): { result: GateResult } | { error: unknown } | undefined {
    const taken = this.finishVerification;
    this.finishVerification = undefined;
    return taken;
  }

  private strictRefusal(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): ToolObservation | undefined {
    if (this.options.workerMethod !== "strict") return undefined;
    if (
      call.name === "finish_card" &&
      this.lastCheck &&
      !this.lastCheck.passed &&
      !this.writtenSinceCheck
    ) {
      return {
        tool: "finish_card",
        ok: false,
        summary: "finish refused: the last check failed",
        content: `Not finished: your last check failed and nothing has changed since. A card is done only when a check passes on the current files. The failures:\n${this.lastCheck.failures
          .slice(0, 3)
          .map(
            (f, i) =>
              `${i + 1}. ${f.errorExcerpt.split("\n")[0]}${f.suggestedAction ? `\n   fix: ${f.suggestedAction}` : ""}`,
          )
          .join("\n")}`,
      };
    }
    if (call.name === "run_cmd" && typeof call.arguments.command === "string") {
      const prev = this.commandRuns.get(normaliseCommand(call.arguments.command));
      if (prev && prev.effects === this.effects) {
        return {
          tool: "run_cmd",
          ok: false,
          summary: "not run again: nothing changed since it last ran",
          content: `Not run again: nothing has changed since turn ${prev.turn}, when this command last ran, so it would give the same result. Its output then:\n${prev.content}\n\nAct on that output: edit the code it points at, or call finish_card if the work is done.`,
        };
      }
    }
    return undefined;
  }

  /** Remember a command's output, and count it as a possible change for other commands. */
  private recordCommand(
    call: { arguments: Record<string, unknown> },
    turnIndex: number,
    observation: ToolObservation,
  ): void {
    if (typeof call.arguments.command !== "string") return;
    const key = normaliseCommand(call.arguments.command);
    // A different command may itself have changed files (sed, a generator),
    // so it resets what counts as "nothing changed".
    if (this.lastCommandKey !== key) this.effects++;
    this.lastCommandKey = key;
    this.commandRuns.set(key, {
      turn: turnIndex,
      effects: this.effects,
      content: observation.content,
    });
  }

  /** C19: load tools by name or task; their contracts reach the next prompt. */
  private toolSearchObservation(query: unknown): ToolObservation {
    const q = typeof query === "string" ? query.trim() : "";
    if (!q)
      return {
        tool: TOOL_SEARCH_NAME,
        ok: false,
        summary: "empty query",
        content: "Name a tool or a task.",
      };
    const loader =
      this.toolLoader ??
      new ToolLoader(
        this.catalog(),
        this.catalog().map((t) => t.name),
      );
    const r = loader.handle(q, (symbol) => this.tools.declaringFile(symbol));
    if (r.loaded.length === 0) {
      const files = this.filesAskedFor(q);
      if (files) return files;
    }
    return {
      tool: TOOL_SEARCH_NAME,
      ok: r.loaded.length > 0,
      summary: r.loaded.length > 0 ? `loaded ${r.loaded.join(", ")}` : "no tool matched",
      content: r.text,
    };
  }

  /**
   * A tool_search that names files is a request to read them, so the reply is
   * the files. Suite run 4 found naming the read_file calls was not enough:
   * with read_file offered natively and the calls spelled out, the Worker
   * searched for tool_search itself and was stopped. The design's rule — the
   * reply carries what the model would have fetched — applies, and reading is
   * free. Only files inside the worktree, at most three, each capped.
   */
  private filesAskedFor(query: string): ToolObservation | undefined {
    const terms = query
      .split(/[,\s]+/)
      .map((t) =>
        t
          .trim()
          .replace(/^["'`]|["'`]$/g, "")
          .replace(/^\.\//, ""),
      )
      .filter((t) => /\/|\.[cm]?[jt]sx?$|\.json$/.test(t))
      .slice(0, 3);
    if (!terms.length) return undefined;
    const root = this.options.worktreePath;
    const sections: string[] = [];
    let found = 0;
    for (const term of terms) {
      const ts = term.replace(/\.[cm]?js(x?)$/, ".ts$1");
      const candidates = [...new Set([ts, term, `src/${ts}`, `src/${term}`])];
      const hit = candidates.find((c) => {
        const abs = join(root, c);
        const rel = relative(root, abs);
        return (
          !rel.startsWith("..") && !isAbsolute(rel) && existsSync(abs) && statSync(abs).isFile()
        );
      });
      if (!hit) {
        sections.push(`${term}: no such file in this repository.`);
        continue;
      }
      found++;
      const text = readFileSync(join(root, hit), "utf8");
      const capped =
        text.length > 6000
          ? `${text.slice(0, 6000)}\n… (truncated; read_file reads the rest)`
          : text;
      sections.push(`=== ${hit} ===\n${capped || "(empty file)"}`);
    }
    return {
      tool: TOOL_SEARCH_NAME,
      ok: found > 0,
      summary: found > 0 ? `read ${found} file(s) for a file query` : "no such files",
      content: [
        "tool_search finds tools, not files — here are the files you asked for. Use read_file for others.",
        ...sections,
      ].join("\n\n"),
    };
  }

  /**
   * C16: a side question answered in a child context with read-only tools;
   * only its short summary enters this card's context.
   */
  private async subtaskObservation(question: unknown, context: unknown): Promise<ToolObservation> {
    const q = typeof question === "string" ? question.trim() : "";
    if (!q)
      return {
        tool: "subtask",
        ok: false,
        summary: "empty question",
        content: "Ask one specific question.",
      };
    const readOnly = new Set([
      "read_file",
      "grep_search",
      "find_files",
      "list_dir",
      "read_symbol",
      "find_references",
      "go_to_definition",
      "docs",
    ]);
    try {
      const r = await runSubtask({
        adapter: this.options.subtaskAdapter ?? this.options.modelAdapter,
        question: q,
        ...(typeof context === "string" && context.trim() ? { context } : {}),
        tools: this.toolDefinitions().filter((t) => readOnly.has(t.name)),
        executeTool: async (call) =>
          readOnly.has(call.name)
            ? (await this.tools.execute(call)).content
            : `${call.name} is not available to a subtask (read-only tools only).`,
        maxSteps: 4,
      });
      return {
        tool: "subtask",
        ok: r.stopReason === "answered",
        summary: `subtask ${r.stopReason} in ${r.steps} step(s)`,
        content: r.summary || "The subtask found no answer.",
      };
    } catch (err) {
      return {
        tool: "subtask",
        ok: false,
        summary: "subtask failed",
        content: `The subtask could not run: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
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

  /** What this attempt learned, for the next attempt and the playbook reflector. */
  public getLessons(): { lines: string[]; struggles: { text: string; edits: number }[] } {
    return { lines: this.memory.lines(), struggles: this.memory.getStruggles() };
  }

  /** Playbook rules that were in this card's prompt, for helpful/harmful counting. */
  /** Tokens output condensing removed from this session's observations (RUN-47). */
  public getCondensedTokensSaved(): number {
    return this.tools.condensedTokensSaved;
  }

  public getRulesUsed(): string[] {
    return [...this.rulesUsed];
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
        // Counted as read only once the prompt shows it in full (buildPrompt).
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
      // C1: the ranked map (definitions and references, PageRank seeded
      // toward the card's scope, fitted to a token budget); the flat map
      // when the ranked one finds nothing.
      let ranked = "";
      try {
        ranked = buildRankedRepoMap(this.tools.root, {
          scopeFiles: this.options.scopeFiles ?? [],
          budgetTokens: 1200,
        }).text;
      } catch {
        ranked = "";
      }
      const map = ranked.trim()
        ? ranked
        : buildRepoMap(this.tools.root, this.options.scopeFiles ?? []);
      // The fields and tables the card builds on, whichever map was chosen.
      const contracts = dataContracts(this.tools.root, this.options.scopeFiles ?? []);
      this.repoMapCache = contracts
        ? `${map}\n\nDATA CONTRACTS (types and tables this card builds on):\n${contracts}`
        : map;
    }
    return this.repoMapCache;
  }

  /**
   * The tools offered this session: the card's catalog, plus `tool_search`
   * under progressive loading (C19), where a catalog tool not yet loaded is
   * still offered (reachable through tool_search). A call to anything else is
   * refused, and counted as a format error (WL-M2-5).
   */
  private offeredToolNames(): string[] {
    const names = this.catalog().map((t) => t.name);
    return this.toolLoader && !names.includes(TOOL_SEARCH_NAME)
      ? [...names, TOOL_SEARCH_NAME]
      : names;
  }

  /** Tool schemas sent alongside the prompt; they count against the window too. */
  /** The tools this card may use: the restricted catalog under `--restricted` (S12). */
  private catalog() {
    // L18: the card's class fixes its tool list (explore, plan, review,
    // research, implement), unless the caller chose tools itself.
    const progressive = this.options.progressiveTools === true;
    const chosen =
      this.options.tools ??
      toolsForClass(cardClassFor(this.card), TOOL_CATALOG, {
        scriptCapable: this.options.scriptCapable,
        arm: progressive ? "progressive" : "fixed",
      });
    // WL-M2-2: the fixed-set arm never offers tool_search, whoever chose the tools.
    const base = progressive ? chosen : chosen.filter((t) => t.name !== TOOL_SEARCH_NAME);
    return this.withNoteGate(this.options.restricted ? restrictedToolCatalog(base) : base);
  }

  /**
   * The attempt's gates, sorted: what `note`'s `gate` may name (GT-M6-5),
   * listed from what emits the ids — the runner's declared and project gates,
   * and here the bounds, integrity and hook gates when they run and the
   * built-in layers' own list.
   */
  private suspectableGates(): string[] {
    const builtin = this.options.builtinGates;
    const ids = [
      ...(this.options.suspectableGates ?? []),
      ...(this.options.bounds ? ["bounds"] : []),
      ...(this.options.integrityGate !== false ? ["integrity"] : []),
      ...(this.options.hooks ? ["hook"] : []),
      ...(builtin
        ? builtinGateIds(this.options.restricted ? { ...builtin, mutation: false } : builtin)
        : []),
    ];
    return [...new Set(ids)].sort();
  }

  /**
   * GT-M6-5, option A: `note` takes an optional `gate`, an enum of this
   * attempt's gates. It is structured, so a note that merely mentions a gate
   * can never stop the card; the list is fixed for the attempt, so the schema
   * stays byte-stable.
   */
  private withNoteGate(tools: ToolInterfaceSpec[]): ToolInterfaceSpec[] {
    const gates = this.suspectableGates();
    if (gates.length === 0) return tools;
    return tools.map((t) =>
      t.name === "note"
        ? {
            ...t,
            parameters: [
              ...t.parameters,
              {
                name: "gate",
                type: "string" as const,
                required: false,
                description: workerCopy.noteGate,
                enumValues: gates,
              },
            ],
          }
        : t,
    );
  }

  /**
   * C19: tools `tool_search` loaded during the card, which the core set in the
   * pinned system prompt does not already carry. They go to the volatile tail
   * precisely because they arrive mid-card: putting them in the prefix would
   * invalidate the server's cache on the turn after every search.
   */
  private loadedSinceStart(): ToolInterfaceSpec[] {
    if (!this.toolLoader) return [];
    const core = new Set((this.coreToolSpecs ?? []).map((t) => t.name));
    return this.toolLoader.visibleSpecs().filter((t) => !core.has(t.name));
  }

  /** What the request carries: every tool, or the loaded ones under C19. */
  private visibleToolDefinitions() {
    const all = this.toolDefinitions();
    return this.toolLoader ? this.toolLoader.visibleSchemas(all) : all;
  }

  /** The request's tool definitions, from the one builder a replay also uses (tool_schema.ts). */
  private toolDefinitions() {
    return this.catalog().map(toolDefinition);
  }

  /** The tools this card is given, as the session renders and sends them (the prompt lint and golden renders read these). */
  public getToolSpecs(): ToolInterfaceSpec[] {
    return this.catalog();
  }

  /** Whether `recall` is offered: a pointer names it only then (context CX-M1-1). */
  public recallOffered(): boolean {
    return this.offeredToolNames().includes("recall");
  }

  /** The request budget in tokens, if the adapter's window is known. */
  private promptBudget(): number | undefined {
    return this.promptBudgetW;
  }

  /** The answer cap each request states (rule 22). */
  private answerCap(): number | undefined {
    return this.options.maxTokens ?? this.options.modelAdapter.contextWindow?.maxTokens;
  }

  /**
   * W, once per attempt (rule 22, WL-M3-1, WL-M3-5): the window less the
   * answer cap, the largest thinking cap the policy can request on any step
   * and a margin for tokenizer disagreement. Every policy can think (`off`
   * on its escalated rungs), so that is the high budget; a step that does not
   * think leaves its allowance unused and the prompt never grows into it.
   */
  private fixPromptBudget(): number | undefined {
    if (this.options.promptTokenBudget !== undefined) return this.options.promptTokenBudget;
    const window = this.options.modelAdapter.contextWindow;
    const answer = this.answerCap();
    if (!window || answer === undefined) return undefined;
    return window.contextTokens - answer - REASONING_BUDGET_TOKENS.high - WINDOW_MARGIN_TOKENS;
  }

  /** The prompt budget W this attempt runs under, for the evidence (WL-M3-5). */
  public getPromptBudget(): number | undefined {
    return this.promptBudgetW;
  }

  /** Which tool arm the Worker runs (WL-M2-5): progressive loading or the fixed set. */
  public getToolSetArm(): "fixed" | "progressive" {
    return this.toolLoader ? "progressive" : "fixed";
  }

  /** The manager's plan and any in-loop re-plan, newest last. */
  private guidance(): string | undefined {
    const parts = [this.options.managerGuidance, this.replanGuidance].filter(
      (p): p is string => typeof p === "string" && p.trim().length > 0,
    );
    return parts.length > 0 ? parts.join("\n\nRevised plan (repair rung 3):\n") : undefined;
  }

  /**
   * This turn's prompt, from the one context allocator (`buildWorkerPrompt`,
   * C4 and C7). It orders the prompt for the prefix cache (system, then the
   * card-stable static part, then the per-turn tail), describes the tools
   * once (as native schemas when the adapter sends them, as text otherwise),
   * applies the 70/80/85/90% pressure tiers and cuts by priority, keeping the
   * scope files and the standing failure longest.
   */
  private buildPrompt(): WorkerPromptResult {
    // C9: every skill as a manifest line, the matched ones in full; a skill
    // needing a tool this card is not offered is left out (EXT-22a).
    const skills =
      this.options.skillsRegistry?.skillsForPrompt(this.card.title, this.options.scopeFiles ?? [], {
        tools: this.offeredToolNames(),
      }) ?? [];
    // EXT-22a, EXT-25: what the prompt left out or cut, for the evidence.
    for (const o of this.options.skillsRegistry?.omitted() ?? []) {
      this.skillsOmitted.set(o.name, o);
    }
    for (const s of skills) {
      if (s.truncated) this.skillsTruncated.set(s.name, { name: s.name, ...s.truncated });
    }
    // C22: the project's own conventions (AGENTS.md, CLAUDE.md), once per card.
    this.conventions ??= (() => {
      try {
        return loadProjectConventions(this.tools.root);
      } catch {
        return "";
      }
    })();
    // C13: the best passing runs of this card's class, as worked examples.
    const exemplars =
      this.options.exemplarStore?.topFor(contextCardClass(this.card), 2, this.card.id) ?? [];
    // The failure text lets error-scoped rules match only while their error
    // stands (integration review item 3).
    const rules =
      this.options.playbookRegistry?.matchRules({
        cardTitle: this.card.title,
        scopeFiles: this.options.scopeFiles ?? [],
        ...(this.lastGateFailure ? { triggerGate: this.lastGateFailure.rung } : {}),
        ...(this.lastGateFailures.length > 0
          ? { failureText: this.lastGateFailures.map((f) => f.errorExcerpt).join("\n") }
          : {}),
      }) ?? [];
    const pinned = this.pinnedFiles();
    const native = this.options.modelAdapter.nativeTools === true;
    const budget = this.promptBudget();
    const guidance = this.guidance();
    const lines = (this.options.dossierLines ?? []).filter((l) => l.trim().length > 0);
    // S9: the card's own text is untrusted when it came from a tracker (its
    // link) or from an imported file (its origin, M3).
    const source = this.card.externalRef
      ? `${this.card.externalRef.system}:${this.card.externalRef.id}`
      : this.options.untrustedOrigin
        ? `${this.options.untrustedOrigin}:${this.card.id}`
        : undefined;
    const untrusted = lines.some(containsUntrusted) || source !== undefined;
    // S9: with untrusted content in context, the contract says so, and the
    // tools run under the strict policy (no ask-tier approvals, no network).
    this.tools.setUntrustedContext(untrusted);
    const dossier = [
      ...(untrusted ? [{ label: "Untrusted content", text: UNTRUSTED_CONTRACT }] : []),
      ...lines.map((text) => ({ label: "From the team (this card)", text })),
    ];
    const completedWork = [
      ...[...this.filesWritten].sort().map((f) => `wrote ${f}`),
      // Listing what was already read is what stops the agent spending its
      // budget re-reading files it has in front of it.
      ...this.tools.getReadFiles().map((f) => `read ${f}`),
    ];
    const pending = this.pendingScopeFiles();
    // Rule 10: the run's fixed seed, set on the model, also seeds the prune null arm.
    const seed = (this.options.modelAdapter as { seed?: unknown }).seed;
    const built = buildWorkerPrompt({
      card: { ...this.card, stepsUsed: this.stepsUsed },
      ...(source && !this.card.externalRef ? { untrustedSource: source } : {}),
      ...(typeof seed === "number" ? { seed } : {}),
      // C19: with progressive loading the system prompt carries the core
      // tools' contracts and a one-line index of the rest; what tool_search
      // has loaded since rides in the volatile tail, so the prefix survives.
      tools: this.coreToolSpecs ?? this.catalog(),
      ...(this.options.prefixGuard ? { prefixGuard: this.options.prefixGuard } : {}),
      ...(this.conventions ? { conventions: this.conventions } : {}),
      ...(exemplars.length > 0 ? { exemplars } : {}),
      ...(this.toolLoader
        ? { toolIndex: this.catalog(), loadedTools: this.loadedSinceStart() }
        : {}),
      ...(native ? { nativeToolSchemas: this.visibleToolDefinitions() } : {}),
      ...(budget !== undefined ? { budgetTokens: budget } : {}),
      repoMap: this.repoMap(),
      acceptanceTests: pinned
        .filter((f) => f.label === "acceptance test")
        .map(({ path, content }) => ({ path, content })),
      scopeFiles: pinned
        .filter((f) => f.label === "scope file")
        .map(({ path, content }) => ({ path, content })),
      ...(this.options.teamNote ? { teamNote: this.options.teamNote } : {}),
      ...(guidance ? { repairPlan: guidance } : {}),
      ...(dossier.length > 0 ? { dossier } : {}),
      lessons: this.memory.lines(),
      rules,
      ...(this.activeRung && this.activeRung.rung !== "direct_repair"
        ? { rungDirective: this.activeRung.directive }
        : {}),
      skills,
      turns: this.history,
      gateFailures: this.lastGateFailures,
      ...(this.lastGateFailures.length > 0
        ? { failureCode: this.failureCode(this.lastGateFailures) }
        : {}),
      // A spec synced from an external tracker, or imported, is untrusted (S9, M3).
      ...(this.card.spec
        ? { goal: source ? tagUntrusted(this.card.spec, source) : this.card.spec }
        : {}),
      ...(this.card.acceptanceCriteria?.length
        ? { acceptanceCriteria: this.card.acceptanceCriteria }
        : {}),
      ...(completedWork.length > 0 ? { completedWork } : {}),
      ...(pending.length > 0
        ? { openTodos: pending }
        : { readyToVerify: this.filesWritten.size > 0 }),
    });
    for (const id of built.rulesUsed) this.rulesUsed.add(id);
    this.lastPackRecord = built.pack;
    this.lastMetrics = built.metrics;
    if (this.history.length > 8) {
      this.compactedTurns = Math.max(this.compactedTurns, this.history.length - 6);
    }
    this.lastPrompt = built;
    // What the prompt showed in full, for edit's refusal (the B2.1 review, B2).
    this.tools.setShownInFull(built.shownInFull);
    // Shown in full in the prompt (even when empty): it has been read (L17). A
    // file the allocator cut or shrank has not (the confirmation review).
    for (const path of built.shownInFull) this.tools.markSeen(path);
    // Rule 29a: a file the prompt shows in full has reached the Worker whole.
    if (this.options.evidenceGate === "on") {
      for (const path of built.shownInFull) {
        try {
          const lines = splitLines(this.tools.readRaw(path)).lines.length;
          this.evidence.push({ kind: "read", path, from: 1, to: lines, lines });
        } catch {
          // A file the session left out is not a read.
        }
      }
    }
    return built;
  }

  /** The last prompt's context-pack record and step metrics (C14, C20). */
  public getLastContextReport():
    | { pack: WorkerPromptResult["pack"]; metrics: WorkerPromptResult["metrics"] }
    | undefined {
    return this.lastPackRecord && this.lastMetrics
      ? { pack: this.lastPackRecord, metrics: this.lastMetrics }
      : undefined;
  }

  /** Where the last model request's prompt was logged (K11), when `onPrompt` is set. */
  public getLastContextPackId(): string | undefined {
    return this.lastContextPackId;
  }

  /** The last prompt's allocation report (tier, cuts, prefix hashes), for evidence and the log. */
  public getLastPromptReport():
    | Pick<
        WorkerPromptResult,
        "tier" | "prefixHash" | "staticPrefixHash" | "usedTokens" | "budgetTokens" | "cut"
      >
    | undefined {
    const p = this.lastPrompt;
    return p
      ? {
          tier: p.tier,
          prefixHash: p.prefixHash,
          staticPrefixHash: p.staticPrefixHash,
          usedTokens: p.usedTokens,
          budgetTokens: p.budgetTokens,
          cut: p.cut,
        }
      : undefined;
  }

  public async executeTurn(): Promise<TurnResult> {
    const before = {
      filesWrittenBefore: this.filesWritten.size,
      failedCheckStanding: this.lastGateFailures.length > 0,
    };
    this.stepMeta = {};
    const turn = await this.executeTurnInner();
    Object.assign(turn, this.stepMeta);
    // WL-T3-1: the phase, from the one pure function.
    turn.phase = phaseOf({
      tools: turn.toolCalls.map((c) => c.name),
      ...before,
      verified: turn.gateResult !== undefined,
    });
    // Rule 31a: which budget ran out.
    if (turn.stopReason === "budget_exhausted" && !turn.budget) {
      turn.budget = { budget: "steps", used: this.stepsUsed, of: this.stepBudget };
    }
    // K12: the loop has decided to stop; hooks observe it (notifiers, formatters).
    if (turn.stopReason && this.options.hooks) {
      await this.options.hooks
        .emit("turn-stopping", {
          cardId: this.cardId,
          step: turn.turnIndex,
          data: { stopReason: turn.stopReason },
        })
        .catch(() => undefined);
    }
    return turn;
  }

  /** Messages user hooks injected, shown to the model on its next turn (K12). */
  private hookNotes(turn: number, messages: { content: string }[]): void {
    if (messages.length === 0) return;
    this.history.push({
      turn,
      action: "project hook",
      result: messages.map((m) => m.content).join("\n"),
    });
  }

  private async executeTurnInner(): Promise<TurnResult> {
    this.lastContextPackId = undefined;
    if (this.abortReason !== undefined) {
      return {
        turnIndex: this.stepsUsed,
        toolCalls: [],
        observations: [],
        stopReason: "human_abort",
        // Rule 31: the next action is to see who stopped it.
        abortedBy: this.abortReason,
      };
    }
    if (this.pausedBy !== undefined) {
      return {
        turnIndex: this.stepsUsed,
        toolCalls: [],
        observations: [],
        stopReason: "paused",
        abortedBy: this.pausedBy,
      };
    }
    // Check headroom before spending a turn: stopping here is resumable,
    // letting the host run out of memory is not.
    // Enabled by the CLI and eval harness for real runs; unit tests with mock
    // adapters leave it off so their outcome does not depend on host swap.
    if (this.options.memoryProbe || this.options.memoryGuard) {
      const verdict = this.options.memoryProbe
        ? this.options.memoryProbe()
        : checkExecutionHeadroom(this.baselineSwap, this.options.memoryGuard || {});
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

    const built = this.buildPrompt();
    const { systemPrompt, prompt } = built;
    this.lastSystemPrompt = systemPrompt;
    if (built.stop) {
      // Even the required sections exceed the window: another request would
      // be rejected by the server (C7, the 95% hard stop).
      this.history.push({
        turn: turnIndex,
        action: "context budget",
        result: `Stopped: the prompt needs ${built.usedTokens} tokens of a ${built.budgetTokens}-token budget even after every cut.`,
      });
      // Rule 31a, WL-T3-12: the context budget, naming the zone that overflowed.
      const over = built.zoneBudgets.find((z) => z.zone !== 4 && !z.withinBudget);
      return {
        turnIndex,
        toolCalls: [],
        observations: [],
        stopReason: "budget_exhausted",
        budget: over
          ? { budget: "context", zone: over.name, tokens: over.tokens, cap: over.budget }
          : {
              budget: "context",
              zone: "prompt",
              tokens: built.usedTokens,
              cap: built.budgetTokens ?? 0,
            },
      };
    }

    // Reasoning per step (M6): off for ordinary steps and direct repair, on
    // once the direct fix has failed.
    const rung = this.activeRung?.rung;
    const thinking = this.thinkingFor(
      reasoningForStep(
        rung && rung !== "direct_repair" ? { purpose: "repair", rung } : { purpose: "mechanical" },
      ),
    );
    this.turnsTaken++;

    // K12: pre-step hooks may veto the step (fail closed) or add a message.
    if (this.options.hooks) {
      const pre = await this.options.hooks.emit("pre-step", {
        cardId: this.cardId,
        step: turnIndex,
      });
      this.hookNotes(turnIndex, pre.messages);
      if (pre.blocked) {
        this.history.push({
          turn: turnIndex,
          action: "project hook",
          result: `Stopped by a pre-step hook: ${pre.reason ?? "blocked"}`,
        });
        // WL-T3-4: a hook's veto is `hook_veto`, naming the hook, not a person's abort.
        return {
          turnIndex,
          toolCalls: [],
          observations: [],
          stopReason: "hook_veto",
          hookVeto: {
            // Its configured name or command; an unnamed handler by position.
            hook: pre.blockedBy ?? `pre-step hook ${(pre.blockedByIndex ?? 0) + 1}`,
            reason: pre.reason ?? "blocked",
          },
        };
      }
    }

    const tools = this.visibleToolDefinitions();
    // K11: the prompt is logged before it is sent, or it is not sent.
    this.lastContextPackId = this.options.onPrompt?.({
      step: turnIndex,
      systemPrompt,
      prompt,
      tools: tools.map((t) => t.name),
      reasoning: thinking.reasoning,
      // The rest of the request below, so the pack is exactly what was sent (kernel rule 17).
      toolDefinitions: tools,
      toolArm: this.options.toolArm ?? this.options.modelAdapter.preferredToolArm ?? "arm_a_flat",
      reasoningBudgetTokens: thinking.reasoningBudgetTokens,
      maxTokens: this.options.maxTokens,
      temperature: this.options.temperature,
    });

    const response = await this.options.modelAdapter.generate({
      systemPrompt,
      prompt,
      reasoning: thinking.reasoning,
      reasoningBudgetTokens: thinking.reasoningBudgetTokens,
      // Names travel with the request so the parser can recognise a call in
      // whatever syntax the model chose to emit it.
      // Real JSON Schema, so servers with native tool calling can constrain
      // the call format instead of leaving the model to improvise one.
      tools,
      // M9: the arm measured for this model, unless the card sets one.
      toolArm: this.options.toolArm ?? this.options.modelAdapter.preferredToolArm ?? "arm_a_flat",
      // M2: tokens stream to the dashboard's step view as they are decoded.
      ...(this.options.onToken ? { onToken: this.options.onToken } : {}),
      ...(this.options.temperature !== undefined ? { temperature: this.options.temperature } : {}),
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    });

    const toolCalls = response.toolCalls;
    // WL-M3-2, WL-M3-4, WL-M2-5: why the reply ended, whether a cap cut it,
    // how many of its calls were malformed and whether it was prose only,
    // recorded on the step.
    // One offered set per step, for the metric and the refusal alike: under
    // progressive loading it is the class catalog reachable through
    // tool_search, not only the tools loaded so far.
    const offeredNames = this.offeredToolNames();
    const offered = new Set(offeredNames);
    this.tools.setOfferedTools(offeredNames);
    const truncated =
      response.finishReason === "length"
        ? thinking.reasoningBudgetTokens > 0 &&
          (response.usage.answerTokens === 0 ||
            (toolCalls.length === 0 && response.text.trim() === ""))
          ? { cut: "thinking" as const, capTokens: thinking.reasoningBudgetTokens }
          : { cut: "answer" as const, capTokens: this.answerCap() ?? 0 }
        : undefined;
    // A silent reply (no call, not cut off) is a format error only when it
    // tried to make a call the parser could not read; otherwise it is prose.
    const silent = toolCalls.length === 0 && !truncated;
    const attempted = silent && looksLikeToolCallAttempt(response.text, [...offered]);
    this.stepMeta = {
      ...(response.finishReason ? { finishReason: response.finishReason } : {}),
      ...(truncated ? { truncated } : {}),
      formatErrors:
        toolCalls.length === 0
          ? attempted
            ? 1
            : 0
          : toolCalls.filter((c) => !offered.has(c.name)).length,
      proseOnly: silent && !attempted ? 1 : 0,
    };

    // A turn that produced no actionable call is a stall signal in its own right:
    // tell the model plainly rather than silently burning the step budget.
    if (toolCalls.length === 0) {
      // Rule 19, WL-M3-2: a reply cut off by a cap is not a silent step.
      // TODO(prompt standard): the typed `truncated` observation's wording
      // for the Worker; until then it sees the existing no-call message.
      if (!truncated) this.emptyTurns++;
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
    // WL-M3-2: a truncated step never counts toward a stall or an oscillation.
    const stall = truncated
      ? "none"
      : this.oscillationDetector.recordAndCheck(toolCalls, repoStateHash);

    // The first stall is feedback, not a verdict. A Worker that has repeated
    // itself once has not been told so, and the design requires a failure it
    // must act on to arrive with the action attached — the same rule that
    // governs gate failures and scope denials.
    if (stall === "warn") {
      const repeated = this.oscillationDetector.repeatedTools || "that call";
      this.pendingStallWarning = [
        `You just repeated ${repeated} and the repository is unchanged, so that turn made no progress.`,
        "Do something different: act on what you have already read, or call finish_card if the work is done.",
        "Repeating it again will end the card.",
      ].join(" ");
      this.history.push({
        turn: turnIndex,
        action: "stall warning",
        result: `repeated ${repeated} with no change to the tree`,
      });
    }

    if (stall === "stop") {
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
        const ladderStop = await this.applyLadder(this.activeRung, turnIndex);
        return {
          turnIndex,
          toolCalls,
          observations: [],
          usage: response.usage,
          gateResult: forced,
          ...(ladderStop ? { stopReason: ladderStop } : {}),
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
        // WL-T3-3 (structural half): the repeated call, for the stop's detail.
        repeatedCall:
          this.oscillationDetector.repeatedTools || toolCalls.map((c) => c.name).join(", "),
      };
    }

    this.tools.resetFinish();
    this.finishVerification = undefined;
    const observations: ToolObservation[] = [];
    // The stall warning leads the turn's history so the Worker reads it
    // before the results of the calls it just repeated. It is kept apart from
    // the calls' observations, which stay at their calls' indices (review
    // item 11): the step records pair observations[i] with toolCalls[i].
    const stallWarning: ToolObservation | undefined = this.pendingStallWarning
      ? {
          tool: "stall",
          ok: false,
          summary: "no progress on the last turn",
          content: this.pendingStallWarning,
        }
      : undefined;
    this.pendingStallWarning = undefined;
    let suspected: { gate: string; reason: string } | undefined;
    for (const call of toolCalls) {
      // `check` runs the real gates without ending the card: the agent was
      // spending most of its turns trying to self-verify with shell commands.
      // K12: a pre-tool hook can refuse the call (a permission or secret
      // guard); the model sees why, and the tool does not run.
      const preTool = this.options.hooks
        ? await this.options.hooks.emit("pre-tool", {
            cardId: this.cardId,
            step: turnIndex,
            toolName: call.name,
            toolArgs: call.arguments as Record<string, unknown>,
          })
        : undefined;
      if (preTool?.blocked) {
        this.hookNotes(turnIndex, preTool.messages);
        observations.push({
          tool: call.name,
          ok: false,
          denied: true,
          deniedRule: "hook",
          summary: "blocked by a project hook",
          content: `A project hook refused ${call.name}: ${preTool.reason ?? "blocked"}`,
        } as ToolObservation);
        continue;
      }
      const refused =
        this.tools.refuseNotOffered(call.name, offeredNames) ??
        this.strictRefusal(call) ??
        this.unknownGateRefusal(call);
      if (refused) {
        observations.push(refused);
        continue;
      }
      // Rule 29a: with the switch on, a write or a finish waits for its evidence.
      const postponed =
        this.options.evidenceGate === "on" ? await this.evidencePostponement(call) : undefined;
      if (postponed) {
        observations.push(postponed);
        continue;
      }
      const toolStarted = Date.now();
      const observation =
        call.name === "check"
          ? await this.checkObservation()
          : call.name === "recall"
            ? this.recallObservation(call.arguments.ref)
            : call.name === "ask"
              ? await this.askObservation(call.arguments.question)
              : call.name === TOOL_SEARCH_NAME
                ? this.toolSearchObservation(call.arguments.query)
                : call.name === "subtask"
                  ? await this.subtaskObservation(call.arguments.question, call.arguments.context)
                  : await this.tools.execute(call);
      observations.push(observation);
      this.options.onToolCall?.({
        turnIndex,
        callId: call.id,
        name: call.name,
        ok: observation.ok,
        denied: observation.denied === true,
        startedAtMs: toolStarted,
        endedAtMs: Date.now(),
      });
      this.recordEvidence(call, observation);
      if (call.name === "run_cmd") this.recordCommand(call, turnIndex, observation);
      if (this.options.hooks) {
        const post = await this.options.hooks.emit("post-tool", {
          cardId: this.cardId,
          step: turnIndex,
          toolName: call.name,
          toolArgs: call.arguments as Record<string, unknown>,
          toolResult: { ok: observation.ok, summary: observation.summary },
        });
        this.hookNotes(turnIndex, [...(preTool?.messages ?? []), ...post.messages]);
      }
      if (call.name === "note" && observation.ok && typeof call.arguments.message === "string") {
        await this.options.onNote?.(call.arguments.message).catch(() => undefined);
        // GT-M6-5: a note that names a gate says the gate is wrong.
        if (typeof call.arguments.gate === "string") {
          suspected = {
            gate: call.arguments.gate,
            reason: call.arguments.message.slice(0, 300),
          };
        }
      }

      if (observation.ok && WRITE_TOOLS.has(call.name)) {
        const path = call.arguments.path;
        if (typeof path === "string") this.filesWritten.add(path.replace(/^\.\//, ""));
        this.writtenSinceCheck = true;
        // The files changed: a verification of the old tree is not reused.
        this.finishVerification = undefined;
        this.writeCount++;
        this.effects++;
        if (typeof path === "string") this.memory.noteWrite(path);
      }
    }

    this.history.push({
      turn: turnIndex,
      action: toolCalls.map((c) => c.name).join(", "),
      result: [...(stallWarning ? [stallWarning] : []), ...observations]
        .map((o) => o.content)
        .join("\n---\n"),
    });
    if (stallWarning) observations.push(stallWarning);

    // GT-M6-5: the Worker named a gate as wrong. Grinding repair rungs against
    // it is what gates exist to prevent, so the card parks for a person.
    if (suspected) {
      this.isFinished = true;
      return {
        turnIndex,
        toolCalls,
        observations,
        usage: response.usage,
        rawText: response.text,
        stopReason: "gate_suspected",
        suspectedGate: suspected,
      };
    }

    let gateResult: GateResult | undefined;
    let stopReason: ExecutionStopReason | undefined;

    // A Worker that keeps writing outside its scope is working on a different
    // card than the one it was given; more turns will not fix that.
    const scopeDenials = this.tools.getDenialCounts().scope ?? 0;
    if (scopeDenials >= (this.options.maxScopeDenials ?? 3)) {
      this.history.push({
        turn: turnIndex,
        action: "scope",
        result: `Stopped: ${scopeDenials} writes outside the declared scope were refused.`,
      });
      return {
        turnIndex,
        toolCalls,
        observations,
        usage: response.usage,
        rawText: response.text,
        stopReason: "scope_violation",
      };
    }

    // Re-check after every edit while a failure is outstanding. Without it the
    // agent edited blind: Chronicle's ledger card fixed the one error it was
    // shown, then spent 25 turns re-reading files while seven more stood, and
    // ran out of budget without ever verifying again. This is feedback, not a
    // submission: it does not climb the repair ladder.
    const wroteThisTurn = toolCalls.some(
      (c, i) => WRITE_TOOLS.has(c.name) && observations[i]?.ok === true,
    );
    const checkedThisTurn = toolCalls.some((c) => c.name === "check") || this.evidenceCheckPassed;
    this.evidenceCheckPassed = false;

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
    let recheckFailed = false;
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
      } else if (onlyNotRun(recheck)) {
        // What is left is gates that could not run: the Worker's failures are
        // gone, so the card stops for the gates rather than keep repairing.
        this.isFinished = true;
        this.history.push({
          turn: turnIndex,
          action: "re-check after edit",
          result: workerCopy.gatesNotRun(
            recheck.failures.map((f) => f.errorExcerpt.split("\n")[0]).join(" | "),
          ),
        });
        gateResult = recheck;
        stopReason = "done_pending_gates";
      } else {
        recheckFailed = true;
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
      const reused = this.takeFinishVerification();
      try {
        if (reused !== undefined && "error" in reused) throw reused.error;
        gateResult = reused !== undefined ? reused.result : await this.runVerification();
      } catch (err) {
        // The Worker declared the work done and the gates could not run (a
        // tampered gates.toml, a refused sandbox). The work is kept, and the
        // card says exactly that rather than "error".
        const message = err instanceof Error ? err.message : String(err);
        this.history.push({
          turn: turnIndex,
          action: "verification",
          result: `Gates could not run: ${message.slice(0, 300)}`,
        });
        return {
          turnIndex,
          toolCalls,
          observations,
          usage: response.usage,
          rawText: response.text,
          stopReason: "done_pending_gates",
        };
      }

      const gatesDidNotRun = onlyNotRun(gateResult);
      if (gateResult.passed) {
        this.isFinished = true;
        this.lastGateFailure = undefined;
        this.lastGateFailures = [];
        this.ladder.reset();
        this.activeRung = undefined;
        stopReason = "gate_passed";
      } else if (gatesDidNotRun) {
        // Blocker 1 of the B2.3 review: what is left is gates that could not
        // run. That is not the Worker's failure: no repair rung, no measured
        // stop — the work is kept for the gates to run.
        this.isFinished = true;
        this.history.push({
          turn: turnIndex,
          action: "verification",
          result: workerCopy.gatesNotRun(
            gateResult.failures.map((f) => f.errorExcerpt.split("\n")[0]).join(" | "),
          ),
        });
        stopReason = "done_pending_gates";
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

        stopReason = await this.applyLadder(policy, turnIndex);
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
    // The next turn thinks, under "surgical", when this one failed a check
    // or the gates: that is where a diagnosis is worth its tokens.
    this.lastTurnFailed =
      recheckFailed ||
      (gateResult !== undefined && !gateResult.passed) ||
      observations.some((o) => (o.tool === "check" || o.tool === "finish_card") && !o.ok);
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
    // K12: a pre-gate hook can stop verification (fail closed); post-gate observes.
    if (this.options.hooks) {
      const pre = await this.options.hooks.emit("pre-gate", {
        cardId: this.cardId,
        step: this.stepsUsed,
        gateRungs: rungs,
      });
      this.hookNotes(this.stepsUsed, pre.messages);
      if (pre.blocked) {
        return {
          passed: false,
          durationMs: 0,
          failures: [
            {
              rung: "test",
              gate: "hook",
              layer: "hygiene",
              exitCode: 1,
              errorExcerpt: `A pre-gate hook stopped verification: ${pre.reason ?? "blocked"}`,
              suggestedFixFiles: [],
              location: { file: "." },
              expected: "the pre-gate hooks to let verification run",
              actual: pre.reason ?? "blocked",
              minimalRepro: RERUN_GATES,
              suggestedAction: gateCopy.hookBlocked(pre.reason ?? "blocked"),
              notRun: true,
            },
          ],
          rungResults: [],
        };
      }
    }
    const result = await this.runVerificationInner();
    // Rule 29a: the tests ran on the tree as it stands.
    if (!onlyNotRun(result)) this.evidence.push({ kind: "tests" });
    if (this.options.hooks) {
      const post = await this.options.hooks
        .emit("post-gate", {
          cardId: this.cardId,
          step: this.stepsUsed,
          gateRungs: rungs,
          gateResult: { passed: result.passed, failures: result.failures.length },
        })
        .catch(() => undefined);
      if (post) this.hookNotes(this.stepsUsed, post.messages);
    }
    return result;
  }

  private async runVerificationInner(): Promise<GateResult> {
    // A read-only audit never runs a formatter over the files (S12).
    const autofix = this.options.restricted ? undefined : this.options.autofixCommand;
    const scope = this.options.restricted ? [] : (this.options.scopeFiles ?? []);
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
    let result = await this.options.gateRunner.runGates(rungs, this.tools.root);
    const base = this.options.baseBranch ?? "main";
    // One read of the diff for every gate that judges it; undefined when git
    // cannot produce it, and then those gates say they did not run.
    const diff = worktreeDiff(this.tools.root, base);
    const notRun = (gate: string, rung: GateRung, expected: string): GateFailure => ({
      rung,
      gate,
      layer: "hygiene",
      exitCode: -1,
      errorExcerpt: `${gate} not run: the card's diff could not be read`,
      suggestedFixFiles: [],
      location: { file: "." },
      expected,
      actual: "git could not produce the diff",
      minimalRepro: `git diff ${base}`,
      suggestedAction: gateCopy.gateNotRun(gate),
      notRun: true,
    });
    // The integrity gate (ARIS: "plausible unsupported success"): a pass
    // bought by switching a check off is not a pass.
    if (this.options.integrityGate !== false && diff === undefined) {
      result = {
        ...result,
        passed: false,
        failures: [
          notRun("integrity", "hygiene", "no check switched off in the card's lines"),
          ...result.failures,
        ],
      };
    } else if (this.options.integrityGate !== false && diff !== undefined) {
      const protectedTests = (this.card.acceptanceTests ?? []).map((t) =>
        t.startsWith("tests/") ? t : `tests/${t}`,
      );
      const violations = scanDiffIntegrity(diff, protectedTests);
      if (violations.length > 0) {
        result = {
          ...result,
          passed: false,
          failures: [...integrityFailures(violations, base), ...result.failures],
        };
      }
    }
    // The card-size gate (G10): measured on the real diff at every
    // verification, so an oversized change fails like any other gate.
    const bounds = this.options.bounds;
    if (bounds) {
      const staged = new Set(
        (this.card.acceptanceTests ?? []).map((t) => (t.startsWith("tests/") ? t : `tests/${t}`)),
      );
      const perFile = worktreeNumstat(this.tools.root, base);
      if (!perFile) {
        result = {
          ...result,
          passed: false,
          failures: [
            notRun(
              "bounds",
              "bounds",
              `at most ${bounds.maxFiles} files and ${bounds.maxLines} lines`,
            ),
            ...result.failures,
          ],
        };
      } else {
        const own = perFile.filter((f) => !staged.has(f.file));
        const verdict = checkBounds({
          base,
          filesTouched: own.map((f) => f.file),
          linesAdded: own.reduce((n, f) => n + f.added, 0),
          linesRemoved: own.reduce((n, f) => n + f.removed, 0),
          maxFiles: bounds.maxFiles,
          maxLines: bounds.maxLines,
        });
        if (!verdict.passed && verdict.failure) {
          result = {
            ...result,
            passed: false,
            failures: [verdict.failure, ...result.failures],
            rungResults: [
              ...(result.rungResults ?? []),
              {
                gate: "bounds",
                rung: "bounds",
                layer: "hygiene",
                passed: false,
                exitCode: 1,
                durationMs: 0,
              },
            ],
          };
        }
      }
    }
    // The built-in layers (G3): security, hygiene, and robustness once the
    // declared gates pass (mutation testing is only meaningful then).
    const builtin = this.options.builtinGates;
    if (builtin) {
      const project = this.options.restricted ? { ...builtin, mutation: false } : builtin;
      const extra = await runBuiltinGates({
        root: this.tools.root,
        base,
        diff,
        // The acceptance tests the harness staged are not the card's writing.
        harnessOwned: (this.options.card?.acceptanceTests ?? []).map((t) => `tests/${t}`),
        project: result.passed ? project : { ...project, mutation: false },
        // The visual layer only once the declared gates pass: a page that
        // does not build has nothing to look at.
        visual: result.passed && !this.options.restricted,
        ...(this.options.stateDir ? { stateDir: this.options.stateDir } : {}),
        ...(this.options.registry ? { registry: this.options.registry } : {}),
        runTests: async () =>
          (await this.options.gateRunner.runGates(["test"], this.tools.root)).passed,
      });
      // No catch: each built-in layer runs guarded and reports itself as not
      // run, so the layers never vanish from the result (gates rule 9, B2.3).
      this.advisories = extra.advisories;
      result = {
        ...result,
        passed: result.passed && extra.failures.length === 0,
        failures: [...extra.failures, ...result.failures],
        rungResults: [...(result.rungResults ?? []), ...extra.outcomes],
      };
    }
    // The one cap (gates rule 20, F14): every gate has reported, so declared,
    // integrity, bounds and built-in failures are checked complete and ranked
    // together, and three reach the model.
    // A harness defect (an incomplete failure) is filled and recorded, never
    // thrown mid-turn.
    const defects = [...(result.defects ?? [])];
    result = {
      ...result,
      failures: finalizeFailures(result.failures, {
        cwd: this.tools.root,
        onIncomplete: (d) => defects.push(d),
      }),
    };
    if (defects.length > 0) {
      this.advisories = [...this.advisories, ...defects.map((d) => `gate defect: ${d}`)];
    }
    this.memory.observe(result);
    return result;
  }

  /** Advisory findings of the last verification (mutation survivors, unverified dependencies). */
  public getAdvisories(): string[] {
    return [...this.advisories];
  }

  /** Release what the card holds: its background processes (L23). */
  public dispose(): void {
    this.tools.dispose();
  }

  /**
   * Hand the Worker typed failures the harness found after its loop ended — a
   * rebase conflict's hunks (review-git RG-N1-1) — so it continues within its
   * remaining budget: the failures stand as the last check's, and a finish
   * needs a fresh check.
   */
  public returnToWorker(failures: GateFailure[], note: string): void {
    this.isFinished = false;
    this.tools.resetFinish();
    this.lastGateFailure = failures[0];
    this.lastGateFailures = failures;
    this.lastCheck = undefined;
    this.writtenSinceCheck = true;
    this.history.push({
      turn: this.stepsUsed,
      action: "returned by the harness",
      result: `${note}\n${failures
        .map(
          (f, i) =>
            `${i + 1}. [${f.gate ?? f.rung}] ${f.location?.file ?? ""}\n${f.errorExcerpt}${f.suggestedAction ? `\n   fix: ${f.suggestedAction}` : ""}`,
        )
        .join("\n")}`,
    });
  }

  /**
   * A person's message, delivered into the Worker's next step (WL-N10-1): it
   * joins the history the next prompt carries, after the current step's tool
   * calls have finished.
   */
  public deliverMessage(text: string, from = "a person's message"): void {
    this.history.push({ turn: this.stepsUsed, action: from, result: text });
  }

  /** The skills this session's prompts left out or cut (EXT-22a, EXT-25). */
  public getSkillReport(): {
    omitted: { name: string; missingTools: string[] }[];
    truncated: { name: string; budgetTokens: number; keptTokens: number; originalTokens: number }[];
  } {
    return {
      omitted: [...this.skillsOmitted.values()],
      truncated: [...this.skillsTruncated.values()],
    };
  }

  /** WL-N10-2: stop at the next step boundary with the resumable `paused`. */
  public pause(by: string): void {
    this.pausedBy = by;
  }

  public async abort(reason: string): Promise<void> {
    this.abortReason = reason;
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
    // Harness code, not the agent: read-before-edit governs model tool calls.
    this.tools.markSeen(relativePath);
    this.unwrap(
      await this.tools.execute({
        id: "direct",
        name: "replace_lines",
        arguments: { path: relativePath, start: startLine, end: endLine, replacement },
      }),
    );
  }

  public async executeEdit(relativePath: string, search: string, replace: string): Promise<void> {
    // Harness code, not the agent: read-before-edit governs model tool calls.
    this.tools.markSeen(relativePath);
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
    // Harness code, not the agent: read-before-edit governs model tool calls.
    this.tools.markSeen(relativePath);
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
    // Harness code, not the agent: read-before-edit governs model tool calls.
    this.tools.markSeen(relativePath);
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
