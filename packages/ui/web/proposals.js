// Proposal groups (PM_DESIGN §2.4): field diffs with Apply / Discard, one by
// one or all together. Used by the PM thread and by Import on Integrations.
import { esc, icon, kbd } from "./dom.js";
import {
  applyAllLabel,
  formatFieldValue,
  formatPoints,
  formatShortDate,
  proposalDiff,
  proposalKind,
} from "./lib/pm.js";
import { ISSUE_TYPE_LABELS, issueTypeOf } from "./lib/vocabulary.js";
import { cardChip, diffContext, prioMark } from "./marks.js";
import { applyAll, decide, discardAll } from "./pm_client.js";
import { hasReviewPlan, openReviewPlan } from "./review_plan.js";
import { reviewPlanButtonHtml } from "./review_plan_view.js";
import { getSession } from "./session.js";
import { store } from "./store.js";

const busy = new Set();

function clock(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleTimeString([], {
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function valueHtml(row, which) {
  const text = which === "before" ? row.before : row.after;
  const raw = which === "before" ? row.beforeRaw : row.afterRaw;
  const glyph = row.field === "priority" ? prioMark(raw) : "";
  return `${glyph}<span>${esc(text)}</span>`;
}

function diffRows(p, ctx) {
  const rows = proposalDiff(p, ctx);
  if (rows.length === 0) return "";
  const items = rows
    .map((r) => {
      if (r.type === "labels") {
        const add = (r.added ?? []).map((l) => `<span class="add">+ ${esc(l)}</span>`).join("");
        const rem = (r.removed ?? []).map((l) => `<span class="rem">− ${esc(l)}</span>`).join("");
        const aria = [
          r.added?.length ? `adds ${r.added.join(", ")}` : "",
          r.removed?.length ? `removes ${r.removed.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("; ");
        return `<div><dt>${esc(r.label)}</dt><dd class="set" aria-label="${esc(`${r.label}: ${aria}`)}">${add}${rem}</dd></div>`;
      }
      return `<div><dt>${esc(r.label)}</dt><dd aria-label="${esc(`${r.label}: ${r.before}, changes to ${r.after}`)}"><span class="b">${valueHtml(r, "before")}</span>${icon("arrow-right", 12, "ic s12 arr")}<span class="a">${valueHtml(r, "after")}</span></dd></div>`;
    })
    .join("");
  return `<dl class="pdiff">${items}</dl>`;
}

function cardsList(p) {
  const list = p.cards ?? [];
  if (!list.length) return "";
  const items = list
    .map((c, i) => {
      const kind = ISSUE_TYPE_LABELS[issueTypeOf(c)]?.label ?? "";
      const meta = [
        kind,
        typeof c.estimate === "number" ? formatPoints(c.estimate) : "",
        c.priority ? formatFieldValue("priority", c.priority) : "",
        c.dependsOn?.length ? `waits on ${c.dependsOn.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return `<li><span class="n tnum">${i + 1}</span><span class="t">${esc(c.title ?? "Untitled issue")}</span><span class="meta">${esc(meta)}</span></li>`;
    })
    .join("");
  return `<ol class="pcards">${items}</ol>`;
}

function cycleRows(p) {
  const x = p.patch ?? {};
  const rows = [];
  if (x.name) rows.push(["Name", x.name]);
  if (x.startsOn || x.endsOn)
    rows.push(["Dates", `${formatShortDate(x.startsOn)} – ${formatShortDate(x.endsOn)}`]);
  if (x.goal) rows.push(["Goal", x.goal]);
  if (!rows.length) return "";
  return `<dl class="pdiff new">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd><span class="a"><span>${esc(v)}</span></span></dd></div>`).join("")}</dl>`;
}

function body(p, ctx) {
  if (p.kind === "create_cycle") return cycleRows(p);
  if (p.kind === "create_card" || p.kind === "split_card") {
    const note =
      p.kind === "split_card" && p.cardId
        ? `<p class="pnote">Replaces${cardChip(p.cardId) ?? `<span class="mono">${esc(p.cardId)}</span>`}</p>`
        : "";
    return `${cardsList(p)}${note}`;
  }
  if (p.kind === "reorder") return "";
  if (p.kind === "park" || p.kind === "unpark") {
    const reason = p.patch?.reason ?? p.patch?.note;
    return reason ? `<p class="pnote">${esc(reason)}</p>` : "";
  }
  return diffRows(p, ctx);
}

export function proposalHtml(p, ctx = diffContext()) {
  const k = proposalKind(p.kind);
  const chip = p.cardId ? (cardChip(p.cardId, { max: 40 }) ?? "") : "";
  if (p.state === "applied" || p.state === "discarded") {
    const when = clock(p.decidedAt);
    const verb = p.state === "applied" ? "Applied" : "Discarded";
    const mark =
      p.state === "applied" ? icon("check", 12, "ic s12 i-pass") : icon("x", 12, "ic s12");
    return `<li class="prop ${p.state}" data-prop="${esc(p.id)}">${mark}<b>${verb}</b><span class="sum">${esc(p.summary)}</span>${when ? `<span class="when tnum">${p.state === "applied" ? "by you " : ""}at ${esc(when)}</span>` : ""}</li>`;
  }
  const isBusy = busy.has(p.id);
  const stale = p.state === "stale";
  const staleNote = stale
    ? `<p class="pstale">${icon("alert", 12, "ic s12 i-park")}<span>${p.cardId ? `${chip || esc(p.cardId)} changed after this was proposed.` : "The board changed after this was proposed."} Ask again for a fresh proposal.</span></p>`
    : "";
  const acts = stale
    ? `<div class="pacts"><button class="btn ghost sm" type="button" data-discard>Discard ${kbd("n")}</button><button class="btn sm" type="button" disabled aria-disabled="true">Apply</button><span class="why">Out of date</span></div>`
    : `<div class="pacts"><button class="btn ghost sm" type="button" data-discard ${isBusy ? "disabled" : ""}>Discard ${kbd("n")}</button>${
        // DS-P2-6: a new project is reviewed, with the person's choices, before it is created.
        hasReviewPlan(p)
          ? reviewPlanButtonHtml(isBusy)
          : `<button class="btn sm" type="button" data-apply ${isBusy ? "disabled" : ""}>${isBusy ? "Applying…" : `Apply ${kbd("y")}`}</button>`
      }</div>`;
  return `<li class="prop open${stale ? " stale" : ""}" tabindex="-1" data-prop="${esc(p.id)}" role="group" aria-label="${esc(`${k.label}: ${p.summary}`)}"><div class="ph">${icon(k.icon, 14, "ic s14")}<span class="pk">${esc(k.label)}</span>${chip}</div><p class="sum">${esc(p.summary)}</p>${body(p, ctx)}${staleNote}${acts}</li>`;
}

/**
 * A reply's proposals as one group. `title` defaults to "Proposed changes";
 * Import passes "Import from Jira CSV".
 */
export function proposalGroupHtml(proposals, { title = "Proposed changes", groupId = "" } = {}) {
  if (!proposals?.length) return "";
  const ctx = diffContext();
  const open = proposals.filter((p) => p.state === "open");
  // A new project is never applied in bulk: it goes through Review plan.
  const bulk = withoutReviewPlan(open).length > 0;
  const head = open.length
    ? `<span class="sec tnum">${open.length} open</span><div class="gacts">${open.length > 1 ? `<button class="btn ghost sm" type="button" data-discard-all>Discard all</button>` : ""}${bulk ? `<button class="btn primary sm" type="button" data-apply-all>${esc(applyAllLabel(withoutReviewPlan(proposals)))} ${kbd("⇧Y")}</button>` : ""}</div>`
    : `<span class="sec">All decided</span>`;
  return `<section class="pgroup" data-group="${esc(groupId)}" aria-label="${esc(title)}"><header><b>${esc(title)}</b>${head}</header><ul class="plist" role="list">${proposals.map((p) => proposalHtml(p, ctx)).join("")}</ul></section>`;
}

/** The proposals Apply all may apply: every one but a new project's (DS-P2-6). */
function withoutReviewPlan(list) {
  return list.filter((p) => !hasReviewPlan(p));
}

/** Proposals by id across the thread (and any extra source, e.g. an import preview). */
function findIn(sources, id) {
  for (const list of sources()) {
    const p = list.find((x) => x.id === id);
    if (p) return { p, list };
  }
  return null;
}

export function threadSources() {
  return store.state.pm.messages.filter((m) => m.proposals?.length).map((m) => m.proposals);
}

/**
 * Delegate clicks and the proposal keys (`y`, `n`, `⇧Y`, `j/k`) under `root`.
 * `sources()` returns the proposal lists to search; `onChange()` re-renders
 * callers that keep proposals outside the store.
 */
export function bindProposals(root, { sources = threadSources, onChange = () => {} } = {}) {
  const run = async (p, verb) => {
    if (busy.has(p.id)) return;
    busy.add(p.id);
    onChange();
    store.set({});
    const r = await decide(p, verb);
    busy.delete(p.id);
    if (r.ok) Object.assign(p, r.proposal);
    onChange();
    store.set({});
    // Keep the keyboard in the group: move to the next open proposal.
    const next = root.querySelector(".prop.open:not(.stale)");
    if (next && root.contains(document.activeElement)) next.focus();
  };
  // DS-P2-6: Review plan applies the proposal itself, with the person's choices.
  const review = async (p) => {
    if (busy.has(p.id)) return;
    const result = await openReviewPlan(p, { setup: getSession().mode });
    if (result?.proposal) Object.assign(p, result.proposal);
    onChange();
    store.set({});
  };
  const groupOf = (el) => {
    const li = el.closest(".pgroup")?.querySelector("[data-prop]");
    return li ? findIn(sources, li.dataset.prop)?.list : null;
  };
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const li = t.closest("[data-prop]");
    if (t.closest("[data-review-plan]") && li) {
      const hit = findIn(sources, li.dataset.prop);
      if (hit) review(hit.p);
    } else if (t.closest("[data-apply]") && li) {
      const hit = findIn(sources, li.dataset.prop);
      if (hit) run(hit.p, "apply");
    } else if (t.closest("[data-discard]") && li) {
      const hit = findIn(sources, li.dataset.prop);
      if (hit) run(hit.p, "discard");
    } else if (t.closest("[data-apply-all]")) {
      const list = groupOf(t);
      if (list) applyAll(withoutReviewPlan(list)).then(() => onChange());
    } else if (t.closest("[data-discard-all]")) {
      const list = groupOf(t);
      if (list) discardAll(list).then(() => onChange());
    }
  });
  root.addEventListener("keydown", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const li = t.closest(".prop.open");
    const group = t.closest(".pgroup");
    if (!group) return;
    let handled = true;
    if (e.key === "Y") {
      const list = groupOf(t);
      if (list) applyAll(withoutReviewPlan(list)).then(() => onChange());
    } else if (li && e.key === "y" && !li.classList.contains("stale")) {
      const hit = findIn(sources, li.dataset.prop);
      if (hit) {
        if (hasReviewPlan(hit.p)) review(hit.p);
        else run(hit.p, "apply");
      }
    } else if (li && e.key === "n") {
      const hit = findIn(sources, li.dataset.prop);
      if (hit) run(hit.p, "discard");
    } else if (e.key === "j" || e.key === "k" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = Array.from(root.querySelectorAll(".prop.open"));
      const i = items.indexOf(li);
      const next = items[e.key === "j" || e.key === "ArrowDown" ? i + 1 : i - 1] ?? items[0];
      next?.focus();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}
