import { renderApproval } from "./approval.js";
import { loadDetail } from "./data.js";
// Card view (FRONTEND_DESIGN §2.4.3): header with triage, then five tabs.
// Evidence reuses the Review composition; Plan, Steps, Thread and Files are
// their own modules. Route: #/card/:id/:tab, tabs on keys 1–5.
import { nextDiffMode } from "./diff.js";
import { $, esc, getJSON, icon } from "./dom.js";
import { EvidencePane } from "./evidence.js";
import { filesCount, renderFiles } from "./files.js";
import { columnLabel } from "./lib/vocabulary.js";
import { renderPlan } from "./plan.js";
import { setTopbar } from "./shell.js";
import { renderSteps } from "./steps.js";
import { store } from "./store.js";
import { renderSuggestions } from "./suggestions.js";
import { renderThread } from "./thread.js";
import {
  accept,
  composerHtml,
  openPark,
  quickNotes,
  triageBarHtml,
  wireComposer,
} from "./triage.js";

const TABS = [
  { id: "evidence", label: "Evidence" },
  { id: "plan", label: "Plan" },
  { id: "steps", label: "Steps" },
  { id: "thread", label: "Thread" },
  { id: "files", label: "Files" },
];

const ui = {
  root: null,
  id: null,
  tab: "evidence",
  detail: null,
  events: null,
  pane: null,
  unsub: null,
  attempt: undefined,
  sig: "",
  closeComposer: null,
  tabCtl: null,
  loadSeq: 0,
};

const PILL_ICON = {
  running: '<span class="dot run" aria-hidden="true"></span>',
  pass: icon("check", 12, "ic s12 i-pass"),
  fail: icon("x", 12, "ic s12 i-fail"),
  parked: icon("pause", 12, "ic s12 i-park"),
  blocked: icon("link", 12, "ic s12 i-blk"),
  neutral: "",
};

function tabsHtml(card) {
  const counts = {
    steps:
      card.status === "in_progress"
        ? Number.parseInt(card.display?.budgetText ?? "", 10) || ""
        : card.display?.evidence
          ? ui.detail?.evidence?.turnsUsed
          : card.stepsUsed || "",
    thread: ui.events ? ui.events.length : "",
    files: ui.detail ? filesCount(card, ui.detail) : "",
  };
  return `<div class="tabs" role="tablist" aria-label="Card sections">${TABS.map((t, i) => {
    const sel = t.id === ui.tab;
    const c = counts[t.id];
    return `<button class="tab" type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-selected="${sel}" aria-controls="panel" tabindex="${sel ? "0" : "-1"}" title="${esc(t.label)} (${i + 1})">${esc(t.label)}${c !== "" && c !== undefined && c !== 0 ? ` <span class="c tnum">${esc(c)}</span>` : ""}</button>`;
  }).join("")}</div>`;
}

function renderHead() {
  const card = store.card(ui.id);
  const head = $(".cv-h", ui.root);
  if (!card) {
    setTopbar({ title: "Card", crumb: store.state.meta?.project ?? "" });
    head.innerHTML = "";
    return;
  }
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Card",
    crumb: `${project ? `${project} › ` : ""}${columnLabel(card.status)}`,
  });
  const d = ui.detail;
  const triage = triageBarHtml(card, d?.evidence, { hint: false }).replace(
    /^<div class="triage[^"]*"[^>]*>|<\/div>$/g,
    "",
  );
  const pill = `<span class="pill">${PILL_ICON[card.display?.tone ?? "neutral"] ?? ""}${esc(columnLabel(card.status))}</span>`;
  const headHtml = ui.pane.headHtml(card, d, { attempt: ui.attempt, withTitle: false });
  const next = `<div class="line"><div style="min-width:0;flex:1 1 420px">${headHtml
    .replace(
      '<div class="outcome">',
      `<h2 class="ttl">${esc(card.display?.title ?? card.title)}</h2><div class="outcome">`,
    )
    .replace(
      '<div class="outcome">',
      `<div class="outcome">${pill}`,
    )}</div><div class="acts">${triage}</div></div>${tabsHtml(card)}`;
  if (head.dataset.html !== next) {
    const active = document.activeElement;
    const which = ["data-accept", "data-back", "data-park", "data-tab"].find(
      (a) => active?.hasAttribute?.(a) && head.contains(active),
    );
    const tabVal = active?.dataset?.tab;
    head.innerHTML = next;
    head.dataset.html = next;
    if (which === "data-tab") head.querySelector(`[data-tab="${tabVal}"]`)?.focus();
    else if (which) head.querySelector(`[${which}]`)?.focus();
  }
}

