// Activity tab (dashboard §2.6, DB-N8-1, DB-N8-3): the agent's plan, its
// progress and its questions and the people's messages, in time order — the
// issue's conversation. A question's options are buttons; while the agent
// runs, a message box reaches it at its next step (DB-N8-2). The timeline's
// rules and words are `/app/lib/issue.js`; every ledger entry is one toggle away.
import { esc, getJSON, icon, postJSON } from "./dom.js";
import { refreshDecisions } from "./inbox.js";
import { aiBadge } from "./issue_view.js";
import { ISSUE_COPY, activityItems, agentPanel } from "./lib/issue.js";
import { store } from "./store.js";
import { toast } from "./toast.js";
import { blockedToast } from "./triage.js";

const TONE_ICON = {
  pass: () => icon("check", 14, "ic s14 i-pass"),
  fail: () => icon("x", 14, "ic s14 i-fail"),
  parked: () => icon("pause", 14, "ic s14 i-park"),
};

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
}

function questionHtml(q, confirm) {
  const buttons = q.options
    .map((o) => {
      const armed = confirm === `${q.id}:${o.index}`;
      return `<button class="btn" type="button" data-answer="${esc(q.id)}" data-option="${o.index}" data-source="${esc(q.source)}">${esc(armed ? `Confirm: ${o.label}` : o.label)}${o.isDefault ? ' <span class="sec">(default)</span>' : ""}</button>`;
    })
    .join("");
  return `<div class="act-q"><div class="acts" role="group" aria-label="${esc(ISSUE_COPY.answer)}">${buttons}</div><div class="sec">${esc(q.line)}</div></div>`;
}

function rowHtml(item, confirm) {
  const mark = TONE_ICON[item.tone]?.() ?? '<span class="tl-dot" aria-hidden="true"></span>';
  const steps = item.steps
    ? ` <a href="#" data-go-steps>${esc(item.steps[0] === item.steps[1] ? `Step ${item.steps[0]}` : "Steps")}</a>`
    : "";
  return `<li class="th-row act-${esc(item.kind)}"><span class="th-mark">${mark}</span><div class="th-body"><div><b class="who">${esc(item.who)}</b>${item.ai ? aiBadge() : ""} ${esc(item.text)}${steps}</div>${item.quote ? `<blockquote>${esc(item.quote)}</blockquote>` : ""}${item.question ? questionHtml(item.question, confirm) : ""}${item.meta ? `<div class="sec act-meta">${esc(item.meta)}</div>` : ""}</div><span class="th-meta"><span class="tnum">${esc(when(item.at))}</span></span></li>`;
}

