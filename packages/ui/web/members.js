// Members (dashboard §2.17.4, DB-N9-16; teams items 6–10): everyone in the
// workspace — the person with a presence dot, access level, per-project
// levels, profile label and last active — as GitHub's and Linear's member
// tables read. An Admin sees Invite (a single-use link shown once) and, per
// row, change level, set a project level, change label, reset password,
// unlock and remove, and Approve or Decline for a pending person; everyone
// else reads the table, with the Admin's controls disabled and the level
// that can use them written beside (DB-N9-17). Team only (DB-N9-12). Every
// word is `/app/lib/team_admin.js`'s.
import { $, announce, copyText, esc, getJSON, icon, sendJSON } from "./dom.js";
import { refusalMessage } from "./lib/account.js";
import {
  MEMBERS_COPY as C,
  PROFILE_LABELS,
  accessLevelWord,
  levelNote,
  memberRows,
} from "./lib/team_admin.js";
import { openMenu } from "./overlay.js";
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
};

async function load() {
  const [m, p] = await Promise.all([
    getJSON("/api/members").catch(() => ({ ok: false, status: 0 })),
    getJSON("/api/projects").catch(() => ({ ok: false })),
  ]);
  ui.members = m.ok ? (m.data?.members ?? []) : { error: m.status || "no response" };
  ui.canManage = m.ok && m.data?.canManage === true;
  ui.projects = p.ok ? (p.data?.projects ?? []).filter((x) => x.status !== "archived") : [];
  render();
}

const projectNames = () => Object.fromEntries(ui.projects.map((p) => [p.id, p.name]));

function levelOptions(selected) {
  return LEVELS.map(
    (l) =>
      `<option value="${l}"${l === selected ? " selected" : ""}>${esc(accessLevelWord(l))}</option>`,
  ).join("");
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
    fields = `<div class="auth-field"><label for="${id}-level">${esc(C.level)}</label><select id="${id}-level" name="level">${levelOptions(row.level)}</select></div>`;
  else if (e.kind === "override")
    fields = `<div class="auth-field"><label for="${id}-project">${esc(C.overrideProject)}</label><select id="${id}-project" name="project">${projectOptions(false)}</select></div><div class="auth-field"><label for="${id}-level">${esc(C.overrideLevel)}</label><select id="${id}-level" name="level">${levelOptions(row.level)}</select></div>`;
  else if (e.kind === "label")
    fields = `<div class="auth-field"><label for="${id}-label">${esc(C.label)}</label><input id="${id}-label" name="label" type="text" maxlength="80" list="mb-labels" value="${esc(row.label)}" autocomplete="off"><datalist id="mb-labels">${PROFILE_LABELS.map((l) => `<option value="${esc(l)}"></option>`).join("")}</datalist></div>`;
  return `<tr class="mb-edit"><td colspan="6"><form class="mb-form" data-mb-edit="${esc(e.kind)}" data-principal="${esc(row.principal)}" aria-label="${esc(`${e.kind === "level" ? C.changeLevel : e.kind === "override" ? C.override : C.changeLabel}: ${row.name}`)}">${fields}<button class="btn primary" type="submit">${esc(C.save)}</button><button class="btn ghost" type="button" data-mb-cancel>${esc(C.cancel)}</button></form></td></tr>`;
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
  return `<tr data-principal="${esc(row.principal)}"><td data-col="person"><span class="pj-lbl">${esc(C.person)}</span><span class="mb-person"><span class="avatar" aria-hidden="true">${esc(row.initials)}</span>${dot}<span><b>${esc(row.name)}</b>${row.you ? ` <span class="sec">(${esc(C.you)})</span>` : ""}${row.email ? `<span class="sec mb-email">${esc(row.email)}</span>` : ""}${state}</span></span></td><td data-col="level"><span class="pj-lbl">${esc(C.level)}</span>${esc(row.levelWord)}</td><td data-col="overrides"><span class="pj-lbl">${esc(C.overrides)}</span>${overrides}</td><td data-col="label"><span class="pj-lbl">${esc(C.label)}</span>${row.label ? esc(row.label) : `<span class="sec">${esc(C.noLabel)}</span>`}</td><td data-col="active"><span class="pj-lbl">${esc(C.lastActive)}</span><span class="tnum">${esc(row.lastActive)}</span></td><td data-col="actions">${actions}</td></tr>${editorHtml(row)}`;
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
    const invite = `<div class="mb-bar"><button class="btn primary" type="button" data-mb-invite-open${note ? ' disabled aria-describedby="mb-why"' : ""}>${icon("plus", 14, "ic s14")}${esc(C.invite)}</button>${note ? `<span class="sec level-note" id="mb-why">${esc(note)}</span>` : ""}</div>`;
    const table = rows.length
      ? `<div class="tbl-wrap"><table class="tbl pj-tbl mb-tbl"><caption class="sr-only">${esc(C.title)}</caption><thead><tr><th scope="col">${esc(C.person)}</th><th scope="col">${esc(C.level)}</th><th scope="col">${esc(C.overrides)}</th><th scope="col">${esc(C.label)}</th><th scope="col">${esc(C.lastActive)}</th><th scope="col"><span class="sr-only">${esc(C.actions)}</span></th></tr></thead><tbody>${rows.map(rowHtml).join("")}</tbody></table></div>`
      : `<div class="ib-empty">${icon("user", 24, "ic s24")}<b>${esc(C.empty)}</b></div>`;
    body = `<p class="sec">${esc(C.lead)}</p>${invite}${ui.inviting && ui.canManage ? inviteForm() : ""}${ui.error ? `<p class="auth-error" role="alert">${esc(ui.error)}</p>` : ""}${shownHtml()}${table}`;
  }
  setTopbar({
    title: C.title,
    crumb: Array.isArray(v) ? `${v.length} ${v.length === 1 ? "person" : "people"}` : "",
  });
  if (body === ui.last) return;
  ui.last = body;
  $(".sc", ui.root).innerHTML = body;
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
      run: async () => {
        if (!window.confirm(C.removeConfirm(row.name))) return;
        if (await act("DELETE", `/api/members/${principal}`, undefined, C.remove)) load();
      },
    });
  }
  openMenu(anchor, items, { heading: row.name });
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

export function mount(view) {
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
  // Solo has no Members (DB-N9-12): its one person is the whole workspace.
  if (getSession().mode !== "team") {
    location.replace("#/");
    return { unmount() {} };
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
    unmount() {
      root.remove();
      ui.root = null;
      // A link is shown once: leaving the page forgets it.
      ui.shown = null;
    },
  };
}
