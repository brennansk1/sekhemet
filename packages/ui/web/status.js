// Status (dashboard §2.8, DB-P5-1, DB-P5-2, DB-N9-1..8; DEC-37): the project
// page for the stakeholder and the team, from the same data. Every word and
// number is the pure model's (`lib/status.js`); this fetches its inputs, draws
// the sections in §2.8's order and carries out a person's presses. Nothing
// here changes the project without one: a risk's suggestion is applied where
// it lives, and the weekly update is posted only by *Post*.
import { burnupHtml, loadBurnup } from "./burnup.js";
import { $, announce, esc, getJSON, icon, postJSON } from "./dom.js";
import { aiBadge } from "./issue_view.js";
import { viewerManagesWork } from "./learn.js";
import { noteFor } from "./level_gate.js";
import { burnupTarget } from "./lib/burnup.js";
import { START_COPY, START_ROUTE } from "./lib/start.js";
import { STATUS_COPY, STATUS_SECTIONS, statusModel } from "./lib/status.js";
import { sendMessage } from "./pm_client.js";
import { togglePmPanel } from "./pm_panel.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";
import { store, triageBlocker } from "./store.js";
import { toast } from "./toast.js";

const C = STATUS_COPY;
const REFRESH_MS = 60_000;
const ui = {
  root: null,
  last: "",
  facts: { status: 0, data: null },
  map: null,
  standup: null,
  signals: null,
  standing: null,
  burn: null,
  /** The update editor: null, or { loading, text, error }. */
  editor: null,
  /** The release whose Extend form is open. */
  extend: null,
  /** The Set health picker is open (TEAM-28). */
  health: false,
  /** The Set target date form is open (DB-N9-3). */
  target: false,
  /** The Set release lead form is open (teams item 28, DB-N9-2). */
  releaseLead: false,
  busy: false,
  timer: 0,
  off: null,
};

const projectQuery = () => {
  const id = store.state.project?.id;
  return id ? `?project=${encodeURIComponent(id)}` : "";
};

async function json(path) {
  try {
    const r = await getJSON(path);
    return { status: r.status, data: r.ok ? r.data : null };
  } catch {
    return { status: -1, data: null };
  }
}

async function load() {
  const id = store.state.project?.id;
  const [facts, map, standup, signals, standing] = await Promise.all([
    json(`/api/status${projectQuery()}`),
    json(`/api/story-map${id ? `/${encodeURIComponent(id)}` : ""}`),
    json("/api/standup"),
    // The project's own signals, scoped by the server to what the person can see (PM-N9-8).
    json(`/api/signals${projectQuery()}`),
    json("/api/queue/standing"),
  ]);
  ui.facts = { status: facts.status, data: facts.data?.facts ?? null };
  ui.map = map.data;
  ui.standup = standup.data;
  ui.signals = signals.data?.signals ?? null;
  ui.standing = standing.data?.entries ?? null;
  render();
  // The burn-up once the forecast is known: its band is the model's. The forecast is
  // the project's, so the chart is too — never a sprint's, whose scope the band would miss.
  const target = burnupTarget(
    [],
    { terms: [], text: "" },
    Date.now(),
    store.state.project?.id,
    store.state.estimation,
  );
  ui.burn = await loadBurnup(target.url);
  render();
}

function model() {
  const s = store.state;
  const me = getSession()?.principal;
  return statusModel({
    now: Date.now(),
    ...(me ? { me } : {}),
    facts: ui.facts.data,
    cards: s.cards,
    cycles: s.cycles,
    storyMap: ui.map,
    standup: ui.standup,
    signals: ui.signals,
    standing: ui.standing,
    managesWork: viewerManagesWork(),
  });
}

/* ---------- Sections ---------- */

