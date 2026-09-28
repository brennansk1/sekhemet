// Runs (FRONTEND_DESIGN §2.4.4): "Did the last unattended run go well, and is
// it better than the one before?" A list of runs, and one run's scorecard.
import { $, esc, getJSON, icon } from "./dom.js";
import {
  formatDuration,
  formatTokens,
  parseTitle,
  shortId,
  stopReasonLabel,
  summarizeRun,
} from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = {
  root: null,
  runs: null,
  id: null,
  run: null,
  prev: null,
  sort: { key: "order", dir: 1 },
  seq: 0,
};

function when(iso, withYear = false) {
  const d = new Date(iso);
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function titleOf(id) {
  const c = store.card(id);
  return c?.display?.title ?? (c ? parseTitle(c.title).title : shortId(id));
}

function listHtml() {
  if (!ui.runs) return '<div class="sk sk-line" style="margin:12px 16px;width:70%"></div>';
  const rows = ui.runs
    .map(
      (r) =>
        `<button class="rn" type="button" role="option" data-run="${esc(r.id)}" aria-selected="${r.id === ui.id}"><div class="a"><span>${esc(when(r.startedAt))}</span><span class="tnum">${r.firstTry} of ${r.cards}</span></div><div class="b"><span class="mono">${esc(r.model.replace(/:latest$/, ""))}</span><span class="tnum">${esc(formatDuration(r.totalDurationMs))}</span></div></button>`,
    )
    .join("");
  const hint =
    ui.runs.length < 2
      ? '<p class="hint">Every <span class="mono">sekhemet queue</span> run is kept here, so you can compare it with the next.</p>'
      : "";
  return `<div role="listbox" aria-label="Runs">${rows}</div>${hint}`;
}

function delta(cur, prev, { unit = "", better = "up", fmt = (n) => String(n) } = {}) {
  if (prev === undefined || prev === null) return "";
  const d = cur - prev;
  if (d === 0) return '<span class="sec">same as the run before</span>';
  const good = better === "up" ? d > 0 : d < 0;
  const sign = d > 0 ? "+" : "−";
  return `<span class="${good ? "up" : "down"}">${icon("arrow-down", 10, `ic s10${d > 0 ? " flip" : ""}`)}${sign}${esc(fmt(Math.abs(d)))}${unit}</span> <span class="sec">vs the run before</span>`;
}

function numsHtml(run, s, prevS) {
  const retryNote = run.managerModel
    ? `${s.passedAfterRetry} of ${s.retried} retried`
    : "No Planning model was set";
  return `<div class="nums"><div class="num"><div class="k">Passed on the first try</div><div class="v">${s.firstTry} <small>of ${s.cards}</small></div><div class="d">${s.cards ? Math.round((s.firstTry / s.cards) * 100) : 0}% · <span class="mono">pass@1 ${(s.cards ? s.firstTry / s.cards : 0).toFixed(2)}</span></div><div class="d">${delta(
    s.cards ? Math.round((s.firstTry / s.cards) * 100) : 0,
    prevS ? (prevS.cards ? Math.round((prevS.firstTry / prevS.cards) * 100) : 0) : undefined,
    { unit: " pts" },
  )}</div></div><div class="num"><div class="k">Passed after a Planning model retry</div><div class="v">${s.passedAfterRetry} <small>of ${s.retried}</small></div><div class="d">${esc(retryNote)}</div></div><div class="num"><div class="k">Total time</div><div class="v">${esc(formatDuration(s.totalMs))}</div><div class="d">${s.failedMs ? `Failed cards used ${esc(formatDuration(s.failedMs))} (${Math.round((s.failedMs / Math.max(1, s.totalMs)) * 100)}%)` : "No time lost to failures"}</div><div class="d">${delta(s.totalMs, prevS?.totalMs, { better: "down", fmt: formatDuration })}</div></div><div class="num"><div class="k">Tokens</div><div class="v">${esc(formatTokens(s.promptTokens))} <small>in</small></div><div class="d">${esc(formatTokens(s.completionTokens))} out · ${s.tokensPerSecond.toFixed(1)} tok/s overall</div></div></div>`;
}

function timelineHtml(run, s) {
  if (!s.segments.length) return "";
  const segs = s.segments
    .map((g) => {
      const label = `${titleOf(g.cardId)} · ${formatDuration(g.ms)} · ${g.label}`;
      const pct = (g.share * 100).toFixed(2);
      return `<div class="seg ${g.tone}" style="flex:0 0 ${pct}%" title="${esc(label)}">${g.share > 0.06 ? esc(shortId(g.cardId)) : ""}</div>`;
    })
    .join("");
  const gap =
    s.overheadShare > 0.001
      ? `<div class="seg gap" style="flex:1" title="Harness overhead · ${esc(formatDuration(s.overheadShare * s.totalMs))}"></div>`
      : "";
  const start = Date.parse(run.startedAt);
  const ticks = 5;
  const axis = Array.from({ length: ticks + 1 }, (_, i) => {
    if (i === 0) return new Date(start).toLocaleTimeString([], { hourCycle: "h23" });
    if (i === ticks)
      return new Date(start + s.totalMs).toLocaleTimeString([], { hourCycle: "h23" });
    return `+${formatDuration((s.totalMs * i) / ticks)}`;
  })
    .map((t) => `<span>${esc(t)}</span>`)
    .join("");
  const aria = s.segments
    .map((g) => `${shortId(g.cardId)} ${g.label.toLowerCase()} ${formatDuration(g.ms)}`)
    .join(", ");
  return `<section><h3 class="sh">Timeline <span class="sec">cards ran one after another; width is time</span></h3><div class="tl" role="img" aria-label="Timeline: ${esc(aria)}">${segs}${gap}</div><div class="axis">${axis}</div><div class="legend"><span><i class="sw pass"></i>Passed</span><span><i class="sw fail"></i>Failed</span><span><i class="sw parked"></i>Paused</span></div></section>`;
}

const COLS = [
  ["title", "Card", ""],
  ["attempt", "Attempt", ""],
  ["result", "Result", ""],
  ["stop", "Why it stopped", ""],
  ["turns", "Steps", "r"],
  ["durationMs", "Time", "r"],
  ["tokens", "Tokens in · out", "r"],
  ["accepted", "Main", ""],
];

function tableHtml(run) {
  const rows = run.entries.map((e, i) => ({
    ...e,
    order: i,
    title: titleOf(e.cardId),
    tokens: e.promptTokens + e.completionTokens,
    stop: stopReasonLabel(e.stopReason).short,
    result: e.passed ? 0 : stopReasonLabel(e.stopReason).tone === "parked" ? 1 : 2,
  }));
  const { key, dir } = ui.sort;
  rows.sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * dir);
  const head = COLS.map(([k, label, cls]) => {
    const sorted = key === k ? (dir > 0 ? "ascending" : "descending") : "none";
    return `<th class="${cls}" aria-sort="${sorted}"><button type="button" data-sort="${k}">${esc(label)}${key === k ? icon("chevron-down", 10, `ic s10${dir > 0 ? " flip" : ""}`) : ""}</button></th>`;
  }).join("");
  const body = rows
    .map((e) => {
      const res = e.passed
        ? `<span class="res">${icon("check", 14, "ic s14 i-pass")}Passed</span>`
        : e.result === 1
          ? `<span class="res">${icon("pause", 14, "ic s14 i-park")}Paused</span>`
          : `<span class="res">${icon("x", 14, "ic s14 i-fail")}Failed</span>`;
      const main = e.accepted
        ? `<span class="res">${icon("merge", 14, "ic s14")}Merged</span>`
        : '<span class="sec">—</span>';
      return `<tr><td><a class="t" href="#/card/${encodeURIComponent(e.cardId)}/steps">${esc(e.title)}</a><span class="id">${esc(shortId(e.cardId))}</span></td><td class="tnum">${esc(e.attempt ?? 1)}</td><td>${res}</td><td title="${esc(stopReasonLabel(e.stopReason).sentence)}">${esc(e.stop)}</td><td class="r">${esc(e.turns)}</td><td class="r">${esc(formatDuration(e.durationMs))}</td><td class="r">${esc(formatTokens(e.promptTokens))} · ${esc(formatTokens(e.completionTokens))}</td><td>${main}</td></tr>`;
    })
    .join("");
  return `<section><h3 class="sh">Cards</h3><div class="tbl-wrap"><table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function stopsHtml(s) {
  const total = s.stops.reduce((n, x) => n + x.count, 0) || 1;
  const bars = s.stops
    .map(
      (x) =>
        `<div class="bar-r"><span>${esc(x.label)}</span><span class="trk"><i class="${x.tone === "pass" ? "pass" : x.tone === "parked" ? "parked" : "fail"}" style="width:${((x.count / total) * 100).toFixed(1)}%"></i></span><span class="n tnum">${x.count}</span></div>`,
    )
    .join("");
  return `<section><h3 class="sh">Why cards stopped</h3><div class="bars">${bars}</div></section>`;
}

function observations(run, s) {
  const out = [];
  const pass = run.entries.filter((e) => e.passed);
  const fail = run.entries.filter((e) => !e.passed);
  const range = (list) => {
    const t = list.map((e) => e.turns);
    const lo = Math.min(...t);
    const hi = Math.max(...t);
    return lo === hi ? `${lo}` : `${lo} to ${hi}`;
  };
  if (pass.length && fail.length) {
    out.push([
      "check",
      `Passing cards took ${range(pass)} steps. Failing cards took ${range(fail)}.`,
    ]);
  } else if (pass.length) {
    out.push(["check", `Every card passed, in ${range(pass)} steps.`]);
  } else if (fail.length) {
    out.push(["x", `No card passed. They stopped after ${range(fail)} steps.`]);
  }
  if (pass.length > 1) {
    const slow = [...pass].sort((a, b) => b.durationMs - a.durationMs)[0];
    const rest = pass.filter((e) => e !== slow).map((e) => e.durationMs);
    if (slow.durationMs > 3 * Math.max(...rest)) {
      out.push([
        "clock",
        `<b>${esc(titleOf(slow.cardId))}</b> took ${esc(formatDuration(slow.durationMs))} for ${slow.turns} steps; the other passing cards took ${esc(formatDuration(Math.min(...rest)))} to ${esc(formatDuration(Math.max(...rest)))}.`,
      ]);
    }
  }
  const paused = run.entries.find((e) => e.stopReason === "memory_pressure");
  if (paused)
    out.push([
      "pause",
      `<b>${esc(titleOf(paused.cardId))}</b> stopped safely at step ${paused.turns}, and the queue halted. It can resume.`,
    ]);
  const ids = new Set(run.entries.map((e) => e.cardId));
  const rules = (store.state.playbook?.rules ?? []).filter(
    (r) => r.originCard && ids.has(r.originCard),
  );
  if (rules.length) {
    out.push([
      "playbook",
      `Playbook rules ${rules.map((r) => `<a class="mono" href="#/playbook">${esc(r.id)}</a>`).join(", ")} were learned from cards in this run.`,
    ]);
  }
  if (!out.length) return "";
  return `<section><h3 class="sh">What the numbers show</h3><ul class="obs">${out.map(([i, t]) => `<li>${icon(i, 14, "ic s14")}<span>${t}</span></li>`).join("")}</ul></section>`;
}

function settingsHtml(run) {
  return `<section><h3 class="sh">Run settings</h3><dl class="kv"><dt>Coding model</dt><dd class="mono">${esc(run.model)}</dd><dt>Planning model</dt><dd>${run.managerModel ? `<span class="mono">${esc(run.managerModel)}</span>` : '<span class="sec">None: failed cards were not retried</span>'}</dd><dt>Model swaps</dt><dd class="tnum">${run.modelSwaps ?? '<span class="sec">Not recorded</span>'}</dd><dt>Started</dt><dd class="tnum">${esc(when(run.startedAt, true))}</dd><dt>Report</dt><dd class="mono">${esc(run.id === "latest" ? ".sekhemet/queue_report.json" : `.sekhemet/runs/${run.id}.json`)}</dd></dl></section>`;
}

function scoreHtml() {
  const sc = $(".sc", ui.root);
  if (!sc) return;
  if (ui.runs && ui.runs.length === 0) {
    sc.innerHTML = `<div class="ev-empty">${icon("runs", 24, "ic s24")}<b>No runs yet.</b><span>Run every Ready card unattended: <code>sekhemet queue --auto-accept</code></span></div>`;
    return;
  }
  const run = ui.run;
  if (!run) {
    sc.innerHTML =
      '<div class="sk sk-line" style="width:40%"></div><div class="sk" style="height:84px"></div><div class="sk" style="height:28px"></div>';
    return;
  }
  const s = summarizeRun(run);
  const prevS = ui.prev ? summarizeRun(ui.prev) : null;
  const merged = run.entries.some((e) => e.accepted);
  const sub = `${s.cards} Ready ${s.cards === 1 ? "card" : "cards"} on <span class="mono">${esc(run.model)}</span> · ${run.managerModel ? `Planning model <span class="mono">${esc(run.managerModel)}</span> retried failures` : "no Planning model retry configured"}${merged ? " · passing cards merged automatically" : ""}`;
  const top = sc.scrollTop;
  sc.innerHTML = `<div class="sc-h"><h2>Run of ${esc(when(run.startedAt))}</h2><p>${sub}</p></div>${numsHtml(run, s, prevS)}${timelineHtml(run, s)}${tableHtml(run)}<div class="two">${stopsHtml(s)}${observations(run, s)}</div>${settingsHtml(run)}`;
  sc.scrollTop = top;
}

async function selectRun(id, { replace = true } = {}) {
  ui.id = id;
  const seq = ++ui.seq;
  $(".runs", ui.root).innerHTML = listHtml();
  ui.run = null;
  scoreHtml();
  const i = ui.runs.findIndex((r) => r.id === id);
  const prevId = ui.runs[i + 1]?.id;
  const [cur, prev] = await Promise.all([
    getJSON(`/api/runs/${encodeURIComponent(id)}`),
    prevId ? getJSON(`/api/runs/${encodeURIComponent(prevId)}`) : Promise.resolve(null),
  ]);
  if (seq !== ui.seq || !ui.root) return;
  ui.run = cur.ok ? cur.data : null;
  ui.prev = prev?.ok ? prev.data : null;
  if (replace) history.replaceState(null, "", `#/runs/${encodeURIComponent(id)}`);
  scoreHtml();
}

