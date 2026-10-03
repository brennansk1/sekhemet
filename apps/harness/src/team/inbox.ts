import type { CardRecord, EventLog, EventRecord } from "@sekhemet/kernel";
import {
  type AiStateFacts,
  type InboxChange,
  type InboxFilter,
  type InboxItemFacts,
  type InboxReason,
  type MyIssueFacts,
  type MyIssueWhy,
  changeLine,
  itemLine,
  strongestReason,
} from "@sekhemet/ui";
import { nameFor } from "../pm/audience.js";
import { PmStore } from "../pm/store.js";
import { PM_EVENTS } from "../pm/types.js";
import {
  AiTeammateError,
  type AiTeammatesDeps,
  COMMENT_EVENT,
  MENTION_ANSWERED,
  aiStates,
  startRequests,
} from "./ai_teammates.js";
import { triageCountsFor } from "./intake.js";
import { REMOVAL_SETTLED, emptiedAcceptRules } from "./leaving.js";
import {
  ACCEPT_DISMISSED,
  REVIEW_COMMENTED,
  THREAD_REOPENED,
  THREAD_RESOLVED,
} from "./review_threads.js";

/**
 * Subscriptions, mentions and the Inbox (teams NEW-teams-7, items 22–24;
 * TEAM-21, -22, -23, -43; dashboard DB-N9-14, -15).
 *
 * Nothing here is a second store: every answer folds the event log. A person
 * is subscribed to an issue when they create it, own it, are delegated or
 * mentioned on it, comment on it, or are asked to review it (TEAM-21), and
 * by the *Watch* toggle (`issue/watched`, `issue/unwatched`). Each later
 * change on the issue reaches each subscriber other than the person who made
 * it, with a reason: *Mentioned*, *Review requested*, *Agent finished* or
 * *Watching* (TEAM-43's Inbox half). A comment that mentions someone who
 * cannot see the project reaches no one until its author answers whether to
 * invite them (TEAM-22). Reading, *Done*, *Snooze* and *Save* are the
 * person's own events (`inbox/*`), each covering the changes up to a
 * sequence number, so a later change brings a row back, as Linear's does
 * (TEAM-23). *Needs you* holds the questions waiting on the person: a
 * request to start the Agent, a plan sent for their approval, the Agent's
 * question, and a mention's invite question. Items about a project the
 * person cannot see are not shown.
 */

export { MENTION_ANSWERED };
export const WATCHED = "issue/watched";
export const UNWATCHED = "issue/unwatched";
export const INBOX_EVENTS = {
  read: "inbox/read",
  done: "inbox/done",
  snoozed: "inbox/snoozed",
  saved: "inbox/saved",
} as const;

/** The Inbox's reads need the AI teammates' deps and the workspace's people. */
export type InboxDeps = AiTeammatesDeps & {
  /** The Solo install's person: the one reviewer and Agent-starter when no rule names one. */
  localPrincipal?: () => string;
};

/** A change as the fold records it: people by principal, named for each reader later. */
interface ChangeFact {
  type: InboxChange["type"];
  by?: string;
  byAi?: "agent";
  status?: string;
  to?: string;
  toAi?: "agent";
  fields?: string[];
}

interface Delivery {
  seq: number;
  at: string;
  eventId: string;
  cardId: string;
  reason: InboxReason;
  change: ChangeFact;
}

interface CommentState {
  id: string;
  cardId: string;
  author: string;
  seq: number;
  at: string;
  people: string[];
  held: string[];
  answer?: "invite" | "skip";
  answeredSeq?: number;
}

interface Mark {
  read: number;
  done: number;
  saved: boolean;
  snoozeUntil?: string | undefined;
}

interface CardState {
  owner?: string | undefined;
  delegate?: { kind: string; id?: string } | null;
  /** Who delegated it to the Agent: the person the Agent's work is for. */
  delegator?: string;
}

export interface InboxFold {
  lastSeq: number;
  /** Per issue: each person's subscription (true) or explicit unwatch (false). */
  subs: Map<string, Map<string, boolean>>;
  /** Per person, what reached them, oldest first. */
  deliveries: Map<string, Delivery[]>;
  comments: Map<string, CommentState>;
  /** Per person, per item. */
  marks: Map<string, Map<string, Mark>>;
}

const FOLD_TYPES = [
  "card/created",
  "card/owner_changed",
  "card/delegated",
  "card/status_changed",
  "card/updated",
  COMMENT_EVENT,
  // Review verdicts and threads (teams item 25), as a pull request notifies.
  REVIEW_COMMENTED,
  THREAD_RESOLVED,
  THREAD_REOPENED,
  ACCEPT_DISMISSED,
  "card/accepted",
  WATCHED,
  UNWATCHED,
  MENTION_ANSWERED,
  INBOX_EVENTS.read,
  INBOX_EVENTS.done,
  INBOX_EVENTS.snoozed,
  INBOX_EVENTS.saved,
];

/** The fields a `card/updated` names, in the words the issue page uses. */
const FIELD_WORDS: Record<string, string> = {
  title: "title",
  body: "description",
  description: "description",
  priority: "priority",
  labels: "labels",
  estimate: "points",
  dueDate: "due date",
  cycleId: "sprint",
  epicId: "epic",
  acceptance: "acceptance criteria",
  acceptanceCriteria: "acceptance criteria",
};