// Each section names its place in the wide grid (NEW-dashboard-18); the DOM
// order, and so the reading order, stays §2.8's.
const section = (id, body, extra = "") => {
  const s = STATUS_SECTIONS.find((x) => x.id === id);
  return `<section class="stp-sec stp-a-${id}" aria-labelledby="stp-h-${id}"${extra}><h2 id="stp-h-${id}" tabindex="-1">${esc(s?.heading ?? id)}</h2>${body}</section>`;
};

const empty = (text) => `<p class="sec stp-empty">${esc(text)}</p>`;

const toneDot = (tone) =>
  `<span class="stp-dot${tone ? ` t-${esc(tone)}` : ""}" aria-hidden="true"></span>`;

/**
 * DB-N9-17: a header action the viewer's level does not allow — disabled,
 * marked with the permission it needs, so the level gate writes beside it
 * the level they hold and one that can. Never hidden. Nothing when the page
 * finds no note to write (the server's word decides; it refuses the write).
 */
function gatedButton(permission, label, ghost = false) {
  const p = ui.facts.data?.project;
  if (!permission || !p?.id || !noteFor(permission, p.id, p.name)) return "";
  return `<button class="btn sm${ghost ? " ghost" : ""}" type="button" disabled data-needs="${esc(permission)}" data-needs-project="${esc(p.id)}" data-needs-project-name="${esc(p.name ?? "")}">${esc(label)}</button>`;
}

function headerHtml(v) {
  const health = v.health
    ? `<p class="stp-health">${toneDot(v.health.tone)}<span>${esc(v.health.text)}</span></p>`
    : "";
  const setHealth =
    v.setHealth && !ui.health
      ? `<button class="btn sm" type="button" data-set-health aria-expanded="false">${esc(C.setHealth)}</button>`
      : v.setHealth
        ? ""
        : gatedButton(v.gated.health, C.setHealth);
  const target = v.target ? `<p class="stp-by sec">${esc(v.target)}</p>` : "";
  const setTarget =
    v.setTarget && !ui.target
      ? `<button class="btn sm ghost" type="button" data-set-target aria-expanded="false">${esc(v.setTarget.date ? C.changeTarget : C.setTarget)}</button>`
      : v.setTarget
        ? ""
        : gatedButton(v.gated.target, C.setTarget, true);
  const missing = v.updateMissing
    ? `<p class="stp-missing" role="status">${icon("clock", 14, "ic s14")}${esc(v.updateMissing)}</p>`
    : "";
  const update = v.update
    ? `<article class="stp-update" aria-label="Latest project update"><p class="stp-by sec">${esc(v.update.byline)}</p><div class="stp-text">${esc(v.update.text)}</div></article>`
    : "";
  const write =
    v.writeUpdate && !ui.editor
      ? `<button class="btn sm" type="button" data-write>${icon("pencil", 14, "ic s14")}${esc(C.writeUpdate)}</button>`
      : v.writeUpdate
        ? ""
        : gatedButton(v.gated.update, C.writeUpdate);
  // Teams item 28: the current release's lead, and naming one (the project lead or an Admin).
  const releaseLead = v.releaseLead ? `<p class="stp-by sec">${esc(v.releaseLead)}</p>` : "";
  const setReleaseLead =
    v.setReleaseLead && !ui.releaseLead
      ? `<button class="btn sm ghost" type="button" data-set-release-lead aria-expanded="false">${esc(v.setReleaseLead.lead ? C.changeReleaseLead : C.setReleaseLead)}</button>`
      : v.setReleaseLead
        ? ""
        : gatedButton(v.gated.releaseLead, C.setReleaseLead, true);
  const leadRow =
    releaseLead || setReleaseLead
      ? `<div class="stp-row">${releaseLead}${setReleaseLead}</div>`
      : "";
  // DS-N7-2: on a phone New project is at the top of Status, not only at its foot.
  const newProject = noteFor("project.create")
    ? ""
    : `<a class="btn sm stp-new" href="${START_ROUTE}" data-new-project>${icon("plus", 14, "ic s14")}${esc(START_COPY.title)}</a>`;
  return `<header class="stp-head">${newProject}<p class="stp-headline">${esc(v.headline)}</p><div class="stp-row">${health}${setHealth}${write}</div>${healthFormHtml(v)}${target || setTarget ? `<div class="stp-row">${target}${setTarget}</div>` : ""}${targetFormHtml(v)}${leadRow}${releaseLeadFormHtml(v)}${missing}${editorHtml()}${update}</header>`;
}

