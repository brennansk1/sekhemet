// Tips, the on-screen name of the Learn layer (dashboard §2.9, P4): the one
// `data-learn` attribute, the toggle, and the popover a `?` opens. Every word
// and every number's sentence is the pure module's (`lib/learn.js`); a view
// puts `tip(...)` beside a term and passes the facts it already has.
import { esc, icon } from "./dom.js";
import {
  FIRST_RUN,
  answerFirstRun,
  managesWork,
  readRole,
  readTips,
  tipButtonHtml,
  tipFor,
  writeTips,
} from "./lib/learn.js";
import { placeUnder, pushOverlay, trapFocus } from "./overlay.js";
import { getSession } from "./session.js";

export function storage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * NEW-dashboard-17: this person manages the work (Solo's *I manage the work*,
 * or the Team profile label Product owner or Stakeholder).
 */
export function viewerManagesWork() {
  const session = getSession();
  return managesWork({
    team: session.mode === "team",
    profileLabel: session.label,
    role: readRole(storage()),
  });
}

/** Kept for this page when the browser blocks storage. */
let thisPage = null;

export function tipsOn() {
  return thisPage ?? readTips(storage());
}

function apply() {
  if (tipsOn()) document.documentElement.dataset.learn = "on";
  else delete document.documentElement.dataset.learn;
}

/** Turn Tips on or off: every view mounts again, so with Tips off no `?` is left (DB-P4-1). */
export function setTips(on) {
  const s = storage();
  writeTips(s, on);
  thisPage = readTips(s) === on ? null : on;
  closeTip();
  apply();
  window.dispatchEvent(new CustomEvent("sekhemet:tips", { detail: { on } }));
}

export function toggleTips() {
  setTips(!tipsOn());
}

/**
 * The `?` beside a term (DB-P4-2): nothing at all with Tips off. `facts` are
 * the numbers the lesson's own line reads (`LearnFacts`), carried on the
 * button so the popover says what the view showed when it drew it.
 */
export function tip(id, term, facts) {
  return tipButtonHtml(tipsOn(), id, term, facts ? JSON.stringify(facts) : "");
}

/** The Checks strip's `?`: this issue's results, and a lesson for each family present (DB-P4-2). */
export function checksTip(gates) {
  const checks = (gates ?? []).map((g) => ({ id: g.id, label: g.label, state: g.state }));
  return tip("checks", "Checks", { checks });
}

/** The topbar's Tips toggle: a book and the word, pressed while Tips are on (§2.9.1). */
export function tipsToggleHtml() {
  const on = tipsOn();
  return `<button class="btn ghost sm tips-btn" type="button" data-tips-toggle aria-pressed="${on}" aria-label="Tips">${icon("book", 14, "ic s14")}<span class="lbl">Tips</span></button>`;
}

/* ---------- The popover (DB-P4-3) ---------- */

let open = null;

function closeTip() {
  open?.close();
}

function factsOf(btn) {
  const raw = btn.dataset.tipCtx ?? "";
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function popoverHtml(t) {
  const more = t.more.length
    ? `<ul class="tip-more">${t.more.map((m) => `<li><b>${esc(m.term)}</b> ${esc(m.concept)}</li>`).join("")}</ul>`
    : "";
  return `<h3 id="tip-pop-h">${esc(t.term)}</h3><p>${esc(t.concept)}</p><p class="tip-yours"><span class="sec">In this project</span>${esc(t.yours)}</p>${more}<a class="tip-src" href="${esc(t.source.url)}" target="_blank" rel="noopener noreferrer">${esc(t.source.label)}${icon("external", 12, "ic s12")}</a>`;
}

/** Open the lesson a `?` names, anchored to it; Esc returns focus to the `?`. */
export function openTip(btn) {
  const same = open?.anchor === btn;
  closeTip();
  if (same) return;
  let view;
  try {
    view = tipFor(btn.dataset.tip, factsOf(btn));
  } catch {
    return;
  }
  const pop = document.createElement("div");
  pop.className = "tip-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", "tip-pop-h");
  pop.tabIndex = -1;
  pop.innerHTML = popoverHtml(view);
  document.getElementById("overlay-root").append(pop);
  placeUnder(pop, btn);
  btn.setAttribute("aria-expanded", "true");
  const outside = (e) => {
    if (!pop.contains(e.target) && e.target !== btn) close(false);
  };
  const remove = pushOverlay({
    kind: "tip",
    modal: true,
    node: pop,
    close: () => close(true),
    onKey: (e) => {
      if (e.key === "Tab") return trapFocus(pop, e) || true;
      // Esc goes to the stack (closeTop); Enter follows the link. Letters
      // never reach the view underneath while the popover is open.
      return e.key !== "Escape" && e.key !== "Enter" && e.key !== " ";
    },
  });
  function close(refocus) {
    remove();
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    btn.setAttribute("aria-expanded", "false");
    if (open?.pop === pop) open = null;
    if (refocus && btn.isConnected) btn.focus();
  }
  open = { anchor: btn, pop, close: () => close(false) };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  pop.focus();
}

