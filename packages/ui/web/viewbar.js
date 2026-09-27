// The board's view bar and cycle header (PM_DESIGN §3.2): Board | List | Story map,
// saved views, filter chips over a GitHub-style query, grouping, and the
// active cycle's progress. One filter object, shared by board and list.
import { esc, icon, kbd, tip } from "./dom.js";
import { cycleHeaderShown } from "./lib/burnup.js";
import {
  PRIORITY_LABELS,
  PRIORITY_NAMES,
  PRIORITY_ORDER,
  activeCycle,
  cycleProgress,
  formatQuery,
  formatShortDate,
  isFilterEmpty,
  matchCard,
  parseQuery,
  setTerm,
  slug,
  termValues,
} from "./lib/pm.js";
import { BOARD_COLUMN_ORDER, KIND_LABELS, columnLabel } from "./lib/vocabulary.js";
import { prioMark } from "./marks.js";
import { openMenu } from "./overlay.js";
import { openPicker, openPrompt } from "./picker.js";
import { askMerit } from "./pm_panel.js";
import { getSession } from "./session.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

const STATE_KEY = "sekhemet-board-view";
const VIEWS_KEY = "sekhemet-views";

export const BUILTIN_VIEWS = [
  { id: "all", name: "All cards", query: "" },
  { id: "cycle", name: "Current cycle", query: "cycle:current" },
  { id: "needs", name: "Needs you", query: "is:needs-you" },
  { id: "hot", name: "Urgent and high", query: "priority:urgent,high is:open" },
  { id: "unest", name: "Unestimated", query: "is:unestimated is:open" },
];

const GROUPS = [
  { id: "none", label: "None" },
  { id: "epic", label: "Epic" },
  { id: "assignee", label: "Assignee" },
  { id: "priority", label: "Priority" },
  { id: "cycle", label: "Cycle" },
];

const FIELD_NAMES = {
  priority: "Priority",
  label: "Label",
  epic: "Epic",
  cycle: "Cycle",
  owner: "Owner",
  delegate: "Delegate",
  kind: "Kind",
  state: "State",
  is: "Is",
};

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Private mode: this page only.
  }
}

const initial = load(STATE_KEY, {});
/** The shared view state. `draft` is the typed text not yet turned into chips. */
export const vb = {
  viewId: initial.viewId ?? "all",
  filter: parseQuery(initial.query ?? ""),
  group: initial.group ?? "none",
  draft: "",
};
const listeners = new Set();

function persist() {
  save(STATE_KEY, { viewId: vb.viewId, query: formatQuery(vb.filter), group: vb.group });
}

function changed() {
  persist();
  for (const fn of listeners) fn();
}

export function onViewChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function savedViews() {
  return load(VIEWS_KEY, []);
}

export function allViews() {
  return [...BUILTIN_VIEWS, ...savedViews()];
}

function currentView() {
  return allViews().find((v) => v.id === vb.viewId) ?? BUILTIN_VIEWS[0];
}

/** The filter in force: chips, plus the typed text (without a half-typed field token). */
export function effectiveFilter() {
  const words = vb.draft.split(/\s+/).filter((w) => w && !/^-?\w+:/.test(w));
  const text = [vb.filter.text, ...words].filter(Boolean).join(" ");
  return { terms: vb.filter.terms, text };
}

export function matchContext() {
  // DB-N5-5: `owner:@me` is the signed-in person (the install's person on Solo).
  const me = getSession().principal;
  return {
    ...(me ? { me } : {}),
    cycles: store.state.cycles,
    epics: store.state.epics,
    statusLabel: columnLabel,
  };
}

export function filterCards(cards) {
  const f = effectiveFilter();
  if (isFilterEmpty(f)) return cards;
  const ctx = matchContext();
  return cards.filter((c) => matchCard(c, f, ctx));
}

export function isDirty() {
  return (
    formatQuery(vb.filter) !== formatQuery(parseQuery(currentView().query)) ||
    vb.group !== (currentView().group ?? vb.group)
  );
}

export function setGroup(g) {
  vb.group = g;
  changed();
}

