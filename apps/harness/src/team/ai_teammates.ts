import { randomUUID } from "node:crypto";
import type { CardRecord, CardStore, EventLog, EventRecord } from "@sekhemet/kernel";
import {
  type AiStateFacts,
  type AiWho,
  aiMentions,
  personMentions,
  stopReasonLabel,
} from "@sekhemet/ui";
import { postCardMessage } from "../collaborate.js";
import { type Audience, nameFor } from "../pm/audience.js";
import { PM_EVENTS } from "../pm/types.js";
import type { Access, Decision, Level } from "./access.js";
import { capNote, personOf } from "./fair_queue.js";

/**
 * The AI teammates on an issue (teams NEW-teams-5, items 17–19 and 19a;
 * kernel NEW-kernel-10; DEC-36).
 *
 * People reach Seshat and the Agent the way they reach a colleague: by
 * delegating the issue to the Agent, or by writing `@Agent` or `@Seshat` in
 * a comment. The harness — never the model — sets the AI's state at once
 * (TEAM-15): a Member's `@Agent` delegates the issue (its events then carry
 * that Member as `on_behalf_of`, K-N10-1), or reaches the running Agent's
 * next step; a Stakeholder's or Viewer's becomes a request in the owner's —
 * or the lead's — *Needs you*, and the Agent starts only when a Member
 * presses *Start*, on that Member's behalf (TEAM-39); `@Seshat` puts the
 * question in Seshat's queue, answered by the person's own level, so a
 * Viewer gets answers and no proposals (TEAM-40). The Agent never runs for
 * a person who could not start it (TEAM-16, `agentRefusal`).
 */

export const COMMENT_EVENT = "issue/commented";
export const START_REQUESTED = "agent/start_requested";
export const START_ANSWERED = "agent/start_answered";
/** TEAM-22: the author's answer about the people a comment held back (teams §3). */
export const MENTION_ANSWERED = "issue/mention_answered";

export interface IssueComment {
  id: string;
  seq: number;
  cardId: string;
  /** A person's comment names them; Seshat's answer is `seshat`. */
  by: "person" | "seshat";
  principal?: string;
  name: string;
  text: string;
  postedAt: string;
  ai: AiWho[];
  /**
   * TEAM-22, to its author only: the people it mentions who cannot see the
   * project, while the author has not answered whether to invite them.
   */
  invite?: { people: string[]; project?: string };
}

export interface StartRequest {
  id: string;
  cardId: string;
  title: string;
  requestedBy: string;
  requestedByName: string;
  /** Whom it waits on; none: the workspace's Admins. */
  to?: string;
  toName: string;
  ask: string;
  requestedAt: string;
}

export interface AiTeammatesDeps {
  cardStore: CardStore;
  log: EventLog;
  access: Access;
  audience: Audience;
  /** The card's project: its own, or the workspace's only project. */
  projectOf: (card: CardRecord) => string | undefined;
  /** Put the person's question in Seshat's queue; its message id. */
  askSeshat?: (text: string, cardId: string) => Promise<string>;
  /** Each Ready issue's place and estimate (teams item 31). */
  standing?: () => Promise<
    {
      cardId: string;
      message: string;
      person?: string;
      /** Its place in the fair order, 1 first. */
      place?: number;
      /** At the per-person cap (TEAM-30): said with the place, so the wait has its reason. */
      capped?: { cap: number; running: number };
    }[]
  >;
  /**
   * The workspace's people by name (teams item 23): whom an `@Name` in a
   * comment can mention. Solo has none: its one person mentions no one.
   */
  people?: () => { principal: string; name: string }[];
}

export class AiTeammateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const priv = (e: EventRecord): Record<string, unknown> =>
  ((e as EventRecord & { private?: Record<string, unknown> }).private ?? {}) as Record<
    string,
    unknown
  >;

async function requireCard(store: CardStore, cardId: string): Promise<CardRecord> {
  const card = await store.getCard(cardId);
  if (!card) throw new AiTeammateError(`No issue ${cardId}`, 404);
  return card;
}

/**
 * Whom a Stakeholder's or Viewer's `@Agent` waits on (item 19a): the
 * issue's owner when they can start the Agent, else the project lead when
 * they can; none — the workspace's Admins — otherwise.
 */