/** The lead's health call (TEAM-28): three words, one checked; nothing changes until Save. */
function healthFormHtml(v) {
  if (!ui.health || !v.setHealth) return "";
  const radios = v.healthChoices
    .map(
      (c) =>
        `<label class="stp-choice"><input type="radio" name="health" value="${esc(c.value)}"${c.checked ? " checked" : ""}> ${esc(c.label)}</label>`,
    )
    .join("");
  return `<form class="stp-editor" data-health><fieldset aria-describedby="stp-health-hint"><legend>${esc(C.healthLegend)}</legend><p class="sec" id="stp-health-hint">${esc(C.healthHint)}</p>${radios}</fieldset><div class="acts"><button class="btn ghost" type="button" data-cancel-health>${esc(C.cancel)}</button><button class="btn" type="submit"${ui.busy ? " disabled" : ""}>${esc(C.save)}</button></div></form>`;
}

/** Name the current release's lead (teams item 28): a Member or an Admin of the project, or no one. */
function releaseLeadFormHtml(v) {
  if (!ui.releaseLead || !v.setReleaseLead) return "";
  const t = v.setReleaseLead;
  const options = [
    `<option value=""${t.lead ? "" : " selected"}>${esc(C.noReleaseLead)}</option>`,
    ...t.choices.map(
      (c) =>
        `<option value="${esc(c.principal)}"${c.principal === t.lead ? " selected" : ""}>${esc(c.name)}</option>`,
    ),
  ].join("");
  return `<form class="stp-editor" data-release-lead="${esc(t.release)}"><label for="stp-release-lead">${esc(C.releaseLeadLabel)}: ${esc(t.name)}</label><p class="sec" id="stp-release-lead-hint">${esc(C.releaseLeadHint)}</p><select id="stp-release-lead" aria-describedby="stp-release-lead-hint">${options}</select><div class="acts"><button class="btn ghost" type="button" data-cancel-release-lead>${esc(C.cancel)}</button><button class="btn" type="submit"${ui.busy ? " disabled" : ""}>${esc(C.save)}</button></div></form>`;
}

/** The current release's target date (DB-N9-3): a day, drawn against the forecast range. */
function targetFormHtml(v) {
  if (!ui.target || !v.setTarget) return "";
  const t = v.setTarget;
  const clear = t.date
    ? `<button class="btn ghost" type="button" data-clear-target>${esc(C.clearTarget)}</button>`
    : "";
  return `<form class="stp-editor" data-target="${esc(t.release)}"><label for="stp-target">${esc(C.targetLabel)}: ${esc(t.name)}</label><p class="sec" id="stp-target-hint">${esc(C.targetHint)}</p><input type="date" id="stp-target" required value="${esc(t.date ?? "")}" aria-describedby="stp-target-hint"><div class="acts"><button class="btn ghost" type="button" data-cancel-target>${esc(C.cancel)}</button>${clear}<button class="btn" type="submit"${ui.busy ? " disabled" : ""}>${esc(C.save)}</button></div></form>`;
}

function editorHtml() {
  const e = ui.editor;
  if (!e) return "";
  if (e.loading) return `<p class="sec stp-editor" role="status">${esc(C.loadingDraft)}</p>`;
  return `<form class="stp-editor" data-editor><label for="stp-update">${esc(C.updateLabel)}</label><p class="sec" id="stp-update-hint">${esc(C.updateHint)}</p><textarea id="stp-update" rows="12" aria-describedby="stp-update-hint">${esc(e.text)}</textarea>${e.error ? `<p class="err" role="alert">${esc(e.error)}</p>` : ""}<div class="acts"><button class="btn ghost" type="button" data-cancel>${esc(C.cancel)}</button><button class="btn" type="submit"${ui.busy ? " disabled" : ""}>${icon("send", 14, "ic s14")}${esc(C.post)}</button></div></form>`;
}

