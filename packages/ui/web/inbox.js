// Inbox (dashboard §2.17.2, DB-N9-14; teams items 22–24): what reached you,
// across projects, grouped by reason — Needs you, Mentioned, Review
// requested, Watching, Agent finished — the way Linear's Inbox reads, with
// Done, Snooze and Save on each row and the Inbox · Saved · Done tabs.
// Selecting a row marks it read and fills the reading pane (NEW-dashboard-19,
// DEC-51: two panes from 1100 px, one list below with the pane in its place).
// *Needs you* carries the questions waiting on
// you: a request to start the Agent (Start, Decline), a plan sent for your
// approval, a mention of someone who cannot see the project (Invite, Don't
// invite), and decision requests, answered here with their options (the
// planner's and the kernel's, §2.5.7). Every word is `/app/lib/inbox.js`'s.
import { byWait, duration, mergeDecisions, policyLine, waited } from "./decision.js";
import { $, $$, aiBadge, esc, getJSON, icon, postJSON } from "./dom.js";
import { viewerManagesWork } from "./learn.js";
import {
  INBOX_COPY as C,
  INBOX_FILTERS,
  INBOX_SPLIT_PX,
  INBOX_PANE_COPY as PC,
  SNOOZE_CHOICES,
  causeComment,
  inboxGroups,
  itemLine,
  paneOpenHref,
  readingFacts,
  snoozeUntil,
} from "./lib/inbox.js";
import { parseTitle, shortId } from "./lib/vocabulary.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

const ui = {
  root: null,
  filter: "inbox",
  data: null,
  picked: new Map(),
  confirm: new Set(),
  focus: 0,
  last: "",
  lastPane: "",
  timer: 0,
  /** The item the reading pane shows (DB-N19-7). */
  selected: "",
  /** Below 1100 px: the pane is open in the list's place (DB-N19-9). */
  reading: false,
  /** The selected issue's card and comments: `{id, loading?, card?, comments?}`. */
  pane: { id: "" },
  draftFor: "",
};

/** Fetch both decision sources into the store (`decisions` slice, U21). */
export async function refreshDecisions() {
  const [planner, plain] = await Promise.all([
    getJSON("/api/planner/decisions").catch(() => ({ ok: false })),
    getJSON("/api/decisions?status=pending").catch(() => ({ ok: false })),
  ]);
  const available = planner.ok || plain.ok;
  const items = mergeDecisions(
    planner.ok ? planner.data?.decisions : [],
    plain.ok ? plain.data?.decisions : [],
  );
  store.set({ decisions: { available, items, at: Date.now() } });
  return items;
}

/** The Inbox's unread count for the sidebar badge, and this page's rows when it is open. */
export async function refreshInbox() {
  const other = ui.root && ui.filter !== "inbox" ? ui.filter : undefined;
  const [main, tab] = await Promise.all([
    getJSON("/api/inbox?filter=inbox").catch(() => ({ ok: false })),
    other
      ? getJSON(`/api/inbox?filter=${encodeURIComponent(other)}`).catch(() => ({ ok: false }))
      : undefined,
  ]);
  const shown = tab ?? main;
  if (ui.root) {
    if (shown.ok) ui.data = shown.data;
    else if (!ui.data) ui.data = { error: shown.status || "no response" };
  }
  // The badge counts what is unread in the Inbox tab, whichever tab is open.
  if (main.ok) store.set({ inbox: { unread: main.data?.unread ?? 0, at: Date.now() } });
  else render();
}

/** The planning model's questions the person may answer: not tied to an issue the server filed. */
function plannerDecisions(items) {
  const s = getSession();
  const mayAnswer = s.mode !== "team" || s.level === "member" || s.level === "admin";
  if (!mayAnswer) return [];
  const filed = new Set(items.map((i) => i.id));
  return byWait(store.state.decisions.items ?? [], store.state.now ?? Date.now()).filter(
    (d) => d.source === "planner" && !filed.has(d.id),
  );
}

