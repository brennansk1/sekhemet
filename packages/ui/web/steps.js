// Steps tab (FRONTEND_DESIGN §2.4.3): the transcript one step per row, the loop
// annotated where it fired, the stop stated last. A running card streams new
// steps at the bottom with no animation; auto-follow pauses on scroll-up.
import { esc, getJSON, icon, kbd } from "./dom.js";
import {
  formatDuration,
  formatTokens,
  gateLabel,
  loopRange,
  plural,
  stopReasonLabel,
} from "./lib/vocabulary.js";

function usageHtml(u) {
  if (!u) return "";
  const t = `${formatTokens(u.promptTokens ?? 0)} in · ${formatTokens(u.completionTokens ?? 0)} out`;
  return `${esc(t)}${u.durationMs !== undefined ? `<br>${esc(formatDuration(u.durationMs))}` : ""}`;
}

function gateLine(gate) {
  if (!gate) return "";
  if (gate.passed)
    return `<div class="gate-r pass">${icon("check", 12, "ic s12")}Gates passed</div>`;
  const names = [
    ...new Set(
      (gate.failures ?? [])
        .map((f) => {
          const g = /^(\w+) failed$/.exec(f)?.[1];
          return g ? gateLabel(g) : null;
        })
        .filter(Boolean),
    ),
  ];
  const n = (gate.failures ?? []).length;
  if (names.length) {
    return `<div class="gate-r">${icon("x", 12, "ic s12")}Gates: ${esc(names.join(", "))} failed</div>`;
  }
  const first = String(gate.failures?.[0] ?? "").split("\n")[0];
  return `<div class="gate-r" title="${esc(first)}">${icon("x", 12, "ic s12")}Gates failed${n ? ` · ${esc(plural(n, "error"))}` : ""}${first ? ` <span class="arg">${esc(first.length > 90 ? `${first.slice(0, 87)}…` : first)}</span>` : ""}</div>`;
}

function stepHtml(s, loop, open) {
  const inLoop = loop && s.turn >= loop.from && s.turn <= loop.to;
  const calls = s.calls.length
    ? s.calls
        .map(
          (c, i) =>
            `<span class="${c.ok === false ? "bad" : ""}">${esc(c.name)}</span>${c.target ? ` <span class="arg">${esc(c.name === "note" ? `"${c.target}"` : c.target)}</span>` : ""}${c.content !== undefined ? ` <button class="expand" type="button" data-expand="${s.turn}:${i}" aria-expanded="${open.has(`${s.turn}:${i}`)}">${open.has(`${s.turn}:${i}`) ? "hide" : "show"} content</button>` : ""}`,
        )
        .join(" · ")
    : '<span class="arg">no tool calls</span>';
  const obs = s.calls
    .map((c) => c.summary)
    .filter(Boolean)
    .join(" · ");
  const contents = s.calls
    .map((c, i) =>
      c.content !== undefined && open.has(`${s.turn}:${i}`)
        ? `<pre class="written" aria-label="Content written to ${esc(c.target ?? "file")}">${esc(c.content)}</pre>`
        : "",
    )
    .join("");
  const bracket =
    loop && s.turn === loop.to
      ? `<div class="bracket">${icon("ring", 12, "ic s12")}Steps ${loop.from}–${loop.to} repeat ${esc(loop.repeated)}${loop.lastChange ? `; no file changed after step ${loop.lastChange}` : "; no file changed"}</div>`
      : "";
  return `<li class="step${inLoop ? " loop" : ""}" id="step-${s.turn}"><span class="no">Step ${s.turn}</span><div><div class="call">${calls}</div>${obs ? `<div class="obs">${esc(obs)}</div>` : ""}${gateLine(s.gate)}${bracket}${contents}</div><span class="use">${usageHtml(s.usage)}</span></li>`;
}

