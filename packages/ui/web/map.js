// Story map (`#/board/map`, dashboard §2.4.17, DB-P3-13): the board's epics
// across as the backbone, the release slices beneath with the walking
// skeleton marked, each requirement with its state in words and its cards'
// tiles under it; then the burn-up (DB-P3-14). What it shows is the pure
// models' (`lib/storymap.js`, `lib/burnup.js`); the slices and requirement
// states are the requirement graph's (`GET /api/story-map`).
import { burnupHtml, loadBurnup } from "./burnup.js";
import { openCreate } from "./create.js";
import { $, $$, esc, getJSON, icon } from "./dom.js";
import { tip as learnTip } from "./learn.js";
import { burnupTarget } from "./lib/burnup.js";
import { epicFromFilter } from "./lib/create.js";
import { storyMapModel } from "./lib/storymap.js";
import { openPeek } from "./peek.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { tileHtml } from "./tile.js";
import {
  bindViewBar,
  effectiveFilter,
  filterCards,
  focusFilter,
  onViewChange,
  paintViewBar,
} from "./viewbar.js";

/** The map and the burn-up refetch at most this often while the board changes. */
const REFRESH_MS = 2000;

const ui = {
  root: null,
  barHost: null,
  cycHost: null,
  /** undefined until fetched; null when no brief has been accepted (404). */
  map: undefined,
  mapStatus: 0,
  burn: null,
  burnUrl: "",
  html: "",
  timer: 0,
};

async function loadMap() {
  try {
    const r = await getJSON("/api/story-map");
    ui.mapStatus = r.status;
    ui.map = r.ok ? r.data : r.status === 404 ? null : ui.map;
  } catch {
    ui.mapStatus = -1;
  }
}

async function loadBurn(force = false) {
  const target = burnupTarget(
    store.state.cycles,
    effectiveFilter(),
    store.state.now,
    store.state.project?.id,
    store.state.estimation,
  );
  if (!force && target.url === ui.burnUrl && ui.burn) return;
  ui.burnUrl = target.url;
  ui.burn = { status: 0, data: null };
  render();
  ui.burn = await loadBurnup(target.url);
  render();
}

async function refresh() {
  await loadMap();
  render();
  await loadBurn(true);
}

/** At most one refetch per REFRESH_MS, however often the stream sends frames. */
function schedule() {
  if (ui.timer) return;
  ui.timer = setTimeout(() => {
    ui.timer = 0;
    if (ui.root) refresh();
  }, REFRESH_MS);
}

function tileOpts() {
  return {
    now: store.state.now,
    epics: store.state.epics,
    pmPaused: Boolean(store.state.pm?.status?.workerPaused),
    estimation: store.state.estimation,
  };
}

function tilesHtml(cards, visible) {
  const shown = cards.filter((c) => visible.has(c.id));
  if (shown.length === 0) return "";
  return `<ul class="list smap-cards" role="listbox" aria-label="Issues">${shown
    .map((c) => tileHtml(c, tileOpts()).replace(' role="option"', ' role="option" tabindex="0"'))
    .join("")}</ul>`;
}

function requirementHtml(r, visible) {
  const tone = r.tone ? ` i-${r.tone}` : "";
  return `<li class="sreq"><div class="sreq-h"><span class="rst${tone}">${icon(r.icon, 12, "ic s12")}<span>${esc(r.label)}</span></span><span class="sreq-id tnum">${esc(r.id)}</span><span class="sec">${esc(r.moscow)}</span></div><p class="sreq-t">${esc(r.title)}</p><p class="sreq-why">${esc(r.why)}</p>${tilesHtml(r.cards, visible)}</li>`;
}

/** Tips: the burn-up's `?`, reading its last day (DB-P4-2). */
function burnTip() {
  const days = ui.burn?.data?.days ?? [];
  const last = days[days.length - 1];
  const burnup = last
    ? { done: last.done, scope: last.scope, unit: ui.burn.data.unit ?? "points" }
    : undefined;
  return learnTip("metric:burnup", "Burn-up", burnup ? { burnup } : undefined);
}

function mapHtml(m, visible) {
  if (m.empty) {
    return `<div class="board-empty">${icon("layers", 24, "ic s24")}<b>${esc(m.empty)}</b><span class="board-empty-acts"><button type="button" class="btn primary" data-open-pm>Open Seshat</button></span></div>`;
  }
  const n = m.backbone.length;
  const head = m.backbone
    .map(
      (e) =>
        `<th scope="col" class="smap-epic"${e.id ? "" : ' data-none=""'}>${icon("layers", 12, "ic s12")}<span>${esc(e.title)}</span></th>`,
    )
    .join("");
  const bands = m.bands
    .map((b) => {
      // Tips explain a release, and the first one, where they appear (DB-P4-2,
      // §2.9.2); the teaching is theirs, not a hover title's.
      const mark = b.skeleton
        ? `<span class="skel">${icon("arrow-right", 12, "ic s12")}First release</span>`
        : "";
      // A requirement is done when proven on main; a cut one is out of the count.
      const reqs = b.cells.flatMap((c) => c.requirements).filter((r) => r.state !== "cut");
      const release = {
        heading: b.heading,
        done: reqs.filter((r) => r.state === "proven").length,
        total: reqs.length,
      };
      const why = b.stateText
        ? learnTip(
            b.skeleton ? "first_release" : "release",
            b.skeleton ? "First release" : "Release",
            { release },
          )
        : "";
      const cells = b.cells
        .map((c) => {
          const reqs = c.requirements.map((r) => requirementHtml(r, visible)).join("");
          const loose = tilesHtml(c.cards, visible);
          const body =
            reqs || loose
              ? `${reqs ? `<ul class="sreqs">${reqs}</ul>` : ""}${loose}`
              : '<span class="smap-none" aria-label="Nothing here">–</span>';
          return `<td>${body}</td>`;
        })
        .join("");
      return `<tbody class="smap-band${b.skeleton ? " skeleton" : ""}"><tr><th scope="rowgroup" colspan="${n}" class="smap-band-h"><span class="smap-band-t">${esc(b.heading)}</span>${mark}${why}${b.stateText ? `<span class="sec">${esc(b.stateText)}</span>` : ""}</th></tr><tr>${cells}</tr></tbody>`;
    })
    .join("");
  const note = m.note
    ? `<p class="smap-note">${icon("alert", 12, "ic s12")}<span>${esc(m.note)}</span></p>`
    : "";
  return `${note}<div class="smap-scroll" role="region" aria-label="Story map" tabindex="0"><table class="smap" style="--cols:${n}"><thead><tr>${head}</tr></thead>${bands}</table></div>`;
}

