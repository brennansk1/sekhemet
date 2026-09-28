/**
 * The model's output, live, on the Steps tab (dashboard §2.6,
 * NEW-dashboard-3). While a step decodes, the server streams `event: tokens
 * { cardId, text }` — the tail of that step's output so far, re-sent each time
 * it grows (`server.ts` M2). The running step's row shows it, with no
 * animation, and the step's `card/step` event replaces it with the step's
 * summary (DB-N3-1). The state lives only while the Steps tab of that running
 * card is open: any other view keeps no token text (DB-N3-2).
 *
 * The browser loads the compiled module as `/app/lib/live.js`.
 */
import { formatWait } from "./vocabulary.js";

/** The most output a row keeps: the server's own tail length. */
export const LIVE_TEXT_LIMIT = 2000;

/** Every word of the live row. */
export const LIVE_STEP_COPY = {
  heading: (step: number, stepBudget?: number) =>
    `Step ${step}${stepBudget ? ` of ${stepBudget}` : ""} · the model is writing`,
  waiting: "Waiting for the model's first words. New steps appear here as they finish.",
  label: (step: number) => `The model's output for step ${step}, so far`,
} as const;

/** One `tokens` frame as the server sends it. */
export interface TokensFrame {
  cardId: string;
  text: string;
}

/**
 * What the Steps tab holds: the open card's output so far. `finished` is the
 * output of the step whose summary replaced it, so a late re-read of that
 * step's file does not bring it back.
 */
export interface LiveTokens {
  cardId: string;
  text: string;
  finished?: string;
}

/** Where the page is: the open card, its tab, and whether that card is running. */
export interface LiveView {
  cardId: string | null;
  tab: string | null;
  running: boolean;
}

/** A frame, or null when it is not one. */
export function tokensFrame(raw: unknown): TokensFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.cardId !== "string" || !r.cardId || typeof r.text !== "string") return null;
  return { cardId: r.cardId, text: r.text };
}

/**
 * DB-N3-1, DB-N3-2: fold one frame into the Steps tab's state. Outside the
 * Steps tab of a running card the state is dropped (null), whatever arrives.
 */
export function onTokensFrame(
  prev: LiveTokens | null,
  frame: TokensFrame,
  view: LiveView,
): LiveTokens | null {
  if (!view.running || view.tab !== "steps" || !view.cardId) return null;
  if (frame.cardId !== view.cardId) return prev;
  const finished = prev?.cardId === frame.cardId ? prev.finished : undefined;
  // The finished step's file read again: the same text, or its last bytes
  // flushed after the step's event. The file only grows until the next step
  // restarts it, so a shorter text is the next step's opening words — often
  // the same boilerplate as the last step's — and is shown.
  if (finished && frame.text.startsWith(finished)) return prev;
  return { cardId: frame.cardId, text: frame.text.slice(-LIVE_TEXT_LIMIT) };
}

/** DB-N3-1: the step's own event replaces its streamed output with its summary. */
export function onStepEvent(
  prev: LiveTokens | null,
  event: { type: string; cardId?: string },
): LiveTokens | null {
  if (!prev || event.type !== "card/step" || event.cardId !== prev.cardId) return prev;
  const finished = prev.text || prev.finished;
  return { cardId: prev.cardId, text: "", ...(finished ? { finished } : {}) };
}

/** The running row's words and text. */
export function liveRow(
  tokens: LiveTokens | null,
  at: { step: number; stepBudget?: number },
): { heading: string; text: string; waiting: string; label: string } {
  const text = tokens?.text ?? "";
  return {
    heading: LIVE_STEP_COPY.heading(at.step, at.stepBudget),
    text,
    waiting: text ? "" : LIVE_STEP_COPY.waiting,
    label: LIVE_STEP_COPY.label(at.step),
  };
}

/**
 * A run in progress on Runs (DB-N2-11): *Running · 2 of 6 issues · 4m*,
 * from `/api/runs`' `running` and the run's start; "" for a finished run.
 */
export function runningRunText(
  run: { startedAt: string; running?: { finished: number; total: number } },
  now = Date.now(),
): string {
  if (!run.running) return "";
  const { finished, total } = run.running;
  const elapsed = formatWait(now - Date.parse(run.startedAt));
  return `Running · ${finished} of ${total} ${total === 1 ? "issue" : "issues"} · ${elapsed}`;
}
