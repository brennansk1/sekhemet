// Inbox (dashboard §2.17.2, DB-N9-14; teams items 22–24): what reached you,
// across projects, grouped by reason — Needs you, Mentioned, Review
// requested, Watching, Agent finished — the way Linear's Inbox reads, with
// Done, Snooze and Save on each row and the Inbox · Saved · Done tabs.
// Opening a row marks it read. *Needs you* carries the questions waiting on
// you: a request to start the Agent (Start, Decline), a plan sent for your
// approval, a mention of someone who cannot see the project (Invite, Don't
// invite), and decision requests, answered here with their options (the
// planner's and the kernel's, §2.5.7). Every word is `/app/lib/inbox.js`'s.
import { byWait, duration, mergeDecisions, policyLine, waited } from "./decision.js";
import { $, $$, aiBadge, esc, getJSON, icon, postJSON } from "./dom.js";
import {
  INBOX_COPY as C,
  INBOX_FILTERS,
  SNOOZE_CHOICES,
  inboxGroups,
  itemLine,
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
  timer: 0,
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

function actionsHtml(item) {
  const id = esc(item.id);
  const done =
    ui.filter === "done"
      ? `<button class="btn sm" type="button" data-act="undone" data-id="${id}">${esc(C.undone)}</button>`
      : `<button class="btn sm" type="button" data-act="done" data-id="${id}">${icon("check", 14, "ic s14")}${esc(C.done)}</button>`;
  const snooze = `<details class="ib-snooze"><summary class="btn sm">${icon("clock", 14, "ic s14")}${esc(C.snooze)}</summary><div class="ib-menu" role="menu">${SNOOZE_CHOICES.map(
    (c) =>
      `<button type="button" role="menuitem" data-snooze="${esc(c.value)}" data-id="${id}">${esc(c.label)}</button>`,
  ).join("")}</div></details>`;
  const save = `<button class="btn sm" type="button" data-act="${item.saved ? "unsave" : "save"}" data-id="${id}" aria-pressed="${item.saved}">${esc(item.saved ? C.saved : C.save)}</button>`;
  return `${done}${snooze}${save}`;
}

/** The row's own answers: Start/Decline, Invite/Don't invite, the plan's Open. */
function answersHtml(item) {
  if (item.kind === "start_request" && item.request)
    return `<span class="ib-answers"><button class="btn sm primary" type="button" data-start="${esc(item.request.id)}" data-card="${esc(item.cardId)}" data-needs="agent.start"${item.project ? ` data-needs-project="${esc(item.project.id)}" data-needs-project-name="${esc(item.project.name)}"` : ""}>${esc(C.start)}</button><button class="btn sm" type="button" data-decline="${esc(item.request.id)}" data-card="${esc(item.cardId)}" data-needs="agent.start" data-needs-quiet${item.project ? ` data-needs-project="${esc(item.project.id)}" data-needs-project-name="${esc(item.project.name)}"` : ""}>${esc(C.decline)}</button></span>`;
  if (item.kind === "mention_invite" && item.mention)
    return `<span class="ib-answers"><button class="btn sm primary" type="button" data-mention="invite" data-comment="${esc(item.mention.commentId)}" data-card="${esc(item.cardId)}">${esc(C.invite)}</button><button class="btn sm" type="button" data-mention="skip" data-comment="${esc(item.mention.commentId)}" data-card="${esc(item.cardId)}">${esc(C.dontInvite)}</button></span>`;
  return "";
}

function rowHtml(item, i) {
  const words = itemLine(item);
  const key = item.cardId ? `<span class="ib-key mono">${esc(shortId(item.cardId))}</span>` : "";
  const project = item.project ? `<span class="ib-proj sec">${esc(item.project.name)}</span>` : "";
  const decision =
    item.kind === "decision"
      ? (store.state.decisions.items ?? []).find((d) => d.id === item.id)
      : undefined;
  const panel = decision
    ? decisionHtml(decision, {
        picked: ui.picked.get(decision.id),
        confirm: ui.confirm.has(decision.id),
        now: store.state.now ?? Date.now(),
      })
    : "";
  const snoozed = item.snoozedUntil
    ? `<span class="sec">${esc(C.snoozedUntil(new Date(item.snoozedUntil).toLocaleString()))}</span>`
    : "";
  return `<li class="ib-row${item.unread ? " unread" : ""}${i === ui.focus ? " focus" : ""}" data-i="${i}" data-item="${esc(item.id)}"><div class="ib-line"><span class="ib-dot" aria-hidden="true"></span><a class="ib-main" href="${esc(item.link)}" data-open="${esc(item.id)}">${item.unread ? '<span class="sr-only">Unread: </span>' : ""}${key}<span class="ib-title">${esc(words.title)}</span>${project}<span class="ib-what">${esc(words.line)}</span></a><time class="ib-time sec tnum" datetime="${esc(item.at)}">${esc(ago(item.at))}</time></div>${aiHtml(words.ai)}${snoozed}<div class="ib-acts">${answersHtml(item)}${actionsHtml(item)}</div>${panel}</li>`;
}

function plannerRowHtml(d, i) {
  const c = d.cardId ? store.card(d.cardId) : null;
  const title = c ? (c.display?.title ?? parseTitle(c.title).title) : "";
  return `<li class="ib-row unread${i === ui.focus ? " focus" : ""}" data-i="${i}"><div class="ib-wait tnum${waited(d, store.state.now) > 2 * 3600_000 ? " long" : ""}">${icon("clock", 12, "ic s12")}waiting ${esc(duration(waited(d, store.state.now)))}</div>${decisionHtml(
    d,
    {
      picked: ui.picked.get(d.id),
      confirm: ui.confirm.has(d.id),
      now: store.state.now ?? Date.now(),
      title: title
        ? `For <a href="#/card/${encodeURIComponent(d.cardId)}/activity">${esc(title)}</a>`
        : "",
    },
  )}</li>`;
}

function render() {
  if (!ui.root) return;
  const data = ui.data;
  const unread = store.state.inbox?.unread ?? 0;
  setTopbar({ title: C.title, crumb: unread ? C.unread(unread) : "" });
  const tabs = `<div class="ib-tabs" role="tablist" aria-label="${esc(C.title)}">${INBOX_FILTERS.map(
    (f) =>
      `<button type="button" role="tab" data-filter="${esc(f.value)}" aria-selected="${ui.filter === f.value}">${esc(f.label)}</button>`,
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
    const sections = groups.map((g) => {
      const rows = g.items.map((it) => rowHtml(it, i++)).join("");
      const more =
        g.reason === "needs_you" ? extra.map((d) => plannerRowHtml(d, i++)).join("") : "";
      return `<section class="ib-group" aria-labelledby="ib-h-${esc(g.reason)}"><h2 id="ib-h-${esc(g.reason)}">${esc(g.label)} <span class="sec tnum">${g.items.length + (g.reason === "needs_you" ? extra.length : 0)}</span></h2><ol class="ib-rows">${rows}${more}</ol></section>`;
    });
    if (extra.length && !groups.some((g) => g.reason === "needs_you")) {
      sections.unshift(
        `<section class="ib-group" aria-labelledby="ib-h-needs_you"><h2 id="ib-h-needs_you">Needs you <span class="sec tnum">${extra.length}</span></h2><ol class="ib-rows">${extra.map((d) => plannerRowHtml(d, i++)).join("")}</ol></section>`,
      );
    }
    ui.count = i;
    ui.focus = Math.min(ui.focus, Math.max(0, i - 1));
    const empty =
      ui.filter === "saved" ? C.emptySaved : ui.filter === "done" ? C.emptyDone : C.empty;
    body = sections.length
      ? sections.join("")
      : `<div class="ib-empty">${icon("inbox", 24, "ic s24")}<b>${esc(empty)}</b>${ui.filter === "inbox" ? `<span>${esc(C.emptyHint)}</span>` : ""}</div>`;
  }
  const html = `${tabs}${body}`;
  if (html === ui.last) return;
  ui.last = html;
  const host = $(".sc", ui.root);
  const top = host.scrollTop;
  host.innerHTML = html;
  host.scrollTop = top;
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
    ui.last = "";
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

function pick(id, i) {
  ui.picked.set(id, i);
  ui.confirm.delete(id);
  ui.last = "";
  render();
}

/** Opening an item marks it read (teams item 24), then goes where it points. */
function open(id, href) {
  const item = (ui.data?.items ?? []).find((x) => x.id === id);
  if (item?.unread) void act(id, "read");
  if (href) location.hash = href.replace(/^#/, "");
}

const rows = () => $$(".ib-row", ui.root);

export function onKey(e) {
  const list = rows();
  const cur = list[ui.focus];
  const id = cur?.dataset.item;
  const decision = cur?.querySelector("[data-decision]")?.dataset.decision;
  if (/^[1-9]$/.test(e.key) && decision) {
    const d = (store.state.decisions.items ?? []).find((x) => x.id === decision);
    if (d && Number(e.key) <= d.options.length) {
      pick(decision, Number(e.key) - 1);
      return true;
    }
  }
  if (e.key === "Enter" && cur) {
    if (decision && ui.picked.has(decision)) answerDecision(decision);
    else if (id) open(id, cur.querySelector("[data-open]")?.getAttribute("href"));
    return true;
  }
  if (e.key === "e" && id) {
    void act(id, ui.filter === "done" ? "undone" : "done");
    return true;
  }
  const step =
    e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
  if (step && list.length) {
    ui.focus = Math.max(0, Math.min(list.length - 1, ui.focus + step));
    for (const [i, n] of list.entries()) n.classList.toggle("focus", i === ui.focus);
    list[ui.focus]?.scrollIntoView({ block: "nearest" });
    return true;
  }
  return false;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc ib-view" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.data = null;
  ui.filter = "inbox";
  root.addEventListener("change", (e) => {
    const input = e.target instanceof HTMLInputElement ? e.target : null;
    const art = input?.closest("[data-decision]");
    if (input?.dataset.opt !== undefined && art)
      pick(art.dataset.decision, Number(input.dataset.opt));
  });
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const tab = t.closest("[data-filter]");
    if (tab) {
      ui.filter = tab.dataset.filter;
      ui.data = null;
      ui.focus = 0;
      render();
      void refreshInbox();
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
      e.preventDefault();
      open(o.dataset.open, o.getAttribute("href"));
      return;
    }
    const row = t.closest(".ib-row");
    if (row && Number(row.dataset.i) !== ui.focus) {
      ui.focus = Number(row.dataset.i);
      for (const n of rows()) n.classList.toggle("focus", n === row);
    }
  });
  const unsub = store.on((_s, patch) => {
    if ("inbox" in patch || "decisions" in patch || "now" in patch) render();
  });
  render();
  void refreshInbox();
  refreshDecisions().catch(() => {});
  // Relative times move to the minute, never every second (§2.5.7).
  ui.timer = setInterval(() => store.set({ now: Date.now() }), 60_000);
  return {
    onKey,
    unmount() {
      clearInterval(ui.timer);
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
