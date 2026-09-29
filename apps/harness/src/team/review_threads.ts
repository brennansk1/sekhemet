import { randomUUID } from "node:crypto";
import type { CardStore, EventLog, EventRecord } from "@sekhemet/kernel";
import { openThreadText, threadPlace } from "@sekhemet/ui";

/**
 * Review verdicts as GitHub's pull-request review has them (teams item 25,
 * NEW-teams-8; review-git §2 item 4; DESIGN_RESEARCH_COLLABORATION §4).
 *
 * Beside *Accept* and *Send back*, a reviewer may leave a *Comment*: a review
 * with no verdict. Each of its comments opens a **review thread** — on a
 * file's line, or on the whole change — that anyone who can comment may
 * answer, and that a person who reviews (a Member or above) resolves or
 * reopens. A project may require every thread resolved before Accept
 * (TEAM-25): Accept is then refused, and disabled on the page, naming the
 * open thread. Every answer here is a fold of the issue's events — there is
 * no second store — and each comment's text lives in the event's private,
 * erasable part (teams §3).
 */

export const REVIEW_COMMENTED = "review/commented";
export const THREAD_RESOLVED = "review/thread_resolved";
export const THREAD_REOPENED = "review/thread_reopened";
export const ACCEPT_DISMISSED = "review/accept_dismissed";

/** The most comments one review carries, and the longest comment. */
export const MAX_REVIEW_COMMENTS = 50;
export const MAX_COMMENT_CHARS = 8000;

export interface ThreadComment {
  id: string;
  principal?: string;
  name?: string;
  text: string;
  at: string;
}

export interface ReviewThread {
  id: string;
  cardId: string;
  /** Where it was left: a file and line, or neither for the whole change. */
  file?: string;
  line?: number;
  /** Who opened it. */
  principal?: string;
  name?: string;
  at: string;
  resolved: boolean;
  /** Who resolved it, and when, while it is resolved. */
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: string;
  comments: ThreadComment[];
}

/** A refusal the route answers with its HTTP status. */
export class ReviewThreadError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ReviewThreadError";
  }
}

type NameOf = (principal: string | undefined) => string | undefined;

const privateOf = (e: EventRecord): Record<string, unknown> =>
  ((e as EventRecord & { private?: Record<string, unknown> }).private ?? {}) as Record<
    string,
    unknown
  >;

/** An erased comment reads as a gap, never as an empty string (kernel rule 33). */
const ERASED_TEXT = "This comment was erased.";

function textAt(e: EventRecord, i: number): string {
  const texts = privateOf(e).texts;
  const t = Array.isArray(texts) ? texts[i] : undefined;
  return typeof t === "string" && t.length > 0 ? t : ERASED_TEXT;
}

function named(principal: string | undefined, nameOf: NameOf | undefined) {
  const name = principal ? nameOf?.(principal) : undefined;
  return { ...(principal ? { principal } : {}), ...(name ? { name } : {}) };
}

/** An issue's review threads, oldest first, each with its comments and whether it is resolved. */
export async function reviewThreads(
  store: CardStore,
  cardId: string,
  nameOf?: NameOf,
): Promise<ReviewThread[]> {
  const events = await store.cardEvents(cardId, [
    REVIEW_COMMENTED,
    THREAD_RESOLVED,
    THREAD_REOPENED,
  ]);
  const threads = new Map<string, ReviewThread>();
  for (const e of events) {
    const who = e.principal ?? undefined;
    if (e.type === REVIEW_COMMENTED) {
      const p = e.payload as {
        id: string;
        threads?: { id: string; file?: string; line?: number }[];
        replyTo?: string;
      };
      if (p.replyTo) {
        threads.get(p.replyTo)?.comments.push({
          id: p.id,
          ...named(who, nameOf),
          text: textAt(e, 0),
          at: e.createdAt,
        });
        continue;
      }
      (p.threads ?? []).forEach((t, i) => {
        threads.set(t.id, {
          id: t.id,
          cardId,
          ...(t.file ? { file: t.file } : {}),
          ...(t.line !== undefined ? { line: t.line } : {}),
          ...named(who, nameOf),
          at: e.createdAt,
          resolved: false,
          comments: [
            { id: `${p.id}:${i}`, ...named(who, nameOf), text: textAt(e, i), at: e.createdAt },
          ],
        });
      });
      continue;
    }
    const p = e.payload as { thread: string };
    const thread = threads.get(p.thread);
    if (!thread) continue;
    // Reopening drops who resolved it; resolving names them.
    const { resolvedBy: _b, resolvedByName: _n, resolvedAt: _a, ...open } = thread;
    if (e.type === THREAD_RESOLVED) {
      const by = named(who, nameOf);
      threads.set(p.thread, {
        ...open,
        resolved: true,
        ...(by.principal ? { resolvedBy: by.principal } : {}),
        ...(by.name ? { resolvedByName: by.name } : {}),
        resolvedAt: e.createdAt,
      });
    } else {
      threads.set(p.thread, { ...open, resolved: false });
    }
  }
  return [...threads.values()];
}