function render() {
  if (!ui.root) return;
  const s = store.state;
  const proven = ui.map?.provenLine ?? "";
  const project = s.meta?.project ?? "";
  setTopbar({
    title: "Story map",
    crumb: [project, proven].filter(Boolean).join(" · "),
  });
  paintViewBar(ui.barHost, ui.cycHost, "map");
  let body;
  if (ui.map === undefined && ui.mapStatus === 0) {
    body = '<div class="chart sk" style="height:320px"></div>';
  } else if (ui.map === undefined) {
    body = `<div class="later">${icon("alert", 24, "ic s24")}<b>Couldn't load the story map.</b><span>The server returned ${esc(ui.mapStatus > 0 ? ui.mapStatus : "no response")}.</span><button class="btn sm" type="button" data-reload>Retry</button></div>`;
  } else {
    const visible = new Set(filterCards(s.cards).map((c) => c.id));
    body = mapHtml(storyMapModel({ map: ui.map, cards: s.cards, epics: s.epics }), visible);
  }
  const width = Math.max(320, Math.min(900, (ui.root.clientWidth || 900) - 48));
  const html = `<div class="smap-host">${body}<section class="smap-burn" aria-label="Burn-up">${burnupHtml(ui.burn, width, undefined, { tip: burnTip() })}</section></div>`;
  if (html === ui.html) return;
  const scroller = $(".smap-scroll", ui.root);
  const keep = scroller ? [scroller.scrollLeft, scroller.scrollTop] : null;
  const focusId = document.activeElement?.closest?.(".tile")?.dataset.id;
  ui.root.innerHTML = html;
  ui.html = html;
  const next = $(".smap-scroll", ui.root);
  if (next && keep) [next.scrollLeft, next.scrollTop] = keep;
  if (focusId) document.getElementById(`tile-${focusId}`)?.focus({ preventScroll: true });
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (t.closest("[data-reload]")) {
    refresh();
    return;
  }
  if (t.closest("[data-open-pm]")) {
    window.dispatchEvent(new CustomEvent("sekhemet:open-pm"));
    return;
  }
  const tile = t.closest(".tile");
  if (tile) {
    store.state.focusedId = tile.dataset.id;
    openPeek(tile.dataset.id, { returnFocus: tile });
  }
}

export function onKey(e) {
  const k = e.key;
  if (k === "v") {
    location.hash = "#/board";
    return true;
  }
  if (k === "c") {
    openCreate({ epicId: epicFromFilter(effectiveFilter(), store.state.epics) });
    return true;
  }
  const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
  if (tile && k === "Enter") {
    location.hash = `#/card/${encodeURIComponent(tile.dataset.id)}`;
    return true;
  }
  if (tile && k === " ") {
    openPeek(tile.dataset.id, { returnFocus: tile });
    return true;
  }
  return false;
}

export function mount(view) {
  const outer = document.createElement("div");
  outer.className = "view-host";
  outer.innerHTML =
    '<div class="vbar-host"></div><div class="cyc-host"></div><div class="view-host map-host"></div>';
  view.append(outer);
  ui.barHost = $(".vbar-host", outer);
  ui.cycHost = $(".cyc-host", outer);
  bindViewBar(ui.barHost);
  bindViewBar(ui.cycHost);
  ui.root = $(".map-host", outer);
  ui.map = undefined;
  ui.mapStatus = 0;
  ui.burn = null;
  ui.burnUrl = "";
  ui.html = "";
  ui.root.addEventListener("click", onClick);
  const unsub = store.on((_s, patch) => {
    if ("focusedId" in patch && Object.keys(patch).length === 1) return;
    render();
    if ("cards" in patch || "cycles" in patch) schedule();
  });
  const offView = onViewChange(() => {
    render();
    loadBurn();
  });
  const focusFirst = () => $$(".tile", ui.root)[0]?.focus();
  view.addEventListener("sekhemet:focus-first", focusFirst);
  render();
  refresh();
  return {
    onKey,
    focusFilter: () => focusFilter(outer),
    unmount() {
      unsub();
      offView();
      clearTimeout(ui.timer);
      ui.timer = 0;
      view.removeEventListener("sekhemet:focus-first", focusFirst);
      outer.remove();
      ui.root = null;
    },
  };
}