/** Linear's row time: *just now*, else how long ago. */
const ago = (at) => {
  const ms = Math.max(0, Date.now() - Date.parse(at ?? ""));
  return ms < 60_000 ? "just now" : `${duration(ms)} ago`;
};

function aiHtml(lines) {
  if (!lines?.length) return "";
  return `<span class="ib-ai">${lines
    .map(
      (l) =>
        `<span class="ib-ai-line"><b>${esc(l.name)}</b>${aiBadge()}<span class="ib-state">${esc(l.label)}</span> <span class="sec">${esc(l.sentence)}</span></span>`,
    )
    .join("")}</span>`;
}

function actionsHtml(item, { primaryDone = false } = {}) {
  const id = esc(item.id);
  const done =
    ui.filter === "done"
      ? `<button class="btn sm" type="button" data-act="undone" data-id="${id}">${esc(C.undone)}</button>`
      : `<button class="btn sm${primaryDone ? " primary" : ""}" type="button" data-act="done" data-id="${id}" aria-keyshortcuts="e">${icon("check", 14, "ic s14")}${esc(C.done)}</button>`;
  // A disclosure of buttons, not an ARIA menu: Tab and Enter reach each choice (A11Y-04).
  const snooze = `<details class="ib-snooze"><summary class="btn sm">${icon("clock", 14, "ic s14")}${esc(C.snooze)}</summary><div class="ib-menu">${SNOOZE_CHOICES.map(
    (c) =>
      `<button type="button" data-snooze="${esc(c.value)}" data-id="${id}">${esc(c.label)}</button>`,
  ).join("")}</div></details>`;
  const save = `<button class="btn sm" type="button" data-act="${item.saved ? "unsave" : "save"}" data-id="${id}" aria-pressed="${item.saved}">${esc(item.saved ? C.saved : C.save)}</button>`;
  return `${snooze}${save}${done}`;
}

/** The item's own answers: Start/Decline, Invite/Don't invite. */
function answersHtml(item) {
  if (item.kind === "start_request" && item.request)
    return `<span class="ib-answers"><button class="btn sm primary" type="button" data-start="${esc(item.request.id)}" data-card="${esc(item.cardId)}" data-needs="agent.start"${item.project ? ` data-needs-project="${esc(item.project.id)}" data-needs-project-name="${esc(item.project.name)}"` : ""}>${esc(C.start)}</button><button class="btn sm" type="button" data-decline="${esc(item.request.id)}" data-card="${esc(item.cardId)}" data-needs="agent.start" data-needs-quiet${item.project ? ` data-needs-project="${esc(item.project.id)}" data-needs-project-name="${esc(item.project.name)}"` : ""}>${esc(C.decline)}</button></span>`;
  if (item.kind === "mention_invite" && item.mention)
    return `<span class="ib-answers"><button class="btn sm primary" type="button" data-mention="invite" data-comment="${esc(item.mention.commentId)}" data-card="${esc(item.cardId)}">${esc(C.invite)}</button><button class="btn sm" type="button" data-mention="skip" data-comment="${esc(item.mention.commentId)}" data-card="${esc(item.cardId)}">${esc(C.dontInvite)}</button></span>`;
  return "";
}

/** One row of the list (DB-N19-7): what it is about, why, and when; its actions are the pane's. */
function rowHtml(item, i) {
  const words = itemLine(item);
  const key = item.cardId ? `<span class="ib-key mono">${esc(shortId(item.cardId))}</span>` : "";
  const project = item.project ? `<span class="ib-proj sec">${esc(item.project.name)}</span>` : "";
  const snoozed = item.snoozedUntil
    ? `<span class="sec ib-snoozed">${esc(C.snoozedUntil(new Date(item.snoozedUntil).toLocaleString()))}</span>`
    : "";
  const sel = item.id === ui.selected;
  return `<li class="ib-row${item.unread ? " unread" : ""}${i === ui.focus ? " focus" : ""}${sel ? " selected" : ""}" data-i="${i}" data-item="${esc(item.id)}"><div class="ib-line"><span class="ib-dot" aria-hidden="true"></span><a class="ib-main" href="${esc(paneOpenHref(item, viewerManagesWork()))}" data-open="${esc(item.id)}"${sel ? ' aria-current="true"' : ""} tabindex="${i === ui.focus ? "0" : "-1"}">${item.unread ? '<span class="sr-only">Unread: </span>' : ""}<span class="ib-title">${esc(words.title)}</span><span class="ib-sub">${key}${project}<span class="ib-what">${esc(words.line)}</span></span></a><time class="ib-time sec tnum" datetime="${esc(item.at)}">${esc(ago(item.at))}</time></div>${aiHtml(words.ai)}${snoozed}</li>`;
}

