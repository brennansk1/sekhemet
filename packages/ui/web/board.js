// Board (dashboard §2.4): the professional columns or pipeline stages, chips
// for empty columns, keyed tile patching and the keyboard. What the board shows
// is the pure model's (`lib/columns.js`, `lib/tiles.js`, dashboard P3).
import { openCreate } from "./create.js";
import { $, $$, brandMark, esc, icon, postJSON, tip } from "./dom.js";
import { fieldKey, selectionOrFocused } from "./fields.js";
import * as intakeView from "./intake.js";
import * as lanes from "./lanes.js";
import { tip as learnTip } from "./learn.js";
import { noteFor } from "./level_gate.js";
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
import { TRIAGE_COPY } from "./lib/intake.js";
import { columnLessonId } from "./lib/learn.js";
import { draggedBy } from "./lib/live.js";
import { formatQuery } from "./lib/pm.js";
import { boardFit, openColumn } from "./lib/reach.js";
import { START_ROUTE } from "./lib/start.js";
import { loadFailedText } from "./lib/switcher.js";
import { GATE_STATE_LABELS, formatDuration } from "./lib/vocabulary.js";
import * as listView from "./list.js";
import * as mapView from "./map.js";
import { openMenu } from "./overlay.js";
import { openPeek, peekOpenFor } from "./peek.js";
import { togglePmPanel } from "./pm_panel.js";
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
/** Comfortable density adds the first line of the description (§2.4.4; no budget on the tile, DB-N7-3). */
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
  /** How the columns sit (BRD-01): `fit`, `tight`, `split` or `one` (`lib/reach.js`). */
  fit: { mode: "fit", colMin: 200 },
  /** On a phone, the one column shown (the column switcher, §2.14.3). */
  phoneCol: null,
  /** The header controls (New issue, Ask Seshat) live in the shell's top bar. */
  topHandler: null,
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
    ? `<button class="more add" type="button" data-create data-needs="issue.create" data-needs-quiet${store.state.project?.id ? ` data-needs-project="${esc(store.state.project.id)}"` : ""} aria-label="${esc(QUICK_CREATE_COPY.plus)}" ${tip(QUICK_CREATE_COPY.plusTip)}>${icon("plus")}</button>`
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
  const toggle = `<button class="col-chip pipe-toggle" type="button" data-pipeline aria-pressed="${ui.pipeline ? "true" : "false"}" ${tip("Show each status as its own column (Shift+V).")}>Pipeline stages</button>`;
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
  // BRD-09: the board's two ways to add work, as the approved mockup has them.
  const projectAttr = store.state.project?.id
    ? ` data-needs-project="${esc(store.state.project.id)}"`
    : "";
  const actions = `<button class="btn top-ask" type="button" data-top-ask>${icon("chat", 14, "ic s14")}Ask Seshat</button><button class="btn primary top-create" type="button" data-top-create data-needs="issue.file" data-needs-quiet${projectAttr} aria-label="New issue" aria-keyshortcuts="C" title="New issue (C)">${icon("plus", 14, "ic s14")}<span class="lbl">New issue</span></button>`;
  setTopbar({ title: "Board", crumb: `${project}${project ? " · " : ""}${count}`, actions });
  paintViewBar(ui.barHost, ui.cycHost, "board");
}

/** The column's section, empty until filled. */
function sectionHtml(col) {
  const id = esc(col.id);
  return `<section class="col${col.queue ? " col-queue" : ""}" role="group" aria-labelledby="h-${id}" data-col="${id}"><div class="col-head" data-head="${id}"></div><ul class="list" role="listbox" aria-orientation="vertical" aria-labelledby="h-${id}" data-list="${id}"></ul></section>`;
}

/**
 * How the columns sit in this width (BRD-01, `boardFit`): all in view where
 * they fit, relaxed to 184 px at 1280 px and wider; else the queues in their
 * own pane; on a phone, one column.
 */
function fitFor(columns) {
  const width = ui.root.clientWidth || window.innerWidth;
  return boardFit(columns.length, width, {
    width: window.innerWidth,
    dockOpen: document.body.classList.contains("pm-open"),
  });
}

