import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "./log.js";
import { STOP_REASONS } from "./stop_reasons.js";
import type {
  AttemptOutcome,
  AttemptRecord,
  AttemptStatus,
  BuiltBy,
  CardStopReason,
  CompetenceEntry,
  CompetenceSummary,
  CreateDecisionInput,
  DecisionRequestRecord,
  DecisionStatus,
  EventRecord,
  EvidenceBundleRecord,
  EvidenceChecks,
  FinishAttemptInput,
  GateResultExternalRef,
  GateResultRecord,
  RecordCompetenceInput,
  RecordGateResultInput,
  RecordStepInput,
  RepairRung,
  StartAttemptInput,
  StepRecord,
  StepToolCall,
  ToolCallFormatCode,
} from "./types.js";
import { ATTEMPT_ROLES } from "./types.js";

/** Ledger event types for run records; each is replayed into its table (K8). */
export const RUN_EVENTS = {
  attemptStarted: "attempt/started",
  attemptFinished: "attempt/finished",
  stepRecorded: "step/recorded",
  stepCheckpointed: "step/checkpointed",
  gateResult: "gate/result",
  evidenceRecorded: "evidence/recorded",
  decisionRequested: "decision/requested",
  decisionAnswered: "decision/answered",
  decisionTimedOut: "decision/timed_out",
  competenceRecorded: "competence/recorded",
} as const;

/**
 * A decision's delivery to the card that asked (planner-pm PM-P2-7). Not a
 * projected table: `deliveredAt` is read from this event.
 */
export const DECISION_DELIVERED_EVENT = "decision/delivered";

const RUNGS = new Set<RepairRung>([1, 2, 3, 4]);
const TOOL_ARMS = new Set<ToolCallFormatCode>(["A", "B", "C"]);

const GATE_LAYERS = new Set([
  "static",
  "functional",
  "robustness",
  "security",
  "visual",
  "hygiene",
]);

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** The `attempt/finished` payload as written since WL-N5-1. */
type FinishedPayload = FinishAttemptInput & {
  cardId: string;
  attemptNumber: number;
  modelId: string;
  completedAt: string;
};

/**
 * Does this outcome say anything about the Worker? Not when a person built
 * it, and not when something outside the model stopped it — a halt, a crash,
 * a quota, a hook (the stop reason's `measuresModel`, MD-N6-2).
 */
export function measuresModel(o: AttemptOutcome): boolean {
  return o.builtBy.kind !== "person" && STOP_REASONS[o.stopReason]?.measuresModel !== false;
}

/**
 * Each card's first attempt that measures the Worker, in ledger order: what
 * Pass@1, the Worker's record and a rule's credit read as "first try". A
 * resume after a halt starts a new attempt number, but it is still the
 * Worker's first real try at the card (B4.0a review M2).
 */
export function firstModelAttempts(outcomes: readonly AttemptOutcome[]): AttemptOutcome[] {
  const seen = new Set<string>();
  const first: AttemptOutcome[] = [];
  for (const o of [...outcomes].sort(
    (a, b) => a.attemptNumber - b.attemptNumber || a.seq - b.seq,
  )) {
    if (seen.has(o.cardId) || !measuresModel(o)) continue;
    seen.add(o.cardId);
    first.push(o);
  }
  return first.sort((a, b) => a.seq - b.seq);
}

/**
 * The one reader of attempt outcomes (WL-N5-2): `attempt/finished` records,
 * in ledger order. A record written before the record was extended is
 * completed from its own `attempt/started` event (number, model, arm,
 * `builtBy`), never from another store. Takes any handle on the ledger, a
 * read-only one included.
 */