/** A planning-model question not filed as an item: a row like the others, answered in the pane. */
function plannerRowHtml(d, i) {
  const c = d.cardId ? store.card(d.cardId) : null;
  const title = c ? (c.display?.title ?? parseTitle(c.title).title) : "";
  const id = `planner:${d.id}`;
  const sel = id === ui.selected;
  const long = waited(d, store.state.now) > 2 * 3600_000;
  return `<li class="ib-row unread${i === ui.focus ? " focus" : ""}${sel ? " selected" : ""}" data-i="${i}" data-item="${esc(id)}"><div class="ib-line"><span class="ib-dot" aria-hidden="true"></span><a class="ib-main" href="#/inbox" data-open="${esc(id)}"${sel ? ' aria-current="true"' : ""} tabindex="${i === ui.focus ? "0" : "-1"}"><span class="sr-only">Unread: </span><span class="ib-title">${esc(d.question)}</span><span class="ib-sub">${title ? `<span class="ib-proj sec">${esc(title)}</span>` : ""}<span class="ib-what">The planning model asks.</span></span></a><span class="ib-wait tnum${long ? " long" : ""}">${icon("clock", 12, "ic s12")}waiting ${esc(duration(waited(d, store.state.now)))}</span></div></li>`;
}

/** Every row the list shows, in its order: the items, and the planner's questions under Needs you. */
function listEntries() {
  const data = ui.data;
  if (!data || data.error !== undefined) return [];
  const items = data.items ?? [];
  const extra = ui.filter === "inbox" ? plannerDecisions(items) : [];
  const out = [];
  const groups = inboxGroups(items);
  if (extra.length && !groups.some((g) => g.reason === "needs_you"))
    for (const d of extra) out.push({ id: `planner:${d.id}`, planner: d });
  for (const g of groups) {
    for (const it of g.items) out.push({ id: it.id, item: it });
    if (g.reason === "needs_you")
      for (const d of extra) out.push({ id: `planner:${d.id}`, planner: d });
  }
  return out;
}