/** Once, at boot: the attribute, the `?` buttons and the toggles, wherever they are drawn. */
export function initTips() {
  apply();
  // Capture: a `?` inside a view's clickable region opens its lesson, nothing else.
  document.addEventListener(
    "click",
    (e) => {
      const q = e.target instanceof Element ? e.target.closest("[data-tip]") : null;
      if (!q) return;
      e.preventDefault();
      e.stopPropagation();
      openTip(q);
    },
    true,
  );
  document.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-tips-toggle]")) toggleTips();
  });
  // A view's own keys (Enter opens the focused card) must not take the `?`'s.
  document.addEventListener(
    "keydown",
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t?.matches("[data-tip]") || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      openTip(t);
    },
    true,
  );
}

/* ---------- The first-run question (§2.2.5, DB-P4-7) ---------- */

/**
 * The one question, as a bar above the view: it blocks nothing and takes no
 * focus, so a deep link opens as it was. *I'm learning* turns Tips on; the
 * other answers leave them off. `onAnswer(role)` goes on from there.
 */
/**
 * The first visit (§2.2.5; FINDINGS SHL-03): a welcome — what Sekhemet is,
 * the model step when no model is set up yet (an Admin's, in the Team
 * setup) — and the one question, *I'll just talk to Seshat* among its
 * answers. A bar above the view: it blocks nothing and takes no focus.
 */
export function showFirstRun(onAnswer, { noModel = false, setsUpModels = true } = {}) {
  if (document.getElementById("sk-firstrun")) return;
  const bar = document.createElement("section");
  bar.id = "sk-firstrun";
  bar.className = "fr-bar";
  bar.setAttribute("aria-labelledby", "fr-q");
  const choices = FIRST_RUN.choices
    .map(
      (c) =>
        `<button class="btn fr-choice" type="button" data-fr="${esc(c.role)}"><b>${esc(c.label)}</b><span class="sec">${esc(c.detail)}</span></button>`,
    )
    .join("");
  const step = noModel
    ? `<p class="fr-step">${esc(setsUpModels ? FIRST_RUN.modelStep : FIRST_RUN.modelStepAdmin)}${setsUpModels ? ` <a href="#/configuration/models">${esc(FIRST_RUN.setUpModels)}</a>` : ""}</p>`
    : "";
  bar.innerHTML = `<div class="fr-head"><p class="fr-welcome"><b>${esc(FIRST_RUN.welcome)}</b> <span class="sec">${esc(FIRST_RUN.lede)}</span></p>${step}<h2 id="fr-q">${esc(FIRST_RUN.question)}</h2><span class="sec">${esc(FIRST_RUN.note)}</span></div><div class="fr-choices">${choices}<button class="btn ghost" type="button" data-fr="later">${esc(FIRST_RUN.later)}</button></div>`;
  bar.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-fr]") : null;
    if (!b) return;
    const role = b.dataset.fr;
    answerFirstRun(storage(), role);
    thisPage = null;
    apply();
    bar.remove();
    onAnswer?.(role);
  });
  document.getElementById("view")?.before(bar);
}
