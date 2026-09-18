// Sidebar, topbar and the four shell bars (FRONTEND_DESIGN §2.2, §2.4).
import { MOD, esc, icon, kbd } from "./dom.js";
import { stopReasonLabel } from "./lib/vocabulary.js";
import { ledgerAltered, store } from "./store.js";

const NAV = [
  { name: "review", label: "Review", icon: "review", key: "g r" },
  { name: "board", label: "Board", icon: "board", key: "g b" },
  { name: "pm", label: "Merit", icon: "chat", key: "g a", title: "Merit, project manager" },
  { name: "insights", label: "Insights", icon: "insights", key: "g f" },
  { name: "runs", label: "Runs", icon: "runs", key: "g q" },
  { name: "ledger", label: "Ledger", icon: "ledger", key: "g l" },
  { name: "playbook", label: "Playbook", icon: "playbook", key: "g p" },
  { name: "machine", label: "Machine", icon: "machine", key: "g m" },
  { name: "integrations", label: "Integrations", icon: "plug", key: "g s" },
];

let active = "";
let lastSide = "";
let lastBar = "";

export function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === "sand" ? "basalt" : "sand";
  root.dataset.theme = next;
  try {
    localStorage.setItem("sekhemet-theme", next);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  renderSide();
}

export function setActiveNav(name) {
  active = name;
  renderSide();
}

