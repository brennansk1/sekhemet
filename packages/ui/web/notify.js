// A notification when work waits (dashboard §2.16.4, NEW-dashboard-22;
// DEC-53 c4; FINDINGS PRC-11). Kept per browser like the theme
// (`sekhemet-notify`). The browser's permission prompt appears only after
// the person presses *Turn on*, never on load (DB-N22-1). While it is on and
// this tab is open but not in front, an issue entering In review — in the
// Team setup, an Inbox item under *Needs you* or *Review requested* — raises
// one notification naming the issue's key, title and where it waits; more
// within 60 s replace it with their count (DB-N22-2, -3). Clicking it brings
// the tab to the front and opens the issue in Review. Preferences also holds
// the Solo person's switch for the operating-system notification the server
// raises while no tab is open (DB-N22-5 to -7). No library. The words and
// the rules are `/app/lib/notify.js`'s.
import { esc, getJSON, sendJSON } from "./dom.js";
import { storage } from "./learn.js";
import {
  NOTIFY_COPY as C,
  NOTIFY_STORAGE_KEY,
  WaitBatch,
  inboxArrivals,
  notifyOfferVisible,
  notifyState,
  readNotifyPref,
  reviewArrivals,
} from "./lib/notify.js";
import { getSession } from "./session.js";
import { store } from "./store.js";

const batch = new WaitBatch();
/** Team: the Inbox items seen, so only arrivals notify; null until the first load. */
let seen = null;

function supported() {
  return typeof window.Notification === "function";
}

function permission() {
  return supported() ? window.Notification.permission : "denied";
}

export function notifyPref() {
  const s = storage();
  return s ? readNotifyPref(s) : undefined;
}

function setPref(value) {
  try {
    storage()?.setItem(NOTIFY_STORAGE_KEY, value);
  } catch {}
}

export function currentNotifyState() {
  return notifyState({ pref: notifyPref(), permission: permission(), supported: supported() });
}

/** The tab is open but not in front: hidden, or another window has the focus. */
function inFront() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function raise(issue) {
  if (currentNotifyState() !== "on" || inFront()) return;
  const shown = batch.add(issue, Date.now());
  try {
    const n = new window.Notification(shown.title, { tag: "sekhemet-waiting" });
    n.onclick = () => {
      window.focus();
      location.hash = shown.cardId ? `#/review/${encodeURIComponent(shown.cardId)}` : "#/review";
      n.close?.();
    };
  } catch {
    // A browser that refuses a page-made notification raises none.
  }
}

function issueOf(id, fallbackTitle) {
  const card = store.card(id);
  return {
    cardId: id,
    key: card?.display?.shortId ?? id,
    title: card?.display?.title ?? card?.title ?? fallbackTitle ?? "",
  };
}

/** Solo: the live stream's events (app.js's append handler). */
export function noticeEvents(events) {
  if (getSession().mode === "team") return;
  for (const id of reviewArrivals(events ?? [])) raise(issueOf(id));
}

/** Team: the Inbox's items after a refresh (inbox.js); the first load only records them. */
export function noticeInbox(items) {
  if (getSession().mode !== "team") return;
  if (seen === null) {
    seen = new Map();
    inboxArrivals(seen, items ?? []);
    return;
  }
  for (const item of inboxArrivals(seen, items ?? [])) {
    raise(issueOf(item.cardId ?? item.id, item.title));
  }
}

/** *Turn on*: the browser asks for permission now, and only now (DB-N22-1). */
export async function turnOnNotifications() {
  if (!supported()) return "unsupported";
  let answer = window.Notification.permission;
  if (answer === "default") {
    try {
      answer = await window.Notification.requestPermission();
    } catch {
      answer = window.Notification.permission;
    }
  }
  if (answer === "granted") setPref("on");
  return currentNotifyState();
}

/* ---------- The one-time offer above the Review queue ---------- */

/** "" unless the offer is due (the queue holds work and nothing was chosen here). */
export function notifyOfferHtml(queueSize) {
  if (
    !notifyOfferVisible({
      pref: notifyPref(),
      permission: permission(),
      supported: supported(),
      queueSize,
    })
  )
    return "";
  return `<p class="notify-offer" role="note"><span>${esc(C.offer)}</span> <button class="btn sm" type="button" data-notify-on>${esc(C.turnOn)}</button> <button class="btn sm ghost" type="button" data-notify-not-now>${esc(C.notNow)}</button></p>`;
}

/** Wire the offer's two buttons in `host`; `after` redraws. */
export function wireNotifyOffer(host, after) {
  host.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-notify-not-now]")) {
      // Remembered: the offer is not shown again in this browser.
      setPref("not-now");
      after?.();
    } else if (t?.closest("[data-notify-on]")) {
      const state = await turnOnNotifications();
      // Answered either way: a refusal is the browser's, and Preferences says so.
      if (state !== "on") setPref("not-now");
      after?.();
    }
  });
}

/* ---------- Preferences ---------- */

function browserRowHtml() {
  const state = currentNotifyState();
  const words =
    state === "on"
      ? C.on
      : state === "blocked"
        ? C.blocked
        : state === "unsupported"
          ? C.unsupported
          : C.off;
  const button =
    state === "on"
      ? `<button class="btn" type="button" data-notify-off>${esc(C.turnOff)}</button>`
      : state === "off"
        ? `<button class="btn" type="button" data-notify-on>${esc(C.turnOn)}</button>`
        : "";
  return `<div class="row"><span id="cfg-notify-l">${esc(C.setting)}</span>${button}</div><p class="${state === "blocked" ? "why" : "sec"}" id="cfg-notify-state" data-notify-state="${esc(state)}">${esc(words)}</p>`;
}

async function desktopRowHtml() {
  // Teams: the server is not the person's computer, so the switch is not offered.
  if (getSession().mode === "team") return "";
  const r = await getJSON("/api/notify/desktop").catch(() => ({ ok: false }));
  if (!r.ok || r.data?.offered === false) return "";
  const d = r.data;
  const disabled = !d.available;
  return `<div class="row"><label><input type="checkbox" data-notify-desktop${d.on ? " checked" : ""}${disabled ? ' disabled aria-describedby="cfg-notify-desktop-why"' : ""}> ${esc(C.desktop)}</label></div><p class="${disabled ? "why" : "sec"}" id="cfg-notify-desktop-why">${esc(disabled ? d.reason : C.desktopHint)}</p><p class="why" role="status" data-notify-desktop-note></p>`;
}

/** Mount the Notifications part of Preferences into `host`. */
export async function mountNotifyPrefs(host) {
  if (!host) return;
  const draw = async () => {
    host.innerHTML = `<h4 id="cfg-h-notify">${esc(C.heading)}</h4>${browserRowHtml()}${await desktopRowHtml()}`;
  };
  host.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-notify-on]")) {
      await turnOnNotifications();
      await draw();
    } else if (t?.closest("[data-notify-off]")) {
      setPref("off");
      await draw();
    }
  });
  host.addEventListener("change", async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.hasAttribute("data-notify-desktop")) return;
    const r = await sendJSON("POST", "/api/notify/desktop", { on: t.checked });
    const note = host.querySelector("[data-notify-desktop-note]");
    if (note) note.textContent = r.ok ? C.saved : (r.data?.error ?? "Not saved.");
    if (!r.ok) t.checked = !t.checked;
  });
  await draw();
}
