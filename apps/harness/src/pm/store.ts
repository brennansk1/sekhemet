import { randomUUID } from "node:crypto";
import { ERASED_MARKER, type EventLog, type EventRecord } from "@sekhemet/kernel";
import { SESHAT_SKILL_VERSION } from "./seshat_skill.js";
import {
  type Cycle,
  PM_EVENTS,
  type PmCite,
  type PmContext,
  type PmDocumentRef,
  type PmMessage,
  type PmPlanApproval,
  type PmProposal,
  type PmProposalState,
  type PmStatus,
} from "./types.js";
import { voiceGuard } from "./voice.js";

interface MessagePayload {
  id: string;
  /** Only on messages written before the text moved to the private part. */
  text?: string;
  context?: PmContext;
  createdAt: string;
  /** PM-N10-2: the documents it carries, without their names (private) or text. */
  documents?: Omit<PmDocumentRef, "name">[];
}

/** A document to record with a message: its reference and, unless it is the message's own text, its text. */
export interface MessageDocument {
  ref: PmDocumentRef;
  /** Absent for the message's own text (`ref.fromMessage`). */
  text?: string;
}

/** An attached document with its text, as Seshat reads it (PM-N10-3). */
export interface AttachedDocumentText extends PmDocumentRef {
  messageId: string;
  /** Undefined when a person erased it (the gap is named, never filled). */
  text?: string;
}

type DocumentTexts = Record<string, { name: string; text?: string }>;

/** A message event's documents, their names from the private part (or the erasure marker). */
function documentsOf(e: EventRecord): PmDocumentRef[] | undefined {
  const refs = (e.payload as MessagePayload).documents;
  if (!refs?.length) return undefined;
  const texts = e.private?.documentTexts;
  const named = texts && typeof texts === "object" ? (texts as DocumentTexts) : {};
  return refs.map((r) => ({ ...r, name: named[r.id]?.name ?? ERASED_MARKER }));
}

interface ReplyPayload {
  id: string;
  replyTo: string[];
  text: string;
  proposals?: PmProposal[];
  cites?: PmCite[];
  error?: boolean;
  /** Why a reply could not be given (PM-01): a cause, never the exception's text. */
  cause?: "no_model" | "timeout" | "other";
  createdAt: string;
  model?: string;
  /** Who it answers (Team setup, PM-N9-8); a broadcast has none. */
  to?: string;
  /**
   * The senior-PM skill's version in force when the reply was written
   * (PM-P6-4): on every reply, a model's or the ledger's, so a change to the
   * skill file shows in the thread's record from the next reply on.
   */
  skillVersion: string;
}

interface ProposalStatePayload {
  proposalId: string;
  state: PmProposalState;
  cardIds?: string[];
}

interface PlanSentPayload {
  proposalId: string;
  approver: string;
  choices?: Record<string, unknown>;
}

interface PlanApprovedPayload {
  proposalId: string;
  projectId?: string;
}

interface PlanCommentedPayload {
  proposalId: string;
  id: string;
}

const THREAD_TYPES = [
  PM_EVENTS.message,
  PM_EVENTS.reply,
  PM_EVENTS.proposalState,
  PM_EVENTS.status,
  PM_EVENTS.planSent,
  PM_EVENTS.planApproved,
  PM_EVENTS.planCommented,
];

/**
 * The PM conversation, its proposals and the cycles, all derived from the
 * ledger.
 *
 * Nothing here has its own table: the hash chain is the record, so a replayed
 * or copied `events.db` carries the conversation with it, and a tampered
 * message breaks the chain like any other event.
 */
export class PmStore {
  constructor(public readonly log: EventLog) {}

  private async events(types: string[] = THREAD_TYPES): Promise<EventRecord[]> {
    return this.log.getEventsByTypes(types);
  }

  /** `actor` is "human" for the lead; the Worker's questions use "executor". */
  public async appendUserMessage(
    text: string,
    context?: PmContext,
    actor = "human",
    documents: MessageDocument[] = [],
  ): Promise<PmMessage> {
    // The text is free text (an `@Seshat` comment's body among them): the
    // event's erasable private part, never the hashed payload (teams §3).
    // So are an attached document's name and text (PM-N10-2).
    const payload: MessagePayload = {
      id: `pmm_${randomUUID().slice(0, 12)}`,
      createdAt: new Date().toISOString(),
      ...(context && (context.cardId || context.view) ? { context } : {}),
      ...(documents.length
        ? { documents: documents.map(({ ref: { name: _name, ...rest } }) => rest) }
        : {}),
    };
    const documentTexts: DocumentTexts = Object.fromEntries(
      documents.map((d) => [
        d.ref.id,
        { name: d.ref.name, ...(d.text !== undefined ? { text: d.text } : {}) },
      ]),
    );
    const event = await this.log.append({
      actor,
      type: PM_EVENTS.message,
      payload,
      private: { text, ...(documents.length ? { documentTexts } : {}) },
      ...(context?.cardId ? { cardId: context.cardId } : {}),
    });
    return {
      id: payload.id,
      seq: event.seq,
      role: "user",
      text,
      createdAt: payload.createdAt,
      state: "queued",
      ...(payload.context ? { context: payload.context } : {}),
      ...(documents.length ? { documents: documents.map((d) => d.ref) } : {}),
    };
  }

