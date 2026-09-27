import type { EventRecord } from "@sekhemet/kernel";
import type { SimCard, SimDay, SimSession } from "@sekhemet/models";

/**
 * The demand a Smart Swap replay runs (models rule 20j, MD-N14-38; live-test
 * F15), read from the ledger: the cards' attempts and steps, a person's chat
 * with Seshat, research requests and presence. Before F15 the Configuration
 * page's replay built its day from the cards alone, Seshat and presence
 * always empty, so a combination's waits said nothing of chat or research.
 */

/** The ledger event types the replay reads. */
export const REPLAY_EVENT_TYPES = [
  "card/step",
  "card/status_changed",
  "pm/message",
  "pm/reply",
  "research/asked",
  "session/active",
  "session/started",
] as const;

/** A step's service time when none is recorded per step. */
const STEP_MS = 30_000;
/** A passing card's review. */
const REVIEW_MS = 120_000;
/** A person is present this long after a dashboard session's mark (C6's window). */
const PRESENCE_MS = 10 * 60_000;
/** Messages further apart than this after the last answer start a new session. */
const SESSION_GAP_MS = 10 * 60_000;
/** A message never answered: its turn's service, as the design's estimate. */
const UNANSWERED_MS = 30_000;
/** The replay's span. */
const SPAN_MS = 7 * 24 * 3_600_000;

type Demand = Pick<SimDay, "start" | "end" | "cards" | "seshat" | "research" | "presence">;

const timeOf = (e: EventRecord): number => {
  const own = (e.payload as { createdAt?: unknown } | undefined)?.createdAt;
  const t = typeof own === "string" ? Date.parse(own) : Number.NaN;
  return Number.isNaN(t) ? Date.parse(e.createdAt) : t;
};

/**
 * One replay day from the ledger's events: the last `limit` cards (each
 * attempt's steps at a fixed step time, as before), each arriving when it
 * first went in progress; a person's messages and Seshat's replies as
 * sessions whose turns arrive a think-time after the previous answer (a
 * turn's service is its message-to-reply time, an upper estimate: it holds
 * any wait); each research request at the time it was asked for its
 * recorded time; presence from dashboard sessions.
 */
export function replayDemand(
  events: readonly EventRecord[],
  opts: { limit?: number } = {},
): Demand {
  const sorted = [...events].sort((a, b) => timeOf(a) - timeOf(b) || a.seq - b.seq);
  // Cards, as the replay read them before, now at their recorded arrival.
  const byCard = new Map<
    string,
    { steps: number; attempts: number; passed: boolean; arrivesAt?: number }
  >();
  for (const e of sorted) {
    if (e.type !== "card/status_changed" || !e.cardId) continue;
    const p = e.payload as { toStatus?: string };
    const c = byCard.get(e.cardId) ?? { steps: 0, attempts: 0, passed: false };
    if (p.toStatus === "in_progress") {
      c.attempts += 1;
      c.arrivesAt ??= timeOf(e);
    }
    if (p.toStatus === "review" || p.toStatus === "done") c.passed = true;
    byCard.set(e.cardId, c);
  }
  for (const e of sorted) {
    if (e.type !== "card/step" || !e.cardId) continue;
    const c = byCard.get(e.cardId) ?? { steps: 0, attempts: 1, passed: false };
    c.steps += 1;
    c.arrivesAt ??= timeOf(e);
    byCard.set(e.cardId, c);
  }
  const chosen = [...byCard.entries()].filter(([, c]) => c.attempts > 0).slice(-(opts.limit ?? 20));
  const times = [
    ...chosen.map(([, c]) => c.arrivesAt).filter((t): t is number => t !== undefined),
    ...sorted.filter((e) => !e.type.startsWith("card/")).map(timeOf),
  ];
  const start = times.length > 0 ? Math.min(...times) : 0;
  const end = start + SPAN_MS;
  const inSpan = (t: number) => t >= start && t <= end;
  const cards: SimCard[] = chosen.map(([id, c], i) => {
    const attempts = Math.max(1, c.attempts);
    const per = Math.max(1, Math.round(c.steps / attempts) || 10);
    return {
      id,
      arrivesAt: c.arrivesAt ?? start + i,
      attempts: Array.from({ length: attempts }, (_, k) => ({
        steps: Array.from({ length: per }, () => STEP_MS),
        passed: c.passed && k === attempts - 1,
      })),
      reviewMs: REVIEW_MS,
    };
  });

  // A person's chat: the Worker's own questions are not a person's turns.
  const replies = new Map<string, number>();
  for (const e of sorted) {
    if (e.type !== "pm/reply") continue;
    for (const id of (e.payload as { replyTo?: string[] }).replyTo ?? [])
      if (!replies.has(id)) replies.set(id, timeOf(e));
  }
  const seshat: SimSession[] = [];
  let open: SimSession | undefined;
  let lastAnswer: number | undefined;
  for (const e of sorted) {
    if (e.type !== "pm/message" || e.actor !== "human") continue;
    const at = timeOf(e);
    if (!inSpan(at)) continue;
    const id = (e.payload as { id?: string }).id;
    const answered = id !== undefined ? replies.get(id) : undefined;
    const serviceMs = answered !== undefined ? Math.max(0, answered - at) : UNANSWERED_MS;
    if (open && lastAnswer !== undefined && at - lastAnswer <= SESSION_GAP_MS) {
      open.turns.push({ thinkMs: Math.max(0, at - lastAnswer), serviceMs });
    } else {
      open = { startAt: at, turns: [{ thinkMs: 0, serviceMs }] };
      seshat.push(open);
    }
    lastAnswer = at + serviceMs;
  }

  // Research requests, at the time each was asked.
  const research = sorted
    .filter((e) => e.type === "research/asked")
    .map((e) => {
      const ms = Number((e.payload as { ms?: unknown }).ms);
      const serviceMs = Number.isFinite(ms) && ms >= 0 ? ms : 0;
      return { at: timeOf(e) - serviceMs, serviceMs };
    })
    .filter((r) => inSpan(r.at));

  // Presence: each dashboard mark keeps a person present for C6's window.
  const presence: { from: number; to: number }[] = [];
  for (const e of sorted) {
    if (e.type !== "session/active" && e.type !== "session/started") continue;
    const from = timeOf(e);
    if (!inSpan(from)) continue;
    const last = presence.at(-1);
    if (last && from <= last.to) last.to = Math.max(last.to, from + PRESENCE_MS);
    else presence.push({ from, to: from + PRESENCE_MS });
  }
  return { start, end, cards, seshat, research, presence };
}