/** The runner's and the Worker's own moves are the Agent's. */
const AGENT_ACTORS = new Set(["executor", "worker", "runner", "agent"]);

/** The fold so far, with what it keeps between events: each log's own, advanced as it grows. */
interface FoldState {
  fold: InboxFold;
  cards: Map<string, CardState>;
  projects: Map<string, string | undefined>;
}
const cache = new WeakMap<EventLog, FoldState>();
/** One advance at a time per log, so two readers never fold the same events twice. */
const advancing = new WeakMap<EventLog, Promise<InboxFold>>();
const FOLD_PAGE = 5_000;

/** Who may accept on a card's project: the people asked to review it (item 7, DEC-42). */
function reviewersOf(deps: InboxDeps, project: string | undefined): string[] {
  const holders = deps.access.acceptHolders(project);
  if (holders) return holders;
  const local = deps.localPrincipal?.();
  return deps.access.setup === "solo" && local ? [local] : [];
}

/**
 * Fold the log into subscriptions, deliveries and marks. The fold is kept
 * per log and advanced over only the events appended since (read a page at
 * a time), so a long ledger is read once, not on every Inbox request.
 */
export async function foldInbox(deps: InboxDeps): Promise<InboxFold> {
  for (;;) {
    const running = advancing.get(deps.log);
    if (!running) break;
    await running.catch(() => undefined);
  }
  const last = (await deps.log.getLastEvent())?.seq ?? 0;
  const cached = cache.get(deps.log);
  if (cached && cached.fold.lastSeq === last) return cached.fold;
  const run = advanceFold(deps, cached && cached.fold.lastSeq < last ? cached : undefined, last);
  advancing.set(deps.log, run);
  try {
    return await run;
  } catch (err) {
    // A half-advanced fold is not kept: the next read folds from the start.
    cache.delete(deps.log);
    throw err;
  } finally {
    advancing.delete(deps.log);
  }
}

