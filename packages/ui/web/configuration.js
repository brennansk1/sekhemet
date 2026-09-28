// Configuration (dashboard §2.16, NEW-dashboard-6): one page with the
// sections Models, Benchmark, Review capacity, Preferences and Project
// configuration, each addressable (`#/configuration/<section>`). `#/registry`
// opens Benchmark and `#/settings` opens Preferences (DB-N6-1; DEC-31 names
// the section *Preferences*, never "This browser"). It replaces the Registry
// and Settings views. Preferences holds the theme, Tips and the first-run
// role (this browser's, §2.9.1, §2.2.5) and the project's Estimation (DB-N7-2: off, or story points), kept per project.
// Review capacity and Project configuration are NEW-dashboard-4's (DB-N4-1..3):
// the project's minutes a day with the In review limit they give, disabled
// with its reason for a person who may not change them, and every effective
// value with the file it came from.
import { esc, getJSON, sendJSON } from "./dom.js";
import { setTips, storage, tipsOn } from "./learn.js";
import { FIRST_RUN, readRole, writeRole } from "./lib/learn.js";
import { ESTIMATION_LABELS } from "./lib/pm.js";
import {
  DENSITY_CHOICES,
  configRows,
  readDensity,
  reviewCapacityView,
  reviewMinutesInput,
} from "./lib/settings.js";
import { getSession } from "./session.js";
import { currentThemeChoice, setDensity, setTheme, setTopbar } from "./shell.js";
import { store } from "./store.js";

export const SECTIONS = [
  { id: "models", label: "Models" },
  { id: "benchmark", label: "Benchmark" },
  { id: "review", label: "Review capacity" },
  { id: "preferences", label: "Preferences" },
  { id: "project", label: "Project configuration" },
];

/** The section a route opens (DB-N6-1). */
export function sectionFor(name, params = []) {
  if (name === "registry") return "benchmark";
  if (name === "settings") return "preferences";
  // The section's former address, kept so an old link still opens it.
  const want = params[0] === "browser" ? "preferences" : params[0];
  return SECTIONS.some((s) => s.id === want) ? want : "models";
}

/** Why a non-Admin sees the server's settings read-only in the Team setup (DB-N6-15). */
function readOnlyReason() {
  const s = getSession();
  if (s.mode !== "team") return "";
  return s.level === "admin"
    ? ""
    : "Read-only: an Admin changes the models, the benchmark and the project's configuration.";
}

const ui = { root: null, section: "models", child: null, capacity: null };

function tabsHtml() {
  return `<nav class="cfg-tabs" aria-label="Configuration sections">${SECTIONS.map(
    (s) =>
      `<a class="btn sm" href="#/configuration/${s.id}"${s.id === ui.section ? ' aria-current="page"' : ""}>${esc(s.label)}</a>`,
  ).join("")}</nav>`;
}

async function mountBenchmark(host) {
  try {
    const mod = await import("./config_benchmark.js");
    const mountFn = mod.mountBenchmark ?? mod.mount;
    if (typeof mountFn === "function") {
      const child = mountFn(host, { readOnly: readOnlyReason() }) ?? {};
      // Its `config` frames (`{ kind: "benchmark", run }`) refresh it.
      const onConfig = (ev) => {
        if (ev.detail?.kind === "benchmark") child.refresh?.(ev.detail);
      };
      window.addEventListener("sekhemet:config", onConfig);
      return {
        ...child,
        unmount() {
          window.removeEventListener("sekhemet:config", onConfig);
          child.unmount?.();
        },
      };
    }
  } catch {
    // Not built yet: the registry's bake-off matrix stands in.
  }
  const reg = await import("./registry.js");
  return reg.mount(host);
}

function reviewHtml(cfg) {
  const cap = cfg?.reviewCapacity;
  const project = store.state.project;
  ui.capacity = cap ?? null;
  if (!cap) {
    const minutes = cfg?.config?.review?.reviewMinutesPerDay ?? 60;
    return `<section class="cfg-sec" aria-labelledby="cfg-h-review"><h3 id="cfg-h-review">Review capacity</h3><p>Review minutes per day set the In review limit.</p><p class="sec">The default is ${esc(`${minutes} minutes a day`)}. Choose a project in the sidebar to change its own.</p></section>`;
  }
  const v = reviewCapacityView(cap);
  const why = v.disabled ? ' aria-describedby="cfg-review-why"' : "";
  return `<section class="cfg-sec" aria-labelledby="cfg-h-review"><h3 id="cfg-h-review">Review capacity</h3><p>Review minutes per day set the In review limit: how many issues may wait for review at once.</p><form class="row" data-review-form><label for="cfg-review">Minutes a day for ${esc(project?.name ?? cap.project)}</label><input id="cfg-review" type="text" inputmode="numeric" name="minutes" value="${esc(v.value)}"${v.disabled ? " disabled" : ""}${why}><button class="btn" type="submit"${v.disabled ? " disabled" : ""}${why}>Save</button></form>${v.disabled ? `<p class="why" id="cfg-review-why">${esc(v.reason)}</p>` : ""}<p class="sec" data-review-limit>${esc(v.limitText)}</p><p class="why" role="status" data-review-note></p></section>`;
}

