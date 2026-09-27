// Swimlanes (PM_DESIGN §3.2): the board grouped by epic, assignee, priority or
// cycle. Each lane is a row of the same columns. Lanes are not windowed; the
// ungrouped board keeps its virtualization.
import { esc, icon, tip } from "./dom.js";
import { groupCards } from "./lib/pm.js";
import { openPeek, peekOpenFor } from "./peek.js";
import { store } from "./store.js";
import { tileHtml } from "./tile.js";
import { matchContext } from "./viewbar.js";

const collapsed = new Set();
let last = "";
let bound = null;

/** The board's columns in force (dashboard §2.4.1) that hold cards, plus the Worker's and the review queue. */
function columnsFor(cards, defs) {
  const present = new Set(cards.map((c) => c.status));
  return defs.filter(
    (d) =>
      d.states.some((s) => present.has(s)) ||
      d.states.includes("in_progress") ||
      d.states.includes("review"),
  );
}

function progressHtml(g) {
  const p = g.epic?.progress;
  if (!p || !p.total) return "";
  const pct = Math.round((p.done / p.total) * 100);
  const pts =
    typeof p.pointsDone === "number" && p.points ? ` · ${p.pointsDone} of ${p.points} pts` : "";
  return `<span class="eprog" title="${esc(`${p.done} of ${p.total} cards done${pts}`)}"><span class="ebar"><i style="width:${pct}%"></i></span><span class="tnum">${p.done} of ${p.total} done${esc(pts)}</span></span>`;
}

export function render(root, cards, { group, sortCards, tileOpts, columns }) {
  const groups = groupCards(cards, group, matchContext());
  const cols = columnsFor(cards, columns);
  const inCol = (d, list) => list.filter((c) => d.states.includes(c.status));
  const head = `<div class="lane-cols" style="--cols:${cols.length}">${cols
    .map(
      (d) =>
        `<div class="lc-h"><h2>${esc(d.label)}</h2><span class="c tnum">${inCol(d, cards).length}</span></div>`,
    )
    .join("")}</div>`;
  const body = groups
    .map((g) => {
      const key = `${group}:${g.key}`;
      const shut = collapsed.has(key);
      const h = `<header class="lane-h"><button class="chev" type="button" data-lane-toggle="${esc(key)}" aria-expanded="${!shut}" aria-label="${esc(`${shut ? "Expand" : "Collapse"} ${g.label}`)}">${icon(shut ? "chevron-right" : "chevron-down", 14, "ic s14")}</button><b>${esc(g.label)}</b><span class="sec tnum">${g.cards.length} ${g.cards.length === 1 ? "card" : "cards"}${g.points ? ` · ${g.points} pts` : ""}</span>${progressHtml(g)}</header>`;
      if (shut) return `<section class="lane shut" data-lane="${esc(key)}">${h}</section>`;
      const cells = cols
        .map((d) => {
          const list = sortCards(d.id, inCol(d, g.cards));
          const tiles = list.map((c) => tileHtml(c, tileOpts(c))).join("");
          const aria = `${g.label}, ${d.label}`;
          return `<ul class="list cell" role="listbox" aria-label="${esc(aria)}" data-cell="${esc(d.id)}">${tiles || `<li class="empty" ${tip(d.empty)}>–</li>`}</ul>`;
        })
        .join("");
      return `<section class="lane" data-lane="${esc(key)}" aria-label="${esc(g.label)}">${h}<div class="lane-row" style="--cols:${cols.length}">${cells}</div></section>`;
    })
    .join("");
  const html = `<div class="lanes" role="region" aria-label="${esc(`Board grouped by ${group}`)}">${head}${body || '<p class="empty">No cards match this filter.</p>'}</div>`;
  if (html === last && root.querySelector(".lanes")) return;
  const active = document.activeElement?.closest?.(".tile")?.dataset.id;
  const scroll = root.querySelector(".lanes");
  const pos = scroll ? [scroll.scrollLeft, scroll.scrollTop] : [0, 0];
  root.innerHTML = html;
  last = html;
  const next = root.querySelector(".lanes");
  next.scrollLeft = pos[0];
  next.scrollTop = pos[1];
  syncTabs(root, active);
  if (bound !== root) {
    bound = root;
    root.addEventListener("click", (e) => {
      const b = e.target instanceof Element ? e.target.closest("[data-lane-toggle]") : null;
      if (!b) return;
      const key = b.dataset.laneToggle;
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      last = "";
      window.dispatchEvent(new CustomEvent("sekhemet:refresh-view"));
    });
  }
}

