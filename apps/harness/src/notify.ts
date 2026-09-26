import { createHash } from "node:crypto";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import { type ModelSlowLoadPayload, SWAP_EVENTS, describeSlowLoad } from "@sekhemet/models";
import { egressRecorder, integrationFetch } from "./github_transport.js";
import { readSettings, writeSettings } from "./integrations.js";
import { PM_EVENTS } from "./pm/types.js";
import { readSlack, sendSlack } from "./slack.js";

/**
 * Self-hosted push notifications (H20): ntfy or Gotify, for the moments a
 * person is needed: a card reached Review, a card was parked (budget, repair
 * exhausted, capability ceiling), the Worker asked a question, a run finished.
 *
 * Self-hosted because the design is local-first: the phone gets the push from
 * the user's own ntfy or Gotify server (or ntfy.sh if they choose it). The
 * server URL and token are credentials, so they live with the other
 * integration settings in the user's config directory (mode 0600), never in
 * the repository.
 *
 * Triggers come from the ledger, not from call sites: a notifier tails the
 * hash-chained event log, so every path that parks a card or moves it to
 * Review notifies, including ones added later.
 */

export type PushKind = "ntfy" | "gotify";
/** The kinds a channel may carry (integrations item 21); `test` is a channel check. */
export type NotifyEvent =
  | "review"
  | "parked"
  | "budget"
  | "question"
  | "decision"
  | "standup"
  | "needs_you"
  | "run_report"
  | "slow_load"
  | "test";

export const ALL_EVENTS: NotifyEvent[] = [
  "review",
  "parked",
  "budget",
  "question",
  "decision",
  "standup",
  "needs_you",
  "run_report",
  "slow_load",
];

/**
 * The interruption budget (integrations item 23a, planner-pm item 15):
 * unsolicited notices to one person, 3 a day unless configured, and never
 * more than 5 whatever the configuration. Past it a notice is held for the
 * next standup (INT-20a).
 */
export const DEFAULT_DAILY_BUDGET = 3;
export const MAX_DAILY_BUDGET = 5;

/** A channel's daily limit: its configured budget, clamped to 0..5. */
export function dailyLimit(configured?: number): number {
  const n = Number.isFinite(configured) ? Math.floor(configured as number) : DEFAULT_DAILY_BUDGET;
  return Math.max(0, Math.min(MAX_DAILY_BUDGET, n));
}

/**
 * Kinds that interrupt a person unasked, and so count against the budget.
 * The standup counts but is never held (it is where held notices go); a run
 * report answers a run the person started, and a test answers their click.
 */
const UNSOLICITED = new Set<NotifyEvent>([
  "review",
  "parked",
  "budget",
  "question",
  "decision",
  "needs_you",
  "standup",
]);

export interface PushSettings {
  kind: PushKind;
  /** Server base URL, e.g. https://ntfy.sh or http://192.168.1.5:8080 (self-hosted). */
  url: string;
  /** ntfy topic. */
  topic?: string;
  /** ntfy access token, or the Gotify application token. */
  token?: string;
  /** Which events push; default all. */
  events?: NotifyEvent[];
  /** Unsolicited pushes a day: 3 when unset, never more than 5 (item 23a). */
  dailyBudget?: number;
}

export interface Notice {
  event: NotifyEvent;
  title: string;
  message: string;
  /** 1 (min) to 5 (urgent), ntfy's scale; Gotify is mapped to 0-10. */
  priority?: number;
  /** Opens this link when tapped (the dashboard card). */
  click?: string;
  cardId?: string;
  /** What makes two notices the same for the ten-minute rule; kind and card when unset. */
  key?: string;
}

export function validatePush(p: Partial<PushSettings>): string | undefined {
  if (p.kind !== "ntfy" && p.kind !== "gotify") return "kind must be ntfy or gotify";
  try {
    const u = new URL(String(p.url ?? ""));
    if (!/^https?:$/.test(u.protocol)) return "url must be http(s)";
  } catch {
    return "url is not a URL";
  }
  if (p.kind === "ntfy" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(p.topic ?? ""))) {
    return "ntfy needs a topic (letters, digits, - and _)";
  }
  if (p.kind === "gotify" && !p.token) return "Gotify needs an application token";
  return undefined;
}

