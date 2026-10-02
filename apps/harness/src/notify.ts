import { createHash } from "node:crypto";
import type { EventLog, EventRecord } from "@sekhemet/kernel";
import {
  type ModelRequantisedPayload,
  type ModelSlowLoadPayload,
  SWAP_EVENTS,
  describeSlowLoad,
} from "@sekhemet/models";
import { emailAccepts, personAddresses, readEmail, sendEmail } from "./email.js";
import { egressRecorder, integrationFetch } from "./github_transport.js";
import { readSettings, writeSettings } from "./integrations.js";
import { setupFor } from "./planner_live.js";
import { plainTitle } from "./pm/standup.js";
import { PmStore } from "./pm/store.js";
import { PM_EVENTS } from "./pm/types.js";
import { readSlack, sendSlack } from "./slack.js";
import { UPDATE_CLOCK_EVENTS, updateClock } from "./team/health.js";
import type { InboxNotifier, WatcherNotice } from "./team/inbox.js";

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
  | "requantised"
  /** A neutral reminder to an item's owner (planner-pm PM-N9-6). */
  | "reminder"
  /** Teams TEAM-43: a watched issue's change, a mention, a posted update, the digest of what is unread. */
  | "watching"
  | "mentioned"
  | "project_update"
  | "digest"
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
  "requantised",
  "reminder",
  "watching",
  "mentioned",
  "project_update",
  "digest",
];

/**
 * The interruption budget (integrations item 23a, planner-pm item 15):
 * unsolicited notices to one person, 3 a day unless configured, and never
 * more than 5 whatever the configuration. Past it a notice is held for the
 * next standup (INT-20a).
 */
export const DEFAULT_DAILY_BUDGET = 3;
export const MAX_DAILY_BUDGET = 5;

/**
 * PM-P6-10: a notice about an Urgent issue may use the day's whole ceiling
 * (5, never a 6th); every other one stops at the channel's budget (3 unless
 * configured). A channel set to 0 sends none.
 */
function limitFor(c: { limit: number }, urgent: boolean): number {
  return urgent && c.limit > 0 ? MAX_DAILY_BUDGET : c.limit;
}

/** How recently the board was in focus for a notice to go to the panel instead (PM-P6-10). */
export const BOARD_FOCUS_MS = 5 * 60_000;

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
  "reminder",
  // TEAM-43: a watcher's notices and posted project updates share the budget;
  // the digest, like the standup, counts but is never held.
  "watching",
  "mentioned",
  "project_update",
  "digest",
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
  if (p.kind !== "ntfy" && p.kind !== "gotify") return "Choose ntfy or Gotify.";
  try {
    const u = new URL(String(p.url ?? ""));
    if (!/^https?:$/.test(u.protocol))
      return "Use a web address that starts with http:// or https://.";
  } catch {
    return "That isn't a web address.";
  }
  if (p.kind === "ntfy" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(p.topic ?? ""))) {
    return "Give ntfy a topic: letters, digits, - and _.";
  }
  if (p.kind === "gotify" && !p.token) return "Gotify needs an application token.";
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
      message: `${card} passed its checks and waits for you.`,
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
      title: budget ? "Budget reached" : "Issue on hold",
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
  if (e.type === SWAP_EVENTS.requantised) {
    // models rule 20h: Ollama serves the model with another quantisation or
    // hash than its file; exact weights need llama-server.
    const r = p as unknown as ModelRequantisedPayload;
    const what =
      r.servedQuant && r.fileQuant
        ? `as ${r.servedQuant}, but the file is ${r.fileQuant}`
        : "from a file that differs from the one verified";
    return {
      event: "requantised",
      key: `requantised:${r.model}`,
      title: "A model is running as a converted copy",
      message: `Ollama runs ${r.model} ${what}. Its answers may differ from the weights verified on this machine; serve it through llama-server where exact weights matter.`,
      priority: 3,
    };
  }
  if (e.type === "card/question") {
    return {
      ...base,
      event: "question",
      title: "The Agent has a question",
      message: `${card}: ${String(p.text ?? "").slice(0, 300)}`,
      priority: 3,
    };
  }
  return undefined;
}