function renderPanel({ keepScroll = true } = {}) {
  const card = store.card(ui.id);
  const body = $(".cv-body", ui.root);
  ui.tabCtl?.destroy?.();
  ui.tabCtl = null;
  if (!card) {
    body.innerHTML = `<div class="ev-scroll"><div class="ev-empty">${icon("alert", 24, "ic s24")}<b>No card ${esc(ui.id)}.</b><span>It may have been removed. <a href="#/board">Back to the board</a></span></div></div>`;
    return;
  }
  const d = ui.detail;
  if (ui.tab === "evidence") {
    const old = $(".ev-scroll", body);
    const top = old?.scrollTop ?? 0;
    body.innerHTML = `<div class="ev-scroll" id="panel" role="tabpanel" aria-labelledby="tab-evidence" tabindex="-1">${d ? ui.pane.bodyHtml(card, d) : ui.pane.loadingHtml()}</div><div data-facts style="display:contents">${d ? ui.pane.factsHtml(card, d) : ""}</div>`;
    if (keepScroll) $(".ev-scroll", body).scrollTop = top;
    return;
  }
  body.innerHTML = `<div class="ev-scroll panel" id="panel" role="tabpanel" aria-labelledby="tab-${ui.tab}" tabindex="-1"></div>`;
  const host = $("#panel", body);
  const ctx = {
    id: ui.id,
    card: () => store.card(ui.id),
    detail: () => ui.detail,
    events: () => ui.events,
    goTab: (t, hash) => {
      location.hash = `#/card/${encodeURIComponent(ui.id)}/${t}${hash ?? ""}`;
    },
  };
  const renderers = {
    plan: renderPlan,
    steps: renderSteps,
    thread: renderThread,
    files: renderFiles,
  };
  ui.tabCtl = renderers[ui.tab]?.(host, ctx) ?? null;
}

async function loadEvents() {
  const id = ui.id;
  const res = await getJSON(`/api/events?card=${encodeURIComponent(id)}&order=asc&limit=1000`);
  if (ui.id !== id || !ui.root) return;
  ui.events = res.ok ? res.data.events : [];
  renderHead();
  ui.tabCtl?.onEvents?.();
}

async function load(keepScroll = false) {
  const id = ui.id;
  const seq = ++ui.loadSeq;
  const card = store.card(id);
  ui.pane.forCard(id);
  ui.sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
  if (!keepScroll) ui.detail = null;
  renderHead();
  if (!keepScroll) renderPanel({ keepScroll });
  const sug = $("[data-suggestions]", ui.root);
  if (sug && sug.dataset.card !== id) {
    sug.dataset.card = "";
    sug.hidden = true;
    sug.innerHTML = "";
  }
  void renderSuggestions(sug, id);
  // PM-N7-5: a card waiting on a person's approval of its criteria shows them, and Approve.
  const apv = $("[data-approval]", ui.root);
  if (apv && apv.dataset.card !== id) {
    apv.dataset.card = "";
    apv.hidden = true;
    apv.innerHTML = "";
  }
  if (card?.status === "planning") void renderApproval(apv, id);
  else if (apv) apv.hidden = true;
  const d = await loadDetail(id, ui.attempt);
  if (seq !== ui.loadSeq || ui.id !== id || !ui.root) return;
  ui.detail = d;
  renderHead();
  if (ui.tab === "evidence" || !ui.tabCtl) renderPanel({ keepScroll });
  else ui.tabCtl.onDetail?.();
}

function runAction(key) {
  const card = store.card(ui.id);
  if (!card) return false;
  const ev = ui.detail?.evidence;
  if (key === "a") {
    accept(card, ev, { onChange: () => renderHead(), onMerged: () => renderHead() });
    return true;
  }
  if (key === "r" && ev) {
    if ($("[data-composer]", ui.root)) return true;
    $(".cv-body", ui.root).insertAdjacentHTML(
      "beforebegin",
      composerHtml(quickNotes(card, ev, store.state.gates)),
    );
    ui.closeComposer = wireComposer($("[data-composer]", ui.root), card, {
      onSent: () => {
        ui.closeComposer = null;
      },
      onClose: () => {
        ui.closeComposer = null;
      },
    });
    return true;
  }
  if (key === "p") {
    openPark($("[data-park]", ui.root) ?? $(".cv-h", ui.root), card);
    return true;
  }
  return false;
}

