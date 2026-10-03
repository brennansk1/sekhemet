// Projects (dashboard §2.11, DB-N9-9, DB-N9-21; teams item 5): the
// workspace's home, replacing the Workspace rollup. It reads like a Linear or
// Jira projects list: the totals strip, one row per project the person can
// see, the Waiting on you list across projects, and the models on this
// server. Every word is `projectsModel`'s (`/app/lib/projects.js`); a row
// opens that project's Status, its overview. *New project* opens the start
// page, #/projects/new (design-stage §2.11), which this route mounts.
import { $, aiBadge, esc, getJSON, icon, postJSON } from "./dom.js";
import { viewerManagesWork } from "./learn.js";
import { PROJECTS_COPY as C, projectsModel } from "./lib/projects.js";
import { START_ROUTE } from "./lib/start.js";
import { loadFailedText } from "./lib/switcher.js";
import { setTopbar } from "./shell.js";
import * as startPage from "./start.js";
import { chooseProject, setProjectList } from "./switcher.js";

/** `refused`: a Resume the server refused, by project, with its sentence (DB-N26-3). */
const ui = { root: null, last: "", overview: undefined, loading: false, refused: {} };

async function load() {
  ui.loading = true;
  const r = await getJSON("/api/projects/overview");
  ui.loading = false;
  if (r.ok) {
    ui.overview = r.data.overview;
    // The project switcher's list (DB-N25-2), as this page read it.
    setProjectList(ui.overview);
  } else ui.overview = r.status === 404 ? null : { error: r.status };
  render();
}

const labelled = (text, ai) => `${esc(text)}${ai ? aiBadge() : ""}`;

function totalsHtml(v) {
  return `<dl class="pj-totals">${v.totals
    .map(
      (t) =>
        `<div class="pj-total"><dt>${labelled(t.label, t.ai)}</dt><dd><span class="pj-v tnum">${esc(t.value)}</span>${t.detail ? `<span class="pj-d sec">${esc(t.detail)}</span>` : ""}</dd></div>`,
    )
    .join("")}</dl>`;
}

function healthHtml(r) {
  const h = r.health
    ? `<span class="pj-health"><span class="stp-dot t-${esc(r.health.tone || "none")}" aria-hidden="true"></span>${esc(r.health.text)}</span>`
    : "";
  const missing = r.updateMissing ? `<span class="pj-missing">${esc(r.updateMissing)}</span>` : "";
  // Solo shows the Health column only once a health is set (TEAM-45; the model decides).
  return `${h}${missing}`;
}

function progressHtml(r) {
  if (!r.progress) return `<span class="sec">${esc(r.release)}</span>`;
  const { done, total, text } = r.progress;
  return `<span class="pj-rel">${esc(r.release)}</span><span class="pj-prog"><progress max="${Math.max(1, total)}" value="${done}" aria-label="${esc(`${r.release}: ${text}`)}"></progress><span class="sec tnum">${esc(text)}</span></span>`;
}

/** STA-07: two projects of one name are told apart by their folders, as the switcher does. */
function folderNote(r) {
  const all = ui.overview?.projects ?? [];
  if (all.filter((p) => p.name === r.name).length < 2) return "";
  const root = all.find((p) => p.id === r.id)?.rootPath ?? "";
  const folder = root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return folder ? ` · ${folder}` : "";
}

function rowHtml(r, columns) {
  const cells = {
    name: `<a href="#/status" data-open="${esc(r.id)}"><b>${esc(r.name)}</b></a><span class="sec pj-state">${esc(r.state)}${esc(folderNote(r))}</span>${
      r.paused
        ? `<span class="pj-paused"><span class="sec">${esc(r.paused.reason)}</span><button class="btn sm" type="button" data-resume="${esc(r.id)}">${esc(r.paused.resume)}</button></span>${ui.refused[r.id] ? `<span class="pj-refused" role="alert">${esc(ui.refused[r.id])}</span>` : ""}`
        : ""
    }`,
    health: healthHtml(r),
    release: progressHtml(r),
    forecast: `<span class="tnum">${esc(r.forecast)}</span>`,
    target: `<span class="tnum">${esc(r.target)}</span>`,
    waiting: `<span class="tnum">${esc(r.waiting)}</span>`,
    agent: esc(r.agent),
    lead: esc(r.lead),
  };
  return `<tr data-project="${esc(r.id)}">${columns
    .map(
      (c) =>
        `<td data-col="${esc(c.id)}"><span class="pj-lbl">${labelled(c.label, c.ai)}</span>${cells[c.id] ?? ""}</td>`,
    )
    .join("")}</tr>`;
}

function tableHtml(v) {
  return `<div class="tbl-wrap" tabindex="0"><table class="tbl pj-tbl"><caption class="sr-only">${esc(C.tableLabel)}</caption><thead><tr>${v.columns
    .map((c) => `<th scope="col">${labelled(c.label, c.ai)}</th>`)
    .join(
      "",
    )}</tr></thead><tbody>${v.rows.map((r) => rowHtml(r, v.columns)).join("")}</tbody></table></div>`;
}

