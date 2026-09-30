// The conversation with Seshat (PM_DESIGN §2.4–2.6): messages, proposals, the
// waiting procedure, the context chip and the composer. Mounted twice: in the
// right-side panel and in the full #/pm view. Both render the one thread.
import { $, announce, esc, icon, isTyping, kbd, teammateName } from "./dom.js";
import {
  formatClock,
  pendingView,
  renderPmMarkdown,
  sourceCites,
  statusEtaSeconds,
  threadNotice,
} from "./lib/pm.js";
import {
  composerCostLine,
  composerHint,
  composerStarters,
  documentChip,
  pastedDocument,
  userMessageView,
} from "./lib/seshat.js";
import { columnLabel } from "./lib/vocabulary.js";
import { cardChip } from "./marks.js";
import { openPeek } from "./peek.js";
import { PM_NAME, loadThread, pendingMessage, sendMessage } from "./pm_client.js";
import { bindProposals, proposalGroupHtml } from "./proposals.js";
import { store } from "./store.js";

const IDLE_STARTERS_MS = 12 * 3600_000;

function time(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function avatar(who = "S") {
  return `<span class="av" aria-hidden="true">${esc(who)}</span>`;
}

function md(text) {
  return renderPmMarkdown(text, { chip: (id) => cardChip(id) });
}

/** Research sources (cites with a url or label): a compact numbered list. */
function sourcesHtml(cites) {
  const list = sourceCites(cites);
  if (!list.length) return "";
  const items = list
    .map(
      (s) =>
        `<li>${s.href ? `<a href="${esc(s.href)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>${s.host ? `<span class="host mono">${esc(s.host)}</span>` : ""}` : `<span>${esc(s.label)}</span>`}</li>`,
    )
    .join("");
  return `<div class="sources"><span class="sh-s">Sources</span><ol>${items}</ol></div>`;
}

/** An attached document's chip (PM-N10-2): its name and size; where it is kept on hover. */
function docChipHtml(d, removable) {
  const chip = documentChip(d);
  const remove =
    removable === undefined
      ? ""
      : `<button class="icon-btn" type="button" data-doc-remove="${removable}" aria-label="Remove ${esc(d.name)}">${icon("x", 12, "ic s12")}</button>`;
  return `<span class="dchip" title="${esc(chip.title)}">${icon("file", 12, "ic s12")}<span class="t">${esc(chip.label)}</span>${remove}</span>`;
}

function citesHtml(cites) {
  if (!cites?.length) return "";
  const parts = [];
  for (const c of cites) {
    if (c.documentId) {
      // PM-N10-3: the reply read this attached document.
      parts.push(
        `<span class="cchip" title="${esc(c.path ? `In the repository at ${c.path}` : "Kept with the conversation")}">${icon("file", 12, "ic s12")}<span class="t">${esc(c.label ?? c.documentId)}</span></span>`,
      );
    } else if (c.evidenceId) {
      const href = c.cardId ? `#/card/${encodeURIComponent(c.cardId)}/evidence` : "#/ledger";
      parts.push(
        `<a class="cchip" href="${esc(href)}" title="Evidence ${esc(c.evidenceId)}">${icon("file-diff", 12, "ic s12")}<span class="mono">${esc(c.evidenceId)}</span></a>`,
      );
    } else if (c.runId) {
      parts.push(
        `<a class="cchip" href="#/runs/${esc(encodeURIComponent(c.runId))}">${icon("runs", 12, "ic s12")}<span class="t">${esc(runLabel(c.runId))}</span></a>`,
      );
    } else if (c.cardId) {
      parts.push(cardChip(c.cardId) ?? `<span class="mono">${esc(c.cardId)}</span>`);
    }
  }
  return parts.length ? `<p class="cites"><span>Based on:</span>${parts.join("")}</p>` : "";
}

/** `run_2026-09-18T02-14` -> `run 18 Sep 02:14`; anything else as given. */
function runLabel(id) {
  const m = /(\d{4})-(\d{2})-(\d{2})T(\d{2})[-:](\d{2})/.exec(id);
  if (!m) return id;
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][Number(m[2]) - 1];
  return `run ${Number(m[3])} ${month} ${m[4]}:${m[5]}`;
}

