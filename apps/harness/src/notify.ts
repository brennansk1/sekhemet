import type { EventLog, EventRecord } from "@sekhemet/kernel";
import { readSettings, writeSettings } from "./integrations.js";
import { PM_EVENTS } from "./pm/types.js";

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
export type NotifyEvent = "review" | "parked" | "budget" | "question" | "run_report" | "test";

export const ALL_EVENTS: NotifyEvent[] = ["review", "parked", "budget", "question", "run_report"];

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
    const res = await (deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(10_000) });
    result = res.ok ? { ok: true } : { ok: false, error: `${p.kind} answered ${res.status}` };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await deps.log
    ?.append({
      actor: "harness",
      type: PM_EVENTS.notify,
      ...(n.cardId ? { cardId: n.cardId } : {}),
      payload: { channel: p.kind, kind: n.event, ok: result.ok },
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

/**
 * Tail the ledger and push what needs a person. Starts after the current last
 * event (no replay of history), polls every `intervalMs`, and never pushes the
 * same (event, card) twice within ten minutes.
 */
export async function startNotifier(
  log: EventLog,
  repoPath: string,
  opts: { intervalMs?: number; dashboard?: string; fetch?: typeof fetch } = {},
): Promise<{ stop: () => void; tick: () => Promise<number> }> {
  let seq = (await log.getLastEvent())?.seq ?? 0;
  const recent = new Map<string, number>();
  const tick = async (): Promise<number> => {
    if (!readPush(repoPath)) {
      seq = (await log.getLastEvent())?.seq ?? seq;
      return 0;
    }
    const events = await log.getEvents(seq + 1, 500);
    let sent = 0;
    for (const e of events) {
      seq = Math.max(seq, e.seq);
      const n = noticeFor(e, opts.dashboard);
      if (!n) continue;
      const key = `${n.event}:${n.cardId ?? ""}`;
      const now = Date.now();
      if ((recent.get(key) ?? 0) > now - 600_000) continue;
      recent.set(key, now);
      const r = await sendPush(repoPath, n, { log, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
      if (r.ok) sent++;
    }
    return sent;
  };
  const timer = setInterval(() => void tick().catch(() => undefined), opts.intervalMs ?? 5000);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
