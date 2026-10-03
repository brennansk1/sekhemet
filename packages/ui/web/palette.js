// Command palette (FRONTEND_DESIGN §2.5.10): grouped, fuzzy, with shortcuts.
import { openCheatsheet } from "./cheatsheet.js";
import { MOD, copyText, esc, getJSON, icon, kbd } from "./dom.js";
import { runIssueAction } from "./issue_actions.js";
import { tipsOn, toggleTips } from "./learn.js";
import { ACCOUNT_COPY } from "./lib/account.js";
import { issueActions } from "./lib/issue_actions.js";
import { paletteGoTo } from "./lib/nav.js";
import { searchHits, searchWords } from "./lib/search.js";
import { paletteSeshat } from "./lib/seshat.js";
import { START_ROUTE } from "./lib/start.js";
import { ISSUE_TYPE_LABELS, columnLabel } from "./lib/vocabulary.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { askSeshat } from "./pm_panel.js";
import { currentContext } from "./pm_thread.js";
import { followProject, visibleProjects } from "./project_filter.js";
import { getSession, signOutAndLeave } from "./session.js";
import { currentNav, setDensity, toggleTheme } from "./shell.js";
import { sprintPaletteItems } from "./sprints.js";
import { store } from "./store.js";
import { openProjectSwitcher, openWorkspaceSwitcher } from "./switcher.js";
import { toast } from "./toast.js";

let open = null;

/**
 * Fuzzy score of `query` against `text`: every query character must appear in
 * order. Contiguous runs and word starts score higher; a prefix scores most.
 * Returns { score, hits } or null.
 */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, hits: [] };
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const wordStart = direct === 0 || /[\s_\-/.(]/.test(t[direct - 1]);
    const hits = Array.from({ length: q.length }, (_, i) => direct + i);
    return {
      score: 100 + (wordStart ? 50 : 0) + (direct === 0 ? 50 : 0) - direct * 0.1 - t.length * 0.01,
      hits,
    };
  }
  const hits = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    score += at === prev + 1 ? 5 : 1;
    if (at === 0 || /[\s_\-/.]/.test(t[at - 1])) score += 3;
    hits.push(at);
    prev = at;
    ti = at + 1;
  }
  // Letters scattered across unrelated words are noise, not a match.
  if (score < q.length * 3) return null;
  return { score, hits };
}

function highlight(text, hits) {
  const set = new Set(hits);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = esc(text[i]);
    out += set.has(i) ? `<mark>${c}</mark>` : c;
  }
  return out;
}

const STATE_ICON = {
  running: () => '<span class="dot run" aria-hidden="true"></span>',
  pass: () => icon("check", 12, "ic s12 i-pass"),
  fail: () => icon("x", 12, "ic s12 i-fail"),
  parked: () => icon("pause", 12, "ic s12 i-park"),
  blocked: () => icon("link", 12, "ic s12 i-blk"),
  neutral: () => "",
};

function goTo(hash) {
  return () => {
    location.hash = hash;
  };
}

/** Go to: every shown view from the one keymap (lib/nav.js), then the list and the panel. */
function views() {
  return [
    ...paletteGoTo(currentNav()).map((p) => ({
      label: `Go to ${p.label}${p.sub ? `, ${p.sub}` : ""}`,
      search: p.search,
      keys: p.keys,
      run: goTo(p.route),
    })),
    {
      label: "Go to List",
      search: "Board list table view",
      keys: ["v"],
      run: goTo("#/board/list"),
    },
    {
      label: "Go to Story map",
      search: "Board story map releases requirements burn-up",
      run: goTo("#/board/map"),
    },
    {
      label: "Talk to Seshat, the project manager",
      search: "Seshat project manager chat ask",
      keys: [`${MOD}J`],
      run: () => window.dispatchEvent(new CustomEvent("sekhemet:open-pm")),
    },
  ];
}

/** Compact (88px tiles) or comfortable (112px: the first line of the issue's description, BRD-13). */
export function toggleDensity() {
  // The same setting as Configuration › Preferences › Density ("sekhemet-density").
  setDensity(
    document.documentElement.dataset.density === "comfortable" ? "compact" : "comfortable",
  );
}

