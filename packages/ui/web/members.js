// Members (dashboard §2.17.4, DB-N9-16; teams items 6–10): everyone in the
// workspace — the person with a presence dot, access level, per-project
// levels, profile label and last active — as GitHub's and Linear's member
// tables read. An Admin sees Invite (a single-use link shown once) and, per
// row, change level, set a project level, change label, reset password,
// unlock and remove, and Approve or Decline for a pending person; everyone
// else reads the table, with the Admin's controls disabled and the level
// that can use them written beside (DB-N9-17). Team only (DB-N9-12). Every
// word is `/app/lib/team_admin.js`'s.
//
// C2a (NEW-dashboard-19, DEC-51; FINDINGS TEAM-04): the approved mockup's
// parts — tabs Members, Invites (an Admin only) and Sign-in, an Audit log link
// for an Admin; the table's columns Name, Access, Labels, Projects and *Can
// accept in*; under it the AI teammates, and beside it the Access levels from
// the table the server checks. Invites lists each outstanding invite with
// Revoke; Sign-in the sign-in settings in force and where each is changed.
import { $, aiBadge, announce, copyText, esc, getJSON, icon, sendJSON } from "./dom.js";
import { refusalMessage } from "./lib/account.js";
import {
  MEMBERS_COPY as C,
  NO_ACCESS,
  MEMBERS_PARTS_COPY as P,
  PROFILE_LABELS,
  accessLevelLines,
  accessLevelWord,
  aiTeammateLines,
  inviteRows,
  levelNote,
  memberRows,
  membersTab,
  membersTabs,
  removalView,
  signInLines,
  teamOnlyNotice,
} from "./lib/team_admin.js";
import { openMenu, pushOverlay, trapFocus } from "./overlay.js";
import { getSession } from "./session.js";
import { setTopbar } from "./shell.js";
import { toast } from "./toast.js";

const LEVELS = ["admin", "member", "stakeholder", "viewer"];
const DAYS = [1, 7, 14, 30];

const ui = {
  root: null,
  members: undefined,
  canManage: false,
  projects: [],
  /** `{principal, kind}` of the inline editor that is open, or null. */
  editing: null,
  inviting: false,
  /** A link shown once: `{kind: "invite" | "reset", url, name?}`. */
  shown: null,
  error: "",
  last: "",
  /** The tab shown: members, invites (an Admin's) or signin (DB-N19-3). */
  tab: "members",
  /** The workspace's parts from `GET /api/members`: levels, ai, signIn. */
  facts: {},
  /** Outstanding invites (DB-N19-4): undefined until read, or `{error}`. */
  invites: undefined,
};

async function load() {
  const [m, p] = await Promise.all([
    getJSON("/api/members").catch(() => ({ ok: false, status: 0 })),
    getJSON("/api/projects").catch(() => ({ ok: false })),
  ]);
  ui.members = m.ok ? (m.data?.members ?? []) : { error: m.status || "no response" };
  ui.canManage = m.ok && m.data?.canManage === true;
  ui.facts = m.ok ? { levels: m.data?.levels ?? [], ai: m.data?.ai, signIn: m.data?.signIn } : {};
  ui.projects = p.ok ? (p.data?.projects ?? []).filter((x) => x.status !== "archived") : [];
  ui.tab = membersTab(ui.tab, ui.canManage);
  if (ui.tab === "invites") await loadInvites();
  render();
}

/** DB-N19-4: the outstanding invites, an Admin's read. */
async function loadInvites() {
  const r = await getJSON("/api/invites").catch(() => ({ ok: false, status: 0 }));
  ui.invites = r.ok ? (r.data?.invites ?? []) : { error: r.status || "no response" };
}

const projectNames = () => Object.fromEntries(ui.projects.map((p) => [p.id, p.name]));

