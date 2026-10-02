// Entry point: who is signed in, then hydrate, subscribe to the ledger stream,
// route, and mount views.
import * as profileView from "./account.js";
import { initAccount } from "./account.js";
import * as auditView from "./audit.js";
import * as boardView from "./board.js";
import { initBulk } from "./bulk.js";
import * as cardView from "./card.js";
import * as configurationView from "./configuration.js";
import { getJSON } from "./dom.js";
import * as graphView from "./graph.js";
import * as inboxView from "./inbox.js";
import { refreshDecisions, refreshInbox } from "./inbox.js";
import * as insightsView from "./insights.js";
import * as integrationsView from "./integrations.js";
import { initKeys } from "./keys.js";
import { initTips, showFirstRun, storage } from "./learn.js";
import * as ledgerView from "./ledger.js";
import { initLevelGates } from "./level_gate.js";
import { authDecision, refusalMessage } from "./lib/account.js";
import { defaultRouteFor, firstRunDue, readRole } from "./lib/learn.js";
import { presenceFrameOf } from "./lib/live.js";
import { navNameOf } from "./lib/nav.js";
import * as machineView from "./machine.js";
import * as membersView from "./members.js";
import * as myIssuesView from "./my_issues.js";
import * as playbookView from "./playbook.js";
import { initPm, loadThread, onPmEvent } from "./pm_client.js";
import { initPmPanel } from "./pm_panel.js";
import * as pmView from "./pm_view.js";
import * as projectsView from "./projects.js";
import * as reviewView from "./review.js";
import * as runsView from "./runs.js";
import { getSession, loadSession } from "./session.js";
import { initShell, setActiveNav, setNavViews } from "./shell.js";
import { mountAuthPage } from "./signin.js";
import * as statusView from "./status.js";
import { store } from "./store.js";
import { followIssueProject, loadProjects } from "./switcher.js";
import { toast } from "./toast.js";

const VIEWS = {
  // Status, the project page for the stakeholder and the team (§2.8, DEC-37).
  status: statusView,
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
  // Teams: the issues a person owns, is delegated or reviews (DB-N9-15).
  "my-issues": myIssuesView,
  graph: graphView,
  // P11 route names; the old ones keep opening the same views (§2.2.1).
  // Projects replaces the Workspace rollup, and `#/workspace` opens it
  // (DB-N9-9). Configuration replaces Registry and Settings:
  // `#/registry` opens its Benchmark, `#/settings` This browser (DB-N6-1).
  projects: projectsView,
  configuration: configurationView,
  workspace: projectsView,
  registry: configurationView,
  settings: configurationView,
  // The account menu's page (§2.2.6); in the palette, with no chord.
  account: profileView,
  // Team only, from the account menu (§2.17.4–5, DB-N9-16; TEAM-27): no chord.
  members: membersView,
  audit: auditView,
};

let current = null;
let currentName = "";

/** `#/review/card_x` -> { name: "review", params: ["card_x"] }. */
export function parseHash(hash = location.hash) {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const name = parts[0] && VIEWS[parts[0]] ? parts[0] : "";
  return { name, params: name ? parts.slice(1) : [] };
}

/**
 * The page with no route (§2.2.5): Configuration › Models while no model is
 * set up (DB-N6-2); then the first-run answer — or, in the Team setup, the
 * profile label — and with no answer, Status for a person who has never
 * accepted an issue.
 */
function defaultRoute({ answered = false } = {}) {
  const s = store.state;
  const session = getSession();
  return defaultRouteFor({
    // An answer to the first-run question goes where it says (SHL-07), model or not;
    // the No Coding model bar stays to say what is missing.
    noModel: !answered && Boolean(s.modelSetup?.none),
    team: session.mode === "team",
    // SHL-03: only who can set up models is sent to Configuration › Models.
    level: session.level,
    profileLabel: session.label,
    role: readRole(storage()),
    reviewWaiting: s.cards.some((c) => c.status === "review"),
    everAccepted: s.cards.some((c) => c.status === "done"),
  });
}

/** The route a page opened with no route landed on; an answer there takes the person home. */
let landedOn = "";

