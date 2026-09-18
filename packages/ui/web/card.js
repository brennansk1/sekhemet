// Card view (FRONTEND_DESIGN §2.4.3), Evidence tab. Plan, Steps, Thread and
// Files arrive with Phase 3; until then the view is the Review composition at
// full width for any card, reachable with Enter from the board or Review.
import { loadDetail } from "./data.js";
import { $, esc, icon } from "./dom.js";
import { EvidencePane } from "./evidence.js";
import { columnLabel } from "./lib/vocabulary.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import {
  accept,
  composerHtml,
  openPark,
  quickNotes,
  triageBarHtml,
  wireComposer,
} from "./triage.js";

const ui = {
  root: null,
  id: null,
  detail: null,
  pane: null,
  unsub: null,
  attempt: undefined,
  sig: "",
  closeComposer: null,
};

const PILL_ICON = {
  running: '<span class="dot run" aria-hidden="true"></span>',
  pass: icon("check", 12, "ic s12 i-pass"),
  fail: icon("x", 12, "ic s12 i-fail"),
  parked: icon("pause", 12, "ic s12 i-park"),
  blocked: icon("link", 12, "ic s12 i-blk"),
  neutral: "",
};

function render({ keepScroll = true, headOnly = false } = {}) {
  const card = store.card(ui.id);
  const head = $(".cv-h", ui.root);
  const scroll = $(".ev-scroll", ui.root);
  if (!card) {
    setTopbar({ title: "Card", crumb: store.state.meta?.project ?? "" });
    head.innerHTML = "";
    scroll.innerHTML = `<div class="ev-empty">${icon("alert", 24, "ic s24")}<b>No card ${esc(ui.id)}.</b><span>It may have been removed. <a href="#/board">Back to the board</a></span></div>`;
    return;
  }
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Card",
    crumb: `${project ? `${project} › ` : ""}${columnLabel(card.status)}`,
  });
  const top = scroll.scrollTop;
  const d = ui.detail;
  const triage = triageBarHtml(card, d?.evidence, { hint: false }).replace(
    /^<div class="triage[^"]*"[^>]*>|<\/div>$/g,
    "",
  );
  const pill = `<span class="pill">${PILL_ICON[card.display?.tone ?? "neutral"] ?? ""}${esc(columnLabel(card.status))}</span>`;
  const headHtml = ui.pane.headHtml(card, d, { attempt: ui.attempt, withTitle: false });
  const headNext = `<div class="line"><div style="min-width:0;flex:1 1 420px">${headHtml.replace('<div class="outcome">', `<h2 class="ttl">${esc(card.display?.title ?? card.title)}</h2><div class="outcome">`).replace('<div class="outcome">', `<div class="outcome">${pill}`)}</div><div class="acts">${triage}</div></div>`;
  if (head.dataset.html !== headNext) {
    const which = ["data-accept", "data-back", "data-park"].find(
      (a) => document.activeElement?.hasAttribute?.(a) && head.contains(document.activeElement),
    );
    head.innerHTML = headNext;
    head.dataset.html = headNext;
    if (which) head.querySelector(`[${which}]`)?.focus();
  }
  if (headOnly) return;
  scroll.innerHTML = d ? ui.pane.bodyHtml(card, d) : ui.pane.loadingHtml();
  $("[data-facts]", ui.root).innerHTML = d ? ui.pane.factsHtml(card, d) : "";
  scroll.scrollTop = keepScroll ? top : 0;
}

async function load(keepScroll = false) {
  const id = ui.id;
  const card = store.card(id);
  ui.pane.forCard(id);
  ui.sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
  if (!keepScroll) ui.detail = null;
  render({ keepScroll });
  const d = await loadDetail(id, ui.attempt);
  if (ui.id !== id || !ui.root) return;
  ui.detail = d;
  render({ keepScroll });
}

function runAction(key) {
  const card = store.card(ui.id);
  if (!card) return false;
  const ev = ui.detail?.evidence;
  if (key === "a") {
    accept(card, ev, { onChange: () => render(), onMerged: () => render() });
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

function onKey(e) {
  const k = e.key;
  if (k === "a" || k === "r" || k === "p") return runAction(k);
  if (k === "u") {
    ui.pane.mode = ui.pane.mode === "split" ? "unified" : "split";
    render();
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
  if (id === ui.id) return;
  ui.closeComposer?.();
  ui.id = id;
  ui.attempt = undefined;
  store.state.focusedId = id;
  load();
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="cv" aria-label="Card"><div class="cv-h"></div><div class="cv-body"><div class="ev-scroll" tabindex="-1"></div><div data-facts style="display:contents"></div></div></section>`;
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
  ui.pane.bind(root, { rerender: () => render(), reload: () => load(true) });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-accept]")) runAction("a");
    else if (t.closest("[data-back]")) runAction("r");
    else if (t.closest("[data-park]")) runAction("p");
  });
  ui.unsub = store.on((_s, patch) => {
    if (!ui.root || !("cards" in patch || "connection" in patch || "verification" in patch)) return;
    const card = store.card(ui.id);
    const sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
    if (sig !== ui.sig && !$("[data-composer]", ui.root)) load(true);
    else render({ headOnly: true });
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
      ui.unsub?.();
      root.remove();
      ui.root = null;
    },
  };
}
