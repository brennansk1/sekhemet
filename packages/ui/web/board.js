// Board (dashboard §2.4): the professional columns or pipeline stages, chips
// for empty columns, keyed tile patching and the keyboard. What the board shows
// is the pure model's (`lib/columns.js`, `lib/tiles.js`, dashboard P3).
import { openCreate } from "./create.js";
import { $, $$, brandMark, esc, icon, postJSON, tip } from "./dom.js";
import { fieldKey, selectionOrFocused } from "./fields.js";
import * as lanes from "./lanes.js";
import { tip as learnTip } from "./learn.js";
import {
  boardColumnDefs,
  boardModel,
  defaultSort,
  focusAfterFrame,
  onColumns,
  readColumnChoices,
  readPipeline,
  sortColumn,
  writeColumnChoices,
  writePipeline,
} from "./lib/columns.js";
import { QUICK_CREATE_COPY, epicFromFilter } from "./lib/create.js";
import { columnLessonId } from "./lib/learn.js";
import { draggedBy } from "./lib/live.js";
import { formatQuery } from "./lib/pm.js";
import { START_PROJECT_OPENING } from "./lib/seshat.js";
import { GATE_STATE_LABELS, formatDuration } from "./lib/vocabulary.js";
import * as listView from "./list.js";
import * as mapView from "./map.js";
import { openMenu } from "./overlay.js";
import { openPeek, peekOpenFor } from "./peek.js";
import { askMerit, togglePmPanel } from "./pm_panel.js";
import { announceDrag } from "./presence.js";
import { bindReorder } from "./reorder.js";
import { getSession } from "./session.js";
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
import { columnsInWindow, windowRange } from "./virtual.js";

/** Columns whose header has the create `+` (DB-P3-12): where a new card can start. */
const CREATE_COLUMNS = new Set(["backlog", "todo", "ready"]);

/** Above this many cards a column windows its tiles instead of rendering all. */
const VIRTUAL_THRESHOLD = 60;
const ROW = 88;
/** Comfortable density adds the spec line and the token and time bars (§2.5.1). */
const rowHeight = () => (document.documentElement.dataset.density === "comfortable" ? 112 : ROW);
const GAP = 8;
const OVERSCAN = 3;
/** Columns with more cards than this drop their tiles when scrolled out of view (U6). */
const CULL_MIN = 12;
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
  hFrame: 0,
  /** Pipeline stages (`⇧V`), kept per browser (DB-P3-3). */
  pipeline: false,
  /** Full columns in order, from the last render. */
  layout: [],
  /** Card id → its column id, from the last render (DB-P3-15). */
  colOf: new Map(),
  columns: new Map(),
};

function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** A person's column choices for the layout in force, from this browser (DB-P3-16). */
function loadChoices() {
  const c = readColumnChoices(storage(), ui.pipeline);
  ui.sort = c.sort;
  ui.collapsed = c.collapsed;
  ui.expanded = c.expanded;
}

function saveChoices() {
  writeColumnChoices(storage(), ui.pipeline, {
    sort: ui.sort,
    collapsed: ui.collapsed,
    expanded: ui.expanded,
  });
}

/* ---------- Data shaping ---------- */

function visibleCards() {
  return filterCards(store.state.cards);
}

/**
 * The column definitions in force: the professional five (with Won't do when
 * the filter asks for rejected cards), or the nine stages. The board and its
 * swimlanes read the same list (DB-P3-1).
 */
function columnDefs() {
  return boardColumnDefs({ pipeline: ui.pipeline, wontDo: wantsWontDo() });
}

/** A column's sort, for swimlanes: the same default and choice as the board. */
function sortCards(colId, cards) {
  const def = columnDefs().find((c) => c.id === colId) ?? { queue: false };
  return sortColumn(cards, ui.sort[colId] ?? defaultSort(def), store.state.now);
}

/** The filter asks for rejected cards: the Won't do column shows (§2.4.1). */
function wantsWontDo() {
  return effectiveFilter().terms.some(
    (t) => t.field === "state" && !t.negate && t.values.includes("rejected"),
  );
}

