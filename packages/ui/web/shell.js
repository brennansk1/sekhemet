// Sidebar, topbar and the four shell bars (FRONTEND_DESIGN §2.2, §2.4).
import { MOD, brandLockup, esc, icon, kbd, tip } from "./dom.js";
import { tipsToggleHtml } from "./learn.js";
import { ACCOUNT_COPY, accountHeader, initials, themeChoice, themeFor } from "./lib/account.js";
import { agentStatusLine, bottomBar, navNameOf, visibleNav } from "./lib/nav.js";
import { stopReasonLabel } from "./lib/vocabulary.js";
import { getSession } from "./session.js";
import { ledgerAltered, store } from "./store.js";

// The views the page mounts, by nav name (app.js); a view not built is never linked.
let mounted = new Set();

export function setNavViews(names) {
  mounted = new Set(names.map(navNameOf).filter(Boolean));
  renderSide();
}

/** The nav items shown now, in order (dashboard §2.2.1, P11). */
export function currentNav() {
  const s = store.state;
  return visibleNav({
    views: mounted,
    team: getSession().mode === "team",
    completedRuns: s.queue?.entries?.length ?? 0,
    dependencyEdges: s.cards.filter((c) => c.dependsOn?.length).length,
    playbookEntries: (s.playbook?.rules?.length ?? 0) + (s.playbook?.candidates?.length ?? 0),
  });
}

let active = "";
let lastSide = "";
let lastTabs = "";
/** The More disclosure, kept across renders; open by default while it holds the page. */
let moreOpen = null;
let lastBar = "";

/* ---------- Theme: System, Light or Dark, kept per browser (§2.1.3) ---------- */

const THEME_KEY = "sekhemet-theme";
let themeThisPage = null;

