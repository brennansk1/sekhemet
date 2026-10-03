/**
 * A notification when work waits (dashboard §2.16.4, NEW-dashboard-22;
 * DEC-53 c4; FINDINGS PRC-11): the words, the per-browser setting
 * (`sekhemet-notify`), the one-time offer above the Review queue, what counts
 * as work arriving, and the 60-second batching. Pure: the page's
 * `notify.js` raises the browser's notification from it, and the server's
 * operating-system notification (`desktop_notify.ts`) uses the same words.
 * A notification names the issue's key, title and where it waits — never
 * code, a diff or a model's text.
 */

export const NOTIFY_STORAGE_KEY = "sekhemet-notify";
export type NotifyPref = "on" | "off" | "not-now";
export type NotifyPermission = "default" | "granted" | "denied";

/** Several arrivals within this window raise one notification that counts them (DB-N22-3). */
export const NOTIFY_WINDOW_MS = 60_000;

/** The column work waits in. */
const WHERE = "In review";

export const NOTIFY_COPY = {
  heading: "Notifications",
  setting: "Notify me in this browser when work waits for me",
  offer: "Get a browser notification when work waits for you.",
  turnOn: "Turn on",
  turnOff: "Turn off",
  notNow: "Not now",
  on: "On. A notification comes when an issue waits for you and no dashboard tab is in front.",
  off: "Off.",
  blocked:
    "Your browser blocks notifications from this dashboard, so none are shown. To allow them, open the browser's site settings for this address (the icon at the left of the address bar), set Notifications to Allow, then press Turn on.",
  unsupported: "This browser cannot show notifications.",
  desktop: "Also notify me on this computer when no dashboard tab is open",
  desktopHint:
    "Sekhemet raises it through this computer's own notifications while no dashboard tab is open, with the same words.",
  saved: "Saved.",
} as const;

export function readNotifyPref(storage: {
  getItem: (key: string) => string | null;
}): NotifyPref | undefined {
  try {
    const v = storage.getItem(NOTIFY_STORAGE_KEY);
    return v === "on" || v === "off" || v === "not-now" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** What the setting shows: on only with the browser's permission granted. */
export function notifyState(input: {
  pref: NotifyPref | undefined;
  permission: NotifyPermission;
  supported: boolean;
}): "unsupported" | "blocked" | "on" | "off" {
  if (!input.supported) return "unsupported";
  if (input.permission === "denied") return "blocked";
  return input.pref === "on" && input.permission === "granted" ? "on" : "off";
}

/** The one-time offer: the queue holds work and nothing was chosen in this browser. */
export function notifyOfferVisible(input: {
  pref: NotifyPref | undefined;
  permission: NotifyPermission;
  supported: boolean;
  queueSize: number;
}): boolean {
  return (
    input.supported &&
    input.permission !== "denied" &&
    input.pref === undefined &&
    input.queueSize > 0
  );
}

export interface WaitingIssue {
  cardId: string;
  key: string;
  title: string;
}

/** *CHR-12 Implement canonical JSON · waiting in In review* */
export function waitingLine(issue: { key: string; title: string }): string {
  return `${issue.key} ${issue.title} · waiting in ${WHERE}`;
}

/** *3 issues wait in In review* */
export function waitingCount(n: number): string {
  return n === 1 ? `1 issue waits in ${WHERE}` : `${n} issues wait in ${WHERE}`;
}

/**
 * The notification to show for an arrival: the first of a window at once,
 * naming the issue; each further one within 60 s replaces it with the count
 * (DB-N22-3), so several arrivals are one notification on screen.
 */
export class WaitBatch {
  private start = Number.NEGATIVE_INFINITY;
  private readonly ids = new Set<string>();

  constructor(private readonly windowMs = NOTIFY_WINDOW_MS) {}

  public add(issue: WaitingIssue, now: number): { title: string; cardId?: string; count: number } {
    if (now - this.start > this.windowMs) {
      this.start = now;
      this.ids.clear();
    }
    this.ids.add(issue.cardId);
    const count = this.ids.size;
    return count === 1
      ? { title: waitingLine(issue), cardId: issue.cardId, count }
      : { title: waitingCount(count), count };
  }
}

interface LedgerEvent {
  type: string;
  cardId?: string;
  payload?: unknown;
}

/** Solo: the issues these events moved into In review from another column. */
export function reviewArrivals(events: readonly LedgerEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "card/status_changed" || !e.cardId) continue;
    const p = (e.payload ?? {}) as { fromStatus?: string; toStatus?: string };
    if (p.toStatus === "review" && p.fromStatus !== "review" && !out.includes(e.cardId))
      out.push(e.cardId);
  }
  return out;
}

interface InboxRow {
  id: string;
  reason: string;
  seq: number;
  unread?: boolean;
  done?: boolean;
  /** The item's kind; only an issue is notified (DB-N22-2). */
  kind?: string;
  cardId?: string;
}

/**
 * The Team setup: issues newly in the Inbox under *Needs you* or *Review
 * requested* — unread, not done, and changed since last seen. Only an issue
 * (DB-N22-2: the notification names its key, its title and where it
 * waits): a triage count, a rule notice, a plan, a question or an invite is
 * the Inbox's to show, never a notification naming an id or a column it is
 * not in. `seen` is updated.
 */
export function inboxArrivals<T extends InboxRow>(
  seen: Map<string, number>,
  items: readonly T[],
): T[] {
  const out: T[] = [];
  for (const i of items) {
    const before = seen.get(i.id);
    if (before !== undefined && before >= i.seq) continue;
    seen.set(i.id, i.seq);
    if (i.reason !== "needs_you" && i.reason !== "review_requested") continue;
    if (i.done || i.unread === false) continue;
    if (i.kind !== "issue" || !i.cardId) continue;
    out.push(i);
  }
  return out;
}
