import { openCreate } from "./create.js";
// List / table view (PM_DESIGN §3.3): the board's cards as rows, with the
// same filter, grouping and selection, sortable columns and inline edits.
import { $, $$, esc, icon } from "./dom.js";
import { editField, fieldKey, selectionOrFocused } from "./fields.js";
import { epicFromFilter } from "./lib/create.js";
import {
  PRIORITY_LABELS,
  assigneeLabel,
  formatShortDate,
  groupCards,
  priorityOf,
  priorityRank,
  showsPoints,
} from "./lib/pm.js";
import {
  BOARD_COLUMN_ORDER,
  ISSUE_TYPE_LABELS,
  columnLabel,
  formatWait,
} from "./lib/vocabulary.js";
import { labelChips, pointsText, prioMark } from "./marks.js";
import { openPeek } from "./peek.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import {
  bindViewBar,
  cycleGroup,
  effectiveFilter,
  filterCards,
  focusFilter,
  matchContext,
  onViewChange,
  paintViewBar,
  vb,
} from "./viewbar.js";

const COLS = [
  { key: "priority", label: "Priority", cls: "c-prio", edit: "priority" },
  { key: "id", label: "ID", cls: "c-id" },
  { key: "title", label: "Title", cls: "c-title" },
  { key: "status", label: "State", cls: "c-state" },
  { key: "epicId", label: "Epic", cls: "c-epic", edit: "epicId" },
  { key: "cycleId", label: "Sprint", cls: "c-cycle", edit: "cycleId" },
  // Only with Preferences → Estimation on story points (DB-N7-2): see `cols()`.
  { key: "estimate", label: "Points", cls: "c-pts r", edit: "estimate" },
  { key: "labels", label: "Labels", cls: "c-labels", edit: "labels" },
  { key: "assignee", label: "Assignee", cls: "c-who", edit: "assignee" },
  { key: "dueDate", label: "Due", cls: "c-due", edit: "dueDate" },
  { key: "updatedAt", label: "Updated", cls: "c-upd r" },
];

/** The columns in force: Points only with Preferences → Estimation on story points (DB-N7-2). */
function cols() {
  return showsPoints(store.state.estimation) ? COLS : COLS.filter((c) => c.key !== "estimate");
}

const TONE = {
  running: () => '<span class="dot run" aria-hidden="true"></span>',
  pass: () => icon("check", 12, "ic s12 i-pass"),
  fail: () => icon("x", 12, "ic s12 i-fail"),
  parked: () => icon("pause", 12, "ic s12 i-park"),
  blocked: () => icon("link", 12, "ic s12 i-blk"),
  done: () => icon("check-circle", 12, "ic s12"),
};

const ui = {
  root: null,
  sort: { key: "priority", dir: 1 },
  collapsed: new Set(),
  anchorId: null,
  last: "",
};

function sortValue(c, key) {
  const s = store.state;
  switch (key) {
    case "priority":
      return priorityRank(c.priority);
    case "id":
      return c.display?.shortId ?? c.id;
    case "title":
      return (c.display?.title ?? c.title).toLowerCase();
    case "status":
      return BOARD_COLUMN_ORDER.indexOf(c.status);
    case "epicId":
      return s.epics.find((e) => e.id === c.epicId)?.title ?? "￿";
    case "cycleId":
      return s.cycles.find((x) => x.id === c.cycleId)?.startsOn ?? "￿";
    case "estimate":
      return c.estimate ?? -1;
    case "labels":
      return (c.labels ?? []).join(",") || "￿";
    case "assignee":
      return c.assignee ?? "￿";
    case "dueDate":
      return c.dueDate ?? "￿";
    case "updatedAt":
      return c.updatedAt ?? "";
    default:
      return "";
  }
}

function sorted(cards) {
  const { key, dir } = ui.sort;
  return cards
    .map((c, i) => [c, i])
    .sort((a, b) => {
      const va = sortValue(a[0], key);
      const vb2 = sortValue(b[0], key);
      const cmp = va < vb2 ? -1 : va > vb2 ? 1 : 0;
      return cmp * dir || priorityRank(a[0].priority) - priorityRank(b[0].priority) || a[1] - b[1];
    })
    .map(([c]) => c);
}

