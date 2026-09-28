import { randomUUID } from "node:crypto";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import { SESHAT_SKILL_VERSION } from "./seshat_skill.js";
import {
  type Cycle,
  PM_EVENTS,
  type PmCite,
  type PmContext,
  type PmMessage,
  type PmProposal,
  type PmProposalState,
  type PmStatus,
} from "./types.js";
import { voiceGuard } from "./voice.js";

interface MessagePayload {
  id: string;
  text: string;
  context?: PmContext;
  createdAt: string;
}

interface ReplyPayload {
  id: string;
  replyTo: string[];
  text: string;
  proposals?: PmProposal[];
  cites?: PmCite[];
  error?: boolean;
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

const THREAD_TYPES = [
  PM_EVENTS.message,
  PM_EVENTS.reply,
  PM_EVENTS.proposalState,
  PM_EVENTS.status,
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
  ): Promise<PmMessage> {
    const payload: MessagePayload = {
      id: `pmm_${randomUUID().slice(0, 12)}`,
      text,
      createdAt: new Date().toISOString(),
      ...(context && (context.cardId || context.view) ? { context } : {}),
    };
    const event = await this.log.append({
      actor,
      type: PM_EVENTS.message,
      payload,
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
    };
  }

  public async appendReply(input: {
    replyTo: string[];
    text: string;
    proposals?: Omit<PmProposal, "id" | "state">[];
    cites?: PmCite[];
    error?: boolean;
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
            proposals: p.proposals.map((pr) => ({ ...pr, state: states.get(pr.id) ?? pr.state })),
          }
        : {}),
      ...(p.cites ? { cites: p.cites } : {}),
      ...(p.to ? { principal: p.to } : {}),
      ...(p.skillVersion ? { skillVersion: p.skillVersion } : {}),
      // Who wrote it: the Planning model, the ledger or the notifier (PM-N9-6).
      ...(p.model ? { model: p.model } : {}),
    };
  }

  /** The whole conversation, oldest first, with each message's live state. */
  public async thread(since = 0): Promise<PmMessage[]> {
    const events = await this.events();
    const states = new Map<string, PmProposalState>();
    const answered = new Set<string>();
    for (const e of events) {
      if (e.type === PM_EVENTS.proposalState) {
        const p = e.payload as ProposalStatePayload;
        states.set(p.proposalId, p.state);
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
        const state = answered.has(p.id)
          ? "done"
          : status.phase === "thinking"
            ? "thinking"
            : "queued";
        out.push({
          id: p.id,
          seq: e.seq,
          role: "user",
          text: p.text,
          createdAt: p.createdAt,
          state,
          ...(p.context ? { context: p.context } : {}),
          ...(e.principal ? { principal: e.principal } : {}),
        });
      } else if (e.type === PM_EVENTS.reply) {
        out.push(this.replyToMessage(e.payload as ReplyPayload, e.seq, states));
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
