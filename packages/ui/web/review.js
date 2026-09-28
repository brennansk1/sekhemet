import { loadDetail } from "./data.js";
// Review (FRONTEND_DESIGN §2.4.1): the queue on the left, the evidence in the
// middle, the facts on the right, and the triage bar under the evidence.
import { nextDiffMode } from "./diff.js";
import { $, announce, brandMark, esc, icon } from "./dom.js";
import { EvidencePane } from "./evidence.js";
import { ISSUE_TYPE_LABELS, formatWait } from "./lib/vocabulary.js";
import {
  acknowledgeFocused,
  focusNextFinding,
  recordShown as recordShownFor,
} from "./review_desk.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import {
  READ_ONLY_DETAIL,
  READ_ONLY_TEXT,
  accept,
  composerHtml,
  mutationsBlocked,
  openPark,
  quickNotes,
  triageBarHtml,
  wireComposer,
} from "./triage.js";

const TWO_HOURS = 2 * 3600_000;

const ui = {
  root: null,
  selected: null,
  attempt: undefined,
  detail: null,
  openedStatus: null,
  pane: null,
  unsub: null,
  queueHtml: "",
  triageHtml: "",
  composerOpen: false,
  loadSeq: 0,
};

/* ---------- Queue ---------- */

function waitOf(card) {
  const at = card.display?.enteredColumnAt ? Date.parse(card.display.enteredColumnAt) : Date.now();
  return store.state.now - at;
}

export function queueGroups() {
  const cards = store.state.cards;
  const ready = cards.filter((c) => c.status === "review").sort((a, b) => waitOf(b) - waitOf(a));
  const needYou = cards
    .filter((c) => c.status !== "review" && c.display?.needsYou)
    .sort((a, b) => waitOf(b) - waitOf(a));
  return { ready, needYou, order: [...ready, ...needYou] };
}

function rowMeta(card) {
  const d = card.display ?? {};
  const wait = waitOf(card);
  const w = `<span class="w tnum${wait > TWO_HOURS ? " old" : ""}" title="Waiting ${esc(formatWait(wait))}">${esc(formatWait(wait))}</span>`;
  const kind = ISSUE_TYPE_LABELS[d.type]
    ? `<span>${esc(ISSUE_TYPE_LABELS[d.type].label)}</span>·`
    : "";
  if (card.status === "review") {
    const gates = d.evidence?.gates ?? [];
    const passed = gates.filter((g) => g.state === "pass").length;
    const ran = gates.filter((g) => g.state !== "not_run").length;
    const all = gates.length > 0 && passed === ran;
    return `${kind}${icon(all ? "check" : "x", 12, `ic s12 ${all ? "i-pass" : "i-fail"}`)}<span>${ran ? `${passed} of ${ran} checks` : "Waiting for you"}</span>${w}`;
  }
  if (d.tone === "parked")
    return `${icon("pause", 12, "ic s12 i-park")}<span>${esc(d.statusLine)}</span>${w}`;
  const failed = (d.evidence?.gates ?? []).filter((g) => g.state === "fail").map((g) => g.label);
  const text = [d.stopLabel, failed.length ? `${failed[0]} failed` : ""]
    .filter(Boolean)
    .join(" · ");
  return `${icon("x", 12, "ic s12 i-fail")}<span>${esc(text || d.statusLine)}</span>${w}`;
}

function rowHtml(card) {
  const sel = card.id === ui.selected;
  return `<button class="q-row" type="button" role="option" id="q-${esc(card.id)}" data-id="${esc(card.id)}" aria-selected="${sel}" tabindex="${sel ? "0" : "-1"}"><div class="q-t">${esc(card.display?.title ?? card.title)}</div><div class="q-m">${rowMeta(card)}</div></button>`;
}

