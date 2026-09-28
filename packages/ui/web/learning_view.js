// Playbook with learning (PM_CONTRACT §6): rules grouped by status with their
// scope, counts, value and evidence, and what Seshat has learned about you.
// Nothing learned takes effect until you approve it; everything is editable.
import { esc, icon, kbd } from "./dom.js";
import { approveRule, dismissEntry, editEntry, editRule, retireRule } from "./learning.js";
import {
  PLAYBOOK_COPY,
  learningMissing,
  playbookCrumb,
  playbookSectionNotes,
  profileHeadingNote,
  retireSentence,
  ruleReach,
  ruleRoleLabel,
} from "./lib/playbook.js";
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
import { formatWait } from "./lib/vocabulary.js";
import { cardChip } from "./marks.js";
import { openPicker } from "./picker.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

function ago(iso) {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const ms = Date.now() - t;
  return ms < 60_000 ? "just now" : `${formatWait(ms)} ago`;
}

function editForm(kind, id, text) {
  return `<form class="lr-edit" data-edit-form="${kind}:${esc(id)}"><textarea rows="3" aria-label="Edit the wording">${esc(text)}</textarea><div class="acts"><button class="btn ghost sm" type="button" data-edit-cancel>Cancel ${kbd("Esc")}</button><button class="btn sm primary" type="submit">Save ${kbd("⌘↵")}</button></div></form>`;
}

function evidenceHtml(list) {
  if (!list?.length) return "";
  const item = (e) =>
    `<li>${e.cardId ? (cardChip(e.cardId) ?? `<span class="mono">${esc(e.cardId)}</span>`) : ""}${e.note ? `<span class="q">“${esc(e.note)}”</span>` : ""}${e.at ? `<span class="sec tnum">${esc(ago(e.at))}</span>` : ""}</li>`;
  const first = list.slice(0, 2).map(item).join("");
  const rest = list.slice(2);
  return `<ul class="lr-ev">${first}</ul>${rest.length ? `<details class="lr-more"><summary>${esc(PLAYBOOK_COPY.moreSignals(rest.length))}</summary><ul class="lr-ev">${rest.map(item).join("")}</ul></details>` : ""}`;
}

function ruleHtml(r, maxAbs, ui) {
  const editing = ui.editing === `rule:${r.id}`;
  const chips = scopeChips(r.scope)
    .map(
      (c) =>
        `<span class="lchip"><span class="sec">${esc(c.label)}:</span> <span class="${c.label === "Files" || c.label === "Error" || c.label === "Kind" ? "mono" : ""}">${esc(c.value)}</span></span>`,
    )
    .join("");
  const vb = valueBar(r.value, maxAbs);
  const value = `<span class="valbar${vb.negative ? " neg" : ""}" role="img" aria-label="${esc(`Value ${r.value.toFixed(2)}`)}"><i style="width:${Math.round(vb.ratio * 100)}%"></i></span><span class="tnum">Value ${esc(r.value.toFixed(1))}</span>`;
  const counts = `<span class="cnt">${icon("check", 12, "ic s12 i-pass")}<span class="tnum">${r.helpful}</span> helpful</span><span class="cnt">${icon("x", 12, "ic s12 i-fail")}<span class="tnum">${r.harmful}</span> harmful</span>`;
  const retire = retireSuggested(r)
    ? `<p class="lr-warn">${icon("alert", 12, "ic s12 i-park")}<span>${esc(retireSentence(r))}</span></p>`
    : "";
  let acts = "";
  if (r.readonly) {
    acts = `<span class="sec small" title="${esc(PLAYBOOK_COPY.seededTitle)}">Edit in <span class="mono">playbook.toml</span></span>`;
  } else if (r.status === "candidate") {
    acts = `<button class="btn sm primary" type="button" data-approve aria-haspopup="dialog">${icon("check", 12, "ic s12")}Approve…</button><button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm ghost" type="button" data-retire>Retire</button>`;
  } else if (r.status === "active") {
    acts = `<button class="btn sm" type="button" data-edit>Edit</button><button class="btn sm ${retireSuggested(r) ? "" : "ghost"}" type="button" data-retire>Retire</button>`;
  }
  const role = ruleRoleLabel(r.role);
  const reach = ruleReach(r.reach);
  const text = editing ? editForm("rule", r.id, r.text) : `<p class="lr-text">${esc(r.text)}</p>`;
  return `<li class="lrule ${esc(r.status)}${retireSuggested(r) ? " warn" : ""}" data-rule-id="${esc(r.id)}"><div class="lr-main"><div class="lr-head"><span class="role">${esc(role)}</span>${r.status === "active" && !r.readonly ? `<span class="role reach${r.reach === "global" ? " global" : ""}" title="${esc(reach.title)}">${esc(reach.label)}</span>` : ""}<span class="sec">${esc(RULE_SOURCE_LABELS[r.source] ?? r.source)}${r.createdAt ? ` · ${esc(ago(r.createdAt))}` : ""}</span></div>${text}<div class="lr-scope">${chips}</div>${r.status === "candidate" || r.unused ? "" : `<div class="lr-meta">${value}${counts}</div>`}${retire}${evidenceHtml(r.evidence)}</div>${editing ? "" : `<div class="lr-acts">${acts}</div>`}</li>`;
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
    : `<p class="sec empty-l">${esc(PLAYBOOK_COPY.profile.empty)}</p>`;
  const gone = dismissed.length
    ? `<details class="lr-more"><summary>${esc(PLAYBOOK_COPY.profile.dismissed(dismissed.length))}</summary><ul class="lrules quiet">${dismissed.map((e) => `<li class="lentry dismissed"><p class="lr-text">${esc(e.statement)}</p></li>`).join("")}</ul></details>`
    : "";
  return `<section id="pb-profile" class="lsec"><h3 class="sh">${esc(PLAYBOOK_COPY.profile.heading)} <span class="sec">${esc(profileHeadingNote(active))}</span></h3><p class="lp-note">${icon("lock", 12, "ic s12")}<span>${esc(PLAYBOOK_COPY.profile.lock)}</span></p>${body}${gone}</section>`;
}