function stopHtml(steps, card, live) {
  if (live) {
    return `<li class="step live"><span class="no"></span><div><div class="call"><span class="dot run" aria-hidden="true"></span> Working</div><div class="obs">The Worker is on step ${esc(steps.at(-1)?.turn ?? 1)} of ${esc(card?.stepBudget ?? "?")}. New steps appear here as they finish.</div></div><span class="use"></span></li>`;
  }
  const last = steps.at(-1);
  const reason = last?.stopReason;
  if (!reason) return "";
  const l = stopReasonLabel(reason, { step: last.turn, stepBudget: card?.stepBudget });
  const inT = steps.reduce((n, s) => n + (s.usage?.promptTokens ?? 0), 0);
  const outT = steps.reduce((n, s) => n + (s.usage?.completionTokens ?? 0), 0);
  const ms = steps.reduce((n, s) => n + (s.usage?.durationMs ?? 0), 0);
  const totals = [
    `${last.turn} of ${card?.stepBudget ?? "?"} steps used`,
    `${formatTokens(inT)} tokens in · ${formatTokens(outT)} out`,
    ms ? formatDuration(ms) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<li class="step stop ${esc(l.tone)}"><span class="no"></span><div><div class="call">Stopped: ${esc(l.short)}</div><div class="obs">${esc(l.sentence)} ${esc(totals)}.</div></div><span class="use"></span></li>`;
}

/** Mount the Steps tab into `host`. */
export function renderSteps(host, ctx) {
  const state = {
    data: null,
    attempt: undefined,
    open: new Set(),
    follow: true,
    unseen: 0,
    seq: 0,
  };
  host.innerHTML = '<div class="sk sk-line" style="width:40%"></div>';

  const scroller = host;
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
  const onScroll = () => {
    state.follow = atBottom();
    if (state.follow && state.unseen) {
      state.unseen = 0;
      host.querySelector(".new-steps")?.remove();
    }
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });

  const draw = ({ appendOnly = false } = {}) => {
    const d = state.data;
    const card = ctx.card();
    if (!d || d.attempts === 0) {
      host.innerHTML = `<div class="ev-empty">${icon("runs", 24, "ic s24")}<b>No steps yet.</b><span>The Worker hasn't started this card.</span></div>`;
      return;
    }
    const loop = d.live ? null : loopRange(d.steps);
    const list = host.querySelector("ol.steps");
    if (appendOnly && list) {
      // Streaming: append rows for new turns only, no re-render, no motion.
      const have = new Set([...list.querySelectorAll(".step[id]")].map((n) => n.id));
      list.querySelector(".step.live")?.remove();
      for (const s of d.steps) {
        if (!have.has(`step-${s.turn}`))
          list.insertAdjacentHTML("beforeend", stepHtml(s, loop, state.open));
      }
      list.insertAdjacentHTML("beforeend", stopHtml(d.steps, card, d.live));
      return;
    }
    const attempts =
      d.attempts > 1
        ? `<select class="att" data-steps-attempt aria-label="Attempt">${Array.from({ length: d.attempts }, (_, i) => `<option value="${i + 1}"${i + 1 === d.attempt ? " selected" : ""}>attempt ${i + 1} of ${d.attempts}</option>`).join("")}</select>`
        : `<span class="att">attempt ${esc(d.attempt)} of ${esc(d.attempts)}</span>`;
    const source = d.live
      ? "live from the ledger"
      : d.file
        ? `transcript <span class="mono">${esc(d.file)}</span>`
        : "";
    const top = scroller.scrollTop;
    host.innerHTML = `<h3 class="sh" style="margin:0">Steps <span class="sec">${attempts}</span><span class="sec">${source}</span><span class="diff-mode">${kbd("[")}${kbd("]")} attempt</span></h3><ol class="steps" aria-live="off">${d.steps.map((s) => stepHtml(s, loop, state.open)).join("")}${stopHtml(d.steps, card, d.live)}</ol>`;
    scroller.scrollTop = top;
  };

  const fetchSteps = async ({ appendOnly = false } = {}) => {
    const seq = ++state.seq;
    const q = state.attempt ? `?attempt=${state.attempt}` : "";
    const res = await getJSON(`/api/cards/${encodeURIComponent(ctx.id)}/transcript${q}`);
    if (seq !== state.seq || !host.isConnected) return;
    if (!res.ok) {
      host.innerHTML = `<div class="ev-error" role="alert">${icon("alert")}<span><b>Couldn't load the steps.</b> <span class="sec">The server returned ${esc(res.status)}. ${esc(res.data?.error ?? "")}</span></span></div>`;
      return;
    }
    const before = state.data?.steps?.length ?? 0;
    const sameAttempt =
      state.data && state.data.attempt === res.data.attempt && state.data.live === res.data.live;
    state.data = res.data;
    const wasBottom = atBottom();
    draw({ appendOnly: appendOnly && sameAttempt });
    const added = res.data.steps.length - before;
    if (appendOnly && added > 0) {
      if (wasBottom || state.follow) scroller.scrollTop = scroller.scrollHeight;
      else {
        state.unseen += added;
        let pill = host.querySelector(".new-steps");
        if (!pill) {
          host.insertAdjacentHTML(
            "beforeend",
            '<button class="new-steps" type="button" data-new-steps></button>',
          );
          pill = host.querySelector(".new-steps");
        }
        pill.innerHTML = `${esc(plural(state.unseen, "new step"))} ${icon("arrow-down", 12, "ic s12")}`;
      }
    }
  };

  host.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const ex = t?.closest("[data-expand]");
    if (ex) {
      const k = ex.dataset.expand;
      if (state.open.has(k)) state.open.delete(k);
      else state.open.add(k);
      draw();
      return;
    }
    if (t?.closest("[data-new-steps]")) {
      scroller.scrollTop = scroller.scrollHeight;
      state.unseen = 0;
      t.closest("[data-new-steps]").remove();
    }
  });
  host.addEventListener("change", (e) => {
    const sel = e.target instanceof Element ? e.target.closest("[data-steps-attempt]") : null;
    if (sel) {
      state.attempt = Number(sel.value) === state.data?.attempts ? undefined : Number(sel.value);
      fetchSteps();
    }
  });

  fetchSteps();
  return {
    onEvents(fresh) {
      if ((fresh ?? []).some((e) => e.type === "card/step" || e.type === "card/status_changed")) {
        if (!state.attempt) fetchSteps({ appendOnly: true });
      }
    },
    onKey(e) {
      if (e.key !== "[" && e.key !== "]") return false;
      const n = state.data?.attempts ?? 0;
      const cur = state.attempt ?? n;
      const next = Math.max(1, Math.min(n, cur + (e.key === "]" ? 1 : -1)));
      if (n > 1 && next !== cur) {
        state.attempt = next === n ? undefined : next;
        fetchSteps();
      }
      return true;
    },
    destroy() {
      state.seq++;
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}