function askTo(deps: AiTeammatesDeps, card: CardRecord): string | undefined {
  const project = deps.projectOf(card);
  const can = (p: string | undefined): p is string =>
    p !== undefined && deps.access.can(p, "agent.start", project);
  if (can(card.owner)) return card.owner;
  const lead = project ? deps.access.settings(project).lead : undefined;
  return can(lead) ? lead : undefined;
}

/**
 * A comment on an issue (TEAM-15, -39, -40). The route has checked
 * `comment`; `ceiling` is the scope of the personal token it came with.
 * Returns the comment and the AI teammates' state as the harness set it.
 */
export async function postComment(
  deps: AiTeammatesDeps,
  input: { cardId: string; principal: string; text: string; ceiling?: Level },
): Promise<{
  comment: IssueComment;
  ai: AiStateFacts[];
  request?: StartRequest;
  /** TEAM-22: people it mentions who cannot see the project; the author is asked whether to invite them. */
  invite?: { commentId: string; people: string[]; project?: string };
}> {
  const text = input.text.trim();
  if (!text) throw new AiTeammateError("A comment needs text", 400);
  const card = await requireCard(deps.cardStore, input.cardId);
  const project = deps.projectOf(card);
  const mentions = aiMentions(text);
  // Teams item 23: `@Name` mentions a person; one who cannot see the
  // project is held until the author answers (TEAM-22). The author is not
  // mentioned by their own comment.
  const named = personMentions(text, deps.people?.() ?? []).filter((p) => p !== input.principal);
  const people = named.filter((p) => deps.audience.canSee(p, project));
  const held = named.filter((p) => !deps.audience.canSee(p, project));
  // Seshat's question first, so the comment can name it (its state reads from it).
  const seshatMessage =
    mentions.includes("seshat") && deps.askSeshat ? await deps.askSeshat(text, card.id) : undefined;
  const id = `cmt_${randomUUID().slice(0, 12)}`;
  await deps.cardStore.recordEvent({
    type: COMMENT_EVENT,
    cardId: card.id,
    actor: "human",
    principal: input.principal,
    payload: {
      id,
      cardId: card.id,
      ...(mentions.length ? { ai: mentions } : {}),
      ...(seshatMessage ? { seshatMessage } : {}),
      ...(people.length ? { people } : {}),
      ...(held.length ? { held } : {}),
    },
    private: { text },
  });
  let request: StartRequest | undefined;
  if (mentions.includes("agent")) {
    const decision: Decision = deps.access.decide(
      input.principal,
      "agent.start",
      project,
      undefined,
      input.ceiling,
    );
    if (decision.allowed) {
      const running = card.status === "in_progress" && card.delegate?.kind === "worker";
      if (running) {
        // WL-N10-1: the running Agent reads it at its next step.
        await postCardMessage(deps.cardStore, card.id, text, input.principal);
      } else if (
        card.delegate?.kind !== "worker" ||
        deps.cardStore.delegatorOf(card.id) !== input.principal
      ) {
        // K-N10-1: the Agent's events now carry this person as on_behalf_of.
        await deps.cardStore.delegateCard(card.id, { kind: "worker" }, input.principal);
      }
    } else if (decision.level !== undefined) {
      const to = askTo(deps, card);
      const rid = `asr_${randomUUID().slice(0, 12)}`;
      await deps.cardStore.recordEvent({
        type: START_REQUESTED,
        cardId: card.id,
        actor: "human",
        principal: input.principal,
        payload: {
          id: rid,
          cardId: card.id,
          requested_by: input.principal,
          ...(to ? { to } : {}),
          comment: id,
        },
        private: { ask: text },
      });
      request = (await startRequests(deps, { cardId: card.id })).find((r) => r.id === rid);
    }
  }
  const comment = (await issueComments(deps, card.id, input.principal)).find((c) => c.id === id);
  if (!comment) throw new AiTeammateError("The comment was not recorded", 500);
  const projectName = project ? deps.cardStore.getProject(project)?.name : undefined;
  return {
    comment,
    ai: await aiStates(deps, card.id, input.principal),
    ...(request ? { request } : {}),
    ...(held.length
      ? {
          invite: {
            commentId: id,
            people: held.map((p) => nameFor(deps.audience, p, input.principal)),
            ...(projectName ? { project: projectName } : {}),
          },
        }
      : {}),
  };
}

