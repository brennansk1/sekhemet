// Command palette (FRONTEND_DESIGN §2.5.10): grouped, fuzzy, with shortcuts.
import { openCheatsheet } from "./cheatsheet.js";
import { MOD, copyText, esc, icon, kbd } from "./dom.js";
import { KIND_LABELS, columnLabel } from "./lib/vocabulary.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { toggleTheme } from "./shell.js";
import { store } from "./store.js";
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

function views() {
  return [
    { label: "Go to Review", keys: ["g", "r"], run: goTo("#/review") },
    { label: "Go to Board", keys: ["g", "b"], run: goTo("#/board") },
    {
      label: "Go to List",
      search: "Board list table view",
      keys: ["v"],
      run: goTo("#/board/list"),
    },
    {
      label: "Talk to Merit, the project manager",
      search: "Merit PM project manager chat ask",
      keys: [`${MOD}J`],
      run: () => window.dispatchEvent(new CustomEvent("sekhemet:open-pm")),
    },
    {
      label: "Go to Merit (full conversation)",
      search: "Merit PM conversation",
      keys: ["g", "a"],
      run: goTo("#/pm"),
    },
    {
      label: "Go to Insights",
      search: "Insights flow metrics cycle time throughput",
      keys: ["g", "f"],
      run: goTo("#/insights"),
    },
    {
      label: "Go to Integrations",
      search: "Integrations GitHub Jira Linear Slack import export",
      keys: ["g", "s"],
      run: goTo("#/integrations"),
    },
    { label: "Go to Runs", keys: ["g", "q"], run: goTo("#/runs") },
    { label: "Go to Ledger", keys: ["g", "l"], run: goTo("#/ledger") },
    { label: "Go to Playbook", keys: ["g", "p"], run: goTo("#/playbook") },
    { label: "Go to Machine", keys: ["g", "m"], run: goTo("#/machine") },
  ];
}

function prefs() {
  return [
    { label: "Switch theme", keys: ["t"], run: toggleTheme },
    { label: "Keyboard shortcuts", keys: ["?"], run: () => setTimeout(openCheatsheet, 0) },
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
      label: `Send back “${title}”`,
      search: "Send back return",
      keys: ["r"],
      run: run("r"),
    });
  if (card.status !== "parked" && card.status !== "done")
    out.push({ label: `Park “${title}”`, search: "Park", keys: ["p"], run: run("p") });
  out.push({
    label: `Open “${title}”`,
    search: "Open card",
    keys: ["↵"],
    run: goTo(`#/card/${encodeURIComponent(card.id)}`),
  });
  out.push({
    label: "Copy card id",
    search: "Copy card id",
    run: async () =>
      toast({
        text: (await copyText(card.id)) ? `Copied ${card.id}` : "Couldn't copy to the clipboard.",
      }),
  });
  return out;
}

function cardItems() {
  return store.state.cards.map((c) => {
    const d = c.display ?? {};
    const kinds = (d.kinds ?? [])
      .map((k) => KIND_LABELS[k]?.label)
      .filter(Boolean)
      .join(", ");
    return {
      label: d.title ?? c.title,
      search: `${d.title ?? c.title} ${d.shortId ?? ""}`,
      shortId: (d.shortId ?? "").toLowerCase(),
      meta: `${STATE_ICON[d.tone ?? "neutral"]?.() ?? ""}${esc(columnLabel(c.status))}${kinds ? ` · ${esc(kinds)}` : ""}`,
      run: goTo(`#/card/${encodeURIComponent(c.id)}`),
      card: c,
    };
  });
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
    if (acts.length) groups.push({ name: "Actions on focused card", items: acts });
  }
  if (only !== "commands") {
    let cards = rank(cardItems());
    if (!q) {
      // Empty query: the cards that need a person first.
      cards = cards.sort(
        (a, b) =>
          Number(Boolean(b.card.display?.needsYou) || b.card.status === "review") -
          Number(Boolean(a.card.display?.needsYou) || a.card.status === "review"),
      );
    }
    if (cards.length) groups.push({ name: "Cards", items: cards.slice(0, q ? 8 : 5) });
  }
  if (only !== "cards") {
    const go = rank(views());
    if (go.length) groups.push({ name: "Go to", items: go });
    const pr = rank(prefs());
    if (pr.length) groups.push({ name: "Preferences", items: pr });
  }
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
          const row = `<div class="po" role="option" id="${id}" data-i="${i}" aria-selected="${sel}"><span class="t">${highlight(it.label, it.hits ?? [])}</span>${meta}${keys}</div>`;
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
    `<div class="palette-empty">No matches for “${esc(input.value)}”. Try <kbd>&gt;</kbd> for commands or <kbd>#</kbd> for cards.</div>`;
  input.setAttribute("aria-activedescendant", flat.length ? `po-${open.index}` : "");
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

export function closePalette() {
  if (!open) return;
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
  node.innerHTML = `<div class="dialog palette" role="dialog" aria-modal="true" aria-label="Command palette"><div class="palette-input">${icon("search")}<input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" placeholder="Search cards, views and commands" autocomplete="off" spellcheck="false"></div><div class="palette-list" id="palette-list" role="listbox"></div><div class="palette-foot"><span>${kbd("↑", "↓")} move</span><span>${kbd("↵")} run</span><span>${kbd(`${MOD}↵`)} open card</span><span>${kbd(">")} commands</span><span>${kbd("#")} cards</span><span>${kbd("Esc")} close</span></div></div>`;
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
  open = { node, input, remove, invoker, index: 0, flat: [], actions };
  input.value = prefill;
  input.addEventListener("input", () => {
    open.index = 0;
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