function ensureLayout(columns, fit) {
  const pinned = fit.mode === "split" ? columns.filter((c) => c.queue) : [];
  const key = `${fit.mode}:${columns.map((c) => c.id).join("|")}`;
  if (key === ui.layoutKey && $(".board", ui.root)) return false;
  ui.layoutKey = key;
  const frame = document.createElement("div");
  frame.className = "board-frame";
  frame.dataset.fit = fit.mode;
  const board = document.createElement("div");
  board.className = "board";
  board.setAttribute("role", "region");
  board.setAttribute("aria-label", "Board");
  frame.append(board);
  const oldFrame = $(".board-frame", ui.root);
  const old = $(".board", ui.root);
  const scroll = old ? old.scrollLeft : 0;
  const listScroll = new Map($$(".list", ui.root).map((l) => [l.dataset.list, l.scrollTop]));
  board.innerHTML = columns
    .filter((c) => !pinned.includes(c))
    .map(sectionHtml)
    .join("");
  if (pinned.length) {
    // The queues beside the scrolling columns, covering none of them (BRD-01).
    const pane = document.createElement("div");
    pane.className = "board-pin";
    pane.setAttribute("role", "region");
    pane.setAttribute("aria-label", "Your queue");
    pane.style.setProperty("--pin-col", `${fit.colMin}px`);
    pane.innerHTML = pinned.map(sectionHtml).join("");
    frame.append(pane);
  }
  ui.html.clear();
  if (oldFrame) oldFrame.replaceWith(frame);
  else ui.root.append(frame);
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
  for (const list of $$(".list", frame)) {
    // Lists are empty until filled; restore their scroll once tiles exist.
    ui.pendingScroll.set(list.dataset.list, listScroll.get(list.dataset.list) ?? 0);
    list.addEventListener("scroll", () => paintVirtual(list), { passive: true });
  }
  return true;
}

/**
 * A phone shows one column (§2.14.3, BRD-01): the switcher above the board
 * names each column with its count; the board opens on the first working one.
 */
