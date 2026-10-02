// *Ready to start* on the issue page (dashboard §2.6, NEW-dashboard-14,
// DB-N14-2; FINDINGS PRC-12): on an issue in Backlog, To do or being
// planned, each of the kernel's entry conditions for building, *Met* or
// *Not met* with its reason — read from the board's own checks
// (`GET /api/cards/:id/readiness`); it enforces nothing new (DB-N14-3).
import { esc, getJSON, icon } from "./dom.js";
import { readyToStart } from "./lib/readiness.js";

/** The statuses before building starts: Backlog, To do (ready) and Planning. */
export const BEFORE_BUILDING = new Set(["backlog", "ready", "planning"]);

export async function renderReady(host, cardId, status) {
  if (!host) return;
  if (!BEFORE_BUILDING.has(status)) {
    host.hidden = true;
    host.innerHTML = "";
    host.dataset.card = "";
    return;
  }
  host.dataset.card = cardId;
  const r = await getJSON(`/api/cards/${encodeURIComponent(cardId)}/readiness`);
  if (host.dataset.card !== cardId) return;
  if (!r.ok) {
    host.hidden = true;
    return;
  }
  const v = readyToStart(r.data?.readiness ?? []);
  const rows = v.rows
    .map(
      (row) =>
        `<li class="rd-row ${row.met ? "met" : "unmet"}">${row.met ? icon("check", 14, "ic s14 i-pass") : icon("x", 14, "ic s14 i-fail")}<span class="rd-l">${esc(row.label)}</span><span class="rd-s">${esc(row.state)}</span>${row.reason ? `<span class="rd-r sec">${esc(row.reason)}</span>` : ""}</li>`,
    )
    .join("");
  host.innerHTML = `<section class="rd" aria-labelledby="rd-h"><h3 class="sh" id="rd-h">Ready to start <span class="sec tnum">${esc(v.summary)}</span></h3><ul class="rd-list">${rows}</ul></section>`;
  host.hidden = false;
}