async function advanceFold(
  deps: InboxDeps,
  from: FoldState | undefined,
  last: number,
): Promise<InboxFold> {
  const state: FoldState = from ?? {
    fold: {
      lastSeq: 0,
      subs: new Map(),
      deliveries: new Map(),
      comments: new Map(),
      marks: new Map(),
    },
    cards: new Map(),
    projects: new Map(),
  };
  const { fold, cards, projects } = state;
  const projectOf = async (cardId: string): Promise<string | undefined> => {
    if (projects.has(cardId)) return projects.get(cardId);
    const card = await deps.cardStore.getCard(cardId);
    const p = card ? deps.projectOf(card) : undefined;
    projects.set(cardId, p);
    return p;
  };
  const subsOf = (cardId: string) => {
    let m = fold.subs.get(cardId);
    if (!m) {
      m = new Map();
      fold.subs.set(cardId, m);
    }
    return m;
  };
  const subscribe = (cardId: string, p: string | null | undefined) => {
    if (p) subsOf(cardId).set(p, true);
  };
  const markOf = (p: string, item: string): Mark => {
    let m = fold.marks.get(p);
    if (!m) {
      m = new Map();
      fold.marks.set(p, m);
    }
    let mark = m.get(item);
    if (!mark) {
      mark = { read: 0, done: 0, saved: false };
      m.set(item, mark);
    }
    return mark;
  };
  /** One change to every subscriber but the person who made it, each with its reason. */
  const deliver = (
    e: EventRecord,
    cardId: string,
    change: ChangeFact,
    reasonFor: (p: string) => InboxReason = () => "watching",
    also: readonly string[] = [],
    except: ReadonlySet<string> = new Set(),
  ) => {
    const madeBy = change.by;
    const to = new Set([...[...subsOf(cardId)].filter(([, on]) => on).map(([p]) => p), ...also]);
    for (const p of to) {
      if (p === madeBy || except.has(p)) continue;
      const list = fold.deliveries.get(p) ?? [];
      list.push({
        seq: e.seq,
        at: e.createdAt,
        eventId: e.id,
        cardId,
        reason: reasonFor(p),
        change,
      });
      fold.deliveries.set(p, list);
    }
  };
  const byOf = (e: EventRecord): string | undefined =>
    e.actor === "human" || (e.principal && !AGENT_ACTORS.has(e.actor)) ? e.principal : undefined;
  const deliverComment = (e: EventRecord, c: CommentState) => {
    const mentioned = new Set([...c.people, ...(c.answer === "invite" ? c.held : [])]);
    for (const p of mentioned) subscribe(c.cardId, p);
    deliver(
      e,
      c.cardId,
      { type: "commented", by: c.author },
      (p) => (mentioned.has(p) ? "mentioned" : "watching"),
      [],
      // Those it held back and were not invited hear nothing of it.
      new Set(c.answer === "invite" ? [] : c.held),
    );
  };

  let cursor = fold.lastSeq + 1;
  for (;;) {
    const page = await deps.log.getEventsByTypes(FOLD_TYPES, cursor, FOLD_PAGE);
    for (const e of page) {
      if (e.seq > last) break;
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const cardId = String(p.cardId ?? p.id ?? e.cardId ?? "");
      switch (e.type) {
        case "card/created": {
          const owner = typeof p.owner === "string" ? p.owner : undefined;
          const delegate = (p.delegate as CardState["delegate"]) ?? null;
          const by = byOf(e);
          cards.set(cardId, {
            ...(owner ? { owner } : {}),
            delegate,
            ...(delegate?.kind === "worker" && by ? { delegator: by } : {}),
          });
          subscribe(cardId, by);
          subscribe(cardId, owner);
          if (delegate?.kind === "person") subscribe(cardId, delegate.id);
          deliver(e, cardId, { type: "created", ...(by ? { by } : {}) });
          break;
        }
        case "card/owner_changed": {
          const to = typeof p.to === "string" ? p.to : undefined;
          const c = cards.get(cardId) ?? {};
          if (to) c.owner = to;
          else c.owner = undefined;
          cards.set(cardId, c);
          subscribe(cardId, to);
          const by = byOf(e);
          deliver(e, cardId, { type: "owner", ...(by ? { by } : {}), ...(to ? { to } : {}) });
          break;
        }
        case "card/delegated": {
          const to = (p.to as CardState["delegate"]) ?? null;
          const by = byOf(e);
          const c = cards.get(cardId) ?? {};
          c.delegate = to;
          if (to?.kind === "worker" && by) c.delegator = by;
          cards.set(cardId, c);
          if (to?.kind === "person") subscribe(cardId, to.id);
          if (to?.kind === "worker") subscribe(cardId, by);
          deliver(e, cardId, {
            type: "delegated",
            ...(by ? { by } : {}),
            ...(to?.kind === "worker" ? { toAi: "agent" as const } : {}),
            ...(to?.kind === "person" && to.id ? { to: to.id } : {}),
          });
          break;
        }
        case "card/status_changed": {
          const status = String(p.toStatus ?? "");
          const by = byOf(e);
          const agent = !by && AGENT_ACTORS.has(e.actor);
          const c = cards.get(cardId) ?? {};
          const reviewers = status === "review" ? reviewersOf(deps, await projectOf(cardId)) : [];
          for (const r of reviewers) subscribe(cardId, r);
          // Agent finished: the Agent's own move out of its work, to the person it worked for.
          const solo = deps.access.setup === "solo" ? deps.localPrincipal?.() : undefined;
          const startedBy =
            agent && ["review", "parked", "done"].includes(status)
              ? (c.delegator ?? c.owner ?? solo)
              : undefined;
          subscribe(cardId, startedBy);
          deliver(
            e,
            cardId,
            { type: "status", status, ...(by ? { by } : agent ? { byAi: "agent" as const } : {}) },
            (r) =>
              strongestReason([
                ...(r === startedBy ? (["agent_finished"] as const) : []),
                ...(reviewers.includes(r) ? (["review_requested"] as const) : []),
              ]),
          );
          break;
        }
        case "card/updated": {
          const patch = (p.patch ?? {}) as Record<string, unknown>;
          const fields = [
            ...new Set(
              Object.keys(patch)
                .map((k) => FIELD_WORDS[k])
                .filter((w): w is string => Boolean(w)),
            ),
          ];
          if (fields.length === 0) break;
          const by = byOf(e);
          deliver(e, cardId, { type: "updated", ...(by ? { by } : {}), fields });
          break;
        }
        case COMMENT_EVENT: {
          const author = e.principal;
          if (!author) break;
          const c: CommentState = {
            id: String(p.id),
            cardId,
            author,
            seq: e.seq,
            at: e.createdAt,
            people: Array.isArray(p.people) ? (p.people as string[]) : [],
            held: Array.isArray(p.held) ? (p.held as string[]) : [],
          };
          fold.comments.set(c.id, c);
          subscribe(cardId, author);
          // TEAM-22: held back until its author answers.
          if (c.held.length === 0) deliverComment(e, c);
          break;
        }
        case REVIEW_COMMENTED: {
          // A review (the Comment verdict) or a reply in its thread: the
          // reviewer is subscribed (TEAM-21) and the watchers hear of it.
          const by = e.principal;
          if (!by) break;
          subscribe(cardId, by);
          deliver(e, cardId, { type: typeof p.replyTo === "string" ? "replied" : "reviewed", by });
          break;
        }
        case THREAD_RESOLVED:
        case THREAD_REOPENED: {
          const by = byOf(e);
          deliver(e, cardId, {
            type: e.type === THREAD_RESOLVED ? "resolved" : "reopened",
            ...(by ? { by } : {}),
          });
          break;
        }
        case "card/accepted": {
          // Accepted with its pull request open: the issue stays in Review, so
          // no move says so. A direct accept's move to Done already does.
          if (typeof p.pr !== "string") break;
          const by = byOf(e);
          deliver(e, cardId, { type: "accepted", ...(by ? { by } : {}) });
          break;
        }
        case ACCEPT_DISMISSED: {
          // TEAM-24: the accepter, the watchers and the reviewers, asked again.
          const accepter = typeof p.accepter === "string" ? p.accepter : undefined;
          const reviewers = reviewersOf(deps, await projectOf(cardId));
          deliver(
            e,
            cardId,
            { type: "accept_dismissed", ...(accepter ? { to: accepter } : {}) },
            (r) => (reviewers.includes(r) ? "review_requested" : "watching"),
            [...(accepter ? [accepter] : []), ...reviewers],
          );
          break;
        }
        case MENTION_ANSWERED: {
          const c = fold.comments.get(String(p.id));
          if (!c || c.answer) break;
          c.answer = p.answer === "invite" ? "invite" : "skip";
          c.answeredSeq = e.seq;
          deliverComment(e, c);
          break;
        }
        case WATCHED:
        case UNWATCHED:
          if (e.principal) subsOf(cardId).set(e.principal, e.type === WATCHED);
          break;
        case INBOX_EVENTS.read:
        case INBOX_EVENTS.done:
        case INBOX_EVENTS.snoozed:
        case INBOX_EVENTS.saved: {
          if (!e.principal) break;
          const mark = markOf(e.principal, String(p.item));
          const seq = Number(p.seq ?? 0);
          if (e.type === INBOX_EVENTS.read) mark.read = Math.max(mark.read, seq);
          else if (e.type === INBOX_EVENTS.done) {
            mark.done = p.undo === true ? 0 : Math.max(mark.done, seq);
            if (p.undo !== true) mark.snoozeUntil = undefined;
          } else if (e.type === INBOX_EVENTS.snoozed) mark.snoozeUntil = String(p.until);
          else mark.saved = p.saved === true;
          break;
        }
      }
    }
    const tail = page.at(-1)?.seq;
    if (page.length < FOLD_PAGE || tail === undefined || tail >= last) break;
    cursor = tail + 1;
  }
  fold.lastSeq = last;
  cache.set(deps.log, state);
  return fold;
}

