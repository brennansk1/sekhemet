// The burn-up (dashboard §2.4.17, DB-P3-14): done points and total scope as
// two lines, from `GET /api/metrics/burnup`. The geometry and every word are
// the pure module's (`lib/burnup.js`); this draws them, with the summary and
// a data table so the lines are never the only way to the numbers.
import { esc, getJSON } from "./dom.js";
import { BURNUP_HEIGHT, BURNUP_MARGIN, burnupChart } from "./lib/burnup.js";

/** Fetch the series a target names (`burnupTarget(...).url`). */
export async function loadBurnup(url) {
  try {
    const r = await getJSON(url);
    return { status: r.status, data: r.ok ? r.data : null };
  } catch {
    return { status: -1, data: null };
  }
}

function tableHtml(rows) {
  return `<div class="tbl-wrap" tabindex="0"><table class="tbl"><thead><tr><th>Date</th><th>Done</th><th>Scope</th></tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td class="tnum">${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/**
 * The burn-up as a chart figure at `width` px, or its state in words. Status
 * passes `extras` (§2.8.3, DB-N9-3): the forecast range as a band and the
 * target date as a line, each labelled in words on the chart and the caption.
 */
export function burnupHtml(state, width, extras, opts = {}) {
  // Tips: Insights puts a `?` beside the title (DB-P4-2); `opts.tip` is its markup.
  const tipBtn = opts.tip ?? "";
  const question = "Are we getting there, or is the scope growing?";
  if (!state || state.status === 0) {
    return '<div class="chart sk" style="height:300px"></div>';
  }
  if (!state.data) {
    return `<figure class="chart burnup"><header><h2>${esc(question)}</h2>${tipBtn}<span class="sec">Burn-up</span></header><p class="sec">${esc(
      state.status === 404
        ? "No burn-up on this server yet: update Sekhemet and restart it."
        : `Couldn't load the burn-up. The server returned ${state.status > 0 ? state.status : "no response"}.`,
    )}</p></figure>`;
  }
  const c = burnupChart(state.data, width, extras ?? {});
  if ("empty" in c) {
    return `<figure class="chart burnup"><header><h2>${esc(question)}</h2>${tipBtn}<span class="sec">${esc(c.title)}</span></header><p class="sec">${esc(c.empty)}</p></figure>`;
  }
  const M = BURNUP_MARGIN;
  const H = BURNUP_HEIGHT;
  const ticks = c.ticks
    .map(
      (t) =>
        `<text class="ax" x="${M.l - 8}" y="${t.y + 3.5}" text-anchor="end">${t.value}</text>${t.value === 0 ? `<line class="base" x1="${M.l}" x2="${c.width - M.r}" y1="${t.y}" y2="${t.y}"/>` : ""}`,
    )
    .join("");
  const top = M.t;
  const bottom = H - M.b;
  const band = c.band
    ? `<rect class="bu-band" x="${c.band.x1}" y="${top}" width="${Math.max(2, c.band.x2 - c.band.x1)}" height="${bottom - top}"/><text class="ax" x="${c.band.x1}" y="${top + 10}">${esc(c.band.label)}</text>`
    : "";
  const target = c.target
    ? `<line class="bu-target" x1="${c.target.x}" x2="${c.target.x}" y1="${top}" y2="${bottom}"/><text class="ax" x="${c.target.x}" y="${bottom - 4}" text-anchor="end">${esc(c.target.label)}</text>`
    : "";
  const svg = `${band}${ticks}${target}<path class="bu-scope" d="${c.scopePath}"/><path class="bu-done" d="${c.donePath}"/><text class="pl" x="${c.labels.scope.x}" y="${c.labels.scope.y}">${esc(c.labels.scope.text)}</text><text class="pl" x="${c.labels.done.x}" y="${c.labels.done.y}">${esc(c.labels.done.text)}</text><text class="ax" x="${M.l}" y="${H - 8}">${esc(c.firstDate)}</text><text class="ax" x="${c.width - M.r}" y="${H - 8}" text-anchor="end">${esc(c.lastDate)}</text>`;
  const key = `<ul class="legend" aria-hidden="true"><li><span class="sw bu-sw-scope"></span>Scope</li><li><span class="sw bu-sw-done"></span>Done</li>${c.band ? '<li><span class="sw bu-sw-band"></span>Forecast, 50% to 85%</li>' : ""}${c.target ? '<li><span class="sw bu-sw-target"></span>Target</li>' : ""}</ul>`;
  return `<figure class="chart burnup"><header><h2>${esc(question)}</h2>${tipBtn}<span class="sec">${esc(c.title)}</span></header>${key}<svg viewBox="0 0 ${c.width} ${H}" role="img" aria-label="${esc(c.caption)}">${svg}</svg><figcaption>${esc(c.caption)}</figcaption><details class="data"><summary>Data table</summary>${tableHtml(c.rows)}</details></figure>`;
}
