import type { IncomingMessage, ServerResponse } from "node:http";
import type { BoardService } from "@sekhemet/board";
import type { CardStore, CardUpdate, EventLog } from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { handleIntegrationsApi } from "./integrations.js";
import { ProposalError, applyProposal } from "./pm/apply.js";
import { flowMetrics } from "./pm/metrics.js";
import { DEFAULT_PM_MODEL, answerQueued, createPmAdapter, runnerLease } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import { PM_EVENTS, type PmMessage, type PmStatus } from "./pm/types.js";

export interface PmApiContext {
  repoPath: string;
  log: EventLog;
  boardService: BoardService;
  /** Present only when the server was started with triage enabled. */
  cardStore?: CardStore;
  pmModel?: string;
  /** Injectable for tests: the PM model the server answers with. */
  pmAdapter?: () => LocalInferenceAdapter;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
}

const CARD_ID = "[A-Za-z0-9_-]+";

/** Card fields the dashboard may edit inline (PM_CONTRACT §2). */
const PATCHABLE: Record<string, (v: unknown) => unknown> = {
  priority: (v) => (typeof v === "number" && v >= 0 && v <= 4 ? Math.round(v) : undefined),
  estimate: (v) => (v === null ? null : typeof v === "number" && v >= 0 ? v : undefined),
  labels: (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim()) : undefined,
  epicId: (v) => (v === null || typeof v === "string" ? v : undefined),
  cycleId: (v) => (v === null || typeof v === "string" ? v : undefined),
  assignee: (v) => (v === null || typeof v === "string" ? v : undefined),
  dueDate: (v) =>
    v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : undefined,
  title: (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined),
};

/**
 * Routes for the PM conversation, proposals, cycles, inline edits, flow
 * metrics and integrations. Returns true when it handled the request.
 */
