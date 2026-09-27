import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { BoardService } from "@sekhemet/board";
import {
  type CardStore,
  type CardUpdate,
  DEPTH_PROFILES,
  EventLog,
  nearestCardEstimate,
  parseDepthProfile,
} from "@sekhemet/kernel";
import type { LocalInferenceAdapter } from "@sekhemet/models";
import { readKernelPressureLevel } from "@sekhemet/models";
import { resolvePlannerModel } from "@sekhemet/planner";
import { quickCreateRequest } from "@sekhemet/ui";
import { effectiveConfig } from "./config_apply.js";
import { recommendRoster } from "./init.js";
import { handleIntegrationsApi } from "./integrations.js";
import { readSettings } from "./integrations.js";
import { learnFromProposalChoices } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import { sharedModelAccess } from "./model_access.js";
import { ProposalError, applyProposal } from "./pm/apply.js";
import { type Audience, soloAudience } from "./pm/audience.js";
import { capabilityReport } from "./pm/capability.js";
import { burnupMetrics, flowMetrics, pmQuality } from "./pm/metrics.js";
import type { ProjectChoices } from "./pm/pipeline.js";
import { DEFAULT_PM_MODEL, answerQueued, pmModelFor, runnerLease } from "./pm/service.js";
import { PmStore } from "./pm/store.js";
import {
  SuggestionError,
  applySuggestion,
  dismissSuggestion,
  suggestionsOn,
} from "./pm/suggest.js";
import { PM_EVENTS, type PmMessage, type PmStatus } from "./pm/types.js";
import { draftWeeklyUpdate, postWeeklyUpdate } from "./pm/weekly.js";
import { seshatWait } from "./pm/while_worker.js";
import { oneShotResearcher } from "./research/service.js";
import { quickAnswererFor } from "./smart_swap.js";
import { modelRegistry, ruleGateVerdict } from "./wave2.js";

export interface PmApiContext {
  repoPath: string;
  log: EventLog;
  boardService: BoardService;
  /** Present only when the server was started with triage enabled. */
  cardStore?: CardStore;
  pmModel?: string;
  /** Injectable for tests: the PM model the server answers with. */
  pmAdapter?: () => LocalInferenceAdapter;
  /** Injectable for tests: kernel memory-pressure level (1 normal). */
  pressureLevel?: () => number | undefined;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  readJsonBody: (req: IncomingMessage, limit?: number) => Promise<Record<string, unknown>>;
  isTrustedMutation: (req: IncomingMessage) => boolean;
  /** The person a request is for (teams §2.3, kernel rule 19); the server's one resolver. */
  principalOf?: (req: IncomingMessage) => string;
  /**
   * Who is asked and what each person can see (planner-pm §2.8.5, §2.18;
   * teams items 6, 19a, 20). A Solo install's one person when omitted.
   */
  audience?: () => Audience;
}

const CARD_ID = "[A-Za-z0-9_-]+";

/** Card fields the dashboard may edit inline (PM_CONTRACT §2). */
const PATCHABLE: Record<string, (v: unknown) => unknown> = {
  priority: (v) => (typeof v === "number" && v >= 0 && v <= 4 ? Math.round(v) : undefined),
  // PM_CONTRACT §2: the kernel refuses any estimate outside {1,2,3,5,8}; the
  // PATCH rule matches it by mapping to the nearest allowed value rather
  // than passing an arbitrary number through to be refused.
  estimate: (v) =>
    v === null ? null : typeof v === "number" && v >= 0 ? nearestCardEstimate(v) : undefined,
  labels: (v) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => x.trim()) : undefined,
  epicId: (v) => (v === null || typeof v === "string" ? v : undefined),
  cycleId: (v) => (v === null || typeof v === "string" ? v : undefined),
  assignee: (v) => (v === null || typeof v === "string" ? v : undefined),
  dueDate: (v) =>
    v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : undefined,
  title: (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : undefined),
  // What the card declares to its gates (GT-N4-4, GT-N4-6, GT-TQ-8, GT-TQ-11):
  // the route needs Accept for it (access.ts), the kernel checks its shape and
  // `card/updated` names the principal who changed it.
  gateChecks: (v) =>
    v === null || (typeof v === "object" && v !== null && !Array.isArray(v)) ? v : undefined,
};