function numbersHtml(v) {
  const items = v.numbers
    .map((n) => {
      const value = n.jump
        ? // A11Y-06: the number's button says what it counts and where it goes.
          `<button class="link-btn stp-v tnum" type="button" data-jump="${esc(n.jump)}" aria-label="${esc(`${n.label}: ${n.value}. Show them`)}">${esc(n.value)}</button>`
        : `<span class="stp-v tnum">${esc(n.value)}</span>`;
      return `<div class="stp-num"><dt>${esc(n.label)}</dt><dd>${value}${n.detail ? `<span class="sec stp-d">${esc(n.detail)}</span>` : ""}</dd></div>`;
    })
    .join("");
  return `<dl class="stp-nums">${items}</dl>${v.appetite ? `<p class="sec">${esc(v.appetite)}</p>` : ""}`;
}

function blockedReason() {
  const b = triageBlocker(store.state);
  return b === "offline" ? "Offline" : b === "readonly" ? "Read-only" : "";
}

function buttonHtml(b) {
  if (b.href) return `<a class="btn sm" href="${esc(b.href)}">${esc(b.label)}</a>`;
  const why = blockedReason();
  const data = `data-act="${esc(b.act)}" data-id="${esc(b.id ?? "")}"${b.ids ? ` data-ids="${esc(b.ids.join(","))}"` : ""}${b.cards ? ` data-cards="${b.cards}"` : ""}${b.card ? ` data-card="${esc(b.card)}"` : ""}`;
  return `<button class="btn sm" type="button" ${data}${why ? " disabled" : ""}>${esc(b.label)}</button>${why ? `<span class="why sec">${esc(why)}</span>` : ""}`;
}

function extendForm(item) {
  const b = item.buttons.find((x) => x.act === "slice-extend");
  if (!b || ui.extend !== b.id) return "";
  const min = (b.cards ?? 0) + 1;
  return `<form class="stp-extend" data-extend="${esc(b.id)}"><label for="stp-extend-n">${esc(C.extendLabel)}</label><input id="stp-extend-n" type="number" min="${min}" value="${min}" required><button class="btn sm" type="submit">${esc(C.save)}</button><button class="btn ghost sm" type="button" data-cancel-extend>${esc(C.cancel)}</button></form>`;
}

function needsHtml(v) {
  if (!v.needsYou.items.length) return empty(v.needsYou.empty);
  return `<ul class="stp-list">${v.needsYou.items
    .map(
      (i) =>
        `<li><span>${esc(i.text)}</span><span class="stp-acts">${i.buttons.map(buttonHtml).join("")}</span>${extendForm(i)}</li>`,
    )
    .join("")}</ul>`;
}

const list = (items, emptyText) =>
  items.length
    ? `<ul class="stp-list">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`
    : empty(emptyText);

/** By release, each with the count its key number uses (STA-01), then by MoSCoW group. */
function requirementsHtml(v) {
  if (v.requirements.empty) return empty(v.requirements.empty);
  return v.requirements.releases
    .map(
      (rel) =>
        `<div class="stp-release${rel.current ? " current" : ""}"><h3>${esc(rel.name)} <span class="sec">${esc(rel.summary)}</span></h3>${rel.groups
          .map(
            (g) =>
              `<div class="stp-group"><h4>${esc(g.label)} <span class="sec">${esc(g.summary)}</span></h4><ul class="stp-list">${g.rows
                .map(
                  (r) =>
                    `<li><span>${esc(r.title)}</span><span class="stp-state">${toneDot(r.tone)}${esc(r.label)}</span></li>`,
                )
                .join("")}</ul></div>`,
          )
          .join("")}</div>`,
    )
    .join("");
}

