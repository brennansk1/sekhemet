// The start page (design-stage §2.11, NEW-design-stage-7): #/projects/new.
// The conversation with Seshat on the left and, on the right, the live draft
// Seshat has made so far — Brief, Requirements and Plan, as far as they
// exist — with Review plan once a plan exists. Narrower than 768 px the
// draft is a tab beside the conversation. Every word and every part shown
// is `startDraftView`'s (`/app/lib/start.js`); the draft is the newest open
// `start_project` proposal in the thread, so nothing exists until the plan
// is approved (DS-N7-5). Review plan is the thread's own, opened with the
// choices made here. A folder that already holds a project cannot take a new
// one: the page asks the server first and says so before any drafting, with
// Plan the next piece of work (`/plan`) instead of a conversation (DS-N7-1).
import { $, aiBadge, esc, getJSON, icon } from "./dom.js";
import { START_PROJECT_OPENING } from "./lib/seshat.js";
import { START_COPY as C, startDraftOf, startDraftView } from "./lib/start.js";
import { openConversationWith, setFullThread } from "./pm_panel.js";
import { mountThread } from "./pm_thread.js";
import { reviewPlanFor } from "./proposals.js";
import { moveLine, reviewState, toggleCandidate } from "./review_plan_view.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = {
  root: null,
  /** The draft's tab, and on a phone the page's (conversation or draft). */
  tab: "brief",
  pane: "conversation",
  /** The person's choices on the current draft, by its proposal id. */
  draftId: "",
  state: null,
  last: "",
  thread: null,
  /** The composer is offered the start of a project once, when the thread has loaded. */
  offered: false,
};

function current() {
  const proposal = startDraftOf(store.state.pm.messages);
  const group = proposal?.patch?.group ?? null;
  if ((proposal?.id ?? "") !== ui.draftId) {
    // A new draft: its own proposal, and the person's choices start again.
    ui.draftId = proposal?.id ?? "";
    ui.state = group ? reviewState(group, proposal.approval?.choices) : null;
  }
  return { proposal, group };
}