function model() {
  const s = store.state;
  return boardModel({
    cards: s.cards,
    visible: new Set(visibleCards().map((c) => c.id)),
    now: s.now,
    pipeline: ui.pipeline,
    wipLimits: s.wipLimits,
    reviewLimit: s.reviewLimit ?? null,
    expanded: ui.expanded,
    collapsed: ui.collapsed,
    sort: ui.sort,
    wontDo: wantsWontDo(),
    estimation: s.estimation,
  });
}

/* ---------- Rendering ---------- */

function headerHtml(col) {
  const lim = col.limit;
  // On hold's count is in the parked tone whenever it holds cards (DB-P3-18).
  const tone = lim?.state ? ` ${lim.state}` : col.countTone === "parked" ? " held" : "";
  const c = lim
    ? `<span class="c tnum${tone}" ${tip(lim.derivation)}>${esc(lim.text)}</span>`
    : `<span class="c tnum${tone}">${col.count}</span>`;
  // Tips (DB-P4-2): a `?` on the header, the WIP count and the points, each
  // with the numbers this header shows (DB-P4-4: the In review limit's
  // review minutes a day and minutes a review). Nothing with Tips off.
  const reviewLimit =
    col.states.length === 1 && col.states[0] === "review" ? store.state.reviewLimit : null;
  const facts = {
    column: col.id,
    count: lim ? lim.count : col.count,
    ...(lim ? { limit: lim.limit } : {}),
    ...(reviewLimit ? { reviewLimit } : {}),
  };
  const colTip = learnTip(columnLessonId(col.id), col.label, facts);
  const wipTip = lim ? learnTip("wip", "WIP limit", facts) : "";
  const pts = `<span class="pts tnum">${esc(col.pointsText)}</span>${col.pointsText ? learnTip("points", "Story points", { column: col.id, points: col.points }) : ""}`;
  const cap = lim
    ? `<div class="cap${lim.state ? ` ${lim.state}` : ""}"><i style="width:${Math.min(100, Math.round((lim.count / Math.max(1, lim.limit)) * 100))}%"></i></div>`
    : "";
  // DB-P3-12: the columns a new card can start in carry the create `+`.
  const add = CREATE_COLUMNS.has(col.id)
    ? `<button class="more add" type="button" data-create aria-label="${esc(QUICK_CREATE_COPY.plus)}" ${tip(QUICK_CREATE_COPY.plusTip)}>${icon("plus")}</button>`
    : "";
  return `<div class="col-h"><h2 id="h-${esc(col.id)}">${esc(col.label)}</h2>${colTip}${c}${wipTip}${pts}${add}<button class="more" type="button" data-colmenu="${esc(col.id)}" aria-label="${esc(col.label)} column options"${lim ? ` aria-description="${esc(lim.derivation)}"` : ""}>${icon("more")}</button></div>${cap}`;
}

/** Empty and folded columns as chips above the board, and the stages toggle (DB-P3-10). */
function chipsHtml(chips) {
  const items = chips
    .map(
      (c) =>
        `<button class="col-chip" type="button" data-chip-col="${esc(c.id)}" ${tip(`${c.label}: ${c.empty} Opens the column.`)}><span>${esc(c.label)}</span><span class="c tnum">${c.count}</span>${icon("chevron-right", 12, "ic s12")}</button>`,
    )
    .join("");
  const toggle = `<button class="col-chip pipe-toggle" type="button" data-pipeline aria-pressed="${ui.pipeline ? "true" : "false"}" ${tip("Show each stored state as its own column (Shift+V).")}>Pipeline stages</button>`;
  return `<div class="col-chips" role="group" aria-label="Columns">${items}${toggle}</div>`;
}

function renderTopbar() {
  const total = store.state.cards.length;
  const shown = visibleCards().length;
  const project = store.state.meta?.project ?? "";
  const count =
    shown === total
      ? `${total} ${total === 1 ? "issue" : "issues"}`
      : `${shown} of ${total} issues`;
  setTopbar({ title: "Board", crumb: `${project}${project ? " · " : ""}${count}` });
  paintViewBar(ui.barHost, ui.cycHost, "board");
}

