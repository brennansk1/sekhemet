// Board (FRONTEND_DESIGN §2.4.2): columns, rails, keyed tile patching, keyboard.
import { $, $$, esc, icon } from "./dom.js";
import { fieldKey, selectionOrFocused } from "./fields.js";
import * as lanes from "./lanes.js";
import { formatQuery, sortByPriority } from "./lib/pm.js";
import {
  BOARD_COLUMN_ORDER,
  COLUMN_EMPTY,
  GATE_STATE_LABELS,
  KIND_LABELS,
  columnLabel,
  formatDuration,
} from "./lib/vocabulary.js";
import * as listView from "./list.js";
import { openMenu } from "./overlay.js";
import { openPeek, peekOpenFor } from "./peek.js";
import { bindReorder } from "./reorder.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { tileHtml } from "./tile.js";
import { toast } from "./toast.js";
import {
  bindViewBar,
  cycleGroup,
  effectiveFilter,
  filterCards,
  focusFilter,
  onViewChange,
  paintViewBar,
  vb,
} from "./viewbar.js";

/** Columns that collapse into a 36px rail when empty. Working and Review never do. */
const RAILABLE = new Set(["backlog", "ready", "planning", "verify", "done", "parked"]);
/** Columns whose limit is a real constraint worth showing as `n / limit`. */
const LIMIT_SHOWN = 20;
/** Above this many cards a column windows its tiles instead of rendering all. */
const VIRTUAL_THRESHOLD = 60;
const ROW = 88;
const GAP = 8;
const OVERSCAN = 3;
const JUST_NOW_MS = 10_000;

const ui = {
  root: null,
  expanded: new Set(),
  collapsed: new Set(),
  pendingScroll: new Map(),
  sort: {},
  barHost: null,
  cycHost: null,
  userScrolled: false,
  autoScroll: false,
  mode: "columns",
  layoutKey: "",
  html: new Map(),
  unsub: null,
  justNowTimer: 0,
  tipEl: null,
};

/* ---------- Data shaping ---------- */

function visibleCards() {
  return filterCards(store.state.cards);
}

function waitMs(c) {
  const at = c.display?.enteredColumnAt ? Date.parse(c.display.enteredColumnAt) : Date.now();
  return store.state.now - at;
}