export function cycleGroup() {
  const i = GROUPS.findIndex((g) => g.id === vb.group);
  vb.group = GROUPS[(i + 1) % GROUPS.length].id;
  changed();
  toast({ text: `Grouped by ${GROUPS.find((g) => g.id === vb.group).label.toLowerCase()}` });
}

export function applyView(id) {
  const v = allViews().find((x) => x.id === id) ?? BUILTIN_VIEWS[0];
  vb.viewId = v.id;
  vb.filter = parseQuery(v.query);
  if (v.group) vb.group = v.group;
  vb.draft = "";
  changed();
}

/** A short phrase for Seshat's context chip: `Current cycle · 2 filters`. */
export function viewContextLabel() {
  const v = currentView();
  const n = vb.filter.terms.length + (vb.filter.text ? 1 : 0);
  const extra = isDirty() && n ? ` · ${n} ${n === 1 ? "filter" : "filters"}` : "";
  return `${v.name}${extra}`;
}

/* ---------- Term values: labels and options ---------- */

function valueLabel(field, v) {
  const s = store.state;
  switch (field) {
    case "priority": {
      const p = Object.entries(PRIORITY_NAMES).find(([, n]) => n === v)?.[0];
      return p !== undefined ? PRIORITY_LABELS[p] : v;
    }
    case "epic":
      return v === "none"
        ? "No epic"
        : (s.epics.find((e) => e.id.toLowerCase() === v || slug(e.title) === slug(v))?.title ?? v);
    case "cycle":
      if (v === "current") return activeCycle(s.cycles)?.name ?? "Current";
      if (v === "next") return "Next";
      if (v === "none") return "No cycle";
      return s.cycles.find((c) => c.id.toLowerCase() === v || slug(c.name) === slug(v))?.name ?? v;
    case "owner":
    case "delegate":
      return personValueLabel(field, v);
    case "kind":
      return KIND_LABELS[v]?.label ?? v;
    case "state":
      return columnLabel(v);
    case "is":
      return (
        {
          "needs-you": "Needs you",
          blocked: "Blocked",
          running: "Running",
          unestimated: "Unestimated",
          done: "Done",
          open: "Open",
          started: "Started",
        }[v] ?? v
      );
    default:
      return v;
  }
}

/** An owner or delegate value in words: You, Worker, a person's name, or none. */
function personValueLabel(field, v) {
  if (v === "none") return field === "owner" ? "No owner" : "No delegate";
  if (v === "@me" || v === "me" || v === "you") return "You";
  if (v === "worker") return "Worker";
  for (const c of store.state.cards) {
    if (field === "owner" && c.owner?.toLowerCase() === v && c.display?.ownerName)
      return c.display.ownerName;
    if (field === "delegate" && c.delegate?.id?.toLowerCase() === v && c.display?.delegateName)
      return c.display.delegateName;
  }
  return v;
}

/** The people on the board's cards, as filter options (principal, name). */
function peopleOptions(field, opt) {
  const seen = new Map();
  const me = getSession().principal;
  for (const c of store.state.cards) {
    const id = field === "owner" ? c.owner : c.delegate?.kind === "person" ? c.delegate.id : "";
    const name = field === "owner" ? c.display?.ownerName : c.display?.delegateName;
    if (id && id !== me && !seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), name || id);
  }
  return [...seen].map(([id, name]) => opt(id, name));
}

function optionsFor(field) {
  const s = store.state;
  const cur = new Set(termValues(vb.filter, field));
  const opt = (value, label, html = "", detail = "") => ({
    value,
    label,
    html,
    detail,
    checked: cur.has(value),
  });
  switch (field) {
    case "priority":
      return PRIORITY_ORDER.map((p) => opt(PRIORITY_NAMES[p], PRIORITY_LABELS[p], prioMark(p)));
    case "label": {
      const all = new Set();
      for (const c of s.cards) for (const l of c.labels ?? []) all.add(l.toLowerCase());
      return [
        ...[...all].sort().map((l) => opt(l, l, icon("tag", 12, "ic s12"))),
        opt("none", "No labels"),
      ];
    }
    case "epic":
      return [...s.epics.map((e) => opt(slug(e.title), e.title)), opt("none", "No epic")];
    case "cycle": {
      const list = [];
      if (activeCycle(s.cycles))
        list.push(opt("current", `Current · ${activeCycle(s.cycles).name}`));
      for (const c of s.cycles)
        if (c.state !== "active")
          list.push(opt(slug(c.name), c.name, "", c.state === "planned" ? "Planned" : "Closed"));
      list.push(opt("none", "No cycle"));
      return list;
    }
    case "owner":
      return [opt("@me", "You"), ...peopleOptions("owner", opt), opt("none", "No owner")];
    case "delegate":
      return [
        opt("worker", "Worker"),
        opt("@me", "You"),
        ...peopleOptions("delegate", opt),
        opt("none", "No delegate"),
      ];
    case "kind":
      return Object.entries(KIND_LABELS).map(([k, v]) => opt(k, v.label));
    case "state":
      return BOARD_COLUMN_ORDER.map((st) => opt(st, columnLabel(st)));
    case "is":
      return ["needs-you", "blocked", "running", "unestimated", "open", "done"].map((v) =>
        opt(v, valueLabel("is", v)),
      );
    default:
      return [];
  }
}