function levelOptions(selected, { noAccess = false } = {}) {
  // TEAM-58: a one-project override may take the project away: No access.
  return (noAccess ? [NO_ACCESS, ...LEVELS] : LEVELS)
    .map(
      (l) =>
        `<option value="${l}"${l === selected ? " selected" : ""}>${esc(accessLevelWord(l))}</option>`,
    )
    .join("");
}

function projectOptions(withWorkspace) {
  return `${withWorkspace ? `<option value="">${esc(C.inviteNoProject)}</option>` : ""}${ui.projects
    .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
    .join("")}`;
}

function inviteForm() {
  return `<form class="mb-form" data-mb-invite aria-label="${esc(C.inviteTitle)}"><div class="auth-field"><label for="mb-inv-level">${esc(C.inviteLevel)}</label><select id="mb-inv-level" name="level">${levelOptions("member")}</select></div>${ui.projects.length ? `<div class="auth-field"><label for="mb-inv-project">${esc(C.inviteProject)}</label><select id="mb-inv-project" name="project">${projectOptions(true)}</select></div>` : ""}<div class="auth-field"><label for="mb-inv-email">${esc(C.inviteEmail)}</label><input id="mb-inv-email" name="email" type="email" autocomplete="off"></div><div class="auth-field"><label for="mb-inv-days">${esc(C.inviteDays)}</label><select id="mb-inv-days" name="days">${DAYS.map((d) => `<option value="${d}"${d === 7 ? " selected" : ""}>${d} ${d === 1 ? "day" : "days"}</option>`).join("")}</select></div><button class="btn primary" type="submit">${esc(C.createInvite)}</button><button class="btn ghost" type="button" data-mb-cancel>${esc(C.cancel)}</button></form>`;
}

function shownHtml() {
  if (!ui.shown) return "";
  const lead = ui.shown.kind === "invite" ? C.inviteOnce : C.resetOnce;
  const url = new URL(ui.shown.url, location.origin).href;
  return `<div class="token-once" role="status"><p>${esc(lead)}</p><div class="token-row"><code class="mono" data-mb-link>${esc(url)}</code><button class="btn sm" type="button" data-mb-copy>${icon("copy", 14, "ic s14")}${esc(C.copy)}</button></div></div>`;
}

function editorHtml(row) {
  const e = ui.editing;
  if (!e || e.principal !== row.principal) return "";
  const id = `mb-ed-${esc(row.principal)}`;
  let fields = "";
  if (e.kind === "level")
    fields = `<div class="auth-field"><label for="${id}-level">${esc(C.level)}</label><select id="${id}-level" name="level">${levelOptions(row.level, { noAccess: true })}</select></div>`;
  else if (e.kind === "override")
    fields = `<div class="auth-field"><label for="${id}-project">${esc(C.overrideProject)}</label><select id="${id}-project" name="project">${projectOptions(false)}</select></div><div class="auth-field"><label for="${id}-level">${esc(C.overrideLevel)}</label><select id="${id}-level" name="level">${levelOptions(row.level)}</select></div>`;
  else if (e.kind === "label")
    fields = `<div class="auth-field"><label for="${id}-label">${esc(C.label)}</label><input id="${id}-label" name="label" type="text" maxlength="80" list="mb-labels" value="${esc(row.label)}" autocomplete="off"><datalist id="mb-labels">${PROFILE_LABELS.map((l) => `<option value="${esc(l)}"></option>`).join("")}</datalist></div>`;
  return `<tr class="mb-edit"><td colspan="7"><form class="mb-form" data-mb-edit="${esc(e.kind)}" data-principal="${esc(row.principal)}" aria-label="${esc(`${e.kind === "level" ? C.changeLevel : e.kind === "override" ? C.override : C.changeLabel}: ${row.name}`)}">${fields}<button class="btn primary" type="submit">${esc(C.save)}</button><button class="btn ghost" type="button" data-mb-cancel>${esc(C.cancel)}</button></form></td></tr>`;
}