/** Tips on or off: the view mounts again, so its `?` buttons come or go (DB-P4-1). */
function remount() {
  if (!currentName) return;
  // Focus stays on the control that changed Tips: the toggle, or a field by its id.
  const toggle = document.activeElement?.closest?.("[data-tips-toggle]");
  const id = document.activeElement?.id ?? "";
  const parsed = parseHash();
  if (!parsed.name) return;
  current?.unmount?.();
  const view = document.getElementById("view");
  view.textContent = "";
  currentName = parsed.name;
  current = VIEWS[parsed.name].mount(view, parsed);
  if (toggle) document.querySelector("#top [data-tips-toggle]")?.focus();
  else if (id) setTimeout(() => document.getElementById(id)?.focus(), 0);
}

function askFirstRun() {
  if (!firstRunDue(storage(), { noModel: Boolean(store.state.modelSetup?.none) })) return;
  showFirstRun(
    () => {
      remount();
      // SHL-07: the answer goes where it says, from the page the dashboard opened on.
      if (landedOn && parseHash().name === parseHash(landedOn).name)
        location.hash = defaultRoute({ answered: true });
    },
    {
      noModel: Boolean(store.state.modelSetup?.none),
      // SHL-03: only who may change the server's configuration sets up models.
      setsUpModels: getSession().mode !== "team" || getSession().level === "admin",
    },
  );
}

/**
 * Whether any role has a model, and whether the Worker has one that fits
 * (DB-N6-2): read from Configuration's roles and models. The *No Worker
 * model* bar shows on every view until it has one.
 */
async function refreshModelSetup() {
  try {
    const [roles, models] = await Promise.all([
      getJSON("/api/config/roles"),
      getJSON("/api/config/models"),
    ]);
    if (!roles.ok || !models.ok) return;
    const assigned = (roles.data.roles ?? []).filter((r) => r.model);
    const found = models.data.models ?? [];
    const none = assigned.length === 0 && found.length === 0;
    const worker = (roles.data.roles ?? []).find((r) => r.role === "worker");
    const workerFits =
      Boolean(worker?.model) || found.some((m) => m.fits?.worker && m.fits.worker !== "no");
    // SHL-04: the sidebar's model line reads this, Configuration's roles, and nothing else.
    store.set({
      modelSetup: {
        none,
        noWorker: !workerFits,
        workerModel: worker?.model ? String(worker.model) : null,
      },
    });
    // The bar shows whenever the Worker has no model that fits, none at all included.
    showNoWorkerBar(!workerFits);
  } catch {
    // The page works without it; Configuration says the same.
  }
}

function showNoWorkerBar(show) {
  let bar = document.getElementById("sk-noworker");
  if (!show) {
    bar?.remove();
    return;
  }
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "sk-noworker";
  bar.className = "cfg-bar";
  bar.setAttribute("role", "status");
  const session = getSession();
  // SHL-03: who cannot change the server's models is told who can, not sent to a read-only page.
  bar.innerHTML =
    session.mode === "team" && session.level !== "admin"
      ? "No Coding model yet: issues cannot run until an Admin sets one up in Configuration."
      : 'No Coding model: issues cannot run until one fits this machine. <a href="#/configuration/models">Set up models</a>';
  document.getElementById("view")?.before(bar);
}

/**
 * A11Y-01 (WCAG 2.4.1): *Skip to content* moves focus to the page's content and
 * never changes the route — the router once read `#view` as an unknown route
 * and opened Configuration. A `#view` reached another way (typed, or the link
 * followed before this script ran) is put back to the page it was on.
 */
let lastRoute = "";
function skipToContent() {
  const view = document.getElementById("view");
  view?.focus();
}
function initSkipLink() {
  document.querySelector("a.skip")?.addEventListener("click", (e) => {
    e.preventDefault();
    skipToContent();
  });
}