function preferencesHtml() {
  const choice = currentThemeChoice();
  const opt = (v, label) =>
    `<option value="${v}"${choice === v ? " selected" : ""}>${label}</option>`;
  const density = readDensity(storage());
  const dens = DENSITY_CHOICES.map(
    (c) =>
      `<option value="${c.value}"${density === c.value ? " selected" : ""}>${esc(c.label)}</option>`,
  ).join("");
  return `<section class="cfg-sec" aria-labelledby="cfg-h-preferences"><h3 id="cfg-h-preferences">Preferences</h3><div class="row"><label for="cfg-theme">Theme</label><select id="cfg-theme" data-theme-select>${opt("system", "Match the system")}${opt("dark", "Basalt (dark)")}${opt("light", "Sand (light)")}</select></div><div class="row"><label for="cfg-density">Density</label><select id="cfg-density" data-density-select aria-describedby="cfg-density-why">${dens}</select></div><p class="sec" id="cfg-density-why">Comfortable board cards add the plan's first line and the token and time bars. The theme and density apply to this browser only and need no permission.</p>${tipsHtml()}${estimationHtml()}</section>`;
}

/** Tips and the first-run role: this browser's, like the theme (§2.9.1, §2.2.5). */
function tipsHtml() {
  const on = tipsOn();
  const role = readRole(storage()) ?? "later";
  const roles = [...FIRST_RUN.choices.map((c) => [c.role, c.label]), ["later", "Not answered"]]
    .map(
      ([v, label]) =>
        `<option value="${esc(v)}"${role === v ? " selected" : ""}>${esc(label)}</option>`,
    )
    .join("");
  return `<div class="row"><label for="cfg-tips">Tips</label><select id="cfg-tips" data-tips-select aria-describedby="cfg-tips-why"><option value="on"${on ? " selected" : ""}>On</option><option value="off"${on ? "" : " selected"}>Off</option></select></div><p class="sec" id="cfg-tips-why">Tips put a ? beside each column, check and chart that explains it with this project's numbers.</p><div class="row"><label for="cfg-role">How you use Sekhemet</label><select id="cfg-role" data-role-select aria-describedby="cfg-role-why">${roles}</select></div><p class="sec" id="cfg-role-why">Sets the page Sekhemet opens on.</p>`;
}

/**
 * Preferences → Estimation (DEC-31, DB-N7-2): the project's, for everyone on
 * it. Off (the default) shows no points on cards, columns or reports and
 * counts work in issues; Story points shows them as Jira does.
 */
function estimationHtml() {
  const project = store.state.project;
  if (!project?.id) {
    return '<h4 id="cfg-h-estimation">Estimation</h4><p class="sec">Choose a project in the sidebar to set its estimation.</p>';
  }
  const current = store.state.estimation === "points" ? "points" : "off";
  const ro = readOnlyReason();
  const opt = (v) =>
    `<option value="${v}"${current === v ? " selected" : ""}>${esc(ESTIMATION_LABELS[v])}</option>`;
  return `<h4 id="cfg-h-estimation">Estimation</h4><div class="row"><label for="cfg-estimation">Estimation for ${esc(project.name ?? project.id)}</label><select id="cfg-estimation" data-estimation-select aria-describedby="cfg-estimation-why"${ro ? " disabled" : ""}>${opt("off")}${opt("points")}</select></div><p class="sec" id="cfg-estimation-why">Kept for the whole project. Off, no points show on board cards, columns or reports, and work is counted in issues; Story points shows them.${ro ? ` ${esc(ro)}` : ""}</p><p class="why" role="status" data-estimation-note></p>`;
}

async function saveEstimation(value) {
  const project = store.state.project?.id;
  const note = ui.root?.querySelector("[data-estimation-note]");
  if (!project) return;
  const r = await sendJSON("PATCH", `/api/projects/${encodeURIComponent(project)}/settings`, {
    estimation: value,
  });
  if (r.ok) {
    const on = r.data?.settings?.estimation === "points" ? "points" : "off";
    store.set({ estimation: on });
    if (note) note.textContent = `Saved: ${ESTIMATION_LABELS[on]}.`;
  } else if (note) {
    note.textContent = r.data?.error ?? "Not saved.";
  }
}

