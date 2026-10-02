// Registry (U7): the models this machine knows, what each is qualified for, the
// measured tool arm and throughput, and the bake-off records that chose them.
import { $, esc, getJSON, icon } from "./dom.js";
import { setTopbar } from "./shell.js";

const ui = { root: null, data: null, status: 0, last: "" };

function pct(v) {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—";
}

/** Best decode speed across the measured context buckets. */
export function bestDecode(m) {
  const t = Object.values(m.throughput ?? {}).map((b) => b.decode);
  return t.length ? Math.max(...t) : undefined;
}

function modelsHtml(models) {
  if (models.length === 0)
    return `<p class="sec">No models registered yet. <code>sekhemet calibrate</code> and <code>sekhemet qualify</code> measure the models you run and record them here.</p>`;
  return `<div class="tbl-wrap" tabindex="0"><table class="tbl rg"><thead><tr><th>Model</th><th>Roles</th><th>Quant</th><th>Tool format</th><th class="num">Decode</th><th>Verified on this machine</th></tr></thead><tbody>${models
    .map((m) => {
      const q = m.qualification;
      const qual = q
        ? `<span class="rg-q ${q.status === "qualified" ? "pass" : "fail"}">${icon(q.status === "qualified" ? "check" : "x", 12, "ic s12")}${esc(q.status === "qualified" ? "Verified on this machine" : "Not verified on this machine")} · ${pct(q.passRate)}</span><span class="sec"> ${esc(q.suiteVersion)} · ${esc(String(q.date).slice(0, 10))}</span>`
        : '<span class="sec">Not verified on this machine</span>';
      const dec = bestDecode(m);
      return `<tr><td><b class="mono">${esc(m.id)}</b>${m.family ? `<span class="sec"> ${esc(m.family)}</span>` : ""}</td><td>${(m.roles ?? []).map((r) => `<span class="rg-role">${esc(r)}</span>`).join(" ") || '<span class="sec">—</span>'}</td><td class="mono">${esc(m.quant ?? "—")}</td><td class="mono">${esc(m.toolArm ?? "—")}</td><td class="num tnum">${dec !== undefined ? `${dec.toFixed(1)} tok/s` : "—"}</td><td>${qual}</td></tr>`;
    })
    .join("")}</tbody></table></div>`;
}

function bakeoffHtml(rows) {
  if (rows.length === 0)
    return '<p class="sec">No benchmark runs yet. A benchmark runs the models on the same task set and records every setting with the result.</p>';
  const sorted = [...rows].sort((a, b) => b.passAt1 - a.passAt1 || a.minutes - b.minutes);
  return `<div class="tbl-wrap" tabindex="0"><table class="tbl rg"><thead><tr><th>Model</th><th>Task set</th><th class="num">Passed first try</th><th class="num">Passed</th><th class="num">Minutes</th><th class="num">Tokens</th><th>Date</th></tr></thead><tbody>${sorted
    .map(
      (r) =>
        `<tr><td class="mono">${esc(r.candidate?.modelId ?? r.candidate?.id ?? "?")}${r.candidate?.quant ? `<span class="sec"> ${esc(r.candidate.quant)}</span>` : ""}</td><td>${esc(r.fixture)}</td><td class="num tnum">${pct(r.passAt1)}</td><td class="num tnum">${r.passed} of ${r.total}</td><td class="num tnum">${Number(r.minutes).toFixed(1)}</td><td class="num tnum">${Math.round(r.tokens / 1000)}k</td><td class="tnum">${esc(String(r.date).slice(0, 10))}</td></tr>`,
    )
    .join("")}</tbody></table></div>`;
}

function render() {
  if (!ui.root) return;
  const models = ui.data?.models ?? [];
  const bake = ui.data?.bakeoff ?? [];
  setTopbar({
    title: "Configuration",
    crumb: ui.data
      ? `Benchmark · ${models.length} models · ${bake.length} benchmark records`
      : "Benchmark",
  });
  let html;
  if (ui.status === 0) html = '<div class="sk" style="height:160px"></div>';
  else if (ui.status !== 200)
    html = `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't read the model list.</b> <span class="sec">The server returned ${esc(ui.status > 0 ? ui.status : "no response")}.</span></span></div>`;
  else
    html = `<section><h3 class="sh">Models <span class="sec">measured on this machine</span></h3>${modelsHtml(models)}</section><section><h3 class="sh">Benchmark runs <span class="sec">every model on the same task set, best first</span></h3>${bakeoffHtml(bake)}</section>`;
  if (html === ui.last) return;
  ui.last = html;
  $(".sc", ui.root).innerHTML = html;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = '<section class="sc rg-view" aria-label="Benchmark"></section>';
  view.append(root);
  ui.root = root;
  ui.last = "";
  render();
  getJSON("/api/registry")
    .then((r) => {
      ui.status = r.status;
      ui.data = r.ok ? r.data : null;
      render();
    })
    .catch(() => {
      ui.status = -1;
      render();
    });
  return {
    unmount() {
      root.remove();
      ui.root = null;
    },
  };
}