function ensureLayout(columns) {
  const key = columns.map((c) => c.id).join("|");
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
  for (const col of columns) {
    const id = esc(col.id);
    parts.push(
      `<section class="col${col.queue ? " queue" : ""}" role="group" aria-labelledby="h-${id}" data-col="${id}"><div class="col-head" data-head="${id}"></div><ul class="list" role="listbox" aria-orientation="vertical" aria-labelledby="h-${id}" data-list="${id}"></ul></section>`,
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
      // U6: a culled column scrolled into view gets its tiles back.
      if (!ui.hFrame && $(".list[data-culled]", board))
        ui.hFrame = requestAnimationFrame(() => {
          ui.hFrame = 0;
          render();
        });
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
    estimation: store.state.estimation,
    hidePriority: vb.group === "priority",
    epics: store.state.epics,
    // DB-N9-20: the others dragging this card, from the stream's presence frame.
    draggedBy: draggedBy(store.state.presence, card.id, getSession().principal),
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
    if (virtual) node.style.top = `${GAP + (from + i) * (rowHeight() + GAP)}px`;
    const expected = prev ? prev.nextSibling : list.firstChild;
    if (node !== expected) list.insertBefore(node, expected);
    prev = node;
  });
  for (const n of keep.values()) n.remove();
  if (sizer) list.append(sizer);
}

function paintVirtual(list) {
  const cards = ui.columns.get(list.dataset.list) ?? [];
  if (cards.length <= VIRTUAL_THRESHOLD) return;
  if (list.dataset.culled) return;
  const stride = rowHeight() + GAP;
  const [first, last] = windowRange(
    list.scrollTop,
    list.clientHeight,
    stride,
    cards.length,
    OVERSCAN,
  );
  patchList(list, cards.slice(first, last), { virtual: true, from: first });
  syncFocusAttrs();
}

/** The columns inside the board's horizontal window (U6). */
function horizontalWindow() {
  const board = $(".board", ui.root);
  if (!board) return new Set(ui.layout.map((c) => c.id));
  const spans = $$(".col[data-col]", board).map((c) => ({
    id: c.dataset.col,
    left: c.offsetLeft,
    width: c.offsetWidth,
  }));
  return columnsInWindow(spans, board.scrollLeft, board.clientWidth || window.innerWidth);
}

/** An off-screen column keeps its scroll height and header, not its tiles. */
function cullList(list, cards) {
  if (list.dataset.culled === String(cards.length)) return;
  list.dataset.culled = String(cards.length);
  list.classList.add("virtual");
  for (const n of $$(":scope > .tile, :scope > .empty", list)) n.remove();
  let sizer = $(":scope > .sizer", list);
  if (!sizer) {
    sizer = document.createElement("div");
    sizer.className = "sizer";
    sizer.setAttribute("aria-hidden", "true");
    list.append(sizer);
  }
  sizer.style.height = `${cards.length * (rowHeight() + GAP) + GAP}px`;
  for (const c of cards) ui.html.delete(c.id);
}

function restoreScroll(list) {
  const want = ui.pendingScroll.get(list.dataset.list);
  if (want === undefined) return;
  ui.pendingScroll.delete(list.dataset.list);
  list.scrollTop = want;
}