function projectHtml(cfg) {
  if (!cfg) return '<div class="sk" style="height:120px"></div>';
  if (cfg.error) return `<p role="alert">${esc(cfg.error)}</p>`;
  const c = cfg.config ?? {};
  // Every effective value with where it came from (DB-N4-1).
  const rows = configRows(c, cfg.sources ?? {})
    .map(
      (r) =>
        `<tr><th scope="row">${esc(r.label)}</th><td>${esc(r.value)}</td><td class="sec">${esc(r.source)} <span class="mono">${esc(r.key)}</span></td></tr>`,
    )
    .join("");
  const problems = (cfg.problems ?? []).map((p) => `<li>${esc(p)}</li>`).join("");
  return `<section class="cfg-sec" aria-labelledby="cfg-h-project"><h3 id="cfg-h-project">Project configuration</h3><p class="sec">The values in force, and the file each came from. Edit the files to change them.</p><div class="tbl-wrap"><table class="tbl"><thead><tr><th scope="col">Setting</th><th scope="col">Value</th><th scope="col">From</th></tr></thead><tbody>${rows}</tbody></table></div>${problems ? `<h4>Problems</h4><ul class="cfg-warn">${problems}</ul>` : ""}</section>`;
}

async function renderSection() {
  if (!ui.root) return;
  ui.child?.unmount?.();
  ui.child = null;
  ui.root.querySelector(".cfg-tabs-host").innerHTML = tabsHtml();
  const host = ui.root.querySelector(".cfg-body");
  host.textContent = "";
  const label = SECTIONS.find((s) => s.id === ui.section)?.label ?? "";
  setTopbar({ title: "Configuration", crumb: label });
  if (ui.section === "models") {
    const mod = await import("./config_models.js");
    ui.child = mod.mount(host, { readOnly: readOnlyReason() });
  } else if (ui.section === "benchmark") {
    ui.child = await mountBenchmark(host);
  } else if (ui.section === "preferences") {
    host.innerHTML = preferencesHtml();
  } else {
    host.innerHTML = '<div class="sk" style="height:120px"></div>';
    const project = store.state.project?.id;
    const r = await getJSON(
      `/api/config${project ? `?project=${encodeURIComponent(project)}` : ""}`,
    ).catch(() => ({ ok: false, data: null }));
    const cfg = r.ok ? r.data : { error: r.data?.error ?? "The configuration could not be read." };
    host.innerHTML = ui.section === "review" ? reviewHtml(cfg) : projectHtml(cfg);
  }
}

async function onSubmit(e) {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form?.hasAttribute("data-review-form")) return;
  e.preventDefault();
  const field = form.elements.namedItem("minutes");
  const note = ui.root.querySelector("[data-review-note]");
  const previous = ui.capacity?.minutesPerDay ?? 60;
  // 0 or less is refused beside the field; the previous value stays (DB-N4-3).
  const input = reviewMinutesInput(field?.value ?? "", previous);
  if (!input.ok) {
    if (field) field.value = String(input.value);
    if (note) note.textContent = input.error;
    return;
  }
  const r = await sendJSON("PUT", "/api/config/review", {
    project: ui.capacity?.project ?? store.state.project?.id,
    minutesPerDay: input.value,
  });
  if (!r.ok) {
    if (field) field.value = String(previous);
    if (note) note.textContent = r.data?.error ?? "Not saved.";
    return;
  }
  // The recomputed limit, at once (DB-N4-2).
  ui.capacity = {
    ...(ui.capacity ?? { project: r.data?.project, allowed: true }),
    minutesPerDay: r.data?.minutesPerDay ?? input.value,
    ...(r.data?.reviewWip !== undefined ? { reviewWip: r.data.reviewWip } : {}),
  };
  const limit = ui.root.querySelector("[data-review-limit]");
  if (limit) limit.textContent = reviewCapacityView(ui.capacity).limitText;
  if (note) note.textContent = "Saved.";
}

function onChange(e) {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-theme-select")) setTheme(t.value);
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-density-select")) setDensity(t.value);
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-tips-select"))
    setTips(t.value === "on");
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-role-select"))
    writeRole(storage(), t.value);
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-estimation-select")) {
    saveEstimation(t.value === "points" ? "points" : "off");
  }
}

export function mount(view, parsed = { name: "configuration", params: [] }) {
  const root = document.createElement("div");
  root.className = "view-host";
  root.innerHTML =
    '<div class="cfg"><p class="cfg-lede">Choose which models do each job, and compare them on this machine. Nothing is downloaded, loaded or run until you press the button.</p><div class="cfg-tabs-host"></div><div class="cfg-body"></div></div>';
  view.append(root);
  ui.root = root;
  ui.section = sectionFor(parsed.name, parsed.params);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("change", onChange);
  renderSection();
  return {
    setParams(params) {
      const next = sectionFor("configuration", params);
      if (next === ui.section) return;
      ui.section = next;
      renderSection();
    },
    unmount() {
      ui.child?.unmount?.();
      ui.child = null;
      root.remove();
      ui.root = null;
    },
  };
}