function waitingHtml(w) {
  const body = w.items.length
    ? `<ul class="stp-list">${w.items
        .map(
          (i) =>
            `<li><span><span class="pj-proj sec">${esc(i.project)}</span> ${esc(i.text)} <span class="sec tnum">${esc(i.wait)}</span></span><a class="btn sm" href="${esc(i.href)}" data-go="${esc(i.projectId)}">${esc(i.action)}</a></li>`,
        )
        .join("")}</ul>`
    : `<p class="sec">${esc(w.empty)}</p>`;
  return `<section class="stp-sec" aria-labelledby="pj-h-waiting"><h2 id="pj-h-waiting">${esc(w.heading)}</h2>${body}</section>`;
}

function modelsHtml(m) {
  return `<section class="stp-sec" aria-labelledby="pj-h-models"><h2 id="pj-h-models">${esc(m.heading)}</h2><ul class="stp-list">${m.rows
    .map(
      (r) =>
        `<li><span><b>${labelled(r.label, r.seshat)}</b> <span class="mono sec">${esc(r.model)}</span></span><span class="sec">${esc(r.state)}${r.load ? ` · ${esc(r.load)}` : ""}</span></li>`,
    )
    .join(
      "",
    )}</ul><p class="sec pj-mem">${icon("memory", 14, "ic s14")}${esc(m.memory)}</p></section>`;
}

function render() {
  if (!ui.root) return;
  let html;
  const o = ui.overview;
  if (o === undefined) {
    setTopbar({ title: C.title });
    html = '<div class="sk" style="height:160px"></div>';
  } else if (o?.error !== undefined) {
    setTopbar({ title: C.title });
    // ERR-04: what failed and what to do, in words, with Retry.
    const t = loadFailedText("the projects", o.error);
    html = `<p class="stp-notice" role="alert"><b>${esc(t.title)}</b> <span class="sec">${esc(t.detail)}</span> <button class="btn sm" type="button" data-reload>${icon("refresh", 14, "ic s14")}Try again</button></p>`;
  } else {
    const v = projectsModel({ now: Date.now(), overview: o, managesWork: viewerManagesWork() });
    setTopbar({ title: v.title, crumb: v.crumb });
    if (v.unavailable) {
      html = `<div class="ib-empty">${icon("layers", 24, "ic s24")}<b>${esc(v.unavailable)}</b><span>${esc(C.notOnServerDetail)}</span></div>`;
    } else if (v.empty) {
      // DB-N9-21: one empty state and nothing else.
      html = `<div class="ib-empty pj-empty">${icon("layers", 24, "ic s24")}<b>${esc(v.empty.heading)}</b><span>${esc(v.empty.detail)}</span><button class="btn primary" type="button" data-new>${icon("plus", 14, "ic s14")}${esc(v.empty.button)}</button></div>`;
    } else {
      html = `<div class="pj-head">${totalsHtml(v)}<button class="btn primary" type="button" data-new>${icon("plus", 14, "ic s14")}${esc(v.newProject)}</button></div>${tableHtml(v)}${waitingHtml(v.waiting)}${modelsHtml(v.models)}`;
    }
  }
  if (html === ui.last) return;
  ui.last = html;
  $(".sc", ui.root).innerHTML = html;
}

/** Make a project current (the switcher's own choice), then go where the person asked. */
function scopeTo(id, hash) {
  if (id) chooseProject(id, { stay: true });
  location.hash = hash;
}

/** New project: the start page, the conversation beside the live draft (DS-N7-1). */
function startProject() {
  location.hash = START_ROUTE;
}

async function resumeProject(id) {
  const r = await postJSON(`/api/projects/${encodeURIComponent(id)}`, { status: "active" });
  ui.refused = r.ok
    ? {}
    : { [id]: r.data?.error ?? `The server returned ${r.status || "no response"}.` };
  ui.last = "";
  if (r.ok) load();
  else render();
}

export function mount(view, parsed) {
  if (parsed?.params?.[0] === "new") return startPage.mount(view);
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc pj" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest("[data-new]")) {
      startProject();
      return;
    }
    if (t.closest("[data-reload]")) {
      ui.overview = undefined;
      render();
      load();
      return;
    }
    // DB-N26-3, RUN-82: Resume a paused project; at the cap it is refused
    // with the cap's sentence until a person pauses another.
    const resume = t.closest("[data-resume]");
    if (resume) {
      void resumeProject(resume.dataset.resume);
      return;
    }
    const open = t.closest("[data-open]");
    if (open) {
      e.preventDefault();
      scopeTo(open.dataset.open, "#/status");
      return;
    }
    const go = t.closest("[data-go]");
    if (go) {
      e.preventDefault();
      scopeTo(go.dataset.go, go.getAttribute("href"));
    }
  });
  render();
  load();
  return {
    unmount() {
      root.remove();
      ui.root = null;
    },
  };
}
