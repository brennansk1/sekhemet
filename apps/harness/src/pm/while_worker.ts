import type { CardRecord } from "@sekhemet/kernel";
import { type LocalInferenceAdapter, plannerCopy } from "@sekhemet/models";
import { guardCompletionClaim } from "@sekhemet/planner";
import { type PmSnapshot, isStatusQuestion, ledgerStandup, stripThinking } from "./agent.js";
import type { PmMessage } from "./types.js";

/**
 * Seshat while the Worker runs (models rule 20f, MD-N14-27–29). A person who
 * writes to Seshat during a card would otherwise wait out a round trip of
 * minutes, so they are answered in this order:
 *
 * - **(a) Deterministic answers, with no model,** from the ledger and the
 *   board: status, where the cards stop, what waits on the person, and every
 *   predicted wait (`ledgerQuestion`, `ledgerAnswer`).
 * - **(b) A quick answer,** only when a person named a quick answerer and the
 *   measured headroom admits it: labelled, informational, given no tools,
 *   and never able to create or change a card, plan, proposal or decision
 *   (`quickAnswer`; the headroom check is the caller's `admitted`).
 * - **(c) The full answer,** queued under the interactive cap with its
 *   predicted wait in words (`waitInWords`) and a hold for the thread.
 */

export type LedgerQuestion = "status" | "stops" | "waiting" | "wait";

/** A question the ledger and the board answer with no model, or undefined. */
export function ledgerQuestion(text: string): LedgerQuestion | undefined {
  if (isStatusQuestion(text)) return "status";
  const t = text.trim();
  if (/\bwhere\b.*\bcards?\b.*\bstop/i.test(t) || /\bwhere\b.*\b(stuck|blocked)\b/i.test(t))
    return "stops";
  if (/\b(what|anything)\b.*\b(wait(s|ing)?|need(s|ed)?|blocked)\b.*\b(on|for|from) me\b/i.test(t))
    return "waiting";
  if (
    /\bhow long\b.*\b(answer|reply|respond|wait)/i.test(t) ||
    /\bwhen (will|can|do) you (answer|reply|respond)/i.test(t) ||
    /\b(predicted|expected) wait\b/i.test(t)
  )
    return "wait";
  return undefined;
}

/** When the full answer would start (the median), and why it waits. */
export interface SeshatWait {
  waitMs: number;
  /** The full answer would break the Worker's floor (C5): rule 20f's quick path meanwhile. */
  quickPath: boolean;
  /** The rest of the Worker's current step. */
  stepMs?: number;
  /** Switching models (the round trip's load). */
  switchMs?: number;
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/** The predicted wait in words (rule 20f c). */
export function waitInWords(w: SeshatWait): string {
  const n = minutes(w.waitMs);
  const why: string[] = [];
  if (w.stepMs !== undefined && w.stepMs > 0) why.push("the agent is finishing a step");
  if (w.switchMs !== undefined && w.switchMs > 0)
    why.push(
      w.switchMs < 60_000
        ? "switching takes under a minute"
        : `switching takes about ${minutes(w.switchMs)}`,
    );
  const head = `I'll answer in about ${n} minute${n === 1 ? "" : "s"}`;
  return why.length ? `${head}: ${why.join(", and ")}.` : `${head}.`;
}

const FROM_LEDGER = "\n\n_Answered from the ledger without loading a model._";

const name = (c: CardRecord) => `${c.title} (\`${c.id}\`)`;

/** A deterministic answer from the ledger and the board (rule 20f a). */
export function ledgerAnswer(
  kind: LedgerQuestion,
  snapshot: PmSnapshot,
  wait?: SeshatWait,
): string {
  if (kind === "status") return ledgerStandup(snapshot);
  if (kind === "stops") {
    const stopped = snapshot.cards.filter(
      (c) => c.stopReason && c.stopReason !== "gate_passed" && c.status !== "done",
    );
    const text = stopped.length
      ? `Where the cards stop: ${stopped.map((c) => `${name(c)} stopped on ${c.stopReason}`).join("; ")}.`
      : "No card has stopped short.";
    return `${text}${FROM_LEDGER}`;
  }
  if (kind === "waiting") {
    const review = snapshot.cards.filter((c) => c.status === "review");
    const text = review.length
      ? `Waiting on you: ${review.map((c) => `review ${name(c)}`).join("; ")}.`
      : "Nothing is waiting on you.";
    return `${text}${FROM_LEDGER}`;
  }
  const text = wait ? waitInWords(wait) : "I can answer now: no model needs switching in.";
  return `${text}${FROM_LEDGER}`;
}

/**
 * A quick answer (rule 20f b): one request with **no tools**, so nothing it
 * says can become a card, plan, proposal or decision, labelled as a quick
 * answer; the full answer follows.
 */
export async function quickAnswer(
  model: LocalInferenceAdapter,
  snapshot: PmSnapshot,
  queued: readonly PmMessage[],
  modelName: string,
): Promise<string> {
  const res = await model.generate({
    systemPrompt: plannerCopy.quickAnswerSystem,
    prompt: `Project: ${snapshot.project}\n\n${queued.map((m) => `Human: ${m.text}`).join("\n")}`,
    toolArm: "arm_a_flat",
    temperature: 0.2,
    maxTokens: 300,
  });
  // PM-P13-6: a quick answer's claim of "complete" counts for no more than a full one's.
  const text = guardCompletionClaim(stripThinking(res.text).trim(), snapshot.storyMap).text;
  return `Quick answer (${modelName}), informational only; the full answer follows.\n\n${text}`;
}

/** The predicted wait for Seshat's queue from the scheduler (the median, MD-N14-8). */
export async function seshatWait(
  access: {
    predictWait(
      queue: string,
      opts?: { cls?: "interactive"; homeBacklog?: boolean },
    ): Promise<{ waitMs: number; quickPath: boolean }>;
    predictLoad(queue: string): Promise<{ medianMs: number } | undefined>;
  },
  queue: string,
  opts: { homeBacklog?: boolean } = {},
): Promise<SeshatWait> {
  const w = await access.predictWait(queue, { cls: "interactive", ...opts });
  const load = await access.predictLoad(queue).catch(() => undefined);
  return {
    waitMs: w.waitMs,
    quickPath: w.quickPath,
    ...(load && w.waitMs > 0 ? { switchMs: load.medianMs } : {}),
  };
}
