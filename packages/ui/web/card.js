import { renderActivity } from "./activity.js";
import { renderApproval } from "./approval.js";
import { renderChanges } from "./changes.js";
import { forget, loadDetail } from "./data.js";
// The issue page (dashboard §2.6, NEW-dashboard-8, DEC-34): the header with
// triage; the description, the acceptance criteria with their check state and
// the Agent's controls; then six tabs — Activity, Checks, Changes, AI review,
// Steps and Plan — on keys 1–6. Route: #/card/:id/:tab; the old tab names
// (evidence, thread, files) land on the tab that holds their content.
import { nextDiffMode } from "./diff.js";
import { $, esc, getJSON, icon } from "./dom.js";
import { EvidencePane, reviewHtml } from "./evidence.js";
import { mountIssue } from "./issue_view.js";
import { tip as learnTip, viewerManagesWork } from "./learn.js";
import {
  ISSUE_COPY,
  agentPanel,
  criteriaChecks,
  issueDocumentTitle,
  issueEventsUrl,
  issueTab,
  issueTabsFor,
  oldestFirst,
} from "./lib/issue.js";
import { kindTip } from "./lib/learn.js";
import { PRESENCE_COPY, viewersStrip } from "./lib/live.js";
import { reviewerFindings } from "./lib/review_desk.js";
import { stateBadge } from "./lib/strip.js";
import { boardColumnLabel } from "./lib/vocabulary.js";
import { renderPlan } from "./plan.js";
import { announceIssue } from "./presence.js";
import { mountProperties } from "./props.js";
import { renderReady } from "./ready.js";
import { acknowledgeFocused, focusNextFinding, reviewerHtml } from "./review_desk.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";
import { shotsHtml } from "./shots.js";
import { renderSteps } from "./steps.js";
import { store } from "./store.js";
import { renderSuggestions } from "./suggestions.js";
import {
  accept,
  acceptChecklistHtml,
  acceptPending,
  commentFormHtml,
  composerHtml,
  openPark,
  quickNotes,
  triageBarHtml,
  undoAccept,
  wireCommentForm,
  wireComposer,
} from "./triage.js";
import { mountWatch } from "./watch.js";

const ui = {
  root: null,
  id: null,
  tab: "activity",
  detail: null,
  events: null,
  pane: null,
  unsub: null,
  attempt: undefined,
  sig: "",
  closeComposer: null,
  tabCtl: null,
  issue: null,
  loadSeq: 0,
  /** DB-N8-4: this card's comments on diff lines, carried by Send back. */
  comments: [],
  /** ISS-01: the properties rail. */
  props: null,
  /** Team: who watches this issue, for the rail's Watchers. */
  watchers: [],
};

/** The tabs this person sees: the criteria view first when they manage the work (DB-N17-1). */
function tabs() {
  return issueTabsFor(viewerManagesWork(), ui.tab);
}

/** Where each of Accept's conditions is met on this page (dashboard §8 question 7). */
function checklistLinks(id) {
  const at = (t) => `#/card/${encodeURIComponent(id)}/${t}`;
  return {
    findings: at(ui.tab === "criteria" ? "criteria" : "ai_review"),
    files: at("changes"),
    conversation: at("changes"),
    thread: at("changes"),
  };
}

const PILL_ICON = {
  running: '<span class="dot run" aria-hidden="true"></span>',
  pass: icon("check", 12, "ic s12 i-pass"),
  fail: icon("x", 12, "ic s12 i-fail"),
  parked: icon("pause", 12, "ic s12 i-park"),
  blocked: icon("link", 12, "ic s12 i-blk"),
  planning: icon("pencil", 12, "ic s12"),
  neutral: "",
};

/** What each tab's count says, beside its name. */
function tabCounts(card) {
  const ev = ui.detail?.evidence;
  const failedGates = ev && !ev.passed ? new Set((ev.failures ?? []).map((f) => f.gate)).size : 0;
  return {
    checks: failedGates || "",
    changes: ev ? `+${ev.linesAdded ?? 0} −${ev.linesRemoved ?? 0}` : "",
    ai_review:
      reviewerFindings(ui.detail?.desk?.findings ?? [], new Set()).rows.length ||
      ui.detail?.review?.findings?.length ||
      "",
    steps:
      card.status === "in_progress"
        ? Number.parseInt(card.display?.budgetText ?? "", 10) || ""
        : card.display?.evidence
          ? ev?.turnsUsed
          : card.stepsUsed || "",
  };
}

