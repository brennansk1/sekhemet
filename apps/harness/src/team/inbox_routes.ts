import type { IncomingMessage, ServerResponse } from "node:http";
import type { InboxFilter } from "@sekhemet/ui";
import { AiTeammateError } from "./ai_teammates.js";
import {
  type InboxAction,
  type InboxDeps,
  answerMention,
  inboxFor,
  markInboxItem,
  myIssues,
  setWatch,
  watchState,
} from "./inbox.js";

/**
 * The Inbox's routes (teams NEW-teams-7, §3; PM_CONTRACT §3): a person's
 * Inbox by filter, their marks on its items, the *Watch* toggle, My issues,
 * and a comment's author answering whether to invite the people it mentioned
 * who cannot see the project. The server's one access check has already
 * decided each write's permission (`read` for one's own Inbox and Watch,
 * `comment` for the answer) at the issue's project; a read answers only for
 * what the person can see.
 */
export interface InboxRouteContext {
  deps: () => InboxDeps | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  principalOf: (req: IncomingMessage) => string;
  canSee: (req: IncomingMessage, project: string | undefined) => boolean;
}

const CARD = "[A-Za-z0-9_.:-]+";
const ITEM = /^\/api\/inbox\/items\/([A-Za-z0-9_.:%-]+)\/(read|done|undone|snooze|save|unsave)$/;
const WATCH = new RegExp(`^/api/issues/(${CARD})/watch$`);
const MENTION = new RegExp(`^/api/cards/(${CARD})/comments/(cmt_[A-Za-z0-9_-]+)/mention$`);
const FILTERS = new Set<InboxFilter>(["inbox", "saved", "done"]);

export async function handleInboxRoute(
  req: IncomingMessage,
  res: ServerResponse,
  rawUrl: string,
  ctx: InboxRouteContext,
): Promise<boolean> {
  const [url = "", query = ""] = rawUrl.split("?");
  const inbox = url === "/api/inbox";
  const mine = url === "/api/my-issues";
  const item = ITEM.exec(url);
  const watch = WATCH.exec(url);
  const mention = MENTION.exec(url);
  if (!inbox && !mine && !item && !watch && !mention) return false;
  const method = req.method ?? "GET";
  const deps = ctx.deps();
  if (!deps) {
    ctx.json(
      res,
      method === "GET" ? 200 : 501,
      method === "GET"
        ? inbox
          ? { items: [], unread: 0 }
          : mine
            ? { issues: [] }
            : { watching: false, watchers: [] }
        : { error: "This server was started read-only" },
    );
    return true;
  }
  const me = ctx.principalOf(req);
  if (method === "GET") {
    if (inbox) {
      const filter = new URLSearchParams(query).get("filter") as InboxFilter | null;
      ctx.json(
        res,
        200,
        await inboxFor(deps, me, { filter: filter && FILTERS.has(filter) ? filter : "inbox" }),
      );
      return true;
    }
    if (mine) {
      ctx.json(res, 200, { issues: await myIssues(deps, me) });
      return true;
    }
    if (watch) {
      const card = await deps.cardStore.getCard(watch[1] as string);
      if (!card || !ctx.canSee(req, deps.projectOf(card))) {
        ctx.json(res, 404, { error: `No issue ${watch[1]}` });
        return true;
      }
      ctx.json(res, 200, await watchState(deps, card.id, me));
      return true;
    }
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (method !== "POST" || inbox || mine) {
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (!ctx.isTrustedMutation(req)) {
    ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
    return true;
  }
  try {
    const body = await ctx.readJsonBody(req);
    if (item) {
      let id: string;
      try {
        id = decodeURIComponent(item[1] as string);
      } catch {
        ctx.json(res, 400, { error: "That is not an Inbox item" });
        return true;
      }
      await markInboxItem(deps, {
        principal: me,
        item: id,
        action: item[2] as InboxAction,
        until: body.until,
      });
      ctx.json(res, 200, await inboxFor(deps, me));
      return true;
    }
    const cardId = (watch?.[1] ?? mention?.[1]) as string;
    const card = await deps.cardStore.getCard(cardId);
    if (!card || !ctx.canSee(req, deps.projectOf(card))) {
      ctx.json(res, 404, { error: `No issue ${cardId}` });
      return true;
    }
    if (watch) {
      if (typeof body.watch !== "boolean") {
        ctx.json(res, 400, { error: "Say whether to watch: {watch: true | false}" });
        return true;
      }
      await setWatch(deps, { cardId: card.id, principal: me, watch: body.watch });
      ctx.json(res, 200, await watchState(deps, card.id, me));
      return true;
    }
    if (body.answer !== "invite" && body.answer !== "skip") {
      ctx.json(res, 400, { error: "Answer invite or skip" });
      return true;
    }
    await answerMention(deps, {
      cardId: card.id,
      commentId: mention?.[2] as string,
      principal: me,
      answer: body.answer,
    });
    ctx.json(res, 200, { answered: body.answer });
  } catch (err) {
    ctx.json(res, err instanceof AiTeammateError ? err.status : 409, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
