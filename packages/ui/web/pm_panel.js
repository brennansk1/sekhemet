// The Seshat panel (PM_DESIGN §2.4): a persistent right-side dock, toggled with
// ⌘J from anywhere. A dock, not an overlay: the view narrows beside it.
import { MOD, aiBadge, esc, icon, kbd } from "./dom.js";
import { formatClock, pmSteps } from "./lib/pm.js";
import { seshatHeader, seshatOpensIn } from "./lib/seshat.js";
import { PM_NAME, sendMessage } from "./pm_client.js";
import { avatar, mountThread } from "./pm_thread.js";
import { store } from "./store.js";

const KEY = "sekhemet-pm-panel";
let aside = null;
let thread = null;
let open = false;
/** The thread the user sees: the panel's, or the full view's on #/pm. */
let fullThread = null;
/** Words for the full view's composer, held until it mounts (a phone opens #/pm). */
let pendingPrefill = null;

/** Below 768 px the panel is hidden (`pm.css`): Seshat is the full view (§2.7.1). */
function onPhone() {
  return seshatOpensIn(window.innerWidth) === "full";
}

function saved() {
  try {
    return localStorage.getItem(KEY) === "open";
  } catch {
    return false;
  }
}

function remember(v) {
  try {
    localStorage.setItem(KEY, v ? "open" : "closed");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
}

/** A page that is the conversation: #/pm, and the start page (design-stage §2.11). */
function onPmRoute() {
  const r = store.state.route;
  return r?.name === "pm" || (r?.name === "projects" && r.params?.[0] === "new");
}

/** DB-P5-6: *Seshat · Project manager* and the presence line; no model (Configuration names it). */
function statusLine() {
  const pm = store.state.pm;
  const s = pm.status ?? { phase: "idle" };
  const row =
    s.phase === "idle"
      ? undefined
      : pmSteps(s, { workerInvolved: pm.workerInvolved, step: pm.step }).find(
          (r) => r.state === "current",
        );
  const head = seshatHeader({ available: pm.available, phase: s.phase, current: row?.label });
  return { ...head, since: head.busy ? pm.phaseSeenAt[s.phase] : undefined };
}

function renderHead() {
  if (!aside) return;
  const st = statusLine();
  const clock = st.since
    ? ` · <span class="tnum" data-head-since="${st.since}">${formatClock(Date.now() - st.since)}</span>`
    : "";
  const line = `${st.busy ? '<span class="dot run" aria-hidden="true"></span>' : ""}${esc(st.line)}${clock}`;
  const html = `${avatar()}<div class="who"><span class="nm"><b>${esc(st.title)}</b>${aiBadge()}</span><span class="line">${line}</span></div><a class="icon-btn" href="#/pm" title="Open the full conversation (g p)" aria-label="Open the full conversation">${icon("expand", 14, "ic s14")}</a><button class="icon-btn" type="button" data-pm-close title="Close (${MOD}J)" aria-label="Close the ${PM_NAME} panel">${icon("x", 14, "ic s14")}</button>`;
  const head = aside.querySelector(".pm-head");
  if (head.dataset.html !== html) {
    head.innerHTML = html;
    head.dataset.html = html;
  }
}

function sync() {
  const show = open && !onPmRoute();
  if (show && !aside) {
    aside = document.createElement("aside");
    aside.className = "pm-dock";
    aside.setAttribute("aria-label", `${PM_NAME}, project manager`);
    aside.innerHTML = '<header class="pm-head"></header><div class="pm-body"></div>';
    document.body.append(aside);
    thread = mountThread(aside.querySelector(".pm-body"), { variant: "panel" });
    aside.addEventListener("click", (e) => {
      if (e.target instanceof Element && e.target.closest("[data-pm-close]")) togglePmPanel(false);
    });
    renderHead();
  } else if (!show && aside) {
    thread?.destroy();
    thread = null;
    aside.remove();
    aside = null;
  }
  document.body.classList.toggle("pm-open", show);
  // The board measures its width on resize; let it re-fit beside the dock.
  window.dispatchEvent(new Event("resize"));
}

export function togglePmPanel(force) {
  if (onPmRoute() && force !== false) {
    fullThread?.focus();
    return;
  }
  // A phone has no panel: opening Seshat opens the full view.
  if (force !== false && onPhone()) {
    location.hash = "#/pm";
    return;
  }
  const next = force ?? !open;
  const wasOpen = open;
  open = next;
  remember(open);
  sync();
  if (open && (!wasOpen || !aside?.contains(document.activeElement))) thread?.focus();
  else if (!open) document.getElementById("view")?.focus({ preventScroll: true });
}

/** Open Seshat with `text` in the composer, not sent (PM_DESIGN §3.2). */
export function askMerit(text) {
  if (onPmRoute() || onPhone()) {
    if (fullThread && onPmRoute()) fullThread.prefill(text);
    else {
      pendingPrefill = text;
      if (!onPmRoute()) location.hash = "#/pm";
    }
    return;
  }
  if (!open) togglePmPanel(true);
  thread?.prefill(text);
}

/**
 * Ask Seshat `text` from anywhere (the palette's *Ask Seshat: <query>*): sent
 * with what the person is looking at, then Seshat opened on the reply. When
 * it cannot be sent (read-only, offline), it waits in the composer instead.
 */
export async function askSeshat(text, context) {
  const sent = await sendMessage(text, context);
  if (sent) togglePmPanel(true);
  else askMerit(text);
}

/** Open the full conversation with `text` in its composer, not sent (the start page's `/plan`). */
export function openConversationWith(text) {
  pendingPrefill = text;
  location.hash = "#/pm";
}

export function setFullThread(t) {
  fullThread = t;
  if (t && pendingPrefill != null) {
    t.prefill(pendingPrefill);
    pendingPrefill = null;
  }
}

export function panelKbd() {
  return kbd(`${MOD}J`);
}

export function initPmPanel() {
  open = saved();
  sync();
  store.on((_s, patch) => {
    if ("route" in patch || "loaded" in patch) sync();
    renderHead();
  });
  window.addEventListener("hashchange", () => setTimeout(sync, 0));
  window.addEventListener("sekhemet:open-pm", () => togglePmPanel(true));
  setInterval(() => {
    const n = aside?.querySelector("[data-head-since]");
    if (n && store.state.connection !== "offline")
      n.textContent = formatClock(Date.now() - Number(n.dataset.headSince));
  }, 1000);
}
