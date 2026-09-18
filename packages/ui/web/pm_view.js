// #/pm: the full conversation with Merit (PM_DESIGN §2.4). The thread in a
// reading column, and a rail with open proposals, the Worker and what Merit sees.
import { esc, icon } from "./dom.js";
import { loadLearning } from "./learning.js";
import { proposalKind, strengthLabel } from "./lib/pm.js";
import { cardChip } from "./marks.js";
import { PM_NAME, pmModel } from "./pm_client.js";
import { setFullThread } from "./pm_panel.js";
import { mountThread } from "./pm_thread.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

function railHtml() {
  const s = store.state;
  const open = [];
  for (const m of s.pm.messages)
    for (const p of m.proposals ?? []) if (p.state === "open") open.push(p);
  const props = open.length
    ? `<ul class="rail-props">${open
        .map((p) => {
          const k = proposalKind(p.kind);
          return `<li><button type="button" data-goto-prop="${esc(p.id)}">${icon(k.icon, 12, "ic s12")}<span>${esc(p.summary)}</span></button></li>`;
        })
        .join("")}</ul>`
    : '<p class="sec">Nothing waiting. Proposals Merit makes appear here until you apply or discard them.</p>';

  const running = s.cards.find((c) => c.status === "in_progress");
  const paused = s.pm.status?.workerPaused;
  const worker = running
    ? `<p class="wk">${paused ? icon("pause", 12, "ic s12 i-run") : '<span class="dot run" aria-hidden="true"></span>'}<span>${paused ? `Paused for ${PM_NAME}` : "Working"}${running.stepsUsed ? ` · step ${running.stepsUsed} of ${running.stepBudget}` : ""}</span></p><p>${cardChip(running.id, { max: 40 }) ?? ""}</p>`
    : '<p class="sec">Idle. Nothing is running, so talking to Merit pauses nothing.</p>';

  const lastRun = s.queue?.startedAt ?? s.queue?.finishedAt;
  const runText = lastRun
    ? new Date(lastRun).toLocaleString([], {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
    : "No runs yet";
  const ledger = s.verification
    ? `${s.verification.totalEvents} entries${s.verification.valid === false ? " · altered" : " · intact"}`
    : "Checking…";
  const model = pmModel();
  const sees = `<dl class="kv"><div><dt>Board</dt><dd>${s.cards.length} cards · live</dd></div><div><dt>Last run</dt><dd>${esc(runText)}</dd></div><div><dt>Ledger</dt><dd>${esc(ledger)}</dd></div><div><dt>Model</dt><dd class="mono">${esc(model)}</dd></div></dl>`;

  const l = s.learning;
  let learned;
  if (l.status === 200 && l.data) {
    const top = (l.data.profile ?? [])
      .filter((e) => e.status === "active")
      .sort((a, b) => b.strength - a.strength);
    learned = top.length
      ? `<ul class="rail-learned">${top
          .slice(0, 3)
          .map(
            (e) =>
              `<li><span class="valbar" role="img" aria-label="${esc(`Strength ${strengthLabel(e.strength)}`)}"><i style="width:${Math.round(Math.min(1, Math.max(0, e.strength)) * 100)}%"></i></span><span>${esc(e.statement)}</span></li>`,
          )
          .join(
            "",
          )}</ul><p class="small"><a href="#/playbook/profile">See all ${top.length} and edit them in Playbook</a></p>`
      : '<p class="sec">Nothing yet. Merit learns from your send-back notes, the proposals you apply or discard, and the fields you change.</p>';
    learned += '<p class="sec small">Stays on this machine. You can edit or dismiss any of it.</p>';
  } else if (l.status === 0) {
    learned = '<p class="sec">Checking…</p>';
  } else {
    learned =
      '<p class="sec">Arrives with an updated Sekhemet (<span class="mono">GET /api/learning</span>).</p>';
  }
  return `<section><h3>Open proposals <span class="sec tnum">${open.length}</span></h3>${props}</section><section><h3>Worker</h3>${worker}</section><section><h3>What ${PM_NAME} can see</h3>${sees}<p class="sec small">${PM_NAME} reads these and proposes changes. It never edits the board itself.</p></section><section><h3>What ${PM_NAME} has learned about you</h3>${learned}</section>`;
}

export function mount(view) {
  setTopbar({ title: PM_NAME, crumb: "Project manager" });
  const host = document.createElement("div");
  host.className = "pm-page";
  host.innerHTML =
    '<div class="pm-main"></div><aside class="pm-rail" aria-label="Conversation facts"></aside>';
  view.append(host);
  const thread = mountThread(host.querySelector(".pm-main"), { variant: "full" });
  setFullThread(thread);
  const rail = host.querySelector(".pm-rail");
  let last = "";
  const render = () => {
    const html = railHtml();
    if (html !== last) {
      rail.innerHTML = html;
      last = html;
    }
  };
  rail.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("[data-goto-prop]") : null;
    if (!b) return;
    const li = host.querySelector(`.pm-main [data-prop="${CSS.escape(b.dataset.gotoProp)}"]`);
    li?.scrollIntoView({ block: "center" });
    li?.querySelector("button[data-apply]")?.focus({ preventScroll: true });
  });
  const unsub = store.on(render);
  render();
  loadLearning();
  setTimeout(() => thread.focus(), 0);
  return {
    unmount() {
      unsub();
      setFullThread(null);
      thread.destroy();
      host.remove();
    },
  };
}