function paintSwitcher(columns, fit) {
  let host = $(":scope > .col-switch", ui.root);
  if (fit.mode !== "one") {
    host?.remove();
    for (const c of $$(".col.on", ui.root)) c.classList.remove("on");
    return;
  }
  const ids = columns.map((c) => c.id);
  if (!ids.includes(ui.phoneCol)) ui.phoneCol = openColumn(ids) ?? null;
  const html = columns
    .map(
      (c) =>
        `<button type="button" data-switch-col="${esc(c.id)}" aria-pressed="${c.id === ui.phoneCol ? "true" : "false"}">${esc(c.label)}<span class="c tnum">${c.count}</span></button>`,
    )
    .join("");
  if (!host) {
    host = document.createElement("div");
    host.className = "col-switch";
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Columns on this board");
    $(".board-frame", ui.root)?.before(host);
  }
  if (host.innerHTML !== html) host.innerHTML = html;
  for (const c of $$(".col[data-col]", ui.root)) {
    c.classList.toggle("on", c.dataset.col === ui.phoneCol);
  }
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
    // Teams item 19: the Agent's state on the issue (`GET /api/agent/states`).
    ai: store.state.agentStates?.get?.(card.id),
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
  const inView = columnsInWindow(spans, board.scrollLeft, board.clientWidth || window.innerWidth);
  // The queue pane never scrolls, and a phone's one column is the one in view.
  for (const c of $$(".board-pin .col[data-col]", ui.root)) inView.add(c.dataset.col);
  if (ui.fit.mode === "one" && ui.phoneCol) inView.add(ui.phoneCol);
  return inView;
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

  // ERR-03: a failed read is never an empty board; it says so, with Retry.
  if (s.loaded && s.cards.length === 0 && s.boardError) {
    ui.layoutKey = "";
    const t = loadFailedText("the issues", s.boardError > 0 ? s.boardError : 0);
    ui.root.innerHTML = `<div class="board-empty" role="alert">${icon("alert", 24, "ic s24")}<b>${esc(t.title)}</b><span>${esc(t.detail)}</span><span class="board-empty-acts"><button type="button" class="btn" data-empty-action="retry">${icon("refresh", 14, "ic s14")}Try again</button></span></div>`;
    return;
  }
  if (s.loaded && s.cards.length === 0) {
    ui.layoutKey = "";
    // DS-TO-16 (dashboard item 10): start from a brief, or take over a repository someone left.
    ui.root.innerHTML = `<div class="board-empty">${brandMark(24)}<b>No issues yet.</b><span class="board-empty-acts"><button type="button" class="btn primary" data-empty-action="start">Start a project</button> <button type="button" class="btn" data-empty-action="takeover">Take over a project</button></span><span>Take over reads a repository someone else left, runs what it can once you trust it, and proposes a plan in Seshat.</span><span>From the terminal: <code>sekhemet plan "Build a timesheet app with overtime rules"</code></span></div>`;
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
  ui.fit = fitFor(m.columns);
  ensureLayout(m.columns, ui.fit);
  paintSwitcher(m.columns, ui.fit);
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
  openOnWorkingColumn();
  scheduleJustNow();
}

/** The chips bar above the board, patched only when it changed. */
function paintChips(chips) {
  paintBoardLevelNote();
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
 * DB-N9-17: where the viewer's level cannot create or move issues on this
 * board, the sentence is written once above it — the column `+` and the
 * tiles' drag carry it quietly (their title and description).
 */
function boardLevelNote() {
  const project = store.state.project?.id;
  const create = noteFor("issue.create", project);
  const move = noteFor("priority.change", project);
  // DB-N10-1: a Stakeholder still files from New issue, for triage.
  const files = create && !noteFor("issue.file", project) ? TRIAGE_COPY.filesForTriage : "";
  return [create, files, move && move !== create ? move.replace(/^You're [^.]*\. /, "") : ""]
    .filter(Boolean)
    .join(" ");
}

function paintBoardLevelNote() {
  const text = boardLevelNote();
  let el = $(":scope > .board-level-note", ui.root);
  if (!text) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement("p");
    el.className = "level-note board-level-note";
    ui.root.prepend(el);
  }
  if (el.textContent !== text) el.textContent = text;
}

/**
 * Until a person scrolls, a board wider than its window opens on the first
 * working column at its left edge — In progress where it shows (`openColumn`)
 * — or, where the scroll ends first, on the column before it, so no column
 * opens cut in half (BRD-01). The queues are in their own pane and need no pinning.
 */
function openOnWorkingColumn() {
  const board = $(".board", ui.root);
  if (!board || ui.userScrolled || ui.fit.mode === "one") return;
  const max = board.scrollWidth - board.clientWidth;
  if (max <= 1) return;
  const cols = $$(":scope > .col[data-col]", board);
  // One column gap in from the edge, so no sliver of the column before it shows.
  const gap = Number.parseFloat(getComputedStyle(board).columnGap) || 0;
  const at = (i) => (i === 0 ? 0 : cols[i].offsetLeft - gap);
  let i = Math.max(
    0,
    cols.findIndex((c) => c.dataset.col === openColumn(cols.map((x) => x.dataset.col))),
  );
  while (i > 0 && at(i) > max) i--;
  const want = Math.max(0, at(i));
  if (Math.abs(board.scrollLeft - want) > 1) {
    ui.autoScroll = true;
    board.scrollLeft = want;
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
  // A phone shows the focused card's column (h/l move between columns).
  if (ui.fit.mode === "one" && colId && colId !== ui.phoneCol) {
    ui.phoneCol = colId;
    paintSwitcher(ui.layout, ui.fit);
  }
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

/** Columns with cards, left to right as drawn: the scrolling columns, then the queue pane. */
function navColumns() {
  return $$(".col[data-col]", ui.root)
    .map((c) => c.dataset.col)
    .filter((id) => (ui.columns.get(id) ?? []).length > 0);
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
    text: ui.pipeline ? "Pipeline stages: one column per status." : "The five board columns.",
  });
  render();
}

/**
 * The empty board's two ways in: Start a project opens the start page with
 * its live draft (design-stage §2.11, DS-N7-1); Take over opens Seshat (DS-TO-16).
 */
async function emptyAction(action) {
  if (action === "start") {
    location.hash = START_ROUTE;
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
  if (empty?.dataset.emptyAction === "retry") {
    window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
    return;
  }
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
  const sw = t.closest("[data-switch-col]");
  if (sw) {
    ui.phoneCol = sw.dataset.switchCol;
    paintSwitcher(ui.layout, ui.fit);
    render();
    return;
  }
  const tile = t.closest(".tile");
  if (tile) {
    store.state.focusedId = tile.dataset.id;
    syncFocusAttrs();
    tile.classList.add("focus");
    // BRD-06: a click opens the issue's peek, as Linear, Jira and GitHub
    // Projects open an issue on click; a modifier click selects, as `x` does.
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      toggleSelect(tile.dataset.id);
      return;
    }
    if (t.closest("a, button, [data-pips]")) return;
    openPeek(tile.dataset.id, { returnFocus: tile });
  }
}

/** The top bar's New issue and Ask Seshat (BRD-09). */
function onTopClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest("[data-top-create]")) createCard();
  else if (t?.closest("[data-top-ask]")) {
    // Below 768 px the panel is hidden; the full Seshat view opens instead.
    if (window.innerWidth < 768) location.hash = "#/pm";
    else togglePmPanel(true);
  }
}

export function mount(view, route) {
  if (route?.params?.[0] === "list") return listView.mount(view, route);
  if (route?.params?.[0] === "map") return mapView.mount(view, route);
  // DB-N10-2: the Triage view, the untriaged issues with their four decisions.
  if (route?.params?.[0] === "triage") return intakeView.mount(view, route);
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
  // Each visit opens on the first working column again (BRD-01).
  ui.userScrolled = false;
  ui.phoneCol = null;
  container.addEventListener("click", onClick);
  ui.topHandler = onTopClick;
  document.getElementById("top")?.addEventListener("click", ui.topHandler);
  // B11: drag (or Alt+Up/Down) to reorder cards within a column.
  bindReorder(container);
  // DB-N9-20: the others see this person's avatar on the card being dragged.
  container.addEventListener("dragstart", (e) => {
    const tile = e.target instanceof Element ? e.target.closest(".tile") : null;
    if (tile?.dataset.id) announceDrag(tile.dataset.id);
  });
  container.addEventListener("dragend", () => announceDrag(null));
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
      document.getElementById("top")?.removeEventListener("click", ui.topHandler);
      outer.remove();
      ui.root = null;
    },
  };
}