/**
 * The playbook file's seeded rules, shown as active and read-only when the
 * learning store doesn't carry them itself, so nothing already in force hides.
 */
function withSeeds(rules) {
  const seeds = store.state.playbook?.rules ?? [];
  const known = new Set(rules.flatMap((r) => [r.id, r.text]));
  const extra = seeds
    .filter((s) => !known.has(s.id) && !known.has(s.instruction))
    .map((s) => ({
      id: s.id,
      role: "worker",
      text: s.instruction,
      scope: { ...(s.pattern ? { pathPattern: s.pattern } : {}) },
      status: "active",
      helpful: 0,
      harmful: 0,
      value: 0,
      source: "seed",
      evidence: s.originCard ? [{ cardId: s.originCard, note: "" }] : [],
      createdAt: s.effectiveDate ?? "",
      readonly: true,
      unused: true,
    }));
  return [...rules, ...extra];
}

export function learningHtml(data, ui) {
  const rules = withSeeds(data.rules ?? []);
  const g = groupRules(rules);
  const notes = playbookSectionNotes(g);
  const maxAbs = Math.max(1, ...rules.map((r) => Math.abs(r.value || 0)));
  const project = store.state.meta?.project ?? "";
  setTopbar({
    title: "Playbook",
    crumb: playbookCrumb(project, g),
  });
  const list = (items) =>
    `<ul class="lrules">${items.map((r) => ruleHtml(r, maxAbs, ui)).join("")}</ul>`;
  const cand = g.candidate.length
    ? list(g.candidate)
    : `<p class="sec empty-l">${esc(PLAYBOOK_COPY.empty.candidates)}</p>`;
  const active = g.active.length
    ? list(g.active)
    : `<p class="sec empty-l">${esc(PLAYBOOK_COPY.empty.active)}</p>`;
  const retired = g.retired.length
    ? `<details class="lr-more"><summary>${esc(notes.retired)}</summary>${list(g.retired)}</details>`
    : `<p class="sec empty-l">${esc(PLAYBOOK_COPY.empty.retired)}</p>`;
  return `<div class="lp"><p class="lp-lede">${icon("lock", 14, "ic s14")}<span>${esc(PLAYBOOK_COPY.lede)}</span></p>
<section id="pb-candidates" class="lsec"><h3 class="sh">${esc(PLAYBOOK_COPY.headings.candidates)} <span class="sec">${esc(notes.candidates)}</span></h3>${cand}</section>
<section id="pb-active" class="lsec"><h3 class="sh">${esc(PLAYBOOK_COPY.headings.active)} <span class="sec">${esc(notes.active)}</span></h3>${active}</section>
<section id="pb-retired" class="lsec"><h3 class="sh">${esc(PLAYBOOK_COPY.headings.retired)}</h3>${retired}</section>
${profileSectionHtml(data.profile, ui)}</div>`;
}

export function learningMissingHtml(status) {
  // DB-N2-8: the banner's words are the model's (`learningMissing`, lib/playbook.js).
  const m = learningMissing(status);
  const text = `<b>${esc(m.title)}</b> ${m.endpoint ? `<code>${esc(m.endpoint)}</code> ` : ""}${esc(m.detail)}`;
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
    const ap = t.closest("[data-approve]");
    if (ap && rule) {
      openPicker(ap, {
        heading: PLAYBOOK_COPY.approve.heading,
        search: false,
        options: [
          {
            value: "project",
            label: PLAYBOOK_COPY.approve.project.label,
            detail: PLAYBOOK_COPY.approve.project.detail,
            plain: true,
          },
          {
            value: "global",
            label: PLAYBOOK_COPY.approve.global.label,
            detail: PLAYBOOK_COPY.approve.global.detail,
            plain: true,
          },
        ],
        wide: true,
        footer: PLAYBOOK_COPY.approve.footer,
        onPick: (reach) => approveRule(rule, reach),
      });
      return;
    }
    if (t.closest("[data-retire]") && rule) retireRule(rule);
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