function rowHtml(row) {
  const dot = row.active
    ? `<span class="dot" aria-hidden="true"></span><span class="sr-only">${esc(C.activeNow)}</span>`
    : "";
  const overrides = row.overrides.length
    ? row.overrides
        .map((o) => `<span class="mb-ov">${esc(o.projectName)}: ${esc(o.levelWord)}</span>`)
        .join("")
    : `<span class="sec">${esc(C.none)}</span>`;
  const state = row.pending
    ? `<span class="sec mb-state">${esc(C.pending)}</span>`
    : row.locked
      ? `<span class="mb-state warn">${esc(C.locked)}</span>`
      : "";
  const actions = row.actions.length
    ? row.pending
      ? `<button class="btn sm" type="button" data-mb-act="approve" data-principal="${esc(row.principal)}">${esc(C.approve)}</button> <button class="btn sm ghost" type="button" data-mb-act="decline" data-principal="${esc(row.principal)}">${esc(C.decline)}</button>`
      : `<button class="btn sm ghost" type="button" data-mb-menu="${esc(row.principal)}" aria-haspopup="menu" aria-label="${esc(`${C.actions}: ${row.name}`)}">${icon("more", 14, "ic s14")}</button>`
    : "";
  const k = P.columns;
  const projects = `${ui.projects.length ? esc(P.allProjects(ui.projects.length)) : `<span class="sec">${esc(P.noProjects)}</span>`}${row.overrides.length ? overrides : ""}`;
  const accepts = row.acceptIn.length
    ? esc(row.acceptIn.join(", "))
    : `<span class="sec" aria-label="${esc(C.none)}">—</span>`;
  return `<tr data-principal="${esc(row.principal)}"><td data-col="person"><span class="pj-lbl">${esc(k.name)}</span><span class="mb-person"><span class="avatar" aria-hidden="true">${esc(row.initials)}</span>${dot}<span><b>${esc(row.name)}</b>${row.you ? ` <span class="sec">(${esc(C.you)})</span>` : ""}${row.email ? `<span class="sec mb-email">${esc(row.email)}</span>` : ""}${state}</span></span></td><td data-col="level"><span class="pj-lbl">${esc(k.access)}</span>${esc(row.levelWord)}</td><td data-col="label"><span class="pj-lbl">${esc(k.labels)}</span>${row.label ? `<span class="mb-chip">${esc(row.label)}</span>` : `<span class="sec">${esc(C.noLabel)}</span>`}</td><td data-col="projects"><span class="pj-lbl">${esc(k.projects)}</span>${projects}</td><td data-col="accept"><span class="pj-lbl">${esc(k.acceptIn)}</span>${accepts}</td><td data-col="active"><span class="pj-lbl">${esc(k.lastActive)}</span><span class="tnum">${esc(row.lastActive)}</span></td><td data-col="actions">${actions}</td></tr>${editorHtml(row)}`;
}