function editTerm(field, anchor) {
  openPicker(anchor, {
    heading: `${FIELD_NAMES[field]} is any of`,
    multi: true,
    options: optionsFor(field),
    onChange: (values) => {
      vb.filter = setTerm(vb.filter, field, values);
      changed();
    },
    footer: "Space toggles · Esc closes",
  });
}

/* ---------- Rendering ---------- */

function chipHtml(t) {
  const name = FIELD_NAMES[t.field] ?? t.field;
  const vals = t.values.map((v) => valueLabel(t.field, v));
  const shown =
    vals.length > 2 ? `${vals.slice(0, 2).join(", ")} +${vals.length - 2}` : vals.join(", ");
  return `<span class="fchip${t.negate ? " neg" : ""}"><button type="button" data-edit-term="${esc(t.field)}"${t.negate ? " disabled" : ""} title="${esc(`${name} ${t.negate ? "is not" : "is"} ${vals.join(", ")}`)}"><span class="sec">${esc(name)}${t.negate ? " is not" : ""}:</span> ${esc(shown)}</button><button type="button" class="x" data-rm-term="${esc(`${t.negate ? "-" : ""}${t.field}`)}" aria-label="${esc(`Remove ${name} filter`)}">${icon("x", 12, "ic s12")}</button></span>`;
}

export function viewBarHtml(layout) {
  const v = currentView();
  const chips = vb.filter.terms.map(chipHtml).join("");
  const group = GROUPS.find((g) => g.id === vb.group) ?? GROUPS[0];
  const save =
    isDirty() && !isFilterEmpty(vb.filter)
      ? `<button class="btn sm ghost" type="button" data-save-view>Save view</button>`
      : "";
  return `<div class="vbar" role="toolbar" aria-label="View and filters">
<div class="lseg" role="tablist" aria-label="Layout"><a role="tab" href="#/board" aria-selected="${layout === "board"}" title="Board (v)">${icon("board", 14, "ic s14")}<span>Board</span></a><a role="tab" href="#/board/list" aria-selected="${layout === "list"}" title="List (v)">${icon("list", 14, "ic s14")}<span>List</span></a><a role="tab" href="#/board/map" aria-selected="${layout === "map"}" ${tip("Story map: epics across, release slices beneath")}>${icon("layers", 14, "ic s14")}<span>Story map</span></a></div>
<button class="vsel" type="button" data-view-menu aria-haspopup="dialog"><span class="sec">View:</span> <b>${esc(v.name)}</b>${icon("chevron-down", 12, "ic s12")}</button>
<div class="chips">${chips}<button class="filter" type="button" data-add-filter aria-haspopup="menu">${icon("filter", 12, "ic s12")}Filter</button></div>
<label class="q">${icon("search", 12, "ic s12")}<input type="text" data-q value="${esc([vb.filter.text, vb.draft].filter(Boolean).join(" "))}" placeholder="Filter by title, or type label:api" aria-label="Filter cards. Accepts priority:, label:, epic:, cycle:, owner:, delegate:, kind:, is:" spellcheck="false">${kbd("/")}</label>
<div class="vr"><button class="vsel" type="button" data-group-menu title="Group into swimlanes (⇧S)" aria-description="Group into swimlanes" aria-keyshortcuts="Shift+S">${icon("layers", 12, "ic s12")}<span class="sec">Group:</span> <b>${esc(group.label)}</b></button>${save}</div>
</div>`;
}