  /**
   * The documents these messages carry, with their text (PM-N10-3): the
   * message's own text for a document made of it. Oldest message first.
   */
  public async attachedDocuments(messageIds: readonly string[]): Promise<AttachedDocumentText[]> {
    const wanted = new Set(messageIds);
    const out: AttachedDocumentText[] = [];
    for (const e of await this.events([PM_EVENTS.message])) {
      const p = e.payload as MessagePayload;
      if (!wanted.has(p.id)) continue;
      const texts = e.private?.documentTexts;
      const named = texts && typeof texts === "object" ? (texts as DocumentTexts) : {};
      for (const ref of documentsOf(e) ?? []) {
        const raw = ref.fromMessage ? messageText(e) : named[ref.id]?.text;
        const text = raw === undefined || raw === ERASED_MARKER ? undefined : raw;
        out.push({ ...ref, messageId: p.id, ...(text !== undefined ? { text } : {}) });
      }
    }
    return out;
  }

  /** The notes of Seshat's last reading of a document in parts, if it read one (PM-N10-3). */
  public async documentNotes(
    documentId: string,
  ): Promise<{ parts: number; notes: string; condensed?: number } | undefined> {
    const read = (await this.events([PM_EVENTS.documentRead]))
      .filter((e) => (e.payload as { document?: string }).document === documentId)
      .at(-1);
    const notes = read?.private?.notes;
    if (!read || typeof notes !== "string" || notes === ERASED_MARKER) return undefined;
    const p = read.payload as { parts: number; condensed?: number };
    return { parts: p.parts, notes, ...(p.condensed ? { condensed: p.condensed } : {}) };
  }

  /** Record that Seshat read a document in parts, with its notes (private). */
  public async recordDocumentRead(input: {
    messageId: string;
    documentId: string;
    parts: number;
    windowTokens: number;
    notes: string;
    /** Rounds of notes on the notes needed for them to fit (PM-N10-3). */
    condensed?: number;
  }): Promise<void> {
    await this.log.append({
      actor: "planner",
      type: PM_EVENTS.documentRead,
      payload: {
        message: input.messageId,
        document: input.documentId,
        parts: input.parts,
        windowTokens: input.windowTokens,
        ...(input.condensed ? { condensed: input.condensed } : {}),
      },
      private: { notes: input.notes },
    });
  }

  public async appendReply(input: {
    replyTo: string[];
    text: string;
    proposals?: Omit<PmProposal, "id" | "state">[];
    cites?: PmCite[];
    error?: boolean;
    cause?: "no_model" | "timeout" | "other";
    model?: string;
    /** The person it answers (Team setup, PM-N9-8). */
    to?: string;
  }): Promise<PmMessage> {
    // PM-N9-4: Seshat's voice is enforced where every reply is written —
    // every model string a person reads, not only the assembled summary.
    const proposals: PmProposal[] = (input.proposals ?? []).map((p) => ({
      ...p,
      summary: voiceGuard(p.summary),
      ...(p.why !== undefined ? { why: voiceGuard(p.why) } : {}),
      id: `pmp_${randomUUID().slice(0, 12)}`,
      state: "open",
    }));
    const payload: ReplyPayload = {
      id: `pmr_${randomUUID().slice(0, 12)}`,
      replyTo: input.replyTo,
      text: voiceGuard(input.text),
      createdAt: new Date().toISOString(),
      ...(proposals.length > 0 ? { proposals } : {}),
      ...(input.cites && input.cites.length > 0 ? { cites: input.cites } : {}),
      ...(input.error ? { error: true } : {}),
      ...(input.error && input.cause ? { cause: input.cause } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.to ? { to: input.to } : {}),
      skillVersion: SESHAT_SKILL_VERSION,
    };
    const event = await this.log.append({ actor: "planner", type: PM_EVENTS.reply, payload });
    return this.replyToMessage(payload, event.seq, new Map());
  }

  public async setStatus(status: PmStatus): Promise<void> {
    await this.log.append({
      actor: "harness",
      type: PM_EVENTS.status,
      payload: { ...status, since: status.since ?? new Date().toISOString() },
    });
  }