function messageHtml(m) {
  if (m.role === "system") return `<p class="msg sys">${esc(m.text)}</p>`;
  // PM-N9-6, PM-P6-10: the product's notice, kept apart from Seshat's voice.
  const notice = threadNotice(m);
  if (notice !== undefined) return `<p class="msg sys notice">${esc(notice)}</p>`;
  if (m.role === "user") {
    const note =
      m.state === "queued" && pendingMessage() !== m
        ? " · Queued · Seshat answers in order"
        : m.state === "queued"
          ? " · Queued"
          : "";
    const err =
      m.state === "error"
        ? `<div class="msg pm error">${avatar()}<div><p><b>${PM_NAME} couldn't reply.</b> <span class="sec">The Planning model did not answer this message.</span></p><button class="btn sm" type="button" data-retry="${esc(m.id)}">${icon("refresh", 12, "ic s12")}Retry</button></div></div>`
        : "";
    // PM-N10-2: a long message shows its opening; its documents show as chips.
    const view = userMessageView(m);
    const body = view.preview ? `<div class="bubble md">${md(view.preview)}</div>` : "";
    const whole = view.note ? `<p class="sec doc-note">${esc(view.note)}</p>` : "";
    const docs = m.documents?.length
      ? `<div class="docs">${m.documents.map((d) => docChipHtml(d)).join("")}</div>`
      : "";
    return `<article class="msg user" data-msg="${esc(m.id)}">${body}${whole}${docs}<div class="meta tnum">${esc(time(m.createdAt))}${note}</div></article>${err}`;
  }
  const proposals = proposalGroupHtml(m.proposals ?? [], { groupId: m.id });
  return `<article class="msg pm" data-msg="${esc(m.id)}"><header>${avatar()}${teammateName(PM_NAME, "seshat")}<time class="tnum">${esc(time(m.createdAt))}</time></header><div class="md">${md(m.text)}</div>${proposals}${sourcesHtml(m.cites)}${citesHtml(m.cites)}</article>`;
}

/* ---------- Waiting (PM_DESIGN §2.5) ---------- */

const STATE_ICON = {
  done: () => icon("check", 12, "ic s12 i-pass"),
  current: () => icon("ring", 12, "ic s12 i-run"),
  todo: () => '<span class="todo" aria-hidden="true"></span>',
};

function pendingHtml(user) {
  const pm = store.state.pm;
  const status = pm.status ?? { phase: "idle" };
  const started = Date.parse(user.createdAt) || pm.phaseSeenAt.queued || Date.now();
  const seen = pm.phaseSeenAt;
  // DB-N2-8: the rows and the note are the model's (`pendingView`, lib/pm.js).
  const view = pendingView(status, {
    name: PM_NAME,
    workerInvolved: pm.workerInvolved,
    step: pm.step,
    elapsedMs: Date.now() - (seen[status.phase] ?? Date.now()),
  });
  if (status.phase === "idle") {
    return `<div class="msg pm pending" aria-busy="true">${avatar()}<div class="pend"><header>${teammateName(PM_NAME, "seshat")}<span class="clock tnum" data-since="${started}"></span></header><p class="note">${esc(view.note)}</p></div></div>`;
  }
  const rows = view.rows;
  const eta = statusEtaSeconds(status);
  const items = rows
    .map((r, i) => {
      let right = "";
      if (r.state === "current") {
        right = `<span class="t tnum" data-since="${seen[r.phase] ?? Date.now()}"></span>`;
      } else if (r.state === "done" && seen[r.phase]) {
        const next = rows[i + 1];
        const end = next ? seen[next.phase] : undefined;
        if (end) right = `<span class="t tnum">${formatClock(end - seen[r.phase])}</span>`;
      }
      const bar =
        r.state === "current" && r.phase === "loading_pm" && eta
          ? `<span class="eta" data-eta="${eta * 1000}" data-from="${seen[r.phase] ?? Date.now()}"><i></i></span>`
          : "";
      return `<li class="is-${r.state}"${r.state === "current" ? ' aria-current="step"' : ""}>${STATE_ICON[r.state]()}<span class="l">${esc(r.label)}</span>${bar}${right}</li>`;
    })
    .join("");
  return `<div class="msg pm pending" aria-busy="true" data-phase="${esc(status.phase)}" data-phase-since="${seen[status.phase] ?? Date.now()}">${avatar()}<div class="pend"><header>${teammateName(PM_NAME, "seshat")}<span class="clock tnum" data-since="${started}"></span></header><ol class="steps-pm">${items}</ol><p class="note" data-note>${esc(view.note)}</p></div></div>`;
}

