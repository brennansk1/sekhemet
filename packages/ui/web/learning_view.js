// Playbook with learning (PM_CONTRACT §6): rules grouped by status with their
// scope, counts, value and evidence, and what Merit has learned about you.
// Nothing learned takes effect until you approve it; everything is editable.
import { esc, icon, kbd } from "./dom.js";
import { approveRule, dismissEntry, editEntry, editRule, retireRule } from "./learning.js";
import {
  PROFILE_SOURCE_LABELS,
  RULE_SOURCE_LABELS,
  groupRules,
  profileByCategory,
  retireSuggested,
  scopeChips,
  strengthLabel,
  valueBar,
} from "./lib/pm.js";
import { KIND_LABELS, formatWait } from "./lib/vocabulary.js";
import { cardChip } from "./marks.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const ms = Date.now() - t;
  return ms < 60_000 ? "just now" : `${formatWait(ms)} ago`;
}

const kindLabel = (k) => KIND_LABELS[k]?.label ?? k;

function editForm(kind, id, text) {
  return `<form class="lr-edit" data-edit-form="${kind}:${esc(id)}"><textarea rows="3" aria-label="Edit the wording">${esc(text)}</textarea><div class="acts"><button class="btn ghost sm" type="button" data-edit-cancel>Cancel ${kbd("Esc")}</button><button class="btn sm primary" type="submit">Save ${kbd("⌘↵")}</button></div></form>`;
}

function evidenceHtml(list) {
  if (!list?.length) return "";
  const item = (e) =>
    `<li>${e.cardId ? (cardChip(e.cardId) ?? `<span class="mono">${esc(e.cardId)}</span>`) : ""}${e.note ? `<span class="q">“${esc(e.note)}”</span>` : ""}${e.at ? `<span class="sec tnum">${esc(ago(e.at))}</span>` : ""}</li>`;
  const first = list.slice(0, 2).map(item).join("");
  const rest = list.slice(2);
  return `<ul class="lr-ev">${first}</ul>${rest.length ? `<details class="lr-more"><summary>${rest.length} more ${rest.length === 1 ? "signal" : "signals"}</summary><ul class="lr-ev">${rest.map(item).join("")}</ul></details>` : ""}`;
}

function ruleHtml(r, maxAbs, ui) {
  const editing = ui.editing === `rule:${r.id}`;
  const chips = scopeChips(r.scope, kindLabel)
    .map(
      (c) =>
        `<span class="lchip"><span class="sec">${esc(c.label)}:</span> <span class="${c.label === "Files" || c.label === "Error" ? "mono" : ""}">${esc(c.value)}</span></span>`,
    )
    .join("");
  const vb = valueBar(r.value, maxAbs);
  const value = `<span class="valbar${vb.negative ? " neg" : ""}" role="img" aria-label="${esc(`Value ${r.value.toFixed(2)}`)}"><i style="width:${Math.round(vb.ratio * 100)}%"></i></span><span class="tnum">Value ${esc(r.value.toFixed(1))}</span>`;
  const counts = `<span class="cnt">${icon("check", 12, "ic s12 i-pass")}<span class="tnum">${r.helpful}</span> helpful</span><span class="cnt">${icon("x", 12, "ic s12 i-fail")}<span class="tnum">${r.harmful}</span> harmful</span>`;
  const retire = retireSuggested(r)
    ? `<p class="lr-warn">${icon("alert", 12, "ic s12 i-park")}<span>Proposed for retirement: used ${r.harmful} times on failing first attempts, ${r.helpful} on passing ones.</span></p>`
    : "";
  let acts = "";
  if (r.status === "candidate") {
    acts = `<button class="btn sm primary" type="button" data-approve>${icon("check", 12, "ic s12")}Approve</button><button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm ghost" type="button" data-retire>Retire</button>`;
  } else if (r.status === "active") {
    acts = `<button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm ${retireSuggested(r) ? "" : "ghost"}" type="button" data-retire>Retire</button>`;
  }
  const role = r.role === "manager" ? "For Merit" : "For the Worker";
  const text = editing ? editForm("rule", r.id, r.text) : `<p class="lr-text">${esc(r.text)}</p>`;
  return `<li class="lrule ${esc(r.status)}${retireSuggested(r) ? " warn" : ""}" data-rule-id="${esc(r.id)}"><div class="lr-main"><div class="lr-head"><span class="role">${esc(role)}</span><span class="sec">${esc(RULE_SOURCE_LABELS[r.source] ?? r.source)}${r.createdAt ? ` · ${esc(ago(r.createdAt))}` : ""}</span></div>${text}<div class="lr-scope">${chips}</div>${r.status === "candidate" ? "" : `<div class="lr-meta">${value}${counts}</div>`}${retire}${evidenceHtml(r.evidence)}</div>${editing ? "" : `<div class="lr-acts">${acts}</div>`}</li>`;
}

