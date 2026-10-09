import { basename, join } from "node:path";
import {
  type AttemptOutcome,
  type CardRecord,
  type CardStore,
  firstModelAttempts,
} from "@sekhemet/kernel";
import type { ModelHold, ModelRegistry } from "@sekhemet/models";
import { unenforcedInvariants } from "../architecture_gate.js";
import { LearningStore } from "../learning/store.js";
import { type SwapLedger, sharedQueue } from "../model_access.js";
import { projectStoryMap } from "../project_done.js";
import { registrySearch } from "../research/plan_research.js";
import { forecastSentence } from "../status_api.js";
import { takeoverPromptContext } from "../takeover_brief.js";
import {
  type PmSnapshot,
  type SnapshotDocument,
  answer,
  condenseNotes,
  documentsFitWhole,
  isStatusShaped,
  ledgerStandup,
  readDocumentInParts,
  seshatThreadId,
  standupBody,
  summarizeConversation,
} from "./agent.js";
import { type Audience, nameFor, soloAudience } from "./audience.js";
import { capabilityReport, capabilitySummary } from "./capability.js";
import { namedDecisions } from "./decisions.js";
import { failureDetail, seshatFailure } from "./failure.js";
import { guardProposals, judgementAnswer, judgementQuestion } from "./judgement.js";
import {
  briefText,
  cardsNamed,
  failureFacts,
  snapshotAssumptions,
  snapshotFindings,
  snapshotGoals,
} from "./knowledge.js";
import { draftProjectGroup } from "./pipeline.js";
import { type SlashBoard, parseSlash, resolveCard, runSlash } from "./slash.js";
import { recordStandupGiven, standupCardIds, standupFacts } from "./standup.js";
import type { PmStore } from "./store.js";
import { postSuggestions, suggestedText } from "./suggest.js";
import { PM_EVENTS, type PmMessage, type PmProposal } from "./types.js";
import {
  type SeshatWait,
  ledgerAnswer,
  ledgerCites,
  ledgerQuestion,
  quickAnswer,
  waitInWords,
} from "./while_worker.js";

/** The PM's model unless the user names another: the 27B dense manager. */
export const DEFAULT_PM_MODEL = "dirk-27b:latest";

/** Seconds a cold load of the PM usually takes on this class of machine. */
export const PM_LOAD_ETA_SECONDS = 45;

/**
 * Seshat's model for a caller that holds no queue (the dashboard, the ACP
 * bridge): the Planner role's `chat` queue on the process's one residency
 * scheduler (MD-N9-4), so a chat answer and a research question never hold
 * two large models at once. Each call returns a hold on the model, which
 * `answerQueued` releases when the answer is written.
 */
export function pmModelFor(
  modelId = DEFAULT_PM_MODEL,
  registry?: ModelRegistry,
  ledger?: SwapLedger,
  opts: { refuseUnknownFootprint?: boolean } = {},
): () => Promise<ModelHold> {
  return sharedQueue(
    {
      queue: "chat",
      role: "planner",
      name: modelId,
      ...(opts.refuseUnknownFootprint ? { refuseUnknownFootprint: true } : {}),
    },
    { ...(registry ? { registry } : {}), ...(ledger ? { ledger } : {}) },
  );
}

// --- Runner lease ------------------------------------------------------------

// The lease lives in its own module (NEW-runtime-1); re-exported for callers.
export {
  type Lease,
  type RosterEntry,
  holdRunnerLease,
  runnerLease,
} from "../runner_lease.js";

// --- Snapshot ----------------------------------------------------------------

/** How many recent first attempts the Worker's record covers. */
const RECORD_WINDOW = 30;

/**
 * The Worker's track record, in one line the PM can plan against.
 *
 * This is the PM's model of its teammate: how often first attempts pass, how
 * many steps a pass takes, and what the failures were. It is what lets the
 * PM say "split it" rather than "retry it". It reads the attempt records
 * alone (WL-N5-2), and a person's attempt is not the Worker's (MD-N6-2).
 */
export function workerRecord(
  outcomes: readonly AttemptOutcome[],
): { model: string; record: string } | undefined {
  const worker = outcomes.filter((o) => o.builtBy.kind !== "person");
  const last = worker.at(-1);
  if (!last) return undefined;
  const first = firstModelAttempts(worker).slice(-RECORD_WINDOW);
  const passed = first.filter((o) => o.passed);
  const steps = passed
    .map((o) => o.steps)
    .filter((n): n is number => n !== undefined)
    .sort((a, b) => a - b);
  const median = steps.length ? steps[Math.floor(steps.length / 2)] : undefined;
  const reasons = new Map<string, number>();
  for (const o of first.filter((x) => !x.passed)) {
    reasons.set(o.stopReason, (reasons.get(o.stopReason) ?? 0) + 1);
  }
  const failing = [...reasons].map(([r, n]) => `${r} ×${n}`).join(", ");
  return {
    model: last.modelId,
    record: `over the last ${first.length} first attempts, ${passed.length}/${first.length} first attempts passed${median !== undefined ? `, a pass takes a median of ${median} steps` : ""}${failing ? `; failures: ${failing}` : ""}.`,
  };
}

