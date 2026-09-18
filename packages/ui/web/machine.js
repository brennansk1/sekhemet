// Machine (FRONTEND_DESIGN §2.4.6): memory against its thresholds, the model
// server, health checks with fixes, the sandbox and the worktrees on disk.
import { $, esc, getJSON, icon } from "./dom.js";
import { ROSTER_STATE_LABELS, rosterRows } from "./lib/pm.js";
import { checkFixHint, shortId } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = {
  root: null,
  data: null,
  loading: false,
  error: null,
  last: "",
  roster: { status: 0, data: null },
};

const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

const LEVEL = {
  normal: {
    label: "Normal",
    tone: "pass",
    text: "Cards run normally. Sekhemet stops adding worktrees at 90% and pauses the Worker at 94%.",
  },
  warning: {
    label: "Warning",
    tone: "parked",
    text: "Above 85%: multi-token prediction is off, and above 90% no new worktree is created. Running cards continue.",
  },
  critical: {
    label: "Critical",
    tone: "fail",
    text: "Above 94%: the Worker is paused safely before the system would swap. Work resumes below 85%.",
  },
};

function memoryHtml(m) {
  if (!m) return '<div class="sk" style="height:96px"></div>';
  const pct = Math.round(m.usedRatio * 100);
  const guard = m.guardLevel ?? m.level;
  const lv = LEVEL[guard] ?? LEVEL.normal;
  const source =
    m.guardSource === "kernel" && guard !== m.level
      ? `<p class="sec mem-why">The system reports ${esc(guard)} pressure, and that is what the run guard acts on. The ${pct}% includes file cache the system can reclaim.</p>`
      : "";
  const t = m.thresholds ?? { warning: 0.85, throttle: 0.9, critical: 0.94 };
  const tick = (r, label, up = false) =>
    `<span class="tick${up ? " up" : ""}" style="left:${r * 100}%" title="${label}"><i></i><em class="tnum">${Math.round(r * 100)}%</em></span>`;
  const kernel = m.kernelLevel
    ? ({ 1: "normal", 2: "warning", 4: "critical" }[m.kernelLevel] ?? String(m.kernelLevel))
    : null;
  return `<section class="mc-card"><h3 class="sh">Memory <span class="sec">${esc(lv.label)}</span></h3><div class="mem-big"><span class="v tnum">${pct}%</span><span class="sec tnum">${esc(gb(m.usedBytes))} used of ${esc(gb(m.totalBytes))}</span></div><div class="gauge ${lv.tone}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Memory used"><span class="fill" style="width:${Math.min(100, pct)}%"></span>${tick(t.warning, "Warning")}${tick(t.throttle, "No new worktrees", true)}${tick(t.critical, "Pause the Worker")}</div><p class="sec mem-why">${esc(lv.text)}</p>${source}<dl class="kv"><dt>Swap in use</dt><dd class="tnum">${m.swapUsedBytes !== undefined ? esc(gb(m.swapUsedBytes)) : '<span class="sec">Not readable here</span>'}</dd>${kernel ? `<dt>System pressure</dt><dd>${esc(kernel)}</dd>` : ""}<dt>Keep-alive now</dt><dd class="mono">${esc(m.recommendedKeepAlive)}</dd></dl></section>`;
}

function modelHtml(d) {
  const models = d?.models;
  if (!models) return '<div class="sk" style="height:96px"></div>';
  const list = models.served.length
    ? `<ul class="plain">${models.served.map((m) => `<li><span class="mono">${esc(m)}</span></li>`).join("")}</ul>`
    : '<p class="sec">No model is being served.</p>';
  const working = store.state.cards.some((c) => c.status === "in_progress");
  return `<section class="mc-card"><h3 class="sh">Model <span class="sec">${models.reachable ? (working ? "Worker running" : "idle") : "server unreachable"}</span></h3><dl class="kv"><dt>Endpoint</dt><dd class="mono">${esc(models.endpoint ?? "—")}</dd><dt>Status</dt><dd>${models.reachable ? `${icon("check", 14, "ic s14 i-pass")} reachable` : `${icon("x", 14, "ic s14 i-fail")} not reachable`}</dd></dl><h4 class="sub">Models on the server</h4>${list}</section>`;
}

/** The four-model roster (GET /api/models): who does what, and what is loaded. */
function rosterHtml() {
  const r = ui.roster;
  const head = (sub) => `<h3 class="sh">Models <span class="sec">${esc(sub)}</span></h3>`;
  if (r.status === 0)
    return `<section>${head("")}<div class="sk" style="height:120px"></div></section>`;
  if (r.status !== 200 || !r.data) {
    const why =
      r.status === 404
        ? "<b>The model roster isn't on this server yet.</b> <code>GET /api/models</code> returned 404. It will list the Worker, Seshat, the adversarial reviewer and the Researcher, and which of them is loaded."
        : `<b>Couldn't read the model roster.</b> The server returned ${esc(r.status > 0 ? r.status : "no response")}.`;
    return `<section>${head("Worker, Seshat, reviewer, Researcher")}<p class="roster-empty">${icon("machine", 14, "ic s14")}<span>${why}</span></p></section>`;
  }
  const rows = rosterRows(r.data.roles);
  const resident = rows.filter((x) => x.state === "resident").length;
  // A note every role shares ("No run in progress") is said once, not four times.
  const notes = new Set(rows.map((x) => x.note ?? ""));
  const shared = notes.size === 1 && rows[0]?.note ? rows[0].note : "";
  const items = rows
    .map((x) => {
      const dot =
        x.state === "resident"
          ? '<span class="dot" aria-hidden="true"></span>'
          : x.state === "swapped"
            ? '<span class="dot idle" aria-hidden="true"></span>'
            : '<span class="dot off" aria-hidden="true"></span>';
      return `<li class="rrow ${esc(x.state)}"><div class="rl"><b>${esc(x.label)}</b><span class="mono">${x.model ? esc(x.model) : "—"}</span></div><div class="rs">${dot}<span>${esc(ROSTER_STATE_LABELS[x.state] ?? x.state)}</span></div><p class="rd">${esc(x.does)}</p>${x.note && !shared ? `<p class="rn">${esc(x.note)}</p>` : ""}</li>`;
    })
    .join("");
  const mem = r.data.coResident
    ? "This machine has room for all four at once, so nothing swaps."
    : "One model is resident at a time on this machine; Sekhemet swaps them as the work needs (about 40 seconds each). With 128 GB, all four stay loaded.";
  return `<section>${head(`${resident} of ${rows.length} resident`)}<ul class="roster">${items}</ul><p class="sec roster-note">${icon("memory", 12, "ic s12")}<span>${esc(shared ? `${shared}. ${mem}` : mem)}</span></p></section>`;
}

