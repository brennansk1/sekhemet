// Thread tab (FRONTEND_DESIGN §2.4.3): this card's history from the ledger, in
// sentences. Send-back and park notes, and repair plans, render as quotes.
import { esc, icon } from "./dom.js";
import { eventSentence } from "./lib/vocabulary.js";

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

function rowHtml(e, ctx) {
  const s = eventSentence(e, () => undefined);
  const withTitle = e.type === "card/created";
  const title = withTitle && s.title ? ` <b>${esc(s.title)}</b>` : "";
  const mark = TONE_ICON[s.tone]?.() ?? '<span class="tl-dot" aria-hidden="true"></span>';
  const stepLink =
    e.type === "card/step" ? ` <a href="#/card/${encodeURIComponent(ctx.id)}/steps">Steps</a>` : "";
  return `<li class="th-row${e.type === "card/step" ? " is-step" : ""}"><span class="th-mark">${mark}</span><div class="th-body"><div><b class="who">${esc(s.actor)}</b> ${esc(title ? s.verb : s.verb.replace(/ (on|for)$/, ""))}${title}${s.rest ? ` ${esc(s.rest)}` : ""}${stepLink}</div>${s.quote ? `<blockquote>${esc(s.quote)}</blockquote>` : ""}</div><span class="th-meta"><span class="tnum">${esc(when(e.createdAt))}</span><span class="mono" title="Ledger entry">#${esc(e.seq)}</span></span></li>`;
}

export function renderThread(host, ctx) {
  let showSteps = false;
  let last = "";
  const draw = () => {
    const events = ctx.events();
    if (!events) {
      host.innerHTML = '<div class="sk sk-line" style="width:40%"></div>';
      return;
    }
    const steps = events.filter((e) => e.type === "card/step").length;
    const shown = events.filter((e) => showSteps || e.type !== "card/step");
    const toggle = steps
      ? `<button class="filter" type="button" data-toggle-steps aria-pressed="${showSteps}">${icon(showSteps ? "x" : "plus", 12, "ic s12")}${steps} step ${steps === 1 ? "entry" : "entries"}</button>`
      : "";
    const next = `<h3 class="sh" style="margin:0">Thread <span class="sec">${events.length} ledger ${events.length === 1 ? "entry" : "entries"}</span>${toggle}</h3>${shown.length ? `<ol class="thread">${shown.map((e) => rowHtml(e, ctx)).join("")}</ol>` : '<p class="sec">Nothing recorded for this card yet.</p>'}`;
    if (next === last) return;
    last = next;
    host.innerHTML = next;
  };
  host.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-toggle-steps]")) {
      showSteps = !showSteps;
      draw();
    }
  });
  draw();
  return { onEvents: draw };
}