// ---------------------------------------------------------------------------
// Reading the Inbox
// ---------------------------------------------------------------------------

const name = (deps: InboxDeps, p: string | undefined, reader: string): string | undefined =>
  p ? nameFor(deps.audience, p, reader) : undefined;

function namedChange(deps: InboxDeps, c: ChangeFact, reader: string, reason: InboxReason) {
  const by = name(deps, c.by, reader);
  const to = name(deps, c.to, reader);
  const change: InboxChange = {
    type: c.type === "commented" && reason === "mentioned" ? "mentioned" : c.type,
    ...(by ? { by } : {}),
    ...(c.byAi ? { byAi: c.byAi } : {}),
    ...(c.status ? { status: c.status } : {}),
    ...(to ? { to } : {}),
    ...(c.toAi ? { toAi: c.toAi } : {}),
    ...(c.fields ? { fields: c.fields } : {}),
  };
  return change;
}

interface OpenItem extends Omit<InboxItemFacts, "unread" | "saved" | "done" | "snoozedUntil"> {}

/** The questions waiting on a person (*Needs you*), open now. */
async function needsYou(deps: InboxDeps, fold: InboxFold, me: string): Promise<OpenItem[]> {
  const out: OpenItem[] = [];
  const visibleCard = async (cardId: string | undefined) => {
    if (!cardId) return undefined;
    const card = await deps.cardStore.getCard(cardId);
    return card && deps.audience.canSee(me, deps.projectOf(card)) ? card : undefined;
  };
  const projectFacts = (card: CardRecord) => {
    const id = deps.projectOf(card);
    const project = id ? deps.cardStore.getProject(id) : undefined;
    return project ? { project: { id: project.id, name: project.name } } : {};
  };
  // A request to start the Agent (item 19a, TEAM-39).
  for (const r of await startRequests(deps, { for: me })) {
    const card = await visibleCard(r.cardId);
    if (!card) continue;
    const seq = (await deps.log.getEventsByTypes(["agent/start_requested"])).find(
      (e) => (e.payload as { id?: string }).id === r.id,
    )?.seq;
    out.push({
      id: r.id,
      reason: "needs_you",
      kind: "start_request",
      cardId: card.id,
      title: card.title,
      ...projectFacts(card),
      count: 1,
      by: r.requestedByName,
      at: r.requestedAt,
      seq: seq ?? 0,
      request: { id: r.id, requestedBy: r.requestedByName, ask: r.ask },
      ai: await aiStates(deps, card.id, me),
      link: `#/card/${encodeURIComponent(card.id)}/activity`,
    });
  }
  // A plan sent for this person's approval (TEAM-20).
  const plans = await deps.log.getEventsByTypes([PM_EVENTS.planSent, PM_EVENTS.planApproved]);
  const approved = new Set(
    plans
      .filter((e) => e.type === PM_EVENTS.planApproved)
      .map((e) => String((e.payload as { proposalId?: string }).proposalId)),
  );
  const pm = new PmStore(deps.log);
  for (const e of plans) {
    if (e.type !== PM_EVENTS.planSent) continue;
    const p = e.payload as { proposalId: string; approver: string };
    if (approved.has(p.proposalId)) continue;
    if (p.approver !== me && e.principal !== me) continue;
    const proposal = await pm.proposal(p.proposalId);
    if (!proposal || proposal.state !== "open") continue;
    // Design-stage §2.9 item 7: the plan's thread — the approver's question
    // waits on the sender; the sender's answer is said on the approver's item.
    const last = proposal.approval?.thread?.at(-1);
    if (p.approver === me) {
      const answered = last !== undefined && last.by !== me;
      out.push({
        id: `plan:${p.proposalId}`,
        reason: "needs_you",
        kind: "plan_approval",
        title: proposal.summary,
        count: 1,
        ...(e.principal ? { by: nameFor(deps.audience, e.principal, me) } : {}),
        ...(answered ? { answered: true } : {}),
        at: answered ? last.at : e.createdAt,
        seq: e.seq,
        link: "#/pm",
      });
    } else if (last && last.by === p.approver) {
      out.push({
        id: `plan-question:${p.proposalId}:${last.id}`,
        reason: "needs_you",
        kind: "plan_question",
        title: proposal.summary,
        count: 1,
        by: nameFor(deps.audience, last.by, me),
        question: last.text,
        at: last.at,
        seq: e.seq,
        link: "#/pm",
      });
    }
  }
  // The Agent's question, to whom it waits on: a permission request to the
  // people the Accept rule names, any other question to the issue's owner,
  // else the lead, else the Admins; Solo's person holds all of them.
  for (const d of deps.cardStore.runs.listDecisions("pending")) {
    const card = await visibleCard(d.cardId);
    if (!card) continue;
    const project = deps.projectOf(card);
    const lead = project ? deps.access.settings(project).lead : undefined;
    const waitsOn =
      deps.access.setup === "solo"
        ? [deps.localPrincipal?.() ?? me]
        : d.kind === "permission"
          ? reviewersOf(deps, project)
          : card.owner
            ? [card.owner]
            : lead
              ? [lead]
              : deps.access.admins();
    if (!waitsOn.includes(me)) continue;
    out.push({
      id: d.id,
      reason: "needs_you",
      kind: "decision",
      cardId: card.id,
      title: card.title,
      ...projectFacts(card),
      count: 1,
      at: d.createdAt,
      seq: 0,
      question: d.question,
      ai: await aiStates(deps, card.id, me),
      // DB-N9-14: a Needs you item opens the decision in Review › Needs you.
      link: `#/review/${encodeURIComponent(card.id)}`,
    });
  }
  // DB-N10-4: the project lead's count of issues waiting in Triage, per project.
  for (const t of await triageCountsFor(deps, me, (p) => deps.audience.canSee(me, p))) {
    const project = deps.cardStore.getProject(t.project);
    out.push({
      id: `triage:${t.project}`,
      reason: "needs_you",
      kind: "triage",
      title: "Triage",
      ...(project ? { project: { id: project.id, name: project.name } } : {}),
      count: t.count,
      at: t.at,
      seq: t.seq,
      link: "#/board/triage",
    });
  }
  // TEAM-22: the author's question, and after *Invite*, the Admins' request.
  const admin = deps.access.level(me) === "admin";
  // TEAM-51: an Accept rule left with no current member waits in the project
  // lead's and every Admin's Inbox until a person with the right edits it.
  const emptied = emptiedAcceptRules(deps.access, deps.cardStore);
  if (emptied.length) {
    const settled = await deps.log.getEventsByTypes([REMOVAL_SETTLED]);
    for (const r of emptied) {
      if (!admin && r.lead !== me) continue;
      const when = settled
        .filter((e) =>
          ((e.payload as { emptiedRules?: string[] }).emptiedRules ?? []).includes(r.project),
        )
        .at(-1);
      out.push({
        id: `accept-rule:${r.project}`,
        reason: "needs_you",
        kind: "accept_rule",
        title: `${r.name}'s Accept rule`,
        project: { id: r.project, name: r.name },
        count: 1,
        at: when?.createdAt ?? new Date(0).toISOString(),
        seq: when?.seq ?? 0,
        link: "#/configuration/project",
      });
    }
  }
  for (const c of fold.comments.values()) {
    if (c.held.length === 0) continue;
    const card = await visibleCard(c.cardId);
    if (!card) continue;
    const project = deps.projectOf(card);
    const projectName = project ? deps.cardStore.getProject(project)?.name : undefined;
    const people = c.held.map((p) => nameFor(deps.audience, p, me));
    const base = {
      cardId: card.id,
      title: card.title,
      ...projectFacts(card),
      count: 1,
      link: `#/card/${encodeURIComponent(card.id)}/activity`,
    };
    if (!c.answer && c.author === me) {
      out.push({
        ...base,
        id: `mention:${c.id}`,
        reason: "needs_you",
        kind: "mention_invite",
        at: c.at,
        seq: c.seq,
        mention: { commentId: c.id, people, ...(projectName ? { project: projectName } : {}) },
      });
    }
    const stillOut = c.held.filter((p) => !deps.audience.canSee(p, project));
    if (c.answer === "invite" && admin && stillOut.length) {
      out.push({
        ...base,
        id: `invite:${c.id}`,
        reason: "needs_you",
        kind: "invite_request",
        by: nameFor(deps.audience, c.author, me),
        at: c.at,
        seq: c.answeredSeq ?? c.seq,
        mention: {
          commentId: c.id,
          people: stillOut.map((p) => nameFor(deps.audience, p, me)),
          ...(projectName ? { project: projectName } : {}),
        },
        link: "#/members",
      });
    }
  }
  return out;
}