function risksHtml(v) {
  if (!v.risks.items.length) return empty(v.risks.empty);
  return `<ul class="stp-list stp-risks">${v.risks.items
    .map(
      (r) =>
        `<li><p>${esc(r.sentence)}</p><p class="sec"><b>Suggested:</b> ${esc(r.suggested)} <b>Why:</b> ${esc(r.why)}</p>${r.action ? `<a class="btn sm" href="${esc(r.action.href)}">${esc(r.action.label)}</a>` : ""}</li>`,
    )
    .join("")}</ul>`;
}

function workingHtml(v) {
  if (!v.working.rows.length) return empty(v.working.empty);
  return `<ul class="stp-list">${v.working.rows
    .map(
      (r) =>
        `<li><span class="stp-who">${esc(r.who)}${r.ai ? aiBadge() : ""}</span><span>${esc(r.item)}</span></li>`,
    )
    .join("")}</ul>`;
}

function flowHtml(v) {
  return `<ul class="stp-flow">${v.flow.items
    .map(
      (f) =>
        `<li><a href="${esc(f.href)}"><span class="sec">${esc(f.label)}</span><span class="stp-v tnum">${esc(f.value)}</span></a></li>`,
    )
    .join("")}</ul>${v.flow.note ? `<p class="sec">${esc(v.flow.note)}</p>` : ""}`;
}

function askHtml() {
  // STA-10: an empty question is refused beside the box, never silently dropped.
  return `<form class="stp-ask" data-ask novalidate><label class="sr-only" for="stp-ask-q">${esc(C.askLabel)}</label><input id="stp-ask-q" autocomplete="off" aria-describedby="stp-ask-note" placeholder="${esc(C.askPlaceholder)}"><button class="btn" type="submit">${icon("chat", 14, "ic s14")}${esc(C.ask)}</button></form><button class="btn primary stp-start" type="button" data-start>${icon("plus", 14, "ic s14")}${esc(C.startProject)}</button><p class="why sec" id="stp-ask-note" role="status" data-ask-note></p>`;
}

function render() {
  if (!ui.root) return;
  const v = model();
  const facts = ui.facts.data;
  setTopbar({ title: C.title, crumb: facts?.project?.name ?? "" });
  let html;
  if (ui.facts.status === 0) {
    html = '<div class="sk" style="height:200px"></div>';
  } else {
    const notice =
      ui.facts.status === 404
        ? `<p class="stp-notice" role="status"><b>${esc(C.notOnServer)}</b> <span class="sec">${esc(C.notOnServerDetail)}</span></p>`
        : ui.facts.status !== 200
          ? `<p class="stp-notice" role="alert"><b>${esc(C.loadFailed)}</b> <span class="sec">${esc(C.loadFailedDetail)}</span> <button class="btn sm" type="button" data-reload>${icon("refresh", 14, "ic s14")}${esc(C.tryAgain)}</button></p>`
          : "";
    // In the wide grid the burn-up takes two of three columns (NEW-dashboard-18).
    const avail = (ui.root.clientWidth || 900) - 32;
    const wide = window.matchMedia?.("(min-width: 1280px)").matches ?? false;
    const width = wide
      ? Math.max(320, Math.floor(((avail - 48) * 2) / 3) + 24)
      : Math.min(900, Math.max(320, avail));
    html = [
      notice,
      headerHtml(v),
      section("numbers", numbersHtml(v)),
      section("burnup", burnupHtml(ui.burn, width, v.forecast)),
      section("needs", needsHtml(v)),
      v.waiting ? section("waiting", list(v.waiting.items, v.waiting.empty)) : "",
      section("requirements", requirementsHtml(v)),
      section("risks", risksHtml(v)),
      section("done", list(v.doneThisWeek.items, v.doneThisWeek.empty)),
      section("today", list(v.standup.lines, v.standup.empty)),
      section("working", workingHtml(v)),
      section("models", `<p>${esc(v.models)}</p>`),
      section("flow", flowHtml(v)),
      section("ask", askHtml()),
    ].join("");
  }
  if (html === ui.last) return;
  // Keep focus and a half-typed question or update across a re-render.
  const active = document.activeElement;
  const focus = active && ui.root.contains(active) ? focusKey(active) : "";
  const draft = $("#stp-update", ui.root)?.value;
  const ask = $("#stp-ask-q", ui.root)?.value;
  ui.last = html;
  $(".stp", ui.root).innerHTML = html;
  if (draft !== undefined && ui.editor && !ui.editor.loading) {
    const ta = $("#stp-update", ui.root);
    if (ta) ta.value = draft;
  }
  if (ask) {
    const q = $("#stp-ask-q", ui.root);
    if (q) q.value = ask;
  }
  if (focus) $(focus, ui.root)?.focus({ preventScroll: true });
}