function fillList(list, col, cards) {
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
    const text = label ? `No issues match “${label}”.` : col.empty;
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
    sizer.style.height = `${cards.length * (rowHeight() + GAP) + GAP}px`;
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
  const before = ui.colOf;

  if (s.loaded && s.cards.length === 0) {
    ui.layoutKey = "";
    // DS-TO-16 (dashboard item 10): start from a brief, or take over a repository someone left.
    ui.root.innerHTML = `<div class="board-empty">${brandMark(24)}<b>No issues yet.</b><span class="board-empty-acts"><button type="button" class="btn primary" data-empty-action="start">Start a project</button> <button type="button" class="btn" data-empty-action="takeover">Take over a project</button></span><span>Take over reads a repository someone else left, runs what it can once you trust it, and proposes a plan in Seshat.</span><span>From the terminal: <code>sekhemet plan "Build a tamper-evident ledger"</code></span></div>`;
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
    // A lane holds, and counts, only the cards some column shows.
    const defs = columnDefs();
    lanes.render(ui.root, onColumns(visibleCards(), defs), {
      group: vb.group,
      sortCards,
      tileOpts,
      columns: defs,
    });
    return;
  }
  if (ui.mode === "lanes") {
    ui.root.textContent = "";
    ui.layoutKey = "";
    ui.mode = "columns";
  }

  const m = model();
  ui.layout = m.columns;
  ui.columns = new Map(m.columns.map((c) => [c.id, c.cards]));
  ui.colOf = new Map(m.columns.flatMap((c) => c.cards.map((x) => [x.id, c.id])));
  paintChips(m.chips);
  ensureLayout(m.columns);
  const inView = horizontalWindow();

  for (const col of m.columns) {
    const head = $(`[data-head="${col.id}"]`, ui.root);
    const hh = headerHtml(col);
    if (head && head.dataset.html !== hh) {
      head.innerHTML = hh;
      head.dataset.html = hh;
    }
    const list = $(`[data-list="${col.id}"]`, ui.root);
    if (!inView.has(col.id) && col.cards.length > CULL_MIN) cullList(list, col.cards);
    else {
      delete list.dataset.culled;
      fillList(list, col, col.cards);
    }
  }

  syncFocusAttrs();
  // DB-P3-15: the focused card keeps focus when a frame replaced its node, and
  // is scrolled into view only when it changed column; no other card scrolls.
  const keep = focusAfterFrame(activeId, before, ui.colOf);
  if (keep && !document.activeElement?.closest?.(".tile")) {
    const node = document.getElementById(`tile-${keep.id}`);
    if (node) {
      node.focus({ preventScroll: true });
      if (keep.scroll) node.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  pinQueueColumns();
  scheduleJustNow();
}

/** The chips bar above the board, patched only when it changed. */
function paintChips(chips) {
  const html = chipsHtml(chips);
  const host = $(":scope > .col-chips", ui.root);
  if (host && host.outerHTML === html) return;
  const t = document.createElement("template");
  t.innerHTML = html;
  const fresh = t.content.firstElementChild;
  if (host) host.replaceWith(fresh);
  else ui.root.prepend(fresh);
}

/**
 * When the board scrolls sideways, In review and On hold stay pinned to the
 * right edge: the person's queue is never the part that gets scrolled away (§2.4.2).
 */
function pinQueueColumns() {
  const board = $(".board", ui.root);
  if (!board) return;
  const overflow = board.scrollWidth > board.clientWidth + 1;
  let right = 0;
  for (const col of $$(".col.queue", board).reverse()) {
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
  const colId = ui.colOf.get(id);
  if (!node && colId) {
    // Culled out sideways: give the column its tiles first (U6).
    const culled = $(`[data-list="${colId}"][data-culled]`, ui.root);
    const col = ui.layout.find((c) => c.id === colId);
    if (culled && col) {
      delete culled.dataset.culled;
      fillList(culled, col, col.cards);
      node = document.getElementById(`tile-${id}`);
    }
  }
  if (!node && colId) {
    // Windowed out: scroll its column so it materialises, then focus.
    const list = $(`[data-list="${colId}"]`, ui.root);
    const idx = list ? (ui.columns.get(colId) ?? []).findIndex((c) => c.id === id) : -1;
    if (list && idx >= 0) {
      list.scrollTop = Math.max(0, idx * (rowHeight() + GAP) - list.clientHeight / 2);
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
  return ui.layout
    .map((c) => c.id)
    .filter((id) => (ui.columns.get(id) ?? []).length > 0 && $(`[data-list="${id}"]`, ui.root));
}

function move(dx, dy, edge) {
  const cols = navColumns();
  if (cols.length === 0) return;
  const cur = store.card(store.state.focusedId);
  let ci = cur ? cols.indexOf(ui.colOf.get(cur.id)) : -1;
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
  if (k === "V" && e.shiftKey) {
    togglePipeline();
    return true;
  }
  if (k === "c") {
    createCard();
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
  return false;
}

/** Quick create (DB-P3-12): the card lands under the epic the board is filtered to. */
function createCard() {
  openCreate({ epicId: epicFromFilter(effectiveFilter(), store.state.epics) });
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

/** Pipeline stages on or off, kept per browser (DB-P3-3). */
function togglePipeline() {
  ui.pipeline = !ui.pipeline;
  writePipeline(storage(), ui.pipeline);
  // Each layout keeps its own column choices.
  loadChoices();
  toast({
    tone: "info",
    text: ui.pipeline ? "Pipeline stages: one column per stored state." : "The five board columns.",
  });
  render();
}

/** The empty board's two ways in (DS-TO-16): both open Seshat. */
async function emptyAction(action) {
  if (action === "start") {
    askMerit(START_PROJECT_OPENING);
    return;
  }
  togglePmPanel(true);
  toast({
    tone: "info",
    text: "Taking over this repository…",
    detail: "Seshat posts what it found.",
  });
  const r = await postJSON("/api/takeover", {});
  if (!r.ok) {
    toast({
      tone: "fail",
      text: "The take-over did not run.",
      detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
    });
  }
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const empty = t.closest("[data-empty-action]");
  if (empty) {
    emptyAction(empty.dataset.emptyAction);
    return;
  }
  if (t.closest("[data-create]")) {
    createCard();
    return;
  }
  if (t.closest("[data-pipeline]")) {
    togglePipeline();
    return;
  }
  const chip = t.closest("[data-chip-col]");
  if (chip) {
    const id = chip.dataset.chipCol;
    ui.expanded.add(id);
    ui.collapsed.delete(id);
    saveChoices();
    render();
    $(`[data-list="${id}"]`, ui.root)
      ?.closest(".col")
      ?.querySelector("h2")
      ?.scrollIntoView({ inline: "nearest" });
    return;
  }
  const menuBtn = t.closest("[data-colmenu]");
  if (menuBtn) {
    const status = menuBtn.dataset.colmenu;
    const col = ui.layout.find((c) => c.id === status);
    const cur = ui.sort[status] ?? defaultSort(col ?? { queue: false });
    const set = (mode) => () => {
      ui.sort[status] = mode;
      saveChoices();
      render();
    };
    const items = [
      { label: "Sort by priority", checked: cur === "priority", run: set("priority") },
      { label: "Sort by wait time", checked: cur === "wait", run: set("wait") },
      { label: "Sort by recently changed", checked: cur === "recent", run: set("recent") },
    ];
    items.push("-", {
      label: "Collapse column",
      run: () => {
        ui.expanded.delete(status);
        ui.collapsed.add(status);
        saveChoices();
        render();
      },
    });
    // The WIP reason, which the header shows only as a count, is the menu's
    // first line: reachable by keyboard and by touch (dashboard §2.14.2).
    openMenu(menuBtn, items, {
      heading: col?.label ?? status,
      note: menuBtn.getAttribute("aria-description") ?? "",
    });
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
  if (route?.params?.[0] === "map") return mapView.mount(view, route);
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
  ui.pipeline = readPipeline(storage());
  loadChoices();
  ui.mode = "columns";
  ui.layoutKey = "";
  ui.html.clear();
  container.addEventListener("click", onClick);
  // B11: drag (or Alt+Up/Down) to reorder cards within a column.
  bindReorder(container);
  // DB-N9-20: the others see this person's avatar on the card being dragged.
  container.addEventListener("dragstart", (e) => {
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    if (tile?.dataset.id) announceDrag(tile.dataset.id);
  });
  container.addEventListener("dragend", () => announceDrag(null));
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
