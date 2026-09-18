import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  type TurnHistoryItem,
  type WorkerPromptResult,
  buildWorkerPrompt,
  condenseToolOutput,
  retrieveMaskedObservation,
} from "@sekhemet/context";
import {
  DEFAULT_PROJECT_CONFIG,
  type GateFailure,
  type GateResult,
  checkBounds,
} from "@sekhemet/gates";
import type { CardRecord } from "@sekhemet/kernel";
import { checkExecutionHeadroom, readSwapUsedBytes, reasoningForStep } from "@sekhemet/models";
import type { ExecutionResult } from "@sekhemet/sandbox";
import { apiHints } from "./api_surface.js";
import { OscillationDetector } from "./detector.js";
import {
  integrityFailures,
  scanDiffIntegrity,
  worktreeDiff,
  worktreeNumstat,
} from "./integrity.js";
import { type LadderState, RepairLadder, type RungPolicy } from "./ladder.js";
import type { ToolObservation } from "./observation.js";
import { buildRepoMap } from "./repo_map.js";
import { TOOL_CATALOG, restrictedToolCatalog } from "./tool_catalog.js";
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
  private rulesUsed = new Set<string>();
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
  /** Set by `abort`; the next turn stops with `human_abort` without calling the model. */
  private abortReason: string | undefined;
  /** A re-plan has been applied to this card (from the start, or in-loop). */
  private replanned: boolean;
  /** The plan an in-loop re-plan produced, shown with the manager's guidance. */
  private replanGuidance: string | undefined;
  private replanRequest: ReplanRequest | undefined;
  /** Successful writes this card, so the runner can tell when to checkpoint. */
  private writeCount = 0;
  /** The last prompt the allocator built (for the transcript and evidence). */
  private lastPrompt: WorkerPromptResult | undefined;

  constructor(private options: SessionOptions) {
    if (options.priorLessons?.length) this.memory.seed(options.priorLessons);
    this.cardId = options.cardId;
    this.stepBudget = options.stepBudget;
    this.card = options.card ?? synthesizeCard(options);
    this.oscillationDetector = new OscillationDetector(options.oscillationThreshold ?? 3);
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
    });
    // H17: a resumed card continues its step count from the checkpoint.
    if (options.startStep !== undefined && options.startStep > 0) {
      this.stepsUsed = Math.floor(options.startStep);
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

  /** Why this card should be parked, for the human who picks it up (L15 rung 4). */
  public getParkDiagnosis(stopReason: ParkDiagnosis["stopReason"]): ParkDiagnosis {
    const failures = this.lastGateFailures.slice(0, 3).map((f) => ({
      gate: f.gate ?? f.rung,
      excerpt: f.errorExcerpt.split("\n")[0]?.slice(0, 300) ?? "",
      ...(f.location?.file
        ? { location: `${f.location.file}${f.location.line ? `:${f.location.line}` : ""}` }
        : {}),
    }));
    const first = failures[0];
    const suggestion =
      stopReason === "capability_ceiling"
        ? `A re-planned attempt also exhausted the repair ladder${first ? ` on ${first.gate}` : ""}. Split the card, give it to a stronger model, or fix ${first?.location ?? "the failing location"} by hand.`
        : first
          ? `Four repair rungs could not clear ${first.gate}${first.location ? ` at ${first.location}` : ""}. Re-plan the card or answer what the failure needs.`
          : "The repair ladder ran out without a typed failure; re-run the gates by hand.";
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
      content: condenseToolOutput(
        `Gates failing (not submitted — keep working):\n${lines.join("\n")}`,
        { command: "check", exitCode: 1, cardId: this.cardId, turn: this.stepsUsed },
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
      // Not in the contract: ask the team. Merit answers now if it is
      // resident; otherwise the question waits for its next turn on the host.
      const reply = await this.options
        .askTeam(q, questionEntryId ? { questionEntryId } : {})
        .catch(() => undefined);
      if (reply) {
        await this.options.recordAnswer?.(reply, questionEntryId).catch(() => undefined);
        return {
          tool: "ask",
          ok: true,
          summary: "answered by Merit",
          content: `Merit (project manager) answers: ${reply}`,
        };
      }
      return {
        tool: "ask",
        ok: true,
        summary: "queued for Merit",
        content:
          'The contract does not answer that, and Merit is not loaded right now; your question is queued for it. Proceed with the most conservative reading the acceptance tests allow and record the assumption with note("Assumed: ...").',
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
        if (content.length <= MAX_CHARS) {
          pinned.push({ path, content, label });
          // Shown in full in the prompt (even when empty): it has been read (L17).
          this.tools.markSeen(path);
        }
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

  /** Tool schemas sent alongside the prompt; they count against the window too. */
  /** The tools this card may use: the restricted catalog under `--restricted` (S12). */
  private catalog() {
    const base = this.options.tools ?? TOOL_CATALOG;
    return this.options.restricted ? restrictedToolCatalog(base) : base;
  }

  private toolDefinitions() {
    const catalog = this.catalog();
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
              ...(p.enumValues?.length ? { enum: p.enumValues } : {}),
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
    // A margin for tokenizer disagreement with the character estimate.
    return window ? window.contextTokens - window.maxTokens - 256 : undefined;
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
    const skills =
      this.options.skillsRegistry?.resolveActiveSkills(
        this.card.title,
        this.options.scopeFiles ?? [],
      ) ?? [];
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
    const dossier = (this.options.dossierLines ?? [])
      .filter((l) => l.trim().length > 0)
      .map((text) => ({ label: "From the team (this card)", text }));
    const completedWork = [
      ...[...this.filesWritten].sort().map((f) => `wrote ${f}`),
      // Listing what was already read is what stops the agent spending its
      // budget re-reading files it has in front of it.
      ...this.tools.getReadFiles().map((f) => `read ${f} (do not re-read)`),
    ];
    const pending = this.pendingScopeFiles();
    const built = buildWorkerPrompt({
      card: { ...this.card, stepsUsed: this.stepsUsed },
      tools: this.catalog(),
      ...(native ? { nativeToolSchemas: this.toolDefinitions() } : {}),
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
      ...(this.card.spec ? { goal: this.card.spec } : {}),
      ...(this.card.acceptanceCriteria?.length
        ? { acceptanceCriteria: this.card.acceptanceCriteria }
        : {}),
      ...(completedWork.length > 0 ? { completedWork } : {}),
      ...(pending.length > 0
        ? { openTodos: pending }
        : { readyToVerify: this.filesWritten.size > 0 }),
    });
    for (const id of built.rulesUsed) this.rulesUsed.add(id);
    if (this.history.length > 8) {
      this.compactedTurns = Math.max(this.compactedTurns, this.history.length - 6);
    }
    this.lastPrompt = built;
    return built;
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
    if (this.abortReason !== undefined) {
      return {
        turnIndex: this.stepsUsed,
        toolCalls: [],
        observations: [],
        stopReason: "human_abort",
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
      return { turnIndex, toolCalls: [], observations: [], stopReason: "budget_exhausted" };
    }

    // Reasoning per step (M6): off for ordinary steps and direct repair, on
    // once the direct fix has failed.
    const rung = this.activeRung?.rung;
    const thinking = reasoningForStep(
      rung && rung !== "direct_repair" ? { purpose: "repair", rung } : { purpose: "mechanical" },
    );

    const response = await this.options.modelAdapter.generate({
      systemPrompt,
      prompt,
      reasoning: thinking.reasoning,
      reasoningBudgetTokens: thinking.reasoningBudgetTokens,
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
            : call.name === "ask"
              ? await this.askObservation(call.arguments.question)
              : await this.tools.execute(call);
      observations.push(observation);

      if (observation.ok && WRITE_TOOLS.has(call.name)) {
        const path = call.arguments.path;
        if (typeof path === "string") this.filesWritten.add(path.replace(/^\.\//, ""));
        this.writtenSinceCheck = true;
        this.writeCount++;
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
      try {
        gateResult = await this.runVerification();
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
    // The integrity gate (ARIS: "plausible unsupported success"): a pass
    // bought by switching a check off is not a pass.
    if (this.options.integrityGate !== false) {
      const protectedTests = (this.card.acceptanceTests ?? []).map((t) =>
        t.startsWith("tests/") ? t : `tests/${t}`,
      );
      const violations = scanDiffIntegrity(
        worktreeDiff(this.tools.root, this.options.baseBranch ?? "main"),
        protectedTests,
      );
      if (violations.length > 0) {
        result = {
          ...result,
          passed: false,
          failures: [...integrityFailures(violations), ...result.failures],
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
      const perFile = worktreeNumstat(this.tools.root, this.options.baseBranch ?? "main");
      if (perFile) {
        const own = perFile.filter((f) => !staged.has(f.file));
        const verdict = checkBounds({
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
    this.memory.observe(result);
    return result;
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