/**
 * An issue's comments, oldest first, with Seshat's answers to the reader's
 * own questions (PM-N9-8: a person reads their own part of Seshat's thread;
 * Seshat answered from what they can see).
 */
export async function issueComments(
  deps: AiTeammatesDeps,
  cardId: string,
  reader: string,
): Promise<IssueComment[]> {
  const events = await deps.cardStore.cardEvents(cardId, [COMMENT_EVENT, MENTION_ANSWERED]);
  const answered = new Set(
    events
      .filter((e) => e.type === MENTION_ANSWERED)
      .map((e) => String((e.payload as { id?: string }).id)),
  );
  const replies = await seshatReplies(deps.log);
  const team = deps.audience.setup === "team";
  const card = await deps.cardStore.getCard(cardId);
  const projectId = card ? deps.projectOf(card) : undefined;
  const projectName = projectId ? deps.cardStore.getProject(projectId)?.name : undefined;
  const out: IssueComment[] = [];
  for (const e of events) {
    if (e.type !== COMMENT_EVENT) continue;
    const p = e.payload as { id: string; ai?: AiWho[]; seshatMessage?: string; held?: string[] };
    const asks =
      p.held?.length && e.principal === reader && !answered.has(p.id)
        ? {
            invite: {
              people: p.held.map((h) => nameFor(deps.audience, h, reader)),
              ...(projectName ? { project: projectName } : {}),
            },
          }
        : {};
    out.push({
      id: p.id,
      seq: e.seq,
      cardId,
      by: "person",
      ...(e.principal ? { principal: e.principal } : {}),
      // Activity starts a row with the name: the reader is "You", as elsewhere on the page.
      name:
        e.principal && e.principal === reader
          ? "You"
          : nameFor(deps.audience, e.principal ?? undefined, reader),
      text: String(priv(e).text ?? ""),
      postedAt: e.createdAt,
      ai: p.ai ?? [],
      ...asks,
    });
    const reply = p.seshatMessage ? replies.get(p.seshatMessage) : undefined;
    const theirs = !team || e.principal === reader;
    if (reply && theirs) {
      out.push({
        id: reply.id,
        seq: reply.seq,
        cardId,
        by: "seshat",
        name: "Seshat",
        text: reply.text,
        postedAt: reply.createdAt,
        ai: [],
      });
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** Every start request still waiting, optionally on one issue (TEAM-39). */
export async function startRequests(
  deps: Pick<AiTeammatesDeps, "cardStore" | "log" | "audience"> & {
    projectOf?: AiTeammatesDeps["projectOf"];
  },
  filter: { cardId?: string; for?: string } = {},
): Promise<StartRequest[]> {
  const projectOf = deps.projectOf ?? ((c: CardRecord) => c.projectId ?? undefined);
  const events = await deps.log.getEventsByTypes([START_REQUESTED, START_ANSWERED]);
  const answered = new Set(
    events
      .filter((e) => e.type === START_ANSWERED)
      .map((e) => String((e.payload as { id: string }).id)),
  );
  const out: StartRequest[] = [];
  for (const e of events) {
    if (e.type !== START_REQUESTED) continue;
    const p = e.payload as { id: string; cardId: string; requested_by: string; to?: string };
    if (answered.has(p.id)) continue;
    if (filter.cardId && p.cardId !== filter.cardId) continue;
    const card = await deps.cardStore.getCard(p.cardId);
    if (!card) continue;
    if (filter.for !== undefined) {
      const mine = p.to
        ? p.to === filter.for
        : deps.audience.levelOf(filter.for, projectOf(card)) === "admin";
      if (!mine) continue;
    }
    out.push({
      id: p.id,
      cardId: p.cardId,
      title: card.title,
      requestedBy: p.requested_by,
      requestedByName: nameFor(deps.audience, p.requested_by, filter.for),
      ...(p.to ? { to: p.to } : {}),
      toName: p.to ? nameFor(deps.audience, p.to, filter.for) : "an Admin",
      ask: String(priv(e).ask ?? ""),
      requestedAt: e.createdAt,
    });
  }
  return out;
}

/**
 * A Member answers a start request (TEAM-39): *Start* delegates the issue to
 * the Agent on that Member's behalf (the route checked `agent.start` at the
 * issue's project); *Decline* closes it. Either is recorded once.
 */
export async function answerStartRequest(
  deps: AiTeammatesDeps,
  input: { cardId: string; requestId: string; principal: string; answer: "started" | "declined" },
): Promise<{ ai: AiStateFacts[] }> {
  const card = await requireCard(deps.cardStore, input.cardId);
  const pending = (await startRequests(deps, { cardId: card.id })).find(
    (r) => r.id === input.requestId,
  );
  if (!pending) throw new AiTeammateError("That request was already answered", 409);
  if (input.answer === "started") {
    await deps.cardStore.delegateCard(card.id, { kind: "worker" }, input.principal);
  }
  await deps.cardStore.recordEvent({
    type: START_ANSWERED,
    cardId: card.id,
    actor: "human",
    principal: input.principal,
    payload: { id: input.requestId, answer: input.answer },
  });
  return { ai: await aiStates(deps, card.id, input.principal) };
}

/**
 * The AI teammates' state on an issue, as the harness knows it (item 19):
 * the Agent's from the issue, its start request, its questions and its
 * place in the queue; Seshat's from the latest question put to it here.
 */
export async function aiStates(
  deps: AiTeammatesDeps,
  cardId: string,
  reader: string,
): Promise<AiStateFacts[]> {
  const card = await deps.cardStore.getCard(cardId);
  if (!card) return [];
  const out: AiStateFacts[] = [];
  const request = (await startRequests(deps, { cardId })).at(-1);
  const agent = await agentFacts(deps, card, reader, request);
  if (agent) out.push(agent);
  const seshat = await seshatState(deps, cardId);
  if (seshat) out.push(seshat);
  return out;
}

/** The Agent's state on one issue: a start request waiting, else its work; none when it is not on it. */
async function agentFacts(
  deps: AiTeammatesDeps,
  card: CardRecord,
  reader: string,
  request: StartRequest | undefined,
): Promise<AiStateFacts | undefined> {
  const name = (p: string | undefined) => (p ? nameFor(deps.audience, p, reader) : "an Admin");
  if (request) {
    return {
      who: "agent",
      state: "needs you",
      waitingFor: "start",
      requestedBy: name(request.requestedBy),
      waitsOn: name(request.to),
    };
  }
  return card.delegate?.kind === "worker" ? agentState(deps, card, name) : undefined;
}

/** Each issue's Agent state for the board, and where the reader's own issue stands (teams items 19, 31). */
export interface AgentStatesView {
  states: { cardId: string; ai: AiStateFacts[] }[];
  /**
   * The reader's first waiting Agent issue, in the Team setup: its place and
   * estimate, and — when it is next while another person's issue runs — whose
   * (*Priya's issue is running; yours starts next*). Null when none waits.
   */
  queue: { cardId: string; place: number; message: string; runningFor?: string } | null;
}

/**
 * The Agent's state on every issue it is on that the reader can see — a
 * start request waiting, or delegated to it and not done — for the board's
 * tiles (teams item 19, NEW-teams-5), and the reader's standing in the Team
 * queue for the Agent status line (item 31, dashboard §2.2.3). The standing
 * is computed once for the whole answer.
 */
export async function agentStatesFor(
  deps: AiTeammatesDeps,
  reader: string,
  canSee: (project: string | undefined) => boolean,
): Promise<AgentStatesView> {
  let standing: ReturnType<NonNullable<AiTeammatesDeps["standing"]>> | undefined;
  const once: AiTeammatesDeps = {
    ...deps,
    ...(deps.standing
      ? {
          standing: () => {
            standing ??= (deps.standing as NonNullable<AiTeammatesDeps["standing"]>)();
            return standing;
          },
        }
      : {}),
  };
  const requests = new Map<string, StartRequest>();
  for (const r of await startRequests(deps)) requests.set(r.cardId, r);
  const states: AgentStatesView["states"] = [];
  const visible = (c: CardRecord) => canSee(deps.projectOf(c));
  for (const card of await deps.cardStore.listCards()) {
    if (card.status === "done" || !visible(card)) continue;
    if (!requests.has(card.id) && card.delegate?.kind !== "worker") continue;
    const agent = await agentFacts(once, card, reader, requests.get(card.id));
    if (agent) states.push({ cardId: card.id, ai: [agent] });
  }
  let queue: AgentStatesView["queue"] = null;
  if (deps.audience.setup === "team" && once.standing) {
    const entries = await once.standing().catch(() => []);
    for (const e of entries) {
      if (e.person !== reader || e.place === undefined) continue;
      const card = await deps.cardStore.getCard(e.cardId);
      if (!card || !visible(card)) continue;
      const running = (await deps.cardStore.listCards({ status: "in_progress" })).filter(
        (c) => c.delegate?.kind === "worker" && visible(c),
      );
      const people = running.map((c) => personOf(deps.cardStore, c));
      const other = people.find((p) => p !== reader);
      const next = e.place === 1 && other !== undefined && !people.includes(reader);
      queue = {
        cardId: e.cardId,
        place: e.place,
        message: e.message,
        ...(next ? { runningFor: nameFor(deps.audience, other, reader) } : {}),
      };
      break;
    }
  }
  return { states, queue };
}

async function agentState(
  deps: AiTeammatesDeps,
  card: CardRecord,
  name: (p: string | undefined) => string,
): Promise<AiStateFacts> {
  const question = deps.cardStore.runs.listDecisions("pending").find((d) => d.cardId === card.id);
  if (question) {
    return { who: "agent", state: "needs you", waitingFor: "answer", waitsOn: name(card.owner) };
  }
  switch (card.status) {
    case "ready": {
      const mine = (await deps.standing?.().catch(() => []))?.find((s) => s.cardId === card.id);
      const standing = mine
        ? mine.capped
          ? `${mine.message}; ${capNote(name(mine.person), mine.capped.running, mine.capped.cap, false)}`
          : mine.message
        : undefined;
      return { who: "agent", state: "queued", ...(standing ? { standing } : {}) };
    }
    case "in_progress": {
      const taken = (await deps.cardStore.cardEvents(card.id, ["card/taken_over"])).length;
      const moved = (await deps.cardStore.cardEvents(card.id, ["card/status_changed"])).at(-1)?.seq;
      const lastTake = (await deps.cardStore.cardEvents(card.id, ["card/taken_over"])).at(-1)?.seq;
      if (card.stopReason === "paused" || (taken && (lastTake ?? 0) > (moved ?? 0))) {
        return { who: "agent", state: "paused" };
      }
      return {
        who: "agent",
        state: "working",
        step: (card.stepsUsed ?? 0) + 1,
        ...(card.stepBudget ? { of: card.stepBudget } : {}),
      };
    }
    case "verify":
      return { who: "agent", state: "working", checking: true };
    case "review":
      return { who: "agent", state: "done", waitingFor: "review" };
    case "done":
      return { who: "agent", state: "done" };
    case "parked":
      if (card.stopReason && card.stopReason !== "paused") {
        return {
          who: "agent",
          state: "failed",
          reason: stopReasonLabel(card.stopReason).sentence,
        };
      }
      return { who: "agent", state: "paused" };
    default:
      return { who: "agent", state: "queued" };
  }
}

interface SeshatReply {
  id: string;
  seq: number;
  text: string;
  createdAt: string;
  error: boolean;
}

/** Seshat's first answer to each question, by the question's id (the chat's own records). */
async function seshatReplies(log: EventLog): Promise<Map<string, SeshatReply>> {
  const out = new Map<string, SeshatReply>();
  for (const e of await log.getEventsByTypes([PM_EVENTS.reply])) {
    const p = e.payload as {
      id: string;
      replyTo?: string[];
      text?: string;
      createdAt?: string;
      error?: boolean;
    };
    for (const to of p.replyTo ?? []) {
      if (out.has(to)) continue;
      out.set(to, {
        id: p.id,
        seq: e.seq,
        text: String(p.text ?? ""),
        createdAt: p.createdAt ?? e.createdAt,
        error: p.error === true,
      });
    }
  }
  return out;
}

/** Seshat's state on the latest question put to it on this issue (item 19). */
async function seshatState(
  deps: AiTeammatesDeps,
  cardId: string,
): Promise<AiStateFacts | undefined> {
  const asked = (await deps.cardStore.cardEvents(cardId, [COMMENT_EVENT]))
    .map((e) => (e.payload as { seshatMessage?: string }).seshatMessage)
    .filter((m): m is string => Boolean(m))
    .at(-1);
  if (!asked) return undefined;
  const reply = (await seshatReplies(deps.log)).get(asked);
  if (reply) return { who: "seshat", state: reply.error ? "failed" : "done" };
  // Answering now: the chat's status says Seshat is thinking.
  const status = (await deps.log.getEventsByTypes([PM_EVENTS.status])).at(-1)?.payload as
    | { phase?: string }
    | undefined;
  return { who: "seshat", state: status?.phase === "thinking" ? "working" : "queued" };
}

/**
 * TEAM-16, K-N10-1: the Agent does only what the person it works for may.
 * In the Team setup that is the person who delegated the issue to it (else
 * its owner): while they cannot start the Agent on the issue's project, it
 * does not run. Returns the refusal, or undefined when it may run. Solo's
 * one person may always; an issue with no delegator and no owner runs as
 * the queue's run, which a Member started.
 */
export function agentRefusal(
  access: Access,
  store: CardStore,
  card: CardRecord,
  projectOf: (card: CardRecord) => string | undefined = (c) => projectOfIssue(store, c),
): { person: string; decision: Decision } | undefined {
  if (access.setup !== "team") return undefined;
  const person = store.delegatorOf(card.id) ?? card.owner ?? undefined;
  const project = projectOf(card);
  // No one delegated or owns it: it runs as the queue's run, which a Member
  // started (`run.start`); there is no one else's level to hold it to.
  if (!person) return undefined;
  const name = project ? store.getProject(project)?.name : undefined;
  const decision = access.decide(person, "agent.start", project, name);
  return decision.allowed ? undefined : { person, decision };
}

/**
 * An issue's project as the dashboard reads it (`projectOfCard`): its own,
 * else the workspace's one project — an issue from before projects belongs
 * to it — so the queue and the dashboard hold it to the same level.
 */
export function projectOfIssue(store: CardStore, card: CardRecord): string | undefined {
  if (card.projectId) return card.projectId;
  const projects = store.listProjects();
  return projects.length === 1 ? projects[0]?.id : undefined;
}

/**
 * The queue's side of TEAM-16: of the Ready issues, those the Agent may run.
 * Each one it may not is left where it is and the refusal recorded once
 * while it stands — not again on each queue pass until the person or their
 * level changes — naming the person (`access/refused`, the queue acting for them).
 */
export async function runnableByTheirPeople(
  cards: readonly CardRecord[],
  deps: { access: Access; store: CardStore; log: EventLog; say?: (line: string) => void },
): Promise<CardRecord[]> {
  const out: CardRecord[] = [];
  for (const card of cards) {
    const refused = agentRefusal(deps.access, deps.store, card);
    if (!refused) {
      out.push(card);
      continue;
    }
    deps.say?.(`   ${card.id}: not started — ${refused.decision.message}`);
    const level = refused.decision.level ?? "none";
    const project = projectOfIssue(deps.store, card);
    const standing = (await deps.store.cardEvents(card.id, ["access/refused"]))
      .filter((e) => (e.payload as { permission?: string }).permission === "agent.start")
      .at(-1);
    const same =
      standing?.principal === refused.person &&
      (standing.payload as { level?: string }).level === level;
    if (same) continue;
    await deps.log.append({
      actor: "harness",
      type: "access/refused",
      principal: refused.person,
      cardId: card.id,
      payload: {
        permission: "agent.start",
        level,
        needs: refused.decision.needs,
        ...(project ? { project } : {}),
      },
    });
  }
  return out;
}

/** The check between the Agent's steps (TEAM-16): the refusal's words, or undefined. */
export function agentRefusalFor(
  access: Access,
  store: CardStore,
): (cardId: string) => Promise<string | undefined> {
  return async (cardId) => {
    const card = await store.getCard(cardId);
    return card ? agentRefusal(access, store, card)?.decision.message : undefined;
  };
}