function selectTab(tab, { focus = false } = {}) {
  if (!TABS.some((t) => t.id === tab)) return;
  history.replaceState(null, "", `#/card/${encodeURIComponent(ui.id)}/${tab}`);
  ui.tab = tab;
  renderHead();
  renderPanel({ keepScroll: false });
  if (focus) $(`[data-tab="${tab}"]`, ui.root)?.focus();
}

function onKey(e) {
  const k = e.key;
  if (/^[1-5]$/.test(k)) {
    selectTab(TABS[Number(k) - 1].id, { focus: false });
    return true;
  }
  // WAI-ARIA tabs: arrows move between tabs when a tab has focus.
  if ((k === "ArrowRight" || k === "ArrowLeft") && e.target.closest?.("[role=tab]")) {
    const i = TABS.findIndex((t) => t.id === ui.tab);
    const next = TABS[(i + (k === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length];
    selectTab(next.id, { focus: true });
    return true;
  }
  if (k === "a" || k === "r" || k === "p") return runAction(k);
  if (ui.tabCtl?.onKey?.(e)) return true;
  if (ui.tab !== "evidence") return false;
  if (k === "u") {
    ui.pane.mode = nextDiffMode(ui.pane.mode);
    renderPanel();
    return true;
  }
  if (k === "n" || k === "N") {
    ui.pane.nextAnnotation(ui.root, k === "n" ? 1 : -1);
    return true;
  }
  if (k === " ") {
    ui.pane.toggleFile(ui.root);
    return true;
  }
  if (k === "f") {
    ui.pane.factsHidden = !ui.pane.factsHidden;
    const f = $(".facts", ui.root);
    if (f) f.hidden = ui.pane.factsHidden;
    return true;
  }
  if (k === "[" || k === "]") {
    const n = ui.detail?.attempts?.length ?? 0;
    const cur = ui.attempt ?? n;
    const next = Math.max(1, Math.min(n, cur + (k === "]" ? 1 : -1)));
    if (n > 1 && next !== cur) {
      ui.attempt = next === n ? undefined : next;
      load();
    }
    return true;
  }
  return false;
}

function setParams(params) {
  const id = params?.[0];
  const tab = TABS.some((t) => t.id === params?.[1]) ? params[1] : "evidence";
  if (id === ui.id) {
    if (tab !== ui.tab) selectTab(tab);
    return;
  }
  ui.closeComposer?.();
  ui.id = id;
  ui.tab = tab;
  ui.attempt = undefined;
  ui.events = null;
  store.state.focusedId = id;
  load();
  loadEvents();
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML =
    '<section class="cv" aria-label="Card"><div class="cv-h"></div><div class="cv-apv" data-approval hidden></div><div class="cv-sug" data-suggestions hidden></div><div class="cv-body"></div></section>';
  view.append(root);
  ui.root = root;
  ui.id = null;
  ui.pane = new EvidencePane({
    onAttempt: (n) => {
      const total = ui.detail?.attempts?.length ?? 0;
      ui.attempt = n === total ? undefined : n;
      load();
    },
  });
  ui.pane.bind(root, { rerender: () => renderPanel(), reload: () => load(true) });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest("[data-tab]");
    if (tab) selectTab(tab.dataset.tab);
    else if (t.closest("[data-accept]")) runAction("a");
    else if (t.closest("[data-back]")) runAction("r");
    else if (t.closest("[data-park]")) runAction("p");
  });
  ui.unsub = store.on((_s, patch) => {
    if (!ui.root) return;
    if (!("cards" in patch || "connection" in patch || "verification" in patch)) return;
    const mine = (store.state.feed ?? []).filter((e) => e.cardId === ui.id);
    if ("cards" in patch && mine.length && ui.events) {
      const have = new Set(ui.events.map((e) => e.seq));
      const fresh = mine.filter((e) => !have.has(e.seq));
      if (fresh.length) {
        ui.events = [...ui.events, ...fresh];
        ui.tabCtl?.onEvents?.(fresh);
      }
    }
    const card = store.card(ui.id);
    const sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
    if (sig !== ui.sig && !$("[data-composer]", ui.root)) load(true);
    else renderHead();
    ui.tabCtl?.onStore?.(patch);
  });
  setParams(route.params);
  return {
    onKey,
    setParams,
    cardAction: (key, card) => {
      if (card.id !== ui.id) return false;
      return runAction(key);
    },
    unmount() {
      ui.closeComposer?.();
      ui.tabCtl?.destroy?.();
      ui.tabCtl = null;
      ui.unsub?.();
      root.remove();
      ui.root = null;
      ui.id = null;
    },
  };
}