function cell(c, col) {
  const s = store.state;
  const d = c.display ?? {};
  const edit = (inner, label) =>
    col.edit && !(col.edit === "priority" && vb.group === "priority")
      ? `<button type="button" class="ed" data-edit="${col.edit}" aria-label="${esc(`${col.label}: ${label}. Change`)}">${inner}</button>`
      : inner;
  switch (col.key) {
    case "priority": {
      const p = priorityOf(c.priority);
      return edit(prioMark(p), PRIORITY_LABELS[p]);
    }
    case "id":
      return `<span class="mono">${esc(d.shortId ?? c.id)}</span>`;
    case "title": {
      const type = ISSUE_TYPE_LABELS[d.type];
      const kinds = type ? `<span class="kind">${esc(type.label)}</span>` : "";
      const ext = c.externalRef?.url
        ? `<a class="ext mono" href="${esc(c.externalRef.url)}" target="_blank" rel="noopener noreferrer" title="${esc(`Linked ${c.externalRef.system}: ${c.externalRef.id ?? c.externalRef.key ?? ""}`)}">${esc(c.externalRef.id ?? c.externalRef.key ?? "")}</a>`
        : "";
      return `<span class="t">${esc(d.title ?? c.title)}</span>${kinds}${ext}`;
    }
    case "status": {
      const tone = c.status === "done" ? "done" : d.tone;
      return `<span class="st">${TONE[tone]?.() ?? ""}<span>${esc(columnLabel(c.status))}</span></span>`;
    }
    case "epicId": {
      const t = s.epics.find((e) => e.id === c.epicId)?.title;
      return edit(t ? esc(t) : '<span class="none">–</span>', t ?? "none");
    }
    case "cycleId": {
      const t = s.cycles.find((x) => x.id === c.cycleId)?.name;
      return edit(t ? esc(t) : '<span class="none">–</span>', t ?? "none");
    }
    case "estimate": {
      const t = pointsText(c.estimate);
      return edit(
        t ? `<span class="tnum">${esc(t)}</span>` : '<span class="none">–</span>',
        t || "none",
      );
    }
    case "labels":
      return edit(
        labelChips(c.labels, 3) || '<span class="none">–</span>',
        (c.labels ?? []).join(", ") || "none",
      );
    case "assignee":
      return edit(
        c.assignee ? esc(assigneeLabel(c.assignee)) : '<span class="none">–</span>',
        assigneeLabel(c.assignee),
      );
    case "dueDate":
      return edit(
        c.dueDate
          ? `<span class="tnum">${esc(formatShortDate(c.dueDate))}</span>`
          : '<span class="none">–</span>',
        c.dueDate ? formatShortDate(c.dueDate) : "none",
      );
    case "updatedAt": {
      const t = Date.parse(c.updatedAt ?? "");
      return Number.isFinite(t)
        ? `<span class="tnum" title="${esc(c.updatedAt)}">${esc(formatWait(s.now - t))} ago</span>`
        : "";
    }
    default:
      return "";
  }
}

function rowHtml(c) {
  const sel = store.state.selected.has(c.id);
  return `<tr data-id="${esc(c.id)}" id="row-${esc(c.id)}" tabindex="-1" aria-selected="${sel}" class="${c.status === "done" ? "done" : ""}"><td class="c-sel"><span class="cbx${sel ? " on" : ""}" role="checkbox" aria-checked="${sel}" aria-label="Select" data-sel></span></td>${cols()
    .map((col) => `<td class="${col.cls}">${cell(c, col)}</td>`)
    .join("")}</tr>`;
}