/** Who a snapshot is for, and what they can see (PM-N9-8); everything when no asker. */
export interface SnapshotScope {
  audience: Audience;
  asker?: string | undefined;
}

export async function buildSnapshot(
  repoPath: string,
  cardStore: CardStore,
  pmStore: PmStore,
  pmModel: string,
  scope?: SnapshotScope,
): Promise<PmSnapshot> {
  // PM-N9-8: only the projects and issues the asker can see; a figure that
  // would count what they cannot (the forecast, the story map) is left out.
  const everything = await cardStore.listCards();
  const cards = scope?.asker
    ? everything.filter((c) => scope.audience.canSee(scope.asker as string, c.projectId))
    : everything;
  const partial = cards.length !== everything.length;
  const visibleIds = new Set(cards.map((c) => c.id));
  const outcomes = cardStore.runs
    .readAttemptOutcomes()
    .filter((o) => !partial || visibleIds.has(o.cardId));
  const recentRuns = outcomes
    .slice(-10)
    .map(
      (o) =>
        `- \`${o.cardId}\` attempt ${o.attemptNumber}: ${o.passed ? "passed" : `failed (${o.stopReason})`}${o.steps !== undefined ? ` in ${o.steps} steps` : ""}, ${Math.round(o.secondsUsed)}s`,
    );
  const record = workerRecord(outcomes);
  const measured = capabilitySummary(capabilityReport(repoPath, cards, outcomes));
  const worker = record
    ? { model: record.model, record: `${record.record} ${measured}` }
    : undefined;
  const loose = unenforcedInvariants(join(repoPath, ".sekhemet", "brief.md"));
  // STA-01: Status's forecast, in Status's words, over the same issues.
  const forecast = partial ? undefined : await forecastSentence(cards, pmStore.log);
  const storyMap = partial
    ? undefined
    : await projectStoryMap({ repoPath, cardStore, log: pmStore.log }).catch(() => undefined);
  // PM-N9-5: each decision names its person, and its default and deadline.
  const decisions = await namedDecisions(
    { cardStore, log: pmStore.log },
    scope?.audience ?? soloAudience(),
    scope?.asker,
  ).catch(() => []);
  // DS-TO-10: a take-over's brief as found reaches Seshat only wrapped as
  // untrusted content, and only for an asker who sees the whole board.
  const takeover =
    !partial && (await cardStore.takeover.briefAsFound())
      ? await takeoverPromptContext(cardStore).catch(() => undefined)
      : undefined;
  // planner-pm §2.8.5, P6: the goals, the logged assumptions (and the risk
  // register they make), the Reviewer's findings and the brief, each over
  // what the asker can see (PM-N9-8) and with the id Seshat cites it by.
  const canSeeProject = (projectId: string | undefined) =>
    !scope?.asker || scope.audience.canSee(scope.asker, projectId);
  const knownCtx = { cardStore, log: pmStore.log };
  const goals = await snapshotGoals(knownCtx, canSeeProject).catch(() => []);
  const assumptions = await snapshotAssumptions(knownCtx, (id) => visibleIds.has(id)).catch(
    () => [],
  );
  const findings = await snapshotFindings(pmStore.log, (id) => visibleIds.has(id)).catch(() => []);
  const brief = partial ? undefined : briefText(repoPath);
  const learning = new LearningStore(pmStore.log);
  return {
    project: basename(repoPath),
    ...(forecast ? { forecast } : {}),
    ...(takeover?.blocks.length ? { takeover } : {}),
    cards,
    cycles: await pmStore.cycles(),
    recentRuns,
    ...(worker ? { worker } : {}),
    pmModel,
    // PM-P6-15: statements in force, their strength decayed without new evidence.
    preferences: (await learning.profileInForce()).slice(0, 6).map((p) => p.statement),
    // CX-N4-5, CX-N3-7: the approved PM rules, for Seshat alone.
    pmRules: await learning.seshatRules().catch(() => []),
    ...(goals.length ? { goals } : {}),
    ...(assumptions.length ? { assumptions } : {}),
    ...(findings.length ? { findings } : {}),
    ...(brief ? { brief } : {}),
    ...(loose.length > 0 ? { unenforcedInvariants: loose } : {}),
    // planner-pm §2.15: what is proven and unplanned, for the status and the claim guard.
    ...(storyMap ? { storyMap } : {}),
    ...(decisions.length ? { decisions } : {}),
    today: new Date().toISOString().slice(0, 10),
  };
}

// --- Answering ---------------------------------------------------------------

/** The event recording how Seshat's prompt was fitted (CX-N3-7). */
export const PM_PROMPT_FITTED = "pm/prompt_fitted";

/**
 * A card's dossier as Seshat reads it: one line per entry, oldest first. An
 * AI review finding carries its verdict and model (review-git RG-P8-9, -12).
 */
