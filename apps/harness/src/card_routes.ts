/**
 * The dashboard server's own `/api/cards/:id` routes, in one module with one
 * routing style (FINDINGS_C1 NAM-03; CLAUDE.md's strangler fig): a table of
 * method, path and handler, matched in order by `handleCardRoute`. They
 * once sat inline in `startDashboardServer`'s closure among other routes,
 * each matched its own way; the move changed no answer
 * (`tests/card_routes.spec.ts` pins each over HTTP).
 *
 * A handler that returns `false` declines, and the request falls through
 * to the server's later routes, as the inline routes did when the server had
 * no ledger. A route whose method differs is not tried. The other modules
 * that answer under `/api/cards/` (run_routes, github_routes, plan_approval,
 * pm_api, team/review_routes, team/ai_routes, team/inbox_routes) keep their
 * own matching until a change takes each of them through here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BoardService } from "@sekhemet/board";
import {
  CARD_STATUSES,
  type CardRecord,
  type CardStore,
  type EventLog,
  isCardStatus,
} from "@sekhemet/kernel";
import { RevertConflictError, checkoutNotice, integrationBranch } from "./accept.js";
import { contextForCard } from "./card_root.js";
import {
  cardMessages,
  handBack,
  postCardMessage,
  requestPause,
  submitTakenOver,
  takeOver,
} from "./collaborate.js";
import { liveSteps, readTranscript, transcriptFiles } from "./dashboard_api.js";
import { acceptCard, explainCard, forkCard, requestAbort, rewindCard } from "./execute.js";
import { reviewBrief } from "./github_routes.js";
import { cardBranch } from "./ledger_evidence.js";
import { reviewDesk } from "./review_desk.js";
import type { Access } from "./team/access.js";
import { type AiTeammatesDeps, aiStates } from "./team/ai_teammates.js";
import type { InboxDeps } from "./team/inbox.js";
import { TriageError, triageIssue } from "./team/intake.js";
import { acceptDismissal, openThreadRefusal, reviewThreads } from "./team/review_threads.js";
import { cardTrace } from "./tracing.js";
import {
  park,
  recordReviewOpened,
  reject,
  reopen,
  revertAccept,
  sendBack,
  unpark,
} from "./triage.js";

/** An issue id in a path, as the server matches it. */
const CARD_ID = "[A-Za-z0-9_.-]+";

/** What the routes read from the server: its stores and its per-request helpers. */
export interface CardRouteDeps {
  repoPath: string;
  db: DatabaseSync;
  /** Absent on a read-only server. */
  cardStore?: CardStore;
  boardService: BoardService;
  log: EventLog;
  setup: "solo" | "team";
  json(res: ServerResponse, status: number, body: unknown): void;
  readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  isTrustedMutation(req: IncomingMessage): boolean;
  principalOf(req: IncomingMessage): string;
  /** PM-N9-8: whether the person may see a project's planning. */
  canSee(req: IncomingMessage, project: string | undefined): boolean;
  projectOfCard(card: CardRecord | undefined): string | undefined;
  access: Pick<Access, "acceptHolders" | "settings">;
  namesOf(): (principal: string | undefined) => string | undefined;
  attemptsFor(cardId: string): { summary: unknown; path: string }[];
  acceptanceSources(card: CardRecord): unknown[];
  /** An issue with its board presentation (`withDisplay`). */
  presentCard(card: CardRecord, cards: CardRecord[]): unknown;
  aiDeps(): (AiTeammatesDeps & InboxDeps) | undefined;
}

/** One request, as a route sees it. */
export interface CardRouteContext extends CardRouteDeps {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
}

export interface CardRoute {
  /** The method it answers; any method when absent. */
  method?: "GET" | "POST";
  path: RegExp;
  /** Answers the request; `false` declines it, and the server's later routes are tried. */
  handle(route: CardRouteContext, m: RegExpExecArray): Promise<unknown>;
}