function renderQueue() {
  const { ready, needYou } = queueGroups();
  const html = `<div class="q-h" id="q-ready">Ready for review <span class="c tnum">${ready.length}</span></div>${ready.length ? ready.map(rowHtml).join("") : '<div class="q-empty">Nothing waiting for you.</div>'}<div class="q-sep" role="separator"></div><div class="q-h" id="q-need">Need you <span class="c tnum">${needYou.length}</span></div>${needYou.length ? needYou.map(rowHtml).join("") : '<div class="q-empty">Nothing is stuck.</div>'}`;
  const q = $(".queue", ui.root);
  if (q && html !== ui.queueHtml) {
    const hadFocus = q.contains(document.activeElement);
    const top = q.scrollTop;
    q.innerHTML = html;
    q.scrollTop = top;
    ui.queueHtml = html;
    if (hadFocus) document.getElementById(`q-${ui.selected}`)?.focus({ preventScroll: true });
  }
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Review",
    crumb: `${project ? `${project} · ` : ""}${ready.length} ready · ${needYou.length} need${needYou.length === 1 ? "s" : ""} you`,
  });
}

/* ---------- Evidence ---------- */

function selectedCard() {
  return store.card(ui.selected);
}

function renderTriage() {
  const card = selectedCard();
  const slot = $("[data-triage]", ui.root);
  if (!slot) return;
  const html = card ? triageBarHtml(card, ui.detail?.evidence, { detail: ui.detail }) : "";
  if (html !== ui.triageHtml) {
    const btn = slot.contains(document.activeElement) ? document.activeElement : null;
    const which = ["data-accept", "data-back", "data-park"].find((a) => btn?.hasAttribute(a));
    slot.innerHTML = html;
    ui.triageHtml = html;
    if (which) slot.querySelector(`[${which}]`)?.focus();
  }
}

function renderEmpty() {
  const readyCount = store.state.cards.filter((c) => c.status === "ready").length;
  $(".ev-scroll", ui.root).innerHTML =
    `<div class="ev-empty">${brandMark(24)}<b>Nothing to review.</b><span>Issues land here when every check passes.</span>${readyCount ? `<span>${readyCount} ${readyCount === 1 ? "issue is" : "issues are"} ready to run: <code>sekhemet queue</code></span>` : ""}</div>`;
  $("[data-facts]", ui.root).innerHTML = "";
  $("[data-triage]", ui.root).innerHTML = "";
  ui.triageHtml = "";
}

function renderEvidence({ keepScroll = false } = {}) {
  const card = selectedCard();
  if (!card) return renderEmpty();
  const scroll = $(".ev-scroll", ui.root);
  const top = scroll.scrollTop;
  const d = ui.detail;
  const head = ui.pane.headHtml(card, d, { attempt: ui.attempt });
  const body = d ? ui.pane.bodyHtml(card, d) : ui.pane.loadingHtml();
  scroll.innerHTML = head + body;
  $("[data-notice]", scroll).innerHTML = ui.pane.noticeHtml(card, ui.openedStatus);
  $("[data-facts]", ui.root).innerHTML = d ? ui.pane.factsHtml(card, d) : "";
  if (keepScroll) scroll.scrollTop = top;
  else scroll.scrollTop = 0;
  // What is on screen is recorded first, so Accept's reason counts it (DB-N5-3).
  recordShown();
  renderTriage();
}

/**
 * RG-S6-6, RG-N5-5, DB-N5-3: record the diffs on screen, so Accept knows what
 * was shown; a diff scrolled into view later redraws Accept's reason.
 */
function recordShown() {
  if (!ui.detail) return;
  const scroll = $(".ev-scroll", ui.root);
  recordShownFor(selectedCard(), ui.detail, ui.pane, scroll, renderTriage);
}

async function load(id, { keepScroll = false } = {}) {
  const seq = ++ui.loadSeq;
  const card = store.card(id);
  ui.pane.forCard(id);
  if (!keepScroll) {
    ui.detail = null;
    ui.openedStatus = card?.status ?? null;
  }
  const pending = loadDetail(id, ui.attempt);
  // Show the skeleton only if the load is not instant.
  const t = setTimeout(() => {
    if (seq === ui.loadSeq && !ui.detail) renderEvidence();
  }, 60);
  const detail = await pending;
  clearTimeout(t);
  if (seq !== ui.loadSeq || !ui.root) return;
  ui.detail = detail;
  ui.pane.signature = `${card?.status}|${card?.display?.evidence?.id ?? ""}`;
  renderEvidence({ keepScroll });
}