export async function dossierLines(cardStore: CardStore, cardId: string): Promise<string[]> {
  const dossier = await cardStore.getDossier(cardId).catch(() => undefined);
  return (dossier?.entries ?? []).map(
    (e) =>
      `- ${e.kind}${e.kind === "review" && e.verdict ? ` ${e.verdict}` : ""} (${e.actor}${e.modelId ? `, ${e.modelId}` : ""}): ${e.text}`,
  );
}

export interface AnswerDeps {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel: string;
  /**
   * Bring the PM model into memory (unloading the Worker if it may be
   * unloaded) and hold it: nothing evicts it until the answer releases it.
   */
  acquire: () => Promise<ModelHold>;
  /** The Worker step the queue paused after, for the status line. */
  step?: number;
  /** Who is on the team and what asking each costs right now. */
  team?: string;
  /** The Researcher, when configured; Seshat can delegate evidence questions. */
  researcher?: (
    question: string,
    opts?: { deep?: boolean },
  ) => Promise<import("../research/researcher.js").ResearchAnswer>;
  /**
   * When the full answer would start (the median) and whether it would break
   * the Worker's floor (models rule 20f, C5): the scheduler's `decide()`.
   */
  predictWait?: () => Promise<SeshatWait>;
  /**
   * The quick answerer a person named (a setting of the Planner role, rule
   * 20f b): used only when `admitted` says the measured headroom admits it.
   */
  quick?: {
    name: string;
    admitted: () => Promise<boolean>;
    acquire: () => Promise<ModelHold>;
  };
  /**
   * Who is asked and what each person can see (planner-pm §2.8.5, PM-N9-8;
   * teams item 19a). In the Team setup each person's messages are answered
   * apart, from what they can see; a Solo install when omitted.
   */
  audience?: Audience;
  /** The Planner role's model for /plan (PM-P1-2); the heuristic plans without it. */
  planner?: () => Promise<ModelHold>;
  /** The harness's board: a slash command's move goes through it (kernel K-S4-3). */
  board: SlashBoard;
}

/**
 * Answer every queued PM message in one request.
 *
 * Returns false when nothing was queued. Errors become an error reply rather
 * than a thrown exception: the human is waiting on the thread, and a silent
 * failure there looks exactly like a PM that is still thinking.
 */
/**
 * A snapshot with the standup's facts for the person it is for (PM-P6-3):
 * the one standup builder reads them, over what that person can see.
 */
async function standupSnapshot(
  deps: Pick<AnswerDeps, "repoPath" | "cardStore" | "pmStore" | "pmModel">,
  scope?: SnapshotScope,
  person?: string,
): Promise<PmSnapshot> {
  const snapshot = await buildSnapshot(
    deps.repoPath,
    deps.cardStore,
    deps.pmStore,
    deps.pmModel,
    scope,
  );
  const all = scope?.asker ? (await deps.cardStore.listCards()).length : snapshot.cards.length;
  const facts = await standupFacts({
    repoPath: deps.repoPath,
    cardStore: deps.cardStore,
    log: deps.pmStore.log,
    cards: snapshot.cards,
    cycles: snapshot.cycles,
    audience: scope?.audience ?? soloAudience(),
    person: person ?? scope?.asker ?? deps.cardStore.localPrincipal(),
    asker: scope?.asker,
    whole: all === snapshot.cards.length,
  });
  return { ...snapshot, standup: facts };
}

/** A standup answered in the chat: the one builder's text, its issues cited, recorded as given. */
async function chatStandup(
  deps: AnswerDeps,
  scope: SnapshotScope,
  replyTo: string[],
  to: { to?: string },
  /** A sentence before the standup (PM-02: why it comes from the log). */
  lead?: string,
): Promise<void> {
  const person = scope.asker ?? deps.cardStore.localPrincipal();
  const snapshot = await standupSnapshot(deps, scope, person);
  const ids = snapshot.standup ? standupCardIds(snapshot.standup) : [];
  await deps.pmStore.appendReply({
    replyTo,
    text: lead ? `${lead}\n\n${ledgerStandup(snapshot)}` : ledgerStandup(snapshot),
    ...(ids.length ? { cites: ids.map((cardId) => ({ cardId })) } : {}),
    model: "ledger",
    ...to,
  });
  await recordStandupGiven(deps.pmStore.log, person);
}

/**
 * Seshat's daily standup for the notifier (integrations item 21, INT-18):
 * the same one builder `/standup` answers from (PM-P6-3), for the person the
 * notifier addresses, with an overnight benchmark finished since their last
 * standup in plain words (PM-P6-14), built without loading a model. The
 * notifier's `pm/notify` record of a sent standup marks it as given.
 */