/** Once a second: clocks, the ETA bar and the over-time notes. Text changes; nothing moves. */
function tick(root) {
  if (store.state.connection === "offline") return;
  const now = Date.now();
  for (const n of root.querySelectorAll("[data-since]")) {
    const t = formatClock(now - Number(n.dataset.since));
    if (n.textContent !== t) n.textContent = t;
  }
  for (const n of root.querySelectorAll("[data-eta]")) {
    const ratio = (now - Number(n.dataset.from)) / Number(n.dataset.eta);
    n.firstElementChild.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
    n.classList.toggle("over", ratio > 1);
  }
  const pend = root.querySelector(".pending[data-phase]");
  if (pend) {
    const pm = store.state.pm;
    const note = pend.querySelector("[data-note]");
    // The over-time notes come from the same model as the block (DB-N2-8).
    const text = pendingView(pm.status ?? { phase: "idle" }, {
      name: PM_NAME,
      workerInvolved: pm.workerInvolved,
      step: pm.step,
      elapsedMs: now - Number(pend.dataset.phaseSince),
    }).note;
    if (note && note.textContent !== text) note.textContent = text;
  }
}

/* ---------- Context and composer ---------- */

/** What Seshat will be told you're looking at (PM_DESIGN §2.4). */
export function currentContext() {
  const s = store.state;
  const r = s.route ?? { name: "", params: [] };
  let cardId;
  if ((r.name === "card" || r.name === "review") && r.params[0]) cardId = r.params[0];
  else if (r.name === "board" && s.focusedId && document.getElementById(`tile-${s.focusedId}`))
    cardId = s.focusedId;
  else if (r.name === "board" && s.focusedId && r.params[0] === "list") cardId = s.focusedId;
  const viewName = r.name === "board" && r.params[0] === "list" ? "list" : r.name || "board";
  const ctx = { view: viewName };
  if (cardId && store.card(cardId)) ctx.cardId = cardId;
  return ctx;
}

const VIEW_LABEL = {
  board: "Board",
  list: "List",
  review: "Review",
  card: "Issue",
  runs: "Runs",
  ledger: "Ledger",
  playbook: "Playbook",
  machine: "Machine",
  insights: "Insights",
  integrations: "Integrations",
  pm: "Conversation",
};

function contextHtml(ctx, dismissed) {
  if (dismissed) {
    return `<button class="ctx off" type="button" data-ctx-restore title="Send context again">${icon("plus", 12, "ic s12")}<span>Add what you're looking at</span></button>`;
  }
  const extra = window.sekhemetViewContext?.() ?? "";
  const what = ctx.cardId
    ? (cardChip(ctx.cardId) ?? esc(ctx.cardId))
    : `<span>${esc(VIEW_LABEL[ctx.view] ?? ctx.view)}${extra ? ` · ${esc(extra)}` : ""}</span>`;
  return `<div class="ctx"><span class="sec">Looking at:</span>${what}<button class="icon-btn" type="button" data-ctx-dismiss aria-label="Don't send this context">${icon("x", 12, "ic s12")}</button></div>`;
}

/** DB-P5-5: what sending does, in plain words; no API path, no model name or id. */
function costLine() {
  const s = store.state;
  const running = s.cards.find((c) => c.status === "in_progress");
  return composerCostLine({
    unavailable: s.pm.available === false,
    readOnly: Boolean(s.meta && s.meta.triage === false),
    offline: s.connection === "offline",
    ...(running
      ? {
          agent: running.stepsUsed ? { step: running.stepsUsed, budget: running.stepBudget } : {},
        }
      : {}),
  });
}

