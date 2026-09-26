import type { CardStatus, DecisionRequestRecord } from "@sekhemet/kernel";
import { resolveDecisionAtDeadline } from "./decision.js";
import { type PlannerLedger, appendPlannerEvent, moveCard, plannerEvents } from "./ledger.js";
import type { DecisionRequest } from "./types.js";

/**
 * The planner's decision-request pipeline (P9, P10, P11; design "Durable
 * asynchronous execution" and "Decision request format & safe-fallback
 * protocol"), on the kernel's decision records (K20, `store.runs`).
 *
 * The full planner request (options with consequences and previews, the
 * policy, the deadline) travels in the record's `context` as JSON, so the
 * dashboard and the CLI answer through the same K20 table the ask-tier
 * approver uses. A `default_deny` request parks the card: it releases the
 * machine rather than holding a turn open; under `safe_default` the card
 * keeps its state and work proceeds on the default. An answer returns it to Ready with the answer in
 * its dossier; cards planned under the decision leave Planning. At the
 * deadline `safe_default` answers with the default (and records
 * `decision/default_applied`), `default_deny` times the request out and the
 * card stays Parked (`decision/parked`). All of it is in the ledger, so it
 * survives a restart.
 */
export const PLANNER_DECISION_KIND = "planner";

export const DECISION_OUTCOME_EVENTS = {
  defaultApplied: "decision/default_applied",
  parked: "decision/parked",
} as const;

export interface PlannerDecision {
  /** The kernel record id (`dec_...`), which answers use. */
  id: string;
  record: DecisionRequestRecord;
  request: DecisionRequest;
  state: "pending" | "answered" | "default_applied" | "parked";
  resumeStatus?: CardStatus;
}

interface StoredContext {
  planner: DecisionRequest;
  resumeStatus?: CardStatus;
}

function parseContext(record: DecisionRequestRecord): StoredContext | undefined {
  if (record.kind !== PLANNER_DECISION_KIND) return undefined;
  try {
    const ctx = JSON.parse(record.context) as StoredContext;
    return ctx?.planner ? ctx : undefined;
  } catch {
    return undefined;
  }
}

export function waitingReason(decisionId: string): string {
  return `Waiting on decision ${decisionId}`;
}

export class DecisionStore {
  constructor(private readonly ledger: PlannerLedger) {}

  public async all(): Promise<PlannerDecision[]> {
    const outcomes = await plannerEvents(this.ledger, Object.values(DECISION_OUTCOME_EVENTS));
    const ids = (type: string) =>
      new Set(outcomes.filter((e) => e.type === type).map((e) => (e.payload as { id: string }).id));
    const defaulted = ids(DECISION_OUTCOME_EVENTS.defaultApplied);
    const parked = ids(DECISION_OUTCOME_EVENTS.parked);
    const out: PlannerDecision[] = [];
    for (const record of this.ledger.store.runs.listDecisions()) {
      const ctx = parseContext(record);
      if (!ctx) continue;
      const state =
        record.status === "pending"
          ? parked.has(record.id)
            ? "parked"
            : "pending"
          : record.status === "timed_out"
            ? "parked"
            : defaulted.has(record.id)
              ? "default_applied"
              : "answered";
      out.push({
        id: record.id,
        record,
        request: ctx.planner,
        state,
        ...(ctx.resumeStatus ? { resumeStatus: ctx.resumeStatus } : {}),
      });
    }
    return out;
  }

  public async get(id: string): Promise<PlannerDecision | undefined> {
    return (await this.all()).find((d) => d.id === id || d.request.id === id);
  }

  /** Waiting on a human: pending, or parked after a default_deny deadline. */
  public async waiting(): Promise<PlannerDecision[]> {
    return (await this.all()).filter((d) => d.state === "pending" || d.state === "parked");
  }