export async function dailyStandup(deps: {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel?: string;
  /** The person it is for; the install's person by default. */
  person?: string;
  /**
   * Who can see what (PM-N9-8): the standup names only the projects and
   * issues its recipient can see, as the chat's does. Solo when omitted.
   */
  audience?: Audience;
}): Promise<string> {
  const person = deps.person ?? deps.cardStore.localPrincipal();
  const snapshot = await standupSnapshot(
    { ...deps, pmModel: deps.pmModel ?? DEFAULT_PM_MODEL },
    { audience: deps.audience ?? soloAudience(), asker: person },
    person,
  );
  return standupBody(snapshot);
}

/** Whether a reply by `model` came after message `seq` (a note is said once per new message). */
async function saidSince(pmStore: PmStore, seq: number, model: string): Promise<boolean> {
  const replies = await pmStore.log.getEventsByTypes([PM_EVENTS.reply]);
  return replies.some(
    (e) => e.seq > seq && (e.payload as { model?: string } | undefined)?.model === model,
  );
}

/**
 * Rule 20f (b) and (c) while the Worker keeps its floor: a quick answer when
 * a quick answerer is named and headroom admits it — labelled, with no tools,
 * recording nothing it proposes — then the full answer's predicted wait in
 * words, each said once per new message; the messages stay queued.
 */
async function answerWhileWorkerRuns(
  deps: AnswerDeps,
  queued: PmMessage[],
  wait: SeshatWait,
  scope: SnapshotScope,
): Promise<void> {
  const to = scope.audience.setup === "team" && scope.asker ? { to: scope.asker } : {};
  const newest = Math.max(...queued.map((m) => m.seq));
  const quick = deps.quick;
  const quickModel = quick ? `${quick.name} (quick answer)` : undefined;
  if (
    quick &&
    quickModel &&
    !(await saidSince(deps.pmStore, newest, quickModel)) &&
    (await quick.admitted().catch(() => false))
  ) {
    let hold: ModelHold | undefined;
    try {
      hold = await quick.acquire();
      const snapshot = await buildSnapshot(
        deps.repoPath,
        deps.cardStore,
        deps.pmStore,
        deps.pmModel,
        scope,
      );
      const text = await quickAnswer(hold.adapter, snapshot, queued, quick.name);
      // No proposals, no cites: a quick answer never acts (rule 20f b).
      await deps.pmStore.appendReply({ replyTo: [], text, model: quickModel, ...to });
    } catch {
      // A quick answer that fails leaves the full answer queued, as before.
    } finally {
      hold?.release();
    }
  }
  if (!(await saidSince(deps.pmStore, newest, "scheduler")))
    await deps.pmStore.appendReply({
      replyTo: [],
      text: waitInWords(wait),
      model: "scheduler",
      ...to,
    });
  await deps.pmStore.setStatus({
    phase: "waiting_for_step",
    model: deps.pmModel,
    detail: waitInWords(wait),
    etaSeconds: Math.round(wait.waitMs / 1000),
    ...(deps.step !== undefined ? { step: deps.step, workerPaused: false } : {}),
  });
}

/** Who asked a message: its principal, else the install's person. */
const askerOf = (m: PmMessage, deps: AnswerDeps): string =>
  m.principal ?? deps.cardStore.localPrincipal();

/**
 * Answer every queued PM message. In the Team setup each person's messages
 * are answered apart, from the projects and issues that person can see and
 * their own part of the conversation (PM-N9-8); in Solo, all at once.
 */
export async function answerQueued(deps: AnswerDeps): Promise<boolean> {
  const all = await deps.pmStore.queued();
  if (all.length === 0) return false;
  const audience = deps.audience ?? soloAudience();
  if (audience.setup !== "team") {
    return answerFor(deps, all, { audience, asker: all.at(-1)?.principal });
  }
  const groups = new Map<string, PmMessage[]>();
  for (const m of all) groups.set(askerOf(m, deps), [...(groups.get(askerOf(m, deps)) ?? []), m]);
  let done = true;
  for (const [asker, messages] of groups) {
    if (!(await answerFor(deps, messages, { audience, asker }))) done = false;
  }
  return done;
}

/**
 * A long message kept whole as its own document (PM-N10-3): read by the
 * model as a document, never routed by a phrase inside it to a ledger or
 * rule answer meant for a short question.
 */
const isDocument = (m: PmMessage): boolean => Boolean(m.documents?.some((d) => d.fromMessage));

/** Slash commands that change the board: a Member's, in the Team setup (TEAM-40). */
const MEMBER_COMMANDS = new Set(["plan", "ready", "park", "backlog"]);
/** Of those, the ones that name a card, whose own project's level applies (TEAM-6, -40). */
const CARD_COMMANDS = new Set(["ready", "park", "backlog"]);

/**
 * PM-N9-3: a request to assign an issue to a person or to set a project's
 * health changes nothing. The reply says who can, and — for an assignment,
 * never for health — offers it as a suggestion on the issue.
 */
