// Entry point: hydrate, subscribe to the ledger stream, route, and mount views.
import * as boardView from "./board.js";
import * as cardView from "./card.js";
import { getJSON } from "./dom.js";
import { initKeys } from "./keys.js";
import * as laterView from "./later.js";
import * as reviewView from "./review.js";
import { initShell, setActiveNav } from "./shell.js";
import { store } from "./store.js";

const VIEWS = {
  review: reviewView,
  board: boardView,
  card: cardView,
  runs: laterView,
  ledger: laterView,
  machine: laterView,
  playbook: laterView,
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
  const [board, events, meta, gates, queue] = await Promise.all([
    getJSON("/api/board"),
    getJSON("/api/events"),
    getJSON("/api/meta"),
    getJSON("/api/gates"),
    getJSON("/api/queue"),
  ]);
  if (meta.ok) store.state.meta = meta.data;
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
    }
  });
  source.addEventListener("append", (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.verification) store.state.verification = payload.verification;
      if (payload.board) applyBoard(payload.board);
      else store.set({ verification: store.state.verification });
    } catch {
      // A malformed frame is dropped; the next one carries the full board.
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
  connect();
  refreshDoctor();
  setInterval(refreshDoctor, 30_000);
  // Wait times count up; frozen while offline (§2.4 shell states).
  setInterval(() => {
    if (store.state.connection !== "offline") store.set({ now: Date.now() });
  }, 30_000);
}

boot();