async function loadRuns(wanted) {
  const res = await getJSON("/api/runs");
  if (!ui.root) return;
  ui.runs = res.ok ? res.data.runs : [];
  const r0 = ui.runs[0];
  const crumb = `${store.state.meta?.project ?? ""} · ${ui.runs.length} unattended ${ui.runs.length === 1 ? "run" : "runs"}`;
  setTopbar({ title: "Runs", crumb });
  $(".runs", ui.root).innerHTML = listHtml();
  if (!r0) return scoreHtml();
  selectRun(wanted && ui.runs.some((r) => r.id === wanted) ? wanted : r0.id);
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML =
    '<div class="wrap"><nav class="runs" aria-label="Runs"></nav><section class="sc" aria-label="Scorecard"></section></div>';
  view.append(root);
  ui.root = root;
  ui.runs = null;
  ui.run = null;
  setTopbar({ title: "Runs", crumb: store.state.meta?.project ?? "" });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const rn = t?.closest("[data-run]");
    if (rn) return selectRun(rn.dataset.run);
    const th = t?.closest("[data-sort]");
    if (th) {
      const k = th.dataset.sort;
      ui.sort = { key: k, dir: ui.sort.key === k ? -ui.sort.dir : 1 };
      scoreHtml();
    }
  });
  scoreHtml();
  loadRuns(route.params?.[0]);
  const unsub = store.on((_s, patch) => {
    if (
      "cards" in patch &&
      (store.state.feed ?? []).some((e) => e.type === "card/status_changed")
    ) {
      // A queue that just finished writes a new report; pick it up.
      if (ui.runs)
        getJSON("/api/runs").then((r) => {
          if (r.ok && ui.root && r.data.runs.length !== ui.runs.length) loadRuns(ui.id);
        });
    }
  });
  return {
    setParams(params) {
      if (params?.[0] && params[0] !== ui.id && ui.runs) selectRun(params[0], { replace: false });
    },
    onKey(e) {
      if (!ui.runs?.length || (e.key !== "j" && e.key !== "k")) return false;
      const i = ui.runs.findIndex((r) => r.id === ui.id);
      const next = ui.runs[Math.max(0, Math.min(ui.runs.length - 1, i + (e.key === "j" ? 1 : -1)))];
      if (next && next.id !== ui.id) selectRun(next.id);
      return true;
    },
    unmount() {
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}