function listHtml() {
  const data = ui.data;
  const tabs = `<div class="tabs ptabs ib-tabs" role="tablist" aria-label="${esc(C.title)}">${INBOX_FILTERS.map(
    (f) =>
      `<button class="tab" type="button" role="tab" data-filter="${esc(f.value)}" aria-selected="${ui.filter === f.value}" tabindex="${ui.filter === f.value ? "0" : "-1"}">${esc(f.label)}</button>`,
  ).join("")}</div>`;
  let body;
  if (!data) body = '<div class="sk" style="height:160px"></div>';
  else if (data.error !== undefined)
    body = `<p class="stp-notice" role="status"><b>Couldn't load the Inbox.</b> <span class="sec">The server returned ${esc(data.error)}.</span></p>`;
  else {
    const items = data.items ?? [];
    const extra = ui.filter === "inbox" ? plannerDecisions(items) : [];
    const groups = inboxGroups(items);
    let i = 0;
    const alone = extra.length && !groups.some((g) => g.reason === "needs_you");
    const first = alone
      ? `<section class="ib-group" aria-labelledby="ib-h-needs_you"><h2 id="ib-h-needs_you">Needs you <span class="sec tnum">${extra.length}</span></h2><ol class="ib-rows">${extra.map((d) => plannerRowHtml(d, i++)).join("")}</ol></section>`
      : "";
    const sections = groups.map((g) => {
      const rows = g.items.map((it) => rowHtml(it, i++)).join("");
      const more =
        g.reason === "needs_you" ? extra.map((d) => plannerRowHtml(d, i++)).join("") : "";
      return `<section class="ib-group" aria-labelledby="ib-h-${esc(g.reason)}"><h2 id="ib-h-${esc(g.reason)}">${esc(g.label)} <span class="sec tnum">${g.items.length + (g.reason === "needs_you" ? extra.length : 0)}</span></h2><ol class="ib-rows">${rows}${more}</ol></section>`;
    });
    if (first) sections.unshift(first);
    ui.count = i;
    ui.focus = Math.min(ui.focus, Math.max(0, i - 1));
    const empty =
      ui.filter === "saved" ? C.emptySaved : ui.filter === "done" ? C.emptyDone : C.empty;
    body = sections.length
      ? sections.join("")
      : `<div class="ib-empty">${icon("inbox", 24, "ic s24")}<b>${esc(empty)}</b>${ui.filter === "inbox" ? `<span>${esc(C.emptyHint)}</span>` : ""}</div>`;
  }
  return `${tabs}${body}`;
}

/** The selected entry: an Inbox item, or a planner question. */
function selectedEntry() {
  return listEntries().find((e) => e.id === ui.selected);
}

/** DB-N19-7: the reading pane for the selected item. */
function paneHtml() {
  const entry = selectedEntry();
  const back = `<button class="btn sm ghost ib-back" type="button" data-back>${icon("back", 14, "ic s14")}${esc(PC.backToInbox)}</button>`;
  if (!entry)
    return `<div class="ib-pane-empty">${icon("inbox", 24, "ic s24")}<span class="sec">${esc(PC.noSelection)}</span></div>`;
  const now = store.state.now ?? Date.now();
  if (entry.planner) {
    const d = entry.planner;
    return `<header class="ib-pane-h">${back}</header><div class="ib-pane-b">${decisionHtml(d, {
      picked: ui.picked.get(d.id),
      confirm: ui.confirm.has(d.id),
      now,
      title: d.cardId
        ? `For <a href="#/card/${encodeURIComponent(d.cardId)}/activity">${esc(store.card(d.cardId)?.display?.title ?? d.cardId)}</a>`
        : "",
    })}</div>`;
  }
  const item = entry.item;
  const words = itemLine(item);
  const crumb = `<span class="ib-crumb sec">${item.project ? `${esc(item.project.name)} <span aria-hidden="true">/</span> ` : ""}${item.cardId ? `<span class="mono">${esc(shortId(item.cardId))}</span>` : ""}</span>`;
  const pane = ui.pane.id === item.id ? ui.pane : { id: item.id, loading: Boolean(item.cardId) };
  const facts = pane.card ? `<p class="ib-facts sec">${esc(readingFacts(pane.card))}</p>` : "";
  const decision =
    item.kind === "decision"
      ? (store.state.decisions.items ?? []).find((d) => d.id === item.id)
      : undefined;
  let cause = "";
  if (decision)
    cause = decisionHtml(decision, {
      picked: ui.picked.get(decision.id),
      confirm: ui.confirm.has(decision.id),
      now,
    });
  else {
    const c = pane.comments ? causeComment(item, pane.comments) : undefined;
    const quote = c
      ? `<blockquote class="ib-quote"><p class="ib-quote-h"><b>${esc(c.name)}</b> <time class="sec tnum" datetime="${esc(c.postedAt)}">${esc(ago(c.postedAt))}</time></p><p>${esc(c.text)}</p></blockquote>`
      : "";
    cause = `<p class="ib-cause">${esc(words.line)}</p>${quote}${aiHtml(words.ai)}${answersHtml(item)}`;
  }
  const inReview = item.kind === "plan_approval" || item.reason === "review_requested";
  const href = paneOpenHref(item, viewerManagesWork());
  const open = href
    ? `<a class="btn sm" href="${esc(href)}" data-open-issue="${esc(item.id)}">${esc(inReview ? PC.reviewIt : PC.openIssue)}</a>`
    : "";
  const reply = item.cardId
    ? `<form class="ib-reply" data-reply="${esc(item.cardId)}"><label class="sr-only" for="ib-reply-text">${esc(PC.replyLabel)}</label><textarea id="ib-reply-text" name="text" rows="3" placeholder="${esc(PC.replyPlaceholder)}"></textarea><div class="ib-reply-f"><span class="sec">${esc(PC.replyPlaceholder)}</span>${open}<button class="btn sm primary" type="submit">${esc(PC.reply)}</button></div></form>`
    : open
      ? `<div class="ib-reply-f">${open}</div>`
      : "";
  return `<header class="ib-pane-h">${back}${crumb}<span class="ib-pane-acts">${actionsHtml(item, { primaryDone: true })}</span></header><div class="ib-pane-b"><h2 class="ib-pane-t" id="ib-pane-title" tabindex="-1">${esc(words.title)}</h2>${pane.loading ? `<p class="sec">${esc(PC.loading)}</p>` : facts}${cause}${reply}</div>`;
}