/** A selector that finds the same control after a re-render (a live frame never steals focus). */
function focusKey(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const data = Object.entries(el.dataset)
    .map(
      ([k, v]) => `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${CSS.escape(v)}"]`,
    )
    .join("");
  if (data) return `${el.tagName.toLowerCase()}${data}`;
  const href = el.getAttribute("href");
  return href ? `a[href="${CSS.escape(href)}"]` : "";
}

/* ---------- A person's presses ---------- */

function fail(what, r) {
  toast({
    tone: "fail",
    text: `Couldn't ${what}.`,
    detail: r.data?.error ?? `The server returned ${r.status || "no response"}.`,
  });
}

function refreshAll() {
  window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
  load();
}

async function openEditor() {
  const id = ui.facts.data?.project?.id;
  if (!id) return;
  ui.editor = { loading: true, text: "", error: "" };
  render();
  const r = await json(`/api/pm/update-draft?project=${encodeURIComponent(id)}`);
  ui.editor = { loading: false, text: r.data?.draft?.text ?? "", error: "" };
  if (!r.data)
    ui.editor.error = `Seshat couldn't draft it (the server returned ${r.status}). Write it here.`;
  render();
  $("#stp-update", ui.root)?.focus();
}

function closeEditor() {
  ui.editor = null;
  render();
  $("[data-write]", ui.root)?.focus();
}

async function postUpdate() {
  const id = ui.facts.data?.project?.id;
  const text = $("#stp-update", ui.root)?.value ?? "";
  if (!id || ui.busy) return;
  if (!text.trim()) {
    ui.editor = { loading: false, text, error: "An update needs its text." };
    render();
    return;
  }
  ui.busy = true;
  const r = await postJSON(`/api/projects/${encodeURIComponent(id)}/update`, { text });
  ui.busy = false;
  if (!r.ok) {
    ui.editor = {
      loading: false,
      text,
      error: r.data?.error ?? `The server returned ${r.status}.`,
    };
    render();
    return;
  }
  ui.editor = null;
  toast({ tone: "pass", text: C.posted });
  announce(C.posted);
  await load();
  $("[data-write]", ui.root)?.focus();
}

function openHealth() {
  ui.health = true;
  render();
  (
    $('[data-health] input[name="health"]:checked', ui.root) ?? $("[data-health] input", ui.root)
  )?.focus();
}

function closeHealth() {
  ui.health = false;
  render();
  $("[data-set-health]", ui.root)?.focus();
}

async function saveHealth(form) {
  const id = ui.facts.data?.project?.id;
  const health = form.querySelector('input[name="health"]:checked')?.value;
  if (!id || !health || ui.busy) return;
  ui.busy = true;
  const r = await postJSON(`/api/projects/${encodeURIComponent(id)}/health`, { health });
  ui.busy = false;
  if (!r.ok) {
    fail("set the health", r);
    return;
  }
  ui.health = false;
  toast({ tone: "pass", text: C.healthSaved });
  announce(C.healthSaved);
  await load();
  $("[data-set-health]", ui.root)?.focus();
}