/** The topbar belongs to the view: title, a quiet crumb, filters. Search is always on the right. */
export function setTopbar({ title, crumb = "", filters = "" }) {
  const top = document.getElementById("top");
  const html = `<h1 id="view-title">${esc(title)}</h1>${crumb ? `<span class="crumb">${esc(crumb)}</span>` : ""}${filters}<div class="right"><button class="search" type="button" data-palette title="Search or run a command (${MOD}K)">${icon("search", 14, "ic s14")}<span class="lbl">Search or run a command</span>${kbd(`${MOD}K`)}</button></div>`;
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
    counts.pm = { n: "…", title: "Merit is replying" };
  } else if (openProposals) {
    counts.pm = { n: String(openProposals), title: `${openProposals} open proposals` };
  }
  const nav = NAV.map((item) => {
    const c = counts[item.name];
    const cur = active === item.name ? ' aria-current="page"' : "";
    const badge = c
      ? `<span class="n tnum${c.warn ? " warn" : ""}${c.long ? " long" : ""}"${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.n)}</span>`
      : "";
    return `<a href="#/${item.name}"${cur} title="${esc(item.title ?? item.label)} (${item.key})">${icon(item.icon)}<span class="lbl">${esc(item.label)}</span>${badge}</a>`;
  }).join("");

  const v = s.verification;
  let live;
  if (v && v.valid === false) {
    live = `<a class="row alert" href="#/ledger">${icon("alert", 14, "ic s14")}<span class="lbl">Ledger altered at entry #${esc(v.corruptedSeq ?? "?")}</span></a>`;
  } else if (s.connection === "offline") {
    live = `<div class="row"><span class="dot fail"></span><span class="lbl">Offline since ${esc(clock(s.offlineSince || Date.now()))}</span></div>`;
  } else if (s.connection === "reconnecting" || s.connection === "connecting") {
    live = `<div class="row"><span class="dot warn"></span><span class="lbl">${s.connection === "connecting" ? "Connecting…" : "Reconnecting…"}</span></div>`;
  } else {
    const n = v ? ` · ${v.totalEvents}` : "";
    live = `<div class="row" title="Live. Ledger intact${v ? `, ${v.totalEvents} entries` : ""}"><span class="dot"></span><span class="lbl">Live · ledger intact${n}</span></div>`;
  }

  const m = machineStatus(s.doctor, s.machine);
  const memCls = m.memoryStatus === "fail" ? " fail" : m.memoryStatus === "warn" ? " warn" : "";
  const mem =
    m.memoryPercent !== undefined
      ? `<div class="row" title="Memory ${m.memoryPercent}% used${m.memoryLevel ? `, ${m.memoryLevel}` : ""}">${icon("memory", 14, "ic s14")}<span class="lbl tnum">Memory ${m.memoryPercent}%</span><span class="meter${memCls}"><i style="width:${Math.min(100, m.memoryPercent)}%"></i></span></div>`
      : `<div class="row">${icon("memory", 14, "ic s14")}<span class="lbl">Memory: checking…</span></div>`;
  const working = s.cards.some((c) => c.status === "in_progress");
  const modelName = m.model || (m.inferenceUp === false ? "No model server" : "Model: checking…");
  const model = `<div class="row" title="${esc(modelName)}"><span class="dot ${working ? "run" : "idle"}"></span><span class="lbl${m.model ? " mono" : ""}">${esc(modelName)}${m.model ? ` · ${working ? "working" : "idle"}` : ""}</span></div>`;
  const sand = document.documentElement.dataset.theme === "sand";
  const tools = `<div class="tools"><button class="icon-btn" type="button" data-theme-toggle title="Theme (t)">${icon(sand ? "moon" : "sun", 14, "ic s14")}<span class="lbl">Theme</span></button><button class="icon-btn" type="button" data-cheats title="Keyboard shortcuts (?)">${icon("keyboard", 14, "ic s14")}<span class="lbl">Keys</span></button></div>`;

  const project = s.meta?.project ?? "";
  const html = `<div class="brand">${icon("glyph", 18)}<b class="lbl">Sekhemet</b>${kbd(`${MOD}K`)}</div>${project ? `<div class="project" title="${esc(s.meta?.repoPath ?? "")}"><span>Project</span><b>${esc(project)}</b></div>` : ""}<div class="nav">${nav}</div><div class="foot">${live}${mem}${model}${tools}</div>`;
  if (html !== lastSide) {
    side.innerHTML = html;
    lastSide = html;
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
      : "Sekhemet stopped the Worker safely before the system would swap. Work resumes below 85%.";
    const head = m.memoryPercent
      ? `Paused for memory: ${m.memoryPercent}% used.`
      : pausedCard
        ? "Paused for memory on 1 card."
        : stopReasonLabel("memory_pressure").short;
    html = `<div class="bar" role="status">${icon("pause")}<span><b>${esc(head)}</b> <span class="sec">${esc(sentence)}</span></span><a class="link-btn" href="#/machine">Machine</a></div>`;
  } else if (s.backpressureActive) {
    const limit = s.wipLimits.review;
    const n = s.cards.filter((c) => c.status === "review").length;
    html = `<div class="bar" role="status">${icon("pause")}<span><b>Review is full (${n} of ${esc(limit)}).</b> <span class="sec">Finished cards will wait in Checking until you clear one.</span></span><a class="link-btn" href="#/review">Open review</a></div>`;
  } else if (s.pm.status?.workerPaused && s.pm.status.phase !== "idle") {
    // PM_DESIGN §2.5: nothing is wrong, so the running rule, not amber.
    const step = s.pm.step;
    const head = `Worker paused${step ? ` after step ${step}` : ""} while Merit replies.`;
    const tail =
      s.pm.status.phase === "resuming_worker"
        ? "Reloading the Worker now."
        : `It continues from ${step ? `step ${step + 1}` : "its next step"} when the reply is in.`;
    html = `<div class="bar run" role="status">${icon("pause")}<span><b>${esc(head)}</b> <span class="sec">${esc(tail)}</span></span>${s.route?.name === "pm" ? "" : '<button class="link-btn" type="button" data-open-pm>Open Merit</button>'}</div>`;
  }
  if (html !== lastBar) {
    slot.innerHTML = html;
    lastBar = html;
  }
}

export function initShell() {
  renderSide();
  store.on(() => {
    renderSide();
    renderBar();
  });
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-theme-toggle]")) toggleTheme();
    else if (t.closest("[data-retry]") && !t.closest(".pm-thread"))
      window.dispatchEvent(new CustomEvent("sekhemet:retry"));
    else if (t.closest("[data-open-pm]")) window.dispatchEvent(new CustomEvent("sekhemet:open-pm"));
  });
}