/**
 * A place notices go, each with its kinds and budget: push (ntfy or Gotify)
 * and Slack, which everyone reading them shares, or email, which is personal
 * (`reaches`): one person at their own address (TEAM-43).
 */
interface Channel {
  name: string;
  accepts: (kind: NotifyEvent) => boolean;
  limit: number;
  /** A personal channel: whether it reaches this person (email: an address is recorded). */
  reaches?: (to: string) => boolean;
  send: (n: Notice, record: NoticeRecord) => Promise<{ ok: boolean }>;
}

async function channelsOf(
  repoPath: string,
  log: EventLog,
  opts: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<Channel[]> {
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
  const email = readEmail(repoPath);
  if (email) {
    // Each person's own address, read at send time and never recorded.
    const addresses = await personAddresses(log);
    out.push({
      name: "email",
      accepts: (k) => emailAccepts(email, k),
      limit: dailyLimit(email.dailyBudget),
      reaches: (to) => addresses.has(to),
      send: async (n, record) => {
        const address = record.to ? addresses.get(record.to) : undefined;
        if (!address) return { ok: false };
        return sendEmail(repoPath, n, address, {
          log,
          record,
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        });
      },
    });
  }
  return out;
}

/** A person's name from their `person/created` record's private part (the notifier holds no people). */
async function personNameOn(log: EventLog, principal: string): Promise<string | undefined> {
  for (const e of (await log.getEventsByTypes(["person/created"])).reverse()) {
    if (e.principal !== principal) continue;
    const name = (e.private as { name?: unknown } | undefined)?.name;
    if (typeof name === "string" && name && name !== "[erased]") return name;
  }
  return undefined;
}

/** "Ann", "Ann and Ben", "Ann, Ben and Cy". */
const namesList = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The local calendar day of a time, the budget's day. */
const dayOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** `HH:MM` as minutes after midnight; 09:00 when absent or malformed. */
function minutesOf(at: string | undefined): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at?.trim() ?? "");
  if (!m) return 9 * 60;
  return Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2]));
}

interface LedgerCard {
  status?: string;
  /** When it entered its status (ms). */
  since?: number;
  owner?: string | null;
  projectId?: string | null;
  /** Its title, for a standup's plain words (PM-P6-3). */
  title?: string;
  /** Linear's scale: 1 is Urgent (planner-pm rule 1), which a notice may interrupt for. */
  priority?: number;
}

/**
 * Each card's status, owner and project, folded from the ledger (the
 * notifier tails the ledger and holds no card store).
 */
async function cardsOnLedger(log: EventLog): Promise<Map<string, LedgerCard>> {
  const out = new Map<string, LedgerCard>();
  for (const e of await log.getEventsByTypes([
    "card/created",
    "card/status_changed",
    "card/owner_changed",
    "card/updated",
  ])) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const id = String(p.id ?? e.cardId ?? "");
    if (!id) continue;
    const c = out.get(id) ?? {};
    if (e.type === "card/created") {
      c.status = String(p.status ?? "");
      c.since = Date.parse(e.createdAt);
      c.owner = (p.owner as string | null | undefined) ?? null;
      c.projectId = (p.projectId as string | null | undefined) ?? null;
      if (typeof p.title === "string") c.title = p.title;
      if (typeof p.priority === "number") c.priority = p.priority;
    } else if (e.type === "card/updated") {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      if (typeof patch.title === "string") c.title = patch.title;
      if (typeof patch.priority === "number") c.priority = patch.priority;
    } else if (e.type === "card/status_changed") {
      c.status = String(p.toStatus ?? c.status);
      c.since = Date.parse(e.createdAt);
    } else c.owner = (p.to as string | null | undefined) ?? null;
    out.set(id, c);
  }
  return out;
}

/**
 * The day's neutral reminders for one person (planner-pm §2.18.4, PM-N9-6):
 * the issues that have waited a day or more for their review — theirs, or
 * unowned in Solo; a fresh one had its own notice — and,
 * in the Team setup, "Update due" for a project they lead with no update
 * posted in 7 days. Product text, never Seshat's voice.
 */