export function readAttemptOutcomes(
  db: DatabaseSync,
  options: { cardId?: string } = {},
): AttemptOutcome[] {
  const types = [RUN_EVENTS.attemptStarted, RUN_EVENTS.attemptFinished];
  const rows = (options.cardId
    ? db
        .prepare(
          "SELECT seq, type, payload FROM events WHERE type IN (?, ?) AND card_id = ? ORDER BY seq",
        )
        .all(...types, options.cardId)
    : db
        .prepare("SELECT seq, type, payload FROM events WHERE type IN (?, ?) ORDER BY seq")
        .all(...types)) as unknown as { seq: number; type: string; payload: string }[];
  const started = new Map<string, Partial<AttemptRecord>>();
  const out: AttemptOutcome[] = [];
  for (const row of rows) {
    const p = json<Record<string, unknown>>(row.payload, {});
    if (row.type === RUN_EVENTS.attemptStarted) {
      if (typeof p.id === "string") started.set(p.id, p as Partial<AttemptRecord>);
      continue;
    }
    const f = p as Partial<FinishedPayload>;
    if (typeof f.attemptId !== "string" || !f.status || !f.stopReason) continue;
    const s = started.get(f.attemptId) ?? {};
    const modelId = String(f.modelId ?? s.modelId ?? "");
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    out.push({
      seq: Number(row.seq),
      attemptId: f.attemptId,
      cardId: String(f.cardId ?? s.cardId ?? ""),
      attemptNumber: Number(f.attemptNumber ?? s.attemptNumber ?? 1),
      rung: (f.rung ?? s.rung ?? 1) as RepairRung,
      toolArm: (f.toolArm ?? s.toolArm ?? "A") as ToolCallFormatCode,
      role: f.role ?? "worker",
      modelId,
      status: f.status,
      passed: f.status === "passed",
      stopReason: f.stopReason,
      ...(typeof f.steps === "number" ? { steps: f.steps } : {}),
      tokensUsed: Number(f.tokensUsed ?? 0),
      secondsUsed: Number(f.secondsUsed ?? 0),
      ruleIds: strings(f.ruleIds),
      withheldRuleIds: strings(f.withheldRuleIds),
      exemplarIds: strings(f.exemplarIds),
      builtBy: f.builtBy ?? s.builtBy ?? { kind: "worker", id: modelId },
      ...(f.cardClass ? { cardClass: f.cardClass } : {}),
      ...(f.projectId ? { projectId: f.projectId } : {}),
      ...(typeof f.linesAdded === "number" ? { linesAdded: f.linesAdded } : {}),
      ...(f.repairPlanId ? { repairPlanId: f.repairPlanId } : {}),
      ...(f.evidenceId ? { evidenceId: f.evidenceId } : {}),
      completedAt: String(f.completedAt ?? ""),
    });
  }
  return out;
}

/**
 * Attempts, steps, gate results, evidence bundles, decision requests and the
 * competence model (K16-K21), as ledger-backed tables.
 *
 * Every write appends its event first (with the typed `cardId`,
 * `attemptId` and `stepId` columns filled, K4) and then projects it, so the
 * tables can be rebuilt from the log and verified byte-identical (K8). The
 * payload carries every generated value (ids, timestamps) for that reason.
 */
export class RunLedger {
  constructor(
    private db: DatabaseSync,
    private log: EventLog,
  ) {}

  // --- Attempts (K16) ---------------------------------------------------------