/** Two panes from 1100 px; below, one list and the pane in its place (DB-N19-7, -9). */
const wide = () => window.matchMedia(`(min-width: ${INBOX_SPLIT_PX}px)`).matches;

function render() {
  if (!ui.root) return;
  const unread = store.state.inbox?.unread ?? 0;
  setTopbar({ title: C.title, crumb: unread ? C.unread(unread) : "" });
  // On a wide page the first item is shown until another is chosen; it is not marked read.
  const entries = listEntries();
  if (!entries.some((e) => e.id === ui.selected)) {
    ui.selected = wide() ? (entries[ui.focus]?.id ?? entries[0]?.id ?? "") : "";
    if (!ui.selected) ui.reading = false;
    if (ui.selected) void loadPane();
  }
  const split = $(".ib-split", ui.root);
  split.classList.toggle("reading", ui.reading && Boolean(ui.selected));
  const listHost = $(".ib-list", ui.root);
  const list = listHtml();
  if (list !== ui.last) {
    ui.last = list;
    const top = listHost.scrollTop;
    const had = listHost.contains(document.activeElement) ? document.activeElement : null;
    const refocus = had?.closest(".ib-row")?.dataset.item;
    listHost.innerHTML = list;
    listHost.scrollTop = top;
    if (refocus) $(`.ib-row[data-item="${CSS.escape(refocus)}"] .ib-main`, listHost)?.focus();
  }
  renderPane();
}

function renderPane() {
  const host = $(".ib-pane", ui.root);
  if (!host) return;
  const html = paneHtml();
  if (html === ui.lastPane) return;
  ui.lastPane = html;
  // A reply being written survives a refresh of the pane.
  const draft = $("#ib-reply-text", host)?.value ?? "";
  const typing = document.activeElement?.id === "ib-reply-text";
  host.innerHTML = html;
  const box = $("#ib-reply-text", host);
  if (box && draft && ui.draftFor === ui.selected) box.value = draft;
  if (box && typing) box.focus();
  ui.draftFor = ui.selected;
}

/** The selected issue's column, people and comments, for the pane. */
async function loadPane() {
  const entry = selectedEntry();
  const item = entry?.item;
  if (!item?.cardId) {
    ui.pane = { id: entry?.id ?? "" };
    return;
  }
  const id = item.id;
  ui.pane = { id, loading: true };
  const [c, m] = await Promise.all([
    getJSON(`/api/cards/${encodeURIComponent(item.cardId)}`).catch(() => ({ ok: false })),
    getJSON(`/api/cards/${encodeURIComponent(item.cardId)}/comments`).catch(() => ({ ok: false })),
  ]);
  if (ui.pane.id !== id) return;
  ui.pane = {
    id,
    loading: false,
    ...(c.ok && c.data?.card ? { card: c.data.card } : {}),
    comments: m.ok ? (m.data?.comments ?? []) : [],
  };
  renderPane();
}