export async function remindersFor(
  log: EventLog,
  person: string,
  options: { day: string; now: Date; setup: "solo" | "team" },
): Promise<(Notice & { key: string })[]> {
  const cards = await cardsOnLedger(log);
  // In the Team setup, a project's lead: read once, so an unowned issue's
  // review reminder can go to them too, as an accept with no rule set does.
  const lead = new Map<string, string>();
  if (options.setup === "team") {
    for (const e of await log.getEventsByTypes(["project/settings_changed"])) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const project = String(p.project ?? "");
      if (project && typeof p.lead === "string") lead.set(project, p.lead);
    }
  }
  const waiting = [...cards]
    .filter(
      ([, c]) =>
        c.status === "review" &&
        options.now.getTime() - (c.since ?? 0) >= 24 * 3_600_000 &&
        (c.owner === person ||
          (!c.owner &&
            (options.setup === "solo" || (c.projectId && lead.get(c.projectId) === person)))),
    )
    .map(([id]) => id);
  const out: (Notice & { key: string })[] = [];
  if (waiting.length) {
    out.push({
      event: "reminder",
      key: `reminder-review-${options.day}`,
      title: `${waiting.length} ${waiting.length === 1 ? "issue" : "issues"} waiting for review`,
      message: waiting.join(", "),
      priority: 3,
    });
  }
  if (options.setup === "team") {
    // TEAM-29: Status's own clock — the last update, else the current release's start.
    const clock = await log.getEventsByTypes([...UPDATE_CLOCK_EVENTS]);
    for (const [project, who] of lead) {
      const started = updateClock(clock, project);
      if (who !== person || started === undefined) continue;
      const age = options.now.getTime() - started.at;
      if (age < 7 * 24 * 3_600_000) continue;
      const days = Math.floor(age / (24 * 3_600_000));
      const name = started.name ?? "The project";
      out.push({
        event: "reminder",
        key: `reminder-update-${project}-${options.day}`,
        title: "Update due",
        message:
          started.since === "update"
            ? `${name}: no project update posted in the last ${days} days.`
            : `${name}: no project update posted since the ${started.since} started ${days} days ago.`,
        priority: 3,
      });
    }
  }
  return out;
}

const HELD_LABEL: Partial<Record<NotifyEvent, string>> = {
  review: "waits for review",
  parked: "was put on hold",
  budget: "reached its budget",
  question: "has a question from the Agent",
  decision: "has a decision waiting",
  reminder: "has a reminder",
};

/**
 * The standup's `needs_you` summary of the notices held for it (item 23a),
 * each issue by its title, in the standup's plain words (PM-P6-3).
 */
function heldSummary(held: EventRecord[], cards: Map<string, LedgerCard>): string {
  if (held.length === 0) return "";
  const lines = held.map((e) => {
    const kind = String((e.payload as { kind?: string }).kind ?? "needs_you") as NotifyEvent;
    const what = HELD_LABEL[kind] ?? "needs you";
    const title = e.cardId ? cards.get(e.cardId)?.title : undefined;
    return `- ${title ? plainTitle({ title }) : "an issue"} ${what}`;
  });
  return `Needs you (held for this standup, past the day's notification limit):\n${lines.join("\n")}`;
}

export interface NotifierOptions {
  intervalMs?: number;
  dashboard?: string;
  fetch?: typeof fetch;
  /**
   * Seshat's standup text for the person it is sent to; without it no
   * standup is sent (INT-18). One builder with the chat's (PM-P6-3).
   */
  standup?: (person: string) => Promise<string>;
  /** When the standup is due, local `HH:MM`; the settings' `standupAt`, else 09:00. */
  standupAt?: string;
  /** How long a channel may take before a send counts as failed. */
  timeoutMs?: number;
  /** The clock; the budget's day and the standup's time are local. */
  now?: () => Date;
  /** The person notices are addressed to; the install's own person by default. */
  recipient?: string;
  /** Solo or Team (`[team] mode`); read from the configuration when absent. */
  setup?: "solo" | "team";
  /**
   * Teams TEAM-43: what the Inbox owes its watchers — each watched change, a
   * mention and a posted project update to each person it reached — sent
   * within that person's own budget, and the day's digest of what is still
   * unread. Absent: only the install's person is notified.
   */
  inbox?: InboxNotifier;
}