export function readPush(repoPath: string): PushSettings | undefined {
  const s = readSettings(repoPath) as { push?: PushSettings };
  return s.push && !validatePush(s.push) ? s.push : undefined;
}

export function writePush(repoPath: string, push: PushSettings | undefined): void {
  writeSettings(repoPath, { push } as never);
}

/** The HTTP request for one notice, per server kind. */
export function pushRequest(p: PushSettings, n: Notice): { url: string; init: RequestInit } {
  const base = p.url.replace(/\/$/, "");
  const priority = Math.max(1, Math.min(5, n.priority ?? 3));
  if (p.kind === "ntfy") {
    const headers: Record<string, string> = {
      Title: n.title.replace(/[^\x20-\x7e]/g, "-"),
      Priority: String(priority),
      Tags: n.event,
    };
    if (n.click) headers.Click = n.click;
    if (p.token) headers.Authorization = `Bearer ${p.token}`;
    return { url: `${base}/${p.topic}`, init: { method: "POST", headers, body: n.message } };
  }
  return {
    url: `${base}/message`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gotify-Key": p.token ?? "" },
      body: JSON.stringify({
        title: n.title,
        message: n.message,
        priority: priority * 2,
        ...(n.click ? { extras: { "client::notification": { click: { url: n.click } } } } : {}),
      }),
    },
  };
}

export interface NotifyDeps {
  fetch?: typeof fetch;
  log?: EventLog | undefined;
  /** Structural fields for the `pm/notify` record: the person, the notice and its day. */
  record?: NoticeRecord;
}

/** Who a notice was for, which notice it was, and the budget's day it counts on. */
export interface NoticeRecord {
  to?: string;
  notice?: string;
  day?: string;
}