function prefs() {
  return [
    // No bare key for theme (§2.3.2).
    { label: "Switch theme", search: "theme dark light", run: toggleTheme },
    {
      label: "Switch density (compact or comfortable)",
      search: "density comfortable compact tile description line",
      run: toggleDensity,
    },
    // Tips, the Learn layer (§2.9.1): explain each column, check and chart where it is.
    {
      label: tipsOn() ? "Turn tips off" : "Turn tips on",
      search: "tips learn explain help beginner teach",
      run: toggleTips,
    },
    { label: "Keyboard shortcuts", keys: ["?"], run: () => setTimeout(openCheatsheet, 0) },
    // DB-N25-4: the two switchers, from anywhere.
    ...(store.state.project?.list?.length
      ? [
          {
            label: "Switch project…",
            search: "switch project change current",
            run: () =>
              setTimeout(() => {
                const anchor =
                  document.querySelector("#side [data-project-switch]") ??
                  document.getElementById("view-title");
                if (anchor) openProjectSwitcher(anchor);
              }, 0),
          },
        ]
      : []),
    {
      label: `${ACCOUNT_COPY.switchWorkspace}…`,
      search: "switch workspace server open another",
      run: () => setTimeout(openWorkspaceSwitcher, 0),
    },
    // The account menu's pages are in the palette, with no chord (§2.2.1).
    {
      label: ACCOUNT_COPY.profile,
      search: "profile account tokens sessions",
      run: () => {
        location.hash = "#/account/profile";
      },
    },
    ...(getSession().mode === "team"
      ? [
          {
            label: ACCOUNT_COPY.members,
            search: "members people invite levels access team",
            run: () => {
              location.hash = "#/members";
            },
          },
          // Audit is an Admin's (TEAM-27); the palette offers it to no one else.
          ...(getSession().level === "admin"
            ? [
                {
                  label: ACCOUNT_COPY.audit,
                  search: "audit log sign-ins refusals levels invites tokens export",
                  run: () => {
                    location.hash = "#/audit";
                  },
                },
              ]
            : []),
          { label: ACCOUNT_COPY.signOut, search: "sign out log out", run: signOutAndLeave },
        ]
      : []),
  ];
}

/** Actions for the card the keyboard is on (§2.5.10 group 1). */
function cardActions(actions) {
  const card = store.card(store.state.focusedId);
  if (!card) return [];
  const title = card.display?.title ?? card.title;
  const out = [];
  const run = (key) => () => actions?.(key, card);
  if (card.status === "review")
    out.push({ label: `Accept “${title}”`, search: "Accept", keys: ["a"], run: run("a") });
  if (card.display?.evidence)
    out.push({
      label: `Request changes on “${title}”`,
      search: "Request changes return",
      keys: ["r"],
      run: run("r"),
    });
  if (card.status !== "parked" && card.status !== "done")
    out.push({
      label: `Put “${title}” on hold`,
      search: "Put on hold",
      keys: ["p"],
      run: run("p"),
    });
  // NEW-dashboard-21: the closing and reopening actions, in NAMING's words.
  for (const a of issueActions(card)) {
    out.push({
      label: `${a.label} “${title}”`,
      search: `${a.label} ${a.id === "wontdo" ? "close reject" : a.id}`,
      run: () => void runIssueAction(a.id, card),
    });
  }
  out.push({
    label: `Open “${title}”`,
    search: "Open issue",
    keys: ["↵"],
    run: goTo(`#/card/${encodeURIComponent(card.id)}`),
  });
  out.push({
    label: "Copy issue ID",
    search: "Copy issue ID",
    run: async () =>
      toast({
        text: (await copyText(card.id)) ? `Copied ${card.id}` : "Couldn't copy to the clipboard.",
      }),
  });
  return out;
}

function cardItems() {
  const here = store.state.cards.map((c) => {
    const d = c.display ?? {};
    const kinds = ISSUE_TYPE_LABELS[d.type]?.label ?? "";
    return {
      label: d.title ?? c.title,
      search: `${d.title ?? c.title} ${d.shortId ?? ""}`,
      shortId: (d.shortId ?? "").toLowerCase(),
      meta: `${STATE_ICON[d.tone ?? "neutral"]?.() ?? ""}${esc(columnLabel(c.status))}${kinds ? ` · ${esc(kinds)}` : ""}`,
      run: goTo(`#/card/${encodeURIComponent(c.id)}`),
      card: c,
    };
  });
  // DB-N26-2: the issues of the other projects this person can see, each
  // named with its project; opening one makes that project current.
  const seen = new Set(store.state.cards.map((c) => c.id));
  const visible = new Set(visibleProjects().map((p) => p.id));
  const others = (open?.others ?? [])
    .filter((i) => !seen.has(i.id) && i.project && visible.has(i.project.id))
    .map((i) => ({
      label: i.title,
      search: `${i.title} ${i.id} ${i.project.name}`,
      shortId: i.id.toLowerCase(),
      meta: `<span class="po-proj">${esc(i.project.name)}</span> · ${esc(columnLabel(i.status))}`,
      run: () => {
        followProject(i.project.id);
        location.hash = `#/card/${encodeURIComponent(i.id)}`;
      },
      card: { id: i.id, status: i.status, display: {} },
    }));
  return [...here, ...others];
}

