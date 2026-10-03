// The Triage view (`#/board/triage`; dashboard §2.4.19, NEW-dashboard-10;
// DB-N10-2..4): the untriaged Backlog issues, oldest first, each with its
// four decisions — Accept into Backlog (1), Decline (2), Duplicate of… (3)
// and Snooze (H) — and Seshat's suggestions beside it as proposals a person
// applies. Rows and words are the pure module's (`lib/intake.js`); each
// decision is `POST /api/cards/:id/triage`, which the server checks again.
import { openCreate } from "./create.js";
import { $, $$, esc, icon, kbd, postJSON } from "./dom.js";
import { practiceTip } from "./learn.js";
import { noteFor } from "./level_gate.js";
import {
  TRIAGE_COPY as T,
  TRIAGE_DECISIONS,
  snoozeChoices,
  triageDecisionFor,
  triageModel,
} from "./lib/intake.js";
import { formatWait } from "./lib/vocabulary.js";
import { openMenu } from "./overlay.js";
import { openPicker, openPrompt } from "./picker.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { renderSuggestions } from "./suggestions.js";
import { toast } from "./toast.js";
import { applyView, bindViewBar, focusFilter, paintViewBar, vb } from "./viewbar.js";

const ui = { root: null, list: null, barHost: null, focus: 0, html: "", busy: new Set() };

function model() {
  return triageModel({ cards: store.state.cards, setup: getSession().mode });
}

function rowHtml(row, i, gated) {
  const project = store.state.project?.id;
  const needs = `data-needs="issue.edit" data-needs-quiet${project ? ` data-needs-project="${esc(project)}"` : ""}`;
  const acts = TRIAGE_DECISIONS.map(
    (d) =>
      `<button class="btn sm${d.id === "accept" ? " primary" : " ghost"}" type="button" data-decide="${d.id}" ${needs} aria-keyshortcuts="${d.key}"${ui.busy.has(row.id) ? " disabled" : ""}>${esc(d.label)} ${kbd(d.key)}</button>`,
  ).join("");
  const waited = formatWait(Date.now() - Date.parse(row.at));
  return `<li class="tri-row${i === ui.focus ? " focus" : ""}" data-i="${i}" data-id="${esc(row.id)}" tabindex="${i === ui.focus ? "0" : "-1"}" aria-label="${esc(`${row.key} ${row.title}`)}">
<div class="tri-line"><span class="tri-key mono sec">${esc(row.key)}</span><a class="tri-title" href="#/card/${encodeURIComponent(row.id)}">${esc(row.title)}</a><time class="tri-time sec tnum" datetime="${esc(row.at)}">${esc(waited)} ago</time></div>
<div class="tri-from sec">${esc(row.from)}</div>
<div class="tri-acts" role="group" aria-label="${esc(`Triage ${row.key}`)}">${acts}</div>${gated ? "" : `<div class="tri-sug" data-sug-for="${esc(row.id)}" hidden></div>`}
</li>`;
}

function render() {
  if (!ui.root) return;
  const m = model();
  const total = m.count;
  setTopbar({
    title: T.heading,
    crumb: `${store.state.meta?.project ?? ""}${store.state.meta?.project ? " · " : ""}${total} waiting`,
  });
  paintViewBar(ui.barHost, null, "triage");
  ui.focus = Math.min(ui.focus, Math.max(0, m.rows.length - 1));
  const gated = noteFor("issue.edit", store.state.project?.id);
  const html = !m.shown
    ? `<div class="board-empty"><b>${esc(T.empty)}</b></div>`
    : m.rows.length === 0
      ? `<div class="board-empty tri-empty">${icon("check-circle", 24, "ic s24")}<b>${esc(T.empty)}</b><span>${esc(T.emptyDetail)}</span></div>`
      : `<p class="tri-intro sec">${esc(T.intro)}${practiceTip("practice:triage", "Triage", { practice: { triage: total } })}</p>${gated ? `<p class="level-note">${esc(gated)}</p>` : `<p class="tri-sug-note sec">${icon("chat", 12, "ic s12")}${esc(T.suggestions)}</p>`}<ol class="tri-list" aria-label="${esc(`${T.heading}: ${total} waiting, oldest first`)}">${m.rows.map((r, i) => rowHtml(r, i, gated)).join("")}</ol>`;
  if (html === ui.html) return;
  const had = document.activeElement?.closest?.(".tri-row")?.dataset.id;
  ui.html = html;
  ui.list.innerHTML = html;
  // Seshat's suggestions beside each row: proposals, applied only by a person (DB-N10-3).
  for (const host of $$("[data-sug-for]", ui.list)) {
    void renderSuggestions(host, host.dataset.sugFor, { onChange: refresh });
  }
  if (had) $(`.tri-row[data-id="${CSS.escape(had)}"]`, ui.list)?.focus({ preventScroll: true });
}

function refresh() {
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
}

function rowAt(i) {
  return model().rows[i];
}