/* ---------- Cycle header ---------- */

export function showsCycle() {
  // Shown whenever a cycle is in force, unless the filter points elsewhere
  // (another cycle, or cycle:none): the pure rule, DB-P3-14.
  return cycleHeaderShown(store.state.cycles, vb.filter, Date.now());
}

export function cycleHeaderHtml() {
  if (!showsCycle()) return "";
  const s = store.state;
  const cycle = activeCycle(s.cycles);
  const p = cycleProgress(cycle, s.cards, s.now);
  const pts = p.points;
  const pct = (n) => (pts.total ? `${(n / pts.total) * 100}%` : "0%");
  const left =
    p.daysLeft === 0 ? "Ends today" : `${p.daysLeft} ${p.daysLeft === 1 ? "day" : "days"} left`;
  const leftTitle =
    p.behindBy > 0
      ? `Behind the linear pace by ${p.behindBy} pts.`
      : p.behindBy < 0
        ? `Ahead of the linear pace by ${-p.behindBy} pts.`
        : "On the linear pace.";
  const unest = p.unestimated ? ` · ${p.unestimated} unestimated, counted as 1 pt` : "";
  return `<section class="cyc" aria-label="${esc(`${cycle.name} progress`)}">
<div class="cyc-a"><b>${esc(cycle.name)}</b>${cycle.goal ? `<span class="goal">${esc(cycle.goal)}</span>` : ""}<span class="dates tnum">${esc(formatShortDate(cycle.startsOn))} – ${esc(formatShortDate(cycle.endsOn))} · <span class="${p.atRisk ? "risk" : ""}" title="${esc(leftTitle)}">${esc(left)}</span></span></div>
<div class="cyc-b"><div class="cbar" role="img" aria-label="${esc(`${pts.done} of ${pts.total} points done, ${pts.started} in progress, ${pts.notStarted} not started`)}"><i class="d" style="width:${pct(pts.done)}"></i><i class="s" style="width:${pct(pts.started)}"></i><span class="pace" style="left:${(p.elapsedRatio * 100).toFixed(1)}%" title="${esc(`Where a straight line would be today. ${leftTitle}`)}"></span></div>
<span class="cnums tnum"><b>${pts.done} of ${pts.total} pts done</b> · ${pts.started} in progress · ${pts.notStarted} not started${esc(unest)}</span>
<button class="btn sm" type="button" data-plan-cycle>${icon("chat", 12, "ic s12")}Plan next cycle with Seshat</button></div>
</section>`;
}

/* ---------- Behaviour ---------- */

function commitDraft(input) {
  const typed = parseQuery(input.value);
  if (typed.terms.length) {
    let f = vb.filter;
    for (const t of typed.terms) {
      if (t.negate)
        f = {
          terms: [...f.terms.filter((x) => !(x.field === t.field && x.negate)), t],
          text: f.text,
        };
      else f = setTerm(f, t.field, [...new Set([...termValues(f, t.field), ...t.values])]);
    }
    vb.filter = { terms: f.terms, text: typed.text };
  } else {
    vb.filter = { terms: vb.filter.terms, text: typed.text };
  }
  vb.draft = "";
  changed();
}

