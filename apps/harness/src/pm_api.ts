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
import {
  CARD_VERSION_FIELDS,
  type Reproduction,
  cardVersion,
  issueSpec,
  quickCreateRequest,
  sameProject,
} from "@sekhemet/ui";
import { effectiveConfig } from "./config_apply.js";
import { recommendRoster } from "./init.js";
import { handleIntegrationsApi } from "./integrations.js";
import { readSettings } from "./integrations.js";
import { readIssueForms } from "./issue_forms.js";
import { learnFromProposalChoices } from "./learning/reflect.js";
import { LearningStore } from "./learning/store.js";
import { sharedModelAccess } from "./model_access.js";
import { meterModelUsage, modelUse, recordUsageOn } from "./model_usage.js";
import { ProposalError, applyProposal } from "./pm/apply.js";
import { type Audience, nameFor, soloAudience } from "./pm/audience.js";
import { capabilityReport } from "./pm/capability.js";
import {
  MessageRefused,
  attachDocuments,
  documentsToAttach,
  parseMessage,
  readMessageBody,
} from "./pm/documents.js";
import { burnupMetrics, flowMetrics, pmQuality } from "./pm/metrics.js";
import type { ProjectChoices } from "./pm/pipeline.js";
import {
  approvalRefusal,
  approveSentPlan,
  commentOnSentPlan,
  sendPlanForApproval,
  sentTo,
  withApprovalNames,
} from "./pm/send_for_approval.js";
import { DEFAULT_PM_MODEL, answerQueued, pmModelFor, runnerLease } from "./pm/service.js";
import {
  type CarryTo,
  SprintRefusal,
  completeSprint,
  onlyProjectOf,
  sprintReportOf,
  startSprint,
} from "./pm/sprints.js";
import { type MessageDocument, PmStore } from "./pm/store.js";
import {
  SuggestionError,
  applySuggestion,
  dismissSuggestion,
  suggestionsOn,
  undoSuggestion,
} from "./pm/suggest.js";
import { PM_EVENTS, type PmContext, type PmMessage, type PmStatus } from "./pm/types.js";
import { draftWeeklyUpdate, postWeeklyUpdate } from "./pm/weekly.js";
import { seshatWait } from "./pm/while_worker.js";
import { releaseTags } from "./project_done.js";
import { oneShotResearcher } from "./research/service.js";
import { quickAnswererFor } from "./smart_swap.js";
import { statusFacts } from "./status_api.js";
import {
  isDay,
  isHealth,
  setProjectHealth,
  setReleaseLead,
  setReleaseTarget,
} from "./team/health.js";
import { modelRegistry, ruleGateVerdict } from "./wave2.js";

/** How often a focused dashboard's presence is recorded (PM-P6-10; the notifier's window is 5 minutes). */
const FOCUS_RECORD_MS = 60_000;

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
  /** A principal's recorded name (DB-N16-2: Undo names who changed a field since). */
  nameOf?: (principal: string) => string | undefined;
  /**
   * Teams item 9a (TEAM-50, -52): why new work cannot be assigned to this
   * person (a member who left), recorded as a refusal; undefined when it can.
   */
  refuseAssignment?: (
    by: string | undefined,
    principal: string,
    cardId: string,
  ) => Promise<string | undefined>;
  /**
   * Who is asked and what each person can see (planner-pm §2.8.5, §2.18;
   * teams items 6, 19a, 20). A Solo install's one person when omitted.
   */
  audience?: () => Audience;
  /** The user config.toml, and its writes recorded with the person (TEAM-44; SEC-27c's choice). */
  userConfigPath?: string;
  recordConfigWrite?: <T>(principal: string, write: () => T) => T;
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

/** Two field values alike: absent and null, and label lists in any order (DB-N16-2). */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v === undefined || v === null || (Array.isArray(v) && v.length === 0)
      ? null
      : Array.isArray(v)
        ? [...v].map(String).sort()
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * The versions an `If-Match` header names (RFC 9110 §13.1.1): a list of
 * quoted entity tags, weak or strong; `*` is any. Undefined when the header
 * is absent, so a PATCH without one is applied as before (DB-N16-4).
 */