  public async status(): Promise<PmStatus> {
    const events = await this.events([PM_EVENTS.status]);
    const last = events.at(-1)?.payload as PmStatus | undefined;
    return last ?? { phase: "idle" };
  }

  public async setProposalState(
    proposalId: string,
    state: PmProposalState,
    cardIds?: string[],
  ): Promise<void> {
    const payload: ProposalStatePayload = {
      proposalId,
      state,
      ...(cardIds ? { cardIds } : {}),
    };
    await this.log.append({
      actor: "human",
      type: PM_EVENTS.proposalState,
      payload,
    });
  }

  private replyToMessage(
    p: ReplyPayload,
    seq: number,
    states: Map<string, PmProposalState>,
    approvals: Map<string, PmPlanApproval> = new Map(),
  ): PmMessage {
    return {
      id: p.id,
      seq,
      role: "pm",
      text: p.text,
      createdAt: p.createdAt,
      state: p.error ? "error" : "done",
      ...(p.proposals
        ? {
            proposals: p.proposals.map((pr) => {
              const approval = approvals.get(pr.id);
              return {
                ...pr,
                state: states.get(pr.id) ?? pr.state,
                ...(approval ? { approval } : {}),
              };
            }),
          }
        : {}),
      ...(p.cites ? { cites: p.cites } : {}),
      ...(p.to ? { principal: p.to } : {}),
      ...(p.skillVersion ? { skillVersion: p.skillVersion } : {}),
      // Who wrote it: the Planning model, the ledger or the notifier (PM-N9-6).
      ...(p.model ? { model: p.model } : {}),
      // PM-01: a reply Seshat could not give says why, and what Retry sends again.
      ...(p.error ? { replyTo: p.replyTo, ...(p.cause ? { cause: p.cause } : {}) } : {}),
    };
  }

  /** The whole conversation, oldest first, with each message's live state. */
  public async thread(since = 0): Promise<PmMessage[]> {
    const events = await this.events();
    const states = new Map<string, PmProposalState>();
    const approvals = new Map<string, PmPlanApproval>();
    const answered = new Set<string>();
    for (const e of events) {
      if (e.type === PM_EVENTS.proposalState) {
        const p = e.payload as ProposalStatePayload;
        states.set(p.proposalId, p.state);
      } else if (e.type === PM_EVENTS.planSent) {
        // TEAM-20: the first send stands; the route refuses a second.
        const p = e.payload as PlanSentPayload;
        if (!approvals.has(p.proposalId)) {
          approvals.set(p.proposalId, {
            state: "sent",
            approver: p.approver,
            requestedBy: e.principal ?? "",
            ...(p.choices ? { choices: p.choices } : {}),
          });
        }
      } else if (e.type === PM_EVENTS.planApproved) {
        const p = e.payload as PlanApprovedPayload;
        const was = approvals.get(p.proposalId);
        if (was) {
          approvals.set(p.proposalId, {
            ...was,
            state: "approved",
            ...(e.principal ? { approvedBy: e.principal } : {}),
          });
        }
      } else if (e.type === PM_EVENTS.planCommented) {
        // Design-stage §2.9 item 7: a message in the sent plan's thread, by a person.
        const p = e.payload as PlanCommentedPayload;
        const was = approvals.get(p.proposalId);
        if (was && e.principal) {
          const message = { id: p.id, by: e.principal, text: messageText(e), at: e.createdAt };
          approvals.set(p.proposalId, { ...was, thread: [...(was.thread ?? []), message] });
        }
      } else if (e.type === PM_EVENTS.reply) {
        for (const id of (e.payload as ReplyPayload).replyTo) answered.add(id);
      }
    }
    const status = (events.filter((e) => e.type === PM_EVENTS.status).at(-1)?.payload ?? {
      phase: "idle",
    }) as PmStatus;

    const out: PmMessage[] = [];
    for (const e of events) {
      if (e.seq <= since) continue;
      if (e.type === PM_EVENTS.message) {
        const p = e.payload as MessagePayload;
        const text = messageText(e);
        const state = answered.has(p.id)
          ? "done"
          : status.phase === "thinking"
            ? "thinking"
            : "queued";
        const documents = documentsOf(e);
        out.push({
          id: p.id,
          seq: e.seq,
          role: "user",
          text,
          createdAt: p.createdAt,
          state,
          ...(p.context ? { context: p.context } : {}),
          ...(documents ? { documents } : {}),
          ...(e.principal ? { principal: e.principal } : {}),
        });
      } else if (e.type === PM_EVENTS.reply) {
        out.push(this.replyToMessage(e.payload as ReplyPayload, e.seq, states, approvals));
      }
    }
    return out;
  }

  /** User messages no reply has answered yet, oldest first. */
  public async queued(): Promise<PmMessage[]> {
    return (await this.thread()).filter((m) => m.role === "user" && m.state !== "done");
  }

