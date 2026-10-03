// Quick create (dashboard §2.4.7, DB-P3-12): `c` or a column's `+` opens this
// form. It posts a create proposal to Seshat's thread (`POST /api/pm/create-card`);
// applied there, the card goes through the planner pipeline. Every word is
// the pure module's (`lib/create.js`).
import { esc, getJSON, icon, postJSON } from "./dom.js";
import { noteFor } from "./level_gate.js";
import { NEW_ISSUE_TYPES, QUICK_CREATE_COPY as T, quickCreateRequest } from "./lib/create.js";
import { TRIAGE_COPY } from "./lib/intake.js";
import { PRIORITY_LABELS, PRIORITY_ORDER, assigneeLabel } from "./lib/pm.js";
import { ISSUE_TYPE_LABELS } from "./lib/vocabulary.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { loadThread } from "./pm_client.js";
import { togglePmPanel } from "./pm_panel.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

let open = null;

/**
 * The issue's properties as pills (NEW-dashboard-15, DB-N15-1): the type in
 * DEC-31's words, then priority, sprint and assignee menus and the labels.
 */
function propsHtml({ forTriage = false } = {}) {
  const s = store.state;
  const types = NEW_ISSUE_TYPES.map(
    (t, i) =>
      `<label class="qc-pill"><input type="radio" name="type" value="${t}"${i === 0 ? " checked" : ""}><span title="${esc(ISSUE_TYPE_LABELS[t].tooltip)}">${esc(ISSUE_TYPE_LABELS[t].label)}</span></label>`,
  ).join("");
  const prio = PRIORITY_ORDER.slice()
    .sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : 0))
    .map((p) => `<option value="${p}">${esc(PRIORITY_LABELS[p])}</option>`)
    .join("");
  const cycles = (s.cycles ?? [])
    .filter((c) => c.state !== "closed")
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const people = new Set(["human"]);
  for (const c of s.cards ?? []) if (c.assignee && c.assignee !== "worker") people.add(c.assignee);
  const who = [...people, "worker"]
    .map((a) => `<option value="${esc(a)}">${esc(assigneeLabel(a))}</option>`)
    .join("");
  const sel = (name, label, opts) =>
    `<label class="qc-pill qc-sel"><span>${esc(label)}</span><select name="${name}" aria-label="${esc(label)}">${opts}</select></label>`;
  // DB-N10-1: a person who files for triage chooses the type and labels; a
  // Member triages, then sets priority, sprint and assignee.
  const props = forTriage
    ? ""
    : `<div class="qc-props">${sel("priority", T.priority, prio)}${sel("cycleId", T.sprint, `<option value="">${esc(T.noSprint)}</option>${cycles}`)}${sel("assignee", T.assignee, `<option value="">${esc(T.unassigned)}</option>${who}`)}</div>`;
  return `<fieldset class="qc-types"><legend>${esc(T.type)}</legend>${types}</fieldset>
${props}
<label class="qc-f" for="qc-labels">${esc(T.labels)}</label>
<input id="qc-labels" name="labels" type="text" autocomplete="off" aria-describedby="qc-labels-hint">
<p class="qc-hint" id="qc-labels-hint">${esc(T.labelsHint)}</p>`;
}

/**
 * A repository issue form's fields for the chosen type (DB-N15-3). The form is
 * repository text: its labels and options are escaped and shown, never run.
 */
function formHtml(form) {
  const fields = form.fields
    .map((f, i) => {
      const id = `qc-if-${i}`;
      const req = f.required ? " required" : "";
      const label = `<label class="qc-f" for="${id}">${esc(f.label)}</label>`;
      if (f.kind === "dropdown") {
        const opts = (f.options ?? [])
          .map((o) => `<option value="${esc(o)}">${esc(o)}</option>`)
          .join("");
        return `${label}<select id="${id}" data-if="${i}"${req}><option value=""></option>${opts}</select>`;
      }
      return f.kind === "textarea"
        ? `${label}<textarea id="${id}" data-if="${i}" rows="3"${req}></textarea>`
        : `${label}<input id="${id}" data-if="${i}" type="text" autocomplete="off"${req}>`;
    })
    .join("");
  return `<legend>${esc(form.name)}</legend>${fields}`;
}

/** The form's answers as the issue's text, each under its label. */
function formAnswers(node, form) {
  const lines = [];
  for (const [i, f] of form.fields.entries()) {
    const v = node.querySelector(`[data-if="${i}"]`)?.value.trim() ?? "";
    if (v) lines.push(`${f.label}: ${v}`);
  }
  return lines.join("\n");
}

/** A Bug's reproduction (DB-N15-2): shown only while the type is Bug. */
function reproHtml() {
  return `<fieldset class="qc-repro" hidden><legend>${esc(T.reproduction)}</legend>
<p class="qc-hint">${esc(T.reproductionHint)}</p>
<label class="qc-f" for="qc-happened">${esc(T.happened)}</label><textarea id="qc-happened" name="happened" rows="2"></textarea>
<label class="qc-f" for="qc-expected">${esc(T.expected)}</label><textarea id="qc-expected" name="expected" rows="2"></textarea>
<label class="qc-f" for="qc-steps">${esc(T.steps)}</label><textarea id="qc-steps" name="steps" rows="3"></textarea>
<label class="qc-f" for="qc-release">${esc(T.release)}</label><input id="qc-release" name="release" type="text" list="qc-tags" autocomplete="off" placeholder="${esc(T.noRelease)}"><datalist id="qc-tags"></datalist>
</fieldset>`;
}