function render() {
  if (!ui.root) return;
  const v = ui.members;
  const s = getSession();
  let body;
  if (v === undefined) body = '<div class="sk" style="height:160px"></div>';
  else if (!Array.isArray(v))
    body = `<p class="stp-notice" role="status"><b>Couldn't load the members.</b> <span class="sec">The server returned ${esc(v.error)}.</span></p>`;
  else {
    const rows = memberRows(v, {
      admin: ui.canManage,
      me: s.principal,
      projectNames: projectNames(),
      now: Date.now(),
    });
    const note = ui.canManage ? undefined : levelNote(s, "members.manage");
    const tabs = `<nav class="tabs ptabs" aria-label="${esc(P.tabsLabel)}">${membersTabs(
      ui.canManage,
    )
      .map(
        (t) =>
          `<a class="tab" href="#/members${t.id === "members" ? "" : `/${t.id}`}"${t.id === ui.tab ? ' aria-current="page"' : ""}>${esc(t.label)}${t.id === "members" ? ` <span class="c tnum">${rows.length}</span>` : t.id === "invites" && Array.isArray(ui.invites) ? ` <span class="c tnum">${ui.invites.length}</span>` : ""}</a>`,
      )
      .join("")}</nav>`;
    const audit = ui.canManage ? `<a class="btn" href="#/audit">${esc(P.auditLog)}</a>` : "";
    const invite = `<button class="btn primary" type="button" data-mb-invite-open${note ? ' disabled aria-describedby="mb-why"' : ""}>${icon("plus", 14, "ic s14")}${esc(P.invitePeople)}</button>${note ? `<span class="sec level-note" id="mb-why">${esc(note)}</span>` : ""}`;
    const bar = `<div class="mb-bar">${tabs}<span class="mb-acts">${audit}${invite}</span></div>`;
    const flash = `${ui.inviting && ui.canManage ? inviteForm() : ""}${ui.error ? `<p class="auth-error" role="alert">${esc(ui.error)}</p>` : ""}${shownHtml()}`;
    let part;
    if (ui.tab === "invites") part = invitesHtml();
    else if (ui.tab === "signin") part = signInHtml();
    else part = membersPartHtml(rows);
    body = `${bar}${flash}${part}`;
  }
  setTopbar({
    title: C.title,
    crumb: Array.isArray(v) ? `${v.length} ${v.length === 1 ? "person" : "people"}` : "",
  });
  if (body === ui.last) return;
  ui.last = body;
  $(".sc", ui.root).innerHTML = body;
}

const k = () => P.columns;

/** The Members tab: the table and the AI teammates, the Access levels beside (DB-N19-3). */
function membersPartHtml(rows) {
  const c = k();
  const table = rows.length
    ? `<div class="tbl-wrap" tabindex="0"><table class="tbl pj-tbl mb-tbl"><caption class="sr-only">${esc(C.title)}</caption><thead><tr><th scope="col">${esc(c.name)}</th><th scope="col">${esc(c.access)}</th><th scope="col">${esc(c.labels)}</th><th scope="col">${esc(c.projects)}</th><th scope="col">${esc(c.acceptIn)}</th><th scope="col">${esc(c.lastActive)}</th><th scope="col"><span class="sr-only">${esc(C.actions)}</span></th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`
    : `<div class="ib-empty">${icon("user", 24, "ic s24")}<b>${esc(C.empty)}</b></div>`;
  const ai = ui.facts.ai
    ? `<section class="mb-card" aria-labelledby="mb-ai-h"><h2 id="mb-ai-h">${esc(P.aiTitle)} <span class="sec">${esc(P.aiNote)}</span></h2><ul class="mb-ai">${aiTeammateLines(
        ui.facts.ai,
      )
        .map(
          (a) =>
            `<li><span class="mb-ai-mark" aria-hidden="true">${a.who === "seshat" ? "S" : icon("machine", 14, "ic s14")}</span><span><span class="mb-ai-who"><b>${esc(a.name)}</b>${aiBadge()}<span class="sec">${esc(a.role)}</span></span><span class="sec">${esc(a.does)}</span></span></li>`,
        )
        .join("")}</ul></section>`
    : "";
  const levels = accessLevelLines(ui.facts.levels ?? []);
  const side = levels.length
    ? `<aside class="mb-side"><section class="mb-card" aria-labelledby="mb-lv-h"><h2 id="mb-lv-h">${esc(P.levelsTitle)}</h2><dl class="mb-levels">${levels
        .map((l) => `<div><dt>${esc(l.word)}</dt><dd class="sec">${esc(l.allows)}</dd></div>`)
        .join("")}</dl><p class="sec mb-note">${esc(P.levelsNote)}</p></section></aside>`
    : "";
  return `<div class="mb-grid"><div class="mb-main"><section class="mb-card mb-table" aria-label="${esc(C.title)}">${table}</section>${ai}</div>${side}</div>`;
}

