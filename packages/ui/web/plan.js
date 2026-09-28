// Plan tab (FRONTEND_DESIGN §2.4.3): what the card is supposed to do, what it
// may touch, what it may spend, what it waits on, and what the Planner told
// the Worker after a failed attempt.
import { esc, icon } from "./dom.js";
import {
  ISSUE_TYPE_LABELS,
  columnLabel,
  formatDuration,
  formatTokens,
  parseTitle,
} from "./lib/vocabulary.js";
import { startCardNote } from "./review_plan_view.js";
import { store } from "./store.js";

function meter(used, budget, format = (n) => String(n), unit = "") {
  if (!budget) {
    return `<span class="sec">${used ? `${esc(format(used))}${unit} used · no budget set` : "No budget set"}</span>`;
  }
  const ratio = Math.min(1, (used ?? 0) / budget);
  const cls = ratio >= 1 ? " over" : ratio >= 0.75 ? " warn" : "";
  return `<div class="bmeter"><span class="budget${cls}"><i style="width:${Math.round(ratio * 100)}%"></i></span><span class="tnum">${esc(format(used ?? 0))} of ${esc(format(budget))}${unit}</span></div>`;
}

function difficultyHtml(d) {
  if (!d) return '<span class="sec">Not rated by the planning model</span>';
  const segs = Array.from({ length: 10 }, (_, i) => `<i class="${i < d ? "on" : ""}"></i>`).join(
    "",
  );
  const routing = d <= 3 ? "Direct" : d <= 7 ? "Edit sketch" : "Split";
  return `<div class="diff-meter" role="img" aria-label="Difficulty ${d} of 10">${segs}</div><span class="tnum">${d}/10</span><span class="sec">· routing: ${routing}</span>`;
}

function linkList(cards, empty) {
  if (!cards.length) return `<p class="sec">${esc(empty)}</p>`;
  return `<ul class="links">${cards
    .map(
      (c) =>
        `<li><a href="#/card/${encodeURIComponent(c.id)}/plan">${esc(c.display?.title ?? parseTitle(c.title).title)}</a><span class="sec">${esc(columnLabel(c.status))}</span></li>`,
    )
    .join("")}</ul>`;
}

function repairPlans(events) {
  return (events ?? []).filter((e) => e.type === "card/repair_plan");
}

function html(ctx) {
  const card = ctx.card();
  if (!card) return "";
  const detail = ctx.detail();
  const full = detail?.card ?? card;
  const all = store.state.cards;
  const waitsOn = (full.dependsOn ?? []).map((id) => all.find((c) => c.id === id)).filter(Boolean);
  const unblocks = all.filter((c) => (c.dependsOn ?? []).includes(card.id));
  const type = ISSUE_TYPE_LABELS[card.display?.type];
  const criteria = full.acceptanceCriteria ?? [];
  const plans = repairPlans(ctx.events());
  const ev = detail?.evidence;
  const tokensUsed =
    full.tokensUsed || (ev ? ev.tokens.promptTokens + ev.tokens.completionTokens : 0);
  const secondsUsed = full.secondsUsed || (ev ? Math.round(ev.durationMs / 1000) : 0);

  const parts = [];
  const start = startCardNote(full);
  if (start) parts.push(`<section class="start-card"><p class="prose">${esc(start)}</p></section>`);
  parts.push(
    `<section><h3 class="sh">Spec</h3>${full.spec ? `<p class="prose">${esc(full.spec)}</p>` : '<p class="sec">No spec recorded. The agent works from the title and the criteria.</p>'}${type ? `<p class="sec kind-why"><b>${esc(type.label)}</b>: ${esc(type.tooltip)}</p>` : ""}</section>`,
  );
  parts.push(
    `<section><h3 class="sh">Done when <span class="sec">${criteria.length ? `${criteria.length} criteria` : ""}</span></h3>${criteria.length ? `<ul class="crit">${criteria.map((c) => `<li><span class="bul" aria-hidden="true"></span><span>${esc(c)}</span></li>`).join("")}</ul>` : '<p class="sec">No criteria recorded for this issue.</p>'}</section>`,
  );
  const scope = (full.scopeFiles ?? [])
    .map(
      (f) =>
        `<div class="prov">${icon("file", 14, "ic s14")}<span class="mono">${esc(f)}</span><span class="end">May edit</span></div>`,
    )
    .join("");
  const tests = (full.acceptanceTests ?? [])
    .map(
      (f) =>
        `<div class="prov">${icon("lock", 14, "ic s14")}<span class="mono">tests/${esc(f)}</span><span class="end">Protected</span></div>`,
    )
    .join("");
  parts.push(
    `<div class="two"><section><h3 class="sh">May edit</h3>${scope || '<p class="sec">No files in scope.</p>'}</section><section><h3 class="sh">Acceptance tests</h3>${tests || '<p class="sec">None. The project\'s own checks decide.</p>'}</section></div>`,
  );
  parts.push(
    `<section><h3 class="sh">Budget</h3><dl class="kv budget-kv"><dt>Steps</dt><dd>${meter(full.stepsUsed, full.stepBudget, String, " steps")}</dd><dt>Tokens</dt><dd>${meter(tokensUsed, full.tokenBudget, formatTokens)}</dd><dt>Time</dt><dd>${meter(secondsUsed, full.secondsBudget, (s) => formatDuration(s * 1000))}</dd><dt>Difficulty</dt><dd class="diff-row">${difficultyHtml(full.difficulty)}</dd></dl></section>`,
  );
  parts.push(
    `<div class="two"><section><h3 class="sh">Waits on</h3>${linkList(waitsOn, "Nothing. This issue can run as soon as it is Ready.")}</section><section><h3 class="sh">Unblocks</h3>${linkList(unblocks, "No issue waits on this one.")}</section></div>`,
  );
  const plansHtml = plans.length
    ? plans
        .map(
          (p, i) =>
            `<figure class="plan-q"><figcaption>${icon("pencil", 14, "ic s14")}Planning model, before attempt ${i + 2} · <span class="tnum">${esc(new Date(p.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }))}</span></figcaption><blockquote>${esc(p.payload?.plan ?? "")}</blockquote></figure>`,
        )
        .join("")
    : `<p class="sec">${ev && !ev.passed ? "No repair plan yet. When a queue runs with a Planning model, its plan for the next attempt appears here." : "The planning model has not needed to repair this issue."}</p>`;
  parts.push(`<section><h3 class="sh">Repair plan</h3>${plansHtml}</section>`);
  return parts.join("");
}

export function renderPlan(host, ctx) {
  let last = "";
  const draw = () => {
    const next = html(ctx);
    if (next === last) return;
    last = next;
    const top = host.scrollTop;
    host.innerHTML = next;
    host.scrollTop = top;
  };
  draw();
  return {
    onDetail: draw,
    onEvents: draw,
    onStore(patch) {
      if ("cards" in patch) draw();
    },
  };
}