function openTarget() {
  ui.target = true;
  render();
  $("#stp-target", ui.root)?.focus();
}

function closeTarget() {
  ui.target = false;
  render();
  $("[data-set-target]", ui.root)?.focus();
}

async function saveTarget(release, date) {
  if (!release || ui.busy) return;
  ui.busy = true;
  const r = await postJSON(`/api/slices/${encodeURIComponent(release)}/target`, { date });
  ui.busy = false;
  if (!r.ok) {
    fail(date ? "set the target date" : "clear the target date", r);
    return;
  }
  ui.target = false;
  const said = date ? C.targetSaved : C.targetCleared;
  toast({ tone: "pass", text: said });
  announce(said);
  await load();
  $("[data-set-target]", ui.root)?.focus();
}

function openReleaseLead() {
  ui.releaseLead = true;
  render();
  $("#stp-release-lead", ui.root)?.focus();
}

function closeReleaseLead() {
  ui.releaseLead = false;
  render();
  $("[data-set-release-lead]", ui.root)?.focus();
}

async function saveReleaseLead(release, lead) {
  if (!release || ui.busy) return;
  ui.busy = true;
  const r = await postJSON(`/api/slices/${encodeURIComponent(release)}/lead`, { lead });
  ui.busy = false;
  if (!r.ok) {
    fail(lead ? "set the release lead" : "clear the release lead", r);
    return;
  }
  ui.releaseLead = false;
  const said = lead ? C.releaseLeadSaved : C.releaseLeadCleared;
  toast({ tone: "pass", text: said });
  announce(said);
  await load();
  $("[data-set-release-lead]", ui.root)?.focus();
}

async function act(btn) {
  const { act: kind, id } = btn.dataset;
  if (kind === "slice-extend") {
    ui.extend = id;
    render();
    $("#stp-extend-n", ui.root)?.focus();
    return;
  }
  btn.disabled = true;
  if (kind === "unpark") {
    const r = await postJSON(`/api/cards/${encodeURIComponent(id)}/unpark`, {});
    if (r.ok) toast({ tone: "pass", text: "Taken off hold. It is back where it was." });
    else fail("take it off hold", r);
  } else if (kind === "agent-start" || kind === "agent-decline") {
    // TEAM-39: a Member starts the Agent on the request, on their own behalf, or declines it.
    const card = btn.dataset.card ?? "";
    const verb = kind === "agent-start" ? "start" : "decline";
    const r = await postJSON(
      `/api/cards/${encodeURIComponent(card)}/agent-requests/${encodeURIComponent(id)}/${verb}`,
      {},
    );
    if (r.ok)
      toast({
        tone: "pass",
        text: verb === "start" ? "The Agent is on it, on your behalf." : "Request declined.",
      });
    else fail(verb === "start" ? "start the Agent" : "decline the request", r);
  } else if (kind === "slice-accept") {
    const r = await postJSON(`/api/slices/${encodeURIComponent(id)}/accept`, {});
    if (r.ok) toast({ tone: "pass", text: "Release accepted." });
    else fail("accept the release", r);
  } else if (kind === "slice-cut") {
    const ids = (btn.dataset.ids ?? "").split(",").filter(Boolean);
    let moved = 0;
    for (const req of ids) {
      const r = await postJSON(`/api/requirements/${encodeURIComponent(req)}/cut`, {
        reason: "Moved to Later from Status",
      });
      if (!r.ok) {
        fail(`move every requirement to Later (${moved} of ${ids.length} moved)`, r);
        break;
      }
      moved++;
    }
    if (moved === ids.length)
      toast({
        tone: "pass",
        text: `Moved ${moved} ${moved === 1 ? "requirement" : "requirements"} to Later.`,
      });
  }
  refreshAll();
}