  public async startAttempt(input: StartAttemptInput): Promise<AttemptRecord> {
    if (!Number.isInteger(input.attemptNumber) || input.attemptNumber < 1) {
      throw new Error(`Attempt number must be a positive integer, got ${input.attemptNumber}`);
    }
    const rung = input.rung ?? 1;
    if (!RUNGS.has(rung)) throw new Error(`Rung must be 1..4, got ${rung}`);
    const toolArm = input.toolArm ?? "A";
    if (!TOOL_ARMS.has(toolArm)) throw new Error(`Tool arm must be A, B or C, got ${toolArm}`);
    // K-N6-4: who builds it — the Worker running the model unless a person does.
    const builtBy = input.builtBy ?? { kind: "worker" as const, id: input.modelId };
    if ((builtBy.kind !== "worker" && builtBy.kind !== "person") || !builtBy.id) {
      throw new Error(`builtBy is {kind: "worker" | "person", id}, got ${JSON.stringify(builtBy)}`);
    }
    const payload: AttemptRecord = {
      id: `att_${randomUUID().slice(0, 12)}`,
      cardId: input.cardId,
      attemptNumber: input.attemptNumber,
      rung,
      modelId: input.modelId,
      toolArm,
      status: "running",
      tokensUsed: 0,
      secondsUsed: 0,
      ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}),
      ...(input.resumedFromStep !== undefined ? { resumedFromStep: input.resumedFromStep } : {}),
      builtBy,
      startedAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "executor",
        type: RUN_EVENTS.attemptStarted,
        cardId: input.cardId,
        attemptId: payload.id,
        payload,
      },
      { project: () => this.projectAttemptStarted(payload) },
    );
    return payload;
  }

  public async finishAttempt(input: FinishAttemptInput): Promise<AttemptRecord> {
    const attempt = this.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Attempt not found: ${input.attemptId}`);
    const rung = input.rung ?? attempt.rung;
    if (!RUNGS.has(rung)) throw new Error(`Rung must be 1..4, got ${rung}`);
    const toolArm = input.toolArm ?? attempt.toolArm;
    if (!TOOL_ARMS.has(toolArm)) throw new Error(`Tool arm must be A, B or C, got ${toolArm}`);
    const role = input.role ?? "worker";
    if (!ATTEMPT_ROLES.includes(role)) {
      throw new Error(`Attempt role must be ${ATTEMPT_ROLES.join(" or ")}, got ${role}`);
    }
    const builtBy = input.builtBy ??
      attempt.builtBy ?? { kind: "worker" as const, id: attempt.modelId };
    if ((builtBy.kind !== "worker" && builtBy.kind !== "person") || !builtBy.id) {
      throw new Error(`builtBy is {kind: "worker" | "person", id}, got ${JSON.stringify(builtBy)}`);
    }
    // WL-N5-1: one self-contained record, read by every consumer of outcomes.
    const payload: FinishedPayload = {
      ...input,
      cardId: attempt.cardId,
      attemptNumber: attempt.attemptNumber,
      modelId: attempt.modelId,
      rung,
      toolArm,
      role,
      builtBy,
      ruleIds: [...(input.ruleIds ?? [])],
      withheldRuleIds: [...(input.withheldRuleIds ?? [])],
      exemplarIds: [...(input.exemplarIds ?? [])],
      completedAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "executor",
        type: RUN_EVENTS.attemptFinished,
        cardId: attempt.cardId,
        attemptId: attempt.id,
        payload,
      },
      { project: () => this.projectAttemptFinished(payload) },
    );
    return this.getAttempt(input.attemptId) as AttemptRecord;
  }

  /** Every finished attempt's outcome, in ledger order (WL-N5-2). */
  public readAttemptOutcomes(options: { cardId?: string } = {}): AttemptOutcome[] {
    return readAttemptOutcomes(this.db, options);
  }

  public getAttempt(id: string): AttemptRecord | undefined {
    const r = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapAttempt(r) : undefined;
  }

  public listAttempts(cardId: string): AttemptRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM attempts WHERE card_id = ? ORDER BY attempt_number, started_at")
        .all(cardId) as unknown as Record<string, unknown>[]
    ).map((r) => this.mapAttempt(r));
  }

  /** The next attempt number for a card (one past the highest recorded). */
  public nextAttemptNumber(cardId: string): number {
    const r = this.db
      .prepare("SELECT MAX(attempt_number) AS n FROM attempts WHERE card_id = ?")
      .get(cardId) as { n: number | null };
    return (r.n ?? 0) + 1;
  }

  private mapAttempt(r: Record<string, unknown>): AttemptRecord {
    return {
      id: String(r.id),
      cardId: String(r.card_id),
      attemptNumber: Number(r.attempt_number),
      rung: Number(r.rung ?? 1) as RepairRung,
      modelId: String(r.model_id),
      toolArm: (r.tool_arm ?? "A") as ToolCallFormatCode,
      status: r.status as AttemptStatus,
      ...(r.stop_reason ? { stopReason: r.stop_reason as CardStopReason } : {}),
      tokensUsed: Number(r.tokens_used),
      secondsUsed: Number(r.seconds_used),
      ...(r.evidence_id ? { evidenceId: String(r.evidence_id) } : {}),
      ...(r.forked_from_attempt
        ? {
            forkedFrom: {
              attemptId: String(r.forked_from_attempt),
              step: Number(r.forked_from_step ?? 0),
            },
          }
        : {}),
      ...(r.resumed_from_step !== null && r.resumed_from_step !== undefined
        ? { resumedFromStep: Number(r.resumed_from_step) }
        : {}),
      builtBy: json<BuiltBy>(r.built_by, { kind: "worker", id: String(r.model_id) }),
      startedAt: String(r.started_at),
      ...(r.completed_at ? { completedAt: String(r.completed_at) } : {}),
    };
  }

  private projectAttemptStarted(p: AttemptRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO attempts (id, card_id, attempt_number, rung, model_id, tool_arm,
          status, stop_reason, tokens_used, seconds_used, evidence_id, forked_from_attempt,
          forked_from_step, resumed_from_step, started_at, completed_at, built_by)
         VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, 0, 0, NULL, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        p.id,
        p.cardId,
        p.attemptNumber,
        p.rung,
        p.modelId,
        p.toolArm,
        p.forkedFrom?.attemptId ?? null,
        p.forkedFrom?.step ?? null,
        p.resumedFromStep ?? null,
        p.startedAt,
        p.builtBy ? JSON.stringify(p.builtBy) : null,
      );
  }

  private projectAttemptFinished(p: FinishAttemptInput & { completedAt: string }): void {
    // A pre-extension record carries no rung, arm or builtBy: the started values stand.
    this.db
      .prepare(
        `UPDATE attempts SET status = ?, stop_reason = ?, tokens_used = ?, seconds_used = ?,
          evidence_id = ?, completed_at = ?, rung = COALESCE(?, rung),
          tool_arm = COALESCE(?, tool_arm), built_by = COALESCE(?, built_by) WHERE id = ?`,
      )
      .run(
        p.status,
        p.stopReason,
        p.tokensUsed,
        p.secondsUsed,
        p.evidenceId ?? null,
        p.completedAt,
        p.rung ?? null,
        p.toolArm ?? null,
        p.builtBy ? JSON.stringify(p.builtBy) : null,
        p.attemptId,
      );
  }

  // --- Steps (K17) ------------------------------------------------------------

  public async recordStep(input: RecordStepInput): Promise<StepRecord> {
    const payload: StepRecord = {
      ...input,
      id: `stp_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "executor",
        type: RUN_EVENTS.stepRecorded,
        cardId: input.cardId,
        attemptId: input.attemptId,
        stepId: payload.id,
        payload,
      },
      { project: () => this.projectStep(payload) },
    );
    return payload;
  }

  /** Attach the checkpoint commit taken at a step (what fork and rewind restore). */
  public async markStepCheckpoint(stepId: string, gitRef: string): Promise<void> {
    const step = this.getStep(stepId);
    if (!step) throw new Error(`Step not found: ${stepId}`);
    const payload = { stepId, gitRef };
    // Projected by the replay's own code, before COMMIT (K-S7-3).
    await this.log.append(
      {
        actor: "sync",
        type: RUN_EVENTS.stepCheckpointed,
        cardId: step.cardId,
        attemptId: step.attemptId,
        stepId,
        payload,
      },
      { project: (event) => this.applyEvent(event as EventRecord) },
    );
  }

  public getStep(id: string): StepRecord | undefined {
    const r = this.db.prepare("SELECT * FROM steps WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapStep(r) : undefined;
  }

  public listSteps(attemptId: string): StepRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM steps WHERE attempt_id = ? ORDER BY step_index")
        .all(attemptId) as unknown as Record<string, unknown>[]
    ).map((r) => this.mapStep(r));
  }

  /** Every context pack a card's steps carried, for retention (K27). */
  public contextPackIds(cardId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT DISTINCT context_pack_id AS p FROM steps WHERE card_id = ? AND context_pack_id IS NOT NULL",
        )
        .all(cardId) as unknown as { p: string }[]
    ).map((r) => r.p);
  }

  private mapStep(r: Record<string, unknown>): StepRecord {
    return {
      id: String(r.id),
      attemptId: String(r.attempt_id),
      cardId: String(r.card_id),
      stepIndex: Number(r.step_index),
      calls: json<StepToolCall[]>(r.calls, []),
      ...(r.context_pack_id ? { contextPackId: String(r.context_pack_id) } : {}),
      ...(r.repo_state_hash ? { repoStateHash: String(r.repo_state_hash) } : {}),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      durationMs: Number(r.duration_ms),
      ...(r.stop_reason ? { stopReason: r.stop_reason as CardStopReason } : {}),
      ...(r.git_ref ? { gitRef: String(r.git_ref) } : {}),
      ...(r.sample != null ? { sample: Number(r.sample) } : {}),
      ...(r.phase ? { phase: String(r.phase) } : {}),
      ...(r.finish_reason ? { finishReason: String(r.finish_reason) } : {}),
      ...(r.thinking_tokens != null ? { thinkingTokens: Number(r.thinking_tokens) } : {}),
      ...(r.answer_tokens != null ? { answerTokens: Number(r.answer_tokens) } : {}),
      ...(r.format_errors != null ? { formatErrors: Number(r.format_errors) } : {}),
      ...(r.prose_only != null ? { proseOnly: Number(r.prose_only) } : {}),
      ...(r.cached_prompt_tokens != null
        ? { cachedPromptTokens: Number(r.cached_prompt_tokens) }
        : {}),
      ...(r.evaluated_prompt_tokens != null
        ? { evaluatedPromptTokens: Number(r.evaluated_prompt_tokens) }
        : {}),
      ...(r.draft_tokens != null ? { draftTokens: Number(r.draft_tokens) } : {}),
      ...(r.draft_accepted_tokens != null
        ? { draftAcceptedTokens: Number(r.draft_accepted_tokens) }
        : {}),
      createdAt: String(r.created_at),
    };
  }

  private projectStep(p: StepRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO steps (id, attempt_id, card_id, step_index, calls, context_pack_id,
          repo_state_hash, prompt_tokens, completion_tokens, duration_ms, stop_reason, git_ref, created_at,
          sample, phase, finish_reason, thinking_tokens, answer_tokens, format_errors, prose_only,
          cached_prompt_tokens, evaluated_prompt_tokens, draft_tokens, draft_accepted_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.attemptId,
        p.cardId,
        p.stepIndex,
        JSON.stringify(p.calls),
        p.contextPackId ?? null,
        p.repoStateHash ?? null,
        p.promptTokens,
        p.completionTokens,
        p.durationMs,
        p.stopReason ?? null,
        p.createdAt,
        p.sample ?? null,
        p.phase ?? null,
        p.finishReason ?? null,
        p.thinkingTokens ?? null,
        p.answerTokens ?? null,
        p.formatErrors ?? null,
        p.proseOnly ?? null,
        p.cachedPromptTokens ?? null,
        p.evaluatedPromptTokens ?? null,
        p.draftTokens ?? null,
        p.draftAcceptedTokens ?? null,
      );
  }

  // --- Gate results (K18) -----------------------------------------------------

  public async recordGateResult(input: RecordGateResultInput): Promise<GateResultRecord> {
    // K-N8-3: every result says where it came from; an external one says which run.
    if (input.source !== "local" && input.source !== "external") {
      throw new Error(
        `A gate result names its source, "local" or "external"; got ${String(input.source)}`,
      );
    }
    if (input.source === "external") {
      const ref = input.externalRef;
      if (!ref?.system || !ref.checkName || !ref.runUrl || !ref.headSha) {
        throw new Error(
          "An external gate result carries externalRef {system, checkName, runUrl, headSha}",
        );
      }
    }
    const layer = GATE_LAYERS.has(input.layer) ? input.layer : "functional";
    const payload: GateResultRecord = {
      ...input,
      layer,
      id: `gr_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "gate",
        type: RUN_EVENTS.gateResult,
        cardId: input.cardId,
        attemptId: input.attemptId,
        ...(input.stepId ? { stepId: input.stepId } : {}),
        payload,
      },
      { project: () => this.projectGateResult(payload) },
    );
    return payload;
  }

  public listGateResults(attemptId: string): GateResultRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM gate_results WHERE attempt_id = ? ORDER BY created_at, rowid")
        .all(attemptId) as unknown as Record<string, unknown>[]
    ).map((r) => ({
      id: String(r.id),
      attemptId: String(r.attempt_id),
      cardId: String(r.card_id),
      ...(r.step_id ? { stepId: String(r.step_id) } : {}),
      gate: String(r.gate),
      layer: String(r.layer),
      passed: r.status === "pass",
      exitCode: Number(r.exit_code),
      durationMs: Number(r.duration_ms),
      failures: json<unknown[]>(r.failures, []),
      source: (r.source === "external" ? "external" : "local") as "local" | "external",
      ...(r.external_ref
        ? { externalRef: json<GateResultExternalRef>(r.external_ref, null as never) }
        : {}),
      createdAt: String(r.created_at),
    }));
  }

  private projectGateResult(p: GateResultRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO gate_results (id, attempt_id, card_id, step_id, gate, layer, status,
          exit_code, failures, duration_ms, created_at, source, external_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.attemptId,
        p.cardId,
        p.stepId ?? null,
        p.gate,
        p.layer,
        p.passed ? "pass" : "fail",
        p.exitCode,
        JSON.stringify(p.failures),
        p.durationMs,
        p.createdAt,
        // A result recorded before sources existed was a local run.
        p.source ?? "local",
        p.externalRef ? JSON.stringify(p.externalRef) : null,
      );
  }

  // --- Evidence bundles (K19) -------------------------------------------------

  /**
   * SHA-256 over an attempt's slice of the event log (design §1157).
   *
   * The slice is identified by its events' chain hashes rather than their
   * payloads. The chain already covers each event's actor, type, association
   * columns and payload digest, so hashing the hashes is tamper-evident for
   * free, and it stays computable after a large payload is relocated to
   * `.sekhemet/artifacts/` (design §2044).
   */
  public trajectoryHash(attemptId: string): string {
    const rows = this.db
      .prepare("SELECT hash FROM events WHERE attempt_id = ? ORDER BY seq")
      .all(attemptId) as unknown as { hash: string }[];
    return createHash("sha256")
      .update(rows.map((r) => r.hash).join(""))
      .digest("hex");
  }

  public async recordEvidence(
    input: Omit<EvidenceBundleRecord, "createdAt">,
  ): Promise<EvidenceBundleRecord> {
    // Computed before this event is appended, so the reference covers the
    // trajectory the bundle summarises and not the bundle's own record.
    const trajectoryRef = input.trajectoryRef ?? this.trajectoryHash(input.attemptId);
    const payload: EvidenceBundleRecord = {
      ...input,
      trajectoryRef,
      createdAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "gate",
        type: RUN_EVENTS.evidenceRecorded,
        cardId: input.cardId,
        attemptId: input.attemptId,
        payload,
      },
      { project: () => this.projectEvidence(payload) },
    );
    return payload;
  }

  public getEvidence(id: string): EvidenceBundleRecord | undefined {
    const r = this.db.prepare("SELECT * FROM evidence_bundles WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapEvidence(r) : undefined;
  }

  public listEvidence(cardId: string): EvidenceBundleRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM evidence_bundles WHERE card_id = ? ORDER BY created_at, rowid")
        .all(cardId) as unknown as Record<string, unknown>[]
    ).map((r) => this.mapEvidence(r));
  }

  private mapEvidence(r: Record<string, unknown>): EvidenceBundleRecord {
    return {
      id: String(r.id),
      cardId: String(r.card_id),
      attemptId: String(r.attempt_id),
      passed: Number(r.passed) === 1,
      stopReason: String(r.stop_reason),
      path: String(r.path),
      sha256: String(r.sha256),
      filesTouched: json<string[]>(r.files_touched, []),
      linesAdded: Number(r.lines_added),
      linesRemoved: Number(r.lines_removed),
      ...(r.structural_diff ? { structuralDiff: String(r.structural_diff) } : {}),
      gateResultsSummary: json<Record<string, "pass" | "fail">>(r.gate_results_summary, {}),
      summary: {
        passedChecks: json<string[]>(r.passed_checks, []),
        failedChecks: json<string[]>(r.failed_checks, []),
        abandonedHypotheses: json<string[]>(r.abandoned_hypotheses, []),
      },
      ...(r.trajectory_ref ? { trajectoryRef: String(r.trajectory_ref) } : {}),
      createdAt: String(r.created_at),
    };
  }

  private projectEvidence(p: EvidenceBundleRecord): void {
    const checks: EvidenceChecks = p.summary ?? {
      passedChecks: [],
      failedChecks: [],
      abandonedHypotheses: [],
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO evidence_bundles (id, card_id, attempt_id, passed, stop_reason, path,
          sha256, files_touched, lines_added, lines_removed, trajectory_ref, structural_diff,
          gate_results_summary, passed_checks, failed_checks, abandoned_hypotheses, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.cardId,
        p.attemptId,
        p.passed ? 1 : 0,
        p.stopReason,
        p.path,
        p.sha256,
        JSON.stringify(p.filesTouched),
        p.linesAdded,
        p.linesRemoved,
        p.trajectoryRef ?? null,
        p.structuralDiff ?? null,
        JSON.stringify(p.gateResultsSummary ?? {}),
        JSON.stringify(checks.passedChecks),
        JSON.stringify(checks.failedChecks),
        JSON.stringify(checks.abandonedHypotheses),
        p.createdAt,
      );
  }

  // --- Decision requests (K20) ------------------------------------------------

  public async requestDecision(input: CreateDecisionInput): Promise<DecisionRequestRecord> {
    if (!input.question.trim()) throw new Error("A decision request needs a question");
    if (input.options.length < 2) throw new Error("A decision request needs at least two options");
    const rec = input.recommendationIndex ?? 0;
    if (!Number.isInteger(rec) || rec < 0 || rec >= input.options.length) {
      throw new Error(`Recommendation ${rec} is not one of the ${input.options.length} options`);
    }
    const payload: DecisionRequestRecord = {
      id: `dec_${randomUUID().slice(0, 12)}`,
      ...(input.cardId ? { cardId: input.cardId } : {}),
      kind: input.kind,
      question: input.question,
      context: input.context,
      options: input.options,
      recommendationIndex: rec,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await this.log.append(
      {
        actor: "executor",
        type: RUN_EVENTS.decisionRequested,
        ...(input.cardId ? { cardId: input.cardId } : {}),
        payload,
      },
      { project: () => this.projectDecisionRequested(payload) },
    );
    return payload;
  }

  public async answerDecision(
    id: string,
    optionIndex: number,
    answeredBy = "human",
    /** The acting person's opaque id (K-N2-2); a solo install's person when omitted. */
    principal?: string,
  ): Promise<DecisionRequestRecord> {
    const d = this.getDecision(id);
    if (!d) throw new Error(`Decision not found: ${id}`);
    if (d.status !== "pending") throw new Error(`Decision ${id} is already ${d.status}`);
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= d.options.length) {
      throw new Error(`Option ${optionIndex} is not one of ${d.options.length}`);
    }
    const payload = { id, optionIndex, answeredBy, answeredAt: new Date().toISOString() };
    await this.log.append(
      {
        actor: answeredBy === "human" ? "human" : "system",
        type: RUN_EVENTS.decisionAnswered,
        ...(d.cardId ? { cardId: d.cardId } : {}),
        ...(principal ? { principal } : {}),
        payload,
      },
      { project: () => this.projectDecisionAnswered(payload) },
    );
    return this.getDecision(id) as DecisionRequestRecord;
  }

  /**
   * The answer reached the card that asked (planner-pm PM-P2-7): record
   * `deliveredAt` once — a later delivery keeps the first. Refused for a
   * decision that has no answer yet.
   */
  public async recordDecisionDelivered(id: string): Promise<DecisionRequestRecord> {
    const d = this.getDecision(id);
    if (!d) throw new Error(`Decision not found: ${id}`);
    if (d.status !== "answered") {
      throw new Error(`Decision ${id} is ${d.status}: only an answered decision is delivered`);
    }
    if (d.deliveredAt) return d;
    await this.log.append({
      actor: "system",
      type: DECISION_DELIVERED_EVENT,
      ...(d.cardId ? { cardId: d.cardId } : {}),
      payload: { id, deliveredAt: new Date().toISOString() },
    });
    return this.getDecision(id) as DecisionRequestRecord;
  }

  /** When the answer reached the asker, read from the ledger (PM-P2-7). */
  private deliveredAt(id: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.deliveredAt') AS at FROM events
           WHERE type = ? AND json_extract(payload, '$.id') = ? ORDER BY seq LIMIT 1`,
      )
      .get(DECISION_DELIVERED_EVENT, id) as { at: string | null } | undefined;
    return row?.at ?? undefined;
  }

  public async expireDecision(id: string): Promise<void> {
    const d = this.getDecision(id);
    if (!d || d.status !== "pending") return;
    const payload = { id, at: new Date().toISOString() };
    // Projected by the replay's own code, before COMMIT (K-S7-3).
    await this.log.append(
      {
        actor: "system",
        type: RUN_EVENTS.decisionTimedOut,
        ...(d.cardId ? { cardId: d.cardId } : {}),
        payload,
      },
      { project: (event) => this.applyEvent(event as EventRecord) },
    );
  }

  public getDecision(id: string): DecisionRequestRecord | undefined {
    const r = this.db.prepare("SELECT * FROM decision_requests WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.mapDecision(r) : undefined;
  }

  public listDecisions(status?: DecisionStatus): DecisionRequestRecord[] {
    const rows = status
      ? this.db
          .prepare("SELECT * FROM decision_requests WHERE status = ? ORDER BY created_at, rowid")
          .all(status)
      : this.db.prepare("SELECT * FROM decision_requests ORDER BY created_at, rowid").all();
    return (rows as unknown as Record<string, unknown>[]).map((r) => this.mapDecision(r));
  }

  /**
   * Ask a person and wait (K20, S8's ask tier). Polls the table, which a
   * dashboard in another process answers; resolves to the chosen option, or
   * undefined when nobody answered in time (the request is then timed out).
   */
  public async awaitDecision(
    id: string,
    options: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
  ): Promise<number | undefined> {
    const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      const d = this.getDecision(id);
      if (d?.status === "answered") return d.selectedOptionIndex;
      if (!d || d.status === "timed_out") return undefined;
      if (Date.now() >= deadline) {
        await this.expireDecision(id);
        return undefined;
      }
      await sleep(Math.min(options.pollMs ?? 1000, Math.max(1, deadline - Date.now())));
    }
  }

  private mapDecision(r: Record<string, unknown>): DecisionRequestRecord {
    const deliveredAt = r.status === "answered" ? this.deliveredAt(String(r.id)) : undefined;
    return {
      id: String(r.id),
      ...(r.card_id ? { cardId: String(r.card_id) } : {}),
      kind: String(r.kind),
      question: String(r.question),
      context: String(r.context),
      options: json<string[]>(r.options, []),
      recommendationIndex: Number(r.recommendation_index),
      status: r.status as DecisionStatus,
      ...(r.selected_option_index !== null && r.selected_option_index !== undefined
        ? { selectedOptionIndex: Number(r.selected_option_index) }
        : {}),
      ...(r.answered_by ? { answeredBy: String(r.answered_by) } : {}),
      createdAt: String(r.created_at),
      ...(r.answered_at ? { answeredAt: String(r.answered_at) } : {}),
      ...(deliveredAt ? { deliveredAt } : {}),
    };
  }

  private projectDecisionRequested(p: DecisionRequestRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decision_requests (id, card_id, kind, question, context, options,
          recommendation_index, status, selected_option_index, answered_by, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
      )
      .run(
        p.id,
        p.cardId ?? null,
        p.kind,
        p.question,
        p.context,
        JSON.stringify(p.options),
        p.recommendationIndex,
        p.createdAt,
      );
  }

  private projectDecisionAnswered(p: {
    id: string;
    optionIndex: number;
    answeredBy: string;
    answeredAt: string;
  }): void {
    this.db
      .prepare(
        `UPDATE decision_requests SET status = 'answered', selected_option_index = ?,
          answered_by = ?, answered_at = ? WHERE id = ?`,
      )
      .run(p.optionIndex, p.answeredBy, p.answeredAt, p.id);
  }

  // --- Competence model (K21) -------------------------------------------------

  /**
   * Add an outcome to the competence model. K-N6-4: an attempt a person built
   * says nothing about a model, so naming it (`attemptId`) excludes it — no
   * row, no event — from `CompetenceEntry` and from pass rate by model.
   */
  public async recordCompetence(
    input: RecordCompetenceInput,
    options: { attemptId?: string } = {},
  ): Promise<CompetenceEntry | undefined> {
    if (options.attemptId && this.getAttempt(options.attemptId)?.builtBy?.kind === "person") {
      return undefined;
    }
    const payload: CompetenceEntry = {
      ...input,
      id: `cmp_${randomUUID().slice(0, 12)}`,
      recordedAt: new Date().toISOString(),
    };
    await this.log.append(
      { actor: "system", type: RUN_EVENTS.competenceRecorded, payload },
      { project: () => this.projectCompetence(payload) },
    );
    return payload;
  }

  public listCompetence(filter: { cardClass?: string; modelId?: string } = {}): CompetenceEntry[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.cardClass) {
      where.push("card_class = ?");
      params.push(filter.cardClass);
    }
    if (filter.modelId) {
      where.push("model_id = ?");
      params.push(filter.modelId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM competence_entries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY recorded_at, rowid`,
      )
      .all(...params) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      repoId: String(r.repo_id),
      cardClass: String(r.card_class),
      filesTouchedCount: Number(r.files_touched_count),
      difficulty: String(r.difficulty),
      modelId: String(r.model_id),
      toolArm: String(r.tool_arm),
      stepBudget: Number(r.step_budget),
      stepsUsed: Number(r.steps_used),
      stopReason: String(r.stop_reason),
      passed: Number(r.passed) === 1,
      tokensUsed: Number(r.tokens_used),
      wallClockSeconds: Number(r.wall_clock_seconds),
      recordedAt: String(r.recorded_at),
    }));
  }

  /** Measured pass rate and step use for a card class (optionally one model). */
  public competence(cardClass: string, modelId?: string): CompetenceSummary {
    const rows = this.listCompetence({ cardClass, ...(modelId ? { modelId } : {}) });
    const passing = rows.filter((r) => r.passed);
    const tokens = percentile(
      passing.map((r) => r.tokensUsed),
      0.5,
    );
    const steps = percentile(
      passing.map((r) => r.stepsUsed),
      0.8,
    );
    return {
      cardClass,
      ...(modelId ? { modelId } : {}),
      attempts: rows.length,
      passed: passing.length,
      passRate: rows.length > 0 ? passing.length / rows.length : 0,
      ...(steps !== undefined ? { stepsP80: steps } : {}),
      ...(tokens !== undefined ? { tokensMedian: tokens } : {}),
    };
  }

  private projectCompetence(p: CompetenceEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO competence_entries (id, repo_id, card_class, files_touched_count,
          difficulty, model_id, tool_arm, step_budget, steps_used, stop_reason, passed, tokens_used,
          wall_clock_seconds, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.repoId,
        p.cardClass,
        p.filesTouchedCount,
        p.difficulty,
        p.modelId,
        p.toolArm,
        p.stepBudget,
        p.stepsUsed,
        p.stopReason,
        p.passed ? 1 : 0,
        p.tokensUsed,
        p.wallClockSeconds,
        p.recordedAt,
      );
  }

  // --- Replay (K8) ------------------------------------------------------------

  /** Apply one ledger event to these tables; true when it was a run-record event. */
  public applyEvent(event: EventRecord): boolean {
    const p = event.payload as never;
    switch (event.type) {
      case RUN_EVENTS.attemptStarted:
        this.projectAttemptStarted(p);
        return true;
      case RUN_EVENTS.attemptFinished:
        this.projectAttemptFinished(p);
        return true;
      case RUN_EVENTS.stepRecorded:
        this.projectStep(p);
        return true;
      case RUN_EVENTS.stepCheckpointed: {
        const c = event.payload as { stepId: string; gitRef: string };
        this.db.prepare("UPDATE steps SET git_ref = ? WHERE id = ?").run(c.gitRef, c.stepId);
        return true;
      }
      case RUN_EVENTS.gateResult:
        this.projectGateResult(p);
        return true;
      case RUN_EVENTS.evidenceRecorded:
        this.projectEvidence(p);
        return true;
      case RUN_EVENTS.decisionRequested:
        this.projectDecisionRequested(p);
        return true;
      case RUN_EVENTS.decisionAnswered:
        this.projectDecisionAnswered(p);
        return true;
      case RUN_EVENTS.decisionTimedOut: {
        const t = event.payload as { id: string; at: string };
        this.db
          .prepare(
            "UPDATE decision_requests SET status = 'timed_out', answered_at = ? WHERE id = ?",
          )
          .run(t.at, t.id);
        return true;
      }
      case RUN_EVENTS.competenceRecorded:
        this.projectCompetence(p);
        return true;
      default:
        return false;
    }
  }
}