function route() {
  if (location.hash === "#view") {
    history.replaceState(null, "", lastRoute || "#/");
    skipToContent();
    if (lastRoute) return;
  }
  // An invite link opened on a signed-in page, or Sign in: the auth pages decide.
  const decision = authDecision(getSession(), location.hash);
  if (decision.kind === "page") {
    location.reload();
    return;
  }
  if (decision.kind === "redirect") history.replaceState(null, "", decision.to);
  const parsed = parseHash();
  if (!parsed.name) {
    if (!store.state.loaded) return;
    landedOn = defaultRoute();
    history.replaceState(null, "", landedOn);
    return route();
  }
  store.state.route = parsed;
  // The page before this one, for Esc on an issue (A11Y-02).
  if (lastRoute && lastRoute !== location.hash && currentName !== parsed.name)
    store.state.previousRoute = lastRoute;
  lastRoute = location.hash;
  setActiveNav(navNameOf(parsed.name));
  if ((parsed.name === "card" || parsed.name === "review") && parsed.params[0])
    followIssueProject(parsed.params[0]).catch(() => {});
  const view = document.getElementById("view");
  if (currentName === parsed.name && current?.setParams) {
    current.setParams(parsed.params);
    return;
  }
  current?.unmount?.();
  // A11Y-02: focus that was on the page just removed lands on the new page,
  // never on <body>; the first page leaves focus where the browser put it.
  const was = document.activeElement;
  const lost = Boolean(currentName) && (!was || was === document.body || view.contains(was));
  view.textContent = "";
  currentName = parsed.name;
  current = VIEWS[parsed.name].mount(view, parsed);
  const now = document.activeElement;
  if (lost && (!now || now === document.body)) view.focus({ preventScroll: true });
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
    // How the In review limit was reached (dashboard DB-P3-9).
    reviewLimit: board.reviewLimit ?? null,
    backpressureActive: Boolean(board.backpressureActive),
    epics: board.epics ?? [],
    cycles: board.cycles ?? [],
    // Named only when the board is one project's; an all-projects frame keeps it.
    ...(board.estimation ? { estimation: board.estimation === "points" ? "points" : "off" } : {}),
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
  if (res.ok) {
    if (store.state.boardError) store.set({ boardError: 0 });
    applyBoard(res.data);
  } else if (!store.state.cards.length) {
    // ERR-03: a failed read is never an empty board.
    store.set({ boardError: res.status || -1 });
  }
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
  if (board.ok) {
    store.state.boardError = 0;
    applyBoard(board.data);
  } else {
    // ERR-03: the board's read failed; its view says so, with Retry, never "No issues yet".
    store.state.boardError = board.status || -1;
  }
  await refreshModelSetup();
  store.set({ loaded: true });
  refreshDecisions().catch(() => {});
  refreshInbox().catch(() => {});
  refreshAgentStates().catch(() => {});
}

/**
 * The Agent's state per issue and the person's place in the queue (teams
 * items 19, 31): the tiles and the Agent status line read them.
 */
async function refreshAgentStates() {
  const r = await getJSON("/api/agent/states").catch(() => ({ ok: false }));
  if (!r.ok) return;
  store.set({
    agentStates: new Map((r.data?.states ?? []).map((s) => [s.cardId, s.ai])),
    agentQueue: r.data?.queue ?? null,
  });
}

let agentTimer = 0;
function refreshAgentStatesSoon() {
  if (agentTimer) return;
  agentTimer = setTimeout(() => {
    agentTimer = 0;
    refreshAgentStates().catch(() => {});
  }, 1000);
}