/** DB-N19-4: each outstanding invite with Revoke; an Admin's tab only. */
function invitesHtml() {
  const v = ui.invites;
  if (v === undefined) return '<div class="sk" style="height:120px"></div>';
  if (!Array.isArray(v))
    return `<p class="stp-notice" role="status"><b>Couldn't load the invites.</b> <span class="sec">The server returned ${esc(v.error)}.</span></p>`;
  const c = P.inviteColumns;
  const rows = inviteRows(v, Date.now());
  const table = rows.length
    ? `<div class="tbl-wrap" tabindex="0"><table class="tbl pj-tbl mb-tbl"><caption class="sr-only">${esc(P.invitesTitle)}</caption><thead><tr><th scope="col">${esc(c.email)}</th><th scope="col">${esc(c.access)}</th><th scope="col">${esc(c.project)}</th><th scope="col">${esc(c.by)}</th><th scope="col">${esc(c.expires)}</th><th scope="col"><span class="sr-only">${esc(P.revoke)}</span></th></tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr data-invite="${esc(r.ref)}"><td data-col="email"><span class="pj-lbl">${esc(c.email)}</span>${esc(r.email)}</td><td data-col="level"><span class="pj-lbl">${esc(c.access)}</span>${esc(r.levelWord)}</td><td data-col="project"><span class="pj-lbl">${esc(c.project)}</span>${esc(r.project)}</td><td data-col="by"><span class="pj-lbl">${esc(c.by)}</span>${esc(r.by)}</td><td data-col="expires"><span class="pj-lbl">${esc(c.expires)}</span><span class="tnum">${esc(r.expires)}</span></td><td data-col="actions"><button class="btn sm" type="button" data-mb-revoke="${esc(r.ref)}" data-who="${esc(r.email)}" aria-label="${esc(`${P.revoke}: ${r.email}`)}">${esc(P.revoke)}</button></td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<div class="ib-empty">${icon("user", 24, "ic s24")}<b>${esc(P.invitesEmpty)}</b></div>`;
  return `<section class="mb-card" aria-labelledby="mb-inv-h"><h2 id="mb-inv-h">${esc(P.invitesTitle)}</h2><p class="sec">${esc(P.invitesLead)}</p>${table}</section>`;
}

/** The sign-in settings in force, each with where it is changed (DB-N19-3). */
function signInHtml() {
  const s = ui.facts.signIn;
  if (!s) return "";
  return `<section class="mb-card" aria-labelledby="mb-si-h"><h2 id="mb-si-h">${esc(P.signInTitle)}</h2><p class="sec">${esc(P.signInLead)}</p><dl class="mb-signin">${signInLines(
    s,
  )
    .map(
      (l) =>
        `<div><dt>${esc(l.label)}</dt><dd><span>${esc(l.value)}</span><span class="sec mb-where">${esc(P.where)} <code class="mono">${esc(l.where)}</code></span></dd></div>`,
    )
    .join("")}</dl></section>`;
}

async function act(method, path, body, done) {
  ui.error = "";
  const r = await sendJSON(method, path, body);
  if (!r.ok) {
    ui.error = refusalMessage(r.status, r.data);
    render();
    return undefined;
  }
  if (done) toast({ tone: "pass", text: done });
  return r.data;
}

function rowOf(principal) {
  return (Array.isArray(ui.members) ? ui.members : []).find((m) => m.principal === principal);
}