function sortCards(status, cards) {
  const mode =
    ui.sort[status] ?? (status === "review" || status === "parked" ? "wait" : "priority");
  if (mode === "wait") return [...cards].sort((a, b) => waitMs(b) - waitMs(a));
  if (mode === "recent") return [...cards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  // Priority 1 (urgent) first and 0 (none) last; the stored order breaks ties.
  return sortByPriority(cards);
}

function byColumn(cards) {
  const map = new Map(BOARD_COLUMN_ORDER.map((s) => [s, []]));
  for (const c of cards) map.get(c.status)?.push(c);
  for (const [s, list] of map) map.set(s, sortCards(s, list));
  return map;
}

function columnMode(status, count) {
  if (ui.collapsed.has(status)) return "rail";
  if (ui.expanded.has(status)) return "full";
  if (status === "rejected") return count > 0 ? "full" : "hidden";
  if (status === "done" && window.innerWidth < 1600) return "rail";
  if (RAILABLE.has(status) && count === 0) return "rail";
  return "full";
}

/* ---------- Rendering ---------- */

function limitInfo(status, count) {
  const limit = store.state.wipLimits?.[status];
  if (typeof limit !== "number" || limit > LIMIT_SHOWN) return null;
  const state = count > limit ? "over" : count >= limit ? "full" : "";
  let title = `Limit ${limit}`;
  if (status === "review") {
    const minutes = store.state.meta?.reviewMinutesPerDay ?? 60;
    title = `Review limit ${limit}, from ${minutes} review minutes a day at ~${Math.round(minutes / limit)} min per card.`;
    if (state === "full") title += " Full. The Worker holds finished cards until you clear one.";
  } else if (state === "full") {
    title = `${columnLabel(status)} limit ${limit}. Full.`;
  }
  return { limit, state, title };
}

function headerHtml(status, count) {
  const lim = limitInfo(status, count);
  const parkedWarn = status === "parked" && count > 0 ? " full" : "";
  const c = lim
    ? `<span class="c tnum${lim.state ? ` ${lim.state}` : ""}" title="${esc(lim.title)}">${count} / ${lim.limit}</span>`
    : `<span class="c tnum${parkedWarn}">${count}</span>`;
  const cap = lim
    ? `<div class="cap${lim.state ? ` ${lim.state}` : ""}"><i style="width:${Math.min(100, Math.round((count / lim.limit) * 100))}%"></i></div>`
    : "";
  return `<div class="col-h"><h2 id="h-${status}">${esc(columnLabel(status))}</h2>${c}<button class="more" type="button" data-colmenu="${status}" aria-label="${esc(columnLabel(status))} column options">${icon("more")}</button></div>${cap}`;
}

function railHtml(status, count) {
  const hint = `${columnLabel(status)}: ${COLUMN_EMPTY[status].replace(/\.$/, "").toLowerCase()}`;
  const warn = status === "parked" && count > 0 ? " warn" : "";
  return `<button class="rail" type="button" data-rail="${status}" title="${esc(hint)}. Press Enter to expand." aria-label="${esc(columnLabel(status))}, ${count} ${count === 1 ? "card" : "cards"}, collapsed"><span class="c tnum${warn}">${count}</span><span>${esc(columnLabel(status))}</span></button>`;
}

function renderTopbar() {
  const total = store.state.cards.length;
  const shown = visibleCards().length;
  const project = store.state.meta?.project ?? "";
  const count =
    shown === total ? `${total} ${total === 1 ? "card" : "cards"}` : `${shown} of ${total} cards`;
  setTopbar({ title: "Board", crumb: `${project}${project ? " · " : ""}${count}` });
  paintViewBar(ui.barHost, ui.cycHost, "board");
}

function ensureLayout(columns) {
  const key = columns.map(([s, mode]) => `${s}:${mode}`).join("|");
  if (key === ui.layoutKey && $(".board", ui.root)) return false;
  ui.layoutKey = key;
  const board = document.createElement("div");
  board.className = "board";
  board.setAttribute("role", "region");
  board.setAttribute("aria-label", "Board");
  const old = $(".board", ui.root);
  const scroll = old ? old.scrollLeft : 0;
  const listScroll = new Map($$(".list", ui.root).map((l) => [l.dataset.list, l.scrollTop]));
  const parts = [];
  for (const [status, mode] of columns) {
    if (mode === "hidden") continue;
    if (mode === "rail") {
      parts.push(railHtml(status, 0));
      continue;
    }
    parts.push(
      `<section class="col" role="group" aria-labelledby="h-${status}" data-col="${status}"><div class="col-head" data-head="${status}"></div><ul class="list" role="listbox" aria-orientation="vertical" aria-labelledby="h-${status}" data-list="${status}"></ul></section>`,
    );
  }
  board.innerHTML = parts.join("");
  ui.html.clear();
  if (old) old.replaceWith(board);
  else ui.root.append(board);
  board.scrollLeft = scroll;
  board.addEventListener(
    "scroll",
    () => {
      if (ui.autoScroll) ui.autoScroll = false;
      else ui.userScrolled = true;
    },
    { passive: true },
  );
  for (const list of $$(".list", board)) {
    // Lists are empty until filled; restore their scroll once tiles exist.
    ui.pendingScroll.set(list.dataset.list, listScroll.get(list.dataset.list) ?? 0);
    list.addEventListener("scroll", () => paintVirtual(list), { passive: true });
  }
  return true;
}

function tileOpts(card) {
  const movedAt = store.state.moved.get(card.id);
  return {
    now: store.state.now,
    selected: store.state.selected.has(card.id),
    justNow:
      movedAt !== undefined &&
      Date.now() - movedAt < JUST_NOW_MS &&
      store.state.focusedId !== card.id,
    pmPaused: Boolean(store.state.pm?.status?.workerPaused),
    hidePriority: vb.group === "priority",
  };
}

/** Reconcile one list against `cards`, reusing unchanged tile nodes. */
function patchList(list, cards, { virtual, from = 0 } = {}) {
  const keep = new Map($$(":scope > .tile", list).map((n) => [n.dataset.id, n]));
  let prev = null;
  const sizer = $(":scope > .sizer", list);
  cards.forEach((card, i) => {
    const html = tileHtml(card, tileOpts(card));
    let node = keep.get(card.id);
    if (node && ui.html.get(card.id) === html) {
      keep.delete(card.id);
    } else {
      const t = document.createElement("template");
      t.innerHTML = html;
      const fresh = t.content.firstElementChild;
      if (node) {
        node.replaceWith(fresh);
        keep.delete(card.id);
      }
      node = fresh;
      ui.html.set(card.id, html);
    }
    if (virtual) node.style.top = `${GAP + (from + i) * (ROW + GAP)}px`;
    const expected = prev ? prev.nextSibling : list.firstChild;
    if (node !== expected) list.insertBefore(node, expected);
    prev = node;
  });
  for (const n of keep.values()) n.remove();
  if (sizer) list.append(sizer);
}

function paintVirtual(list) {
  const status = list.dataset.list;
  const cards = ui.columns?.get(status) ?? [];
  if (cards.length <= VIRTUAL_THRESHOLD) return;
  const stride = ROW + GAP;
  const first = Math.max(0, Math.floor(list.scrollTop / stride) - OVERSCAN);
  const last = Math.min(
    cards.length,
    Math.ceil((list.scrollTop + list.clientHeight) / stride) + OVERSCAN,
  );
  patchList(list, cards.slice(first, last), { virtual: true, from: first });
  syncFocusAttrs();
}

function restoreScroll(list) {
  const want = ui.pendingScroll.get(list.dataset.list);
  if (want === undefined) return;
  ui.pendingScroll.delete(list.dataset.list);
  list.scrollTop = want;
}

function fillList(list, status, cards) {
  const virtual = cards.length > VIRTUAL_THRESHOLD;
  list.classList.toggle("virtual", virtual);
  let sizer = $(":scope > .sizer", list);
  if (virtual && !sizer) {
    sizer = document.createElement("div");
    sizer.className = "sizer";
    sizer.setAttribute("aria-hidden", "true");
    list.append(sizer);
  } else if (!virtual && sizer) {
    sizer.remove();
    sizer = null;
  }
  const empty = $(":scope > .empty", list);
  if (cards.length === 0) {
    patchList(list, []);
    const label = formatQuery(effectiveFilter());
    const text = label ? `No cards match “${label}”.` : COLUMN_EMPTY[status];
    if (!empty) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = text;
      list.append(li);
    } else if (empty.textContent !== text) {
      empty.textContent = text;
    }
    return;
  }
  empty?.remove();
  if (virtual) {
    sizer.style.height = `${cards.length * (ROW + GAP) + GAP}px`;
    restoreScroll(list);
    paintVirtual(list);
  } else {
    patchList(list, cards);
    restoreScroll(list);
  }
}