/** The starters (§2.7 item 6): Start a new project among them, and one for the issue in focus. */
function starters() {
  const focused = store.card(currentContext().cardId ?? store.state.focusedId);
  if (!focused) return composerStarters();
  return composerStarters({
    focused: {
      key: focused.display?.shortId ?? focused.id,
      failed: focused.display?.tone === "fail" || focused.display?.evidence?.passed === false,
      estimate: focused.estimate ?? 0,
    },
  });
}

function disabledReason() {
  const s = store.state;
  if (s.pm.available === false) return "unavailable";
  if (s.meta && s.meta.triage === false) return "readonly";
  if (s.connection === "offline") return "offline";
  return "";
}

/* ---------- @ picker ---------- */

function mentionQuery(ta) {
  const upto = ta.value.slice(0, ta.selectionStart);
  const m = /(^|\s)@([\w.-]*)$/.exec(upto);
  return m ? { q: m[2].toLowerCase(), start: upto.length - m[2].length - 1 } : null;
}

function matchCards(q) {
  const scored = [];
  for (const c of store.state.cards) {
    const title = (c.display?.title ?? c.title ?? "").toLowerCase();
    const short = (c.display?.shortId ?? c.id).toLowerCase();
    const hit = !q
      ? 1
      : short.startsWith(q)
        ? 3
        : c.id.toLowerCase().includes(q)
          ? 2
          : title.includes(q)
            ? 1
            : 0;
    if (hit) scored.push([hit, c]);
  }
  return scored
    .sort((a, b) => b[0] - a[0])
    .slice(0, 6)
    .map(([, c]) => c);
}

/* ---------- Mount ---------- */

/**
 * Mount the thread into `host`. `variant` is "panel" or "full".
 * Returns { focus(), prefill(text), destroy() }.
 */