function tabsHtml(card) {
  const counts = tabCounts(card);
  return `<div class="tabs" role="tablist" aria-label="Issue sections">${tabs()
    .map((t) => {
      const sel = t.id === ui.tab;
      const c = counts[t.id];
      return `<button class="tab" type="button" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-selected="${sel}" aria-controls="panel" tabindex="${sel ? "0" : "-1"}" aria-keyshortcuts="${t.key}">${esc(t.label)}${c !== "" && c !== undefined && c !== 0 ? ` <span class="c tnum">${esc(c)}</span>` : ""}</button>`;
    })
    .join("")}</div>`;
}

function renderTabs() {
  const host = $(".cv-tabs", ui.root);
  const card = store.card(ui.id);
  if (!host) return;
  const next = card ? tabsHtml(card) : "";
  if (host.dataset.html === next) return;
  const focusedTab = host.contains(document.activeElement)
    ? document.activeElement?.dataset?.tab
    : undefined;
  host.innerHTML = next;
  host.dataset.html = next;
  if (focusedTab) host.querySelector(`[data-tab="${focusedTab}"]`)?.focus();
}

function renderHead() {
  const card = store.card(ui.id);
  const head = $(".cv-h", ui.root);
  if (!card) {
    setTopbar({ title: "Issue", crumb: store.state.meta?.project ?? "" });
    head.innerHTML = "";
    renderTabs();
    ui.issue?.draw();
    return;
  }
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Issue",
    crumb: `${project ? `${project} › ` : ""}${boardColumnLabel(card.status)}`,
  });
  // ISS-08: the browser tab names the issue.
  document.title = `${issueDocumentTitle(card, project)} · Sekhemet`;
  const d = ui.detail;
  // ISS-07, REV-02: the actions keep their place top right; Accept's
  // conditions are a full-width checklist under the header, each linked to
  // where it is met.
  const triage = triageBarHtml(card, d?.evidence, {
    hint: false,
    detail: d,
    checklist: false,
  }).replace(/^<div class="triage[^"]*"[^>]*>|<\/div>$/g, "");
  const checklist = acceptChecklistHtml(card, d?.evidence, d, { links: checklistLinks(card.id) });
  // Tips: the issue's type explained, an enabler as one (DB-P4-6).
  const kindFacts = {
    card: {
      kind: card.kind,
      change: card.change,
      tier: card.tier,
      split: card.split,
      title: card.title,
    },
  };
  const typeTip = learnTip("type", kindTip(kindFacts.card).term, kindFacts);
  // One badge for the issue's state: never a failure mark on a stage's name (DB-N1-3);
  // a run a person stopped is Stopped, never "Checks failed" (ISS-02).
  const stopped = agentPanel(card, ui.events ?? []).state === "stopped";
  const badge = stopped
    ? { text: "Stopped", tone: "parked", mark: "parked" }
    : stateBadge(card.status, card.display?.tone ?? "neutral");
  const pill = `<span class="pill">${PILL_ICON[badge.mark ?? badge.tone] ?? ""}${esc(badge.text)}</span>${typeTip}`;
  const headHtml = ui.pane.headHtml(card, d, { attempt: ui.attempt, withTitle: false });
  const next = `<div class="line"><div style="min-width:0;flex:1 1 420px">${headHtml
    .replace(
      '<div class="outcome">',
      `<h2 class="ttl">${esc(card.display?.title ?? card.title)}</h2><div class="outcome">`,
    )
    .replace(
      '<div class="outcome">',
      `<div class="outcome">${pill}`,
    )}</div>${presenceHtml(card.id)}<div class="acts">${triage}</div></div>${checklist}`;
  if (head.dataset.html !== next) {
    const active = document.activeElement;
    const which = ["data-accept", "data-back", "data-comment", "data-park"].find(
      (a) => active?.hasAttribute?.(a) && head.contains(active),
    );
    head.innerHTML = next;
    head.dataset.html = next;
    if (which) head.querySelector(`[${which}]`)?.focus();
  }
  renderTabs();
  ui.issue?.draw();
  ui.props?.draw();
}