function openRowMenu(anchor, principal) {
  const row = memberRows([rowOf(principal)].filter(Boolean), {
    admin: ui.canManage,
    me: getSession().principal,
    now: Date.now(),
  })[0];
  if (!row) return;
  const edit = (kind) => () => {
    ui.editing = { principal, kind };
    ui.shown = null;
    render();
    ui.root?.querySelector(".mb-edit select, .mb-edit input")?.focus();
  };
  const items = [];
  if (row.actions.includes("level")) items.push({ label: C.changeLevel, run: edit("level") });
  if (row.actions.includes("override") && ui.projects.length)
    items.push({ label: C.override, run: edit("override") });
  if (row.actions.includes("label")) items.push({ label: C.changeLabel, run: edit("label") });
  if (row.actions.includes("reset"))
    items.push({
      label: C.resetPassword,
      run: async () => {
        const d = await act("POST", `/api/members/${principal}/password-reset`);
        if (d?.url) {
          ui.shown = { kind: "reset", url: d.url };
          render();
          announce(C.resetOnce);
        }
      },
    });
  if (row.actions.includes("unlock"))
    items.push({
      label: C.unlock,
      run: async () => {
        if (await act("POST", `/api/members/${principal}/unlock`, undefined, C.unlock)) load();
      },
    });
  if (row.actions.includes("remove")) {
    items.push("-");
    items.push({
      label: C.remove,
      // Teams item 9a (TEAM-49): Remove first lists what the person leaves behind.
      run: () => openRemoval(principal, row.name, anchor),
    });
  }
  openMenu(anchor, items, { heading: row.name });
}

/**
 * Teams item 9a (TEAM-49, -50): the removal's confirmation — what the person
 * owns and leads, their Accept-rule seats (a rule naming only them is a
 * warning), the Agent work they started — then *Remove* or Cancel.
 */
async function openRemoval(principal, name, anchor) {
  const r = await getJSON(`/api/members/${principal}/removal`).catch(() => ({ ok: false }));
  if (!r.ok) {
    ui.error = refusalMessage(r.status ?? 0, r.data);
    render();
    return;
  }
  const v = removalView(r.data);
  const node = document.createElement("div");
  node.className = "scrim";
  const warnings = v.warnings
    .map((w) => `<li class="why">${icon("alert", 14, "ic s14")}<span>${esc(w)}</span></li>`)
    .join("");
  node.innerHTML = `<div class="dialog mb-remove" role="alertdialog" aria-modal="true" aria-labelledby="mb-rm-h" aria-describedby="mb-rm-d"><header><h2 id="mb-rm-h">${esc(v.title)}</h2></header><div class="mb-rm-b" id="mb-rm-d">${warnings ? `<ul class="plain mb-rm-warn">${warnings}</ul>` : ""}<ul class="plain mb-rm-lines">${v.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div><div class="mb-rm-f"><button class="btn ghost" type="button" data-cancel>${esc(C.cancel)}</button><button class="btn primary" type="button" data-confirm-remove>${esc(C.remove)}</button></div></div>`;
  document.getElementById("overlay-root").append(node);
  const close = () => {
    remove();
    node.remove();
    anchor?.focus?.();
  };
  const remove = pushOverlay({
    kind: "remove-member",
    modal: true,
    close: () => {
      node.remove();
      anchor?.focus?.();
    },
    onKey: (e) => {
      if (trapFocus(node, e)) return true;
      return e.key !== "Escape";
    },
  });
  node.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.target === node || t?.closest("[data-cancel]")) close();
    else if (t?.closest("[data-confirm-remove]")) {
      t.closest("[data-confirm-remove]").disabled = true;
      close();
      if (await act("DELETE", `/api/members/${principal}`, undefined, `${C.remove}d ${name}.`))
        load();
    }
  });
  node.querySelector("[data-cancel]").focus();
}

async function submitEdit(form) {
  const principal = form.dataset.principal;
  const kind = form.dataset.mbEdit;
  const data = Object.fromEntries(new FormData(form).entries());
  let ok;
  if (kind === "level")
    ok = await act("POST", `/api/members/${principal}/level`, { level: data.level }, C.save);
  else if (kind === "override")
    ok = await act(
      "POST",
      `/api/members/${principal}/level`,
      { level: data.level, project: data.project },
      C.save,
    );
  else if (kind === "label") {
    const label = String(data.label ?? "").trim();
    ok = await act("POST", `/api/members/${principal}/label`, { label: label || null }, C.save);
  }
  if (ok) {
    ui.editing = null;
    load();
  }
}

