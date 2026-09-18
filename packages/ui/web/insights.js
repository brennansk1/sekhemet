// Insights (PM_DESIGN §3.6): flow metrics from /api/metrics/flow. Aging WIP,
// cycle time, throughput and cumulative flow, each answering one question.
// SVG coloured only through token classes; every chart has a text summary
// and a data table.
import { esc, getJSON, icon } from "./dom.js";
import {
  CFD_KEYS,
  agingClass,
  cycleTimeStats,
  formatHours,
  formatShortDate,
  movingAverage,
  stackCfd,
} from "./lib/pm.js";
import { columnLabel } from "./lib/vocabulary.js";
import { openPeek } from "./peek.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = { root: null, days: 30, data: null, status: 0, loading: false };
const AGING_COLS = ["ready", "planning", "in_progress", "verify", "review", "parked"];
const CFD_LABEL = {
  backlog: "Backlog",
  ready: "Ready",
  working: "Working",
  checking: "Checking",
  review: "Review",
  done: "Done",
};

/** Drawn 1:1 at the panel's real width, so text is never scaled. */
let W = 560;
const H = 240;
const M = { l: 44, r: 56, t: 12, b: 28 };

/** A 1-2-2.5-5 step so ticks land on round numbers. */
function niceStep(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** The axis top: a whole number of nice steps at or above `v`. */
function niceMax(v, ticks = 4, integer = false) {
  let step = niceStep((v || 1) / ticks);
  if (integer) step = Math.max(1, Math.ceil(step));
  return Math.ceil((v || 1) / step) * step;
}

function yAxis(max, fmt, ticks = 4, integer = false) {
  let step = niceStep(max / ticks);
  if (integer) step = Math.max(1, Math.ceil(step));
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) {
    const y = M.t + (H - M.t - M.b) * (1 - v / max);
    out.push(
      `<text class="ax" x="${M.l - 8}" y="${y + 3.5}" text-anchor="end">${esc(v === 0 ? "0" : fmt(v))}</text>`,
    );
    if (v === 0) out.push(`<line class="base" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/>`);
  }
  return out.join("");
}

function yOf(v, max) {
  return M.t + (H - M.t - M.b) * (1 - v / max);
}

function pctLine(v, max, label, cls) {
  if (!Number.isFinite(v)) return "";
  const y = yOf(v, max);
  return `<line class="pct ${cls}" x1="${M.l}" x2="${W - M.r}" y1="${y}" y2="${y}"/><text class="pl" x="${W - M.r + 6}" y="${y + 3.5}">${esc(label)}</text>`;
}

function figure(title, question, caption, svg, table) {
  return `<figure class="chart"><header><h2>${esc(question)}</h2><span class="sec">${esc(title)}</span></header><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(caption)}">${svg}</svg><figcaption>${esc(caption)}</figcaption><details class="data"><summary>Data table</summary>${table}</details></figure>`;
}