/** The routes, in the order the server tried them inline. */
export const CARD_ROUTES: CardRoute[] = [
  // Dashboard DB-N10-3: a Member's triage decision on an untriaged issue —
  // Accept into Backlog, Decline, Duplicate of or Snooze — as `issue/triaged`.
  {
    method: "POST",
    path: new RegExp(`^/api/cards/(${CARD_ID})/triage$`),
    async handle(route, m) {
      const { req, res, json, readJsonBody, isTrustedMutation, principalOf, canSee } = route;
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Triage must come from the dashboard itself" });
        return;
      }
      const deps = route.aiDeps();
      if (!deps) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const card = await deps.cardStore.getCard(m[1] as string);
      if (!card || !canSee(req, route.projectOfCard(card))) {
        json(res, 404, { error: `No issue ${m[1]}` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const done = await triageIssue(
          { ...deps, boardService: route.boardService, repoPath: route.repoPath },
          {
            cardId: card.id,
            principal: principalOf(req),
            decision: body.decision,
            reason: body.reason,
            duplicateOf: body.duplicateOf,
            until: body.until,
          },
        );
        json(res, 200, { decision: done.decision, card: done.card });
      } catch (err) {
        json(res, err instanceof TriageError ? err.status : 409, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  },
  // One attempt's steps: the transcript file, or live `card/step` events
  // while the card is still running and the transcript is not yet written.
  {
    path: new RegExp(`^/api/cards/(${CARD_ID})/transcript$`),
    async handle(route, m) {
      const { res, query, json, repoPath, db, boardService } = route;
      const cardId = m[1] as string;
      const files = transcriptFiles(repoPath, cardId);
      const card = (await boardService.getBoardState()).cards.find((c) => c.id === cardId);
      if (!card) {
        json(res, 404, { error: `No issue ${cardId}` });
        return;
      }
      const wanted = query.get("attempt");
      const running = card.status === "in_progress";
      const total = files.length + (running ? 1 : 0);
      const n = wanted !== null ? Number(wanted) : total;
      if (total === 0) {
        json(res, 200, { attempt: 0, attempts: 0, file: null, live: false, steps: [] });
        return;
      }
      if (!Number.isInteger(n) || n < 1 || n > total) {
        json(res, 404, { error: `No attempt ${wanted} recorded for this issue` });
        return;
      }
      if (running && n === total) {
        json(res, 200, {
          attempt: n,
          attempts: total,
          file: null,
          live: true,
          steps: liveSteps(db, cardId),
        });
        return;
      }
      const file = files[n - 1] as string;
      json(res, 200, {
        attempt: n,
        attempts: total,
        file: basename(file),
        live: false,
        steps: readTranscript(file),
      });
      return;
    },
  },
  // RUN-46: a card's trace — card, step, model-request and tool-call spans.
  {
    method: "GET",
    path: new RegExp(`^/api/cards/(${CARD_ID})/traces$`),
    async handle(route, m) {
      const { res, json, repoPath } = route;
      json(res, 200, { spans: cardTrace(repoPath, m[1] as string) });
      return;
    },
  },
  // NEW-dashboard-5: what Accept will ask of this viewer, before it is pressed.
  {
    method: "GET",
    path: new RegExp(`^/api/cards/(${CARD_ID})/review$`),
    async handle(route, m) {
      const {
        req,
        res,
        json,
        principalOf,
        canSee,
        projectOfCard,
        access,
        namesOf,
        repoPath,
        cardStore,
        boardService,
        log,
      } = route;
      const store = cardStore;
      const card = store ? await store.getCard(m[1] as string) : undefined;
      // PM-N9-8: a card whose project the person cannot see is no card to them.
      if (!store || !card || !canSee(req, projectOfCard(card))) {
        json(res, 404, { error: `No issue ${m[1]}` });
        return;
      }
      const holders = access.acceptHolders(projectOfCard(card));
      // Teams item 25 (TEAM-24, -25): the review threads, whether the project
      // requires them resolved and the open one Accept then waits on, and an
      // accept that new commits dismissed.
      const nameOf = namesOf();
      const threads = await reviewThreads(store, card.id, nameOf);
      const requireResolvedThreads =
        access.settings(projectOfCard(card)).require_resolved_threads === true;
      const openThread = requireResolvedThreads ? openThreadRefusal(threads) : undefined;
      const acceptDismissed = await acceptDismissal(store, card.id, nameOf);
      json(res, 200, {
        // P12, P14, RG-N5-3: the route's earlier fields stay in its contract.
        ...(await reviewBrief(
          contextForCard({ repoPath, cardStore: store }, card).repoPath,
          store,
          log,
          card,
        )),
        ...(await reviewDesk(
          { repoPath, cardStore: store, boardService: boardService as never, eventLog: log },
          card,
          principalOf(req),
          { acceptHolders: holders, nameOf },
        )),
        threads,
        requireResolvedThreads,
        ...(openThread ? { openThread } : {}),
        ...(acceptDismissed ? { acceptDismissed } : {}),
      });
      return;
    },
  },
  // One card with its presentation and its attempt history.
  // NEW-dashboard-14 (DB-N14-2): Ready to start, read from the board's own entry
  // conditions; it moves nothing and records nothing (DB-N14-3).
  {
    method: "GET",
    path: new RegExp(`^/api/cards/(${CARD_ID})/readiness$`),
    async handle(route, m) {
      const { req, res, json, canSee, projectOfCard, cardStore, boardService } = route;
      const card = await cardStore?.getCard(m[1] as string);
      const read = (boardService as { readiness?: (c: CardRecord) => Promise<unknown[]> })
        .readiness;
      // PM-N9-8: a card whose project the person cannot see is no card to them.
      if (!card || !read || !canSee(req, projectOfCard(card))) {
        json(res, 404, { error: "No such issue." });
        return;
      }
      json(res, 200, { readiness: await read.call(boardService, card) });
      return;
    },
  },
  {
    method: "GET",
    path: new RegExp(`^/api/cards/(${CARD_ID})$`),
    async handle(route, m) {
      const {
        req,
        res,
        json,
        principalOf,
        attemptsFor,
        acceptanceSources,
        presentCard,
        aiDeps,
        repoPath,
        cardStore,
        boardService,
      } = route;
      const state = await boardService.getBoardState();
      const card = state.cards.find((c) => c.id === m[1]);
      if (!card) {
        json(res, 404, { error: `No issue ${m[1]}` });
        return;
      }
      json(res, 200, {
        card: presentCard(card, state.cards),
        attempts: attemptsFor(card.id).map((a) => a.summary),
        acceptance: acceptanceSources(card),
        // PM-N8-2: what the card waits on and why (declared, named, imported).
        dependencies: cardStore?.getDependencyReasons(card.id) ?? [],
        // TEAM-15: the AI teammates' state on the issue, as the harness knows it.
        ai: await (async () => {
          const deps = aiDeps();
          return deps ? aiStates(deps, card.id, principalOf(req)) : [];
        })(),
        // §2.6 properties rail (ISS-01): the issue's branch, once a run made one.
        ...(() => {
          const b = cardBranch(repoPath, card.id);
          return b ? { branch: b.name } : {};
        })(),
      });
      return;
    },
  },
  // Triage: accept, send back, park, reject (Won't do), reopen, revert, and the
  // files a review opened (dashboard §2.6 Issue actions, NEW-dashboard-21).
  {
    method: "POST",
    path: new RegExp(
      `^/api/cards/(${CARD_ID})/(accept|return|park|unpark|reject|reopen|revert|opened)$`,
    ),
    async handle(route, m) {
      const {
        req,
        res,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        projectOfCard,
        access,
        namesOf,
        repoPath,
        cardStore,
        boardService,
        log,
      } = route;
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Triage actions must come from the dashboard itself" });
        return;
      }
      const store = cardStore;
      if (!store) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const [, cardId, verb] = m as unknown as [string, string, string];
      const card = await store.getCard(cardId);
      if (!card) {
        json(res, 404, { error: `No issue ${cardId}` });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const ctx = {
          repoPath,
          restrictedMode: false,
          cardStore: store,
          boardService: boardService as never,
          // DS-N3-1: the project documents follow a person's accept.
          eventLog: log,
        };
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        // review-git §2.4.3 (RG-S6-6): the files the dashboard showed, recorded.
        if (verb === "opened") {
          await recordReviewOpened(ctx, card, strings(body.filesShown), principalOf(req));
          json(res, 200, { ok: true });
          return;
        }
        if (verb === "accept") {
          // INT-22, INT-23: the project's Accept rule decides, and the
          // accepter's principal is recorded on `card/accepted`.
          const holders = access.acceptHolders(projectOfCard(card));
          const sha = await acceptCard(ctx, card, "human", {
            principal: principalOf(req),
            acknowledgedFindings: strings(body.acknowledgedFindings),
            ...(holders ? { acceptHolders: holders } : {}),
            // TEAM-25: the project's rule, from the same fold as its Accept rule.
            requireResolvedThreads:
              access.settings(projectOfCard(card)).require_resolved_threads === true,
            nameOf: namesOf(),
          });
          // A checkout on the integration branch is told how to catch up (RG-S5-2).
          const notice = sha.startsWith("http")
            ? undefined
            : checkoutNotice(repoPath, integrationBranch(repoPath), sha);
          json(res, 200, {
            ok: true,
            status: sha.startsWith("http") ? "review" : "done",
            sha,
            ...(notice ? { notice } : {}),
          });
          return;
        }
        if (verb === "revert") {
          const sha = await revertAccept(
            ctx,
            card,
            typeof body.reason === "string" ? body.reason : "",
            principalOf(req),
            access.acceptHolders(projectOfCard(card)),
          );
          json(res, 200, { ok: true, status: "ready", sha });
          return;
        }

        // Status's Needs you (DB-P5-1): back where it was parked from, as `sekhemet unpark`.
        if (verb === "unpark") {
          const to = await unpark(
            {
              repoPath,
              cardStore: store,
              boardService: boardService as never,
              log,
              principal: principalOf(req),
            },
            card,
          );
          json(res, 200, { ok: true, status: to });
          return;
        }
        const reason = typeof body.reason === "string" ? body.reason : "";
        if (verb === "return" && !reason.trim()) {
          json(res, 400, {
            error: "Request changes needs a reason: it is what the Agent is told next",
          });
          return;
        }
        // One implementation for the board and the command line (triage.ts).
        const triage = {
          repoPath,
          cardStore: store,
          boardService: boardService as never,
          log,
          principal: principalOf(req),
        };
        // DB-N21-2: Reopen, Won't do's undo, puts the issue back in To do.
        if (verb === "reopen") {
          await reopen(triage, card, reason);
          json(res, 200, { ok: true, status: "ready" });
          return;
        }
        const to = verb === "return" ? "ready" : verb === "reject" ? "rejected" : "parked";
        if (verb === "return") {
          const comments = Array.isArray(body.comments)
            ? (body.comments as { file?: unknown; line?: unknown; text?: unknown }[]).map((c) => ({
                file: String(c.file ?? ""),
                line: Number(c.line),
                text: String(c.text ?? ""),
              }))
            : [];
          await sendBack(triage, card, reason, { comments });
        } else if (verb === "reject") await reject(triage, card, reason);
        else await park(triage, card, reason);
        json(res, 200, { ok: true, status: to });
      } catch (err) {
        json(res, 409, {
          error: err instanceof Error ? err.message : String(err),
          // DB-N21-4: a revert git cannot apply names its files.
          ...(err instanceof RevertConflictError ? { files: err.files } : {}),
        });
      }
      return;
    },
  },
  // Human commands (B12): why an issue is where it is.
  {
    path: new RegExp(`^/api/cards/(${CARD_ID})/explain$`),
    async handle(route, m) {
      const { res, json, repoPath, cardStore, boardService } = route;
      if (!cardStore) return false;
      try {
        json(res, 200, {
          lines: await explainCard(
            {
              repoPath,
              restrictedMode: false,
              cardStore: cardStore,
              boardService: boardService as never,
            },
            m[1] as string,
          ),
        });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    },
  },
  // WL-N10-1: a card's messages and hand-back notes, each with the step it reached.
  {
    method: "GET",
    path: new RegExp(`^/api/cards/(${CARD_ID})/messages$`),
    async handle(route, m) {
      const { res, json, namesOf, cardStore } = route;
      if (!cardStore) return false;
      // The issue page's Activity names who wrote each one (DB-N8-1).
      const nameOf = namesOf();
      json(res, 200, {
        messages: (await cardMessages(cardStore, m[1] as string)).map((msg) => {
          const principalName = nameOf(msg.principal);
          return principalName ? { ...msg, principalName } : msg;
        }),
      });
      return;
    },
  },
  // Runner control (L25, H18, H19), collaboration (WL-N10, DEC-34), override, reroute and order (B11).
  {
    method: "POST",
    path: new RegExp(
      `^/api/cards/(${CARD_ID})/(abort|rewind|fork|override|reroute|reorder|message|pause|hand-back|take-over|submit-take-over)$`,
    ),
    async handle(route, m) {
      const {
        req,
        res,
        json,
        readJsonBody,
        isTrustedMutation,
        principalOf,
        repoPath,
        cardStore,
        boardService,
        setup,
      } = route;
      if (!isTrustedMutation(req)) {
        json(res, 403, { error: "Commands must come from the dashboard itself" });
        return;
      }
      const store = cardStore;
      if (!store) {
        json(res, 501, { error: "This server was started read-only" });
        return;
      }
      const ctx = {
        repoPath,
        restrictedMode: false,
        cardStore: store,
        boardService: boardService as never,
      };
      try {
        const body = await readJsonBody(req);
        const [, cardId, verb] = m as unknown as [string, string, string];
        const card = await store.getCard(cardId);
        if (!card) {
          json(res, 404, { error: `No issue ${cardId}` });
          return;
        }
        if (verb === "abort") {
          const reason = typeof body.reason === "string" ? body.reason : "";
          await requestAbort(store, cardId, reason || "stopped from the dashboard");
          json(res, 200, { ok: true, requested: "abort" });
          return;
        }
        // WL-N10-1..3: collaborate on a running issue (DEC-34).
        if (verb === "message") {
          const text = typeof body.text === "string" ? body.text.trim() : "";
          if (!text) {
            json(res, 400, { error: "A message needs text" });
            return;
          }
          await postCardMessage(store, cardId, text, principalOf(req));
          json(res, 200, { ok: true });
          return;
        }
        if (verb === "pause") {
          await requestPause(store, cardId, principalOf(req));
          json(res, 200, { ok: true, requested: "pause" });
          return;
        }
        if (verb === "hand-back" || verb === "take-over" || verb === "submit-take-over") {
          try {
            if (verb === "hand-back") {
              await handBack(
                ctx,
                cardId,
                typeof body.note === "string" ? body.note : "",
                principalOf(req),
              );
              json(res, 200, { ok: true });
            } else if (verb === "take-over") {
              json(res, 200, { ok: true, ...(await takeOver(ctx, cardId, principalOf(req))) });
            } else {
              json(res, 200, {
                ok: true,
                ...(await submitTakenOver(ctx, cardId, principalOf(req))),
              });
            }
          } catch (err) {
            json(res, 409, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }
        if (verb === "rewind" || verb === "fork") {
          const step = Number(body.step);
          if (!Number.isInteger(step) || step < 0) {
            json(res, 400, { error: "A step number is required" });
            return;
          }
          const r =
            verb === "fork"
              ? await forkCard(
                  ctx,
                  cardId,
                  step,
                  typeof body.attemptId === "string" ? body.attemptId : undefined,
                )
              : await rewindCard(ctx, cardId, step);
          json(res, 200, { ok: true, ...r });
          return;
        }
        if (verb === "override") {
          // Past an entry condition or an illegal edge, as a recorded human decision (B1).
          const to = body.toStatus;
          const reason = typeof body.reason === "string" ? body.reason.trim() : "";
          if (typeof to !== "string" || !reason) {
            json(res, 400, { error: "An override needs toStatus and a reason" });
            return;
          }
          // K-S7-5: a value outside the nine states is refused before anything is appended.
          if (!isCardStatus(to)) {
            json(res, 400, {
              error: `'${to}' is not an issue state; use one of ${CARD_STATUSES.join(", ")}`,
            });
            return;
          }
          // Rule 28: an override names the person who takes responsibility —
          // the one given, or the install's own person on a solo setup (rule 19).
          // In the Team setup it is always the person who asked (M4).
          const named =
            typeof body.principal === "string" && body.principal.trim()
              ? body.principal.trim()
              : undefined;
          const principal = setup === "team" || !named ? principalOf(req) : named;
          try {
            await boardService.transitionCard({
              cardId,
              fromStatus: card.status,
              toStatus: to,
              actor: "human",
              reason: `override: ${reason}`,
              ...(principal ? { principal } : {}),
            });
          } catch (err) {
            // B12: a security-layer failure is the one refusal an override
            // does not carry. Answered with its own code so the dashboard can
            // say why rather than showing a generic conflict.
            if ((err as { code?: string }).code === "security_gate") {
              json(res, 403, {
                error: err instanceof Error ? err.message : String(err),
                refused: "security_gate",
              });
              return;
            }
            throw err;
          }
          json(res, 200, { ok: true, status: to });
          return;
        }
        if (verb === "reroute") {
          // Which model runs the card next (B12 "reroute").
          const executor = typeof body.executor === "string" ? body.executor : undefined;
          const planner = typeof body.planner === "string" ? body.planner : undefined;
          if (!executor && !planner) {
            json(res, 400, { error: "Name an executor or a planner" });
            return;
          }
          const updated = await store.updateCard(
            cardId,
            {
              modelRoute: {
                ...(card.modelRoute ?? {}),
                ...(executor ? { executor } : {}),
                ...(planner ? { planner } : {}),
              },
            },
            "human",
            { principal: principalOf(req) },
          );
          json(res, 200, { ok: true, modelRoute: updated.modelRoute });
          return;
        }
        // reorder (B11): place the card between two neighbours.
        const updated = await store.reorderCard(
          cardId,
          {
            ...(typeof body.afterCardId === "string" ? { afterCardId: body.afterCardId } : {}),
            ...(typeof body.beforeCardId === "string" ? { beforeCardId: body.beforeCardId } : {}),
          },
          "human",
          { principal: principalOf(req) },
        );
        json(res, 200, { ok: true, orderKey: updated.orderKey });
      } catch (err) {
        json(res, 409, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    },
  },
  // Run records (K8): each attempt with its steps and checks, and the evidence.
  {
    path: new RegExp(`^/api/cards/(${CARD_ID})/attempts$`),
    async handle(route, m) {
      const { res, json, cardStore } = route;
      if (!cardStore) return false;
      const runs = cardStore.runs;
      const attempts = runs.listAttempts(m[1] as string).map((a) => ({
        ...a,
        steps: runs.listSteps(a.id),
        gates: runs.listGateResults(a.id),
      }));
      json(res, 200, { attempts, evidence: runs.listEvidence(m[1] as string) });
      return;
    },
  },
];

/**
 * Answer `url` from the table when a route takes it: true when answered,
 * false when no route did (the server's later routes are tried).
 */
export async function handleCardRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  query: URLSearchParams,
  deps: CardRouteDeps,
): Promise<boolean> {
  for (const r of CARD_ROUTES) {
    if (r.method && r.method !== req.method) continue;
    const m = r.path.exec(url);
    if (!m) continue;
    if ((await r.handle({ ...deps, req, res, query }, m)) === false) continue;
    return true;
  }
  return false;
}