/** Wire one view bar host. `onChange` re-renders the owning view. */
export function bindViewBar(host) {
  let timer = 0;
  host.addEventListener("input", (e) => {
    const input =
      e.target instanceof HTMLInputElement && e.target.matches("[data-q]") ? e.target : null;
    if (!input) return;
    clearTimeout(timer);
    // A completed field token (`label:api `) becomes a chip at once.
    if (/(^|\s)-?\w+:\S+\s$/.test(input.value)) {
      commitDraft(input);
      return;
    }
    timer = setTimeout(() => {
      vb.filter = { terms: vb.filter.terms, text: "" };
      vb.draft = input.value;
      for (const fn of listeners) fn({ typing: true });
    }, 120);
  });
  host.addEventListener("keydown", (e) => {
    const input =
      e.target instanceof HTMLInputElement && e.target.matches("[data-q]") ? e.target : null;
    if (!input) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft(input);
      input.blur();
      document.getElementById("view")?.dispatchEvent(new CustomEvent("sekhemet:focus-first"));
    } else if (
      e.key === "Backspace" &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0 &&
      vb.filter.terms.length
    ) {
      vb.filter = { terms: vb.filter.terms.slice(0, -1), text: vb.filter.text };
      changed();
    }
  });
  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const edit = t.closest("[data-edit-term]");
    if (edit) return editTerm(edit.dataset.editTerm, edit);
    const rm = t.closest("[data-rm-term]");
    if (rm) {
      const key = rm.dataset.rmTerm;
      const neg = key.startsWith("-");
      const field = key.replace(/^-/, "");
      vb.filter = {
        terms: vb.filter.terms.filter((x) => !(x.field === field && Boolean(x.negate) === neg)),
        text: vb.filter.text,
      };
      changed();
      return;
    }
    const add = t.closest("[data-add-filter]");
    if (add) {
      openMenu(
        add,
        Object.keys(FIELD_NAMES).map((f) => ({
          label: FIELD_NAMES[f],
          run: () => setTimeout(() => editTerm(f, add), 0),
        })),
        { heading: "Filter by" },
      );
      return;
    }
    const vm = t.closest("[data-view-menu]");
    if (vm) {
      const saved = savedViews();
      openPicker(vm, {
        heading: "Views",
        search: false,
        options: [
          ...allViews().map((v) => ({
            value: v.id,
            label: v.name,
            detail: v.query || "Everything on the board",
            checked: v.id === vb.viewId,
          })),
          ...(saved.some((v) => v.id === vb.viewId)
            ? [{ value: "__delete__", label: `Delete “${currentView().name}”` }]
            : []),
        ],
        footer: "Saved views are kept in this browser.",
        onPick: (id) => {
          if (id === "__delete__") {
            save(
              VIEWS_KEY,
              saved.filter((v) => v.id !== vb.viewId),
            );
            applyView("all");
            return;
          }
          applyView(id);
        },
      });
      return;
    }
    const gm = t.closest("[data-group-menu]");
    if (gm) {
      openMenu(
        gm,
        GROUPS.map((g) => ({
          label: g.label,
          checked: g.id === vb.group,
          run: () => setGroup(g.id),
        })),
        { heading: "Group into swimlanes" },
      );
      return;
    }
    const sv = t.closest("[data-save-view]");
    if (sv) {
      openPrompt(sv, {
        heading: "Save view as",
        placeholder: "e.g. API work this cycle",
        onSubmit: (name) => {
          const id = `v_${Date.now().toString(36)}`;
          save(VIEWS_KEY, [
            ...savedViews(),
            { id, name, query: formatQuery(vb.filter), group: vb.group },
          ]);
          vb.viewId = id;
          changed();
          toast({ tone: "pass", text: `Saved view “${name}”`, detail: "Kept in this browser." });
        },
      });
      return;
    }
    if (t.closest("[data-plan-cycle]")) {
      askMerit("Plan the next cycle");
    }
  });
}

/** `/` from the board or list. */
export function focusFilter(root = document) {
  const input = root.querySelector(".vbar [data-q]");
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

window.sekhemetViewContext = () => {
  const r = store.state.route;
  return r?.name === "board" ? viewContextLabel() : "";
};

/**
 * Paint the view bar and cycle header into their hosts, only when changed,
 * keeping focus and the caret in the filter box across repaints.
 */
export function paintViewBar(barHost, cycHost, layout) {
  const html = viewBarHtml(layout);
  if (barHost.dataset.html !== html) {
    const input = barHost.querySelector("[data-q]");
    const had = input && document.activeElement === input;
    const sel = had ? [input.selectionStart, input.selectionEnd] : null;
    barHost.innerHTML = html;
    barHost.dataset.html = html;
    if (had) {
      const next = barHost.querySelector("[data-q]");
      next.focus();
      next.setSelectionRange(
        Math.min(sel[0], next.value.length),
        Math.min(sel[1], next.value.length),
      );
    }
  }
  if (cycHost) {
    const c = cycleHeaderHtml();
    if (cycHost.dataset.html !== c) {
      cycHost.innerHTML = c;
      cycHost.dataset.html = c;
    }
  }
}