/** The person's choice; nothing saved follows the operating system. */
export function currentThemeChoice() {
  if (themeThisPage) return themeThisPage;
  try {
    return themeChoice(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

function applyTheme() {
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  document.documentElement.dataset.theme = themeFor(currentThemeChoice(), light);
  renderSide();
}

export function setTheme(choice) {
  themeThisPage = null;
  try {
    if (choice === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice === "light" ? "sand" : "basalt");
  } catch {
    // Private mode: the choice lasts for this page only.
    themeThisPage = choice;
  }
  applyTheme();
}

/**
 * Compact (88 px tiles) or comfortable (112 px: the spec line, the token and
 * time bars, difficulty); this browser's, like the theme (DB-N4-1).
 */
export function setDensity(value) {
  const next = value === "comfortable" ? "comfortable" : "compact";
  document.documentElement.dataset.density = next;
  try {
    localStorage.setItem("sekhemet-density", next);
  } catch {
    // Private mode: this page only.
  }
  window.dispatchEvent(new CustomEvent("sekhemet:refresh-view"));
}

/** The palette's Switch theme: from what shows now to the other one. */
export function toggleTheme() {
  setTheme(document.documentElement.dataset.theme === "sand" ? "dark" : "light");
}

export function setActiveNav(name) {
  active = name;
  renderSide();
}

/** The topbar belongs to the view: title, a quiet crumb, filters. Search is always on the right. */
export function setTopbar({ title, crumb = "", filters = "" }) {
  const top = document.getElementById("top");
  const html = `<h1 id="view-title">${esc(title)}</h1>${crumb ? `<span class="crumb">${esc(crumb)}</span>` : ""}${filters}<div class="right">${tipsToggleHtml()}<button class="search" type="button" data-palette aria-label="Search or run a command" aria-keyshortcuts="${MOD === "⌘" ? "Meta+K" : "Control+K"}" title="Search or run a command (${MOD}K)">${icon("search", 14, "ic s14")}<span class="lbl">Search or run a command</span>${kbd(`${MOD}K`)}</button></div>`;
  if (top.dataset.html !== html) {
    top.innerHTML = html;
    top.dataset.html = html;
  }
  document.title = `${title} · ${store.state.meta?.project ?? "Sekhemet"} · Sekhemet`;
}

/* ---------- Derived status ---------- */

function firstTryText(queue) {
  const entries = queue?.entries ?? [];
  if (entries.length === 0) return "";
  const ids = new Set(entries.map((e) => e.cardId));
  const first = entries.filter((e) => e.attempt !== 2 && e.passed).length;
  return `${first} of ${ids.size}`;
}

/** Memory and model, from the health checks until /api/machine exists. */
export function machineStatus(doctor, live) {
  const checks = doctor?.checks ?? [];
  const mem = checks.find((c) => c.name === "Unified memory");
  const inf = checks.find((c) => c.name === "Local inference socket");
  const pct = mem ? Number(/(\d+)% used/.exec(mem.detail)?.[1]) : Number.NaN;
  const level = mem ? (/used, (\w+)\)/.exec(mem.detail)?.[1] ?? "") : "";
  let model = "";
  if (inf?.status === "pass") {
    model = (inf.detail.split("):")[1] ?? inf.detail.split(": ")[1] ?? "")
      .split(",")[0]
      .trim()
      .replace(/:latest$/, "");
  }
  if (live?.usedRatio !== undefined) {
    // The guard's level (the kernel's, where it reports one) decides pauses.
    const lvl = live.guardLevel ?? live.level;
    return {
      memoryPercent: Math.round(live.usedRatio * 100),
      memoryLevel: lvl,
      memoryStatus: lvl === "critical" ? "fail" : lvl === "warning" ? "warn" : "pass",
      model,
      inferenceUp: inf ? inf.status !== "fail" : undefined,
    };
  }
  return {
    memoryPercent: Number.isFinite(pct) ? pct : undefined,
    memoryLevel: level,
    memoryStatus: mem?.status,
    model,
    inferenceUp: inf ? inf.status !== "fail" : undefined,
  };
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* ---------- Sidebar ---------- */

function renderSide() {
  const s = store.state;
  const side = document.getElementById("side");
  if (!side) return;
  const reviewCount = s.cards.filter((c) => c.status === "review").length;
  const needYou = s.cards.filter((c) => c.display?.needsYou).length;
  const runs = firstTryText(s.queue);
  const counts = {
    review: reviewCount
      ? { n: String(reviewCount) }
      : needYou
        ? { n: String(needYou), warn: true }
        : null,
    runs: runs ? { n: runs, long: true, title: `${runs} passed on the first try` } : null,
    playbook: s.playbook?.rules?.length
      ? {
          n: String(s.playbook.rules.length),
          title: `${s.playbook.rules.length} rules${s.playbook.candidates?.length ? `, ${s.playbook.candidates.length} suggested` : ""}`,
        }
      : null,
  };
  const openProposals = s.pm.messages.reduce(
    (n, m) => n + (m.proposals ?? []).filter((p) => p.state === "open").length,
    0,
  );
  if (s.pm.status?.phase && s.pm.status.phase !== "idle") {
    counts.pm = { n: "…", title: "Seshat is replying" };
  } else if (openProposals) {
    counts.pm = { n: String(openProposals), title: `${openProposals} open proposals` };
  }
  // Inbox: unread (§2.2.1), once the Inbox answered; the decisions waiting before it has.
  const unread = s.inbox?.at ? (s.inbox.unread ?? 0) : 0;
  const waiting = s.decisions.items?.length ?? 0;
  if (unread)
    counts.inbox = { n: String(unread), warn: true, title: `${unread} unread in your Inbox` };
  else if (!s.inbox?.at && waiting)
    counts.inbox = {
      n: String(waiting),
      warn: true,
      title: `${waiting} decision${waiting === 1 ? "" : "s"} waiting on you`,
    };
  const shown = currentNav();
  const link = (item) => {
    const c = counts[item.name];
    const cur = active === item.name ? ' aria-current="page"' : "";
    const badge = c
      ? `<span class="n tnum${c.warn ? " warn" : ""}${c.long ? " long" : ""}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.n)}${c.title ? `<span class="sr-only">, ${esc(c.title)}</span>` : ""}</span>`
      : "";
    const sub = item.sub ? `<span class="sub">${esc(item.sub)}</span>` : "";
    return `<a href="${item.route}"${cur} title="${esc(item.label)} (g ${item.chord})">${icon(item.icon)}<span class="lbl">${esc(item.label)}</span>${sub}${badge}</a>`;
  };
  const group = (g) =>
    shown
      .filter((i) => i.group === g)
      .map(link)
      .join("");
  const project = s.meta?.project ?? "";
  const more = group("more");
  const moreActive = shown.some((i) => i.group === "more" && i.name === active);
  const open = moreOpen ?? moreActive;
  const nav = `<div class="nav-group">${group("workspace")}</div><div class="nav-group">${project ? `<div class="nav-project"><span class="name">${esc(project)}</span>${s.meta?.repoPath ? `<span class="path mono">${esc(s.meta.repoPath)}</span>` : ""}</div>` : ""}${group("project")}</div>${more ? `<details class="nav-more" data-nav-more${open ? " open" : ""}><summary>${icon("chevron-right", 14, "ic s14")}More</summary><div class="nav-group">${more}</div></details>` : ""}`;
  const bottom = `<div class="nav-group">${group("bottom")}</div>`;
  renderTabs(shown);

  const v = s.verification;
  let live;
  if (v && v.valid === false) {
    live = `<a class="row alert" href="#/ledger">${icon("alert", 14, "ic s14")}<span class="lbl">Ledger altered at entry #${esc(v.corruptedSeq ?? "?")}</span></a>`;
  } else if (s.connection === "offline") {
    live = `<div class="row"><span class="dot fail"></span><span class="lbl">Offline since ${esc(clock(s.offlineSince || Date.now()))}</span></div>`;
  } else if (s.connection === "reconnecting" || s.connection === "connecting") {
    live = `<div class="row"><span class="dot warn"></span><span class="lbl">${s.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span></div>`;
  } else {
    // The whole line is visible text; the title repeats it for when it is cut.
    const text = `Live · ledger intact${v ? ` · ${v.totalEvents} ${v.totalEvents === 1 ? "entry" : "entries"}` : ""}`;
    live = `<div class="row" title="${esc(text)}"><span class="dot"></span><span class="lbl">${esc(text)}</span></div>`;
  }

  const m = machineStatus(s.doctor, s.machine);
  const memCls = m.memoryStatus === "fail" ? " fail" : m.memoryStatus === "warn" ? " warn" : "";
  const mem =
    m.memoryPercent !== undefined
      ? // The run guard acts on the pressure level, not the raw percentage (which
        // counts reclaimable cache), so the sidebar says the level, as Machine does.
        `<a class="row" href="#/machine" ${tip(`Memory pressure ${m.memoryLevel || "normal"}. ${m.memoryPercent}% used, including cache the system can reclaim.`)}><span class="dot${memCls}" aria-hidden="true"></span><span class="lbl">Memory ${esc(m.memoryLevel || "normal")}</span><span class="lbl sec tnum mem-pct">${m.memoryPercent}% used</span></a>`
      : `<div class="row">${icon("memory", 14, "ic s14")}<span class="lbl">Memory: checking…</span></div>`;
  // The Agent status line (§2.2.3, DB-N9-10): the Agent's state in one line,
  // with the Coding model it uses under it in secondary text.
  const running = s.cards
    .filter((c) => c.status === "in_progress")
    .map((c) => ({
      key: c.key ?? c.display?.shortId ?? c.id,
      step: c.display?.lastStep?.turn,
      budget: c.stepBudget,
    }));
  const paused = s.pm.status?.workerPaused && s.pm.status.phase !== "idle";
  const agent = agentStatusLine({
    running,
    ...(paused ? { pausedForSeshat: { step: s.pm.step } } : {}),
  });
  // The Coding model from Sekhemet's roster; the served-model probe is the fallback.
  const worker = (s.roster ?? s.machine?.roster ?? []).find((r) => r.role === "worker");
  const modelName = worker?.model
    ? `Coding model ${worker.model}`
    : m.model || (m.inferenceUp === false ? "No model server" : "Model: checking…");
  const dot = agent.state === "working" ? "run" : agent.state === "paused" ? "warn" : "idle";
  const model = `<div class="row agent-line" title="${esc(agent.text)}"><span class="dot ${dot}"></span><span class="lbl">${esc(agent.text)}</span></div><div class="row sub" title="${esc(modelName)}"><span class="lbl sec${m.model || worker?.model ? " mono" : ""}">${esc(modelName)}</span></div>`;
  // Theme and Keys live in the account menu (§2.2.6); the account closes the sidebar.
  const head = accountHeader(getSession());
  const account = `<button class="account-btn" type="button" data-account aria-haspopup="menu"><span class="avatar" aria-hidden="true">${esc(initials(head.name))}</span><span class="lbl">${esc(head.name)}</span><span class="sr-only">, ${esc(ACCOUNT_COPY.account)}</span></button>`;

  // Top to bottom (DB-N9-10): the brand and Search; the workspace and project
  // groups; at the foot the Agent status line (with live, ledger and memory
  // under it), Configuration and the account.
  const search = `<button class="side-search" type="button" data-palette aria-keyshortcuts="${MOD === "⌘" ? "Meta+K" : "Control+K"}">${icon("search", 14, "ic s14")}<span class="lbl">Search</span>${kbd(`${MOD}K`)}</button>`;
  const html = `<div class="brand">${brandLockup(18)}</div>${search}<div class="nav">${nav}</div><div class="foot">${model}${live}${mem}<div class="nav">${bottom}</div>${account}</div>`;
  if (html !== lastSide) {
    side.innerHTML = html;
    lastSide = html;
  }
}

/** The phone's bottom bar: Status · Review · Board · PM, of the views shown (DB-P11-3). */
function renderTabs(shown) {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  const html = bottomBar(shown)
    .map(
      (i) =>
        `<a href="${i.route}"${active === i.name ? ' aria-current="page"' : ""}>${icon(i.icon)}<span>${esc(i.short ?? i.label)}</span></a>`,
    )
    .join("");
  if (html !== lastTabs) {
    bar.innerHTML = html;
    lastTabs = html;
  }
}

/* ---------- Shell bars ---------- */

function memoryPausedCard(s) {
  return s.cards.find(
    (c) => c.status === "parked" && c.display?.evidence?.stopReason === "memory_pressure",
  );
}

function renderBar() {
  const s = store.state;
  const slot = document.getElementById("bar");
  if (!slot) return;
  let html = "";
  const v = s.verification;
  const m = machineStatus(s.doctor, s.machine);
  const pausedCard = memoryPausedCard(s);
  const lastQueue = s.queue?.entries?.at?.(-1);
  if (ledgerAltered(s)) {
    html = `<div class="bar fail" role="alert">${icon("alert")}<span><b>Ledger altered at entry #${esc(v.corruptedSeq ?? "?")}.</b> <span class="sec">An entry no longer matches its hash. Stop and inspect before accepting anything.</span></span><a class="link-btn" href="#/ledger">Open ledger</a></div>`;
  } else if (s.connection === "offline") {
    html = `<div class="bar offline" role="status">${icon("alert")}<span><b>Offline since ${esc(clock(s.offlineSince || Date.now()))}.</b> <span class="sec">Showing the last known state. Actions are disabled.</span></span><button class="link-btn" type="button" data-retry>Retry</button></div>`;
  } else if (
    (s.machine && m.memoryLevel === "critical") ||
    pausedCard ||
    (lastQueue?.stopReason === "memory_pressure" &&
      !["done", undefined].includes(store.card(lastQueue.cardId)?.status))
  ) {
    const sentence = pausedCard
      ? `Sekhemet stopped “${pausedCard.display.title}” safely${pausedCard.stepsUsed ? ` at step ${pausedCard.stepsUsed}` : ""}. It can resume below 85% memory.`
      : "Sekhemet stopped the agent safely before the system would swap. Work resumes below 85%.";
    const head = m.memoryPercent
      ? `Paused for memory: ${m.memoryPercent}% used.`
      : pausedCard
        ? "Paused for memory on 1 issue."
        : stopReasonLabel("memory_pressure").short;
    html = `<div class="bar" role="status">${icon("pause")}<span><b>${esc(head)}</b> <span class="sec">${esc(sentence)}</span></span><a class="link-btn" href="#/machine">Machine</a></div>`;
  } else if (s.backpressureActive) {
    const limit = s.wipLimits.review;
    const n = s.cards.filter((c) => c.status === "review").length;
    html = `<div class="bar" role="status">${icon("pause")}<span><b>Review is full (${n} of ${esc(limit)}).</b> <span class="sec">Finished issues will wait in Checking until you clear one.</span></span><a class="link-btn" href="#/review">Open review</a></div>`;
  } else if (s.pm.status?.workerPaused && s.pm.status.phase !== "idle") {
    // PM_DESIGN §2.5: nothing is wrong, so the running rule, not amber.
    const step = s.pm.step;
    const head = `Agent paused${step ? ` after step ${step}` : ""} while Seshat replies.`;
    const tail =
      s.pm.status.phase === "resuming_worker"
        ? "Reloading the agent now."
        : `It continues from ${step ? `step ${step + 1}` : "its next step"} when the reply is in.`;
    html = `<div class="bar run" role="status">${icon("pause")}<span><b>${esc(head)}</b> <span class="sec">${esc(tail)}</span></span>${s.route?.name === "pm" ? "" : '<button class="link-btn" type="button" data-open-pm>Open Seshat</button>'}</div>`;
  }
  if (html !== lastBar) {
    slot.innerHTML = html;
    lastBar = html;
  }
}

export function initShell() {
  renderSide();
  // System follows the operating system while the page is open.
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (currentThemeChoice() === "system") applyTheme();
  });
  store.on(() => {
    renderSide();
    renderBar();
  });
  // The More disclosure keeps the person's choice across re-renders.
  document.addEventListener(
    "toggle",
    (e) => {
      if (e.target instanceof Element && e.target.matches("[data-nav-more]")) {
        moreOpen = e.target.open;
      }
    },
    true,
  );
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-retry]") && !t.closest(".pm-thread"))
      window.dispatchEvent(new CustomEvent("sekhemet:retry"));
    else if (t.closest("[data-open-pm]")) window.dispatchEvent(new CustomEvent("sekhemet:open-pm"));
  });
}