  /**
   * Persist a request (idempotent per planner request id) and park its card
   * (P11). Returns the kernel id.
   */
  public async request(req: DecisionRequest, options: { park?: boolean } = {}): Promise<string> {
    const existing = (await this.all()).find((d) => d.request.id === req.id);
    if (existing) return existing.id;
    const { store } = this.ledger;
    const card = await store.getCard(req.cardId);
    // Only `default_deny` parks from the request (planner-pm §2.10.3, kernel
    // rule 27): under `safe_default` work proceeds on the default.
    const park =
      options.park !== false &&
      req.policy === "default_deny" &&
      card !== null &&
      card.status !== "done";
    const ctx: StoredContext = {
      planner: req,
      ...(park && card ? { resumeStatus: card.status } : {}),
    };
    const record = await store.runs.requestDecision({
      ...(card ? { cardId: req.cardId } : {}),
      kind: PLANNER_DECISION_KIND,
      question: req.question,
      context: JSON.stringify(ctx),
      options: req.options.map((o) => o.label),
      recommendationIndex: req.recommendation.optionIndex,
    });
    if (park && card && card.status !== "parked") {
      await moveCard(this.ledger, {
        cardId: req.cardId,
        from: card.status,
        to: "parked",
        reason: `awaiting decision ${record.id}`,
      });
      await store.updateCard(
        req.cardId,
        { blockedReason: `Decision needed: ${req.question}` },
        "planner",
      );
    }
    if (card) {
      const previews = req.previewSketches.length
        ? `\nApproach previews:\n${req.previewSketches.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
        : "";
      await store.recordDossierEntry({
        cardId: req.cardId,
        kind: "question",
        text: `${req.question}\nOptions: ${req.options
          .map((o, i) => `${i + 1}. ${o.label} (${o.consequence}; ${o.effortDelta})`)
          .join(
            "; ",
          )}\nRecommended: ${req.options[req.recommendation.optionIndex]?.label ?? "none"}: ${req.recommendation.rationale}\nIf unanswered by ${req.defaultIfNoAnswer.deadline}: ${req.policy === "safe_default" ? "the default applies" : "the card stays parked"}.${previews}`,
        actor: "planner",
      });
    }
    return record.id;
  }

  /** A human's answer: recorded in K20, written to the dossier, and the card resumes. */
  public async answer(
    id: string,
    optionIndex: number,
    by = "human",
    /** The person answering (kernel rule 19, K-N2-2). */
    principal?: string,
  ): Promise<PlannerDecision> {
    const d = await this.get(id);
    if (!d) throw new Error(`No planner decision ${id}`);
    await this.ledger.store.runs.answerDecision(d.id, optionIndex, by, principal);
    const label = d.request.options[optionIndex]?.label ?? String(optionIndex);
    await this.resume(d, `Decision: ${d.request.question}\nAnswer: ${label}`);
    return (await this.get(d.id)) as PlannerDecision;
  }

  /** Apply deadlines (P10); the queue calls this each pass. */
  public async sweepDeadlines(now: Date = new Date()): Promise<PlannerDecision[]> {
    const changed: PlannerDecision[] = [];
    for (const d of await this.all()) {
      if (d.state !== "pending") continue;
      const res = resolveDecisionAtDeadline(d.request, now);
      if (res.outcome === "awaiting") continue;
      if (res.outcome === "default_applied" && res.optionIndex !== undefined) {
        await appendPlannerEvent(
          this.ledger,
          DECISION_OUTCOME_EVENTS.defaultApplied,
          { id: d.id, optionIndex: res.optionIndex, reason: res.reason },
          { cardId: d.record.cardId },
        );
        await this.ledger.store.runs.answerDecision(d.id, res.optionIndex, "safe_default");
        const label = d.request.options[res.optionIndex]?.label ?? "default";
        await this.resume(
          d,
          `Decision (no answer by the deadline; safe default applied): ${label}`,
        );
      } else {
        // default_deny: the K20 record stays pending (a human can still answer
        // it); the card stays parked and the ledger says why.
        await appendPlannerEvent(
          this.ledger,
          DECISION_OUTCOME_EVENTS.parked,
          { id: d.id, reason: res.reason },
          { cardId: d.record.cardId },
        );
      }
      changed.push((await this.get(d.id)) as PlannerDecision);
    }
    return changed;
  }

  private async resume(d: PlannerDecision, note: string): Promise<void> {
    const { store } = this.ledger;
    const waitingOn = waitingReason(d.id);
    for (const child of await store.listCards()) {
      if (child.status !== "planning" || child.blockedReason !== waitingOn) continue;
      await store.recordDossierEntry({
        cardId: child.id,
        kind: "answer",
        text: note,
        actor: "planner",
      });
      await moveCard(this.ledger, {
        cardId: child.id,
        from: child.status,
        to: (child.dependsOn ?? []).length === 0 ? "ready" : "backlog",
        reason: `decision ${d.id} resolved`,
      });
      await store.updateCard(child.id, { blockedReason: null }, "planner");
    }
    const card = d.record.cardId ? await store.getCard(d.record.cardId) : null;
    if (!card) return;
    await store.recordDossierEntry({
      cardId: card.id,
      kind: "answer",
      text: note,
      actor: "planner",
    });
    const others = (await this.waiting()).filter(
      (x) => x.record.cardId === card.id && x.id !== d.id,
    );
    if (card.status === "parked" && others.length === 0) {
      // Unpark returns a card to Backlog or Planning when it was parked from
      // there, and re-queues it at Ready otherwise: parked has no edge back
      // into the middle of a state (kernel rule 25, K-N5-6).
      const back: CardStatus =
        d.resumeStatus === "backlog" || d.resumeStatus === "planning" ? d.resumeStatus : "ready";
      await moveCard(this.ledger, {
        cardId: card.id,
        from: card.status,
        to: back,
        reason: `decision ${d.id} resolved`,
      });
      await store.updateCard(card.id, { blockedReason: null }, "planner");
    }
  }
}