/** The rows of a person's Inbox, by filter (DB-N9-14; TEAM-23). */
export async function inboxFor(
  deps: InboxDeps,
  me: string,
  options: { filter?: InboxFilter; now?: Date } = {},
): Promise<{ items: InboxItemFacts[]; unread: number }> {
  const filter = options.filter ?? "inbox";
  const now = (options.now ?? new Date()).getTime();
  const fold = await foldInbox(deps);
  const marks = fold.marks.get(me) ?? new Map<string, Mark>();
  const markOf = (id: string): Mark => marks.get(id) ?? { read: 0, done: 0, saved: false };
  const snoozed = (m: Mark) => m.snoozeUntil !== undefined && Date.parse(m.snoozeUntil) > now;
  const all: InboxItemFacts[] = [];

  // Changes on issues, one row per issue (Linear's Inbox).
  const byCard = new Map<string, Delivery[]>();
  for (const d of fold.deliveries.get(me) ?? []) {
    const list = byCard.get(d.cardId) ?? [];
    list.push(d);
    byCard.set(d.cardId, list);
  }
  for (const [cardId, list] of byCard) {
    const card = await deps.cardStore.getCard(cardId);
    const project = card ? deps.projectOf(card) : undefined;
    // Items that reach no one are not shown: only what the reader can see.
    if (!card || !deps.audience.canSee(me, project)) continue;
    const id = `issue:${cardId}`;
    const mark = markOf(id);
    const open = list.filter((d) => d.seq > mark.done);
    const shown = open.length ? open : list;
    const latest = shown[shown.length - 1] as Delivery;
    // FINDINGS TEAM-01: Review requested only while the issue waits in In
    // review; once it leaves, the request is over and the row is Watching.
    const reason = strongestReason(
      shown.map((d) =>
        d.reason === "review_requested" && card.status !== "review" ? "watching" : d.reason,
      ),
    );
    const projectRec = project ? deps.cardStore.getProject(project) : undefined;
    const aboutAi = card.delegate?.kind === "worker" || shown.some((d) => d.change.byAi);
    all.push({
      id,
      reason,
      kind: "issue",
      cardId,
      title: card.title,
      ...(projectRec ? { project: { id: projectRec.id, name: projectRec.name } } : {}),
      change: namedChange(deps, latest.change, me, latest.reason),
      count: open.length || 1,
      at: latest.at,
      seq: latest.seq,
      unread: open.length > 0 && latest.seq > mark.read,
      saved: mark.saved,
      done: open.length === 0,
      ...(mark.snoozeUntil && snoozed(mark) ? { snoozedUntil: mark.snoozeUntil } : {}),
      ...(aboutAi ? { ai: await aiStates(deps, cardId, me) } : {}),
      link: `#/card/${encodeURIComponent(cardId)}/activity`,
    });
  }
  // Needs you: open questions; done or snoozed by the person hides them.
  for (const item of await needsYou(deps, fold, me)) {
    const mark = markOf(item.id);
    const done = mark.done > 0 && mark.done >= item.seq;
    all.push({
      ...item,
      unread: item.seq > mark.read || (item.seq === 0 && mark.read === 0),
      saved: mark.saved,
      done,
      ...(mark.snoozeUntil && snoozed(mark) ? { snoozedUntil: mark.snoozeUntil } : {}),
    });
  }
  const inInbox = (i: InboxItemFacts) => !i.done && !i.snoozedUntil;
  const items = all
    .filter((i) => (filter === "saved" ? i.saved : filter === "done" ? i.done : inInbox(i)))
    // Needs you first, longest wait first (dashboard §2.5.2, as `inboxGroups`
    // draws it); every other row newest first.
    .sort((a, b) => {
      const needs = Number(b.reason === "needs_you") - Number(a.reason === "needs_you");
      if (needs !== 0) return needs;
      if (a.reason === "needs_you") return a.at.localeCompare(b.at);
      return b.seq - a.seq || b.at.localeCompare(a.at);
    });
  return { items, unread: all.filter((i) => inInbox(i) && i.unread).length };
}

