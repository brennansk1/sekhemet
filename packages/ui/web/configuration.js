// Configuration (dashboard §2.16, NEW-dashboard-6): one page with the
// sections Models, Benchmark, Review capacity, This browser and Project
// configuration, each addressable (`#/configuration/<section>`). `#/registry`
// opens Benchmark and `#/settings` opens This browser (DB-N6-1). It replaces
// the Registry and Settings views.
import { esc, getJSON, sendJSON } from "./dom.js";
import { getSession } from "./session.js";
import { currentThemeChoice, setTheme, setTopbar } from "./shell.js";
import { store } from "./store.js";

export const SECTIONS = [
  { id: "models", label: "Models" },
  { id: "benchmark", label: "Benchmark" },
  { id: "review", label: "Review capacity" },
  { id: "browser", label: "This browser" },
  { id: "project", label: "Project configuration" },
];

/** The section a route opens (DB-N6-1). */
export function sectionFor(name, params = []) {
  if (name === "registry") return "benchmark";
  if (name === "settings") return "browser";
  const want = params[0];
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

const ui = { root: null, section: "models", child: null };

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
  const minutes = cfg?.config?.review?.reviewMinutesPerDay ?? 60;
  const project = store.state.project;
  return `<section class="cfg-sec" aria-labelledby="cfg-h-review"><h3 id="cfg-h-review">Review capacity</h3><p>Review minutes per day set the review WIP limit.</p>${
    project
      ? `<form class="row" data-review-form><label for="cfg-review">Minutes a day for ${esc(project.name ?? project.id)}</label><input id="cfg-review" type="text" inputmode="numeric" name="minutes" value="${esc(project.reviewMinutesPerDay ?? minutes)}"><button class="btn" type="submit">Save</button></form>`
      : `<p class="sec">The default is ${esc(`${minutes} minutes a day`)}. Choose a project in the sidebar to change its own.</p>`
  }<p class="why" data-review-note></p></section>`;
}

function browserHtml() {
  const choice = currentThemeChoice();
  const opt = (v, label) =>
    `<option value="${v}"${choice === v ? " selected" : ""}>${label}</option>`;
  return `<section class="cfg-sec" aria-labelledby="cfg-h-browser"><h3 id="cfg-h-browser">This browser</h3><p class="sec">These apply to this browser only and need no permission.</p><div class="row"><label for="cfg-theme">Theme</label><select id="cfg-theme" data-theme-select>${opt("system", "Match the system")}${opt("dark", "Basalt (dark)")}${opt("light", "Sand (light)")}</select></div></section>`;
}

function projectHtml(cfg) {
  if (!cfg) return '<div class="sk" style="height:120px"></div>';
  if (cfg.error) return `<p role="alert">${esc(cfg.error)}</p>`;
  const c = cfg.config ?? {};
  const rows = [
    ["Reserved hours", c.machine?.reservedHours],
    ["Overnight hours", c.machine?.overnightHours ?? "The complement of the reserved hours"],
    ["Network", c.network?.mode],
    ["Setup", c.team?.mode],
  ]
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("");
  const problems = (cfg.problems ?? []).map((p) => `<li>${esc(p)}</li>`).join("");
  return `<section class="cfg-sec" aria-labelledby="cfg-h-project"><h3 id="cfg-h-project">Project configuration</h3><p class="sec">Read from ${esc((cfg.layers ?? []).join(", "))}. Edit the files to change it.</p><div class="cfg-detail"><dl>${rows}</dl></div>${problems ? `<h4>Problems</h4><ul class="cfg-warn">${problems}</ul>` : ""}</section>`;
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
  } else if (ui.section === "browser") {
    host.innerHTML = browserHtml();
  } else {
    host.innerHTML = '<div class="sk" style="height:120px"></div>';
    const r = await getJSON("/api/config").catch(() => ({ ok: false, data: null }));
    const cfg = r.ok ? r.data : { error: r.data?.error ?? "The configuration could not be read." };
    host.innerHTML = ui.section === "review" ? reviewHtml(cfg) : projectHtml(cfg);
  }
}

async function onSubmit(e) {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form?.hasAttribute("data-review-form")) return;
  e.preventDefault();
  const minutes = Number(form.elements.namedItem("minutes")?.value);
  const note = ui.root.querySelector("[data-review-note]");
  if (!Number.isFinite(minutes) || minutes <= 0) {
    if (note) note.textContent = "Review minutes per day must be more than 0.";
    return;
  }
  const r = await sendJSON("PUT", "/api/config/review", {
    project: store.state.project?.id,
    minutesPerDay: minutes,
  });
  if (note) note.textContent = r.ok ? "Saved." : (r.data?.error ?? "Not saved.");
}

function onChange(e) {
  const t = e.target;
  if (t instanceof HTMLSelectElement && t.hasAttribute("data-theme-select")) setTheme(t.value);
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