/** A claim's event id, derived from what is claimed, so two notifiers derive the same one. */
const claimId = (key: string) =>
  `ntc_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/** How long a failed standup waits before the next attempt, and how many a day. */
const STANDUP_RETRY_MS = 10 * 60_000;
const STANDUP_ATTEMPTS = 6;

/**
 * The one notifier (integrations items 20-23a): tail the ledger and send what
 * needs a person through every channel the user connected — push, Slack and
 * email, the last to one person at their own address —
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

  /** A notice record of today's for this person (the install's person unless named). */
  const mine = (e: EventRecord, day: string, who = person) => {
    const p = e.payload as NoticeRecord;
    return (p.day ?? dayOf(new Date(e.createdAt))) === day && !(p.to && p.to !== who);
  };

  /**
   * The distinct unsolicited notices that count against today's budget,
   * other than `except`: every one sent, and every one claimed before
   * `beforeSeq` that is still being sent (not held, no result yet). A failed
   * send is no interruption and does not count.
   */
  const budgetUsed = async (beforeSeq: number, except: string, who = person): Promise<number> => {
    const day = dayOf(now());
    const ok = new Set<string>();
    const tried = new Set<string>();
    const held = new Set<string>();
    const claimed = new Set<string>();
    const types = [
      PM_EVENTS.notify,
      PM_EVENTS.noticeHeld,
      PM_EVENTS.noticeShown,
      PM_EVENTS.notifyClaimed,
    ];
    for (const e of await log.getEventsByTypes(types)) {
      const p = e.payload as NoticeRecord & { kind?: NotifyEvent; ok?: boolean };
      if (!p.kind || !UNSOLICITED.has(p.kind) || !mine(e, day, who)) continue;
      const id = p.notice ?? e.id;
      if (e.type === PM_EVENTS.notify) {
        tried.add(id);
        if (p.ok) ok.add(id);
      } else if (e.type === PM_EVENTS.noticeHeld || e.type === PM_EVENTS.noticeShown) {
        // Held for the standup, or shown in the panel (PM-P6-10): no interruption.
        held.add(id);
      } else if (e.seq < beforeSeq) claimed.add(id);
    }
    const used = new Set(ok);
    for (const id of claimed) if (!tried.has(id) && !held.has(id)) used.add(id);
    used.delete(except);
    return used.size;
  };

  /**
   * PM-P6-10: whether the person had the board in focus in the last five
   * minutes (`pm/board_focus`, recorded while the dashboard is focused),
   * folded from the ledger as it grows.
   */
  let focusSeq = 0;
  const focusedAt = new Map<string, number>();
  const boardInFocus = async (whose = person): Promise<boolean> => {
    for (;;) {
      const page = await log.getEventsByTypes([PM_EVENTS.boardFocus], focusSeq + 1, 10_000);
      for (const e of page) {
        focusSeq = e.seq;
        const who = (e.payload as { principal?: string }).principal ?? e.principal;
        if (who) focusedAt.set(who, Math.max(focusedAt.get(who) ?? 0, Date.parse(e.createdAt)));
      }
      if (page.length < 10_000) break;
    }
    return (focusedAt.get(whose) ?? Number.NEGATIVE_INFINITY) >= now().getTime() - BOARD_FOCUS_MS;
  };

  /** The item in Seshat's panel instead of a notice (PM-P6-10); it interrupts no one. */
  const pm = new PmStore(log);
  const showInPanel = async (n: Notice, record: NoticeRecord): Promise<void> => {
    await pm.appendReply({
      replyTo: [],
      text: `${n.title}: ${n.message}`,
      model: "notifier",
      ...(record.to ? { to: record.to } : {}),
    });
    await log.append({
      actor: "harness",
      type: PM_EVENTS.noticeShown,
      ...(n.cardId ? { cardId: n.cardId } : {}),
      payload: { kind: n.event, ...record },
    });
  };

  /**
   * The channels that reach `to`: every shared one; a personal one (email)
   * only when the person has an address, and — in the Team setup — only
   * about an issue in a project they can see (TEAM-43).
   */
  const reaching = async (list: Channel[], to: string, cardId?: string): Promise<Channel[]> => {
    const out: Channel[] = [];
    for (const c of list) {
      if (c.reaches) {
        if (!c.reaches(to)) continue;
        if (cardId && opts.inbox?.visible && !(await opts.inbox.visible(to, cardId))) continue;
      }
      out.push(c);
    }
    return out;
  };

  const tick = async (): Promise<number> => {
    const channels = await channelsOf(repoPath, log, opts);
    if (channels.length === 0) {
      seq = (await log.getLastEvent())?.seq ?? seq;
      return 0;
    }
    const from = seq;
    const events = await log.getEvents(seq + 1, 500);
    let sent = 0;
    let owners: Awaited<ReturnType<typeof cardsOnLedger>> | undefined;
    for (const e of events) {
      seq = Math.max(seq, e.seq);
      const n = noticeFor(e, opts.dashboard);
      if (!n) continue;
      // PM-N9-6: an issue waiting for review is its owner's to hear about.
      if (n.event === "review" && n.cardId) {
        owners ??= await cardsOnLedger(log);
        const owner = owners.get(n.cardId)?.owner;
        if (owner && owner !== person) continue;
      }
      const key = n.key ?? `${n.event}:${n.cardId ?? ""}`;
      const at = Date.now();
      if ((recent.get(key) ?? 0) > at - 600_000) continue;
      const accepting = await reaching(
        channels.filter((c) => c.accepts(n.event)),
        person,
        n.cardId,
      );
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
      // PM-P6-10: at the board, an offer in the panel beats a ping.
      if (budgeted && (await boardInFocus())) {
        await showInPanel(n, record);
        continue;
      }
      const used = budgeted ? await budgetUsed(claimed.seq, e.id) : 0;
      if (budgeted && n.cardId) owners ??= await cardsOnLedger(log);
      const urgent = budgeted && !!n.cardId && owners?.get(n.cardId)?.priority === 1;
      const open = budgeted ? accepting.filter((c) => used < limitFor(c, urgent)) : accepting;
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
    sent += await watchersNotified(channels, from, seq);
    sent += await standupIfDue(channels);
    sent += await remindersIfDue(channels);
    sent += await digestsIfDue(channels);
    return sent;
  };

  /**
   * TEAM-43: each change the Inbox delivered in (from, upTo], to each person
   * it reached, within that person's own budget — held past it, and shown in
   * Seshat's panel instead while they have the board in focus. One claim per
   * person and event, so the install's person, already told by the path
   * above, is not told twice. On the install's push and Slack, which
   * everyone reading them shares, each change goes out once per channel,
   * naming everyone it is for, and counts against each of their budgets —
   * never one copy per watcher. By email each person gets their own
   * message at their own address, naming no one else.
   */
  const watchersNotified = async (channels: Channel[], from: number, upTo: number) => {
    if (!opts.inbox || upTo <= from) return 0;
    let sent = 0;
    const day = dayOf(now());
    const byEvent = new Map<string, WatcherNotice[]>();
    for (const w of await opts.inbox.notices(from)) {
      if (w.seq > upTo) continue;
      const list = byEvent.get(w.eventId) ?? [];
      list.push(w);
      byEvent.set(w.eventId, list);
    }
    for (const [eventId, notices] of byEvent) {
      const first = notices[0] as WatcherNotice;
      // Per channel, the people it goes to there.
      const going = new Map<Channel, WatcherNotice[]>();
      for (const w of notices) {
        const accepting = await reaching(
          channels.filter((c) => c.accepts(w.kind)),
          w.to,
          w.cardId,
        );
        if (accepting.length === 0) continue;
        const record = { to: w.to, notice: eventId, day };
        const claimed = await claim(
          `notify:${w.to}:${eventId}`,
          { kind: w.kind, ...record },
          w.cardId,
        );
        if (!claimed) continue;
        if (await boardInFocus(w.to)) {
          await showInPanel(watcherNotice(w, [w]), record);
          continue;
        }
        const used = await budgetUsed(claimed.seq, eventId, w.to);
        const open = accepting.filter((c) => used < c.limit);
        if (open.length === 0) {
          await log.append({
            actor: "harness",
            type: PM_EVENTS.noticeHeld,
            ...(w.cardId ? { cardId: w.cardId } : {}),
            payload: { kind: w.kind, ...record },
          });
          continue;
        }
        for (const c of open) going.set(c, [...(going.get(c) ?? []), w]);
      }
      for (const [c, to] of going) {
        if (c.reaches) {
          // Personal: one message each, in that person's own words.
          for (const w of to) {
            const r = await c.send(personalNotice(w), { to: w.to, notice: eventId, day });
            if (r.ok) sent++;
          }
          continue;
        }
        const [lead, ...rest] = to as [WatcherNotice, ...WatcherNotice[]];
        const result = await c.send(watcherNotice(first, to), {
          to: lead.to,
          notice: eventId,
          day,
        });
        // The one message reached everyone it names: each budget is charged.
        for (const w of rest) {
          await log.append({
            actor: "harness",
            type: PM_EVENTS.notify,
            ...(w.cardId ? { cardId: w.cardId } : {}),
            payload: {
              channel: c.name,
              kind: w.kind,
              ok: result.ok,
              to: w.to,
              notice: eventId,
              day,
            },
          });
        }
        if (result.ok) sent++;
      }
    }
    return sent;
  };

  /** One person's own message for a change: their line, under the issue's or project's name. */
  const personalNotice = (w: WatcherNotice): Notice => ({
    event: w.kind,
    title: w.title,
    message: w.message,
    priority: w.kind === "mentioned" ? 4 : 3,
    ...(w.cardId ? { cardId: w.cardId } : {}),
    ...(w.cardId && opts.dashboard
      ? { click: `${opts.dashboard}/#/card/${encodeURIComponent(w.cardId)}/activity` }
      : {}),
  });

  /** One message for a change, naming each person it is for with their own words. */
  const watcherNotice = (first: WatcherNotice, to: WatcherNotice[]): Notice => {
    const lines = new Map<string, string[]>();
    for (const w of to) {
      const names = lines.get(w.message) ?? [];
      names.push(w.name ?? "a watcher");
      lines.set(w.message, names);
    }
    return {
      event: to.some((w) => w.kind === "mentioned") ? "mentioned" : first.kind,
      title: first.title,
      message: [...lines]
        .map(([message, names]) => `For ${namesList(names)}: ${message}`)
        .join("\n"),
      priority: to.some((w) => w.kind === "mentioned") ? 4 : 3,
      ...(first.cardId ? { cardId: first.cardId } : {}),
      ...(first.cardId && opts.dashboard
        ? { click: `${opts.dashboard}/#/card/${encodeURIComponent(first.cardId)}/activity` }
        : {}),
    };
  };

  /**
   * TEAM-23, TEAM-43: once a day, when the standup is due, each person whose
   * watcher notices were held gets one digest of those issues still unread
   * in their Inbox — nothing when all of them were read or done. Like the
   * standup it counts against the budget and is never held.
   */
  const digestsIfDue = async (channels: Channel[]): Promise<number> => {
    if (!opts.inbox) return 0;
    const accepting = channels.filter((c) => c.accepts("digest"));
    if (accepting.length === 0) return 0;
    const clock = now();
    const due = minutesOf(opts.standupAt ?? readSettings(repoPath).standupAt);
    if (clock.getHours() * 60 + clock.getMinutes() < due) return 0;
    const day = dayOf(clock);
    // INT-20a: a notice held waits for the next standup — one held after
    // the day's digest went out is carried by the next day's, not dropped.
    const lastDigest = new Map<string, number>();
    const heldEvents: EventRecord[] = [];
    for (const e of await log.getEventsByTypes([PM_EVENTS.noticeHeld, PM_EVENTS.notifyClaimed])) {
      const p = e.payload as NoticeRecord & { kind?: NotifyEvent };
      if (e.type === PM_EVENTS.noticeHeld) heldEvents.push(e);
      else if (p.kind === "digest" && p.to) lastDigest.set(p.to, e.seq);
    }
    const heldCards = new Map<string, Set<string>>();
    for (const e of heldEvents) {
      const p = e.payload as NoticeRecord & { kind?: NotifyEvent };
      if (!p.to || !e.cardId || (p.kind !== "watching" && p.kind !== "mentioned")) continue;
      if (e.seq <= (lastDigest.get(p.to) ?? 0)) continue;
      const set = heldCards.get(p.to) ?? new Set<string>();
      set.add(e.cardId);
      heldCards.set(p.to, set);
    }
    let sent = 0;
    for (const [to, cards] of heldCards) {
      const notice = `digest-${day}`;
      if (log.hasEvent(claimId(`notify:${to}:${notice}`))) continue;
      const reach = await reaching(accepting, to);
      if (reach.length === 0) continue;
      const digest = await opts.inbox.digest(to, cards);
      if (!digest) continue;
      const record = { to, notice, day };
      if (!(await claim(`notify:${to}:${notice}`, { kind: "digest", ...record }))) continue;
      for (const c of reach) {
        // A shared channel's title names whom it is for; a person's own email need not.
        const n: Notice = {
          event: "digest",
          title: c.reaches ? digest.head : digest.title,
          message: digest.message,
          priority: 3,
        };
        if ((await c.send(n, record)).ok) sent++;
      }
    }
    return sent;
  };

  /**
   * PM-N9-6: once a day, when the standup is due, the person's reminders —
   * each claimed once, counted against the day's budget, and past it held
   * for the next standup like any unsolicited notice.
   */
  const remindersIfDue = async (channels: Channel[]): Promise<number> => {
    const accepting = channels.filter((c) => c.accepts("reminder"));
    if (accepting.length === 0) return 0;
    const clock = now();
    const due = minutesOf(opts.standupAt ?? readSettings(repoPath).standupAt);
    if (clock.getHours() * 60 + clock.getMinutes() < due) return 0;
    const day = dayOf(clock);
    const setup = opts.setup ?? setupFor(repoPath);
    let sent = 0;
    const owed: { to: string; n: Notice & { key: string }; forName?: string }[] = (
      await remindersFor(log, person, { day, now: clock, setup })
    ).map((n) => ({ to: person, n }));
    if (setup === "team") {
      // TEAM-29: Update due reaches each project's lead, not only the
      // install's person; on the shared channel it names whom it is for.
      const leads = new Set<string>();
      for (const e of await log.getEventsByTypes(["project/settings_changed"])) {
        const lead = (e.payload as { lead?: unknown }).lead;
        if (typeof lead === "string" && lead !== person) leads.add(lead);
      }
      for (const lead of leads) {
        const name = await personNameOn(log, lead);
        for (const n of await remindersFor(log, lead, { day, now: clock, setup })) {
          if (!n.key.startsWith("reminder-update-")) continue;
          owed.push({ to: lead, n, forName: name ?? "the lead" });
        }
      }
    }
    for (const { to, n: own, forName } of owed) {
      // On a shared channel it names whom it is for; a person's own email need not.
      const shared = forName ? { ...own, title: `For ${forName}: ${own.title}` } : own;
      const reach = await reaching(accepting, to);
      if (reach.length === 0) continue;
      const record = { to, notice: own.key, day };
      const claimed = await claim(`notify:${to}:${own.key}`, { kind: "reminder", ...record });
      if (!claimed) continue;
      if (await boardInFocus(to)) {
        await showInPanel(shared, record);
        continue;
      }
      const used = await budgetUsed(claimed.seq, own.key, to);
      const open = reach.filter((c) => used < c.limit);
      if (open.length === 0) {
        await log.append({
          actor: "harness",
          type: PM_EVENTS.noticeHeld,
          payload: { kind: "reminder", ...record },
        });
        continue;
      }
      for (const c of open) if ((await c.send(c.reaches ? own : shared, record)).ok) sent++;
    }
    return sent;
  };

  /**
   * INT-18: once a day, when due, the standup and every notice held for it,
   * on each channel that accepts it. A channel whose standup failed tries
   * again that day (each attempt claimed), ten minutes apart, six at most.
   */
  const standupIfDue = async (channels: Channel[]): Promise<number> => {
    if (!opts.standup) return 0;
    const accepting = await reaching(
      channels.filter((c) => c.accepts("standup")),
      person,
    );
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
    const body = [await opts.standup(person), heldSummary(held, await cardsOnLedger(log))]
      .filter(Boolean)
      .join("\n\n");
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
