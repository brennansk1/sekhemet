import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CardStore } from "@sekhemet/kernel";
import { HttpInferenceAdapter, type LocalInferenceAdapter } from "@sekhemet/models";
import type { QueueReport } from "../execute.js";
import { LearningStore } from "../learning/store.js";
import {
  type PmSnapshot,
  answer,
  isStatusQuestion,
  ledgerStandup,
  summarizeConversation,
} from "./agent.js";
import { capabilityReport, capabilitySummary } from "./capability.js";
import { flowMetrics, monteCarloForecast } from "./metrics.js";
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

interface Lease {
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  pmModel?: string;
}

const leasePath = (repoPath: string) => join(repoPath, ".sekhemet", "runner.lock");

/**
 * Claim the runner lease for a `sekhemet queue` process.
 *
 * While a queue holds it, the queue answers PM messages between Worker steps,
 * because only it can unload the Worker; the dashboard answering at the same
 * time would load a second large model and exhaust memory.
 */
export function holdRunnerLease(repoPath: string, pmModel?: string): () => void {
  mkdirSync(join(repoPath, ".sekhemet"), { recursive: true });
  const now = new Date().toISOString();
  const lease: Lease = {
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now,
    ...(pmModel ? { pmModel } : {}),
  };
  writeFileSync(leasePath(repoPath), JSON.stringify(lease));
  const beat = setInterval(() => {
    try {
      writeFileSync(
        leasePath(repoPath),
        JSON.stringify({ ...lease, heartbeatAt: new Date().toISOString() }),
      );
    } catch {
      // A missed heartbeat only matters if the process is also gone.
    }
  }, 10_000);
  beat.unref();
  const release = () => {
    clearInterval(beat);
    try {
      const current = JSON.parse(readFileSync(leasePath(repoPath), "utf8")) as Lease;
      if (current.pid === process.pid) rmSync(leasePath(repoPath), { force: true });
    } catch {
      // Already gone.
    }
  };
  process.once("exit", release);
  return release;
}

/** The live lease holder, or undefined when no queue is running. */
export function runnerLease(repoPath: string): Lease | undefined {
  try {
    const lease = JSON.parse(readFileSync(leasePath(repoPath), "utf8")) as Lease;
    // A lease whose process is gone (a crash, a kill -9) is not a lease.
    process.kill(lease.pid, 0);
    return lease;
  } catch {
    return undefined;
  }
}

// --- Snapshot ----------------------------------------------------------------

function readReports(repoPath: string): QueueReport[] {
  const dir = join(repoPath, ".sekhemet", "runs");
  const reports: QueueReport[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      try {
        reports.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as QueueReport);
      } catch {
        // A partial report is skipped, not fatal.
      }
    }
  }
  if (reports.length === 0) {
    const latest = join(repoPath, ".sekhemet", "queue_report.json");
    if (existsSync(latest)) {
      try {
        reports.push(JSON.parse(readFileSync(latest, "utf8")) as QueueReport);
      } catch {
        // Ignore.
      }
    }
  }
  return reports;
}

/**
 * The Worker's track record, in one line the PM can plan against.
 *
 * This is the PM's model of its teammate: how often first attempts pass, how
 * many turns a pass takes, and what the failures were. It is what lets the
 * PM say "split it" rather than "retry it".
 */
export function workerRecord(
  reports: QueueReport[],
): { model: string; record: string } | undefined {
  const last = reports.at(-1);
  if (!last) return undefined;
  const entries = reports.slice(-3).flatMap((r) => r.entries);
  const first = entries.filter((e) => e.attempt === 1);
  const passed = first.filter((e) => e.passed);
  const turns = passed.map((e) => e.turns).sort((a, b) => a - b);
  const median = turns.length ? turns[Math.floor(turns.length / 2)] : undefined;
  const reasons = new Map<string, number>();
  for (const e of first.filter((x) => !x.passed)) {
    reasons.set(e.stopReason, (reasons.get(e.stopReason) ?? 0) + 1);
  }
  const failing = [...reasons].map(([r, n]) => `${r} ×${n}`).join(", ");
  return {
    model: last.model,
    record: `over the last ${Math.min(3, reports.length)} runs, ${passed.length}/${first.length} first attempts passed${median !== undefined ? `, a pass takes a median of ${median} turns` : ""}${failing ? `; failures: ${failing}` : ""}.`,
  };
}

export async function buildSnapshot(
  repoPath: string,
  cardStore: CardStore,
  pmStore: PmStore,
  pmModel: string,
): Promise<PmSnapshot> {
  const reports = readReports(repoPath);
  const recentRuns = reports
    .slice(-2)
    .flatMap((r) => r.entries)
    .map(
      (e) =>
        `- \`${e.cardId}\` attempt ${e.attempt}: ${e.passed ? "passed" : `failed (${e.stopReason})`} in ${e.turns} turns, ${Math.round(e.durationMs / 1000)}s`,
    );
  const cards = await cardStore.listCards();
  const record = workerRecord(reports);
  const measured = capabilitySummary(capabilityReport(repoPath, cards));
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
}

/**
 * Answer every queued PM message in one request.
 *
 * Returns false when nothing was queued. Errors become an error reply rather
 * than a thrown exception: the human is waiting on the thread, and a silent
 * failure there looks exactly like a PM that is still thinking.
 */
export async function answerQueued(deps: AnswerDeps): Promise<boolean> {
  const queued = await deps.pmStore.queued();
  if (queued.length === 0) return false;
  const stepInfo = deps.step !== undefined ? { step: deps.step, workerPaused: true } : {};

  // Status questions need facts, not judgement: answer from the ledger and
  // never pay a 40-120 s model swap (research: swap-cost mitigation).
  if (queued.every((m) => isStatusQuestion(m.text))) {
    const snapshot = await buildSnapshot(deps.repoPath, deps.cardStore, deps.pmStore, deps.pmModel);
    await deps.pmStore.appendReply({
      replyTo: queued.map((m) => m.id),
      text: ledgerStandup(snapshot),
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
    const snapshot = await buildSnapshot(deps.repoPath, deps.cardStore, deps.pmStore, deps.pmModel);
    const result = await answer(model, snapshot, history, queued, summary);
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