/** DB-N9-20: the avatars of the others viewing this issue, in its header; "" when alone. */
function presenceHtml(id) {
  const strip = viewersStrip(store.state.presence, id, getSession().principal);
  if (!strip.shown.length) return "";
  const faces = strip.shown
    .map(
      (f) =>
        `<span class="av" role="img" aria-label="${esc(PRESENCE_COPY.viewer(f.name))}" title="${esc(PRESENCE_COPY.viewer(f.name))}">${esc(f.initials)}</span>`,
    )
    .join("");
  const more = strip.more
    ? `<span class="sec tnum">${esc(PRESENCE_COPY.more(strip.more))}</span>`
    : "";
  return `<div class="pres-strip" role="group" aria-label="${esc(strip.label)}">${faces}${more}</div>`;
}

function aiReviewHtml(detail) {
  if (!detail) return ui.pane.loadingHtml();
  // NEW-dashboard-5: the Reviewer's findings, acknowledgeable, then Seshat's notes.
  const reviewer = reviewerHtml(store.card(ui.id), detail);
  if (reviewer || detail.review) return reviewer + (detail.review ? reviewHtml(detail.review) : "");
  return `<div class="ev-empty">${icon("chat", 24, "ic s24")}<b>AI review</b><span>${esc(ISSUE_COPY.aiReviewEmpty)}</span></div>`;
}

/**
 * The criteria view (NEW-dashboard-17, DB-N17-1): each acceptance criterion
 * in plain words with its check state, the AI review's findings to
 * acknowledge, and the visual check's screenshots; Accept and Send back are
 * the header's, under the same conditions as Review's (DB-N17-2), and the
 * diff is the Changes tab.
 */
function criteriaHtml(card, detail) {
  if (!detail) return ui.pane.loadingHtml();
  const full = detail.card ?? card;
  const c = criteriaChecks(full, detail.evidence ?? null);
  const items = c.items
    .map(
      (i) =>
        `<li class="cc ${esc(i.state)}"><span class="cc-mark">${i.state === "pass" ? icon("check", 14, "ic s14 i-pass") : i.state === "fail" ? icon("x", 14, "ic s14 i-fail") : '<span class="cc-none" aria-hidden="true"></span>'}</span><span class="cc-t">${esc(i.text)}</span><span class="cc-s">${esc(i.stateText)}</span></li>`,
    )
    .join("");
  const crit = `<section aria-labelledby="cv-crit-h"><h3 class="sh" id="cv-crit-h">${esc(ISSUE_COPY.criteria)} <span class="sec tnum">${esc(c.summary)}</span></h3>${items ? `<ul class="crit-checks">${items}</ul>` : `<p class="sec">${esc(ISSUE_COPY.noCriteria)}</p>`}${c.note ? `<p class="sec">${esc(c.note)}</p>` : ""}</section>`;
  const review = reviewerHtml(card, detail);
  const shots = detail.evidence
    ? shotsHtml(detail.evidence, detail.attachments ?? [], card.id)
    : "";
  const diff = `<p class="sec">The code is on the <a href="#/card/${encodeURIComponent(card.id)}/changes">Changes</a> tab.</p>`;
  return `<div class="crit-view">${crit}${review}${shots}${diff}</div>`;
}