async function extend(form) {
  const id = form.dataset.extend;
  const cards = Number($("#stp-extend-n", form)?.value);
  const r = await postJSON(`/api/slices/${encodeURIComponent(id)}/extend`, { cards });
  if (!r.ok) {
    fail("extend the release", r);
    return;
  }
  ui.extend = null;
  toast({ tone: "pass", text: `Size limit raised to ${cards} issues.` });
  refreshAll();
}

/** Seshat, one step away: the panel, or on a phone the full view (§2.7.1, `pm_panel.js`). */
function openSeshat() {
  togglePmPanel(true);
}

async function ask(form) {
  const input = $("#stp-ask-q", form);
  const text = input?.value.trim();
  const note = $("[data-ask-note]", ui.root);
  if (!text) {
    if (note) note.textContent = C.askEmpty;
    input?.focus();
    return;
  }
  if (note) note.textContent = "";
  const sent = await sendMessage(text, { view: "status" });
  if (!sent) return;
  input.value = "";
  openSeshat();
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc stp" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.editor = null;
  ui.extend = null;
  ui.health = false;
  ui.target = false;
  ui.releaseLead = false;
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-write]")) openEditor();
    else if (t.closest("[data-set-health]")) openHealth();
    else if (t.closest("[data-cancel-health]")) closeHealth();
    else if (t.closest("[data-set-target]")) openTarget();
    else if (t.closest("[data-cancel-target]")) closeTarget();
    else if (t.closest("[data-set-release-lead]")) openReleaseLead();
    else if (t.closest("[data-cancel-release-lead]")) closeReleaseLead();
    else if (t.closest("[data-clear-target]"))
      saveTarget(t.closest("[data-target]")?.dataset.target, null);
    else if (t.closest("[data-cancel]")) closeEditor();
    else if (t.closest("[data-cancel-extend]")) {
      const id = ui.extend;
      ui.extend = null;
      render();
      $(`[data-act="slice-extend"][data-id="${CSS.escape(id ?? "")}"]`, ui.root)?.focus();
    } else if (t.closest("[data-start]")) location.hash = START_ROUTE;
    else if (t.closest("[data-reload]")) {
      ui.facts = { status: 0, data: null };
      render();
      load();
    } else if (t.closest("[data-jump]")) {
      const h = $(`#stp-h-${t.closest("[data-jump]").dataset.jump}`, ui.root);
      h?.scrollIntoView({ block: "start" });
      h?.focus({ preventScroll: true });
    } else if (t.closest("[data-act]")) act(t.closest("[data-act]"));
  });
  root.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    if (f.matches("[data-editor]")) postUpdate();
    else if (f.matches("[data-health]")) saveHealth(f);
    else if (f.matches("[data-target]"))
      saveTarget(f.dataset.target, $("#stp-target", f)?.value || null);
    else if (f.matches("[data-release-lead]"))
      saveReleaseLead(f.dataset.releaseLead, $("#stp-release-lead", f)?.value || null);
    else if (f.matches("[data-extend]")) extend(f);
    else if (f.matches("[data-ask]")) ask(f);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const t = e.target instanceof Element ? e.target : null;
    // Esc closes the editor or the Extend form and returns focus to what opened it.
    if (t?.closest("[data-editor]")) {
      e.stopPropagation();
      closeEditor();
    } else if (t?.closest("[data-health]")) {
      e.stopPropagation();
      closeHealth();
    } else if (t?.closest("[data-target]")) {
      e.stopPropagation();
      closeTarget();
    } else if (t?.closest("[data-release-lead]")) {
      e.stopPropagation();
      closeReleaseLead();
    } else if (t?.closest("[data-extend]")) {
      e.stopPropagation();
      t.closest("form").querySelector("[data-cancel-extend]")?.click();
    }
  });
  ui.off = store.on((_s, patch) => {
    if ("cards" in patch || "cycles" in patch || "connection" in patch) render();
  });
  ui.timer = window.setInterval(load, REFRESH_MS);
  render();
  load();
  return {
    unmount() {
      window.clearInterval(ui.timer);
      ui.off?.();
      root.remove();
      ui.root = null;
    },
  };
}