/** Send one notice if push is set up and the event is enabled. */
export async function sendPush(
  repoPath: string,
  n: Notice,
  deps: NotifyDeps = {},
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const p = readPush(repoPath);
  if (!p) return { ok: false, skipped: true, error: "Push notifications are not set up" };
  if (n.event !== "test" && !(p.events ?? ALL_EVENTS).includes(n.event)) {
    return { ok: false, skipped: true };
  }
  const { url, init } = pushRequest(p, n);
  let result: { ok: boolean; error?: string };
  try {
    // Through the one network policy, recorded as `harness/egress`; the push
    // host is the connected destination, and offline refuses it (item 33).
    const send =
      deps.fetch ??
      integrationFetch(
        repoPath,
        // The topic is the push's credential: the ledger keeps the origin only (B1).
        egressRecorder(deps.log, { redactUrl: true }),
        p.url,
        "integration:push",
      );
    const res = await send(url, { ...init, signal: AbortSignal.timeout(10_000) });
    result = res.ok ? { ok: true } : { ok: false, error: `${p.kind} answered ${res.status}` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await deps.log
    ?.append({
      actor: "harness",
      type: PM_EVENTS.notify,
      ...(n.cardId ? { cardId: n.cardId } : {}),
      payload: {
        channel: p.kind,
        kind: n.event,
        ok: result.ok,
        ...(deps.record?.to ? { to: deps.record.to } : {}),
        ...(deps.record?.notice ? { notice: deps.record.notice } : {}),
        ...(deps.record?.day ? { day: deps.record.day } : {}),
      },
    })
    .catch(() => undefined);
  return result;
}

const BUDGET = /budget|token|wall-?clock|time limit/i;

/** The notice (if any) a ledger event deserves. */
export function noticeFor(e: EventRecord, dashboard?: string): Notice | undefined {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const card = e.cardId ?? String(p.id ?? "");
  const click = dashboard && card ? `${dashboard.replace(/\/$/, "")}/#/card/${card}` : undefined;
  const base = { ...(card ? { cardId: card } : {}), ...(click ? { click } : {}) };
  if (e.type === "card/status_changed" && p.toStatus === "review") {
    return {
      ...base,
      event: "review",
      title: "Ready for review",
      message: `${card} passed its gates and waits for you.`,
      priority: 3,
    };
  }
  const parked =
    e.type === "card/parked" || (e.type === "card/status_changed" && p.toStatus === "parked");
  if (parked) {
    const reason = String(p.reason ?? p.stopReason ?? "no reason recorded");
    const budget = BUDGET.test(reason);
    return {
      ...base,
      event: budget ? "budget" : "parked",
      title: budget ? "Budget reached" : "Card parked",
      message: `${card}: ${reason}`.slice(0, 400),
      priority: 4,
    };
  }
  if (e.type === "decision/requested") {
    // INT-19: a decision request waits on a person.
    return {
      ...base,
      event: "decision",
      key: `decision:${String(p.id ?? card)}`,
      title: "A decision waits for you",
      message: `${String(p.question ?? "").slice(0, 300)}${card ? ` (${card})` : ""}`,
      priority: 4,
    };
  }
  if (e.type === SWAP_EVENTS.slowLoad) {
    // models MD-N14-5: a slow model load, its likely causes and their fixes;
    // low priority, one per weights within the ten-minute rule.
    const slow = p as unknown as ModelSlowLoadPayload;
    return {
      event: "slow_load",
      key: `slow_load:${slow.model}`,
      title: "A model loaded slowly",
      message: describeSlowLoad(slow).slice(0, 400),
      priority: 2,
    };
  }
  if (e.type === "card/question") {
    return {
      ...base,
      event: "question",
      title: "The Worker has a question",
      message: `${card}: ${String(p.text ?? "").slice(0, 300)}`,
      priority: 3,
    };
  }
  return undefined;
}

/** A place notices go: push (ntfy or Gotify) or Slack, each with its kinds and budget. */
interface Channel {
  name: string;
  accepts: (kind: NotifyEvent) => boolean;
  limit: number;
  send: (n: Notice, record: NoticeRecord) => Promise<{ ok: boolean }>;
}

function channelsOf(
  repoPath: string,
  log: EventLog,
  opts: { fetch?: typeof fetch; timeoutMs?: number },
): Channel[] {
  const out: Channel[] = [];
  const push = readPush(repoPath);
  if (push) {
    out.push({
      name: push.kind,
      accepts: (k) => (push.events ?? ALL_EVENTS).includes(k),
      limit: dailyLimit(push.dailyBudget),
      send: (n, record) =>
        sendPush(repoPath, n, { log, record, ...(opts.fetch ? { fetch: opts.fetch } : {}) }),
    });
  }
  const slack = readSlack(repoPath);
  if (slack) {
    out.push({
      name: "slack",
      accepts: (k) => (slack.events ?? ALL_EVENTS).includes(k),
      limit: dailyLimit(slack.dailyBudget),
      send: (n, record) =>
        sendSlack(repoPath, n, {
          log,
          record,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        }),
    });
  }
  return out;
}

/** The local calendar day of a time, the budget's day. */
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** `HH:MM` as minutes after midnight; 09:00 when absent or malformed. */
function minutesOf(at: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at?.trim() ?? "");
  if (!m) return 9 * 60;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

const HELD_LABEL: Partial<Record<NotifyEvent, string>> = {
  review: "waits for review",
  parked: "was parked",
  budget: "reached its budget",
  question: "has a question from the Worker",
  decision: "has a decision waiting",
};

/** The standup's `needs_you` summary of the notices held for it (item 23a). */
function heldSummary(held: EventRecord[]): string {
  if (held.length === 0) return "";
  const lines = held.map((e) => {
    const kind = String((e.payload as { kind?: string }).kind ?? "needs_you") as NotifyEvent;
    const what = HELD_LABEL[kind] ?? "needs you";
    return `- ${e.cardId ?? "a card"} ${what}`;
  });
  return `Needs you (held for this standup, past the day's notice budget):\n${lines.join("\n")}`;
}

export interface NotifierOptions {
  intervalMs?: number;
  dashboard?: string;
  fetch?: typeof fetch;
  /** Seshat's standup text; without it no standup is sent (INT-18). */
  standup?: () => Promise<string>;
  /** When the standup is due, local `HH:MM`; the settings' `standupAt`, else 09:00. */
  standupAt?: string;
  /** How long a channel may take before a send counts as failed. */
  timeoutMs?: number;
  /** The clock; the budget's day and the standup's time are local. */
  now?: () => Date;
  /** The person notices are addressed to; the install's own person by default. */
  recipient?: string;
}

/** A claim's event id, derived from what is claimed, so two notifiers derive the same one. */
const claimId = (key: string) =>
  `ntc_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** How long a failed standup waits before the next attempt, and how many a day. */
const STANDUP_RETRY_MS = 10 * 60_000;
const STANDUP_ATTEMPTS = 6;

/**
 * The one notifier (integrations items 20-23a): tail the ledger and send what
 * needs a person through every channel the user connected — push and Slack —
 * each to the kinds it accepts. Starts after the current last event (no
 * replay of history), polls every `intervalMs`, and never sends the same
 * (kind, card) twice within ten minutes. Unsolicited notices are budgeted per
 * person per day: past a channel's limit nothing is sent on it, and a notice
 * no channel may send is held (`pm/notice_held`) for the next standup, which
 * carries it. The standup is sent once a day, when due, to the channels that
 * accept it; a failed one is retried that day, every ten minutes, six
 * attempts at most. Counts and held notices come from the ledger, so a
 * restart neither forgets them nor sends twice.
 *
 * Several notifiers may tail one ledger (the dashboard server and a queue
 * run): each send is claimed on the ledger first (`pm/notify_claimed`, under
 * an id derived from the notice, or from the channel's standup and attempt),
 * and only the notifier whose claim is recorded sends it. The budget counts
 * the notices claimed before this one, so it holds across notifiers
 * (B4.9 part 2, B2).
 */
export async function startNotifier(
  log: EventLog,
  repoPath: string,
  opts: NotifierOptions = {},
): Promise<{ stop: () => void; tick: () => Promise<number> }> {
  let seq = (await log.getLastEvent())?.seq ?? 0;
  const recent = new Map<string, number>();
  const now = opts.now ?? (() => new Date());
  const person = opts.recipient ?? log.localPrincipal();
  /** When each channel's standup last failed here, by the notifier's clock. */
  const standupFailedAt = new Map<string, number>();

  /** Record a claim under its derived id; undefined when another notifier holds it. */
  const claim = async (
    key: string,
    payload: Record<string, unknown>,
    cardId?: string,
  ): Promise<EventRecord | undefined> => {
    const id = claimId(key);
    if (log.hasEvent(id)) return undefined;
    try {
      return await log.append({
        id,
        actor: "harness",
        type: PM_EVENTS.notifyClaimed,
        ...(cardId ? { cardId } : {}),
        payload,
      });
    } catch (err) {
      // The id is the claim: recorded meanwhile by another notifier.
      if (log.hasEvent(id)) return undefined;
      throw err;
    }
  };

  const mine = (e: EventRecord, day: string) => {
    const p = e.payload as NoticeRecord;
    return (p.day ?? dayOf(new Date(e.createdAt))) === day && !(p.to && p.to !== person);
  };

  /**
   * The distinct unsolicited notices that count against today's budget,
   * other than `except`: every one sent, and every one claimed before
   * `beforeSeq` that is still being sent (not held, no result yet). A failed
   * send is no interruption and does not count.
   */
  const budgetUsed = async (beforeSeq: number, except: string): Promise<number> => {
    const day = dayOf(now());
    const ok = new Set<string>();
    const tried = new Set<string>();
    const held = new Set<string>();
    const claimed = new Set<string>();
    const types = [PM_EVENTS.notify, PM_EVENTS.noticeHeld, PM_EVENTS.notifyClaimed];
    for (const e of await log.getEventsByTypes(types)) {
      const p = e.payload as NoticeRecord & { kind?: NotifyEvent; ok?: boolean };
      if (!p.kind || !UNSOLICITED.has(p.kind) || !mine(e, day)) continue;
      const id = p.notice ?? e.id;
      if (e.type === PM_EVENTS.notify) {
        tried.add(id);
        if (p.ok) ok.add(id);
      } else if (e.type === PM_EVENTS.noticeHeld) held.add(id);
      else if (e.seq < beforeSeq) claimed.add(id);
    }
    const used = new Set(ok);
    for (const id of claimed) if (!tried.has(id) && !held.has(id)) used.add(id);
    used.delete(except);
    return used.size;
  };

  const tick = async (): Promise<number> => {
    const channels = channelsOf(repoPath, log, opts);
    if (channels.length === 0) {
      seq = (await log.getLastEvent())?.seq ?? seq;
      return 0;
    }
    const events = await log.getEvents(seq + 1, 500);
    let sent = 0;
    for (const e of events) {
      seq = Math.max(seq, e.seq);
      const n = noticeFor(e, opts.dashboard);
      if (!n) continue;
      const key = n.key ?? `${n.event}:${n.cardId ?? ""}`;
      const at = Date.now();
      if ((recent.get(key) ?? 0) > at - 600_000) continue;
      const accepting = channels.filter((c) => c.accepts(n.event));
      if (accepting.length === 0) continue;
      recent.set(key, at);
      const record = { to: person, notice: e.id, day: dayOf(now()) };
      // B2: one notifier sends a notice; another that sees it goes on.
      const claimed = await claim(
        `notify:${person}:${e.id}`,
        { kind: n.event, ...record },
        n.cardId,
      );
      if (!claimed) continue;
      const budgeted = UNSOLICITED.has(n.event);
      const used = budgeted ? await budgetUsed(claimed.seq, e.id) : 0;
      const open = budgeted ? accepting.filter((c) => used < c.limit) : accepting;
      if (open.length === 0) {
        // INT-20a: past the budget, held for the next standup; nothing is sent.
        await log.append({
          actor: "harness",
          type: PM_EVENTS.noticeHeld,
          ...(n.cardId ? { cardId: n.cardId } : {}),
          payload: { kind: n.event, ...record },
        });
        continue;
      }
      for (const c of open) if ((await c.send(n, record)).ok) sent++;
    }
    sent += await standupIfDue(channels);
    return sent;
  };

  /**
   * INT-18: once a day, when due, the standup and every notice held for it,
   * on each channel that accepts it. A channel whose standup failed tries
   * again that day (each attempt claimed), ten minutes apart, six at most.
   */
  const standupIfDue = async (channels: Channel[]): Promise<number> => {
    if (!opts.standup) return 0;
    const accepting = channels.filter((c) => c.accepts("standup"));
    if (accepting.length === 0) return 0;
    const clock = now();
    const due = minutesOf(opts.standupAt ?? readSettings(repoPath).standupAt);
    if (clock.getHours() * 60 + clock.getMinutes() < due) return 0;
    const day = dayOf(clock);
    let lastStandupSeq = 0;
    const went = new Set<string>();
    const failures = new Map<string, number>();
    for (const e of await log.getEventsByTypes([PM_EVENTS.notify])) {
      const p = e.payload as NoticeRecord & { kind?: NotifyEvent; ok?: boolean; channel?: string };
      if (p.kind !== "standup") continue;
      if (p.ok) lastStandupSeq = e.seq;
      if (!mine(e, day) || !p.channel) continue;
      if (p.ok) went.add(p.channel);
      else failures.set(p.channel, (failures.get(p.channel) ?? 0) + 1);
    }
    const waiting = accepting.filter((c) => {
      if (went.has(c.name) || (failures.get(c.name) ?? 0) >= STANDUP_ATTEMPTS) return false;
      const failed = standupFailedAt.get(`${day}:${c.name}`);
      return failed === undefined || clock.getTime() - failed >= STANDUP_RETRY_MS;
    });
    if (waiting.length === 0) return 0;
    const notice = `standup-${day}`;
    const record = { to: person, notice, day };
    const ours: Channel[] = [];
    for (const c of waiting) {
      const attempt = failures.get(c.name) ?? 0;
      const key = `notify:${person}:${c.name}:${notice}#${attempt}`;
      const payload = { kind: "standup", ...record, channel: c.name, attempt };
      if (await claim(key, payload)) ours.push(c);
    }
    if (ours.length === 0) return 0;
    const held = (await log.getEventsByTypes([PM_EVENTS.noticeHeld], lastStandupSeq + 1)).filter(
      (e) => (e.payload as { to?: string }).to === person,
    );
    const body = [await opts.standup(), heldSummary(held)].filter(Boolean).join("\n\n");
    const n: Notice = {
      event: "standup",
      title: "Standup",
      message: body,
      priority: 2,
      ...(opts.dashboard ? { click: opts.dashboard } : {}),
    };
    let sent = 0;
    for (const c of ours) {
      if ((await c.send(n, record)).ok) sent++;
      else standupFailedAt.set(`${day}:${c.name}`, clock.getTime());
    }
    return sent;
  };

  const timer = setInterval(() => void tick().catch(() => undefined), opts.intervalMs ?? 5000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
