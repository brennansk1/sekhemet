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

// ---------------------------------------------------------------------------
// Presence (teams item 26, TEAM-26; dashboard DB-N9-20)
// ---------------------------------------------------------------------------

/** A person as an avatar, as the `presence` frame carries them. */
export interface PresenceFace {
  principal: string;
  name: string;
  initials: string;
}

/** The `presence` frame: who views which issue, who drags which card. In memory, never recorded. */
export interface PresenceFrame {
  issues: Record<string, PresenceFace[]>;
  dragging: Record<string, PresenceFace[]>;
}

/** Every word presence shows. */
export const PRESENCE_COPY = {
  viewer: (name: string) => `${name} is viewing this issue`,
  dragging: (name: string) => `${name} is moving this issue`,
  viewing: (names: string[], more: number) => {
    const all = more > 0 ? [...names, `${more} more`] : names;
    const list =
      all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
    return `Also viewing: ${list}`;
  },
  more: (n: number) => `+${n}`,
} as const;

function faceOf(raw: unknown): PresenceFace | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  return typeof r.principal === "string" &&
    typeof r.name === "string" &&
    typeof r.initials === "string"
    ? { principal: r.principal, name: r.name, initials: r.initials }
    : undefined;
}

function facesMap(raw: unknown): Record<string, PresenceFace[]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, PresenceFace[]> = {};
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    out[id] = Array.isArray(list)
      ? list.map(faceOf).filter((f): f is PresenceFace => f !== undefined)
      : [];
  }
  return out;
}

/** A `presence` frame, with anything malformed left out. */
export function presenceFrameOf(raw: unknown): PresenceFrame {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { issues: facesMap(r.issues), dragging: facesMap(r.dragging) };
}

/**
 * DB-N9-20: the other people viewing an issue, for its header — never the
 * reader — at most `max` avatars and a count of the rest, with the label a
 * screen reader hears. Empty when the reader is alone.
 */
export function viewersStrip(
  frame: PresenceFrame,
  issue: string,
  reader: string | undefined,
  max = 4,
): { shown: PresenceFace[]; more: number; label: string } {
  const others = (frame.issues[issue] ?? []).filter((f) => f.principal !== reader);
  if (others.length === 0) return { shown: [], more: 0, label: "" };
  const shown = others.slice(0, max);
  const more = others.length - shown.length;
  return {
    shown,
    more,
    label: PRESENCE_COPY.viewing(
      shown.map((f) => f.name),
      more,
    ),
  };
}

/** DB-N9-20: the others dragging a card, whose avatar its tile shows. */
export function draggedBy(
  frame: PresenceFrame,
  cardId: string,
  reader: string | undefined,
): PresenceFace[] {
  return (frame.dragging[cardId] ?? []).filter((f) => f.principal !== reader);
}