/**
 * TEAM-25: why Accept is refused while a thread is open, naming the first
 * one, or undefined when every thread is resolved — the words the page
 * shows beside the disabled Accept (`openThreadText`, one wording).
 */
export function openThreadRefusal(threads: readonly ReviewThread[]): string | undefined {
  return openThreadText(threads, true) || undefined;
}

/** A repository-relative file a comment may be left on: no absolute path, no `..`. */
function validFile(file: string): boolean {
  return (
    file.length > 0 &&
    file.length <= 512 &&
    !file.startsWith("/") &&
    !/^[A-Za-z]:/.test(file) &&
    !file.split(/[\\/]/).includes("..") &&
    !file.includes("\0")
  );
}

async function openIssue(store: CardStore, cardId: string) {
  const card = await store.getCard(cardId);
  if (!card) throw new ReviewThreadError(`No issue ${cardId}`, 404);
  if (card.status === "done" || card.status === "rejected") {
    throw new ReviewThreadError(
      `${cardId} is ${card.status === "done" ? "accepted" : "closed"}; its review is over`,
      409,
    );
  }
  return card;
}

function cleanText(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_COMMENT_CHARS) : "";
}

/**
 * The *Comment* verdict (teams item 25): a review with no verdict. `body`
 * opens a thread on the whole change; each line comment opens one on its
 * file and line. Recorded as one `review/commented` with the reviewer as
 * principal; nothing moves on the board.
 */
export async function postReview(
  store: CardStore,
  input: {
    cardId: string;
    principal: string;
    body?: unknown;
    comments?: unknown;
  },
  nameOf?: NameOf,
): Promise<{ id: string; threads: ReviewThread[] }> {
  const card = await openIssue(store, input.cardId);
  const opened: { file?: string; line?: number; text: string }[] = [];
  const body = cleanText(input.body);
  if (body) opened.push({ text: body });
  if (input.comments !== undefined && !Array.isArray(input.comments)) {
    throw new ReviewThreadError("comments is a list of {file, line, text}", 400);
  }
  for (const raw of (input.comments as unknown[] | undefined) ?? []) {
    const c = (raw ?? {}) as { file?: unknown; line?: unknown; text?: unknown };
    const text = cleanText(c.text);
    const file = typeof c.file === "string" ? c.file.trim() : "";
    if (!text) throw new ReviewThreadError("Each line comment needs text", 400);
    if (!validFile(file)) {
      throw new ReviewThreadError("A line comment names a file of the change", 400);
    }
    const line =
      c.line === undefined || c.line === null || c.line === "" ? undefined : Number(c.line);
    if (line !== undefined && (!Number.isInteger(line) || line < 1)) {
      throw new ReviewThreadError("A line is a whole number from 1", 400);
    }
    opened.push({ file, ...(line !== undefined ? { line } : {}), text });
  }
  if (opened.length === 0) throw new ReviewThreadError("A comment needs text", 400);
  if (opened.length > MAX_REVIEW_COMMENTS) {
    throw new ReviewThreadError(`A review carries at most ${MAX_REVIEW_COMMENTS} comments`, 400);
  }
  const id = `rvc_${randomUUID().slice(0, 12)}`;
  const threads = opened.map((o) => ({
    id: `thr_${randomUUID().slice(0, 12)}`,
    ...(o.file ? { file: o.file } : {}),
    ...(o.line !== undefined ? { line: o.line } : {}),
  }));
  await store.recordEvent({
    type: REVIEW_COMMENTED,
    cardId: card.id,
    actor: "human",
    principal: input.principal,
    payload: { id, cardId: card.id, threads },
    private: { texts: opened.map((o) => o.text) },
  });
  const all = await reviewThreads(store, card.id, nameOf);
  const ids = new Set(threads.map((t) => t.id));
  return { id, threads: all.filter((t) => ids.has(t.id)) };
}