/** The item's current watermark: the latest change on it (or the request's own sequence). */
async function itemSeq(deps: InboxDeps, me: string, item: string): Promise<number> {
  const fold = await foldInbox(deps);
  if (item.startsWith("issue:")) {
    const cardId = item.slice("issue:".length);
    const list = (fold.deliveries.get(me) ?? []).filter((d) => d.cardId === cardId);
    if (list.length === 0) throw new AiTeammateError("Nothing in your Inbox by that name", 404);
    return list[list.length - 1]?.seq ?? 0;
  }
  const open = await needsYou(deps, fold, me);
  const found = open.find((i) => i.id === item);
  if (!found) throw new AiTeammateError("Nothing in your Inbox by that name", 404);
  // A question with no ledger sequence of its own (the Agent's): the log's head.
  return found.seq || fold.lastSeq;
}

export type InboxAction = "read" | "done" | "undone" | "snooze" | "save" | "unsave";

/**
 * Mark an item (TEAM-23): each mark is the person's own event, covering the
 * changes up to now. Snooze needs a time to come back at.
 */
export async function markInboxItem(
  deps: InboxDeps,
  input: { principal: string; item: string; action: InboxAction; until?: unknown },
): Promise<void> {
  const seq = await itemSeq(deps, input.principal, input.item);
  const base = { actor: "human", principal: input.principal };
  switch (input.action) {
    case "read":
      await deps.log.append({
        ...base,
        type: INBOX_EVENTS.read,
        payload: { item: input.item, seq },
      });
      return;
    case "done":
    case "undone":
      await deps.log.append({
        ...base,
        type: INBOX_EVENTS.done,
        payload: { item: input.item, seq, ...(input.action === "undone" ? { undo: true } : {}) },
      });
      return;
    case "snooze": {
      const until = typeof input.until === "string" ? input.until : "";
      if (!until || Number.isNaN(Date.parse(until))) {
        throw new AiTeammateError("Snooze needs a time to bring it back", 400);
      }
      await deps.log.append({
        ...base,
        type: INBOX_EVENTS.snoozed,
        payload: { item: input.item, seq, until: new Date(until).toISOString() },
      });
      return;
    }
    case "save":
    case "unsave":
      await deps.log.append({
        ...base,
        type: INBOX_EVENTS.saved,
        payload: { item: input.item, saved: input.action === "save" },
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Watch (item 22) and a mention's answer (TEAM-22)
// ---------------------------------------------------------------------------

export async function watchState(
  deps: InboxDeps,
  cardId: string,
  me: string,
): Promise<{ watching: boolean; watchers: { principal: string; name: string }[] }> {
  const fold = await foldInbox(deps);
  const subs = fold.subs.get(cardId) ?? new Map<string, boolean>();
  const card = await deps.cardStore.getCard(cardId);
  const project = card ? deps.projectOf(card) : undefined;
  const watchers = [...subs]
    .filter(([p, on]) => on && deps.audience.canSee(p, project))
    .map(([p]) => ({ principal: p, name: p === me ? "You" : nameFor(deps.audience, p, me) }));
  return { watching: subs.get(me) === true, watchers };
}

export async function setWatch(
  deps: InboxDeps,
  input: { cardId: string; principal: string; watch: boolean },
): Promise<void> {
  const now = await watchState(deps, input.cardId, input.principal);
  if (now.watching === input.watch) return;
  await deps.log.append({
    actor: "human",
    type: input.watch ? WATCHED : UNWATCHED,
    cardId: input.cardId,
    principal: input.principal,
    payload: { cardId: input.cardId },
  });
}

/** The author answers whether to invite the people a comment mentioned who cannot see the project. */
export async function answerMention(
  deps: InboxDeps,
  input: { cardId: string; commentId: string; principal: string; answer: "invite" | "skip" },
): Promise<void> {
  const fold = await foldInbox(deps);
  const c = fold.comments.get(input.commentId);
  if (!c || c.cardId !== input.cardId || c.held.length === 0) {
    throw new AiTeammateError("That comment holds no mention to answer", 404);
  }
  if (c.author !== input.principal) {
    throw new AiTeammateError("Only the person who wrote the comment answers this", 403);
  }
  if (c.answer) throw new AiTeammateError("That mention was already answered", 409);
  await deps.log.append({
    actor: "human",
    type: MENTION_ANSWERED,
    cardId: input.cardId,
    principal: input.principal,
    payload: { id: c.id, cardId: input.cardId, answer: input.answer },
  });
}

/**
 * The people a comment mentions (teams item 23), split by whether they can
 * see the issue's project: those who can are mentioned, those who cannot are
 * held until the author answers (TEAM-22).
 */
export function splitMentions(
  deps: Pick<InboxDeps, "audience">,
  mentioned: readonly string[],
  project: string | undefined,
): { people: string[]; held: string[] } {
  const people: string[] = [];
  const held: string[] = [];
  for (const p of mentioned) (deps.audience.canSee(p, project) ? people : held).push(p);
  return { people, held };
}

// ---------------------------------------------------------------------------
// My issues (DB-N9-15)
// ---------------------------------------------------------------------------

const CLOSED = new Set(["done", "rejected"]);

export async function myIssues(deps: InboxDeps, me: string): Promise<MyIssueFacts[]> {
  const out: MyIssueFacts[] = [];
  for (const card of await deps.cardStore.listCards()) {
    if (CLOSED.has(card.status)) continue;
    const project = deps.projectOf(card);
    if (!deps.audience.canSee(me, project)) continue;
    const why: MyIssueWhy[] = [];
    if (card.owner === me) why.push("owner");
    if (card.delegate?.kind === "person" && card.delegate.id === me) why.push("delegated");
    if (card.status === "review" && reviewersOf(deps, project).includes(me)) why.push("review");
    if (why.length === 0) continue;
    const projectRec = project ? deps.cardStore.getProject(project) : undefined;
    out.push({
      id: card.id,
      title: card.title,
      status: card.status,
      ...(typeof card.priority === "number" ? { priority: card.priority } : {}),
      why,
      ...(projectRec ? { project: { id: projectRec.id, name: projectRec.name } } : {}),
      ...(card.delegate?.kind === "worker" ? { ai: await aiStates(deps, card.id, me) } : {}),
    });
  }
  return out;
}

/** One issue a search found (dashboard DB-N26-2, §2.4.21). */
export interface IssueHit {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
  project?: { id: string; name: string };
}

/**
 * Search the issues of every project the person can see (dashboard DB-N26-2,
 * teams TEAM-58; DEC-57): a title or id containing `q`, any case, newest
 * change first; with no `q`, the newest. A project the person cannot see is
 * never searched.
 */
export async function searchIssues(
  deps: InboxDeps,
  me: string,
  q: string,
  limit = 50,
): Promise<IssueHit[]> {
  const needle = q.trim().toLowerCase();
  const out: IssueHit[] = [];
  for (const card of await deps.cardStore.listCards()) {
    const project = deps.projectOf(card);
    if (!deps.audience.canSee(me, project)) continue;
    if (needle && !`${card.title} ${card.id}`.toLowerCase().includes(needle)) continue;
    const rec = project ? deps.cardStore.getProject(project) : undefined;
    out.push({
      id: card.id,
      title: card.title,
      status: card.status,
      updatedAt: card.updatedAt,
      ...(rec ? { project: { id: rec.id, name: rec.name } } : {}),
    });
  }
  return out
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(200, limit)));
}

// ---------------------------------------------------------------------------
// Notices (TEAM-43): what a watcher is pushed, within their budget
// ---------------------------------------------------------------------------

export interface WatcherNotice {
  to: string;
  /** The event the notice is about: one notice per person per event. */
  eventId: string;
  seq: number;
  cardId?: string;
  kind: "watching" | "mentioned" | "project_update";
  /** What it is about: the issue's title, or the project's name. */
  title: string;
  /** The person's name, for a message on a shared channel naming who it is for. */
  name?: string;
  /** The change, in the reader's words ("mentioned you"). */
  message: string;
}

/**
 * The notices the changes after `afterSeq` owe their watchers: each change
 * that reached a person's Inbox (a mention as *mentioned*, everything else
 * as *watching*), and each posted project update to the project's watchers —
 * the people subscribed to any of its issues, and its lead — other than the
 * person who posted it. The notifier sends them within each person's budget.
 */
export async function watcherNotices(deps: InboxDeps, afterSeq: number): Promise<WatcherNotice[]> {
  const fold = await foldInbox(deps);
  const out: WatcherNotice[] = [];
  const titles = new Map<string, CardRecord | undefined>();
  const cardOf = async (id: string) => {
    if (!titles.has(id)) titles.set(id, (await deps.cardStore.getCard(id)) ?? undefined);
    return titles.get(id);
  };
  const forName = (p: string) => deps.audience.nameOf(p);
  for (const [to, list] of fold.deliveries) {
    for (const d of list) {
      if (d.seq <= afterSeq) continue;
      // The Agent's own moves through its work (started, being checked) show
      // in the Inbox but interrupt no one; its finishing does.
      if (d.change.byAi && ["planning", "in_progress", "verify"].includes(d.change.status ?? "")) {
        continue;
      }
      const card = await cardOf(d.cardId);
      if (!card || !deps.audience.canSee(to, deps.projectOf(card))) continue;
      const who = forName(to);
      out.push({
        to,
        eventId: d.eventId,
        seq: d.seq,
        cardId: d.cardId,
        kind: d.reason === "mentioned" ? "mentioned" : "watching",
        title: card.title,
        ...(who ? { name: who } : {}),
        message: changeLine(namedChange(deps, d.change, to, d.reason)),
      });
    }
  }
  for (const e of await deps.log.getEventsByTypes(["project/update_posted"], afterSeq + 1)) {
    const project = String((e.payload as { project?: string }).project ?? "");
    if (!project) continue;
    const watchers = new Set<string>();
    for (const [cardId, subs] of fold.subs) {
      const card = await cardOf(cardId);
      if (!card || deps.projectOf(card) !== project) continue;
      for (const [p, on] of subs) if (on) watchers.add(p);
    }
    const lead = deps.access.settings(project).lead;
    if (lead) watchers.add(lead);
    const projectName = deps.cardStore.getProject(project)?.name ?? "The project";
    for (const to of watchers) {
      if (to === e.principal || !deps.audience.canSee(to, project)) continue;
      const who = forName(to);
      const by = e.principal ? nameFor(deps.audience, e.principal, to) : "Someone";
      out.push({
        to,
        eventId: e.id,
        seq: e.seq,
        kind: "project_update",
        title: projectName,
        ...(who ? { name: who } : {}),
        message: `${by.charAt(0).toUpperCase()}${by.slice(1)} posted a project update.`,
      });
    }
  }
  return out;
}

/** A person's rows still unread in their Inbox (the digest holds only these, TEAM-23). */
export async function unreadItems(deps: InboxDeps, me: string): Promise<InboxItemFacts[]> {
  return (await inboxFor(deps, me)).items.filter((i) => i.unread);
}

/** What the notifier asks of the Inbox (TEAM-43): the notices owed, and a person's digest. */
export interface InboxNotifier {
  notices(afterSeq: number): Promise<WatcherNotice[]>;
  /**
   * The day's digest for a person: of the issues whose notices were held
   * past their budget, those still unread in their Inbox — none, no digest.
   */
  digest(
    to: string,
    heldCards: ReadonlySet<string>,
  ): Promise<{ title: string; head: string; message: string } | undefined>;
  /**
   * Whether the person may see the issue's project: a personal channel
   * (email) carries nothing of a project they cannot see (TEAM-43).
   */
  visible?(to: string, cardId: string): Promise<boolean>;
}

export function inboxNotifier(deps: InboxDeps): InboxNotifier {
  return {
    notices: (afterSeq) => watcherNotices(deps, afterSeq),
    digest: async (to, heldCards) => {
      const rows = (await unreadItems(deps, to)).filter(
        (i) => i.kind === "issue" && i.cardId !== undefined && heldCards.has(i.cardId),
      );
      if (rows.length === 0) return undefined;
      const who = deps.audience.nameOf(to);
      const n = rows.length;
      const head = `${n} unread in your Inbox`;
      return {
        title: who ? `For ${who}: ${head}` : head,
        head,
        message: rows.map((r) => `${r.title}: ${itemLine(r).line}`).join("\n"),
      };
    },
    visible: async (to, cardId) => {
      const card = await deps.cardStore.getCard(cardId);
      return card ? deps.audience.canSee(to, deps.projectOf(card)) : false;
    },
  };
}

export type { AiStateFacts };