function renderPanel({ keepScroll = true } = {}) {
  const card = store.card(ui.id);
  const body = $(".cv-body", ui.root);
  ui.tabCtl?.destroy?.();
  ui.tabCtl = null;
  if (!card && store.state.boardError) {
    // ERR-03: the issues could not be read; that is not "no such issue".
    body.innerHTML = `<div class="ev-scroll"><div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't load this issue.</b> <span class="sec">Sekhemet didn't answer with the board's issues.</span></span><button class="btn sm" type="button" data-board-retry>${icon("refresh", 14, "ic s14")}Try again</button></div></div>`;
    return;
  }
  if (!card) {
    body.innerHTML = `<div class="ev-scroll"><div class="ev-empty">${icon("alert", 24, "ic s24")}<b>No issue ${esc(ui.id)}.</b><span>It may have been removed. <a href="#/board">Back to the board</a></span></div></div>`;
    return;
  }
  const d = ui.detail;
  if (ui.tab === "criteria") {
    body.innerHTML = `<div class="ev-scroll panel" id="panel" role="tabpanel" aria-labelledby="tab-criteria" tabindex="-1">${criteriaHtml(card, d)}</div>`;
    return;
  }
  if (ui.tab === "checks") {
    const old = $(".ev-scroll", body);
    const top = old?.scrollTop ?? 0;
    body.innerHTML = `<div class="ev-scroll" id="panel" role="tabpanel" aria-labelledby="tab-checks" tabindex="-1">${d ? ui.pane.checksHtml(card, d) : ui.pane.loadingHtml()}</div><div data-facts style="display:contents">${d ? ui.pane.factsHtml(card, d) : ""}</div>`;
    if (keepScroll) $(".ev-scroll", body).scrollTop = top;
    return;
  }
  if (ui.tab === "ai_review") {
    body.innerHTML = `<div class="ev-scroll panel" id="panel" role="tabpanel" aria-labelledby="tab-ai_review" tabindex="-1">${aiReviewHtml(d)}</div>`;
    return;
  }
  body.innerHTML = `<div class="ev-scroll panel" id="panel" role="tabpanel" aria-labelledby="tab-${ui.tab}" tabindex="-1"></div>`;
  const host = $("#panel", body);
  const ctx = {
    id: ui.id,
    card: () => store.card(ui.id),
    detail: () => ui.detail,
    events: () => ui.events,
    pane: ui.pane,
    comments: () => ui.comments,
    setComments: (c) => {
      ui.comments = c;
    },
    refresh: () => {
      void loadEvents();
    },
    // TEAM-15: a comment's @Agent or @Seshat changes the AI teammates' state the header shows.
    reloadDetail: () => {
      forget(ui.id);
      void load(true);
    },
    // Files shown on the Changes tab change what Accept's reason says (DB-N5-3).
    shown: () => renderHead(),
    goTab: (t, hash) => {
      location.hash = `#/card/${encodeURIComponent(ui.id)}/${issueTab(t)}${hash ?? ""}`;
    },
  };
  const renderers = {
    activity: renderActivity,
    changes: renderChanges,
    steps: renderSteps,
    plan: renderPlan,
  };
  ui.tabCtl = renderers[ui.tab]?.(host, ctx) ?? null;
}

async function loadEvents() {
  const id = ui.id;
  // The newest entries, so a reload shows the Agent's state a page that
  // stayed open shows, however long the run (DB-P3-16).
  const res = await getJSON(issueEventsUrl(id));
  if (ui.id !== id || !ui.root) return;
  ui.events = res.ok ? oldestFirst(res.data.events) : [];
  renderHead();
  ui.tabCtl?.onEvents?.();
}

async function load(keepScroll = false) {
  const id = ui.id;
  const seq = ++ui.loadSeq;
  const card = store.card(id);
  ui.pane.forCard(id);
  // TEAM-15: a delegation to the Agent reloads the detail, which carries the AI's state.
  ui.sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}|${card?.delegate?.kind ?? ""}`;
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
  // DB-N14-2: Ready to start, above the tabs, while it has not started building.
  void renderReady($("[data-ready]", ui.root), id, card?.status);
  const d = await loadDetail(id, ui.attempt);
  if (seq !== ui.loadSeq || ui.id !== id || !ui.root) return;
  ui.detail = d;
  renderHead();
  if (ui.tab === "checks" || ui.tab === "ai_review" || ui.tab === "criteria" || !ui.tabCtl)
    renderPanel({ keepScroll });
  else ui.tabCtl.onDetail?.();
}

function runAction(key) {
  const card = store.card(ui.id);
  if (!card) return false;
  const ev = ui.detail?.evidence;
  if (key === "a") {
    accept(card, ev, {
      detail: ui.detail,
      onChange: () => renderHead(),
      onMerged: () => renderHead(),
    });
    return true;
  }
  if (key === "r" && ev) {
    if ($("[data-composer]", ui.root)) return true;
    $(".cv-body", ui.root).insertAdjacentHTML(
      "beforebegin",
      composerHtml(quickNotes(card, ev, store.state.gates), { comments: ui.comments }),
    );
    ui.closeComposer = wireComposer($("[data-composer]", ui.root), card, {
      // DB-N8-4: Send back carries the comments made on diff lines.
      comments: () => ui.comments,
      onSent: () => {
        ui.closeComposer = null;
        ui.comments = [];
        ui.tabCtl?.rerender?.();
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
  if (key === "comment") {
    // Teams item 25: Comment — a review with no verdict; the drafted line comments open threads.
    if ($("[data-comment-form]", ui.root)) return true;
    $(".cv-body", ui.root).insertAdjacentHTML(
      "beforebegin",
      commentFormHtml({ comments: ui.comments }),
    );
    wireCommentForm($("[data-comment-form]", ui.root), card, {
      comments: () => ui.comments,
      onSent: () => {
        ui.comments = [];
        forget(ui.id);
        void load(true);
        ui.tabCtl?.rerender?.();
      },
    });
    return true;
  }
  return false;
}

function selectTab(tab, { focus = false } = {}) {
  if (!tabs().some((t) => t.id === tab)) return;
  history.replaceState(null, "", `#/card/${encodeURIComponent(ui.id)}/${tab}`);
  ui.tab = tab;
  renderTabs();
  renderPanel({ keepScroll: false });
  if (focus) $(`[data-tab="${tab}"]`, ui.root)?.focus();
}