function select(id, { focus = false, fromHash = false } = {}) {
  if (!id) {
    ui.selected = null;
    renderQueue();
    renderEmpty();
    return;
  }
  const changed = id !== ui.selected;
  ui.selected = id;
  store.state.focusedId = id;
  if (changed) {
    ui.attempt = undefined;
    closeComposer();
  }
  if (!fromHash) history.replaceState(null, "", `#/review/${encodeURIComponent(id)}`);
  renderQueue();
  $(".wrap", ui.root)?.classList.add("has-sel");
  if (focus) document.getElementById(`q-${id}`)?.focus({ preventScroll: false });
  document.getElementById(`q-${id}`)?.scrollIntoView({ block: "nearest" });
  if (changed) load(id);
}

function step(dir) {
  const { order } = queueGroups();
  if (order.length === 0) return;
  const i = order.findIndex((c) => c.id === ui.selected);
  const next = order[Math.max(0, Math.min(order.length - 1, i + dir))] ?? order[0];
  select(next.id, { focus: $(".queue", ui.root)?.contains(document.activeElement) });
}

/** After a verdict: move to the next row, as the queue shrinks under us. */
function advance(fromId) {
  const { order } = queueGroups();
  const rest = order.filter((c) => c.id !== fromId);
  const idx = Math.max(
    0,
    order.findIndex((c) => c.id === fromId),
  );
  const next = rest[Math.min(idx, rest.length - 1)];
  if (next) select(next.id, { focus: true });
  else select(null);
  announce(next ? `Next: ${next.display?.title ?? next.title}` : "Nothing left to review.");
}

/* ---------- Triage ---------- */

function closeComposer() {
  ui.closeComposer?.();
  ui.closeComposer = null;
  ui.composerOpen = false;
}

function runAction(key, card = selectedCard()) {
  if (!card) return false;
  const ev = card.id === ui.selected ? ui.detail?.evidence : undefined;
  const blocked = mutationsBlocked();
  if (blocked === "readonly") {
    toast({ text: READ_ONLY_TEXT, detail: READ_ONLY_DETAIL, tone: "parked", iconName: "lock" });
    return true;
  }
  if (key === "a") {
    accept(card, ev, {
      detail: card.id === ui.selected ? ui.detail : undefined,
      onChange: () => {
        ui.triageHtml = "";
        renderTriage();
      },
      onMerged: () => advance(card.id),
    });
    return true;
  }
  if (key === "r") {
    if (!ev) {
      toast({
        text: "Nothing to send back yet.",
        detail: "This issue has no attempt to respond to.",
      });
      return true;
    }
    if (ui.composerOpen) {
      $("[data-composer] textarea", ui.root)?.focus();
      return true;
    }
    $("[data-triage]", ui.root).insertAdjacentHTML(
      "beforebegin",
      composerHtml(quickNotes(card, ev, store.state.gates)),
    );
    ui.composerOpen = true;
    ui.closeComposer = wireComposer($("[data-composer]", ui.root), card, {
      onSent: () => {
        ui.composerOpen = false;
        ui.closeComposer = null;
        advance(card.id);
      },
      onClose: () => {
        ui.composerOpen = false;
        ui.closeComposer = null;
        $("[data-back]", ui.root)?.focus();
      },
    });
    return true;
  }
  if (key === "p") {
    const anchor = $("[data-park]", ui.root) ?? $("[data-triage]", ui.root);
    openPark(anchor, card, { onDone: () => advance(card.id) });
    return true;
  }
  return false;
}