/** The Inbox refetched at most once a second while the ledger is busy (a run moves cards often). */
let inboxTimer = 0;
function refreshInboxSoon() {
  if (inboxTimer) return;
  inboxTimer = setTimeout(() => {
    inboxTimer = 0;
    refreshInbox().catch(() => {});
  }, 1000);
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
      // What can reach an Inbox (teams items 22–24): a change on an issue, a mark, a request.
      if (
        (payload.events ?? []).some((e) =>
          /^(card|issue|inbox|agent|plan|project)\/|^decision\//.test(e.type),
        )
      )
        refreshInboxSoon();
      // The Agent's states and the queue move with its issues and requests.
      if ((payload.events ?? []).some((e) => /^(card|agent|queue|decision)\//.test(e.type)))
        refreshAgentStatesSoon();
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
  // Configuration's progress: scan, hash, download, copy, benchmark (PM_CONTRACT §3).
  source.addEventListener("config", (ev) => {
    try {
      window.dispatchEvent(new CustomEvent("sekhemet:config", { detail: JSON.parse(ev.data) }));
    } catch {
      // A malformed frame is dropped; the page re-reads on its next action.
    }
  });
  // NEW-dashboard-3: a running step's output as it decodes. Passed on, never
  // stored: only the Steps tab of that running card listens (DB-N3-2).
  source.addEventListener("tokens", (ev) => {
    try {
      window.dispatchEvent(new CustomEvent("sekhemet:tokens", { detail: JSON.parse(ev.data) }));
    } catch {
      // A malformed frame is dropped; the next one carries the whole tail.
    }
  });
  // TEAM-26, DB-N9-20: who else views which issue and drags which card. Kept
  // in the store for the issue header and the board; never stored beyond it.
  source.addEventListener("presence", (ev) => {
    try {
      store.set({ presence: presenceFrameOf(JSON.parse(ev.data)) });
    } catch {
      // A malformed frame is dropped; the next one carries the whole picture.
    }
  });
  // DB-N2-10: a card's running check started, changed or ended: its badge
  // (*Running Tests…*) is the server's, so the board is read again.
  source.addEventListener("gate", () => {
    void refreshBoard().catch(() => {});
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

/* ---------- Signed out, and refused ---------- */

let reloading = false;
let lastRefusal = { text: "", at: 0 };

/**
 * A 401 on a signed-in Team page means the session ended: the page boots
 * again and shows Sign in, remembering where it was. A 403 from the access
 * rules shows the server's sentence, which names the missing permission and
 * who can grant it (teams TEAM-4).
 */
function onAuth(e) {
  const { status, data } = e.detail ?? {};
  // Solo: a write refused for its token means the server restarted with a
  // new one (security SEC-25); reloading the page picks it up.
  if (getSession().mode !== "team") {
    if (status === 403 && data?.error === "csrf") {
      const text = refusalMessage(403, data, "solo");
      if (text === lastRefusal.text && Date.now() - lastRefusal.at < 2000) return;
      lastRefusal = { text, at: Date.now() };
      toast({ tone: "fail", text });
    }
    return;
  }
  if (status === 401 && !reloading) {
    reloading = true;
    location.reload();
    return;
  }
  const access = data?.refused === "permission" || data?.reason === "forbidden";
  if (status !== 403 || !(access || data?.error === "csrf")) return;
  const text = refusalMessage(403, data);
  if (text === lastRefusal.text && Date.now() - lastRefusal.at < 2000) return;
  lastRefusal = { text, at: Date.now() };
  toast({ tone: "fail", text });
}

/* ---------- Boot ---------- */

async function boot() {
  initSkipLink();
  // An invite link as a path (`/invite/<id>`) is the same page as its route.
  const invite = /^\/invite\/([A-Za-z0-9_-]+)\/?$/.exec(location.pathname);
  if (invite) history.replaceState(null, "", `/#/invite/${invite[1]}`);
  const session = await loadSession();
  const decision = authDecision(session, location.hash);
  if (decision.kind === "page") {
    // Nothing of the app loads before someone is signed in (DB-N9-13).
    const view = document.getElementById("view");
    mountAuthPage(view, decision);
    // Another auth page (an invite, Sign in) mounts in place; the app needs a fresh boot.
    window.addEventListener("hashchange", () => {
      const d = authDecision(session, location.hash);
      if (d.kind === "page") mountAuthPage(view, d);
      else location.reload();
    });
    return;
  }
  if (decision.kind === "redirect") history.replaceState(null, "", decision.to);
  window.addEventListener("sekhemet:auth", onAuth);
  setNavViews(Object.keys(VIEWS));
  initShell();
  // DB-N9-17: a control the person's level does not allow is disabled, and says why.
  initLevelGates();
  initKeys();
  initAccount();
  initTips();
  window.addEventListener("sekhemet:tips", remount);
  const note = setTimeout(() => {
    const el = document.getElementById("sk-note");
    if (el) {
      el.textContent = `Connecting to Sekhemet on ${location.host}…`;
      el.hidden = false;
    }
  }, 3000);
  try {
    // DB-N25-2: the current project first, so every page opens on it (STA-02).
    await loadProjects();
    await hydrate();
  } catch {
    store.set({ loaded: true, connection: "offline", offlineSince: Date.now() });
  }
  clearTimeout(note);
  // A project chosen in the switcher: the board reads it, and the page shows it.
  window.addEventListener("sekhemet:project", (e) => {
    refreshBoard();
    if (!e.detail?.stay) remount();
  });
  window.addEventListener("hashchange", route);
  window.addEventListener("sekhemet:retry", retryConnection);
  window.addEventListener("sekhemet:refresh", () => {
    refreshBoard();
  });
  route();
  // The first-run question, once a model is set up (§2.2.5).
  askFirstRun();
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
  // A snoozed item comes back when its time does.
  setInterval(() => refreshInbox().catch(() => {}), 60_000);
  // Wait times count up; frozen while offline (§2.4 shell states).
  setInterval(() => {
    if (store.state.connection !== "offline") store.set({ now: Date.now() });
  }, 30_000);
}

boot();