async function act(id, action, extra) {
  const res = await postJSON(`/api/inbox/items/${encodeURIComponent(id)}/${action}`, extra ?? {});
  if (!res.ok) {
    toast({
      text: C.couldNot,
      detail: res.data?.error ?? `The server returned ${res.status}.`,
      tone: "fail",
    });
    return false;
  }
  await refreshInbox();
  return true;
}

async function answerDecision(id) {
  const d = (store.state.decisions.items ?? []).find((x) => x.id === id);
  const option = ui.picked.get(id);
  if (!d || option === undefined) return;
  if (d.options[option]?.destructive && !ui.confirm.has(id)) {
    ui.confirm.add(id);
    ui.lastPane = "";
    render();
    return;
  }
  const path =
    d.source === "planner"
      ? `/api/planner/decisions/${encodeURIComponent(id)}`
      : `/api/decisions/${encodeURIComponent(id)}`;
  const res = await postJSON(path, { option });
  if (res.ok) {
    toast({ text: `Answered: ${d.options[option].label}`, tone: "info" });
    ui.picked.delete(id);
    ui.confirm.delete(id);
    await refreshDecisions();
    await refreshInbox();
  } else {
    toast({
      text: "Couldn't record the answer.",
      detail: res.data?.error ?? `The server returned ${res.status}.`,
      tone: "fail",
    });
  }
}

async function post(path, body, done) {
  const res = await postJSON(path, body);
  if (!res.ok) {
    toast({
      text: C.couldNot,
      detail: res.data?.error ?? `The server returned ${res.status}.`,
      tone: "fail",
    });
    return;
  }
  if (done) toast({ text: done, tone: "info" });
  await refreshInbox();
}

/** DB-N19-8: *Reply* posts on the issue as the person's comment, and the pane stays. */
async function reply(form) {
  const box = $("textarea", form);
  const text = box?.value.trim() ?? "";
  if (!text) {
    box?.focus();
    return;
  }
  const res = await postJSON(`/api/cards/${encodeURIComponent(form.dataset.reply)}/comments`, {
    text,
  });
  if (!res.ok) {
    toast({
      text: PC.couldNotReply,
      detail: res.data?.error ?? `The server returned ${res.status}.`,
      tone: "fail",
    });
    return;
  }
  if (box) box.value = "";
  toast({ text: PC.replied, tone: "pass" });
  void loadPane();
}

function pick(id, i) {
  ui.picked.set(id, i);
  ui.confirm.delete(id);
  ui.lastPane = "";
  renderPane();
}

/**
 * Selecting an item fills the pane and keeps the person in the Inbox
 * (DB-N19-8); it marks the item read (teams item 24). Below 1100 px the pane
 * takes the list's place, with *Back to Inbox*.
 */
function select(i, { open = false, focus = true } = {}) {
  const list = rows();
  const row = list[i];
  if (!row) return;
  ui.focus = i;
  const id = row.dataset.item;
  const changed = id !== ui.selected;
  ui.selected = id;
  const item = (ui.data?.items ?? []).find((x) => x.id === id);
  if (item?.unread) void act(id, "read");
  if (open && !wide()) ui.reading = true;
  for (const [j, n] of list.entries()) {
    n.classList.toggle("focus", j === i);
    n.classList.toggle("selected", j === i);
    const a = $(".ib-main", n);
    a?.setAttribute("tabindex", j === i ? "0" : "-1");
    if (j === i) a?.setAttribute("aria-current", "true");
    else a?.removeAttribute("aria-current");
  }
  ui.last = "";
  if (changed) {
    ui.pane = { id, loading: true };
    void loadPane();
  }
  render();
  if (ui.reading) $("#ib-pane-title", ui.root)?.focus();
  else if (focus) {
    const r = rows()[i];
    $(".ib-main", r)?.focus();
    r?.scrollIntoView({ block: "nearest" });
  }
}