export function onKey(e) {
  const k = e.key;
  if (k === "j" || k === "ArrowDown") {
    step(1);
    return true;
  }
  if (k === "k" || k === "ArrowUp") {
    step(-1);
    return true;
  }
  if (k === "a" || k === "r" || k === "p") return runAction(k);
  // DB-N5-3: `x` acknowledges the focused Reviewer finding (or the first open one).
  if (k === "x") {
    const card = selectedCard();
    if (card && ui.detail && acknowledgeFocused(ui.root, card, ui.detail)) {
      renderEvidence({ keepScroll: true });
      focusNextFinding(ui.root, card, ui.detail);
    }
    return true;
  }
  const onControl = e.target.closest?.("button:not(.q-row), a, summary, select");
  if ((k === "o" || (k === "Enter" && !onControl)) && ui.selected) {
    location.hash = `#/card/${encodeURIComponent(ui.selected)}`;
    return true;
  }
  if (k === "[" || k === "]") {
    const n = ui.detail?.attempts?.length ?? 0;
    if (n < 2) return true;
    const cur = ui.attempt ?? n;
    const next = Math.max(1, Math.min(n, cur + (k === "]" ? 1 : -1)));
    if (next !== cur) {
      ui.attempt = next === n ? undefined : next;
      load(ui.selected);
    }
    return true;
  }
  if (k === "f") {
    ui.pane.factsHidden = !ui.pane.factsHidden;
    const f = $(".facts", ui.root);
    if (f) f.hidden = ui.pane.factsHidden;
    return true;
  }
  if (k === "u") {
    ui.pane.mode = nextDiffMode(ui.pane.mode);
    renderEvidence({ keepScroll: true });
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
  return false;
}

/* ---------- Mount ---------- */

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<div class="wrap"><div class="queue" role="listbox" aria-label="Review queue"></div><section class="ev" aria-label="Evidence"><div class="ev-scroll" tabindex="-1"></div><div data-triage></div></section><div data-facts style="display:contents"></div></div>`;
  view.append(root);
  ui.root = root;
  ui.queueHtml = "";
  ui.triageHtml = "";
  ui.selected = null;
  ui.composerOpen = false;
  ui.pane = new EvidencePane({
    onAttempt: (n) => {
      const total = ui.detail?.attempts?.length ?? 0;
      ui.attempt = n === total ? undefined : n;
      load(ui.selected);
    },
  });
  ui.pane.bind(root, {
    rerender: () => renderEvidence({ keepScroll: true }),
    reload: () => {
      ui.openedStatus = selectedCard()?.status ?? null;
      load(ui.selected);
    },
    current: () => ({ card: selectedCard(), detail: ui.detail }),
  });

  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const row = t.closest(".q-row");
    if (row) return select(row.dataset.id);
    if (t.closest("[data-toggle]")) {
      recordShown();
      renderTriage();
    } else if (t.closest("[data-accept]")) runAction("a");
    else if (t.closest("[data-back]")) runAction("r");
    else if (t.closest("[data-park]")) runAction("p");
  });

  ui.unsub = store.on((_s, patch) => {
    if (!ui.root) return;
    if ("cards" in patch || "now" in patch) renderQueue();
    const card = selectedCard();
    if ("cards" in patch && card) {
      const sig = `${card.status}|${card.display?.evidence?.id ?? ""}`;
      if (ui.pane.signature && sig !== ui.pane.signature) {
        // Moved or re-run while open: say so instead of silently swapping.
        const notice = $("[data-notice]", ui.root);
        if (notice)
          notice.innerHTML = ui.pane.noticeHtml(card, ui.openedStatus) || notice.innerHTML;
        if (card.display?.evidence?.id !== ui.detail?.evidence?.id && !ui.composerOpen)
          load(card.id, { keepScroll: true });
      }
    }
    if (!ui.selected) {
      const first = queueGroups().order[0];
      if (first && "cards" in patch) select(first.id);
    }
    renderTriage();
  });

  setParams(route.params);
  return { onKey, setParams, cardAction, unmount };
}

/** Palette card actions: select the card, wait for its evidence, then act. */
function cardAction(key, card) {
  if (card.id === ui.selected && ui.detail) return runAction(key, card);
  select(card.id);
  loadDetail(card.id).then((d) => {
    if (ui.selected !== card.id) return;
    ui.detail = ui.detail ?? d;
    runAction(key, store.card(card.id));
  });
  return true;
}

function setParams(params) {
  const want = params?.[0];
  if (want && store.card(want)) {
    if (want !== ui.selected) select(want, { fromHash: true });
    return;
  }
  const first = queueGroups().order[0];
  if (first) select(first.id);
  else select(null);
}

function unmount() {
  closeComposer();
  ui.unsub?.();
  ui.root?.remove();
  ui.root = null;
}