async function requireThread(store: CardStore, cardId: string, thread: string) {
  const found = (await reviewThreads(store, cardId)).find((t) => t.id === thread);
  if (!found) throw new ReviewThreadError(`No review thread ${thread} on ${cardId}`, 404);
  return found;
}

/** An answer in a thread: `review/commented {replyTo}`, the author as principal. */
export async function replyToThread(
  store: CardStore,
  input: { cardId: string; thread: string; principal: string; text: unknown },
  nameOf?: NameOf,
): Promise<ReviewThread> {
  const card = await openIssue(store, input.cardId);
  await requireThread(store, card.id, input.thread);
  const text = cleanText(input.text);
  if (!text) throw new ReviewThreadError("A reply needs text", 400);
  await store.recordEvent({
    type: REVIEW_COMMENTED,
    cardId: card.id,
    actor: "human",
    principal: input.principal,
    payload: { id: `rvc_${randomUUID().slice(0, 12)}`, cardId: card.id, replyTo: input.thread },
    private: { texts: [text] },
  });
  return (await reviewThreads(store, card.id, nameOf)).find(
    (t) => t.id === input.thread,
  ) as ReviewThread;
}

/** Resolve or reopen a thread, the person as principal; refused when it already is. */
export async function setThreadResolved(
  store: CardStore,
  input: { cardId: string; thread: string; principal: string; resolved: boolean },
  nameOf?: NameOf,
): Promise<ReviewThread> {
  const card = await store.getCard(input.cardId);
  if (!card) throw new ReviewThreadError(`No issue ${input.cardId}`, 404);
  const thread = await requireThread(store, card.id, input.thread);
  if (thread.resolved === input.resolved) {
    throw new ReviewThreadError(
      `The thread on ${threadPlace(thread)} is already ${input.resolved ? "resolved" : "open"}`,
      409,
    );
  }
  await store.recordEvent({
    type: input.resolved ? THREAD_RESOLVED : THREAD_REOPENED,
    cardId: card.id,
    actor: "human",
    principal: input.principal,
    payload: { cardId: card.id, thread: input.thread },
  });
  return (await reviewThreads(store, card.id, nameOf)).find(
    (t) => t.id === input.thread,
  ) as ReviewThread;
}

/**
 * TEAM-24: the accept dismissed because new commits landed before the
 * merge, while the issue has not been accepted again since — what the
 * triage bar says (*Accept dismissed: new commits since it was accepted*).
 */
export async function acceptDismissal(
  store: CardStore,
  cardId: string,
  nameOf?: NameOf,
): Promise<
  | { at: string; pr?: number; headSha?: string; accepter?: string; accepterName?: string }
  | undefined
> {
  const events = await store.cardEvents(cardId, [ACCEPT_DISMISSED, "card/accepted"]);
  const last = events.at(-1);
  if (!last || last.type !== ACCEPT_DISMISSED) return undefined;
  const p = last.payload as { pr?: number; headSha?: string; accepter?: string };
  const card = await store.getCard(cardId);
  if (!card || card.status !== "review") return undefined;
  const accepterName = p.accepter ? nameOf?.(p.accepter) : undefined;
  return {
    at: last.createdAt,
    ...(p.pr !== undefined ? { pr: p.pr } : {}),
    ...(p.headSha ? { headSha: p.headSha } : {}),
    ...(p.accepter ? { accepter: p.accepter } : {}),
    ...(accepterName ? { accepterName } : {}),
  };
}

/**
 * TEAM-25: whether a project requires every review thread resolved before
 * Accept — the last `project/settings_changed` that set it (teams §3), for
 * an Accept that does not come through the dashboard's access fold (the
 * command line, a standing auto-accept).
 */
export async function requiresResolvedThreads(log: EventLog, project: string): Promise<boolean> {
  const changes = await log.getEventsByTypes(["project/settings_changed"]);
  for (let i = changes.length - 1; i >= 0; i--) {
    const p = (changes[i]?.payload ?? {}) as {
      project?: string;
      require_resolved_threads?: boolean;
    };
    if (p.project === project && typeof p.require_resolved_threads === "boolean") {
      return p.require_resolved_threads;
    }
  }
  return false;
}
