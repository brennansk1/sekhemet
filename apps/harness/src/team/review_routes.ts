import type { IncomingMessage, ServerResponse } from "node:http";
import type { CardRecord, CardStore } from "@sekhemet/kernel";
import {
  ReviewThreadError,
  acceptDismissal,
  postReview,
  replyToThread,
  reviewThreads,
  setThreadResolved,
} from "./review_threads.js";

/**
 * The review verdicts' routes (teams NEW-teams-8, §3; PM_CONTRACT §3): an
 * issue's review threads, the *Comment* verdict, a reply, and resolving or
 * reopening a thread. The server's one access check has already decided
 * each write's permission at the issue's project — `comment` to comment or
 * reply (every level, as on a pull request anyone who can read may),
 * `review` to resolve or reopen (a Member) — and a read answers only for a
 * project the person can see (PM-N9-8), as if the issue did not exist.
 */
export interface ReviewRouteContext {
  cardStore: CardStore | undefined;
  projectOf: (card: CardRecord) => string | undefined;
  /** Whether the project requires every review thread resolved before Accept (TEAM-25). */
  requiresResolved: (project: string | undefined) => boolean;
  nameOf: () => (principal: string | undefined) => string | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  principalOf: (req: IncomingMessage) => string;
  canSee: (req: IncomingMessage, project: string | undefined) => boolean;
}

const CARD = "[A-Za-z0-9_.:-]+";
const THREADS = new RegExp(`^/api/cards/(${CARD})/threads$`);
const REVIEWS = new RegExp(`^/api/cards/(${CARD})/reviews$`);
const THREAD = new RegExp(
  `^/api/cards/(${CARD})/threads/(thr_[A-Za-z0-9_-]+)/(replies|resolve|reopen)$`,
);

export async function handleReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: ReviewRouteContext,
): Promise<boolean> {
  const list = THREADS.exec(url);
  const review = REVIEWS.exec(url);
  const thread = THREAD.exec(url);
  if (!list && !review && !thread) return false;
  const method = req.method ?? "GET";
  const store = ctx.cardStore;
  if (!store) {
    ctx.json(
      res,
      method === "GET" ? 200 : 501,
      method === "GET"
        ? { threads: [] }
        : {
            error: "This server was started read-only",
          },
    );
    return true;
  }
  const cardId = (list?.[1] ?? review?.[1] ?? thread?.[1]) as string;
  const card = await store.getCard(cardId);
  if (!card || !ctx.canSee(req, ctx.projectOf(card))) {
    ctx.json(res, 404, { error: `No issue ${cardId}` });
    return true;
  }
  const nameOf = ctx.nameOf();

  if (list && method === "GET") {
    const dismissed = await acceptDismissal(store, card.id, nameOf);
    ctx.json(res, 200, {
      threads: await reviewThreads(store, card.id, nameOf),
      requireResolvedThreads: ctx.requiresResolved(ctx.projectOf(card)),
      ...(dismissed ? { acceptDismissed: dismissed } : {}),
    });
    return true;
  }
  if (method !== "POST" || list) {
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (!ctx.isTrustedMutation(req)) {
    ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
    return true;
  }
  const me = ctx.principalOf(req);
  try {
    const body = await ctx.readJsonBody(req);
    if (review) {
      ctx.json(
        res,
        200,
        await postReview(
          store,
          { cardId: card.id, principal: me, body: body.body, comments: body.comments },
          nameOf,
        ),
      );
      return true;
    }
    const threadId = thread?.[2] as string;
    const verb = thread?.[3];
    const result =
      verb === "replies"
        ? await replyToThread(
            store,
            { cardId: card.id, thread: threadId, principal: me, text: body.text },
            nameOf,
          )
        : await setThreadResolved(
            store,
            { cardId: card.id, thread: threadId, principal: me, resolved: verb === "resolve" },
            nameOf,
          );
    ctx.json(res, 200, { thread: result });
  } catch (err) {
    ctx.json(res, err instanceof ReviewThreadError ? err.status : 409, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