function render() {
  if (!ui.root) return;
  const s = store.state;
  const cards = filterCards(s.cards);
  const project = s.meta?.project ?? "";
  const count =
    cards.length === s.cards.length
      ? `${s.cards.length} cards`
      : `${cards.length} of ${s.cards.length} cards`;
  setTopbar({ title: "Board", crumb: `${project}${project ? " · " : ""}${count}` });
  paintViewBar(
    $(".vbar-host", ui.root.parentElement),
    $(".cyc-host", ui.root.parentElement),
    "list",
  );

  const groups = groupCards(cards, vb.group, matchContext());
  const head = `<thead><tr><th class="c-sel"><span class="sr-only">Selected</span></th>${cols()
    .map((col) => {
      const on = ui.sort.key === col.key;
      const aria = on ? ` aria-sort="${ui.sort.dir > 0 ? "ascending" : "descending"}"` : "";
      return `<th class="${col.cls}"${aria}><button type="button" data-sort="${col.key}">${esc(col.label)}${on ? icon(ui.sort.dir > 0 ? "chevron-down" : "chevron-right", 10, "ic s10") : ""}</button></th>`;
    })
    .join("")}</tr></thead>`;
  let body = "";
  for (const g of groups) {
    const rows = sorted(g.cards);
    if (vb.group !== "none") {
      const shut = ui.collapsed.has(g.key);
      body += `<tr class="grp"><th colspan="${cols().length + 1}"><button type="button" data-grp="${esc(g.key)}" aria-expanded="${!shut}">${icon(shut ? "chevron-right" : "chevron-down", 12, "ic s12")}<b>${esc(g.label)}</b><span class="sec tnum">${g.cards.length} ${g.cards.length === 1 ? "card" : "cards"}${g.points && showsPoints(store.state.estimation) ? ` · ${g.points} pts` : ""}</span></button></th></tr>`;
      if (shut) continue;
    }
    body += rows.map(rowHtml).join("");
  }
  const empty = cards.length
    ? ""
    : `<div class="list-empty"><b>No cards match this view.</b><span>Clear a filter chip, or press <kbd>/</kbd> and change the query.</span></div>`;
  const html = `<div class="tbl-wrap list-wrap"><table class="tbl ltbl" aria-label="Cards" aria-multiselectable="true">${head}<tbody>${body}</tbody></table>${empty}</div>`;
  if (html === ui.last) return;
  const activeId = document.activeElement?.closest?.("tr[data-id]")?.dataset.id;
  const scroller = $(".list-wrap", ui.root);
  const top = scroller?.scrollTop ?? 0;
  ui.root.innerHTML = html;
  ui.last = html;
  $(".list-wrap", ui.root).scrollTop = top;
  syncFocus(activeId);
}

function rows() {
  return $$("tbody tr[data-id]", ui.root);
}

function syncFocus(activeId) {
  const all = rows();
  let id = store.state.focusedId;
  if (!all.some((r) => r.dataset.id === id)) id = all[0]?.dataset.id ?? null;
  for (const r of all) r.tabIndex = r.dataset.id === id ? 0 : -1;
  if (activeId) document.getElementById(`row-${activeId}`)?.focus({ preventScroll: true });
}

function focusRow(id) {
  if (!id) return;
  store.state.focusedId = id;
  const node = document.getElementById(`row-${id}`);
  for (const r of rows()) r.tabIndex = r === node ? 0 : -1;
  node?.focus({ preventScroll: true });
  node?.scrollIntoView({ block: "nearest" });
}

function toggle(id, on) {
  const sel = store.state.selected;
  if (on ?? !sel.has(id)) sel.add(id);
  else sel.delete(id);
  store.set({ selected: sel });
}

