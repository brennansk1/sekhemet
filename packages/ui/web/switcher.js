// DEC-57's two switchers (dashboard §2.2 item 7, NEW-dashboard-25,
// DB-N25-1..4; FINDINGS SHL-01): the project switcher at the head of the
// sidebar's Project group — the current project's badge and name, never the
// repository's path, which is in its tooltip — and the account menu's Switch
// workspace, listing the workspaces this machine's person has used. The
// project the person chose is kept in this browser, like the theme, and is
// the current project of every project page. Every word is
// `/app/lib/switcher.js`'s.
import { $, $$, esc, getJSON, icon, sendJSON, tip } from "./dom.js";
import { noteFor } from "./level_gate.js";
import { projectSwitcher, workspaceSwitcher } from "./lib/switcher.js";
import { pushOverlay, trapFocus } from "./overlay.js";
import { getSession } from "./session.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

const PROJECT_KEY = "sekhemet-project";

function stored() {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function keep(id) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // Private mode: the choice lasts for this page.
  }
}

/** The list as the switcher reads it: id, name, state and root, from the overview. */
function listOf(overview) {
  return (overview?.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.state,
    state: p.state,
    ...(p.rootPath ? { rootPath: p.rootPath } : {}),
  }));
}

/**
 * The projects this person can see (`GET /api/projects/overview`), and the
 * current one: the one this browser chose, else the first. Returns the
 * current id, or null with no project.
 */
export async function loadProjects() {
  const r = await getJSON("/api/projects/overview");
  if (!r.ok) return store.state.project?.id ?? null;
  const list = listOf(r.data?.overview);
  const want = store.state.project?.id ?? stored();
  const chosen = list.find((p) => p.id === want) ?? list[0] ?? null;
  store.set({
    project: {
      ...store.state.project,
      id: chosen?.id ?? null,
      name: chosen?.name ?? null,
      list,
    },
  });
  return chosen?.id ?? null;
}

/** The list a page already read (Projects): kept, with the current project's name. */
export function setProjectList(overview) {
  const list = listOf(overview);
  const id = store.state.project?.id;
  const current = list.find((p) => p.id === id);
  store.set({
    project: { ...store.state.project, list, ...(current ? { name: current.name } : {}) },
  });
}

/**
 * Make a project current (DB-N25-2): every project page reads it, the
 * person stays on the same kind of page, and this browser keeps it.
 */
export function chooseProject(id, { stay = false } = {}) {
  const p = store.state.project?.list?.find((x) => x.id === id);
  if (!p) return;
  keep(id);
  if (store.state.project?.id === id) return;
  store.set({ project: { ...store.state.project, id, name: p.name } });
  window.dispatchEvent(new CustomEvent("sekhemet:project", { detail: { stay } }));
}

/**
 * A link that opens an issue of another project makes that project current
 * (DB-N25-2); the issue's own page stays as it is.
 */
export async function followIssueProject(cardId) {
  if (!cardId || !store.state.project?.list?.length) return;
  let project = store.card(cardId)?.projectId;
  if (!project) {
    const r = await getJSON(`/api/cards/${encodeURIComponent(cardId)}`);
    project = r.ok ? r.data?.card?.projectId : undefined;
  }
  if (project && project !== store.state.project.id) chooseProject(project, { stay: true });
}

/** The sidebar's button (DB-N25-1): badge and name, the path in its tooltip only. */
export function projectSwitcherHtml() {
  const s = store.state.project ?? {};
  if (!s.list?.length) return "";
  const v = projectSwitcher(s.list, s.id, { canCreate: false });
  return `<button class="proj-switch" type="button" data-project-switch aria-haspopup="listbox" aria-expanded="false" ${tip(v.title)}><span class="proj-badge" aria-hidden="true">${esc(v.initials)}</span><span class="lbl">${esc(v.label)}</span><span class="sr-only">, switch project</span>${icon("chevron-down", 14, "ic s14")}</button>`;
}

let openNow = null;

