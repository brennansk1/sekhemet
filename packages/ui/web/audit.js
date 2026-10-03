// Audit (dashboard §2.17.5, TEAM-27; teams item 27; Admin only): the event
// log read as Atlassian's and GitHub's audit logs are — time, actor (an AI
// teammate with its badge and the person it works for), action and target,
// newest first — filtered by person, action and project, and exported as
// CSV or JSON with the same filters. A read of the ledger, not a second
// store. Anyone but an Admin gets the server's refusal (DB-N9-16), and Solo
// has no Audit (DB-N9-12). Every word is `/app/lib/team_admin.js`'s.
import { $, aiBadge, esc, getJSON, icon } from "./dom.js";
import { refusalMessage } from "./lib/account.js";
import { AUDIT_CATEGORIES, AUDIT_COPY as C, teamOnlyNotice } from "./lib/team_admin.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";

const ui = {
  root: null,
  entries: undefined,
  next: undefined,
  error: "",
  filters: { person: "", action: "", project: "" },
  people: [],
  projects: [],
  last: "",
};

function query(extra = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...ui.filters, ...extra })) if (v) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function load(more = false) {
  const r = await getJSON(`/api/audit${query(more && ui.next ? { before: ui.next } : {})}`).catch(
    () => ({ ok: false, status: 0, data: null }),
  );
  if (!r.ok) {
    ui.entries = [];
    ui.next = undefined;
    ui.error = r.status === 403 ? r.data?.error || C.refused : refusalMessage(r.status, r.data);
    render();
    return;
  }
  ui.error = "";
  const got = r.data?.entries ?? [];
  ui.entries = more && Array.isArray(ui.entries) ? [...ui.entries, ...got] : got;
  ui.next = r.data?.next;
  render();
}

async function loadFilters() {
  const [m, p] = await Promise.all([
    getJSON("/api/members").catch(() => ({ ok: false })),
    getJSON("/api/projects").catch(() => ({ ok: false })),
  ]);
  ui.people = m.ok ? (m.data?.members ?? []) : [];
  ui.projects = p.ok ? (p.data?.projects ?? []) : [];
  render();
}

function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function select(name, label, any, options) {
  const v = ui.filters[name];
  return `<div class="auth-field"><label for="au-${name}">${esc(label)}</label><select id="au-${name}" data-au-filter="${name}"><option value="">${esc(any)}</option>${options
    .map(
      ([id, text]) =>
        `<option value="${esc(id)}"${id === v ? " selected" : ""}>${esc(text)}</option>`,
    )
    .join("")}</select></div>`;
}

function actorHtml(a) {
  const name = `<b>${esc(a.name)}</b>${a.ai ? aiBadge() : ""}`;
  return a.onBehalfOf
    ? `${name} <span class="sec">${esc(C.onBehalfOf(a.onBehalfOf.name))}</span>`
    : name;
}

function render() {
  if (!ui.root) return;
  const filters = `<form class="au-filters" data-au-form aria-label="${esc(C.title)}">${select(
    "person",
    C.person,
    C.anyPerson,
    ui.people.map((m) => [m.principal, m.name || m.principal]),
  )}${select(
    "action",
    C.kind,
    C.anyKind,
    AUDIT_CATEGORIES.map((c) => [c.id, c.label]),
  )}${select(
    "project",
    C.project,
    C.anyProject,
    ui.projects.map((p) => [p.id, p.name]),
  )}<div class="au-export"><a class="btn" href="/api/audit${esc(query({ format: "csv" }))}" download>${icon("download", 14, "ic s14")}${esc(C.exportCsv)}</a><a class="btn" href="/api/audit${esc(query({ format: "json" }))}" download>${icon("download", 14, "ic s14")}${esc(C.exportJson)}</a></div></form>`;
  let body;
  const v = ui.entries;
  if (ui.error) body = `<p class="stp-notice" role="alert"><b>${esc(ui.error)}</b></p>`;
  else if (v === undefined) body = '<div class="sk" style="height:160px"></div>';
  else if (v.length === 0)
    body = `<div class="ib-empty">${icon("ledger", 24, "ic s24")}<b>${esc(C.empty)}</b></div>`;
  else
    body = `<div class="tbl-wrap" tabindex="0"><table class="tbl pj-tbl au-tbl"><caption class="sr-only">${esc(C.title)}</caption><thead><tr><th scope="col">${esc(C.time)}</th><th scope="col">${esc(C.actor)}</th><th scope="col">${esc(C.action)}</th><th scope="col">${esc(C.target)}</th></tr></thead><tbody>${v
      .map(
        (e) =>
          `<tr><td data-col="time"><span class="pj-lbl">${esc(C.time)}</span><time class="tnum" datetime="${esc(e.at)}">${esc(when(e.at))}</time></td><td data-col="actor"><span class="pj-lbl">${esc(C.actor)}</span>${actorHtml(e.actor)}</td><td data-col="action"><span class="pj-lbl">${esc(C.action)}</span>${esc(e.action)}${e.count > 1 ? ` <span class="sec tnum">· ${esc(e.count)} times</span>` : ""}</td><td data-col="target"><span class="pj-lbl">${esc(C.target)}</span>${esc(e.target)}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div>${ui.next ? `<button class="btn ghost" type="button" data-au-more>${esc(C.more)}</button>` : ""}`;
  const html = `<p class="sec">${esc(C.lead)}</p>${ui.error ? "" : filters}${body}`;
  setTopbar({ title: C.title });
  if (html === ui.last) return;
  ui.last = html;
  $(".sc", ui.root).innerHTML = html;
}

export function mount(view) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc au" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.entries = undefined;
  ui.next = undefined;
  ui.error = "";
  // FINDINGS TEAM-07: Solo has no Audit (DB-N9-12); say so here instead of opening another page.
  if (getSession().mode !== "team") {
    const n = teamOnlyNotice("Audit");
    setTopbar({ title: "Audit", crumb: "" });
    root.innerHTML = `<div class="ib-empty team-only" role="status"><b>${esc(n.title)}</b><span>${esc(n.text)}</span><a class="btn" href="${esc(n.route)}">${esc(n.action)}</a></div>`;
    return {
      unmount() {
        root.remove();
        ui.root = null;
      },
    };
  }
  root.addEventListener("change", (e) => {
    const t = e.target instanceof Element ? e.target.closest("[data-au-filter]") : null;
    if (!t) return;
    ui.filters[t.getAttribute("data-au-filter")] = t.value;
    ui.entries = undefined;
    render();
    void load();
  });
  root.addEventListener("submit", (e) => e.preventDefault());
  root.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest("[data-au-more]")) void load(true);
  });
  render();
  void load();
  void loadFilters();
  return {
    unmount() {
      root.remove();
      ui.root = null;
    },
  };
}
