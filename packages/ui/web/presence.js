// Presence (teams item 26, TEAM-26; dashboard DB-N9-20): this page tells the
// server which issue it shows and which card it drags — `POST /api/presence`
// on opening, leaving, a drag's start and end, and every 20 seconds while it
// stays visible (a hidden tab says it left, and sends nothing until shown
// again) — and the others' avatars come back as `presence` frames on the live
// stream (app.js keeps them in `store.state.presence`). Held in memory on the
// server; never recorded. The Team setup only: Solo has no presence.
import { postJSON } from "./dom.js";
import { getSession } from "./session.js";

export const HEARTBEAT_MS = 20_000;

/** This page's own id: two tabs of one person are two tabs, one avatar. */
const tab = (() => {
  try {
    return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
  } catch {
    return `t${Math.random().toString(36).slice(2, 14)}`;
  }
})();

const state = { issue: null, dragging: null };
let timer = null;

/** A hidden tab is not viewing: it says so, and sends no heartbeat until shown again. */
const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

function send() {
  // Solo has no presence (teams item 1): one person has no one to see.
  if (getSession().mode !== "team") return Promise.resolve({ ok: true });
  const away = hidden();
  return postJSON("/api/presence", {
    tab,
    issue: away ? null : state.issue,
    dragging: away ? null : state.dragging,
  }).catch(() => ({ ok: false }));
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if ((state.issue || state.dragging) && !hidden()) timer = setInterval(send, HEARTBEAT_MS);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!state.issue && !state.dragging) return;
    schedule();
    void send();
  });
}

/** The issue page opened `id`, or left it (null). */
export function announceIssue(id) {
  if (state.issue === (id ?? null)) return;
  state.issue = id ?? null;
  schedule();
  void send();
}

/** A drag of card `id` started on the board, or ended (null). */
export function announceDrag(id) {
  if (state.dragging === (id ?? null)) return;
  state.dragging = id ?? null;
  schedule();
  void send();
}