/**
 * Routes for the PM conversation, proposals, cycles, inline edits, flow
 * metrics and integrations. Returns true when it handled the request.
 */
export function createPmApi(ctx: PmApiContext) {
  const pmStore = new PmStore(ctx.log);
  const learning = new LearningStore(ctx.log);

  /** Every applied/discarded proposal so far feeds the user profile. */
  const learnChoices = async (): Promise<void> => {
    const choices = (await pmStore.thread())
      .flatMap((m) => m.proposals ?? [])
      .filter((p) => p.state === "applied" || p.state === "discarded")
      .map((p) => ({ kind: p.kind, state: p.state as "applied" | "discarded" }));
    await learnFromProposalChoices(learning, choices).catch(() => undefined);
  };
  const pmModel = ctx.pmModel ?? DEFAULT_PM_MODEL;
  const audience = (): Audience => ctx.audience?.() ?? soloAudience();
  const personOf = (req: IncomingMessage): string =>
    ctx.principalOf?.(req) ?? ctx.log.localPrincipal();
  /**
   * PM-N9-8: in the Team setup a person reads their own part of Seshat's
   * thread — their messages and the replies to them — and a reply to no one
   * (a planner's post) only when they can see every project.
   */
  const threadFor = async (req: IncomingMessage, since: number): Promise<PmMessage[]> => {
    const all = await pmStore.thread(since);
    const a = audience();
    if (a.setup !== "team") return all;
    const me = personOf(req);
    const seesAll = (ctx.cardStore?.listProjects() ?? []).every((p) => a.canSee(me, p.id));
    return all.filter((m) => (m.principal ? m.principal === me : seesAll));
  };
  // On a host that can hold both, the dashboard's Seshat can use the Researcher too.
  const researcherModel = process.env.SEKHEMET_RESEARCHER;
  let answering: Promise<void> | undefined;

  /**
   * Answer from the dashboard process, but only when no queue is running: a
   * queue holds the Worker in memory and is the only process that can safely
   * swap it out for the PM.
   */
  const kick = (): void => {
    if (answering || !ctx.cardStore || runnerLease(ctx.repoPath)) return;
    // The dashboard loads a large model outside any queue: never on a host
    // already under memory pressure. The message stays queued; it is answered
    // on the next message once pressure is normal, or by the next queue run.
    const level = (ctx.pressureLevel ?? readKernelPressureLevel)();
    if (level !== undefined && level > 1) {
      void pmStore.setStatus({
        phase: "idle",
        detail:
          "Memory is under pressure, so Seshat will answer once it eases or during the next run",
      });
      return;
    }
    const cardStore = ctx.cardStore;
    // MD-N9-4: through the process's one scheduler, loaded when first asked.
    const acquire = ctx.pmAdapter
      ? (() => {
          const a = (ctx.pmAdapter as () => LocalInferenceAdapter)();
          return async () => ({ role: "chat", adapter: a, release: () => {} });
        })()
      : pmModelFor(pmModel, modelRegistry(), ctx.log);
    // Rule 20f (b): the Planner role's quick answerer, when a person named one
    // and the measured headroom admits it beside what is resident.
    const quick = ctx.pmAdapter
      ? undefined
      : quickAnswererFor(
          sharedModelAccess(),
          effectiveConfig(ctx.repoPath).config.models.quickAnswerer,
        );
    // PM-P1-2: /plan with the Planner role's model — `[models] planner`,
    // else Seshat's — and without one when it is "none".
    const plannerName = ctx.pmAdapter
      ? undefined
      : resolvePlannerModel({
          configured: effectiveConfig(ctx.repoPath).config.models.planner,
          seshatModel: pmModel,
        });
    const planner = plannerName
      ? plannerName === pmModel
        ? acquire
        : pmModelFor(plannerName, modelRegistry(), ctx.log)
      : undefined;
    // The loop answers everyone's queued messages: it is not the person's who
    // happened to start it (kernel K-N2-8).
    answering = EventLog.unscoped(async () => {
      // Messages that arrive while the PM is answering are picked up next.
      while (
        await answerQueued({
          repoPath: ctx.repoPath,
          cardStore,
          pmStore,
          pmModel,
          acquire,
          // Smart Swap (models rule 20f): the full answer's predicted wait, said in words.
          ...(ctx.pmAdapter ? {} : { predictWait: () => seshatWait(sharedModelAccess(), "chat") }),
          ...(quick ? { quick } : {}),
          ...(planner ? { planner } : {}),
          audience: audience(),
          ...(researcherModel
            ? {
                researcher: (q: string, o?: { deep?: boolean }) =>
                  oneShotResearcher(ctx.repoPath, researcherModel, cardStore, ctx.log)(q, o),
              }
            : {}),
        })
      ) {
        // loop until the queue is empty
      }
    })
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
        messages: await threadFor(req, since),
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

    // --- Quick create from the board (dashboard DB-P3-12) ---------------------
    // A create proposal in Seshat's thread: applied, it goes through the one
    // planner pipeline (PM-P1-1) like any card Seshat drafts.
    if (url === "/api/pm/create-card" && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      const b = await ctx.readJsonBody(req);
      const asked = quickCreateRequest({
        title: typeof b.title === "string" ? b.title : "",
        ...(typeof b.description === "string" ? { description: b.description } : {}),
        ...(typeof b.epicId === "string" ? { epicId: b.epicId } : {}),
        ...(typeof b.projectId === "string" ? { projectId: b.projectId } : {}),
      });
      if (!asked.ok) {
        ctx.json(res, 400, { error: asked.error });
        return true;
      }
      const { title, description, epicId, projectId } = asked.body;
      const epic = epicId && ctx.cardStore ? await ctx.cardStore.getCard(epicId) : null;
      const underEpic = epic && epic.tier === "epic" ? epic : null;
      const reply = await pmStore.appendReply({
        replyTo: [],
        text: `A new card from the board: “${title}”. Apply it and the planner sizes it, writes its acceptance criteria and bounds its scope.`,
        proposals: [
          {
            kind: "create_card",
            cards: [
              {
                title,
                ...(description ? { spec: description } : {}),
                // Under the epic, the card is in the epic's project; else in
                // the project the board is scoped to (the one checked).
                ...(underEpic ? { epicId: underEpic.id } : projectId ? { projectId } : {}),
              },
            ],
            summary: `Create ${title}`,
          },
        ],
        to: personOf(req),
      });
      ctx.json(res, 200, { messageId: reply.id, proposal: reply.proposals?.[0] });
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
        // TEAM-19: discarding a suggestion's proposal dismisses the suggestion.
        if (found.suggestionId) {
          try {
            await dismissSuggestion(found.suggestionId, {
              cardStore,
              boardService: ctx.boardService,
              pmStore,
              repoPath: ctx.repoPath,
              principal: personOf(req),
              audience: audience(),
            });
          } catch (err) {
            if (!(err instanceof SuggestionError)) throw err;
            ctx.json(res, err.status, { error: err.message });
            return true;
          }
        }
        await pmStore.setProposalState(id, "discarded");
        await learnChoices();
        ctx.json(res, 200, { proposal: { ...found, state: "discarded" } });
        return true;
      }
      // DS-P2-7 (PM_CONTRACT §3): Review plan's choices travel with Apply.
      const choices = projectChoicesOf((await ctx.readJsonBody(req)).choices);
      if (choices === null) {
        ctx.json(res, 400, {
          error: `choices must be {accept?: string[], remove?: string[], releaseLine?: number, type?: ${DEPTH_PROFILES.map((p) => `"${p}"`).join(" | ")}, answers?: {index: number}}`,
        });
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
            repoPath: ctx.repoPath,
            audience: audience(),
            ...(ctx.principalOf ? { principal: ctx.principalOf(req) } : {}),
            ...(choices ? { choices } : {}),
          }),
        );
        await learnChoices();
      } catch (err) {
        ctx.json(res, err instanceof ProposalError ? err.status : 409, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // --- Suggestions on an issue (planner-pm PM-N9-1; teams TEAM-18, -19) ----
    const cardSuggestions = new RegExp(`^/api/cards/(${CARD_ID})/suggestions$`).exec(url);
    if (cardSuggestions && req.method === "GET") {
      const id = cardSuggestions[1] as string;
      const card = ctx.cardStore ? await ctx.cardStore.getCard(id) : null;
      // PM-N9-8: an issue the person cannot see has none they can read.
      if (!ctx.cardStore || !card || !audience().canSee(personOf(req), card.projectId)) {
        ctx.json(res, 404, { error: `No card ${id}` });
        return true;
      }
      ctx.json(res, 200, { suggestions: await suggestionsOn(ctx.cardStore, id, audience()) });
      return true;
    }
    const suggestionAct = /^\/api\/suggestions\/(sug_[A-Za-z0-9_-]+)\/(apply|dismiss)$/.exec(url);
    if (suggestionAct && req.method === "POST") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const [, id, verb] = suggestionAct as unknown as [string, string, string];
      const sctx = {
        cardStore,
        boardService: ctx.boardService,
        pmStore,
        repoPath: ctx.repoPath,
        actor: "human",
        principal: personOf(req),
        audience: audience(),
      };
      try {
        if (verb === "apply") {
          const r = await applySuggestion(id, sctx);
          ctx.json(res, 200, { suggestion: { ...r.suggestion, state: "applied" }, cards: r.cards });
        } else {
          await dismissSuggestion(id, sctx);
          ctx.json(res, 200, { suggestion: { id, state: "dismissed" } });
        }
        await learnChoices();
      } catch (err) {
        ctx.json(res, err instanceof SuggestionError ? err.status : 409, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // --- The weekly project update (planner-pm PM-N9-7; teams item 29) -------
    if (url === "/api/pm/update-draft" && req.method === "GET") {
      if (!ctx.cardStore) {
        ctx.json(res, 501, { error: "This server was started read-only" });
        return true;
      }
      const project = query.get("project") ?? undefined;
      ctx.json(res, 200, {
        draft: await draftWeeklyUpdate({
          repoPath: ctx.repoPath,
          cardStore: ctx.cardStore,
          pmStore,
          ...(project ? { project } : {}),
          audience: audience(),
          asker: personOf(req),
        }),
      });
      return true;
    }
    const postUpdate = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/update$/.exec(url);
    if (postUpdate && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      const project = postUpdate[1] as string;
      const b = await ctx.readJsonBody(req);
      const text = typeof b.text === "string" ? b.text.trim().slice(0, 8000) : "";
      if (!text) {
        ctx.json(res, 400, { error: "An update needs its text" });
        return true;
      }
      const a = audience();
      const me = personOf(req);
      const lead = a.leadOf(project);
      // Teams item 6: a project's update is posted by its lead (or an Admin).
      if (a.setup === "team" && lead !== me && a.levelOf(me, project) !== "admin") {
        ctx.json(res, 403, { error: "The project lead posts its update." });
        return true;
      }
      await postWeeklyUpdate(ctx.log, { project, text, principal: me });
      ctx.json(res, 200, { posted: { project } });
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
      const principal = ctx.principalOf?.(req);
      const card = await cardStore.updateCard(
        id,
        patch as CardUpdate,
        "human",
        principal ? { principal } : {},
      );
      // PM_CONTRACT §2: the estimate a person typed may have been mapped to
      // the nearest allowed value; the original is kept in the dossier.
      if (
        typeof b.estimate === "number" &&
        typeof patch.estimate === "number" &&
        b.estimate !== patch.estimate
      ) {
        await cardStore.recordDossierEntry({
          cardId: id,
          kind: "note",
          actor: "human",
          text: `Estimate ${b.estimate} is not one of {1,2,3,5,8}; mapped to the nearest allowed value, ${patch.estimate}.`,
        });
      }
      ctx.json(res, 200, { card, ...(rejected.length ? { ignored: rejected } : {}) });
      return true;
    }

    // --- Learning (PM_CONTRACT §6) ------------------------------------------
    if (url === "/api/learning" && req.method === "GET") {
      const tuningPath = join(ctx.repoPath, ".sekhemet", "tuning", "latest.json");
      let tuning: unknown;
      try {
        tuning = existsSync(tuningPath) ? JSON.parse(readFileSync(tuningPath, "utf8")) : undefined;
      } catch {
        tuning = undefined;
      }
      ctx.json(res, 200, {
        rules: await learning.rules(),
        profile: await learning.profile(),
        ...(tuning ? { tuning } : {}),
      });
      return true;
    }
    const ruleAction = /^\/api\/learning\/rules\/([A-Za-z0-9_-]+)(?:\/(approve|retire))?$/.exec(
      url,
    );
    if (ruleAction && (req.method === "POST" || req.method === "PATCH")) {
      if (!mutationGuard(req, res)) return true;
      const [, id, verb] = ruleAction as unknown as [string, string, string | undefined];
      const b = await ctx.readJsonBody(req);
      const reach: { reach?: "global" | "project" } =
        b.reach === "global" || b.reach === "project" ? { reach: b.reach } : {};
      const change =
        req.method === "PATCH"
          ? typeof b.text === "string" && b.text.trim()
            ? { text: b.text.trim().slice(0, 600) }
            : undefined
          : verb === "approve"
            ? { status: "active" as const, ...reach }
            : verb === "retire"
              ? { status: "retired" as const }
              : undefined;
      if (!change) {
        ctx.json(res, 400, { error: "Nothing to change" });
        return true;
      }
      // DEC-28, measurement rule 16a: a project rule is admitted by a person's
      // approval; the frozen suite never admits one. A suite verdict from
      // `improve --gate-rule` is a diagnostic, shown with the approval.
      const gate = verb === "approve" ? await ruleGateVerdict(ctx.log, id) : undefined;
      const rule = await learning.update(id, change);
      if (!rule) ctx.json(res, 404, { error: `No rule ${id}` });
      else ctx.json(res, 200, { rule, ...(gate ? { suiteDiagnostic: gate } : {}) });
      return true;
    }
    const prefAction = /^\/api\/learning\/profile\/([A-Za-z0-9_-]+)(?:\/(dismiss))?$/.exec(url);
    if (prefAction && (req.method === "POST" || req.method === "PATCH")) {
      if (!mutationGuard(req, res)) return true;
      const [, id, verb] = prefAction as unknown as [string, string, string | undefined];
      const b = await ctx.readJsonBody(req);
      const change =
        req.method === "PATCH" && typeof b.statement === "string" && b.statement.trim()
          ? { statement: b.statement.trim().slice(0, 400) }
          : verb === "dismiss"
            ? { status: "dismissed" as const }
            : undefined;
      if (!change) {
        ctx.json(res, 400, { error: "Nothing to change" });
        return true;
      }
      const entry = await learning.updateProfile(id, change);
      if (!entry) ctx.json(res, 404, { error: `No profile entry ${id}` });
      else ctx.json(res, 200, { entry });
      return true;
    }

    // --- Model roster (worker, Seshat, reviewer, researcher) -------------------
    if (url === "/api/models" && req.method === "GET") {
      ctx.json(res, 200, modelRoster(ctx.repoPath, pmModel));
      return true;
    }

    // --- Worker capability --------------------------------------------------
    if (url === "/api/capability" && req.method === "GET") {
      const cards = ctx.cardStore ? await ctx.cardStore.listCards() : [];
      ctx.json(res, 200, capabilityReport(ctx.repoPath, cards));
      return true;
    }

    // --- Seshat's own quality (measured) -------------------------------------
    if (url === "/api/metrics/pm" && req.method === "GET") {
      const cards = ctx.cardStore ? await ctx.cardStore.listCards() : [];
      const remaining = cards.filter(
        (c) => !["done", "rejected", "parked"].includes(c.status),
      ).length;
      const evDir = join(ctx.repoPath, ".sekhemet", "evidence");
      const firstTry = new Map<string, boolean>();
      if (existsSync(evDir)) {
        for (const f of readdirSync(evDir).filter((n) => n.startsWith("ev_"))) {
          try {
            const e = JSON.parse(readFileSync(join(evDir, f), "utf8")) as {
              cardId?: string;
              attempt?: number;
              passed?: boolean;
            };
            if (e.cardId && (e.attempt ?? 1) === 1) firstTry.set(e.cardId, e.passed === true);
          } catch {
            // skip partial bundles
          }
        }
      }
      ctx.json(res, 200, await pmQuality(ctx.log, remaining, (id) => firstTry.get(id)));
      return true;
    }

    // --- Burn-up (dashboard DB-P3-14) -----------------------------------------
    if (url === "/api/metrics/burnup" && req.method === "GET") {
      const id = query.get("cycle");
      const cycle = id ? (await pmStore.cycles()).find((c) => c.id === id) : undefined;
      if (id && !cycle) {
        ctx.json(res, 404, { error: `No cycle ${id}` });
        return true;
      }
      // One project's cards when the board is scoped to one; in the Team
      // setup only the projects the person can see (PM-N9-8).
      const project = query.get("project") ?? undefined;
      const a = audience();
      const me = personOf(req);
      ctx.json(
        res,
        200,
        await burnupMetrics(ctx.log, cycle, new Date(), {
          ...(project ? { project } : {}),
          ...(a.setup === "team" ? { canSee: (p: string | undefined) => a.canSee(me, p) } : {}),
        }),
      );
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
    if (pmEvents.some((e) => e.type !== PM_EVENTS.status) && audience().setup === "team") {
      // PM-N9-8: one stream reaches everyone, so it carries no message; each
      // person reloads their own part of the thread.
      frames.push(`event: pm\ndata: ${JSON.stringify({ kind: "refresh" })}\n\n`);
    } else if (pmEvents.some((e) => e.type !== PM_EVENTS.status)) {
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

  return { handle, streamFrames, pmStore, learning };
}

/**
 * The four-model roster and what is loaded: the running queue's lease when
 * there is one, otherwise the roster the next run will use (config.toml, then
 * the recommendation for this machine). Shared by /api/models and the
 * sidebar's model line (via /api/machine).
 */
export function modelRoster(
  repoPath: string,
  pmModel: string = DEFAULT_PM_MODEL,
): {
  roles: { role: string; model?: string; state: string; note?: string }[];
  coResident: boolean;
} {
  const lease = runnerLease(repoPath) as
    | {
        roster?: { role: string; model?: string }[];
        active?: string;
        resident?: string[];
        coResident?: boolean;
      }
    | undefined;
  const configured = new Map<string, string | undefined>(
    (lease?.roster ?? []).map((r) => [r.role, r.model]),
  );
  if (!lease) {
    const cfg = effectiveConfig(repoPath).config;
    const rec = recommendRoster();
    configured.set("worker", cfg.models.executor !== "auto" ? cfg.models.executor : rec.worker);
    configured.set("manager", pmModel);
    configured.set("reviewer", rec.reviewer);
    configured.set("researcher", process.env.SEKHEMET_RESEARCHER ?? rec.researcher);
  }
  const roles = ["worker", "manager", "reviewer", "researcher"].map((role) => {
    const model = configured.get(role);
    const state = !model
      ? "unconfigured"
      : lease?.coResident || lease?.resident?.includes(role) || lease?.active === role
        ? "resident"
        : "swapped";
    return {
      role,
      ...(model ? { model } : {}),
      state,
      ...(lease ? {} : { note: "No run in progress" }),
    };
  });
  return { roles, coResident: lease?.coResident === true };
}

/**
 * Review plan's choices from a request body (PM_CONTRACT §3): undefined when
 * none were sent, null when they are not the documented shape.
 */
export function projectChoicesOf(raw: unknown): ProjectChoices | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const out: ProjectChoices = {};
  for (const key of Object.keys(r)) {
    const v = r[key];
    if (key === "accept" || key === "remove") {
      if (!strings(v)) return null;
      out[key] = v;
    } else if (key === "releaseLine") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return null;
      out.releaseLine = v;
    } else if (key === "type") {
      // One of the depth profiles, never replaced silently by the proposed one.
      if (typeof v !== "string" || !parseDepthProfile(v)) return null;
      out.type = v;
    } else if (key === "answers") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
      const answers: Record<string, number> = {};
      for (const [q, a] of Object.entries(v)) {
        if (!/^\d+$/.test(q) || typeof a !== "number" || !Number.isInteger(a) || a < 0) return null;
        answers[q] = a;
      }
      out.answers = answers;
    } else {
      return null;
    }
  }
  return out;
}