function profileEntryHtml(e, ui) {
  const editing = ui.editing === `profile:${e.id}`;
  const pct = Math.round(Math.min(1, Math.max(0, e.strength)) * 100);
  const text = editing
    ? editForm("profile", e.id, e.statement)
    : `<p class="lr-text">${esc(e.statement)}</p>`;
  return `<li class="lentry" data-entry-id="${esc(e.id)}"><div class="lr-main">${text}<div class="lr-meta"><span class="valbar" role="img" aria-label="${esc(`Strength ${strengthLabel(e.strength)}, ${pct}%`)}"><i style="width:${pct}%"></i></span><span>${esc(strengthLabel(e.strength))}</span><span class="sec">${esc(PROFILE_SOURCE_LABELS[e.source] ?? e.source)}</span></div>${evidenceHtml(e.evidence)}</div>${editing ? "" : `<div class="lr-acts"><button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm ghost" type="button" data-dismiss>Dismiss</button></div>`}</li>`;
}

export function profileSectionHtml(profile, ui) {
  const groups = profileByCategory(profile ?? []);
  const dismissed = (profile ?? []).filter((e) => e.status === "dismissed");
  const active = groups.reduce((n, g) => n + g.entries.length, 0);
  const body = groups.length
    ? groups
        .map(
          (g) =>
            `<div class="pgrp"><h4>${esc(g.label)}</h4><ul class="lrules">${g.entries.map((e) => profileEntryHtml(e, ui)).join("")}</ul></div>`,
        )
        .join("")
    : '<p class="sec empty-l">Nothing yet. Merit learns from your send-back notes, the proposals you apply or discard, and the fields you change after it sets them. Statements appear here after a run.</p>';
  const gone = dismissed.length
    ? `<details class="lr-more"><summary>${dismissed.length} dismissed</summary><ul class="lrules quiet">${dismissed.map((e) => `<li class="lentry dismissed"><p class="lr-text">${esc(e.statement)}</p></li>`).join("")}</ul></details>`
    : "";
  return `<section id="pb-profile" class="lsec"><h3 class="sh">What Merit has learned about you <span class="sec">${active} ${active === 1 ? "statement" : "statements"} Merit reads when it answers you</span></h3><p class="lp-note">${icon("lock", 12, "ic s12")}<span>These stay on this machine, in the project's ledger. Edit a statement to correct it; dismiss it and Merit stops using it.</span></p>${body}${gone}</section>`;
}