/** Mount the Activity tab into `host`. */
export function renderActivity(host, ctx) {
  const state = { messages: null, all: false, confirm: "", last: "", first: true, seq: 0 };

  const loadMessages = async () => {
    const seq = ++state.seq;
    const res = await getJSON(`/api/cards/${encodeURIComponent(ctx.id)}/messages`);
    if (seq !== state.seq || !host.isConnected) return;
    state.messages = res.ok ? (res.data?.messages ?? []) : [];
    draw();
  };

  const draw = () => {
    const card = ctx.card();
    const events = ctx.events();
    if (!card || !events || !state.messages) {
      if (!state.last) host.innerHTML = '<div class="sk sk-line" style="width:40%"></div>';
      return;
    }
    const items = activityItems({
      cardId: ctx.id,
      events,
      messages: state.messages,
      decisions: store.state.decisions?.items ?? [],
      all: state.all,
    });
    const panel = agentPanel(card, events);
    const composer = panel.messageBox
      ? `<form class="act-msg" data-agent-msg><label for="agent-msg">${esc(ISSUE_COPY.messageLabel)}</label><textarea id="agent-msg" name="text" rows="2" aria-describedby="agent-msg-err"></textarea><div class="err" id="agent-msg-err" role="alert" hidden>${esc(ISSUE_COPY.messageEmpty)}</div><div class="acts"><button class="btn" type="submit">${icon("send", 14, "ic s14")}${esc(ISSUE_COPY.send)}</button></div></form>`
      : panel.state === "paused" || panel.state === "taken_over"
        ? `<p class="sec">${esc(ISSUE_COPY.notRunning)}</p>`
        : "";
    const toggle = `<button class="filter" type="button" data-all aria-pressed="${state.all}">${icon(state.all ? "x" : "plus", 12, "ic s12")}${esc(ISSUE_COPY.everyEntry)}</button>`;
    const list = items.length
      ? `<ol class="thread activity">${items.map((i) => rowHtml(i, state.confirm)).join("")}</ol>`
      : `<p class="sec">${esc(ISSUE_COPY.activityEmpty)}</p>`;
    const next = `<h3 class="sh" style="margin:0">Activity ${toggle}</h3>${list}${composer}`;
    if (next === state.last) return;
    // A half-written message survives a redraw, and keeps its focus.
    const draft = host.querySelector("#agent-msg")?.value ?? "";
    const typing = document.activeElement?.id === "agent-msg";
    const top = host.scrollTop;
    host.innerHTML = next;
    state.last = next;
    const area = host.querySelector("#agent-msg");
    if (area) area.value = draft;
    if (typing) area?.focus();
    if (state.first) {
      // The conversation reads down to now, like a thread.
      host.scrollTop = host.scrollHeight;
      state.first = false;
    } else host.scrollTop = top;
  };

  const answer = async (id, option, source) => {
    const d = (store.state.decisions?.items ?? []).find((x) => x.id === id);
    if (!d) return;
    // A destructive choice takes a second press, as in the Inbox.
    if (d.options[option]?.destructive && state.confirm !== `${id}:${option}`) {
      state.confirm = `${id}:${option}`;
      draw();
      return;
    }
    if (blockedToast()) return;
    const path =
      source === "planner"
        ? `/api/planner/decisions/${encodeURIComponent(id)}`
        : `/api/decisions/${encodeURIComponent(id)}`;
    const res = await postJSON(path, { option });
    if (!res.ok) {
      toast({
        text: "Couldn't record the answer.",
        detail: res.data?.error ?? `The server returned ${res.status}.`,
        tone: "fail",
      });
      return;
    }
    state.confirm = "";
    toast({ text: ISSUE_COPY.answered(d.options[option]?.label ?? ""), tone: "info" });
    await refreshDecisions().catch(() => {});
    ctx.refresh();
  };

  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-all]")) {
      state.all = !state.all;
      draw();
      return;
    }
    if (t.closest("[data-go-steps]")) {
      e.preventDefault();
      ctx.goTab("steps");
      return;
    }
    const a = t.closest("[data-answer]");
    if (a) void answer(a.dataset.answer, Number(a.dataset.option), a.dataset.source);
  });

  host.addEventListener("submit", async (e) => {
    const form = e.target instanceof Element ? e.target.closest("[data-agent-msg]") : null;
    if (!form) return;
    e.preventDefault();
    const area = form.querySelector("textarea");
    const err = form.querySelector(".err");
    const text = area.value.trim();
    if (!text) {
      err.hidden = false;
      area.setAttribute("aria-invalid", "true");
      area.focus();
      return;
    }
    if (blockedToast()) return;
    const res = await postJSON(`/api/cards/${encodeURIComponent(ctx.id)}/message`, { text });
    if (!res.ok) {
      toast({
        text: "Couldn't send the message.",
        detail: res.data?.error ?? `The server returned ${res.status}.`,
        tone: "fail",
      });
      return;
    }
    area.value = "";
    toast({ text: ISSUE_COPY.sent, iconName: "send", tone: "info" });
    await loadMessages();
  });

  host.addEventListener("keydown", (e) => {
    const area = e.target instanceof Element ? e.target.closest("#agent-msg") : null;
    if (!area) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      area.form?.requestSubmit();
    } else if (area.getAttribute("aria-invalid") && area.value.trim()) {
      area.removeAttribute("aria-invalid");
      area.form?.querySelector(".err")?.setAttribute("hidden", "");
    }
  });

  void loadMessages();
  refreshDecisions().catch(() => {});
  return {
    onEvents(fresh) {
      if (
        (fresh ?? []).some((e) =>
          ["card/message", "card/handed_back", "card/message_delivered"].includes(e.type),
        )
      ) {
        void loadMessages();
      } else draw();
    },
    onStore(patch) {
      if ("decisions" in patch || "cards" in patch) draw();
    },
    destroy() {
      state.seq++;
    },
  };
}