function closeSwitcher() {
  if (!openNow) return;
  const { node, remove, anchor } = openNow;
  openNow = null;
  remove();
  node.remove();
  document.removeEventListener("pointerdown", outside, true);
  anchor?.setAttribute?.("aria-expanded", "false");
  anchor?.focus?.({ preventScroll: true });
}

function outside(e) {
  if (openNow && !openNow.node.contains(e.target) && !openNow.anchor?.contains?.(e.target))
    closeSwitcher();
}

/** New project: the start page the Projects page opens (design-stage §2.11, DS-N7-1). */
function newProject() {
  location.hash = "#/projects/new";
}

/**
 * The project switcher's list (DB-N25-2): every project the person can see,
 * filtered as they type, *New project* at its foot for who may create one.
 */
export function openProjectSwitcher(anchor) {
  if (openNow) return closeSwitcher();
  const canCreate = !noteFor("project.create");
  const node = document.createElement("div");
  node.className = "menu proj-menu";
  node.dataset.menu = "";
  node.innerHTML = `<label class="sr-only" for="proj-filter">Find a project</label><input id="proj-filter" class="proj-filter" type="search" autocomplete="off" placeholder="Find a project…" role="combobox" aria-controls="proj-list" aria-expanded="true"><div id="proj-list" role="listbox" aria-label="Projects"></div><div class="proj-foot"></div>`;
  document.getElementById("overlay-root").append(node);
  const input = $("#proj-filter", node);
  const draw = () => {
    const v = projectSwitcher(store.state.project?.list ?? [], store.state.project?.id, {
      canCreate,
      filter: input.value,
    });
    $("#proj-list", node).innerHTML = v.empty
      ? `<p class="sec proj-empty">${esc(v.empty)}</p>`
      : v.rows
          .map(
            (r) =>
              `<button type="button" role="option" aria-selected="${r.current}" data-choose="${esc(r.id)}"><span class="proj-badge" aria-hidden="true">${esc(r.initials)}</span><span class="proj-name">${esc(r.name)}</span>${r.detail ? `<span class="sec proj-detail">${esc(r.detail)}</span>` : ""}</button>`,
          )
          .join("");
    $(".proj-foot", node).innerHTML = v.newProject
      ? `<hr><button type="button" data-new-project>${icon("plus", 14, "ic s14")}${esc(v.newProject.label)}</button>`
      : "";
  };
  draw();
  const r = anchor.getBoundingClientRect();
  node.style.left = `${Math.max(8, r.left)}px`;
  node.style.top = `${r.bottom + 4}px`;
  node.style.minWidth = `${Math.max(220, r.width)}px`;
  anchor.setAttribute("aria-expanded", "true");
  input.addEventListener("input", draw);
  node.addEventListener("click", (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const choose = t?.closest("[data-choose]");
    if (choose) {
      const id = choose.dataset.choose;
      closeSwitcher();
      chooseProject(id);
    } else if (t?.closest("[data-new-project]")) {
      closeSwitcher();
      newProject();
    }
  });
  const remove = pushOverlay({
    kind: "menu",
    modal: true,
    close: () => closeSwitcher(),
    onKey: (e) => {
      if (trapFocus(node, e)) return true;
      const items = $$("[role=option], [data-new-project]", node);
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") {
        items[(i + 1) % items.length]?.focus();
        e.preventDefault();
        return true;
      }
      if (e.key === "ArrowUp") {
        if (i <= 0) input.focus();
        else items[i - 1]?.focus();
        e.preventDefault();
        return true;
      }
      return e.key !== "Escape" && e.key !== "Enter" && e.key !== " " && e.key !== "Tab";
    },
  });
  openNow = { node, remove, anchor };
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  input.focus();
}

/* ---------- Switch workspace (DB-N25-3) ---------- */

let dialog = null;

function closeWorkspaces() {
  if (!dialog) return;
  const { node, remove, invoker } = dialog;
  dialog = null;
  remove();
  node.remove();
  invoker?.focus?.({ preventScroll: true });
}