export function closeCreate() {
  if (!open) return;
  const { node, remove, invoker } = open;
  open = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

/**
 * Open the form. `epicId` is the epic the board is filtered to, when there is
 * exactly one, so the card lands under it.
 */
export function openCreate({ epicId } = {}) {
  if (open) return;
  // DB-N9-17: a person who may not file is told who can instead (the server refuses too).
  const projectId = store.state.project?.id;
  const note = noteFor("issue.file", projectId);
  if (note) {
    toast({ tone: "parked", text: note });
    return;
  }
  // DB-N10-1: below Member, the same form files the issue for triage
  // through `issue.file`, with the project lead as its assignee.
  const forTriage = Boolean(noteFor("issue.create", projectId)) && Boolean(projectId);
  const node = document.createElement("div");
  node.className = "scrim";
  node.innerHTML = `<form class="dialog qc" role="dialog" aria-modal="true" aria-labelledby="qc-h" aria-describedby="qc-note" novalidate>
<header><h2 id="qc-h">${esc(T.heading)}</h2><button class="icon-btn" type="button" data-close aria-label="${esc(`${T.cancel} (Esc)`)}">${icon("x")}</button></header>
<label class="qc-f" for="qc-title">${esc(T.title)}</label>
<input id="qc-title" name="title" type="text" autocomplete="off" spellcheck="true" maxlength="300" required aria-describedby="qc-err">
<label class="qc-f" for="qc-desc">${esc(T.description)}</label>
<textarea id="qc-desc" name="description" rows="4" aria-describedby="qc-hint"></textarea>
<p class="qc-hint" id="qc-hint">${esc(T.descriptionHint)}</p>
${propsHtml({ forTriage })}
${reproHtml()}
<fieldset class="qc-repro qc-form" hidden></fieldset>
<p class="qc-err" id="qc-err" role="alert"></p>
<p class="qc-note" id="qc-note">${icon(forTriage ? "inbox" : "chat", 12, "ic s12")}<span>${esc(forTriage ? TRIAGE_COPY.filedForTriage : T.note)}</span></p>
<footer><button class="btn ghost" type="button" data-close>${esc(T.cancel)}</button><button class="btn primary" type="submit">${esc(forTriage ? TRIAGE_COPY.fileSubmit : T.submit)}</button></footer>
</form>`;
  document.getElementById("overlay-root").append(node);
  const form = node.querySelector("form");
  const title = node.querySelector("#qc-title");
  const err = node.querySelector("#qc-err");
  const submit = node.querySelector('button[type="submit"]');
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "create",
    modal: true,
    node,
    close: () => closeCreate(),
    onKey: (e) => trapFocus(node, e),
  });
  open = { node, remove, invoker };
  node.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.target === node || t?.closest("[data-close]")) closeCreate();
  });
  // A Bug asks how to see it, or the repository's form for the type does
  // (DB-N15-3); the tagged releases fill the Release list.
  const repro = node.querySelector(".qc-repro:not(.qc-form)");
  const formBox = node.querySelector(".qc-form");
  let forms = [];
  let active = null;
  const showType = () => {
    const type = form.elements.type.value;
    active = forms.find((f) => f.type === type) ?? null;
    formBox.hidden = !active;
    formBox.innerHTML = active ? formHtml(active) : "";
    repro.hidden = type !== "bug" || Boolean(active);
  };
  form.addEventListener("change", (e) => {
    if (e.target?.name === "type") showType();
  });
  getJSON("/api/issue-forms").then((r) => {
    forms = r.ok ? (r.data?.forms ?? []) : [];
    if (forms.length) showType();
  });
  getJSON("/api/releases/tags").then((r) => {
    const list = node.querySelector("#qc-tags");
    for (const tag of r.ok ? (r.data?.tags ?? []) : []) {
      const o = document.createElement("option");
      o.value = tag;
      list?.append(o);
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const missing = active?.fields.find(
      (x, i) => x.required && !node.querySelector(`[data-if="${i}"]`)?.value.trim(),
    );
    if (missing) {
      err.textContent = `Fill in “${missing.label}”.`;
      return;
    }
    const description = [
      node.querySelector("#qc-desc").value.trim(),
      active ? formAnswers(node, active) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const asked = quickCreateRequest({
      title: title.value,
      description,
      type: f.type.value,
      ...(!forTriage && Number(f.priority.value) ? { priority: Number(f.priority.value) } : {}),
      labels: f.labels.value.split(","),
      ...(forTriage ? {} : { cycleId: f.cycleId.value, assignee: f.assignee.value }),
      reproduction: active
        ? {}
        : {
            happened: f.happened.value,
            expected: f.expected.value,
            steps: f.steps.value,
            release: f.release.value,
          },
      ...(epicId ? { epicId } : {}),
      // The project the board is scoped to: the card lands there, and a Team
      // checks the permission there (DB-P3-12).
      projectId: store.state.project?.id ?? null,
    });
    if (!asked.ok) {
      err.textContent = asked.error;
      title.setAttribute("aria-invalid", "true");
      title.focus();
      return;
    }
    submit.disabled = true;
    const r = await postJSON(
      forTriage ? `/api/projects/${encodeURIComponent(projectId)}/cards` : "/api/pm/create-card",
      asked.body,
    );
    submit.disabled = false;
    if (!r.ok) {
      err.textContent = r.data?.error ?? `The server returned ${r.status || "no response"}.`;
      return;
    }
    closeCreate();
    if (forTriage) {
      toast({ tone: "info", text: TRIAGE_COPY.filed });
      window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
      return;
    }
    // The proposal waits in Seshat's thread for Apply.
    await loadThread();
    togglePmPanel(true);
    toast({ tone: "info", text: T.sent });
  });
  title.focus();
}