async function authorityAnswer(
  deps: AnswerDeps,
  m: PmMessage,
  scope: SnapshotScope,
  cards: CardRecord[],
): Promise<{ text: string; proposals: Omit<PmProposal, "id" | "state">[] } | undefined> {
  const text = m.text.trim();
  const { audience } = scope;
  const asker = scope.asker ?? deps.cardStore.localPrincipal();
  const solo = audience.setup !== "team";
  // "Set the project's health to at risk", "mark the project off track".
  const health =
    /\b(?:set|mark|make|change|update|put|flag)\b[^.?]*\bhealth\b/i.test(text) ||
    /\b(?:set|mark|make|call|flag|put)\b[^.?]*\b(?:project|release)\b[^.?]*\b(?:on track|at risk|off track)\b/i.test(
      text,
    );
  if (health) {
    const card = cards.find((c) => c.id === m.context?.cardId);
    const lead = audience.leadOf(card?.projectId ?? cards[0]?.projectId);
    const who = solo
      ? "you"
      : lead
        ? `${nameFor(audience, lead, asker)}, the project lead,`
        : "the project lead";
    return {
      text: `A project's health is a person's call, never mine: ${who} ${who === "you" ? "set" : "sets"} it on the project's Status page. I can draft the weekly update without it (/update).`,
      proposals: [],
    };
  }
  const assign = /\bassign\b[^.?]*?\bto\s+(me|p_[0-9a-z]+|[A-Za-z][\w'-]*)/i.exec(text);
  // "who should I assign this to?" names no one: a question for Seshat's judgement.
  if (
    !assign ||
    /^(?:this|that|it|them|someone|somebody|who|whom|whoever)$/i.test(assign[1] ?? "")
  ) {
    return undefined;
  }
  const target = assign[1] ?? "";
  const card =
    cards.find((c) => c.id === m.context?.cardId) ??
    cards.find((c) => text.includes(c.id)) ??
    cards.find((c) => c.title.length > 3 && text.toLowerCase().includes(c.title.toLowerCase()));
  const person =
    /^me$/i.test(target) || audience.nameOf(asker)?.toLowerCase() === target.toLowerCase()
      ? asker
      : /^p_/.test(target)
        ? target
        : undefined;
  const whoCan = card?.owner
    ? `${nameFor(audience, card.owner, asker)} ${card.owner === asker ? "own" : "owns"} ${card.title} and can assign it${solo ? "" : ", as can any Member"}`
    : solo
      ? "you can assign it on the board"
      : "a Member can assign it on the board";
  const lead = `Assigning is a person's call, not mine: ${whoCan}.`;
  const viewer = !solo && audience.levelOf(asker) === "viewer";
  if (!card || !person || viewer) {
    return {
      text: `${lead}${!card ? " Open the issue, or name it, and I can post the assignment there as a suggestion." : !person ? ` I could not tell who "${target}" is; name them as they appear on the team.` : ""}`,
      proposals: [],
    };
  }
  const why = `${nameFor(audience, asker)} asked for it in the chat`;
  const draft = {
    kind: "update_card" as const,
    cardId: card.id,
    patch: { assignee: person },
    before: { assignee: card.assignee ?? null },
    why,
    summary: `Suggested: ${suggestedText({ kind: "assignee", value: person }, card.title, (p) => nameFor(audience, p))}. Why: ${why}.`,
  };
  const posted = await postSuggestions([draft], {
    cardStore: deps.cardStore,
    cards,
    audience,
    asker,
  });
  const offered = posted.drafts.length
    ? ` Suggested: ${suggestedText({ kind: "assignee", value: person }, card.title, (p) => nameFor(audience, p))}, on the issue for ${card.owner && card.owner !== asker ? nameFor(audience, card.owner, asker) : "a person"} to apply.`
    : "";
  return { text: `${lead}${offered}`, proposals: posted.drafts };
}

async function answerFor(
  deps: AnswerDeps,
  all: PmMessage[],
  scope: SnapshotScope,
): Promise<boolean> {
  const team = scope.audience.setup === "team";
  const to = team && scope.asker ? { to: scope.asker } : {};
  const asker = scope.asker ?? deps.cardStore.localPrincipal();
  const level = team && scope.asker ? scope.audience.levelOf(scope.asker) : "admin";
  const snap = () =>
    buildSnapshot(deps.repoPath, deps.cardStore, deps.pmStore, deps.pmModel, scope);
  // H16: slash commands are answered by code, from the ledger, before any
  // model loads; /plan is rewritten into the request it stands for.
  const queued: typeof all = [];
  for (const m of all) {
    const cmd = parseSlash(m.text);
    if (!cmd) {
      queued.push(m);
      continue;
    }
    if (cmd.name === "status" || cmd.name === "standup") {
      await chatStandup(deps, scope, [m.id], to);
      continue;
    }
    // TEAM-40: a command that changes the board is checked as its endpoint is
    // — TEAM-6, at the level of the card it names, when it names one.
    if (MEMBER_COMMANDS.has(cmd.name)) {
      let cardLevel = level;
      if (team && CARD_COMMANDS.has(cmd.name)) {
        const cardId = await resolveCard(deps.cardStore, cmd.args, scope);
        if (cardId) {
          const card = await deps.cardStore.getCard(cardId);
          cardLevel = scope.audience.levelOf(asker, card?.projectId);
        }
      }
      if (cardLevel !== "member" && cardLevel !== "admin") {
        await deps.pmStore.appendReply({
          replyTo: [m.id],
          text: `You're ${cardLevel === undefined ? "not a member here" : `a ${cardLevel === "viewer" ? "Viewer" : "Stakeholder"} here`}; a Member can run /${cmd.name}.`,
          model: "command",
          ...to,
        });
        continue;
      }
    }
    // PM-P1-2: /plan with the Planner's model when one is given.
    let plannerHold: ModelHold | undefined;
    if (cmd.name === "plan" && deps.planner) {
      plannerHold = await deps.planner().catch(() => undefined);
    }
    const outcome = await runSlash(cmd, {
      cardStore: deps.cardStore,
      board: deps.board,
      pmStore: deps.pmStore,
      repoPath: deps.repoPath,
      researcher: deps.researcher,
      audience: scope.audience,
      asker: scope.asker,
      ...(plannerHold ? { planner: plannerHold.adapter } : {}),
    })
      .catch((err) => ({
        reply: `The command failed: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .finally(() => plannerHold?.release());
    if ("reply" in outcome) {
      await deps.pmStore.appendReply({
        replyTo: [m.id],
        text: outcome.reply,
        model: "command",
        ...to,
      });
    } else if ("forward" in outcome) {
      queued.push({ ...m, text: outcome.forward });
    } else {
      queued.push(m);
    }
  }
  if (queued.length === 0) return true;
  const stepInfo = deps.step !== undefined ? { step: deps.step, workerPaused: true } : {};

  // PM-N9-3: assigning a person and setting health are people's calls.
  const visibleCards = (await snap()).cards;
  const rest: typeof queued = [];
  for (const m of queued) {
    const a = isDocument(m) ? undefined : await authorityAnswer(deps, m, scope, visibleCards);
    if (!a) {
      rest.push(m);
      continue;
    }
    await deps.pmStore.appendReply({
      replyTo: [m.id],
      text: a.text,
      proposals: a.proposals,
      model: "ledger",
      ...to,
    });
  }
  if (rest.length === 0) return true;
  queued.splice(0, queued.length, ...rest);

  // Rule 20f (a): status, where the cards stop, what waits on the person and
  // the predicted wait need facts, not judgement: answered from the ledger
  // and the board, with no model and never a swap (MD-N14-27).
  let wait: SeshatWait | undefined;
  const toAnswer: typeof queued = [];
  for (const m of queued) {
    const kind = isDocument(m) ? undefined : ledgerQuestion(m.text);
    if (!kind) {
      toAnswer.push(m);
      continue;
    }
    if (kind === "status") {
      await chatStandup(deps, scope, [m.id], to);
      continue;
    }
    if (kind === "wait") wait ??= await deps.predictWait?.();
    const snapshot = await snap();
    const cites = ledgerCites(kind, snapshot);
    await deps.pmStore.appendReply({
      replyTo: [m.id],
      text: ledgerAnswer(kind, snapshot, wait),
      ...(cites.length ? { cites } : {}),
      model: "ledger",
      ...to,
    });
  }
  if (toAnswer.length === 0) return true;
  queued.splice(0, queued.length, ...toAnswer);

  // P6 (PM-P6-7, -8, -9, -14): what is at risk, the next sprint's bet, a
  // split instead of a retry over the size horizon and how a benchmark's
  // result is applied are judged by code from the ledger, whatever the small
  // local model would write; a retry within the horizon goes on to it.
  const toJudge: typeof queued = [];
  for (const m of queued) {
    const kind = isDocument(m) ? undefined : judgementQuestion(m.text);
    const snapshot = kind ? await snap() : undefined;
    const judged =
      kind && snapshot
        ? await judgementAnswer(
            kind,
            { repoPath: deps.repoPath, cardStore: deps.cardStore, log: deps.pmStore.log },
            { cards: snapshot.cards, cycles: snapshot.cycles },
            { text: m.text, cardId: m.context?.cardId },
          )
        : undefined;
    if (!judged) {
      toJudge.push(m);
      continue;
    }
    const posted = await postSuggestions(judged.proposals, {
      cardStore: deps.cardStore,
      cards: snapshot?.cards ?? [],
      audience: scope.audience,
      asker: scope.asker,
      // PM-N9-2: what an Admin's auto-apply rule needs to make the change.
      pmStore: deps.pmStore,
      repoPath: deps.repoPath,
    });
    await deps.pmStore.appendReply({
      replyTo: [m.id],
      text: posted.notes.length ? `${judged.text}\n\n${posted.notes.join(" ")}` : judged.text,
      proposals: posted.drafts,
      ...(judged.cites.length ? { cites: judged.cites } : {}),
      model: "ledger",
      ...to,
    });
  }
  if (toJudge.length === 0) return true;
  queued.splice(0, queued.length, ...toJudge);

  // Rule 20f (b), (c): when the full answer would break the Worker's floor
  // (C5), a quick answer if one is admitted, the predicted wait in words,
  // and the question stays queued for the full answer (MD-N14-28, -29).
  wait ??= await deps.predictWait?.();
  if (wait?.quickPath) {
    await answerWhileWorkerRuns(deps, queued, wait, scope);
    return false;
  }

  let hold: ModelHold | undefined;
  try {
    await deps.pmStore.setStatus({
      phase: "loading_pm",
      model: deps.pmModel,
      detail: wait && wait.waitMs > 0 ? waitInWords(wait) : "Starting Seshat",
      etaSeconds: wait ? Math.round(wait.waitMs / 1000) : PM_LOAD_ETA_SECONDS,
      ...stepInfo,
    });
    hold = await deps.acquire();
    const model = hold.adapter;
    await deps.pmStore.setStatus({
      phase: "thinking",
      model: deps.pmModel,
      detail: "Reading the board and runs",
      ...stepInfo,
    });
    // PM-N9-8: in the Team setup, only this person's part of the conversation
    // (their messages, and the replies addressed to them).
    const history = (await deps.pmStore.thread()).filter(
      (m) => m.state === "done" && (!team || m.principal === scope.asker),
    );
    let summary = team ? undefined : await deps.pmStore.summary();
    const compactAsked = queued.some((m) => /^\s*\/compact\b/i.test(m.text));
    // Fold everything but the last 8 messages into the summary once there are
    // more than 16 unsummarised ones, or whenever the human asks (/compact).
    const unsummarised = history.filter((m) => !summary || m.seq > summary.upToSeq);
    if (compactAsked || unsummarised.length > 16) {
      // An explicit /compact keeps only the last exchange verbatim.
      const keep = compactAsked ? 2 : 8;
      const fold = unsummarised.slice(0, Math.max(0, unsummarised.length - keep));
      if (fold.length > 0 && !team) {
        const text = await summarizeConversation(model, summary?.text, fold);
        const upToSeq = fold.at(-1)?.seq ?? 0;
        await deps.pmStore.appendSummary(upToSeq, text);
        summary = { upToSeq, text };
      }
    }
    if (compactAsked && queued.every((m) => /^\s*\/compact\b/i.test(m.text))) {
      await deps.pmStore.appendReply({
        replyTo: queued.map((m) => m.id),
        text: summary
          ? `Compacted. What I am carrying forward:\n\n${summary.text}`
          : "Nothing to compact yet.",
        model: deps.pmModel,
        ...to,
      });
      return true;
    }
    // CX-N3-7: the dossier of the card the person is looking at, newest message first.
    const base = await snap();
    const seen = new Set(base.cards.map((c) => c.id));
    const inView = [...queued]
      .reverse()
      .find((m) => m.context?.cardId && seen.has(m.context.cardId))?.context?.cardId;
    const dossier = inView ? await dossierLines(deps.cardStore, inView) : undefined;
    // PM-P6-6: the failure evidence of the issues the person is asking about
    // (the one in view, and any the messages name), at most three.
    const asked = [
      ...new Set([
        ...(inView ? [inView] : []),
        ...queued.flatMap((m) => cardsNamed(m.text, base.cards).map((c) => c.id)),
      ]),
    ].slice(0, 3);
    const failures = (
      await Promise.all(asked.map((id) => failureFacts(deps.cardStore, deps.repoPath, id)))
    ).filter((f) => f !== undefined);
    const snapshot: PmSnapshot = {
      ...base,
      ...(deps.team ? { team: deps.team } : {}),
      ...(inView && dossier?.length ? { dossier: { cardId: inView, lines: dossier } } : {}),
      ...(failures.length ? { failures } : {}),
    };
    // PM-N10-3: the documents these messages carry, whole when the window
    // holds them; otherwise each is read in parts first (every character),
    // the reading recorded so a retry does not read it again.
    const attached = await deps.pmStore.attachedDocuments(queued.map((m) => m.id));
    if (attached.length) {
      snapshot.documents = attached;
      if (!documentsFitWhole(model, snapshot, history, queued, summary, Boolean(deps.researcher))) {
        const read: SnapshotDocument[] = [];
        // The documents read now (not from an earlier reading), with the window they were read at.
        const freshlyRead = new Map<string, number>();
        for (const d of attached) {
          if (d.text === undefined) {
            read.push(d);
            continue;
          }
          const text = d.text;
          const notes = await deps.pmStore.documentNotes(d.id);
          if (notes) {
            read.push({ ...d, read: notes });
            continue;
          }
          const fresh = await readDocumentInParts(model, { ...d, text }, (i, n) =>
            deps.pmStore.setStatus({
              phase: "thinking",
              model: deps.pmModel,
              detail: `Reading ${d.name}, part ${i} of ${n}`,
              ...stepInfo,
            }),
          );
          freshlyRead.set(d.id, fresh.windowTokens);
          read.push({ ...d, read: { parts: fresh.parts, notes: fresh.notes } });
        }
        // PM-N10-3: notes too long to sit beside the prompt are read again in
        // parts (notes on the notes) until they fit; a reply made without them
        // never cites them (agent.ts `answer`).
        const condensed = await condenseNotes(
          model,
          read,
          (docs) =>
            documentsFitWhole(
              model,
              { ...snapshot, documents: docs },
              history,
              queued,
              summary,
              Boolean(deps.researcher),
            ),
          (name, i, n) =>
            deps.pmStore.setStatus({
              phase: "thinking",
              model: deps.pmModel,
              detail: `Condensing the notes on ${name}, part ${i} of ${n}`,
              ...stepInfo,
            }),
        );
        // The reading is recorded as it will be used, so a retry reads nothing again.
        for (const [i, d] of condensed.entries()) {
          const windowTokens = freshlyRead.get(d.id);
          const changed = d.read?.condensed !== read[i]?.read?.condensed;
          if (!d.read || (windowTokens === undefined && !changed)) continue;
          await deps.pmStore.recordDocumentRead({
            messageId: d.messageId,
            documentId: d.id,
            parts: d.read.parts,
            windowTokens: windowTokens ?? model.contextWindow?.contextTokens ?? 0,
            notes: d.read.notes,
            ...(d.read.condensed ? { condensed: d.read.condensed } : {}),
          });
        }
        snapshot.documents = condensed;
      }
    }
    const result = await answer(
      model,
      snapshot,
      history,
      queued,
      summary,
      // DS-P7-9: Seshat's find_library searches through the research policy,
      // or nothing when research is not allowed (B4.5).
      registrySearch(deps.repoPath, deps.pmStore.log),
      deps.researcher,
      seshatThreadId(deps.repoPath),
      // PM-P2-1: a new project's proposal group, planned by the held model
      // (it is held in the Planner role) unless the Planner is "none".
      (sentence) =>
        draftProjectGroup(
          { repoPath: deps.repoPath, cardStore: deps.cardStore, log: deps.pmStore.log },
          sentence,
          deps.planner ? { adapter: model } : {},
        ),
    );
    // PM-P6-8, -9: the sprint bet and split-not-retry hold whatever the model wrote.
    const guarded = await guardProposals(
      result.proposals,
      { cardStore: deps.cardStore, log: deps.pmStore.log },
      { cards: snapshot.cards, cycles: snapshot.cycles },
    );
    // PM-N9-1, -9; TEAM-19, -40: triage changes become suggestions on the
    // issue, a change to someone else's issue is marked for its owner, a
    // Viewer is offered none.
    const posted = await postSuggestions(guarded.proposals, {
      cardStore: deps.cardStore,
      cards: snapshot.cards,
      audience: scope.audience,
      asker: scope.asker,
      // PM-N9-2: under an Admin's auto-apply rule the change is made now.
      pmStore: deps.pmStore,
      repoPath: deps.repoPath,
    });
    const reply = await deps.pmStore.appendReply({
      replyTo: queued.map((m) => m.id),
      text: [result.text, guarded.notes.join(" "), posted.notes.join(" ")]
        .filter(Boolean)
        .join("\n\n"),
      proposals: posted.drafts,
      cites: result.cites,
      model: deps.pmModel,
      ...to,
    });
    // CX-N3-7: what Seshat's prompt was fitted to, and each section's tokens.
    if (result.promptBudget && result.promptSections) {
      await deps.pmStore.log.append({
        actor: "harness",
        type: PM_PROMPT_FITTED,
        payload: {
          reply: reply.id,
          ...result.promptBudget,
          sections: result.promptSections.map((x) => ({ id: x.id, tokens: x.tokens })),
        },
      });
    }
  } catch (err) {
    // PM-01: a plain sentence and its cause in the conversation; the
    // exception's own text (paths, addresses, variables) to the server's log.
    const failure = seshatFailure(err);
    console.error(`Seshat could not reply (${failure.cause}): ${failureDetail(err)}`);
    // PM-02: with no model, "How is it going?" is answered as /status is.
    const statusShaped =
      failure.cause === "no_model"
        ? queued.filter((m) => !isDocument(m) && isStatusShaped(m.text))
        : [];
    if (statusShaped.length) {
      await chatStandup(
        deps,
        scope,
        statusShaped.map((m) => m.id),
        to,
        "No model is answering for Seshat right now, so this is the standup from the Activity log.",
      );
    }
    const unanswered = queued.filter((m) => !statusShaped.includes(m));
    if (unanswered.length === 0) return true;
    await deps.pmStore.appendReply({
      replyTo: unanswered.map((m) => m.id),
      text: failure.text,
      error: true,
      cause: failure.cause,
      model: deps.pmModel,
      ...to,
    });
  } finally {
    hold?.release();
    await deps.pmStore.setStatus({ phase: "idle" });
  }
  return true;
}