/** *Back to Inbox*: the list again, focus on the same row (DB-N19-9). */
function back() {
  ui.reading = false;
  render();
  const r = rows()[ui.focus];
  $(".ib-main", r)?.focus();
  r?.scrollIntoView({ block: "nearest" });
}

const rows = () => $$(".ib-list .ib-row", ui.root);

export function onKey(e) {
  if (document.activeElement?.closest?.(".ib-reply")) return false;
  const list = rows();
  const cur = list[ui.focus];
  const id = cur?.dataset.item;
  const decision = $(".ib-pane [data-decision]", ui.root)?.dataset.decision;
  if (/^[1-9]$/.test(e.key) && decision) {
    const d = (store.state.decisions.items ?? []).find((x) => x.id === decision);
    if (d && Number(e.key) <= d.options.length) {
      pick(decision, Number(e.key) - 1);
      return true;
    }
  }
  if (e.key === "Enter" && cur) {
    if (decision && ui.picked.has(decision)) answerDecision(decision);
    else select(ui.focus, { open: true });
    return true;
  }
  if (e.key === "e" && id && !id.startsWith("planner:")) {
    void act(id, ui.filter === "done" ? "undone" : "done");
    return true;
  }
  const step =
    e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
  if (step && list.length && !ui.reading) {
    // j/k move the selection and the focus together (DB-N19-8; FINDINGS TEAM-01).
    select(Math.max(0, Math.min(list.length - 1, ui.focus + step)));
    return true;
  }
  return false;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc ib-view" aria-label="${esc(C.title)}"><div class="ib-split"><div class="ib-list"></div><section class="ib-pane" aria-label="${esc(PC.paneLabel)}"></section></div></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.lastPane = "";
  ui.data = null;
  ui.filter = "inbox";
  ui.selected = "";
  ui.reading = false;
  ui.pane = { id: "" };
  root.addEventListener("change", (e) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const art = input?.closest("[data-decision]");
    if (input?.dataset.opt !== undefined && art)
      pick(art.dataset.decision, Number(input.dataset.opt));
  });
  root.addEventListener("submit", (e) => {
    const form = e.target instanceof HTMLFormElement ? e.target : null;
    if (!form?.matches("[data-reply]")) return;
    e.preventDefault();
    void reply(form);
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest("[data-filter]");
    if (tab) {
      ui.filter = tab.dataset.filter;
      ui.data = null;
      ui.focus = 0;
      ui.selected = "";
      ui.reading = false;
      render();
      void refreshInbox();
      return;
    }
    if (t.closest("[data-back]")) {
      back();
      return;
    }
    const answer = t.closest("[data-answer]");
    if (answer) {
      answerDecision(answer.dataset.answer);
      return;
    }
    const a = t.closest("[data-act]");
    if (a) {
      void act(a.dataset.id, a.dataset.act);
      return;
    }
    const s = t.closest("[data-snooze]");
    if (s) {
      s.closest("details")?.removeAttribute("open");
      void act(s.dataset.id, "snooze", { until: snoozeUntil(s.dataset.snooze, new Date()) });
      return;
    }
    const start = t.closest("[data-start],[data-decline]");
    if (start) {
      const which = start.dataset.start ? "start" : "decline";
      const req = start.dataset.start ?? start.dataset.decline;
      void post(
        `/api/cards/${encodeURIComponent(start.dataset.card)}/agent-requests/${encodeURIComponent(req)}/${which}`,
        {},
      );
      return;
    }
    const mention = t.closest("[data-mention]");
    if (mention) {
      void post(
        `/api/cards/${encodeURIComponent(mention.dataset.card)}/comments/${encodeURIComponent(mention.dataset.comment)}/mention`,
        { answer: mention.dataset.mention },
      );
      return;
    }
    const o = t.closest("[data-open]");
    if (o) {
      // A plain click selects; a modified click opens the issue as a link does.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const row = o.closest(".ib-row");
      select(Number(row?.dataset.i ?? 0), { open: true });
    }
  });
  const unsub = store.on((_s, patch) => {
    if ("inbox" in patch || "decisions" in patch || "now" in patch) render();
  });
  // Crossing 1100 px changes the layout: one list, or two panes.
  const mq = window.matchMedia(`(min-width: ${INBOX_SPLIT_PX}px)`);
  const onWidth = () => {
    ui.reading = false;
    ui.last = "";
    render();
  };
  mq.addEventListener("change", onWidth);
  render();
  void refreshInbox();
  refreshDecisions().catch(() => {});
  // Relative times move to the minute, never every second (§2.5.7).
  ui.timer = setInterval(() => store.set({ now: Date.now() }), 60_000);
  return {
    onKey,
    onEscape() {
      if (!ui.reading) return false;
      back();
      return true;
    },
    unmount() {
      clearInterval(ui.timer);
      mq.removeEventListener("change", onWidth);
      unsub();
      root.remove();
      ui.root = null;
    },
  };
}

