// Entry point: hydrate, subscribe to the ledger stream, route, and mount views.
import * as boardView from "./board.js";
import * as insightsView from "./insights.js";
import * as integrationsView from "./integrations.js";
import * as cardView from "./card.js";
import { getJSON } from "./dom.js";
import { initKeys } from "./keys.js";
import * as ledgerView from "./ledger.js";
import * as machineView from "./machine.js";
import * as playbookView from "./playbook.js";
import { initPm, loadThread, onPmEvent } from "./pm_client.js";
import { initPmPanel } from "./pm_panel.js";
import * as pmView from "./pm_view.js";
import * as reviewView from "./review.js";
import * as runsView from "./runs.js";
import { initShell, setActiveNav } from "./shell.js";
import { store } from "./store.js";

const VIEWS = {
  review: reviewView,
  board: boardView,
  card: cardView,
  runs: runsView,
  ledger: ledgerView,
  machine: machineView,
  playbook: playbookView,
  pm: pmView,
  insights: insightsView,
  integrations: integrationsView,
};

let current = null;
let currentName = "";

/** `#/review/card_x` -> { name: "review", params: ["card_x"] }. */
export function parseHash(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const name = parts[0] && VIEWS[parts[0]] ? parts[0] : "";
  return { name, params: name ? parts.slice(1) : [] };
}

function defaultRoute() {
  return store.state.cards.some((c) => c.status === "review") ? "#/review" : "#/board";
}

function route() {
  const parsed = parseHash();
  if (!parsed.name) {
    if (!store.state.loaded) return;
    history.replaceState(null, "", defaultRoute());
    return route();
  }
  store.state.route = parsed;
  setActiveNav(parsed.name === "card" ? "" : parsed.name);
  const view = document.getElementById("view");
  if (currentName === parsed.name && current?.setParams) {
    current.setParams(parsed.params);
    return;
  }
  current?.unmount?.();
  view.textContent = "";
  currentName = parsed.name;
  current = VIEWS[parsed.name].mount(view, parsed);
}

export function currentView() {
  return current;
}
window.sekhemetView = () => current;

/* ---------- Data ---------- */

function applyBoard(board) {
  if (!board) return;
  const prev = new Map(store.state.cards.map((c) => [c.id, c.status]));
  const moved = store.state.moved;
  const now = Date.now();
  for (const c of board.cards ?? []) {
    const was = prev.get(c.id);
    if (was && was !== c.status) moved.set(c.id, now);
  }
  store.set({
    cards: board.cards ?? [],
    wipLimits: board.wipLimits ?? {},
    backpressureActive: Boolean(board.backpressureActive),
    epics: board.epics ?? [],
    cycles: board.cycles ?? [],
    feed: store.state.feed,
    moved,
    now,
  });
}

export async function refreshBoard() {
  const res = await getJSON("/api/board");
  if (res.ok) applyBoard(res.data);
  return res.ok;
}

async function refreshDoctor() {
  try {
    const res = await getJSON("/api/doctor");
    if (res.ok) store.set({ doctor: res.data });
  } catch {
    // The footer keeps its last reading.
  }
}

async function hydrate() {
  const [board, events, meta, gates, queue, playbook] = await Promise.all([
    getJSON("/api/board"),
    getJSON("/api/events?limit=1"),
    getJSON("/api/meta"),
    getJSON("/api/gates"),
    getJSON("/api/queue"),
    getJSON("/api/playbook"),
  ]);
  if (meta.ok) store.state.meta = meta.data;
  if (playbook.ok) store.state.playbook = playbook.data;
  if (gates.ok) store.state.gates = gates.data;
  if (queue.ok) store.state.queue = queue.data;
  if (events.ok) store.state.verification = events.data.verification;
  if (board.ok) applyBoard(board.data);
  store.set({ loaded: true });
}

/* ---------- Live stream ---------- */

let source = null;
let offlineTimer = 0;

function goOffline() {
  store.set({ connection: "offline", offlineSince: store.state.reconnectingSince || Date.now() });
}

function scheduleOfflineCheck() {
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(async () => {
    if (store.state.connection === "live") return;
    try {
      const meta = await getJSON("/api/meta");
      if (!meta.ok) goOffline();
      else scheduleOfflineCheck();
    } catch {
      goOffline();
    }
  }, 10_000);
}

export function connect() {
  source?.close();
  source = new EventSource("/api/stream");
  source.addEventListener("open", async () => {
    const wasDown = store.state.connection !== "live" && store.state.loaded;
    clearTimeout(offlineTimer);
    store.set({ connection: "live", reconnectingSince: 0, offlineSince: 0 });
    // Frames sent while we were away are gone; catch up once.
    if (wasDown) {
      await hydrate().catch(() => {});
      loadThread();
    }
  });
  source.addEventListener("append", (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.verification) store.state.verification = payload.verification;
      // Views that follow the ledger (Steps, Thread, Ledger) read the new events.
      store.state.feed = payload.events ?? [];
      if (
        (payload.events ?? []).some(
          (e) => e.type === "card/status_changed" && /^returned/.test(e.payload?.reason ?? ""),
        )
      ) {
        getJSON("/api/playbook").then((r) => r.ok && store.set({ playbook: r.data }));
      }
      if (payload.board) applyBoard(payload.board);
      else store.set({ verification: store.state.verification, feed: store.state.feed });
    } catch {
      // A malformed frame is dropped; the next one carries the full board.
    }
  });
  source.addEventListener("pm", (ev) => {
    try {
      onPmEvent(JSON.parse(ev.data));
    } catch {
      // A malformed frame is dropped; the thread reloads on reconnect.
    }
  });
  source.addEventListener("machine", (ev) => {
    try {
      store.set({ machine: JSON.parse(ev.data).memory });
    } catch {
      // Dropped; the next sample arrives in five seconds.
    }
  });
  source.addEventListener("error", () => {
    if (store.state.connection === "live" || store.state.connection === "connecting") {
      store.set({ connection: "reconnecting", reconnectingSince: Date.now() });
      scheduleOfflineCheck();
    }
  });
}

async function retryConnection() {
  try {
    await hydrate();
    connect();
  } catch {
    goOffline();
  }
}

/* ---------- Boot ---------- */

async function boot() {
  initShell();
  initKeys();
  const note = setTimeout(() => {
    const el = document.getElementById("sk-note");
    if (el) {
      el.textContent = `Connecting to Sekhemet on ${location.host}…`;
      el.hidden = false;
    }
  }, 3000);
  try {
    await hydrate();
  } catch {
    store.set({ loaded: true, connection: "offline", offlineSince: Date.now() });
  }
  clearTimeout(note);
  window.addEventListener("hashchange", route);
  window.addEventListener("sekhemet:retry", retryConnection);
  window.addEventListener("sekhemet:refresh", () => {
    refreshBoard();
  });
  route();
  initPm();
  initPmPanel();
  connect();
  refreshDoctor();
  setInterval(refreshDoctor, 30_000);
  // Wait times count up; frozen while offline (§2.4 shell states).
  setInterval(() => {
    if (store.state.connection !== "offline") store.set({ now: Date.now() });
  }, 30_000);
}

boot();
