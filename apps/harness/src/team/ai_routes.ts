import type { IncomingMessage, ServerResponse } from "node:http";
import type { Level } from "./access.js";
import {
  AiTeammateError,
  type AiTeammatesDeps,
  agentStatesFor,
  aiStates,
  answerStartRequest,
  issueComments,
  postComment,
  startRequests,
} from "./ai_teammates.js";

/**
 * The AI teammates' routes (teams NEW-teams-5, §3; PM_CONTRACT §3): an
 * issue's comments with the AI teammates' state, a comment (TEAM-15, -39,
 * -40), a Member's answer to a request to start the Agent (TEAM-39), and
 * the requests waiting on the person (their *Needs you*). The server's one
 * access check has already decided each write's permission (`comment`,
 * `agent.start`) at the issue's project; a read answers only for a project
 * the person can see (PM-N9-8), as if the issue did not exist otherwise.
 */
export interface AiRouteContext {
  deps: () => AiTeammatesDeps | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  principalOf: (req: IncomingMessage) => string;
  ceilingOf: (req: IncomingMessage) => Level | undefined;
  canSee: (req: IncomingMessage, project: string | undefined) => boolean;
}

const CARD = "[A-Za-z0-9_.:-]+";
const COMMENTS = new RegExp(`^/api/cards/(${CARD})/comments$`);
const ANSWER = new RegExp(
  `^/api/cards/(${CARD})/agent-requests/(asr_[A-Za-z0-9_-]+)/(start|decline)$`,
);

export async function handleAiTeammateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  ctx: AiRouteContext,
): Promise<boolean> {
  const comments = COMMENTS.exec(url);
  const answer = ANSWER.exec(url);
  const requests = url === "/api/agent/requests";
  const states = url === "/api/agent/states";
  if (!comments && !answer && !requests && !states) return false;
  const method = req.method ?? "GET";
  const deps = ctx.deps();
  if (!deps) {
    ctx.json(
      res,
      method === "GET" ? 200 : 501,
      method === "GET"
        ? { comments: [], ai: [], requests: [], states: [], queue: null }
        : { error: "This server was started read-only" },
    );
    return true;
  }
  const me = ctx.principalOf(req);

  // Teams items 19 and 31: the Agent's state on each issue it is on that the
  // person can see (the board's tiles), and where their own issue stands.
  if (states && method === "GET") {
    ctx.json(res, 200, await agentStatesFor(deps, me, (project) => ctx.canSee(req, project)));
    return true;
  }
  if (states) {
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }

  if (requests && method === "GET") {
    const mine = await startRequests(deps, { for: me });
    const visible = [];
    for (const r of mine) {
      const card = await deps.cardStore.getCard(r.cardId);
      if (card && ctx.canSee(req, deps.projectOf(card))) visible.push(r);
    }
    ctx.json(res, 200, { requests: visible });
    return true;
  }

  const cardId = (comments?.[1] ?? answer?.[1]) as string | undefined;
  const card = cardId ? await deps.cardStore.getCard(cardId) : undefined;
  if (!card || !ctx.canSee(req, deps.projectOf(card))) {
    ctx.json(res, 404, { error: `No issue ${cardId ?? ""}` });
    return true;
  }

  if (comments && method === "GET") {
    ctx.json(res, 200, {
      comments: await issueComments(deps, card.id, me),
      ai: await aiStates(deps, card.id, me),
      requests: await startRequests(deps, { cardId: card.id }),
    });
    return true;
  }
  if (method !== "POST") {
    ctx.json(res, 405, { error: "Method not allowed." });
    return true;
  }
  if (!ctx.isTrustedMutation(req)) {
    ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
    return true;
  }
  try {
    if (comments) {
      const body = await ctx.readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.slice(0, 8000) : "";
      const ceiling = ctx.ceilingOf(req);
      ctx.json(
        res,
        200,
        await postComment(deps, {
          cardId: card.id,
          principal: me,
          text,
          ...(ceiling ? { ceiling } : {}),
        }),
      );
      return true;
    }
    ctx.json(
      res,
      200,
      await answerStartRequest(deps, {
        cardId: card.id,
        requestId: answer?.[2] as string,
        principal: me,
        answer: answer?.[3] === "start" ? "started" : "declined",
      }),
    );
  } catch (err) {
    ctx.json(res, err instanceof AiTeammateError ? err.status : 409, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