function ifMatchVersions(header: string | string[] | undefined): string[] | "*" | undefined {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.trim() === "*") return "*";
  return raw.split(",").map((t) =>
    t
      .trim()
      .replace(/^W\//, "")
      .replace(/^"(.*)"$/, "$1"),
  );
}

/** The principal who last changed `field` on a card (DB-N16-2: Undo names them). */
async function lastChangedBy(
  log: EventLog,
  cardId: string,
  field: string,
): Promise<string | undefined> {
  const types =
    field === "assignee"
      ? ["card/updated", "card/delegated", "card/owner_changed"]
      : ["card/updated"];
  const events = await log.getEventsByCardAndTypes(cardId, types);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type: string; principal?: string; payload?: unknown };
    const patch = (e.payload as { patch?: Record<string, unknown> } | undefined)?.patch;
    if (e.type !== "card/updated" || (patch && field in patch)) return e.principal;
  }
  return undefined;
}

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
  /** When each person's board focus was last recorded (PM-P6-10). */
  const focusRecorded = new Map<string, number>();
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
    // TEAM-20: a plan sent for approval is read by its approver too (design-stage §2.9 item 1).
    return all
      .filter((m) => (m.principal ? m.principal === me || sentTo(m, me) : seesAll))
      .map((m) => withApprovalNames(m, a));
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
          // Measurement rule 4a: a given model's requests are on the ledger
          // as the one path to a model records them (`ModelAccess`).
          const a = meterModelUsage((ctx.pmAdapter as () => LocalInferenceAdapter)(), {
            record: recordUsageOn(ctx.log),
            served: () => ["planner"],
          });
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
          // The server's own board, which every move goes through (K-S4-3).
          board: ctx.boardService,
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

  /**
   * Put a person's message in Seshat's queue and start answering it (the
   * chat's composer, and an issue comment's `@Seshat`, teams TEAM-15): the
   * running queue answers after the Worker's current step; otherwise this
   * process does, without waiting for the reply.
   */
  const ask = async (
    text: string,
    context: PmContext,
    documents: MessageDocument[] = [],
  ): Promise<PmMessage> => {
    const message = await pmStore.appendUserMessage(text, context, "human", documents);
    const lease = runnerLease(ctx.repoPath);
    if (lease) {
      // The queue answers after the Worker's current step.
      await pmStore.setStatus({
        phase: "waiting_for_step",
        detail: "Pausing the Agent after its current step",
        model: lease.pmModel ?? pmModel,
        workerPaused: false,
      });
    } else {
      kick();
    }
    return message;
  };

  const sprintDeps = (cardStore: CardStore) => ({ log: ctx.log, cardStore, pmStore });
  /** A sprint step's refusal as the person's status and words; any other failure recorded nothing. */
  const sprintRoute = async <T>(
    res: ServerResponse,
    step: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await step();
    } catch (err) {
      if (err instanceof SprintRefusal) ctx.json(res, err.status, { error: err.message });
      else
        ctx.json(res, 500, {
          error: `Nothing was recorded: ${err instanceof Error ? err.message : String(err)}`,
        });
      return undefined;
    }
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

    // PM-P6-10: the dashboard is in focus for this person, so Seshat's
    // unsolicited items go to the panel instead of a notice. Recorded at
    // most once a minute per person.
    if (url === "/api/pm/focus" && req.method === "POST") {
      if (!ctx.isTrustedMutation(req)) {
        ctx.json(res, 403, { error: "Actions must come from the dashboard itself" });
        return true;
      }
      const person = personOf(req);
      const at = Date.now();
      if ((focusRecorded.get(person) ?? 0) <= at - FOCUS_RECORD_MS) {
        focusRecorded.set(person, at);
        await ctx.log.append({
          actor: "harness",
          type: PM_EVENTS.boardFocus,
          payload: { principal: person },
        });
      }
      ctx.json(res, 200, { ok: true });
      return true;
    }

    if (url === "/api/pm/messages" && req.method === "POST") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      // PM-N10-1..4: kept whole up to the request cap; a long message or a
      // pasted document is a project document; a refusal says the size.
      let incoming: ReturnType<typeof parseMessage>;
      let body: Record<string, unknown>;
      try {
        body = await readMessageBody(req, ctx.readJsonBody);
        incoming = parseMessage(body);
      } catch (err) {
        if (!(err instanceof MessageRefused)) throw err;
        ctx.json(res, err.status, { error: err.message, ...err.detail });
        return true;
      }
      const raw = (body.context ?? {}) as Record<string, unknown>;
      const context = {
        ...(typeof raw.cardId === "string" ? { cardId: raw.cardId } : {}),
        ...(typeof raw.view === "string" ? { view: raw.view } : {}),
      };
      const { documents, notice } = await attachDocuments(
        { repoPath: ctx.repoPath, cardStore, log: ctx.log },
        documentsToAttach(incoming),
        personOf(req),
      );
      const message = await ask(incoming.text, context, documents);
      ctx.json(res, 200, { message, ...(notice ? { notice } : {}) });
      return true;
    }

    // NEW-dashboard-15 (DB-N15-3): the repository's issue forms, by type.
    if (url === "/api/issue-forms" && req.method === "GET") {
      ctx.json(res, 200, { forms: readIssueForms(ctx.repoPath) });
      return true;
    }

    // NEW-dashboard-15: a Bug's *Release* offers the repository's tagged
    // releases, newest first (repository text, shown as a list, never sent on).
    if (url === "/api/releases/tags" && req.method === "GET") {
      const tags = releaseTags(ctx.repoPath);
      ctx.json(res, 200, { tags });
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
        // NEW-dashboard-15: the type and properties, and a Bug's reproduction.
        ...(typeof b.type === "string" ? { type: b.type } : {}),
        ...(b.priority !== undefined ? { priority: b.priority as number } : {}),
        ...(Array.isArray(b.labels) ? { labels: b.labels as string[] } : {}),
        ...(typeof b.cycleId === "string" ? { cycleId: b.cycleId } : {}),
        ...(typeof b.assignee === "string" ? { assignee: b.assignee } : {}),
        ...(b.reproduction && typeof b.reproduction === "object"
          ? { reproduction: b.reproduction as Reproduction }
          : {}),
      });
      if (!asked.ok) {
        ctx.json(res, 400, { error: asked.error });
        return true;
      }
      const { title, description, epicId, projectId, reproduction } = asked.body;
      const spec = issueSpec(description, reproduction);
      const { type, priority, labels, cycleId, assignee } = asked.body;
      const epic = epicId && ctx.cardStore ? await ctx.cardStore.getCard(epicId) : null;
      const underEpic = epic && epic.tier === "epic" ? epic : null;
      const reply = await pmStore.appendReply({
        replyTo: [],
        text: `A new issue from the board: “${title}”. Apply it and the planning model sizes it, writes its acceptance criteria and bounds its scope.`,
        proposals: [
          {
            kind: "create_card",
            cards: [
              {
                title,
                ...(spec ? { spec } : {}),
                // Under the epic, the card is in the epic's project; else in
                // the project the board is scoped to (the one checked).
                ...(underEpic ? { epicId: underEpic.id } : projectId ? { projectId } : {}),
                ...(type ? { type } : {}),
                ...(priority !== undefined ? { priority } : {}),
                ...(labels ? { labels } : {}),
                ...(cycleId ? { cycleId } : {}),
                ...(assignee ? { assignee } : {}),
                // K-N6-1: the person who filed it owns it once applied.
                owner: personOf(req),
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
      const [, id, verb] = proposal as unknown as [string, string, "apply" | "discard"];
      const found = await pmStore.proposal(id);
      if (!found) {
        ctx.json(res, 404, { error: `No proposal ${id}` });
        return true;
      }
      // TEAM-20: a plan sent for approval is its named approver's to decide.
      const aside = approvalRefusal(found, verb, personOf(req), audience());
      if (aside) {
        ctx.json(res, aside.status, { error: aside.message });
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
          error: `choices must be {accept?: string[], remove?: string[], releaseLine?: number, type?: ${DEPTH_PROFILES.map((p) => `"${p}"`).join(" | ")}, answers?: {index: number}, folder?: string}`,
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

    // Design-stage §2.9 item 7: the approver asks a question in the sent
    // plan's thread, and the person who sent it answers; nothing is created.
    const planComment = /^\/api\/pm\/proposals\/([A-Za-z0-9_-]+)\/comments$/.exec(url);
    if (planComment && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      const found = await pmStore.proposal(planComment[1] as string);
      const a = audience();
      if (!found) {
        ctx.json(res, 404, { error: `No proposal ${planComment[1]}` });
        return true;
      }
      const body = await ctx.readJsonBody(req);
      try {
        const proposal = await commentOnSentPlan(pmStore, found, {
          principal: personOf(req),
          text: body.text,
          audience: a,
        });
        ctx.json(res, 200, { proposal });
      } catch (err) {
        ctx.json(res, err instanceof ProposalError ? err.status : 409, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }

    // TEAM-20, TEAM-42 (design-stage §2.9 item 7): a Stakeholder's plan is
    // sent to a named Member or Admin, and created only when they approve it.
    const planAct = /^\/api\/pm\/proposals\/([A-Za-z0-9_-]+)\/(send-for-approval|approve)$/.exec(
      url,
    );
    if (planAct && req.method === "POST") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const [, id, verb] = planAct as unknown as [string, string, string];
      const found = await pmStore.proposal(id);
      if (!found) {
        ctx.json(res, 404, { error: `No proposal ${id}` });
        return true;
      }
      const body = await ctx.readJsonBody(req);
      const choices = projectChoicesOf(body.choices);
      if (choices === null) {
        ctx.json(res, 400, {
          error: `choices must be {accept?: string[], remove?: string[], releaseLine?: number, type?: ${DEPTH_PROFILES.map((p) => `"${p}"`).join(" | ")}, answers?: {index: number}, folder?: string}`,
        });
        return true;
      }
      try {
        if (verb === "send-for-approval") {
          const proposal = await sendPlanForApproval(pmStore, found, {
            principal: personOf(req),
            approver: body.approver,
            choices,
            audience: audience(),
          });
          ctx.json(res, 200, { proposal });
        } else {
          ctx.json(
            res,
            200,
            await approveSentPlan(found, {
              cardStore,
              boardService: ctx.boardService,
              pmStore,
              actor: "human",
              repoPath: ctx.repoPath,
              audience: audience(),
              principal: personOf(req),
              ...(choices ? { choices } : {}),
            }),
          );
          await learnChoices();
        }
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
        ctx.json(res, 404, { error: `No issue ${id}` });
        return true;
      }
      ctx.json(res, 200, { suggestions: await suggestionsOn(ctx.cardStore, id, audience()) });
      return true;
    }
    // TEAM-41: what an Admin's auto-apply rule applied is undone in one action.
    const suggestionAct = /^\/api\/suggestions\/(sug_[A-Za-z0-9_-]+)\/(apply|dismiss|undo)$/.exec(
      url,
    );
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
        } else if (verb === "undo") {
          const r = await undoSuggestion(id, sctx);
          ctx.json(res, 200, { suggestion: { ...r.suggestion, state: "undone" }, cards: r.cards });
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

    // --- Status (dashboard §2.8, DB-N9-1..4, -8; DEC-37) ---------------------
    if (url === "/api/status" && req.method === "GET") {
      if (!ctx.cardStore) {
        ctx.json(res, 501, { error: "This server was started read-only" });
        return true;
      }
      const project = query.get("project") ?? undefined;
      ctx.json(res, 200, {
        facts: await statusFacts({
          cardStore: ctx.cardStore,
          log: ctx.log,
          me: personOf(req),
          project,
          audience: audience(),
        }),
      });
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
      // PM-N10-1: a long update is posted whole; only the request cap refuses, in words.
      let b: Record<string, unknown>;
      try {
        b = await readMessageBody(req, ctx.readJsonBody);
      } catch (err) {
        if (!(err instanceof MessageRefused)) throw err;
        ctx.json(res, err.status, { error: err.message, ...err.detail });
        return true;
      }
      const text = typeof b.text === "string" ? b.text.trim() : "";
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

    // --- The retrospective (planner-pm NEW-planner-pm-11, PM-N11-1..3) -------
    const retroRoute = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/retrospectives$/.exec(url);
    if (retroRoute && (req.method === "GET" || req.method === "POST")) {
      const project = retroRoute[1] as string;
      const me = personOf(req);
      const a = audience();
      if (!ctx.cardStore?.getProject(project) || !a.canSee(me, project)) {
        ctx.json(res, 404, { error: `No project ${project}` });
        return true;
      }
      const { postRetrospective, retrospectiveState } = await import("./pm/retrospective.js");
      const { contextForCard } = await import("./card_root.js");
      const deps = {
        cardStore: ctx.cardStore,
        log: ctx.log,
        pmStore,
        repoPath: contextForCard(
          { repoPath: ctx.repoPath, cardStore: ctx.cardStore },
          {
            projectId: project,
          },
        ).repoPath,
      };
      if (req.method === "GET") {
        ctx.json(res, 200, await retrospectiveState(deps, project, a, me));
        return true;
      }
      if (!mutationGuard(req, res)) return true;
      let b: Record<string, unknown>;
      try {
        b = await readMessageBody(req, ctx.readJsonBody);
      } catch (err) {
        if (!(err instanceof MessageRefused)) throw err;
        ctx.json(res, err.status, { error: err.message, ...err.detail });
        return true;
      }
      const text = typeof b.text === "string" ? b.text.trim() : "";
      if (!text) {
        ctx.json(res, 400, { error: "A retrospective needs its text" });
        return true;
      }
      const iso = (v: unknown) =>
        typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined;
      const from = iso(b.from);
      const to = iso(b.to);
      if (!from || !to) {
        ctx.json(res, 400, { error: "A retrospective names the window it covers: from and to" });
        return true;
      }
      const sprint = typeof b.sprint === "string" && b.sprint ? b.sprint : undefined;
      if (sprint && !(await pmStore.cycles()).some((c) => c.id === sprint)) {
        ctx.json(res, 400, { error: `No sprint ${sprint}` });
        return true;
      }
      const id = await postRetrospective(ctx.log, {
        project,
        ...(sprint ? { sprint } : {}),
        from,
        to,
        text,
        principal: me,
      });
      ctx.json(res, 200, { posted: { id, project } });
      return true;
    }

    // --- Health and a release's target date (teams TEAM-28; DB-N9-2, -3) ------
    const postHealth = /^\/api\/projects\/(proj_[A-Za-z0-9_-]+)\/health$/.exec(url);
    if (postHealth && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      if (!ctx.cardStore) {
        ctx.json(res, 501, { error: "This server was started read-only" });
        return true;
      }
      const project = postHealth[1] as string;
      if (!ctx.cardStore.getProject(project)) {
        ctx.json(res, 404, { error: `No project ${project}` });
        return true;
      }
      const b = await ctx.readJsonBody(req);
      if (!isHealth(b.health)) {
        ctx.json(res, 400, { error: "Health is on_track, at_risk or off_track" });
        return true;
      }
      const a = audience();
      const me = personOf(req);
      // Item 28: the project lead's call, or a release lead's (checked centrally as
      // `project.health` first).
      if (
        a.setup === "team" &&
        a.leadOf(project) !== me &&
        a.leadsRelease?.(me, project) !== true
      ) {
        ctx.json(res, 403, {
          error: "The project lead or a Member who leads a release sets its health.",
        });
        return true;
      }
      await setProjectHealth(ctx.log, { project, health: b.health, principal: me });
      ctx.json(res, 200, {
        health: { value: b.health, by: nameFor(a, me, me), at: new Date().toISOString() },
      });
      return true;
    }
    const postTarget = /^\/api\/slices\/([\w.-]+)\/target$/.exec(url);
    if (postTarget && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      if (!ctx.cardStore) {
        ctx.json(res, 501, { error: "This server was started read-only" });
        return true;
      }
      const slice = await ctx.cardStore.slices.get(postTarget[1] as string);
      if (!slice) {
        ctx.json(res, 404, { error: `No release ${postTarget[1]}` });
        return true;
      }
      const b = await ctx.readJsonBody(req);
      const target = b.date === null || b.date === "" ? null : b.date;
      if (target !== null && !isDay(target)) {
        ctx.json(res, 400, { error: "A target date is a day, YYYY-MM-DD, or null to clear it" });
        return true;
      }
      const a = audience();
      const me = personOf(req);
      if (
        a.setup === "team" &&
        a.leadOf(slice.projectId) !== me &&
        a.levelOf(me, slice.projectId) !== "admin"
      ) {
        ctx.json(res, 403, { error: "The project lead or an Admin sets a release's target date." });
        return true;
      }
      await setReleaseTarget(ctx.log, {
        sliceId: slice.id,
        projectId: slice.projectId,
        target,
        principal: me,
      });
      ctx.json(res, 200, { target: target ? { release: slice.id, date: target } : null });
      return true;
    }

    // Teams item 28, DB-N9-2: a release's lead, named by the project lead or an
    // Admin (checked centrally as `release.lead` first); null clears it.
    const postReleaseLead = /^\/api\/slices\/([\w.-]+)\/lead$/.exec(url);
    if (postReleaseLead && req.method === "POST") {
      if (!mutationGuard(req, res)) return true;
      if (!ctx.cardStore) {
        ctx.json(res, 501, { error: "This server was started read-only" });
        return true;
      }
      const slice = await ctx.cardStore.slices.get(postReleaseLead[1] as string);
      if (!slice) {
        ctx.json(res, 404, { error: `No release ${postReleaseLead[1]}` });
        return true;
      }
      const b = await ctx.readJsonBody(req);
      const lead = b.lead === null || b.lead === "" ? null : b.lead;
      const a = audience();
      const me = personOf(req);
      if (lead !== null) {
        const level =
          typeof lead === "string" && /^p_[0-9a-z]+$/.test(lead)
            ? a.levelOf(lead, slice.projectId)
            : undefined;
        if (!level) {
          ctx.json(res, 400, {
            error: "A release's lead is a person in this workspace, named by their id (p_…).",
          });
          return true;
        }
        if (level !== "member" && level !== "admin") {
          const who = a.nameOf(lead as string) ?? (lead as string);
          const where = ctx.cardStore.getProject(slice.projectId)?.name ?? "this project";
          const word = level === "stakeholder" ? "a Stakeholder" : "a Viewer";
          ctx.json(res, 400, {
            error: `${who} is ${word} on ${where}: a release's lead is a Member or an Admin there.`,
          });
          return true;
        }
      }
      if (
        a.setup === "team" &&
        a.leadOf(slice.projectId) !== me &&
        a.levelOf(me, slice.projectId) !== "admin"
      ) {
        ctx.json(res, 403, { error: "The project lead or an Admin names a release's lead." });
        return true;
      }
      await setReleaseLead(ctx.log, {
        sliceId: slice.id,
        projectId: slice.projectId,
        lead: lead as string | null,
        principal: me,
      });
      ctx.json(res, 200, {
        lead: lead
          ? { release: slice.id, principal: lead, name: a.nameOf(lead as string) ?? lead }
          : null,
      });
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
        ctx.json(res, 400, { error: "A sprint needs a name, startsOn and endsOn (YYYY-MM-DD)" });
        return true;
      }
      // DEC-57: a sprint is one project's — the one named, else the
      // workspace's only project; a project that does not exist is a 400, and
      // in a workspace of many, a sprint that names none is refused.
      const named = typeof b.projectId === "string" && b.projectId ? b.projectId : undefined;
      if (named && !ctx.cardStore?.getProject(named)) {
        ctx.json(res, 400, { error: `No project ${named}` });
        return true;
      }
      const projectId = named ?? onlyProjectOf(ctx.cardStore);
      if (!projectId && (ctx.cardStore?.listProjects().length ?? 0) > 1) {
        ctx.json(res, 400, {
          error: "A sprint is one project's: choose the project it plans (projectId).",
        });
        return true;
      }
      // A sprint created active is started (PM-N13-1): refused, before
      // anything is recorded, while another sprint of the project is active.
      if (b.state === "active") {
        const active = (await pmStore.cycles()).find(
          (c) => c.state === "active" && sameProject(c, projectId ? { projectId } : {}),
        );
        if (active) {
          ctx.json(res, 409, {
            error: `${active.name} is active. Complete it before you start ${name}.`,
          });
          return true;
        }
      }
      let cycle = await pmStore.createCycle(
        {
          name,
          startsOn: b.startsOn,
          endsOn: b.endsOn,
          ...(typeof b.goal === "string" && b.goal.trim() ? { goal: b.goal.trim() } : {}),
          ...(projectId ? { projectId } : {}),
        },
        "human",
      );
      if (b.state === "active" && ctx.cardStore) {
        const created = cycle;
        const started = await sprintRoute(res, () =>
          startSprint(sprintDeps(ctx.cardStore as CardStore), created.id, {
            principal: personOf(req),
          }),
        );
        if (!started) return true;
        cycle = started;
      }
      ctx.json(res, 200, { cycle });
      return true;
    }
    // The sprint lifecycle (planner-pm §2.7 item 7a; dashboard DB-N11-1..3).
    const sprintAction = /^\/api\/cycles\/([A-Za-z0-9_-]+)\/(start|complete|report)$/.exec(url);
    if (sprintAction && sprintAction[2] === "report" && req.method === "GET") {
      const id = sprintAction[1] as string;
      const cycle = (await pmStore.cycles()).find((c) => c.id === id);
      if (!cycle) {
        ctx.json(res, 404, { error: "No such sprint" });
        return true;
      }
      const report = await sprintReportOf(ctx.log, id);
      if (!report) {
        ctx.json(res, 409, {
          error:
            cycle.state === "planned"
              ? `${cycle.name} has not started, so it has no report yet.`
              : `${cycle.name} was active before Sekhemet recorded sprint starts, so it has no report.`,
        });
        return true;
      }
      ctx.json(res, 200, { cycle, report });
      return true;
    }
    if (sprintAction && sprintAction[2] !== "report" && req.method === "POST") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const id = sprintAction[1] as string;
      const b = await ctx.readJsonBody(req);
      if (sprintAction[2] === "start") {
        const cycle = await sprintRoute(res, () =>
          startSprint(sprintDeps(cardStore), id, { principal: personOf(req) }),
        );
        if (cycle) ctx.json(res, 200, { cycle });
        return true;
      }
      const carryTo = b.carryTo as CarryTo;
      const ns = b.newSprint as Record<string, unknown> | undefined;
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (
        ns !== undefined &&
        (typeof ns !== "object" ||
          ns === null ||
          (ns.name !== undefined && typeof ns.name !== "string") ||
          (ns.startsOn !== undefined &&
            !(typeof ns.startsOn === "string" && iso.test(ns.startsOn))) ||
          (ns.endsOn !== undefined && !(typeof ns.endsOn === "string" && iso.test(ns.endsOn))))
      ) {
        ctx.json(res, 400, {
          error: "newSprint is {name?, startsOn?, endsOn?} with dates as YYYY-MM-DD",
        });
        return true;
      }
      const done = await sprintRoute(res, () =>
        completeSprint(sprintDeps(cardStore), id, carryTo, {
          principal: personOf(req),
          ...(ns ? { newSprint: ns as { name?: string; startsOn?: string; endsOn?: string } } : {}),
        }),
      );
      if (done) ctx.json(res, 200, { ...done, report: await sprintReportOf(ctx.log, id) });
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
      const id = cycleMatch[1] as string;
      const was = (await pmStore.cycles()).find((c) => c.id === id);
      if (!was) {
        ctx.json(res, 404, { error: "No such sprint" });
        return true;
      }
      // PM-N13-1, -2: a sprint's state changes only by Start sprint and
      // Complete sprint, which record what the change committed and carried.
      if (b.state !== undefined && b.state !== was.state) {
        ctx.json(res, 409, {
          error: `A sprint's state changes by starting or completing it: POST /api/cycles/${id}/start, or POST /api/cycles/${id}/complete with carryTo next, new or backlog.`,
        });
        return true;
      }
      const updated = await pmStore.updateCycle(id, patch);
      ctx.json(res, 200, { cycle: updated });
      return true;
    }

    // --- Inline card edits --------------------------------------------------
    const cardMatch = new RegExp(`^/api/cards/(${CARD_ID})$`).exec(url);
    if (cardMatch && req.method === "PATCH") {
      const cardStore = mutationGuard(req, res);
      if (!cardStore) return true;
      const id = cardMatch[1] as string;
      if (!(await cardStore.getCard(id))) {
        ctx.json(res, 404, { error: `No issue ${id}` });
        return true;
      }
      const b = await ctx.readJsonBody(req);
      const patch: Record<string, unknown> = {};
      const rejected: string[] = [];
      for (const [k, v] of Object.entries(b)) {
        if (k === "ifUnchanged") continue;
        const parse = PATCHABLE[k];
        const value = parse ? parse(v) : undefined;
        if (value === undefined) rejected.push(k);
        else patch[k] = value;
      }
      if (Object.keys(patch).length === 0) {
        ctx.json(res, 400, { error: `Nothing editable in ${rejected.join(", ") || "the body"}` });
        return true;
      }
      // DB-N16-4 (FINDINGS REL-08): an edit made from a version of the issue
      // that is no longer current is refused, with the current values and who
      // changed them, so one person's edit never silently overwrites another's.
      const wanted = ifMatchVersions(req.headers["if-match"]);
      if (wanted !== undefined && wanted !== "*") {
        const current = (await cardStore.getCard(id)) as unknown as Record<string, unknown>;
        const version = cardVersion(current);
        if (!wanted.includes(version)) {
          const fields = Object.keys(patch);
          const by = await lastChangedBy(ctx.log, id, fields[0] as string);
          const name = by ? (ctx.nameOf?.(by) ?? undefined) : undefined;
          res.setHeader("ETag", `"${version}"`);
          ctx.json(res, 409, {
            error: `This issue changed since you opened it${name ? ` (last by ${name})` : ""}, so your change was not applied.`,
            version,
            current: Object.fromEntries(fields.map((f) => [f, current[f] ?? null])),
            card: Object.fromEntries(
              ["id", ...CARD_VERSION_FIELDS].map((f) => [f, current[f] ?? null]),
            ),
            ...(name ? { by: name } : {}),
          });
          return true;
        }
      }
      // NEW-dashboard-16 (DB-N16-2): an Undo restores a field only while it
      // still holds the value the edit set; one another person changed since
      // is left as it is, and the refusal names them.
      if (b.ifUnchanged && typeof b.ifUnchanged === "object" && !Array.isArray(b.ifUnchanged)) {
        const current = (await cardStore.getCard(id)) as unknown as Record<string, unknown>;
        const changed: { field: string; by?: string }[] = [];
        for (const [field, expected] of Object.entries(b.ifUnchanged as Record<string, unknown>)) {
          const parse = PATCHABLE[field];
          if (!parse || !(field in patch)) continue;
          if (sameValue(current[field], parse(expected))) continue;
          const by = await lastChangedBy(ctx.log, id, field);
          const name = by ? (ctx.nameOf?.(by) ?? undefined) : undefined;
          changed.push({ field, ...(name ? { by: name } : {}) });
        }
        if (changed.length > 0) {
          ctx.json(res, 409, {
            error: `${changed.map((c) => c.field).join(", ")} changed since${changed[0]?.by ? ` (by ${changed[0].by})` : ""}, so it was left.`,
            changed,
          });
          return true;
        }
      }
      const principal = ctx.principalOf?.(req);
      // TEAM-50: no one can assign new work to a member who left.
      if (typeof patch.assignee === "string" && ctx.refuseAssignment) {
        const refusal = await ctx.refuseAssignment(principal, patch.assignee, id);
        if (refusal) {
          ctx.json(res, 409, { error: refusal });
          return true;
        }
      }
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
      const version = cardVersion(card as unknown as Record<string, unknown>);
      res.setHeader("ETag", `"${version}"`);
      ctx.json(res, 200, { card, version, ...(rejected.length ? { ignored: rejected } : {}) });
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
        ctx.json(res, 404, { error: `No sprint ${id}` });
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
          // DB-N7-2: issues, unless the project's estimation is story points.
          ...(query.get("unit") === "issues" ? { unit: "issues" as const } : {}),
          ...(a.setup === "team" ? { canSee: (p: string | undefined) => a.canSee(me, p) } : {}),
        }),
      );
      return true;
    }

    // --- Flow metrics -------------------------------------------------------
    if (url === "/api/metrics/flow" && req.method === "GET") {
      const days = Math.min(365, Math.max(1, Number(query.get("days") ?? 30) || 30));
      // Measurement rule 4a: every role's token use over the same window.
      ctx.json(res, 200, {
        ...(await flowMetrics(ctx.log, days)),
        modelUse: await modelUse(ctx.log, days),
      });
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

  return { handle, streamFrames, pmStore, learning, ask };
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
    } else if (key === "folder") {
      // DS-N8-1: the folder a new project's approval creates, as the person changed it.
      if (typeof v !== "string" || !v.trim()) return null;
      out.folder = v.trim();
    } else {
      return null;
    }
  }
  return out;
}