export function mountThread(host, { variant = "panel" } = {}) {
  host.innerHTML = `<div class="pm-thread ${variant}"><div class="pm-log" role="log" aria-live="off" aria-label="Conversation with ${PM_NAME}" tabindex="0"></div><div class="pm-compose"><div class="starters" data-starters></div><div data-ctx></div><div class="docs" data-docs hidden></div><div class="box"><textarea rows="1" aria-label="Message ${PM_NAME}" placeholder="Ask ${PM_NAME} about the board, an issue or a run… (/ for commands)"></textarea><button class="send" type="button" data-send aria-label="Send (Enter)">${icon("send", 14, "ic s14")}</button><div class="picker" role="listbox" hidden></div></div><p class="hint" data-hint hidden></p><p class="cost" data-cost></p></div></div>`;
  const log = $(".pm-log", host);
  const ta = $("textarea", host);
  const picker = $(".picker", host);
  const ctxSlot = $("[data-ctx]", host);
  let lastLog = "";
  let lastCtxKey = "";
  let dismissed = false;
  let pick = { items: [], i: 0, start: 0 };
  /** Documents attached in the composer, not yet sent (PM-N10-5). */
  let attached = [];
  const docsSlot = $("[data-docs]", host);

  function renderDocs() {
    docsSlot.innerHTML = attached
      .map((d, i) => docChipHtml({ ...d, chars: d.text.length, pending: true }, i))
      .join("");
    docsSlot.hidden = attached.length === 0;
  }

  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;

  function renderLog() {
    const pm = store.state.pm;
    let html = "";
    if (pm.available === false) {
      html = `<div class="pm-empty">${avatar()}<b>${PM_NAME} isn't on this server yet.</b><span>This Sekhemet server has no project-manager endpoints (<code>GET /api/pm/thread</code> returned 404). Update Sekhemet and restart <code>sekhemet serve</code>.</span></div>`;
    } else if (pm.error && !pm.messages.length) {
      html = `<div class="pm-empty">${icon("alert", 24, "ic s24")}<b>Couldn't load the conversation.</b><span>${esc(pm.error.status ? `The server returned ${pm.error.status}.` : pm.error.message || "Sekhemet is not reachable.")}</span><button class="btn sm" type="button" data-reload>Retry</button></div>`;
    } else if (pm.available === null) {
      html =
        '<div class="pm-skel"><div class="sk sk-line"></div><div class="sk sk-line"></div><div class="sk sk-line" style="width:60%"></div></div>';
    } else {
      const project = store.state.meta?.project ?? "this project";
      const intro = `<article class="msg pm intro">${avatar()}<div><header>${teammateName(PM_NAME, "seshat")}<span class="sec">Project manager</span></header><div class="md"><p>I'm ${PM_NAME}, the project manager for ${esc(project)}. I read the board, the runs and the ledger, and I propose changes you approve. I never change the board myself.</p></div></div></article>`;
      const pending = pendingMessage(pm.messages);
      const parts = pm.messages.map((m) => messageHtml(m) + (m === pending ? pendingHtml(m) : ""));
      html = (pm.messages.length ? "" : intro) + parts.join("");
    }
    if (html === lastLog) return;
    const stick = atBottom() || !lastLog;
    const focusId = document.activeElement?.closest?.("[data-prop]")?.dataset.prop;
    log.innerHTML = html;
    lastLog = html;
    if (focusId)
      log.querySelector(`[data-prop="${CSS.escape(focusId)}"] button:not([disabled])`)?.focus();
    if (stick) log.scrollTop = log.scrollHeight;
    tick(log);
  }

  function renderCompose() {
    const ctx = currentContext();
    const key = JSON.stringify(ctx) + (window.sekhemetViewContext?.() ?? "");
    if (key !== lastCtxKey) {
      dismissed = false;
      lastCtxKey = key;
    }
    const ctxHtml = ctx.view === "pm" && !ctx.cardId ? "" : contextHtml(ctx, dismissed);
    if (ctxSlot.dataset.html !== ctxHtml) {
      ctxSlot.innerHTML = ctxHtml;
      ctxSlot.dataset.html = ctxHtml;
    }
    const pm = store.state.pm;
    const last = pm.messages.at(-1);
    const idle = !last || Date.now() - Date.parse(last.createdAt) > IDLE_STARTERS_MS;
    const st = $("[data-starters]", host);
    const sHtml =
      idle && pm.available === true
        ? starters()
            .map(
              (t) =>
                `<button class="starter" type="button" data-starter="${esc(t.text)}">${esc(t.label)}</button>`,
            )
            .join("")
        : "";
    if (st.dataset.html !== sHtml) {
      st.innerHTML = sHtml;
      st.dataset.html = sHtml;
    }
    const why = disabledReason();
    ta.disabled = Boolean(why);
    $("[data-send]", host).disabled = Boolean(why);
    const cost = costLine();
    const costEl = $("[data-cost]", host);
    if (costEl.textContent !== cost) costEl.textContent = cost;
    renderHint();
  }

  /** While a person starts a project, what to write and that nothing is created yet (DB-P5-3). */
  function renderHint() {
    const hint = composerHint(ta.value);
    const el = $("[data-hint]", host);
    if (el.textContent !== hint) el.textContent = hint;
    el.hidden = !hint;
  }

  function render() {
    renderLog();
    renderCompose();
  }

  async function send() {
    const text = ta.value.trim();
    if ((!text && !attached.length) || disabledReason()) return;
    const here = currentContext();
    const ctx = dismissed || (here.view === "pm" && !here.cardId) ? undefined : here;
    const docs = attached;
    ta.value = "";
    attached = [];
    renderDocs();
    autosize();
    renderHint();
    closePicker();
    const ok = await sendMessage(text, ctx, docs);
    if (!ok) {
      // Nothing was sent: the words and the documents wait in the composer.
      ta.value = text;
      attached = docs;
      renderDocs();
      autosize();
    }
    log.scrollTop = log.scrollHeight;
  }

  function autosize() {
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 8 * 19 + 16)}px`;
  }

  function closePicker() {
    picker.hidden = true;
    pick = { items: [], i: 0, start: 0 };
  }

  function renderPicker() {
    const mq = mentionQuery(ta);
    if (!mq) return closePicker();
    const items = matchCards(mq.q);
    if (!items.length) return closePicker();
    pick = { items, i: Math.min(pick.i, items.length - 1), start: mq.start };
    picker.innerHTML = items
      .map(
        (c, i) =>
          `<div class="pk-o" role="option" aria-selected="${i === pick.i}" data-pick="${esc(c.id)}"><span class="mono">${esc(c.display?.shortId ?? c.id)}</span><span class="t">${esc(c.display?.title ?? c.title)}</span><span class="sec">${esc(columnLabel(c.status))}</span></div>`,
      )
      .join("");
    picker.hidden = false;
  }

  function insertMention(id) {
    const card = store.card(id);
    const token = `@${card?.id ?? id} `;
    const before = ta.value.slice(0, pick.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = before + token + after;
    const at = (before + token).length;
    ta.setSelectionRange(at, at);
    closePicker();
    autosize();
    ta.focus();
  }

  ta.addEventListener("input", () => {
    autosize();
    renderPicker();
    renderHint();
  });
  ta.addEventListener("keydown", (e) => {
    if (!picker.hidden) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        pick.i =
          (pick.i + (e.key === "ArrowDown" ? 1 : -1) + pick.items.length) % pick.items.length;
        renderPicker();
        e.preventDefault();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        insertMention(pick.items[pick.i].id);
        e.preventDefault();
        return;
      }
      if (e.key === "Escape") {
        closePicker();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener("blur", () => setTimeout(closePicker, 150));
  // PM-N10-5: a paste longer than a comfortable message is attached whole as a document.
  ta.addEventListener("paste", (e) => {
    const doc = pastedDocument(e.clipboardData?.getData("text/plain") ?? "", attached.length);
    if (!doc) return;
    e.preventDefault();
    attached = [...attached, doc];
    renderDocs();
    announce(`Attached ${documentChip({ ...doc, chars: doc.text.length }).label}.`);
  });

  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const pk = t.closest("[data-pick]");
    if (pk) {
      insertMention(pk.dataset.pick);
      return;
    }
    const chip = t.closest("[data-chip]");
    if (chip && !(e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openPeek(chip.dataset.chip, { returnFocus: chip });
      return;
    }
    const remove = t.closest("[data-doc-remove]");
    if (remove) {
      attached = attached.filter((_, i) => i !== Number(remove.dataset.docRemove));
      renderDocs();
      ta.focus();
      return;
    }
    if (t.closest("[data-send]")) send();
    else if (t.closest("[data-starter]")) {
      ta.value = t.closest("[data-starter]").dataset.starter;
      autosize();
      renderHint();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    } else if (t.closest("[data-ctx-dismiss]")) {
      dismissed = true;
      ctxSlot.dataset.html = "";
      renderCompose();
    } else if (t.closest("[data-ctx-restore]")) {
      dismissed = false;
      ctxSlot.dataset.html = "";
      renderCompose();
    } else if (t.closest("[data-reload]")) loadThread();
    else if (t.closest("[data-retry]")) {
      const m = store.state.pm.messages.find(
        (x) => x.id === t.closest("[data-retry]").dataset.retry,
      );
      if (m) sendMessage(m.text, m.context);
    }
  });
  bindProposals(log);

  const unsub = store.on((_s, patch) => {
    if ("focusedId" in patch && Object.keys(patch).length === 1) {
      renderCompose();
      return;
    }
    render();
  });
  const onHash = () => renderCompose();
  window.addEventListener("hashchange", onHash);
  const timer = setInterval(() => {
    tick(log);
    renderCompose();
  }, 1000);
  render();

  return {
    focus() {
      if (!ta.disabled) ta.focus();
      else log.focus();
    },
    prefill(text) {
      ta.value = text;
      autosize();
      renderHint();
      if (!ta.disabled) {
        ta.focus();
        ta.setSelectionRange(text.length, text.length);
      }
    },
    isTypingHere(e) {
      return isTyping(e) && host.contains(e.target);
    },
    destroy() {
      unsub();
      clearInterval(timer);
      window.removeEventListener("hashchange", onHash);
      host.innerHTML = "";
    },
    kbdHint: kbd("↵"),
  };
}