export function createPmApi(ctx: PmApiContext) {
  const pmStore = new PmStore(ctx.log);
  const pmModel = ctx.pmModel ?? DEFAULT_PM_MODEL;
  let answering: Promise<void> | undefined;

  /**
   * Answer from the dashboard process, but only when no queue is running: a
   * queue holds the Worker in memory and is the only process that can safely
   * swap it out for the PM.
   */
  const kick = (): void => {
    if (answering || !ctx.cardStore || runnerLease(ctx.repoPath)) return;
    const cardStore = ctx.cardStore;
    const adapter = (ctx.pmAdapter ?? (() => createPmAdapter(pmModel)))();
    answering = (async () => {
      // Messages that arrive while the PM is answering are picked up next.
      while (
        await answerQueued({
          repoPath: ctx.repoPath,
          cardStore,
          pmStore,
          pmModel,
          acquire: async () => adapter,
        })
      ) {
        // loop until the queue is empty
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        answering = undefined;
      });
  };

  const mutationGuard = (req: IncomingMessage, res: ServerResponse): CardStore | undefined => {
    if (!ctx.isTrustedMutation(req)) {
      ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
      return undefined;
    }
    if (!ctx.cardStore) {
      ctx.json(res, 501, { error: "This server was started read-only" });
      return undefined;
    }
    return ctx.cardStore;
  };

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    // --- Chat ---------------------------------------------------------------
    if (url === "/api/pm/thread" && req.method === "GET") {
      const since = Number(query.get("since") ?? 0) || 0;
      const lease = runnerLease(ctx.repoPath);
      ctx.json(res, 200, {
        messages: await pmStore.thread(since),
        status: await pmStore.status(),
        model: lease?.pmModel ?? pmModel,
      });
      return true;
    }

    if (url === "/api/pm/messages" && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      const body = await ctx.readJsonBody(req);
      const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
      if (!text) {
        ctx.json(res, 400, { error: "A message needs text" });
        return true;
      }
      const raw = (body.context ?? {}) as Record<string, unknown>;
      const context = {
        ...(typeof raw.cardId === "string" ? { cardId: raw.cardId } : {}),
        ...(typeof raw.view === "string" ? { view: raw.view } : {}),
      };
      const message = await pmStore.appendUserMessage(text, context);
      const lease = runnerLease(ctx.repoPath);
      if (lease) {
        // The queue answers after the Worker's current step.
        await pmStore.setStatus({
          phase: "waiting_for_step",
          detail: "Pausing the Worker after its current step",
          model: lease.pmModel ?? pmModel,
          workerPaused: false,
        });
      } else {
        kick();
      }
      ctx.json(res, 200, { message });
      return true;
    }

    const proposal = /^\/api\/pm\/proposals\/([A-Za-z0-9_-]+)\/(apply|discard)$/.exec(url);
    if (proposal && req.method === "POST") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const [, id, verb] = proposal as unknown as [string, string, string];
      const found = await pmStore.proposal(id);
      if (!found) {
        ctx.json(res, 404, { error: `No proposal ${id}` });
        return true;
      }
      if (verb === "discard") {
        if (found.state !== "open") {
          ctx.json(res, 409, { error: `This proposal is already ${found.state}.` });
          return true;
        }
        await pmStore.setProposalState(id, "discarded");
        ctx.json(res, 200, { proposal: { ...found, state: "discarded" } });
        return true;
      }
      try {
        ctx.json(
          res,
          200,
          await applyProposal(found, {
            cardStore,
            boardService: ctx.boardService,
            pmStore,
            actor: "human",
          }),
        );
      } catch (err) {
        ctx.json(res, err instanceof ProposalError ? err.status : 409, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // --- Cycles -------------------------------------------------------------
    if (url === "/api/cycles" && req.method === "GET") {
      ctx.json(res, 200, { cycles: await pmStore.cycles() });
      return true;
    }
    if (url === "/api/cycles" && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      const b = await ctx.readJsonBody(req);
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (
        !name ||
        typeof b.startsOn !== "string" ||
        !iso.test(b.startsOn) ||
        typeof b.endsOn !== "string" ||
        !iso.test(b.endsOn)
      ) {
        ctx.json(res, 400, { error: "A cycle needs a name, startsOn and endsOn (YYYY-MM-DD)" });
        return true;
      }
      const cycle = await pmStore.createCycle({
        name,
        startsOn: b.startsOn,
        endsOn: b.endsOn,
        ...(typeof b.goal === "string" && b.goal.trim() ? { goal: b.goal.trim() } : {}),
        ...(b.state === "active" || b.state === "planned" ? { state: b.state } : {}),
      });
      ctx.json(res, 200, { cycle });
      return true;
    }
    const cycleMatch = /^\/api\/cycles\/([A-Za-z0-9_-]+)$/.exec(url);
    if (cycleMatch && req.method === "PATCH") {
      if (!mutationGuard(req, res)) return true;
      const b = await ctx.readJsonBody(req);
      const patch: Record<string, unknown> = {};
      for (const k of ["name", "startsOn", "endsOn", "goal"]) {
        if (typeof b[k] === "string") patch[k] = b[k];
      }
      if (b.state === "planned" || b.state === "active" || b.state === "closed") {
        patch.state = b.state;
      }
      const updated = await pmStore.updateCycle(cycleMatch[1] as string, patch);
      if (!updated) ctx.json(res, 404, { error: "No such cycle" });
      else ctx.json(res, 200, { cycle: updated });
      return true;
    }

    // --- Inline card edits --------------------------------------------------
    const cardMatch = new RegExp(`^/api/cards/(${CARD_ID})$`).exec(url);
    if (cardMatch && req.method === "PATCH") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const id = cardMatch[1] as string;
      if (!(await cardStore.getCard(id))) {
        ctx.json(res, 404, { error: `No card ${id}` });
        return true;
      }
      const b = await ctx.readJsonBody(req);
      const patch: Record<string, unknown> = {};
      const rejected: string[] = [];
      for (const [k, v] of Object.entries(b)) {
        const parse = PATCHABLE[k];
        const value = parse ? parse(v) : undefined;
        if (value === undefined) rejected.push(k);
        else patch[k] = value;
      }
      if (Object.keys(patch).length === 0) {
        ctx.json(res, 400, { error: `Nothing editable in ${rejected.join(", ") || "the body"}` });
        return true;
      }
      const card = await cardStore.updateCard(id, patch as CardUpdate, "human");
      ctx.json(res, 200, { card, ...(rejected.length ? { ignored: rejected } : {}) });
      return true;
    }

    // --- Flow metrics -------------------------------------------------------
    if (url === "/api/metrics/flow" && req.method === "GET") {
      const days = Math.min(365, Math.max(1, Number(query.get("days") ?? 30) || 30));
      ctx.json(res, 200, await flowMetrics(ctx.log, days));
      return true;
    }

    return handleIntegrationsApi(req, res, url, query, {
      ...ctx,
      pmStore,
      mutationGuard,
    });
  }

  /**
   * SSE frames for PM activity in a batch of new ledger events, so the chat
   * updates without polling.
   */
  async function streamFrames(events: { seq: number; type: string }[]): Promise<string[]> {
    const frames: string[] = [];
    const pmEvents = events.filter((e) => e.type.startsWith("pm/"));
    if (pmEvents.length === 0) return frames;
    if (pmEvents.some((e) => e.type !== PM_EVENTS.status)) {
      const first = Math.min(...pmEvents.map((e) => e.seq));
      // Re-send from the first changed message, plus any message whose state a
      // later event changed (a reply marks its question done).
      const thread: PmMessage[] = await pmStore.thread();
      for (const message of thread.filter(
        (m) => m.seq >= first || m.state === "done" || m.proposals,
      )) {
        if (message.seq < first - 50) continue;
        frames.push(`event: pm\ndata: ${JSON.stringify({ kind: "message", message })}\n\n`);
      }
    }
    if (pmEvents.some((e) => e.type === PM_EVENTS.status)) {
      const status: PmStatus = await pmStore.status();
      frames.push(`event: pm\ndata: ${JSON.stringify({ kind: "status", status })}\n\n`);
    }
    return frames;
  }

  return { handle, streamFrames, pmStore };
}
