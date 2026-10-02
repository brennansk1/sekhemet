import type { CardStatus, DecisionRequestRecord } from "@sekhemet/kernel";
import { sameWord } from "./criteria.js";
import { buildDecisionRequest, resolveDecisionAtDeadline } from "./decision_request.js";
import { DESIGN_COPY } from "./design_copy.js";
import type { DesignQuestion } from "./design_stage.js";
import { type PlannerLedger, appendPlannerEvent, moveCard, plannerEvents } from "./ledger.js";
import { applyOracleAnswer } from "./oracle.js";
import { contentWords } from "./text.js";
import type { DecisionRequest, SettledAnswer, SettledSource, SettledSourceKind } from "./types.js";

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
    // PM-N7-2: a disputed example row takes the value the person chose.
    if (d.request.oracle) await applyOracleAnswer(this.ledger, d.request.oracle, optionIndex);
    const label = d.request.options[optionIndex]?.label ?? String(optionIndex);
    await this.resume(d, `Decision: ${d.request.question}\nAnswer: ${label}`);
    return (await this.get(d.id)) as PlannerDecision;
  }

  /**
   * Every earlier decision's recorded answer (PM-P2-6), a person's or a
   * deadline's default: a later planning pass does not ask the same question.
   */
  public async settledSources(): Promise<SettledSource[]> {
    const out: SettledSource[] = [];
    for (const d of this.ledger.store.runs.listDecisions("answered")) {
      const answer =
        d.selectedOptionIndex !== undefined ? d.options[d.selectedOptionIndex] : undefined;
      if (!answer) continue;
      out.push({ kind: "decision", ref: d.id, text: d.question, question: d.question, answer });
    }
    return out;
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
          { id: d.id, optionIndex: res.optionIndex },
          // The reason is free text: the private part (kernel rule 33).
          { cardId: d.record.cardId, private: { reason: res.reason } },
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
    // PM-P2-7: the answer is delivered once it is in an asking card's dossier.
    let delivered = false;
    const deliver = async () => {
      if (delivered) return;
      delivered = true;
      await store.runs.recordDecisionDelivered(d.id);
    };
    for (const child of await store.listCards()) {
      if (child.status !== "planning" || !child.blockedReason?.includes(waitingOn)) continue;
      await store.recordDossierEntry({
        cardId: child.id,
        kind: "answer",
        text: note,
        actor: "planner",
      });
      await deliver();
      // The answer lifts only its own hold: a card the planner also held for
      // a criterion, a missing test or its size stays in Planning with those
      // reasons (planner-pm §2.4, PM-P1-18).
      const rest = child.blockedReason
        .replace(waitingOn, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (rest) {
        await store.updateCard(child.id, { blockedReason: rest }, "planner");
        continue;
      }
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
    await deliver();
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

/**
 * A further design question (design-stage DS-N1-4, §2.10.1): posted as its
 * own open decision on the plan's epic under `safe_default`, its default the
 * recommendation, so planning proceeds on the default while it is open and
 * the person's answer, or the deadline, settles it. Returns the kernel id.
 */
export async function postDesignQuestion(
  ledger: PlannerLedger,
  input: { cardId: string; question: DesignQuestion; spec: string },
): Promise<string> {
  const { question } = input;
  const labels = question.answers.map((a) => a.answer);
  const at = Math.max(0, labels.indexOf(question.default));
  const built = buildDecisionRequest({
    cardId: input.cardId,
    category: "vagueness",
    question: question.question,
    optionLabels: labels,
    sourceExcerpt: input.spec.slice(0, 200),
  });
  const request: DecisionRequest = {
    ...built,
    recommendation: { optionIndex: at, rationale: DESIGN_COPY.question.rationale },
    policy: "safe_default",
    defaultIfNoAnswer: { optionIndex: at, deadline: built.defaultIfNoAnswer.deadline },
  };
  return new DecisionStore(ledger).request(request);
}

/* -------------------------------------------------------------------------- */
/* Answers already recorded (planner-pm §2.10.1, PM-P2-6)                     */
/* -------------------------------------------------------------------------- */

/** How much of `of` the words `in` cover, 0..1. */
function covered(of: readonly string[], within: readonly string[]): number {
  if (of.length === 0) return 0;
  return of.filter((w) => within.some((x) => sameWord(w, x))).length / of.length;
}

/** A recorded question is the same question when each covers most of the other's words. */
const SAME_QUESTION = 0.8;

/**
 * The answer a question already has, or undefined (PM-P2-6). A decision
 * settles it when its question is the same question; a brief line or a
 * playbook rule settles it when it states the question and then names
 * exactly one of its answers — "Who takes the money? Invoices only." A line
 * marked as an assumption ("*Assumed:*", "Not stated") records a default,
 * not an answer, and settles nothing.
 */
export function settledAnswerFor(
  q: { question: string; options: readonly string[] },
  sources: readonly SettledSource[],
): SettledAnswer | undefined {
  const qWords = contentWords(q.question);
  if (qWords.length === 0) return undefined;
  for (const s of sources) {
    if (s.kind === "decision") {
      const recorded = contentWords(s.question ?? s.text);
      if (
        s.answer &&
        covered(qWords, recorded) >= SAME_QUESTION &&
        covered(recorded, qWords) >= SAME_QUESTION
      ) {
        return { question: q.question, answer: s.answer, source: s.kind, ref: s.ref };
      }
      continue;
    }
    for (const line of s.text.split(/\n/)) {
      if (/\*assumed:?\*|\bnot stated\b|\bassumed\b/i.test(line)) continue;
      const at = line.lastIndexOf("?");
      if (at < 0) continue;
      if (covered(qWords, contentWords(line.slice(0, at))) < SAME_QUESTION) continue;
      const rest = contentWords(line.slice(at + 1));
      const named = q.options
        .map((label) => ({ label, words: contentWords(label) }))
        .filter((o) => o.words.length > 0 && covered(o.words, rest) === 1)
        .sort((a, b) => b.words.length - a.words.length);
      const best = named[0];
      if (!best || named[1]?.words.length === best.words.length) continue;
      return { question: q.question, answer: best.label, source: s.kind, ref: s.ref };
    }
  }
  return undefined;
}

/** The brief as a source of recorded answers (PM-P2-6). */
export function briefSources(text: string, ref = ".sekhemet/brief.md"): SettledSource[] {
  return text.trim() ? [{ kind: "brief", ref, text }] : [];
}

/** Approved playbook rules as sources of recorded answers (PM-P2-6). */
export function playbookSources(rules: readonly { id: string; text: string }[]): SettledSource[] {
  return rules.map((r) => ({ kind: "playbook" as const, ref: r.id, text: r.text }));
}

/** How a settled answer's source is named in the assumption it becomes. */
export function settledBasis(s: Pick<SettledAnswer, "source" | "ref">): string {
  const named: Record<SettledSourceKind, string> = {
    decision: `decision ${s.ref}`,
    brief: `the brief (${s.ref})`,
    playbook: `playbook rule ${s.ref}`,
  };
  return `Settled by ${named[s.source]}`;
}

/**
 * The design stage's questions less those already answered (PM-P2-6): the
 * ones still to ask, and the settled ones with their answers and sources.
 */
export function settleDesignQuestions<T extends DesignQuestion>(
  questions: readonly T[],
  sources: readonly SettledSource[],
): { ask: T[]; settled: SettledAnswer[] } {
  const ask: T[] = [];
  const settled: SettledAnswer[] = [];
  for (const q of questions) {
    const s = settledAnswerFor(
      { question: q.question, options: q.answers.map((a) => a.answer) },
      sources,
    );
    if (s) settled.push(s);
    else ask.push(q);
  }
  return { ask, settled };
}
