// Projects (dashboard §2.11, DB-N9-9, DB-N9-21; teams item 5): the
// workspace's home, replacing the Workspace rollup. It reads like a Linear or
// Jira projects list: the totals strip, one row per project the person can
// see, the Waiting on you list across projects, and the models on this
// server. Every word is `projectsModel`'s (`/app/lib/projects.js`); a row
// opens that project's Status, its overview. *New project* opens Seshat on
// the start-project conversation, the same prompt Status and the board use.
import { $, aiBadge, esc, getJSON, icon } from "./dom.js";
import { PROJECTS_COPY as C, projectsModel } from "./lib/projects.js";
import { START_PROJECT_OPENING } from "./lib/seshat.js";
import { askMerit } from "./pm_panel.js";
import { setTopbar } from "./shell.js";
import { store } from "./store.js";

const ui = { root: null, last: "", overview: undefined, loading: false };

async function load() {
  ui.loading = true;
  const r = await getJSON("/api/projects/overview").catch(() => ({ ok: false, status: 0 }));
  ui.loading = false;
  if (r.ok) {
    ui.overview = r.data.overview;
    // The project switcher's list, as the rollup kept it.
    store.set({
      project: {
        ...store.state.project,
        list: (ui.overview?.projects ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          status: p.state,
        })),
      },
    });
  } else ui.overview = r.status === 404 ? null : { error: r.status || "no response" };
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

function rowHtml(r, columns) {
  const cells = {
    name: `<a href="#/status" data-open="${esc(r.id)}"><b>${esc(r.name)}</b></a><span class="sec pj-state">${esc(r.state)}</span>`,
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
  return `<div class="tbl-wrap"><table class="tbl pj-tbl"><caption class="sr-only">${esc(C.tableLabel)}</caption><thead><tr>${v.columns
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
    html = `<p class="stp-notice" role="status"><b>Couldn't load the projects.</b> <span class="sec">The server returned ${esc(o.error)}.</span></p>`;
  } else {
    const v = projectsModel({ now: Date.now(), overview: o });
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

/** Scope the pages to one project, then go where the person asked. */
function scopeTo(id, hash) {
  if (id && store.state.project.id !== id) {
    store.set({ project: { ...store.state.project, id } });
    window.dispatchEvent(new CustomEvent("sekhemet:refresh"));
  }
  location.hash = hash;
}

/** Seshat, one step away: the panel, or on a phone the full view (§2.7.1, `askMerit`). */
function startProject() {
  askMerit(START_PROJECT_OPENING);
}

export function mount(view) {
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