  /** The open proposal that is a suggestion on an issue (PM-N9-1), if Seshat made one. */
  public async proposalForSuggestion(suggestionId: string): Promise<PmProposal | undefined> {
    for (const m of await this.thread()) {
      const hit = m.proposals?.find((p) => p.suggestionId === suggestionId && p.state === "open");
      if (hit) return hit;
    }
    return undefined;
  }

  public async proposal(id: string): Promise<PmProposal | undefined> {
    for (const m of await this.thread()) {
      const hit = m.proposals?.find((p) => p.id === id);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Who a proposal's reply answered (PM-N9-8): the person whose conversation it is. */
  public async askerOf(proposalId: string): Promise<string | undefined> {
    for (const m of await this.thread()) {
      if (m.role === "pm" && m.proposals?.some((p) => p.id === proposalId)) return m.principal;
    }
    return undefined;
  }

  /**
   * A Stakeholder's plan sent to a named Member or Admin (teams TEAM-20,
   * `plan/sent_for_approval`); the sender is the event's principal, and
   * nothing is created.
   */
  public async sendForApproval(
    proposalId: string,
    approver: string,
    choices?: Record<string, unknown>,
  ): Promise<void> {
    const payload: PlanSentPayload = { proposalId, approver, ...(choices ? { choices } : {}) };
    await this.log.append({ actor: "human", type: PM_EVENTS.planSent, payload });
  }

  /**
   * A message in a sent plan's thread (design-stage §2.9 item 7): the words
   * private, the plan and the message's id structural; the person writing
   * it is the event's principal.
   */
  public async commentOnPlan(proposalId: string, text: string): Promise<string> {
    const id = `pcm_${randomUUID().slice(0, 12).replace(/-/g, "")}`;
    const payload: PlanCommentedPayload = { proposalId, id };
    await this.log.append({
      actor: "human",
      type: PM_EVENTS.planCommented,
      payload,
      private: { text },
    });
    return id;
  }

  /** The approver approved the plan and it created `projectId` (TEAM-20, TEAM-42). */
  public async recordPlanApproved(proposalId: string, projectId?: string): Promise<void> {
    const payload: PlanApprovedPayload = { proposalId, ...(projectId ? { projectId } : {}) };
    await this.log.append({ actor: "human", type: PM_EVENTS.planApproved, payload });
  }

  // --- Conversation summary (hybrid compaction) --------------------------------

  /** The latest rolling summary of the conversation, if one was written. */
  public async summary(): Promise<{ upToSeq: number; text: string } | undefined> {
    const last = (await this.events([PM_EVENTS.summary])).at(-1);
    return last?.payload as { upToSeq: number; text: string } | undefined;
  }

  public async appendSummary(upToSeq: number, text: string): Promise<void> {
    await this.log.append({
      actor: "planner",
      type: PM_EVENTS.summary,
      payload: { upToSeq, text },
    });
  }

  // --- Cycles ----------------------------------------------------------------

  public async cycles(): Promise<Cycle[]> {
    const byId = new Map<string, Cycle>();
    for (const e of await this.events([PM_EVENTS.cycleCreated, PM_EVENTS.cycleUpdated])) {
      const p = e.payload as Partial<Cycle> & { id: string };
      const current = byId.get(p.id);
      byId.set(p.id, { ...(current ?? ({} as Cycle)), ...p } as Cycle);
    }
    return [...byId.values()].sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  }

  public async createCycle(
    input: Omit<Cycle, "id" | "state"> & { state?: Cycle["state"] },
    actor = "human",
  ): Promise<Cycle> {
    const cycle: Cycle = {
      id: `cycle_${randomUUID().slice(0, 8)}`,
      name: input.name,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      state: input.state ?? "planned",
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    };
    await this.log.append({ actor, type: PM_EVENTS.cycleCreated, payload: cycle });
    return cycle;
  }

  public async updateCycle(
    id: string,
    patch: Partial<Omit<Cycle, "id">>,
    actor = "human",
  ): Promise<Cycle | undefined> {
    const existing = (await this.cycles()).find((c) => c.id === id);
    if (!existing) return undefined;
    await this.log.append({ actor, type: PM_EVENTS.cycleUpdated, payload: { ...patch, id } });
    return { ...existing, ...patch };
  }
}

/**
 * A `pm/message`'s text: the private part's (erased, it reads as the erased
 * marker), or the payload's on a message written before it moved there.
 */
export function messageText(e: { payload: unknown; private?: Record<string, unknown> }): string {
  const own = e.private?.text;
  if (typeof own === "string") return own;
  const old = (e.payload as { text?: unknown } | null)?.text;
  return typeof old === "string" ? old : "";
}