function focusRow(i) {
  const rows = $$(".tri-row", ui.list);
  if (!rows.length) return;
  ui.focus = Math.max(0, Math.min(i, rows.length - 1));
  rows.forEach((r, k) => {
    r.classList.toggle("focus", k === ui.focus);
    r.tabIndex = k === ui.focus ? 0 : -1;
  });
  rows[ui.focus].focus({ preventScroll: false });
}

async function decide(row, decision, extra, anchor) {
  if (!row || ui.busy.has(row.id)) return;
  const gated = noteFor("issue.edit", store.state.project?.id);
  if (gated) {
    toast({ tone: "parked", text: gated });
    return;
  }
  ui.busy.add(row.id);
  const r = await postJSON(`/api/cards/${encodeURIComponent(row.id)}/triage`, {
    decision,
    ...extra,
  });
  ui.busy.delete(row.id);
  if (!r.ok) {
    toast({
      tone: "fail",
      text: "Couldn't triage it.",
      detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
    });
    anchor?.focus?.();
    return;
  }
  const text =
    decision === "accept"
      ? T.accepted(row.key)
      : decision === "decline"
        ? T.declined(row.key)
        : decision === "duplicate"
          ? T.duplicated(row.key, extra.duplicateLabel ?? extra.duplicateOf)
          : T.snoozed(row.key, new Date(extra.until).toLocaleString());
  toast({ tone: decision === "accept" ? "pass" : "info", text });
  refresh();
}

/** Run one decision on a row, asking first for what it needs: a reason, an issue, a time. */
function choose(row, decision, anchor) {
  if (!row) return;
  if (decision === "accept") return decide(row, "accept", {}, anchor);
  if (decision === "decline") {
    openPrompt(anchor, {
      heading: T.declineHeading,
      placeholder: T.declinePlaceholder,
      submit: "Decline",
      onSubmit: (reason) => decide(row, "decline", { reason }, anchor),
    });
    return;
  }
  if (decision === "duplicate") {
    const project = store.card(row.id)?.projectId;
    const options = store.state.cards
      .filter((c) => c.id !== row.id && (!project || !c.projectId || c.projectId === project))
      .map((c) => ({
        value: c.id,
        label: c.display?.title ?? c.title,
        detail: c.display?.shortId ?? c.id,
      }));
    openPicker(anchor, {
      heading: T.duplicateHeading,
      search: true,
      wide: true,
      options,
      onPick: (id) => {
        const of = store.card(id);
        decide(
          row,
          "duplicate",
          { duplicateOf: id, duplicateLabel: of?.display?.shortId ?? id },
          anchor,
        );
      },
    });
    return;
  }
  openMenu(
    anchor,
    snoozeChoices(new Date()).map((c) => ({
      label: c.label,
      run: () => decide(row, "snooze", { until: c.until }, anchor),
    })),
    { heading: T.snoozeHeading },
  );
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  const btn = t?.closest("[data-decide]");
  if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") {
    const li = t?.closest(".tri-row");
    if (li && !t.closest("a, button")) focusRow(Number(li.dataset.i));
    return;
  }
  const li = btn.closest(".tri-row");
  ui.focus = Number(li?.dataset.i ?? 0);
  choose(rowAt(ui.focus), btn.dataset.decide, btn);
}

export function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const inRow = document.activeElement?.closest?.(".tri-row");
  if (e.key === "j" || e.key === "ArrowDown") {
    focusRow(ui.focus + 1);
    return true;
  }
  if (e.key === "k" || e.key === "ArrowUp") {
    focusRow(ui.focus - 1);
    return true;
  }
  // New issue, as on the board (DB-N10-1: a Stakeholder files from here too).
  if (e.key === "c") {
    openCreate();
    return true;
  }
  if (!inRow) return false;
  if (e.key === "Enter" && document.activeElement === inRow) {
    location.hash = `#/card/${encodeURIComponent(inRow.dataset.id)}`;
    return true;
  }
  const decision = triageDecisionFor(e.key);
  if (!decision) return false;
  const anchor = $(`[data-decide="${decision}"]`, inRow) ?? inRow;
  choose(rowAt(Number(inRow.dataset.i)), decision, anchor);
  return true;
}

export function mount(view) {
  const outer = document.createElement("div");
  outer.className = "view-host";
  outer.innerHTML =
    '<div class="vbar-host"></div><section class="tri" aria-labelledby="view-title"></section>';
  view.append(outer);
  ui.barHost = outer.querySelector(".vbar-host");
  ui.list = outer.querySelector(".tri");
  ui.root = outer;
  ui.html = "";
  bindViewBar(ui.barHost);
  // Opened by its address (the Inbox, a link): the View menu names Triage.
  if (vb.viewId !== "triage") applyView("triage", { navigate: false });
  ui.list.addEventListener("click", onClick);
  const unsub = store.on(() => render());
  render();
  return {
    onKey,
    focusFilter: () => focusFilter(outer),
    unmount() {
      unsub?.();
      outer.remove();
      ui.root = null;
    },
  };
}