export function learningHtml(data, ui) {
  const rules = data.rules ?? [];
  const g = groupRules(rules);
  const maxAbs = Math.max(1, ...rules.map((r) => Math.abs(r.value || 0)));
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Playbook",
    crumb: `${project}${project ? " · " : ""}${g.active.length} active · ${g.candidate.length} awaiting approval`,
  });
  const list = (items) =>
    `<ul class="lrules">${items.map((r) => ruleHtml(r, maxAbs, ui)).join("")}</ul>`;
  const cand = g.candidate.length
    ? list(g.candidate)
    : '<p class="sec empty-l">Nothing awaiting approval. New rules come from fixes that took the Worker several tries, your send-back notes, and Merit\'s review at the end of a run.</p>';
  const active = g.active.length ? list(g.active) : '<p class="sec empty-l">No active rules.</p>';
  const retired = g.retired.length
    ? `<details class="lr-more"><summary>${g.retired.length} retired</summary>${list(g.retired)}</details>`
    : '<p class="sec empty-l">None retired.</p>';
  return `<div class="lp"><p class="lp-lede">${icon("lock", 14, "ic s14")}<span>Learned from gate results and what you do, never from a model grading itself. Everything stays on this machine and is recorded on the ledger. A rule takes effect only after you approve it, and you can edit or retire any of them.</span></p>
<section id="pb-candidates" class="lsec"><h3 class="sh">Needs your approval <span class="sec">${g.candidate.length} ${g.candidate.length === 1 ? "candidate" : "candidates"}</span></h3>${cand}</section>
<section id="pb-active" class="lsec"><h3 class="sh">Active <span class="sec">${g.active.length} · given to the Worker or Merit when their scope matches · value rises with each helpful use and decays over time</span></h3>${active}</section>
<section id="pb-retired" class="lsec"><h3 class="sh">Retired</h3>${retired}</section>
${profileSectionHtml(data.profile, ui)}</div>`;
}

export function learningMissingHtml(status) {
  const text =
    status === 404
      ? "<b>Learning isn't on this server yet.</b> <code>GET /api/learning</code> returned 404. Below are the seeded rules and your send-back suggestions; approvals, counts and what Merit has learned about you arrive with an updated Sekhemet."
      : `<b>Couldn't load what Sekhemet has learned.</b> The server returned ${esc(status > 0 ? status : "no response")}. Showing the playbook file instead.`;
  return `<p class="lp-banner">${icon("alert", 14, "ic s14 i-park")}<span>${text}</span></p>`;
}

function find(kind, id) {
  return (store.state.learning?.data?.[kind === "rule" ? "rules" : "profile"] ?? []).find(
    (x) => x.id === id,
  );
}

/** Delegated actions for the learning sections under `root`. */
export function bindLearning(root, ui, rerender) {
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const ruleEl = t.closest("[data-rule-id]");
    const entryEl = t.closest("[data-entry-id]");
    const rule = ruleEl && find("rule", ruleEl.dataset.ruleId);
    const entry = entryEl && find("profile", entryEl.dataset.entryId);
    if (t.closest("[data-approve]") && rule) approveRule(rule);
    else if (t.closest("[data-retire]") && rule) retireRule(rule);
    else if (t.closest("[data-dismiss]") && entry) dismissEntry(entry);
    else if (t.closest("[data-edit]") && (rule || entry)) {
      ui.editing = rule ? `rule:${rule.id}` : `profile:${entry.id}`;
      rerender();
      const ta = root.querySelector(".lr-edit textarea");
      ta?.focus();
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    } else if (t.closest("[data-edit-cancel]")) {
      ui.editing = "";
      rerender();
    }
  });
  const save = async (form) => {
    const [kind, id] = form.dataset.editForm.split(/:(.*)/s);
    const text = form.querySelector("textarea").value.trim();
    if (!text) return;
    const item = find(kind, id);
    ui.editing = "";
    rerender();
    if (item) await (kind === "rule" ? editRule(item, text) : editEntry(item, text));
  };
  root.addEventListener("submit", (e) => {
    const form = e.target.closest?.("[data-edit-form]");
    if (!form) return;
    e.preventDefault();
    save(form);
  });
  root.addEventListener("keydown", (e) => {
    const form = e.target.closest?.("[data-edit-form]");
    if (!form) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save(form);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      ui.editing = "";
      rerender();
    }
  });
}
