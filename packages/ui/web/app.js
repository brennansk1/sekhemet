// Entry point: hydrate, subscribe to the ledger stream, route, and mount views.
import * as boardView from "./board.js";
import { initBulk } from "./bulk.js";
import * as cardView from "./card.js";
import { getJSON } from "./dom.js";
import * as graphView from "./graph.js";
import * as inboxView from "./inbox.js";
import { refreshDecisions } from "./inbox.js";
import * as insightsView from "./insights.js";
import * as integrationsView from "./integrations.js";
import { initKeys } from "./keys.js";
import * as ledgerView from "./ledger.js";
import { navNameOf } from "./lib/nav.js";
import * as machineView from "./machine.js";
import * as playbookView from "./playbook.js";
import { initPm, loadThread, onPmEvent } from "./pm_client.js";
import { initPmPanel } from "./pm_panel.js";
import * as pmView from "./pm_view.js";
import * as registryView from "./registry.js";
import * as reviewView from "./review.js";
import * as runsView from "./runs.js";
import { initShell, setActiveNav, setNavViews } from "./shell.js";
import { store } from "./store.js";
import * as workspaceView from "./workspace.js";

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
  inbox: inboxView,
  graph: graphView,
  // P11 route names; the old ones keep opening the same views (§2.2.1).
  // Projects shows the workspace rollup and Configuration the model registry
  // until their own pages are built (NEW-dashboard-9, NEW-dashboard-6).
  projects: workspaceView,
  configuration: registryView,
  workspace: workspaceView,
  registry: registryView,
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
  setActiveNav(navNameOf(parsed.name));
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

/** The board, scoped to the Workspace's chosen project when there is one (U7, U21). */
function boardPath() {
  const id = store.state.project?.id;
  return id ? `/api/board?project=${encodeURIComponent(id)}` : "/api/board";
}

export async function refreshBoard() {
  const res = await getJSON(boardPath());
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

/** The model roster (who is the Worker, what is loaded), for the sidebar. */
async function refreshRoster() {
  try {
    const res = await getJSON("/api/models");
    if (res.ok) store.set({ roster: res.data.roles ?? [] });
  } catch {
    // The sidebar falls back to the served-model probe.
  }
}

async function hydrate() {
  const [board, events, meta, gates, queue, playbook] = await Promise.all([
    getJSON(boardPath()),
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
  refreshDecisions().catch(() => {});
}

/** The highest ledger seq seen: the checkpoint a reconnect replays from (U9). */
function noteSeq(events) {
  const last = events?.length ? events[events.length - 1].seq : 0;
  if (last > store.state.lastSeq) store.state.lastSeq = last;
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
  // U9: a fresh connection asks the server to replay everything after the
  // last seq this page saw; the browser's own reconnects send Last-Event-ID.
  const since = store.state.lastSeq;
  source = new EventSource(since > 0 ? `/api/stream?since=${since}` : "/api/stream");
  source.addEventListener("open", async () => {
    const wasDown = store.state.connection !== "live" && store.state.loaded;
    clearTimeout(offlineTimer);
    store.set({ connection: "live", reconnectingSince: 0, offlineSince: 0 });
    // Without a checkpoint there is nothing to replay from: catch up once.
    if (wasDown && store.state.lastSeq === 0) {
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
      noteSeq(payload.events);
      // A replay after a gap: the Seshat thread may have moved too.
      if (payload.replay) loadThread();
      if ((payload.events ?? []).some((e) => /^decision\//.test(e.type))) refreshDecisions();
      if (
        (payload.events ?? []).some(
          (e) => e.type === "card/status_changed" && /^returned/.test(e.payload?.reason ?? ""),
        )
      ) {
        getJSON("/api/playbook").then((r) => r.ok && store.set({ playbook: r.data }));
      }
      // A project-scoped board refetches its own slice instead of the frame's.
      if (payload.board && store.state.project?.id) refreshBoard();
      else if (payload.board) applyBoard(payload.board);
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
      const memory = JSON.parse(ev.data).memory;
      // The Machine view's memory sparkline: the last 120 samples (10 minutes).
      const t = store.state.telemetry;
      const sample =
        memory?.usedRatio !== undefined ? [{ at: Date.now(), pct: memory.usedRatio * 100 }] : [];
      store.set({
        machine: memory,
        telemetry: { ...t, memory: [...t.memory, ...sample].slice(-120) },
      });
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
  setNavViews(Object.keys(VIEWS));
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
  refreshRoster();
  setInterval(refreshRoster, 30_000);
  initPm();
  initPmPanel();
  initBulk();
  connect();
  refreshDoctor();
  setInterval(refreshDoctor, 30_000);
  // Decision deadlines and new asks: the sidebar count stays current.
  setInterval(() => refreshDecisions().catch(() => {}), 60_000);
  // Wait times count up; frozen while offline (§2.4 shell states).
  setInterval(() => {
    if (store.state.connection !== "offline") store.set({ now: Date.now() });
  }, 30_000);
}

boot();