function syncFocusAttrs() {
  const tiles = $$(".tile", ui.root);
  let focusId = store.state.focusedId;
  if (!tiles.some((t) => t.dataset.id === focusId)) focusId = tiles[0]?.dataset.id ?? null;
  for (const t of tiles) {
    const on = t.dataset.id === focusId;
    t.tabIndex = on ? 0 : -1;
    t.classList.toggle("focus", on && t.contains(document.activeElement));
  }
}

function render() {
  if (!ui.root) return;
  renderTopbar();
  const s = store.state;
  const activeId = document.activeElement?.closest?.(".tile")?.dataset.id;
  const activeCol = activeId ? store.card(activeId)?.status : null;
  const prevCol = document.activeElement?.closest?.(".list")?.dataset.list;

  if (s.loaded && s.cards.length === 0) {
    ui.layoutKey = "";
    ui.root.innerHTML = `<div class="board-empty">${icon("glyph", 24, "ic s24")}<b>No cards yet.</b><span>Plan a feature into cards: <code>sekhemet plan "Build a tamper-evident ledger"</code></span><span>Or seed a fixture: <code>node scripts/seed_project.mjs chronicle</code></span></div>`;
    return;
  }
  $(".board-empty", ui.root)?.remove();
  $(".skeleton", ui.root)?.remove();

  if (vb.group !== "none") {
    if (ui.mode !== "lanes") {
      ui.root.textContent = "";
      ui.layoutKey = "";
      ui.mode = "lanes";
    }
    lanes.render(ui.root, visibleCards(), { group: vb.group, sortCards, tileOpts });
    return;
  }
  if (ui.mode === "lanes") {
    ui.root.textContent = "";
    ui.layoutKey = "";
    ui.mode = "columns";
  }

  const all = byColumn(s.cards);
  const cols = byColumn(visibleCards());
  ui.columns = cols;
  const layout = BOARD_COLUMN_ORDER.map((status) => [
    status,
    columnMode(status, all.get(status).length),
  ]);
  ensureLayout(layout);

  for (const [status, mode] of layout) {
    if (mode === "rail") {
      const rail = $(`[data-rail="${status}"]`, ui.root);
      const html = railHtml(status, all.get(status).length);
      if (rail && rail.outerHTML !== html) rail.outerHTML = html;
      continue;
    }
    if (mode !== "full") continue;
    const head = $(`[data-head="${status}"]`, ui.root);
    const hh = headerHtml(status, all.get(status).length);
    if (head && head.dataset.html !== hh) {
      head.innerHTML = hh;
      head.dataset.html = hh;
    }
    fillList($(`[data-list="${status}"]`, ui.root), status, cols.get(status));
  }

  syncFocusAttrs();
  // Keep focus on the card it was on, even when an SSE frame replaced its node.
  if (activeId && !document.activeElement?.closest?.(".tile")) {
    const node = document.getElementById(`tile-${activeId}`);
    if (node) {
      node.focus({ preventScroll: activeCol === prevCol });
      if (activeCol !== prevCol) node.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  pinQueueColumns();
  scheduleJustNow();
}

/**
 * When the board scrolls sideways, Review and Parked stay pinned to the right
 * edge: the human's queue is never the part that gets scrolled away (§2.4.2).
 */
function pinQueueColumns() {
  const board = $(".board", ui.root);
  if (!board) return;
  const review = $('[data-col="review"]', board);
  const parked = $('[data-col="parked"]', board);
  const overflow = board.scrollWidth > board.clientWidth + 1;
  let right = 0;
  for (const col of [parked, review]) {
    if (!col) continue;
    col.classList.toggle("pinned", overflow);
    col.style.right = overflow ? `${right}px` : "";
    if (overflow) right += col.offsetWidth + GAP;
  }
  // Pinned columns must not hide the Worker: until the user scrolls, keep
  // Working just left of them (e.g. beside the Seshat dock).
  const working = $('[data-col="in_progress"]', board);
  if (overflow && working && !ui.userScrolled) {
    const edge = board.clientWidth - right;
    const end = working.offsetLeft + working.offsetWidth - board.scrollLeft;
    if (end > edge) {
      ui.autoScroll = true;
      board.scrollLeft += end - edge + GAP;
    }
  }
}

function scheduleJustNow() {
  clearTimeout(ui.justNowTimer);
  const pending = [...store.state.moved.values()].filter((t) => Date.now() - t < JUST_NOW_MS);
  if (pending.length === 0) return;
  const next = Math.min(...pending) + JUST_NOW_MS - Date.now() + 50;
  ui.justNowTimer = setTimeout(render, Math.max(100, next));
}

/* ---------- Focus and keyboard ---------- */

function focusTile(id, { scroll = true } = {}) {
  if (!id) return;
  store.state.focusedId = id;
  let node = document.getElementById(`tile-${id}`);
  if (!node) {
    // Windowed out: scroll its column so it materialises, then focus.
    const card = store.card(id);
    const list = card && $(`[data-list="${card.status}"]`, ui.root);
    const idx = list ? (ui.columns.get(card.status) ?? []).findIndex((c) => c.id === id) : -1;
    if (list && idx >= 0) {
      list.scrollTop = Math.max(0, idx * (ROW + GAP) - list.clientHeight / 2);
      paintVirtual(list);
      node = document.getElementById(`tile-${id}`);
    }
  }
  syncFocusAttrs();
  if (node) {
    node.focus({ preventScroll: true });
    if (scroll) node.scrollIntoView({ block: "nearest", inline: "nearest" });
    node.classList.add("focus");
  }
  if (peekOpenFor()) openPeek(id);
}

function navColumns() {
  return BOARD_COLUMN_ORDER.filter(
    (s) => (ui.columns?.get(s) ?? []).length > 0 && $(`[data-list="${s}"]`, ui.root),
  );
}

function move(dx, dy, edge) {
  const cols = navColumns();
  if (cols.length === 0) return;
  const cur = store.card(store.state.focusedId);
  let ci = cur ? cols.indexOf(cur.status) : -1;
  if (ci < 0) {
    focusTile(ui.columns.get(cols[0])[0].id);
    return;
  }
  const list = ui.columns.get(cols[ci]);
  let ri = list.findIndex((c) => c.id === cur.id);
  if (edge === "home") ri = 0;
  else if (edge === "end") ri = list.length - 1;
  else if (dx) {
    ci = Math.max(0, Math.min(cols.length - 1, ci + dx));
    ri = Math.min(ri, ui.columns.get(cols[ci]).length - 1);
  } else ri = Math.max(0, Math.min(list.length - 1, ri + dy));
  focusTile(ui.columns.get(cols[ci])[ri].id);
}

function toggleSelect(id) {
  if (!id) return;
  const sel = store.state.selected;
  if (sel.has(id)) sel.delete(id);
  else sel.add(id);
  store.set({ selected: sel });
}

export function onKey(e) {
  const k = e.key;
  const focused = store.state.focusedId;
  if (k === "v") {
    location.hash = "#/board/list";
    return true;
  }
  if (k === "S" && e.shiftKey) {
    cycleGroup();
    return true;
  }
  const anchor = document.getElementById(`tile-${focused}`) ?? ui.root;
  if (fieldKey(e, selectionOrFocused(), anchor)) return true;
  if (vb.group !== "none") return lanes.onKey(e);
  if (k === "h" || k === "ArrowLeft") {
    move(-1, 0);
    return true;
  }
  if (k === "l" || k === "ArrowRight") {
    move(1, 0);
    return true;
  }
  if (k === "j" || k === "ArrowDown") {
    move(0, 1);
    return true;
  }
  if (k === "k" || k === "ArrowUp") {
    move(0, -1);
    return true;
  }
  if (k === "Home") {
    move(0, 0, "home");
    return true;
  }
  if (k === "End") {
    move(0, 0, "end");
    return true;
  }
  if (k === " " && focused) {
    openPeek(focused, { returnFocus: document.getElementById(`tile-${focused}`) });
    return true;
  }
  if (k === "Enter" && focused && !e.target.closest?.("button:not(.tile)")) {
    location.hash = `#/card/${encodeURIComponent(focused)}`;
    return true;
  }
  if (k === "x") {
    toggleSelect(focused);
    return true;
  }
  if (k === "c") {
    toast({ text: "Create cards from the CLI for now", detail: 'sekhemet plan "<spec>"' });
    return true;
  }
  return false;
}

/* ---------- Gate pip hover ---------- */

function showTip(pipsEl) {
  const card = store.card(pipsEl.closest(".tile")?.dataset.id);
  const gates = card?.display?.evidence?.gates ?? [];
  if (!gates.length) return;
  hideTip();
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  const icons = { pass: "check", fail: "x", skipped: "minus", not_run: "minus", running: "ring" };
  const tone = { pass: "i-pass", fail: "i-fail", running: "i-run" };
  tip.innerHTML = gates
    .map((g) => {
      const meta = g.detail ?? (g.durationMs !== undefined ? formatDuration(g.durationMs) : "");
      const first = g.firstError
        ? `<div class="mono" style="margin:0 0 4px 20px">${esc(g.firstError)}</div>`
        : "";
      return `<div class="row">${icon(icons[g.state], 12, `ic s12 ${tone[g.state] ?? ""}`)}<b>${esc(g.label)}</b><span>${esc(GATE_STATE_LABELS[g.state])}${g.failures ? ` · ${g.failures} ${g.failures === 1 ? "error" : "errors"}` : ""}</span><span class="t tnum">${esc(meta)}</span></div>${first}`;
    })
    .join("");
  document.getElementById("overlay-root").append(tip);
  const r = pipsEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - tip.offsetWidth - 8));
  tip.style.left = `${left}px`;
  tip.style.top = `${r.bottom + 6}px`;
  ui.tipEl = tip;
}