async function drawWorkspaces() {
  if (!dialog) return;
  const body = $(".ws-body", dialog.node);
  const r = await getJSON("/api/workspaces");
  if (!dialog) return;
  if (!r.ok) {
    body.innerHTML = `<p role="alert">${esc(r.data?.error ?? "Couldn't load the workspaces.")} <button class="link-btn" type="button" data-ws-retry>Try again</button></p>`;
    return;
  }
  const setup = getSession().mode === "team" ? "team" : "solo";
  const v = workspaceSwitcher(r.data, { setup });
  const rows = v.rows
    .map(
      (w) =>
        `<li${w.current ? ' aria-current="true"' : ""}><a class="ws-open" href="${esc(w.href)}" data-ws-open><b>${esc(w.label)}</b><span class="sec">${esc(w.detail)}</span>${w.current ? '<span class="ws-here">This workspace</span>' : ""}</a>${w.removable ? `<button class="btn sm ghost" type="button" data-ws-remove="${esc(w.id)}" aria-label="${esc(`Remove ${w.label}`)}">Remove</button>` : ""}</li>`,
    )
    .join("");
  const label = v.add.kind === "add" ? "Address of the workspace to add" : "Address to open";
  body.innerHTML = `<ul class="ws-list">${rows}</ul><form class="ws-add" data-ws-add="${v.add.kind}"><label for="ws-address">${esc(v.add.label)}</label><p class="sec" id="ws-hint">${esc(label)}, such as http://192.168.1.20:7420. It opens with its own sign-in; nothing from this workspace is sent to it.</p><div class="row"><input id="ws-address" type="url" required placeholder="http://" aria-describedby="ws-hint"><button class="btn" type="submit">${v.add.kind === "add" ? "Add" : "Open"}</button></div><p class="why" role="status" data-ws-note></p></form>`;
}

/** The account menu's Switch workspace: this machine's workspaces, each opened at its own address. */
export function openWorkspaceSwitcher() {
  if (dialog) return closeWorkspaces();
  const node = document.createElement("div");
  node.className = "scrim";
  node.innerHTML = `<div class="dialog ws-dialog" role="dialog" aria-modal="true" aria-labelledby="ws-h"><header><h2 id="ws-h">Switch workspace</h2><button class="icon-btn" type="button" data-close aria-label="Close (Esc)">${icon("x")}</button></header><div class="ws-body"><div class="sk" style="height:80px"></div></div></div>`;
  document.getElementById("overlay-root").append(node);
  const invoker = document.activeElement;
  const remove = pushOverlay({
    kind: "workspaces",
    modal: true,
    close: () => closeWorkspaces(),
    // Keys stay in the dialog: Tab cycles, Esc closes, typing types.
    onKey: (e) => trapFocus(node, e) || e.key !== "Escape",
  });
  dialog = { node, remove, invoker };
  node.addEventListener("click", async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (e.target === node || t?.closest("[data-close]")) closeWorkspaces();
    else if (t?.closest("[data-ws-retry]")) drawWorkspaces();
    else if (t?.closest("[data-ws-remove]")) {
      const id = t.closest("[data-ws-remove]").dataset.wsRemove;
      const r = await sendJSON("DELETE", `/api/workspaces/${encodeURIComponent(id)}`);
      if (!r.ok) toast({ tone: "fail", text: "Couldn't remove it.", detail: r.data?.error ?? "" });
      drawWorkspaces();
    }
  });
  node.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const address = $("#ws-address", form)?.value ?? "";
    const note = $("[data-ws-note]", form);
    if (form.dataset.wsAdd === "open") {
      // A Team server keeps no list of yours: the address opens in this tab.
      try {
        const url = new URL(address);
        if (url.protocol === "http:" || url.protocol === "https:") {
          location.href = `${url.origin}/`;
          return;
        }
      } catch {
        // Fall through to the sentence below.
      }
      if (note)
        note.textContent = "Give the workspace's address, such as http://192.168.1.20:7420.";
      return;
    }
    const r = await sendJSON("POST", "/api/workspaces", { address });
    if (!r.ok) {
      if (note) note.textContent = r.data?.error ?? "Not added.";
      return;
    }
    drawWorkspaces();
  });
  drawWorkspaces().then(() => $("[data-close]", node)?.focus());
}