async function submitInvite(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const d = await act("POST", "/api/invites", {
    level: data.level,
    days: Number(data.days),
    ...(data.project ? { project: data.project } : {}),
    ...(String(data.email ?? "").trim() ? { email: String(data.email).trim() } : {}),
  });
  if (!d?.url) return;
  ui.inviting = false;
  ui.shown = { kind: "invite", url: d.url };
  render();
  announce(C.inviteOnce);
  ui.root?.querySelector("[data-mb-link]")?.scrollIntoView({ block: "nearest" });
}

async function revoke(ref, who) {
  if (!window.confirm(P.revokeConfirm(who))) return;
  if (await act("DELETE", `/api/invites/${encodeURIComponent(ref)}`, undefined, P.revoked)) {
    await loadInvites();
    render();
  }
}

async function showTab(params) {
  ui.tab = params?.[0] ?? "members";
  // Until the members are read, the tab asked for stands; `load` then checks it.
  if (ui.members === undefined) return;
  ui.tab = membersTab(ui.tab, ui.canManage);
  if (ui.tab === "invites") {
    ui.invites = undefined;
    render();
    await loadInvites();
  }
  render();
}

export function mount(view, route) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML = `<section class="sc mb" aria-label="${esc(C.title)}"></section>`;
  view.append(root);
  ui.root = root;
  ui.last = "";
  ui.members = undefined;
  ui.editing = null;
  ui.inviting = false;
  ui.shown = null;
  ui.error = "";
  ui.invites = undefined;
  ui.tab = route?.params?.[0] ?? "members";
  // FINDINGS TEAM-07: Solo has no Members (DB-N9-12); say so here instead of opening another page.
  if (getSession().mode !== "team") {
    const n = teamOnlyNotice("Members");
    setTopbar({ title: "Members", crumb: "" });
    root.innerHTML = `<div class="ib-empty team-only" role="status"><b>${esc(n.title)}</b><span>${esc(n.text)}</span><a class="btn" href="${esc(n.route)}">${esc(n.action)}</a></div>`;
    return {
      unmount() {
        root.remove();
        ui.root = null;
      },
    };
  }
  root.addEventListener("submit", (e) => {
    const form = e.target instanceof Element ? e.target : null;
    if (!form) return;
    e.preventDefault();
    if (form.matches("[data-mb-invite]")) submitInvite(form);
    else if (form.matches("[data-mb-edit]")) submitEdit(form);
  });
  root.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const menu = t.closest("[data-mb-menu]");
    if (menu) return openRowMenu(menu, menu.getAttribute("data-mb-menu"));
    if (t.closest("[data-mb-invite-open]")) {
      ui.inviting = true;
      ui.shown = null;
      render();
      root.querySelector("#mb-inv-level")?.focus();
      return;
    }
    if (t.closest("[data-mb-cancel]")) {
      ui.inviting = false;
      ui.editing = null;
      render();
      return;
    }
    if (t.closest("[data-mb-copy]") && ui.shown) {
      if (await copyText(new URL(ui.shown.url, location.origin).href))
        toast({ tone: "pass", text: C.copied });
      return;
    }
    const rv = t.closest("[data-mb-revoke]");
    if (rv) return revoke(rv.getAttribute("data-mb-revoke"), rv.getAttribute("data-who"));
    const a = t.closest("[data-mb-act]");
    if (a) {
      const principal = a.getAttribute("data-principal");
      const verb = a.getAttribute("data-mb-act");
      const done =
        verb === "approve"
          ? await act("POST", `/api/members/${principal}/approve`, undefined, C.approve)
          : await act("DELETE", `/api/members/${principal}`, undefined, C.decline);
      if (done) load();
    }
  });
  render();
  void load();
  return {
    setParams(params) {
      void showTab(params);
    },
    unmount() {
      root.remove();
      ui.root = null;
      // A link is shown once: leaving the page forgets it.
      ui.shown = null;
    },
  };
}
