// The Merit panel (PM_DESIGN §2.4): a persistent right-side dock, toggled with
// ⌘J from anywhere. A dock, not an overlay: the view narrows beside it.
import { MOD, esc, icon, kbd } from "./dom.js";
import { formatClock, pmSteps } from "./lib/pm.js";
import { PM_NAME, pmModel } from "./pm_client.js";
import { avatar, mountThread } from "./pm_thread.js";
import { store } from "./store.js";

const KEY = "sekhemet-pm-panel";
let aside = null;
let thread = null;
let open = false;
/** The thread the user sees: the panel's, or the full view's on #/pm. */
let fullThread = null;

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

function onPmRoute() {
  return store.state.route?.name === "pm";
}

function statusLine() {
  const pm = store.state.pm;
  const s = pm.status ?? { phase: "idle" };
  const model = pmModel();
  if (pm.available === false) return { text: "Not on this server", busy: false };
  if (s.phase === "idle") return { text: `Project manager · ${model}`, busy: false, mono: model };
  const row = pmSteps(s, { workerInvolved: pm.workerInvolved, step: pm.step }).find(
    (r) => r.state === "current",
  );
  const since = pm.phaseSeenAt[s.phase];
  return { text: row?.label ?? "Working", busy: true, since };
}

function renderHead() {
  if (!aside) return;
  const st = statusLine();
  const clock = st.since
    ? ` · <span class="tnum" data-head-since="${st.since}">${formatClock(Date.now() - st.since)}</span>`
    : "";
  const line = st.mono
    ? `Project manager · <span class="mono">${esc(st.mono)}</span>`
    : `${st.busy ? '<span class="dot run" aria-hidden="true"></span>' : ""}${esc(st.text)}${clock}`;
  const html = `${avatar()}<div class="who"><b>${PM_NAME}</b><span class="line">${line}</span></div><a class="icon-btn" href="#/pm" title="Open the full conversation (g a)" aria-label="Open the full conversation">${icon("expand", 14, "ic s14")}</a><button class="icon-btn" type="button" data-pm-close title="Close (${MOD}J)" aria-label="Close the ${PM_NAME} panel">${icon("x", 14, "ic s14")}</button>`;
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
  const next = force ?? !open;
  const wasOpen = open;
  open = next;
  remember(open);
  sync();
  if (open && (!wasOpen || !aside?.contains(document.activeElement))) thread?.focus();
  else if (!open) document.getElementById("view")?.focus({ preventScroll: true });
}

/** Open Merit with `text` in the composer, not sent (PM_DESIGN §3.2). */
export function askMerit(text) {
  if (onPmRoute()) {
    fullThread?.prefill(text);
    return;
  }
  if (!open) togglePmPanel(true);
  thread?.prefill(text);
}

export function setFullThread(t) {
  fullThread = t;
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