export function onKey(e) {
  const list = rows().map((r) => r.dataset.id);
  const id = store.state.focusedId;
  const i = list.indexOf(id);
  const k = e.key;
  if (k === "v") {
    location.hash = "#/board";
    return true;
  }
  if (k === "S" && e.shiftKey) {
    cycleGroup();
    return true;
  }
  if (k === "c") {
    // DB-P3-12: the same create form as the board.
    openCreate({ epicId: epicFromFilter(effectiveFilter(), store.state.epics) });
    return true;
  }
  const anchor = document.getElementById(`row-${id}`)?.querySelector(".c-title") ?? ui.root;
  if (fieldKey(e, selectionOrFocused(), anchor)) return true;
  if (k === "j" || k === "ArrowDown" || k === "J") {
    const next = list[Math.min(list.length - 1, i + 1)];
    if (k === "J") {
      toggle(id, true);
      toggle(next, true);
    }
    focusRow(next);
    return true;
  }
  if (k === "k" || k === "ArrowUp" || k === "K") {
    const prev = list[Math.max(0, i - 1)];
    if (k === "K") {
      toggle(id, true);
      toggle(prev, true);
    }
    focusRow(prev);
    return true;
  }
  if (k === "Home") {
    focusRow(list[0]);
    return true;
  }
  if (k === "End") {
    focusRow(list.at(-1));
    return true;
  }
  if (k === "x" && id) {
    toggle(id);
    ui.anchorId = id;
    return true;
  }
  if (k === " " && id) {
    openPeek(id, { returnFocus: document.getElementById(`row-${id}`) });
    return true;
  }
  if (k === "Enter" && id && !e.target.closest?.("button")) {
    location.hash = `#/card/${encodeURIComponent(id)}`;
    return true;
  }
  return false;
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const sortBtn = t.closest("[data-sort]");
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    ui.sort = ui.sort.key === key ? { key, dir: -ui.sort.dir } : { key, dir: 1 };
    render();
    return;
  }
  const grp = t.closest("[data-grp]");
  if (grp) {
    const k = grp.dataset.grp;
    if (ui.collapsed.has(k)) ui.collapsed.delete(k);
    else ui.collapsed.add(k);
    render();
    return;
  }
  const row = t.closest("tr[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  if (t.closest("[data-sel]") || e.metaKey || e.ctrlKey) {
    toggle(id);
    ui.anchorId = id;
    focusRow(id);
    return;
  }
  if (e.shiftKey && ui.anchorId) {
    const list = rows().map((r) => r.dataset.id);
    const [a, b] = [list.indexOf(ui.anchorId), list.indexOf(id)].sort((x, y) => x - y);
    const sel = store.state.selected;
    for (const x of list.slice(a, b + 1)) sel.add(x);
    store.set({ selected: sel });
    focusRow(id);
    return;
  }
  const ed = t.closest("[data-edit]");
  focusRow(id);
  ui.anchorId = id;
  if (ed) {
    const ids = store.state.selected.has(id) ? [...store.state.selected] : [id];
    editField(ed.dataset.edit, ids, ed);
  }
}

export function mount(view) {
  const outer = document.createElement("div");
  outer.className = "view-host";
  outer.innerHTML =
    '<div class="vbar-host"></div><div class="cyc-host"></div><div class="view-host list-host"></div>';
  view.append(outer);
  bindViewBar($(".vbar-host", outer));
  bindViewBar($(".cyc-host", outer));
  ui.root = $(".list-host", outer);
  ui.last = "";
  ui.root.addEventListener("click", onClick);
  ui.root.addEventListener("dblclick", (e) => {
    const row = e.target instanceof Element ? e.target.closest("tr[data-id]") : null;
    if (row && !e.target.closest("button"))
      location.hash = `#/card/${encodeURIComponent(row.dataset.id)}`;
  });
  ui.root.addEventListener("focusin", (e) => {
    const row = e.target.closest?.("tr[data-id]");
    if (row) store.state.focusedId = row.dataset.id;
  });
  const onSelectAll = (e) => {
    if (
      (e.metaKey || e.ctrlKey) &&
      e.key.toLowerCase() === "a" &&
      !/^(INPUT|TEXTAREA)$/.test(e.target.tagName)
    ) {
      e.preventDefault();
      store.set({ selected: new Set(rows().map((r) => r.dataset.id)) });
    }
  };
  document.addEventListener("keydown", onSelectAll);
  const unsub = store.on((_s, patch) => {
    if ("focusedId" in patch && Object.keys(patch).length === 1) return;
    render();
  });
  const offView = onViewChange(() => render());
  const focusFirst = () => focusRow(rows()[0]?.dataset.id);
  view.addEventListener("sekhemet:focus-first", focusFirst);
  render();
  return {
    onKey,
    focusFilter: () => focusFilter(outer),
    unmount() {
      unsub();
      offView();
      document.removeEventListener("keydown", onSelectAll);
      view.removeEventListener("sekhemet:focus-first", focusFirst);
      outer.remove();
      ui.root = null;
    },
  };
}