function hideTip() {
  ui.tipEl?.remove();
  ui.tipEl = null;
}

/* ---------- Mount ---------- */

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const rail = t.closest("[data-rail]");
  if (rail) {
    ui.expanded.add(rail.dataset.rail);
    ui.collapsed.delete(rail.dataset.rail);
    render();
    $(`[data-list="${rail.dataset.rail}"]`, ui.root)
      ?.closest(".col")
      ?.querySelector("h2")
      ?.scrollIntoView({ inline: "nearest" });
    return;
  }
  const menuBtn = t.closest("[data-colmenu]");
  if (menuBtn) {
    const status = menuBtn.dataset.colmenu;
    const cur =
      ui.sort[status] ?? (status === "review" || status === "parked" ? "wait" : "priority");
    const set = (mode) => () => {
      ui.sort[status] = mode;
      render();
    };
    const items = [
      { label: "Sort by priority", checked: cur === "priority", run: set("priority") },
      { label: "Sort by wait time", checked: cur === "wait", run: set("wait") },
      { label: "Sort by recently changed", checked: cur === "recent", run: set("recent") },
    ];
    if (RAILABLE.has(status)) {
      items.push("-", {
        label: "Collapse column",
        run: () => {
          ui.expanded.delete(status);
          ui.collapsed.add(status);
          render();
        },
      });
    }
    openMenu(menuBtn, items, { heading: columnLabel(status) });
    return;
  }
  const tile = t.closest(".tile");
  if (tile) {
    store.state.focusedId = tile.dataset.id;
    syncFocusAttrs();
    tile.classList.add("focus");
    if (peekOpenFor()) openPeek(tile.dataset.id);
  }
}