function syncTabs(root, activeId) {
  const tiles = Array.from(root.querySelectorAll(".tile"));
  let focusId = store.state.focusedId;
  if (!tiles.some((t) => t.dataset.id === focusId)) focusId = tiles[0]?.dataset.id ?? null;
  for (const t of tiles) t.tabIndex = t.dataset.id === focusId ? 0 : -1;
  if (activeId) document.getElementById(`tile-${activeId}`)?.focus({ preventScroll: true });
}

/* ---------- Keyboard: j/k cross lanes, h/l stay in the lane ---------- */

function grid() {
  return Array.from(document.querySelectorAll(".lanes .lane:not(.shut)")).map((lane) =>
    Array.from(lane.querySelectorAll(".cell")).map((cell) =>
      Array.from(cell.querySelectorAll(".tile")).map((t) => t.dataset.id),
    ),
  );
}

function locate(g, id) {
  for (let l = 0; l < g.length; l++)
    for (let c = 0; c < g[l].length; c++) {
      const r = g[l][c].indexOf(id);
      if (r >= 0) return { l, c, r };
    }
  return null;
}

function focus(id) {
  if (!id) return;
  store.state.focusedId = id;
  const node = document.getElementById(`tile-${id}`);
  for (const t of document.querySelectorAll(".lanes .tile")) t.tabIndex = t === node ? 0 : -1;
  node?.focus({ preventScroll: true });
  node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (peekOpenFor()) openPeek(id);
}

export function onKey(e) {
  const g = grid();
  const id = store.state.focusedId;
  const at = locate(g, id);
  const k = e.key;
  if (!at) {
    if (/^[hjklHJKL]$|^Arrow/.test(k)) {
      focus(g.flat(2)[0]);
      return true;
    }
    return false;
  }
  const { l, c, r } = at;
  if (k === "j" || k === "ArrowDown") {
    if (r + 1 < g[l][c].length) focus(g[l][c][r + 1]);
    else
      for (let n = l + 1; n < g.length; n++)
        if (g[n][c]?.length) {
          focus(g[n][c][0]);
          return true;
        }
    return true;
  }
  if (k === "k" || k === "ArrowUp") {
    if (r > 0) focus(g[l][c][r - 1]);
    else
      for (let n = l - 1; n >= 0; n--)
        if (g[n][c]?.length) {
          focus(g[n][c].at(-1));
          return true;
        }
    return true;
  }
  if (k === "h" || k === "l" || k === "ArrowLeft" || k === "ArrowRight") {
    const dir = k === "h" || k === "ArrowLeft" ? -1 : 1;
    for (let n = c + dir; n >= 0 && n < g[l].length; n += dir) {
      if (g[l][n].length) {
        focus(g[l][n][Math.min(r, g[l][n].length - 1)]);
        return true;
      }
    }
    return true;
  }
  if (k === "Home") {
    focus(g[l][c][0]);
    return true;
  }
  if (k === "End") {
    focus(g[l][c].at(-1));
    return true;
  }
  if (k === " ") {
    openPeek(id, { returnFocus: document.getElementById(`tile-${id}`) });
    return true;
  }
  if (k === "Enter") {
    location.hash = `#/card/${encodeURIComponent(id)}`;
    return true;
  }
  if (k === "x") {
    const sel = store.state.selected;
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
    store.set({ selected: sel });
    return true;
  }
  if ((k === "ArrowLeft" || k === "ArrowRight") && e.shiftKey) return false;
  return false;
}

export function reset() {
  last = "";
}
