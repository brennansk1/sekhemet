import { basename } from "node:path";
import { type AttemptOutcome, type CardStore, firstModelAttempts } from "@sekhemet/kernel";
import { HttpInferenceAdapter, type LocalInferenceAdapter } from "@sekhemet/models";
import { LearningStore } from "../learning/store.js";
import { plannerStandupSection } from "../wave2.js";
import {
  type PmSnapshot,
  answer,
  isStatusQuestion,
  ledgerStandup,
  summarizeConversation,
} from "./agent.js";
import { capabilityReport, capabilitySummary } from "./capability.js";
import { flowMetrics, monteCarloForecast } from "./metrics.js";
import { parseSlash, runSlash } from "./slash.js";
import type { PmStore } from "./store.js";

/** The PM's model unless the user names another: the 27B dense manager. */
export const DEFAULT_PM_MODEL = "dirk-27b:latest";

/** Seconds a cold load of the PM usually takes on this class of machine. */
export const PM_LOAD_ETA_SECONDS = 45;

export function createPmAdapter(modelId = DEFAULT_PM_MODEL): HttpInferenceAdapter {
  return new HttpInferenceAdapter({
    modelId,
    apiFormat: "ollama",
    contextTokens: 8192,
    maxTokens: 1200,
    disableReasoning: true,
    sampling: { temperature: 0.3, topP: 0.9, topK: 20, minP: 0 },
  });
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

export async function buildSnapshot(
  repoPath: string,
  cardStore: CardStore,
  pmStore: PmStore,
  pmModel: string,
): Promise<PmSnapshot> {
  const outcomes = cardStore.runs.readAttemptOutcomes();
  const recentRuns = outcomes
    .slice(-10)
    .map(
      (o) =>
        `- \`${o.cardId}\` attempt ${o.attemptNumber}: ${o.passed ? "passed" : `failed (${o.stopReason})`}${o.steps !== undefined ? ` in ${o.steps} steps` : ""}, ${Math.round(o.secondsUsed)}s`,
    );
  const cards = await cardStore.listCards();
  const record = workerRecord(outcomes);
  const measured = capabilitySummary(capabilityReport(repoPath, cards, outcomes));
  const worker = record
    ? { model: record.model, record: `${record.record} ${measured}` }
    : undefined;
  const remaining = cards.filter((c) => !["done", "rejected", "parked"].includes(c.status)).length;
  const cfd = (await flowMetrics(pmStore.log, 60)).cfd;
  const daily = cfd.slice(1).map((d, i) => Math.max(0, d.done - (cfd[i]?.done ?? 0)));
  const fc = monteCarloForecast(daily, remaining);
  const forecast = fc
    ? `${remaining} cards left: 50% likely within ${fc.p50Days} day(s), 85% within ${fc.p85Days} (from ${fc.samples} days of history).`
    : undefined;
  return {
    project: basename(repoPath),
    ...(forecast ? { forecast } : {}),
    cards,
    cycles: await pmStore.cycles(),
    recentRuns,
    ...(worker ? { worker } : {}),
    pmModel,
    preferences: (await new LearningStore(pmStore.log).profile())
      .filter((p) => p.status === "active")
      .slice(0, 6)
      .map((p) => p.statement),
    today: new Date().toISOString().slice(0, 10),
  };
}

// --- Answering ---------------------------------------------------------------

export interface AnswerDeps {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel: string;
  /** Bring the PM model into memory (unloading the Worker if it holds it). */
  acquire: () => Promise<LocalInferenceAdapter>;
  /** The Worker step the queue paused after, for the status line. */
  step?: number;
  /** Who is on the team and what asking each costs right now. */
  team?: string;
  /** The Researcher, when configured; Seshat can delegate evidence questions. */
  researcher?: (
    question: string,
    opts?: { deep?: boolean },
  ) => Promise<import("../research/researcher.js").ResearchAnswer>;
}

/**
 * Answer every queued PM message in one request.
 *
 * Returns false when nothing was queued. Errors become an error reply rather
 * than a thrown exception: the human is waiting on the thread, and a silent
 * failure there looks exactly like a PM that is still thinking.
 */
/** Seshat's standup plus the planner's decisions waiting and next window (P13). */
async function withPlannerStandup(
  text: string,
  deps: Pick<AnswerDeps, "cardStore" | "pmStore">,
): Promise<string> {
  const extra = await plannerStandupSection(deps.cardStore, deps.pmStore.log).catch(() => "");
  if (!extra) return text;
  const marker = "\n\n_Answered from the ledger";
  const at = text.indexOf(marker);
  return at === -1 ? `${text}\n${extra}` : `${text.slice(0, at)}\n${extra}${text.slice(at)}`;
}

/**
 * Seshat's daily standup for the notifier (integrations item 21, INT-18):
 * the same ledger standup `/standup` answers, with the planner's decisions
 * waiting, built without loading a model.
 */
export async function dailyStandup(deps: {
  repoPath: string;
  cardStore: CardStore;
  pmStore: PmStore;
  pmModel?: string;
}): Promise<string> {
  const snapshot = await buildSnapshot(
    deps.repoPath,
    deps.cardStore,
    deps.pmStore,
    deps.pmModel ?? DEFAULT_PM_MODEL,
  );
  const text = await withPlannerStandup(ledgerStandup(snapshot), deps);
  const marker = text.indexOf("\n\n_Answered from the ledger");
  return marker === -1 ? text : text.slice(0, marker);
}

export async function answerQueued(deps: AnswerDeps): Promise<boolean> {
  const all = await deps.pmStore.queued();
  if (all.length === 0) return false;
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
      const snapshot = await buildSnapshot(
        deps.repoPath,
        deps.cardStore,
        deps.pmStore,
        deps.pmModel,
      );
      await deps.pmStore.appendReply({
        replyTo: [m.id],
        text: await withPlannerStandup(ledgerStandup(snapshot), deps),
        model: "ledger",
      });
      continue;
    }
    const outcome = await runSlash(cmd, {
      cardStore: deps.cardStore,
      pmStore: deps.pmStore,
      repoPath: deps.repoPath,
      researcher: deps.researcher,
    }).catch((err) => ({
      reply: `The command failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
    if ("reply" in outcome) {
      await deps.pmStore.appendReply({ replyTo: [m.id], text: outcome.reply, model: "command" });
    } else if ("forward" in outcome) {
      queued.push({ ...m, text: outcome.forward });
    } else {
      queued.push(m);
    }
  }
  if (queued.length === 0) return true;
  const stepInfo = deps.step !== undefined ? { step: deps.step, workerPaused: true } : {};

  // Status questions need facts, not judgement: answer from the ledger and
  // never pay a 40-120 s model swap (research: swap-cost mitigation).
  if (queued.every((m) => isStatusQuestion(m.text))) {
    const snapshot = await buildSnapshot(deps.repoPath, deps.cardStore, deps.pmStore, deps.pmModel);
    await deps.pmStore.appendReply({
      replyTo: queued.map((m) => m.id),
      text: await withPlannerStandup(ledgerStandup(snapshot), deps),
      model: "ledger",
    });
    return true;
  }

  try {
    await deps.pmStore.setStatus({
      phase: "loading_pm",
      model: deps.pmModel,
      detail: `Loading the PM (${deps.pmModel})`,
      etaSeconds: PM_LOAD_ETA_SECONDS,
      ...stepInfo,
    });
    const model = await deps.acquire();
    await deps.pmStore.setStatus({
      phase: "thinking",
      model: deps.pmModel,
      detail: "Reading the board and runs",
      ...stepInfo,
    });
    const history = (await deps.pmStore.thread()).filter((m) => m.state === "done");
    let summary = await deps.pmStore.summary();
    const compactAsked = queued.some((m) => /^\s*\/compact\b/i.test(m.text));
    // Fold everything but the last 8 messages into the summary once there are
    // more than 16 unsummarised ones, or whenever the human asks (/compact).
    const unsummarised = history.filter((m) => !summary || m.seq > summary.upToSeq);
    if (compactAsked || unsummarised.length > 16) {
      // An explicit /compact keeps only the last exchange verbatim.
      const keep = compactAsked ? 2 : 8;
      const fold = unsummarised.slice(0, Math.max(0, unsummarised.length - keep));
      if (fold.length > 0) {
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
      });
      return true;
    }
    const snapshot = {
      ...(await buildSnapshot(deps.repoPath, deps.cardStore, deps.pmStore, deps.pmModel)),
      ...(deps.team ? { team: deps.team } : {}),
    };
    const result = await answer(
      model,
      snapshot,
      history,
      queued,
      summary,
      undefined,
      deps.researcher,
    );
    await deps.pmStore.appendReply({
      replyTo: queued.map((m) => m.id),
      text: result.text,
      proposals: result.proposals,
      cites: result.cites,
      model: deps.pmModel,
    });
  } catch (err) {
    await deps.pmStore.appendReply({
      replyTo: queued.map((m) => m.id),
      text: `I could not answer: ${err instanceof Error ? err.message : String(err)}. Your message is kept; send it again once the model is available.`,
      error: true,
      model: deps.pmModel,
    });
  } finally {
    await deps.pmStore.setStatus({ phase: "idle" });
  }
  return true;
}