export function mount(view, route) {
  if (route?.params?.[0] === "list") return listView.mount(view, route);
  const outer = document.createElement("div");
  outer.className = "view-host";
  outer.innerHTML =
    '<div class="vbar-host"></div><div class="cyc-host"></div><div class="view-host board-host"></div>';
  view.append(outer);
  ui.barHost = outer.querySelector(".vbar-host");
  ui.cycHost = outer.querySelector(".cyc-host");
  bindViewBar(ui.barHost);
  bindViewBar(ui.cycHost);
  const container = outer.querySelector(".board-host");
  ui.root = container;
  ui.mode = "columns";
  ui.layoutKey = "";
  ui.html.clear();
  container.addEventListener("click", onClick);
  // B11: drag (or Alt+Up/Down) to reorder cards within a column.
  bindReorder(container);
  container.addEventListener("dblclick", (e) => {
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    if (tile) openPeek(tile.dataset.id, { returnFocus: tile });
  });
  container.addEventListener("focusin", (e) => {
    const tile = e.target.closest?.(".tile");
    if (tile && store.state.focusedId !== tile.dataset.id) {
      store.state.focusedId = tile.dataset.id;
      syncFocusAttrs();
    }
    if (tile) tile.classList.add("focus");
  });
  container.addEventListener("focusout", (e) => {
    e.target.closest?.(".tile")?.classList.remove("focus");
  });
  container.addEventListener("mouseover", (e) => {
    const p = e.target instanceof Element ? e.target.closest("[data-pips]") : null;
    if (p) showTip(p);
  });
  container.addEventListener("mouseout", (e) => {
    const p = e.target instanceof Element ? e.target.closest("[data-pips]") : null;
    if (p && !p.contains(e.relatedTarget)) hideTip();
  });
  const onResize = () => render();
  window.addEventListener("resize", onResize);
  ui.unsub = store.on((_s, patch) => {
    if ("focusedId" in patch && Object.keys(patch).length === 1) return;
    render();
  });
  const offView = onViewChange(() => render());
  window.addEventListener("sekhemet:refresh-view", render);
  const focusFirst = () => {
    const first = $(".tile", ui.root);
    if (first) focusTile(first.dataset.id);
  };
  view.addEventListener("sekhemet:focus-first", focusFirst);
  render();
  return {
    onKey,
    focusFilter: () => focusFilter(outer),
    unmount() {
      offView();
      window.removeEventListener("sekhemet:refresh-view", render);
      view.removeEventListener("sekhemet:focus-first", focusFirst);
      ui.unsub?.();
      hideTip();
      clearTimeout(ui.justNowTimer);
      window.removeEventListener("resize", onResize);
      outer.remove();
      ui.root = null;
    },
  };
}