const ICON = { pass: ["check", "i-pass"], warn: ["alert", "i-park"], fail: ["x", "i-fail"] };

function checksHtml(d) {
  if (!d) return '<div class="sk" style="height:160px"></div>';
  const rows = d.checks
    .map((c) => {
      const [ic, cls] = ICON[c.status] ?? ICON.warn;
      const fix = checkFixHint(c.name, c.status, c.detail);
      return `<li class="chk ${esc(c.status)}">${icon(ic, 16, `ic ${cls}`)}<div><div class="nm">${esc(c.name)}</div><div class="dt">${esc(c.detail)}</div>${fix ? `<div class="fix">${icon("pencil", 12, "ic s12")}${esc(fix)}</div>` : ""}</div></li>`;
    })
    .join("");
  const failing = d.checks.filter((c) => c.status !== "pass").length;
  const at = d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString([], { hourCycle: "h23" }) : "";
  return `<section><h3 class="sh">Health checks <span class="sec">${failing ? `${failing} need attention` : "all passing"}${at ? ` · checked ${esc(at)}` : ""}</span><button class="btn sm" type="button" data-rerun ${ui.loading ? "disabled" : ""}>${icon("refresh", 14, "ic s14")}${ui.loading ? "Checking…" : "Re-run checks"}</button></h3><ul class="checks">${rows}</ul></section>`;
}

function sandboxHtml(d) {
  if (!d) return "";
  const sb = d.checks.find((c) => c.name === "Sandbox confinement");
  const trees = d.worktrees ?? [];
  const treeList = trees.length
    ? `<ul class="plain">${trees
        .map((id) => {
          const c = store.card(id);
          return `<li><a href="#/card/${encodeURIComponent(id)}/steps">${esc(c?.display?.title ?? shortId(id))}</a> <span class="mono sec">${esc(id)}</span></li>`;
        })
        .join("")}</ul>`
    : '<p class="sec">No worktrees. Each running card gets its own under .sekhemet/worktrees.</p>';
  return `<div class="two"><section class="mc-card"><h3 class="sh">Sandbox</h3><p>${sb ? esc(sb.detail) : "Unknown"}</p></section><section class="mc-card"><h3 class="sh">Worktrees <span class="sec">${trees.length}</span></h3>${treeList}</section></div>`;
}

function render() {
  if (!ui.root) return;
  const d = ui.data;
  const mem = store.state.machine ?? d?.memory;
  const lv = mem ? (LEVEL[mem.guardLevel ?? mem.level] ?? LEVEL.normal).label : "";
  setTopbar({
    title: "Machine",
    crumb: `${store.state.meta?.project ?? ""}${mem ? ` · memory ${Math.round(mem.usedRatio * 100)}%, ${lv.toLowerCase()}` : ""}`,
  });
  const err = ui.error
    ? `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't read the machine.</b> <span class="sec">The server returned ${esc(ui.error)}.</span></span><button class="btn sm" type="button" data-rerun>Retry</button></div>`
    : "";
  const html = `${err}<div class="two">${memoryHtml(mem)}${modelHtml(d)}</div>${rosterHtml()}${checksHtml(d)}${sandboxHtml(d)}`;
  if (html === ui.last) return;
  ui.last = html;
  const body = $(".mc", ui.root);
  const top = body.scrollTop;
  const focusRerun = document.activeElement?.hasAttribute?.("data-rerun");
  body.innerHTML = html;
  body.scrollTop = top;
  if (focusRerun) $("[data-rerun]", body)?.focus();
}

async function loadRoster() {
  try {
    const r = await getJSON("/api/models");
    ui.roster = { status: r.status, data: r.ok ? r.data : null };
  } catch {
    ui.roster = { status: -1, data: null };
  }
  render();
}

async function load(fresh = false) {
  ui.loading = true;
  render();
  loadRoster();
  const res = await getJSON(`/api/machine${fresh ? "?fresh=1" : ""}`);
  ui.loading = false;
  if (!ui.root) return;
  if (res.ok) {
    ui.data = res.data;
    ui.error = null;
  } else ui.error = res.status || "no response";
  render();
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = '<section class="sc mc" aria-label="Machine"></section>';
  view.append(root);
  ui.root = root;
  ui.last = "";
  root.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-rerun]")) load(true);
  });
  const unsub = store.on((_s, patch) => {
    if ("machine" in patch || "cards" in patch) render();
  });
  render();
  load();
  return {
    setParams() {},
    onKey(e) {
      if (e.key === "R" || (e.key === "r" && e.shiftKey)) {
        load(true);
        return true;
      }
      return false;
    },
    unmount() {
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}