/**
 * DB-N12-1: the full-text search's issues for the typed words — matched in
 * the title, key, description, acceptance criteria or a comment, Done and
 * Won't do included, across every project the person can see — each with its
 * key, project, column and the matched words in context.
 */
function textItems(q) {
  const found = open?.search;
  if (!found || found.q !== q) return [];
  return searchHits(found.rows, q).map((h) => ({
    label: h.title,
    hits: [],
    shortId: h.key.toLowerCase(),
    meta: `<span class="mono">${esc(h.key)}</span>${h.project ? ` · <span class="po-proj">${esc(h.project.name)}</span>` : ""} · ${esc(h.column)}`,
    context: `<span class="sr-only">${esc(h.where)}: </span>${h.context
      .map((c) => (c.hit ? `<mark>${esc(c.text)}</mark>` : esc(c.text)))
      .join("")}`,
    run: () => {
      if (h.project) followProject(h.project.id);
      location.hash = `#/card/${encodeURIComponent(h.id)}`;
    },
    card: { id: h.id, display: {} },
  }));
}

/** The words the palette searches for: the query without its `>` or `#` prefix. */
function searchedText(value) {
  const raw = value.trim();
  return raw.startsWith(">") ? "" : raw.replace(/^#/, "").trim();
}

/** Ask the server's full-text search, once the typing pauses (DB-N12-1). */
function scheduleSearch(state) {
  clearTimeout(state.searchTimer);
  const q = searchedText(state.input.value);
  if (q.length < 2 || searchWords(q).length === 0) {
    state.search = null;
    return;
  }
  state.searchTimer = setTimeout(async () => {
    const r = await getJSON(`/api/search?q=${encodeURIComponent(q)}&limit=8`).catch(() => ({
      ok: false,
    }));
    if (!r.ok || open !== state || searchedText(state.input.value) !== q) return;
    state.search = { q, rows: r.data?.hits ?? [] };
    render();
  }, 120);
}

/** DB-N26-2: the issues of every project this person can see, read once as the palette opens. */
async function loadOtherIssues(state) {
  if (visibleProjects().length < 2) return;
  const r = await getJSON("/api/issues/search?limit=200").catch(() => ({ ok: false }));
  if (!r.ok || open !== state) return;
  state.others = r.data?.issues ?? [];
  render();
}

function build(query, actions) {
  let q = query.trim();
  let only = null;
  if (q.startsWith(">")) {
    only = "commands";
    q = q.slice(1).trim();
  } else if (q.startsWith("#")) {
    only = "cards";
    q = q.slice(1).trim();
  }
  const rank = (items, field = "label") =>
    items
      .map((it) => {
        const target = it.search ?? it[field];
        const m = fuzzy(q, target);
        if (!m) return null;
        const labelHits = it.search ? (fuzzy(q, it.label)?.hits ?? []) : m.hits;
        const idBonus = it.shortId && q && it.shortId.startsWith(q.toLowerCase()) ? 200 : 0;
        return { ...it, score: m.score + idBonus, hits: labelHits };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

  const groups = [];
  if (only === "commands" || (!only && !q)) {
    const acts = rank(cardActions(actions));
    if (acts.length) groups.push({ name: "Actions on focused issue", items: acts });
  }
  if (only !== "commands") {
    let cards = rank(cardItems());
    // DB-N12-1: the full-text search's issues first, best match first.
    const found = textItems(q);
    if (found.length) {
      const ids = new Set(found.map((f) => f.card.id));
      cards = [...found, ...cards.filter((c) => !ids.has(c.card.id))];
    }
    if (!q) {
      // Empty query: the cards that need a person first.
      cards = cards.sort(
        (a, b) =>
          Number(Boolean(b.card.display?.needsYou) || b.card.status === "review") -
          Number(Boolean(a.card.display?.needsYou) || a.card.status === "review"),
      );
    }
    if (cards.length) groups.push({ name: "Issues", items: cards.slice(0, q ? 8 : 5) });
  }
  if (only !== "cards") {
    const go = rank(views());
    if (go.length) groups.push({ name: "Go to", items: go });
    // DB-N11-1..3, -5: Start sprint, Complete sprint, Sprint report and New sprint.
    const sp = rank(sprintPaletteItems());
    if (sp.length) groups.push({ name: "Sprints", items: sp });
    const pr = rank(prefs());
    if (pr.length) groups.push({ name: "Preferences", items: pr });
  }
  // DB-P5-4: "new project" offers Start a new project, first; a query that
  // matches nothing offers Ask Seshat: <query>.
  const matched = groups.reduce((n, g) => n + g.items.length, 0);
  const seshat = paletteSeshat(q, matched)
    .filter((it) => it.kind === "ask" || only !== "cards")
    .map((it) => ({
      label: it.label,
      hits: [],
      run:
        // DS-N7-1: Start a new project opens the start page.
        it.kind === "start"
          ? () => {
              location.hash = START_ROUTE;
            }
          : () => askSeshat(it.text, currentContext()),
    }));
  if (seshat.length) groups.unshift({ name: "Seshat", items: seshat });
  return groups;
}

function render() {
  const { node, input } = open;
  const groups = build(input.value, open.actions);
  const flat = groups.flatMap((g) => g.items);
  open.flat = flat;
  open.index = Math.min(open.index, Math.max(0, flat.length - 1));
  let i = 0;
  const html = groups
    .map((g) => {
      const rows = g.items
        .map((it) => {
          const id = `po-${i}`;
          const sel = i === open.index;
          const keys = it.keys ? `<span class="meta">${kbd(...it.keys)}</span>` : "";
          const meta = it.meta ? `<span class="meta">${it.meta}</span>` : "";
          const ctx = it.context ? `<span class="po-ctx">${it.context}</span>` : "";
          const row = `<div class="po${ctx ? " po-hit" : ""}" role="option" id="${id}" data-i="${i}" aria-selected="${sel}"><span class="t">${highlight(it.label, it.hits ?? [])}</span>${meta}${keys}${ctx}</div>`;
          i++;
          return row;
        })
        .join("");
      return `<div role="group" aria-label="${esc(g.name)}"><div class="pg">${esc(g.name)}</div>${rows}</div>`;
    })
    .join("");
  const list = node.querySelector(".palette-list");
  list.innerHTML =
    html ||
    `<div class="palette-empty">No matches for “${esc(input.value)}”. Try <kbd>&gt;</kbd> for commands or <kbd>#</kbd> for issues.</div>`;
  input.setAttribute("aria-activedescendant", flat.length ? `po-${open.index}` : "");
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

export function closePalette() {
  if (!open) return;
  clearTimeout(open.searchTimer);
  const { node, remove, invoker } = open;
  open = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

function runSelected(e) {
  const it = open?.flat?.[open.index];
  if (!it) return;
  closePalette();
  if ((e.metaKey || e.ctrlKey) && it.card) {
    location.hash = `#/card/${encodeURIComponent(it.card.id)}`;
    return;
  }
  it.run();
}

/**
 * @param initial text to prefill (`#` for cards)
 * @param actions (key, card) => void, the view's triage handler for card actions
 */
export function openPalette(initial, actions) {
  const prefill = initial ?? "";
  if (open) {
    closePalette();
    return;
  }
  const node = document.createElement("div");
  node.className = "scrim";
  node.innerHTML = `<div class="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette"><div class="palette-input">${icon("search")}<input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" placeholder="Search issues, views and commands" autocomplete="off" spellcheck="false"></div><div class="palette-list" id="palette-list" role="listbox"></div><div class="palette-foot"><span>${kbd("↑", "↓")} move</span><span>${kbd("↵")} run</span><span>${kbd(`${MOD}↵`)} open issue</span><span>${kbd(">")} commands</span><span>${kbd("#")} issues</span><span>${kbd("Esc")} close</span></div></div>`;
  document.getElementById("overlay-root").append(node);
  const input = node.querySelector("input");
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "palette",
    modal: true,
    close: () => closePalette(),
    onKey: (e) => {
      if (trapFocus(node, e)) return true;
      if (e.key === "ArrowDown") {
        open.index = Math.min(open.index + 1, open.flat.length - 1);
        render();
        e.preventDefault();
        return true;
      }
      if (e.key === "ArrowUp") {
        open.index = Math.max(open.index - 1, 0);
        render();
        e.preventDefault();
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        runSelected(e);
        return true;
      }
      return e.key !== "Escape";
    },
  });
  open = { node, input, remove, invoker, index: 0, flat: [], actions, others: [] };
  void loadOtherIssues(open);
  input.value = prefill;
  scheduleSearch(open);
  input.addEventListener("input", () => {
    open.index = 0;
    scheduleSearch(open);
    render();
  });
  node.addEventListener("click", (e) => {
    if (e.target === node) return closePalette();
    const row = e.target instanceof Element ? e.target.closest(".po") : null;
    if (row) {
      open.index = Number(row.dataset.i);
      runSelected(e);
    }
  });
  node.addEventListener("mousemove", (e) => {
    const row = e.target instanceof Element ? e.target.closest(".po") : null;
    if (row && Number(row.dataset.i) !== open.index) {
      open.index = Number(row.dataset.i);
      for (const r of node.querySelectorAll(".po"))
        r.setAttribute("aria-selected", String(r === row));
      input.setAttribute("aria-activedescendant", row.id);
    }
  });
  render();
  input.focus();
}

export function paletteIsOpen() {
  return Boolean(open);
}