function onKey(e) {
  const k = e.key;
  const list = tabs();
  const byKey = list.find((t) => t.key === k);
  if (byKey) {
    selectTab(byKey.id, { focus: false });
    return true;
  }
  // WAI-ARIA tabs: arrows move between tabs when a tab has focus.
  if ((k === "ArrowRight" || k === "ArrowLeft") && e.target.closest?.("[role=tab]")) {
    const i = list.findIndex((t) => t.id === ui.tab);
    const next = list[(i + (k === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    selectTab(next.id, { focus: true });
    return true;
  }
  if (k === "a" || k === "r" || k === "p") return runAction(k);
  // DB-N5-3: `x` acknowledges the focused Reviewer finding (or the first open one).
  if (k === "x") {
    const card = store.card(ui.id);
    if (card && ui.detail && acknowledgeFocused(ui.root, card, ui.detail)) {
      renderHead();
      renderPanel();
      focusNextFinding(ui.root, card, ui.detail);
    }
    return true;
  }
  if (ui.tabCtl?.onKey?.(e)) return true;
  if (k === "[" || k === "]") {
    if (ui.tab !== "checks" && ui.tab !== "changes") return false;
    const n = ui.detail?.attempts?.length ?? 0;
    const cur = ui.attempt ?? n;
    const next = Math.max(1, Math.min(n, cur + (k === "]" ? 1 : -1)));
    if (n > 1 && next !== cur) {
      ui.attempt = next === n ? undefined : next;
      load();
    }
    return true;
  }
  if (ui.tab === "checks" && k === "f") {
    ui.pane.factsHidden = !ui.pane.factsHidden;
    const f = $(".facts", ui.root);
    if (f) f.hidden = ui.pane.factsHidden;
    return true;
  }
  if (ui.tab !== "changes") return false;
  if (k === "u") {
    ui.pane.mode = nextDiffMode(ui.pane.mode);
    ui.tabCtl?.rerender?.();
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

function setParams(params) {
  const id = params?.[0];
  const tab = issueTab(params?.[1]);
  if (id === ui.id) {
    if (tab !== ui.tab) selectTab(tab);
    return;
  }
  ui.closeComposer?.();
  ui.id = id;
  ui.tab = tab;
  ui.attempt = undefined;
  ui.events = null;
  ui.comments = [];
  ui.watchers = [];
  store.state.focusedId = id;
  // An old tab name in the address becomes the tab it now lives in.
  if (params?.[1] && params[1] !== tab) {
    history.replaceState(null, "", `#/card/${encodeURIComponent(id)}/${tab}`);
  }
  load();
  loadEvents();
  ui.watch?.load();
  // TEAM-26: the others viewing this issue see this person's avatar.
  announceIssue(id);
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  // ISS-01: the main column beside the 288 px properties rail (a disclosure
  // under the header below 1280 px); the Watch toggle sits in the rail (ISS-07).
  root.innerHTML =
    '<section class="cv" aria-label="Issue"><div class="cv-h"></div><div class="cv-cols"><div class="cv-main"><div class="cv-apv" data-approval hidden></div><div class="cv-sug" data-suggestions hidden></div><div class="cv-issue" data-issue></div><div class="cv-ready" data-ready hidden></div><div class="cv-tabs"></div><div class="cv-body"></div></div><details class="cv-rail" data-rail><summary>Properties</summary><div data-props></div><div class="cv-watch" data-watch-host hidden></div></details></div></section>';
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
  ui.pane.bind(root, {
    rerender: () => {
      renderHead();
      return ui.tabCtl?.rerender ? ui.tabCtl.rerender() : renderPanel();
    },
    reload: () => load(true),
    current: () => ({ card: store.card(ui.id), detail: ui.detail }),
  });
  // Teams item 22: the watchers and the Watch toggle, in the Team setup.
  ui.watch = mountWatch($("[data-watch-host]", root), {
    id: () => ui.id,
    onState: (state) => {
      ui.watchers = (state?.watchers ?? []).map((w) => w.name);
      ui.props?.draw();
    },
  });
  ui.props = mountProperties($("[data-rail]", root), {
    card: () => store.card(ui.id),
    detail: () => ui.detail,
    events: () => ui.events,
    watchers: () => ui.watchers,
  });
  ui.issue = mountIssue($("[data-issue]", root), {
    get id() {
      return ui.id;
    },
    card: () => store.card(ui.id),
    detail: () => ui.detail,
    events: () => ui.events,
    refresh: () => {
      void loadEvents();
    },
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest("[data-tab]");
    if (tab) selectTab(tab.dataset.tab);
    else if (t.closest("[data-accept]")) runAction("a");
    else if (t.closest("[data-back]")) runAction("r");
    else if (t.closest("[data-park]")) runAction("p");
    else if (t.closest("[data-comment]")) runAction("comment");
    else if (t.closest("[data-board-retry]"))
      window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
  });
  ui.unsub = store.on((_s, patch) => {
    if (!ui.root) return;
    if ("decisions" in patch) ui.tabCtl?.onStore?.(patch);
    // DB-N9-20: someone opened or left this issue.
    if ("presence" in patch) renderHead();
    if (!("cards" in patch || "connection" in patch || "verification" in patch)) return;
    const mine = (store.state.feed ?? []).filter((e) => e.cardId === ui.id);
    if ("cards" in patch && mine.length && ui.events) {
      const have = new Set(ui.events.map((e) => e.seq));
      const fresh = mine.filter((e) => !have.has(e.seq));
      if (fresh.length) {
        ui.events = [...ui.events, ...fresh];
        ui.tabCtl?.onEvents?.(fresh);
        // Commenting, a mention, an owner, a delegate or a review subscribes someone (TEAM-21).
        if (
          fresh.some((e) =>
            /^(issue\/|card\/(owner_changed|delegated|status_changed))/.test(e.type),
          )
        )
          ui.watch?.load();
        // Teams item 25: a review comment, a reply, a resolve or a dismissed
        // accept changes the threads and what Accept waits on.
        if (fresh.some((e) => /^review\/(commented|thread_|accept_dismissed)/.test(e.type))) {
          forget(ui.id);
          void load(true);
        }
      }
    }
    const card = store.card(ui.id);
    const sig = `${card?.status}|${card?.display?.evidence?.id ?? ""}|${card?.delegate?.kind ?? ""}`;
    if (sig !== ui.sig && !$("[data-composer]", ui.root)) load(true);
    else renderHead();
    ui.tabCtl?.onStore?.(patch);
  });
  setParams(route.params);
  return {
    onKey,
    setParams,
    // A11Y-02: Esc leaves the issue for the page the person came from, else the board.
    // Inside Accept's grace Esc cancels it instead: leaving would send it (§2.5.10).
    onEscape() {
      if (acceptPending(ui.id)) return undoAccept();
      const back = store.state.previousRoute;
      location.hash = back && !/^#\/card\//.test(back) ? back : "#/board";
      return true;
    },
    cardAction: (key, card) => {
      if (card.id !== ui.id) return false;
      return runAction(key);
    },
    unmount() {
      announceIssue(null);
      ui.closeComposer?.();
      ui.tabCtl?.destroy?.();
      ui.tabCtl = null;
      ui.issue = null;
      ui.props?.destroy();
      ui.props = null;
      ui.unsub?.();
      root.remove();
      ui.root = null;
      ui.id = null;
    },
  };
}