/** One decision request as a card-width panel. `picked` is the chosen index. */
function decisionHtml(d, { picked, confirm = false, now = Date.now(), title = "" } = {}) {
  const pol = policyLine(d, now);
  const opts = d.options
    .map((o, i) => {
      const rec = i === d.recommended;
      const meta = [o.effort ? `Effort ${esc(o.effort)}` : "", o.risk ? `Risk: ${esc(o.risk)}` : ""]
        .filter(Boolean)
        .join(" · ");
      const preview = o.preview
        ? `<details class="dq-prev"><summary>Preview</summary><pre class="mono">${esc(o.preview)}</pre></details>`
        : "";
      return `<li class="dq-opt${o.destructive ? " destructive" : ""}${picked === i ? " on" : ""}"><label><input type="radio" name="dq-${esc(d.id)}" value="${i}"${picked === i ? " checked" : ""} data-opt="${i}"><span class="dq-k kbd">${i + 1}</span><span class="dq-body"><span class="dq-l">${esc(o.label)}${rec ? '<span class="dq-rec">Recommended</span>' : ""}${o.destructive ? `<span class="dq-destr">${icon("alert", 12, "ic s12")}Destructive</span>` : ""}</span>${o.consequence ? `<span class="dq-c">${esc(o.consequence)}</span>` : ""}${meta ? `<span class="dq-m">${meta}</span>` : ""}${rec && d.rationale ? `<span class="dq-why">${esc(d.rationale)}</span>` : ""}</span></label>${preview}</li>`;
    })
    .join("");
  const chosen = picked !== undefined ? d.options[picked] : undefined;
  const needsConfirm = chosen?.destructive && !confirm;
  return `<article class="dq" data-decision="${esc(d.id)}" aria-labelledby="dq-q-${esc(d.id)}"><header class="dq-h"><h3 id="dq-q-${esc(d.id)}">${esc(d.question)}</h3>${d.category ? `<span class="dq-cat">${esc(String(d.category).replace(/_/g, " "))}</span>` : ""}</header>${title ? `<p class="dq-card sec">${title}</p>` : ""}${d.context ? `<p class="dq-ctx sec">${esc(d.context)}</p>` : ""}<ol class="dq-opts" role="radiogroup" aria-label="Options">${opts}</ol><footer class="dq-f"><span class="dq-pol${pol.urgent ? " urgent" : ""}">${pol.lock ? icon("lock", 12, "ic s12") : icon("clock", 12, "ic s12")}${esc(pol.text)}</span><button class="btn${needsConfirm ? "" : " primary"}" type="button" data-answer="${esc(d.id)}"${picked === undefined ? ' aria-disabled="true"' : ""}>${needsConfirm ? "Confirm destructive choice" : "Answer"}<kbd>↩</kbd></button></footer></article>`;
}