function tableHtml(head, rows) {
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td class="tnum">${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/* ---------- Charts ---------- */

function agingChart(wip, stats) {
  const cols = AGING_COLS.filter(
    (s) => wip.some((w) => w.status === s) || s === "in_progress" || s === "review",
  );
  const max = niceMax(Math.max(stats.p95 || 0, ...wip.map((w) => w.hours)) * 1.1);
  const bw = (W - M.l - M.r) / cols.length;
  const parts = [yAxis(max, (v) => formatHours(v))];
  // The band above the 85th percentile: older than most finished cards.
  if (Number.isFinite(stats.p85)) {
    parts.push(
      `<rect class="band" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${Math.max(0, yOf(stats.p85, max) - M.t)}"/>`,
    );
  }
  parts.push(pctLine(stats.p50, max, `50% ${formatHours(stats.p50)}`, "p50"));
  parts.push(pctLine(stats.p85, max, `85% ${formatHours(stats.p85)}`, "p85"));
  cols.forEach((s, i) => {
    const x = M.l + bw * i + bw / 2;
    parts.push(
      `<text class="ax" x="${x}" y="${H - 8}" text-anchor="middle">${esc(columnLabel(s))}</text>`,
    );
    const here = wip.filter((w) => w.status === s).sort((a, b) => a.hours - b.hours);
    here.forEach((w, j) => {
      const dx = (j - (here.length - 1) / 2) * 12;
      const cls = agingClass(w.hours, stats);
      const y = yOf(w.hours, max);
      const tip = `${w.title} · ${columnLabel(s)} · ${formatHours(w.hours)} old${cls === "old" ? " · older than 85% of finished cards" : ""}`;
      parts.push(
        `<g class="dotg" data-card="${esc(w.cardId)}" tabindex="0" role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title><circle class="hit" cx="${x + dx}" cy="${y}" r="10"/><circle class="dot ${cls}" cx="${x + dx}" cy="${y}" r="5"/>${cls === "old" ? `<text class="dl" x="${x + dx + 9}" y="${y + 3.5}">${esc(w.shortId)}</text>` : ""}</g>`,
      );
    });
  });
  const old = wip.filter((w) => agingClass(w.hours, stats) === "old");
  const caption = old.length
    ? `${old.length} of ${wip.length} cards in progress are older than 85% of finished cards: ${old.map((w) => `${w.shortId} (${formatHours(w.hours)})`).join(", ")}.`
    : `All ${wip.length} cards in progress are younger than the 85th percentile of finished cards.`;
  const table = tableHtml(
    ["Card", "Column", "Age"],
    wip.map((w) => [w.shortId, columnLabel(w.status), formatHours(w.hours)]),
  );
  return figure("Aging work in progress", "What is getting old?", caption, parts.join(""), table);
}

function cycleChart(entries, stats) {
  const max = niceMax(
    (stats.p95 || 1) * 1.15 > Math.max(...entries.map((e) => e.hours))
      ? (stats.p95 || 1) * 1.15
      : Math.max(...entries.map((e) => e.hours)) * 1.05,
  );
  const times = entries.map((e) => Date.parse(e.doneAt ?? "")).filter(Number.isFinite);
  const byTime = times.length === entries.length;
  const t0 = byTime ? Math.min(...times) : 0;
  const t1 = byTime ? Math.max(...times) : entries.length - 1;
  const xOf = (e, i) => {
    const v = byTime ? Date.parse(e.doneAt) : i;
    return M.l + ((v - t0) / Math.max(1, t1 - t0)) * (W - M.l - M.r);
  };
  const parts = [yAxis(max, (v) => formatHours(v))];
  parts.push(pctLine(stats.p50, max, `50% ${formatHours(stats.p50)}`, "p50"));
  parts.push(pctLine(stats.p85, max, `85% ${formatHours(stats.p85)}`, "p85"));
  parts.push(pctLine(stats.p95, max, `95% ${formatHours(stats.p95)}`, "p95"));
  entries.forEach((e, i) => {
    const tip = `${e.cardId} · ${formatHours(e.hours)}${e.doneAt ? ` · done ${formatShortDate(e.doneAt)}` : ""}`;
    parts.push(
      `<circle class="sdot" cx="${xOf(e, i)}" cy="${yOf(e.hours, max)}" r="4"><title>${esc(tip)}</title></circle>`,
    );
  });
  if (byTime) {
    parts.push(
      `<text class="ax" x="${M.l}" y="${H - 8}">${esc(formatShortDate(new Date(t0).toISOString()))}</text><text class="ax" x="${W - M.r}" y="${H - 8}" text-anchor="end">${esc(formatShortDate(new Date(t1).toISOString()))}</text>`,
    );
  }
  const caption = `85% of cards finish within ${formatHours(stats.p85)}; half within ${formatHours(stats.p50)}. ${stats.n} finished cards.`;
  const table = tableHtml(
    ["Card", "Cycle time", "Done"],
    entries.map((e) => [
      e.cardId,
      formatHours(e.hours),
      e.doneAt ? formatShortDate(e.doneAt) : "–",
    ]),
  );
  return figure("Cycle time", "How long do cards take?", caption, parts.join(""), table);
}

function throughputChart(rows) {
  const vals = rows.map((r) => r.done);
  const avg = movingAverage(vals, 7);
  const max = niceMax(Math.max(1, ...vals), 4, true);
  const n = rows.length;
  const step = (W - M.l - M.r) / Math.max(1, n);
  const bw = Math.max(3, Math.min(14, step * 0.6));
  const parts = [yAxis(max, (v) => String(v), 4, true)];
  rows.forEach((r, i) => {
    if (!r.done) return;
    const x = M.l + i * step + (step - bw) / 2;
    const y = yOf(r.done, max);
    const h = yOf(0, max) - y;
    parts.push(
      `<path class="bar" d="M${x} ${y + h}V${y + Math.min(2, h)}q0 -2 2 -2h${bw - 4}q2 0 2 2V${y + h}z"><title>${esc(`${formatShortDate(r.date)} · ${r.done} done`)}</title></path>`,
    );
  });
  const line = avg
    .map((v, i) => `${i ? "L" : "M"}${M.l + i * step + step / 2} ${yOf(v, max)}`)
    .join("");
  parts.push(`<path class="avg" d="${line}"/>`);
  const lastAvg = avg.at(-1) ?? 0;
  parts.push(`<text class="pl" x="${W - M.r + 6}" y="${yOf(lastAvg, max) + 3.5}">7-day avg</text>`);
  if (n) {
    parts.push(
      `<text class="ax" x="${M.l}" y="${H - 8}">${esc(formatShortDate(rows[0].date))}</text><text class="ax" x="${W - M.r}" y="${H - 8}" text-anchor="end">${esc(formatShortDate(rows[n - 1].date))}</text>`,
    );
  }
  const total = vals.reduce((a, b) => a + b, 0);
  const caption = `${total} cards finished in ${n} days, ${(total / Math.max(1, n)).toFixed(1)} a day. The 7-day average is ${lastAvg.toFixed(1)} a day.`;
  const table = tableHtml(
    ["Date", "Done", "7-day avg"],
    rows.map((r, i) => [formatShortDate(r.date), String(r.done), avg[i].toFixed(1)]),
  );
  return figure("Throughput", "How much finishes?", caption, parts.join(""), table);
}

function cfdChart(rows) {
  const { bands, max: raw } = stackCfd(rows);
  const max = niceMax(raw, 4, true);
  const n = rows.length;
  const xOf = (i) => M.l + (i / Math.max(1, n - 1)) * (W - M.l - M.r);
  const parts = [yAxis(max, (v) => String(v), 4, true)];
  for (const k of CFD_KEYS) {
    const b = bands[k];
    if (!b.length) continue;
    const top = b.map(([, y1], i) => `${i ? "L" : "M"}${xOf(i)} ${yOf(y1, max)}`).join("");
    const bottom = b
      .map(([y0], i) => [xOf(i), yOf(y0, max)])
      .reverse()
      .map(([x, y]) => `L${x} ${y}`)
      .join("");
    const last = b.at(-1);
    parts.push(
      `<path class="band-${k}" d="${top}${bottom}Z"><title>${esc(`${CFD_LABEL[k]}: ${last[1] - last[0]} on ${formatShortDate(rows.at(-1).date)}`)}</title></path>`,
    );
    // Direct label at the right edge when the band is tall enough to hold it.
    const mid = yOf((last[0] + last[1]) / 2, max);
    if (yOf(last[0], max) - yOf(last[1], max) >= 11) {
      parts.push(
        `<text class="pl" x="${W - M.r + 6}" y="${mid + 3.5}">${esc(CFD_LABEL[k])}</text>`,
      );
    }
  }
  if (n) {
    parts.push(
      `<text class="ax" x="${M.l}" y="${H - 8}">${esc(formatShortDate(rows[0].date))}</text><text class="ax" x="${W - M.r}" y="${H - 8}" text-anchor="end">${esc(formatShortDate(rows[n - 1].date))}</text>`,
    );
  }
  const first = rows[0] ?? {};
  const lastRow = rows.at(-1) ?? {};
  const grew = CFD_KEYS.filter((k) => k !== "done" && k !== "backlog")
    .map((k) => [k, (lastRow[k] ?? 0) - (first[k] ?? 0)])
    .sort((a, b) => b[1] - a[1])[0];
  const caption =
    grew && grew[1] > 0
      ? `${CFD_LABEL[grew[0]]} grew by ${grew[1]} over the period; that is where a queue is forming.`
      : "No in-flight band widened over the period; work is flowing.";
  const legend = `<ul class="legend">${[...CFD_KEYS]
    .reverse()
    .map((k) => `<li><span class="sw band-${k}"></span>${esc(CFD_LABEL[k])}</li>`)
    .join("")}</ul>`;
  const table = tableHtml(
    ["Date", ...CFD_KEYS.map((k) => CFD_LABEL[k])],
    rows.map((r) => [formatShortDate(r.date), ...CFD_KEYS.map((k) => String(r[k] ?? 0))]),
  );
  return figure("Cumulative flow", "Where do queues form?", caption, parts.join(""), table).replace(
    "</svg>",
    `</svg>${legend}`,
  );
}

/* ---------- View ---------- */

function numbers(stats, throughput, wip) {
  const total = throughput.reduce((a, r) => a + r.done, 0);
  const perDay = total / Math.max(1, throughput.length);
  const old = wip.filter((w) => agingClass(w.hours, stats) === "old").length;
  const oldest = [...wip].sort((a, b) => b.hours - a.hours)[0];
  const block = (k, v, d = "") =>
    `<div class="num"><div class="k">${esc(k)}</div><div class="v tnum">${v}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`;
  return `<div class="nums">${block("Cycle time, 85th percentile", esc(formatHours(stats.p85)), `Half finish within ${esc(formatHours(stats.p50))}`)}${block("Throughput", `${perDay.toFixed(1)} <small>a day</small>`, `${total} in ${throughput.length} days`)}${block("Work in progress", `${wip.length} <small>cards</small>`, old ? `<span class="warn">${old} older than 85%</span>` : "None older than 85%")}${block("Oldest in progress", oldest ? esc(formatHours(oldest.hours)) : "–", oldest ? esc(oldest.shortId) : "")}</div>`;
}

function render() {
  if (!ui.root) return;
  const daysSel = [7, 30, 90]
    .map(
      (d) =>
        `<button class="filter" type="button" data-days="${d}" aria-pressed="${ui.days === d}">${d} days</button>`,
    )
    .join("");
  setTopbar({ title: "Insights", crumb: "Flow metrics", filters: daysSel });
  if (ui.status === 404) {
    ui.root.innerHTML = `<div class="later">${icon("insights", 24, "ic s24")}<b>Flow metrics aren't on this server yet.</b><span><code>GET /api/metrics/flow</code> returned 404. Update Sekhemet and restart <code>sekhemet serve</code>. Cycle time, throughput, cumulative flow and aging work appear here.</span></div>`;
    return;
  }
  if (ui.status && ui.status !== 200) {
    ui.root.innerHTML = `<div class="later">${icon("alert", 24, "ic s24")}<b>Couldn't load flow metrics.</b><span>The server returned ${esc(ui.status || "no response")}.</span><button class="btn sm" type="button" data-reload>Retry</button></div>`;
    return;
  }
  if (!ui.data) {
    const num = '<div class="num"><div class="sk sk-line"></div></div>';
    const chart = '<div class="chart sk" style="height:300px"></div>';
    ui.root.innerHTML = `<div class="ins"><div class="nums">${num.repeat(4)}</div><div class="charts">${chart.repeat(4)}</div></div>`;
    return;
  }
  const d = ui.data;
  const cycle = (d.cycleTime ?? []).filter((e) => Number.isFinite(e.hours));
  const stats = cycleTimeStats(cycle);
  if (cycle.length < 3) {
    ui.root.innerHTML = `<div class="later">${icon("insights", 24, "ic s24")}<b>Not enough finished cards to measure flow yet.</b><span>Insights need at least 3 finished cards; this period has ${cycle.length}.</span></div>`;
    return;
  }
  // Two charts a row from 1100px of content; one below that. 16px padding each side.
  const inner = Math.min(1400, ui.root.clientWidth) - 48;
  const perRow = inner >= 1100 ? 2 : 1;
  W = Math.max(320, Math.floor((inner - 16 * (perRow - 1)) / perRow) - 34);
  const wip = (d.wipAge ?? [])
    .map((w) => {
      const c = store.card(w.cardId);
      return c
        ? {
            ...w,
            status: c.status,
            title: c.display?.title ?? c.title,
            shortId: c.display?.shortId ?? c.id,
          }
        : null;
    })
    .filter((w) => w && w.status !== "done" && w.status !== "backlog");
  ui.root.innerHTML = `<div class="ins">${numbers(stats, d.throughput ?? [], wip)}<div class="charts${perRow === 1 ? " one" : ""}">${agingChart(wip, stats)}${cycleChart(cycle, stats)}${throughputChart(d.throughput ?? [])}${cfdChart(d.cfd ?? [])}</div></div>`;
}

async function load() {
  ui.data = null;
  ui.status = 0;
  render();
  try {
    const r = await getJSON(`/api/metrics/flow?days=${ui.days}`);
    ui.status = r.status;
    ui.data = r.ok ? r.data : null;
  } catch {
    ui.status = -1;
  }
  render();
}

export function mount(view) {
  const host = document.createElement("div");
  host.className = "view-host ins-host";
  view.append(host);
  ui.root = host;
  const onTop = (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-days]") : null;
    if (!b) return;
    ui.days = Number(b.dataset.days);
    load();
  };
  document.getElementById("top").addEventListener("click", onTop);
  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-reload]")) return load();
    const g = t?.closest("[data-card]");
    if (g) openPeek(g.dataset.card, { returnFocus: g });
  });
  host.addEventListener("keydown", (e) => {
    const g = e.target instanceof Element ? e.target.closest("[data-card]") : null;
    if (g && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openPeek(g.dataset.card, { returnFocus: g });
    }
  });
  let timer = 0;
  const onResize = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 150);
  };
  window.addEventListener("resize", onResize);
  load();
  return {
    unmount() {
      window.removeEventListener("resize", onResize);
      document.getElementById("top").removeEventListener("click", onTop);
      host.remove();
      ui.root = null;
    },
  };
}