/** The brief's lines are Markdown (DEC-44): its *emphasis* reads as emphasis. */
function emphasis(line) {
  return esc(line).replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/** Each requirement with the one press that changes it: Remove when in, Accept when out. */
function requirementHtml(r) {
  const accept = `<button type="button" class="btn ghost sm" data-accept="${esc(r.key)}">Accept</button>`;
  const remove = `<button type="button" class="btn ghost sm" data-remove="${esc(r.key)}">Remove</button>`;
  const acts =
    r.state === "Accepted" ? remove : r.state === "Removed" ? accept : `${accept}${remove}`;
  return `<li class="st-req${r.state === "Accepted" ? " kept" : ""}" data-cand="${esc(r.key)}"><span class="st-req-t">${esc(r.title)}<span class="sec st-from">${esc(r.from)}${r.ai ? aiBadge() : ""}</span></span><span class="st-side"><span class="st-state sec">${esc(r.state)}</span><span class="st-acts">${acts}</span></span></li>`;
}

function lineHtml(v) {
  return `<li class="st-line" role="separator" aria-label="${esc(v.lineLabel)}"><span>${esc(v.lineLabel)}</span><button type="button" class="btn ghost sm" data-line-up aria-label="Move the release line up">↑</button><button type="button" class="btn ghost sm" data-line-down aria-label="Move the release line down">↓</button></li>`;
}

function panelHtml(v) {
  if (ui.tab === "brief") {
    return v.brief
      .map(
        (s) =>
          `<section class="st-sec"><h3>${esc(s.label)}</h3><ul>${s.lines.map((l) => `<li>${emphasis(l)}</li>`).join("")}</ul></section>`,
      )
      .join("");
  }
  if (ui.tab === "requirements") {
    return `<p class="sec">${esc(v.requirementsHint)}</p>${v.requirements
      .map(
        (p) =>
          `<section class="st-sec"><h3>${esc(p.label)} <span class="sec tnum">${p.items.length}</span></h3><ul class="st-reqs">${p.items
            .map((r) => requirementHtml(r) + (r.key === v.lineAfter ? lineHtml(v) : ""))
            .join("")}</ul></section>`,
      )
      .join("")}`;
  }
  return `<ul class="st-plan">${v.plan
    .map(
      (r) =>
        `<li><b>${esc(r.name)}</b><span class="sec">${esc(r.holds)} · ${esc(r.issues)}</span><span class="tnum">${esc(r.when)}</span></li>`,
    )
    .join("")}</ul>`;
}

function draftHtml(v) {
  if (!v.tabs.some((t) => t.id === ui.tab)) ui.tab = v.tabs[0]?.id ?? "brief";
  const tabs = v.tabs.length
    ? `<div class="tabs ptabs" role="tablist" aria-label="Draft parts">${v.tabs
        .map((t) => {
          const sel = t.id === ui.tab;
          return `<button class="tab" type="button" role="tab" id="st-tab-${t.id}" data-draft-tab="${t.id}" aria-selected="${sel}" aria-controls="st-panel" tabindex="${sel ? "0" : "-1"}">${esc(t.label)}${t.count ? ` <span class="c tnum">${t.count}</span>` : ""}</button>`;
        })
        .join(
          "",
        )}</div><div class="st-panel" role="tabpanel" id="st-panel" aria-labelledby="st-tab-${ui.tab}" tabindex="0">${panelHtml(v)}</div>`
    : `<p class="sec st-empty">${esc(v.empty ?? "")}</p>`;
  const rp = v.reviewPlan;
  const foot = `<div class="start-foot"><p class="${rp.enabled ? "" : "sec"}" id="st-rp-why">${esc(rp.enabled ? rp.summary : rp.reason)}</p><button class="btn primary" type="button" data-review-plan aria-describedby="st-rp-why"${rp.enabled ? "" : " disabled"}>${esc(rp.label)}</button></div>`;
  return `<header class="start-head"><h2 id="st-draft-h">${esc(v.heading)}</h2><p class="sec">${esc(C.createdNothing)}</p></header>${tabs}${foot}`;
}

function render() {
  if (!ui.root || !ui.thread) return;
  const { group } = current();
  // No draft yet: the composer starts the project, for the person to finish (DB-P5-3).
  if (!ui.offered && store.state.pm.available === true) {
    ui.offered = true;
    if (!group) ui.thread?.prefill(START_PROJECT_OPENING);
  }
  const v = startDraftView(group, {
    width: window.innerWidth,
    ...(ui.state ? { state: ui.state } : {}),
  });
  const page = ui.root.querySelector(".start");
  page.dataset.layout = v.layout;
  const pageTabs = $(".start-tabs", ui.root);
  const tabsHtml = v.pageTabs.length
    ? v.pageTabs
        .map((label, i) => {
          const id = i === 0 ? "conversation" : "draft";
          const sel = ui.pane === id;
          return `<button class="tab" type="button" role="tab" id="st-pane-${id}" data-pane="${id}" aria-selected="${sel}" aria-controls="st-${id}" tabindex="${sel ? "0" : "-1"}">${esc(label)}</button>`;
        })
        .join("")
    : "";
  if (pageTabs.dataset.html !== tabsHtml) {
    pageTabs.innerHTML = tabsHtml;
    pageTabs.dataset.html = tabsHtml;
  }
  pageTabs.hidden = !v.pageTabs.length;
  const tabbed = v.layout === "tabs";
  for (const [id, sel, label] of [
    ["conversation", ".start-convo", ""],
    ["draft", ".start-draft", "st-draft-h"],
  ]) {
    const half = $(sel, ui.root);
    half.hidden = tabbed && ui.pane !== id;
    // On a phone each half is the panel of its page tab.
    if (tabbed) half.setAttribute("role", "tabpanel");
    else half.removeAttribute("role");
    const by = tabbed ? `st-pane-${id}` : label;
    if (by) half.setAttribute("aria-labelledby", by);
    else half.removeAttribute("aria-labelledby");
  }
  const html = draftHtml(v);
  if (html === ui.last) return;
  const draft = $(".start-draft", ui.root);
  const keep = focusSelector(
    draft.contains(document.activeElement) ? document.activeElement : null,
  );
  ui.last = html;
  draft.innerHTML = html;
  if (keep)
    (
      $(keep, draft) ??
      $(keep.replace(/data-(accept|remove)=/, "data-cand="), draft)?.querySelector("button")
    )?.focus();
}

/** The control focus was on in the draft, found again after a re-render. */
function focusSelector(el) {
  if (!el) return "";
  for (const name of ["draft-tab", "accept", "remove"]) {
    const v = el.getAttribute(`data-${name}`);
    if (v) return `[data-${name}="${CSS.escape(v)}"]`;
  }
  for (const name of ["line-up", "line-down", "review-plan"])
    if (el.hasAttribute(`data-${name}`)) return `[data-${name}]`;
  return "";
}

async function review() {
  const { proposal } = current();
  if (!proposal) return;
  const result = await reviewPlanFor(proposal, { choices: ui.state, keepTalking: true });
  // Approved here (Solo's Create project, an approver's Approve): the project exists; its page opens.
  if (result?.proposal?.state === "applied") location.hash = "#/status";
  else render();
}

/** DS-N7-1: this folder already holds a project — said before any drafting, with what to do instead. */
function blockedHtml(reason) {
  return `<section class="start-blocked ib-empty" aria-labelledby="st-blocked-h">${icon("layers", 24, "ic s24")}<h2 id="st-blocked-h">${esc(C.blockedTitle)}</h2><p>${esc(reason)}</p><div class="start-blocked-acts"><button class="btn primary" type="button" data-plan-next>${esc(C.planNext)}</button><a class="btn" href="#/projects">${esc(C.backToProjects)}</a></div></section>`;
}

/** The conversation beside the live draft, for a folder that can take a new project. */
function startConversation(root) {
  root.innerHTML = `<div class="start"><div class="tabs ptabs start-tabs" role="tablist" aria-label="${esc(C.title)}" hidden></div><section class="start-convo" id="st-conversation" aria-label="Conversation with Seshat"></section><aside class="start-draft" id="st-draft" aria-labelledby="st-draft-h"></aside></div>`;
  const thread = mountThread($(".start-convo", root), {
    variant: "full",
    intro: C.intro,
    starters: false,
    placeholder: C.composerPlaceholder,
  });
  setFullThread(thread);
  ui.thread = thread;
  ui.offered = false;
  ui.last = "";
  render();
  setTimeout(() => thread.focus(), 0);
}

export function mount(view) {
  setTopbar({ title: C.title, crumb: C.crumb });
  const root = document.createElement("div");
  root.className = "view-host start-host";
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.pane = "conversation";
  ui.thread = null;
  let gone = false;
  // Ask the server first: a refused Create project after a whole conversation is a dead end.
  getJSON("/api/projects/new").then((r) => {
    if (gone) return;
    if (r.ok && r.data?.allowed === false && r.data.reason) {
      root.innerHTML = blockedHtml(r.data.reason);
      $("[data-plan-next]", root)?.focus();
    } else startConversation(root);
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-plan-next]")) {
      openConversationWith(C.planNextPrefill);
      return;
    }
    const pane = t.closest("[data-pane]");
    const tab = t.closest("[data-draft-tab]");
    const accept = t.closest("[data-accept]")?.dataset.accept;
    const remove = t.closest("[data-remove]")?.dataset.remove;
    const { group } = current();
    if (pane) {
      ui.pane = pane.dataset.pane;
      ui.last = "";
      render();
      $(`[data-pane="${ui.pane}"]`, root)?.focus();
    } else if (tab) {
      ui.tab = tab.dataset.draftTab;
      render();
    } else if (t.closest("[data-review-plan]")) review();
    else if (group && ui.state && (accept || remove)) {
      ui.state = moveLine(
        group,
        toggleCandidate(ui.state, accept || remove, accept ? "accept" : "remove"),
        0,
      );
      render();
    } else if (group && ui.state && t.closest("[data-line-up]")) {
      ui.state = moveLine(group, ui.state, -1);
      render();
    } else if (group && ui.state && t.closest("[data-line-down]")) {
      ui.state = moveLine(group, ui.state, +1);
      render();
    }
  });
  // Arrow keys move along a tab list (WAI-ARIA tabs).
  root.addEventListener("keydown", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[role=tab]") : null;
    if (!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
    const all = [...t.parentElement.querySelectorAll("[role=tab]")];
    const next = all[(all.indexOf(t) + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length];
    next?.click();
    next?.focus();
    e.preventDefault();
  });
  const unsub = store.on((_s, patch) => {
    if ("pm" in patch || Object.keys(patch).length === 0) render();
  });
  const mq = window.matchMedia?.("(max-width: 767px)");
  const onWidth = () => {
    ui.last = "";
    render();
  };
  mq?.addEventListener?.("change", onWidth);
  return {
    unmount() {
      gone = true;
      unsub();
      mq?.removeEventListener?.("change", onWidth);
      if (ui.thread) {
        setFullThread(null);
        ui.thread.destroy();
      }
      root.remove();
      ui.root = null;
      ui.thread = null;
    },
  };
}
