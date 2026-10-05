// Configuration › Models › Customize (dashboard NEW-dashboard-27, DB-N27-2..5;
// models NEW-models-21): one role's settings for one model in five tabs —
// Basics, Sampling, Reasoning, Engine and Harness — every value with its
// grade in words and where it came from, *Reset* beside a person's value,
// the context slider's fit recomputed as it moves (nothing loads), the
// Fast / Balanced / Careful presets, *Verify now* when a change needs it,
// and Export and Import of the role's settings as a file. Served by
// `/api/config/roles/:role/settings…` (PM_CONTRACT §3 *A role's settings*).
import { announce, esc, getJSON, sendJSON } from "./dom.js";
import { getSession } from "./session.js";

const TABS = [
  { id: "basics", label: "Basics" },
  { id: "sampling", label: "Sampling" },
  { id: "reasoning", label: "Reasoning" },
  { id: "engine", label: "Engine" },
  { id: "harness", label: "Harness" },
];
const ROLE_NAME = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};
const GRADE_WORD = {
  measured: "Measured",
  card: "From its makers",
  estimated: "Estimated",
  default: "Default",
};
const PRESETS = [
  { id: "fast", label: "Fast", help: "No thinking; MTP where it was measured faster." },
  { id: "balanced", label: "Balanced", help: "The graded values, with no preset." },
  {
    id: "careful",
    label: "Careful",
    help: "Medium reasoning, the evidence check and the strict method.",
  },
];
const CHOICE_WORD = {
  auto: "Automatic",
  off: "Off",
  on: "On",
  surgical: "On repairs and plans",
  all: "On every step",
  low: "Low",
  medium: "Medium",
  high: "High",
  none: "None",
  mmap: "Memory-mapped",
  no_mmap: "Read in full",
  baseline: "Baseline",
  strict: "Strict",
  arm_a_flat: "Native tool calls",
  arm_b_json: "JSON in the reply",
  arm_c_sketch: "A script sketch",
};

const day = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

/** A value's grade in words (MD-N21-1): the four grades, or who set it and when. */
export function gradeText(v) {
  if (!v) return "";
  if (v.grade === "set") {
    const me = getSession()?.principal;
    const who = v.by && me && v.by === me ? "you" : v.by ? "a teammate" : "";
    return `Set${who ? ` by ${who}` : ""}${v.at ? ` · ${day(v.at)}` : ""}`;
  }
  return GRADE_WORD[v.grade] ?? "Default";
}

/** A value as a person reads it. */
export function valueText(field, value) {
  if (field.kind === "bool") return value ? "On" : "Off";
  if (field.kind === "choice") return CHOICE_WORD[value] ?? String(value);
  if (field.key === "contextTokens") return `${Number(value).toLocaleString("en")} tokens`;
  if (field.key === "seed" && value === -1) return "Random";
  return String(value);
}

/** The role's verification in words (DB-N27-3). */
export function verificationText(v) {
  if (!v) return "";
  if (v.state === "verified") return "Verified on this machine with these settings.";
  if (v.state === "needs_verifying")
    return `Needs verifying: ${(v.changed ?? []).join(", ") || "its settings"} changed since it was verified. The Agent does not use this role until it passes.`;
  return "Not verified on this machine for this role yet.";
}

/** The context slider's fit in words: *13.2 GB of 16.0 GB usable*, or what it needs. */
export function fitText(fit) {
  if (!fit) return "";
  if (fit.fits === "no") return fit.reason;
  return fit.fits === "swaps" ? `Fits; ${fit.reason}` : `Fits: ${fit.reason}`;
}

export function mountCustomize(host, opts) {
  const st = {
    role: opts.role,
    model: opts.model,
    tab: "basics",
    data: null,
    edits: {},
    refusal: null,
    note: "",
    fit: null,
    busy: false,
    gone: false,
    timer: 0,
  };
  const ro = opts.readOnly || "";
  const dis = ro ? ' disabled aria-describedby="cust-ro"' : "";
  const roleName = ROLE_NAME[st.role] ?? st.role;

  const load = async (context) => {
    const q = new URLSearchParams({ model: st.model });
    if (context) q.set("context", String(context));
    const r = await getJSON(`/api/config/roles/${st.role}/settings?${q}`);
    if (st.gone) return;
    if (context) {
      // A fit read while the slider moves updates the fit alone: a full
      // render would replace the slider under the person's pointer.
      if (r.ok) st.fit = r.data.fit ?? null;
      const p = host.querySelector("#cust-fit");
      if (p)
        p.textContent = r.ok ? fitText(st.fit) : (r.data?.error ?? "The fit could not be read.");
      return;
    }
    if (!r.ok) {
      st.data = { error: r.data?.error ?? "The settings could not be read." };
    } else {
      st.data = r.data;
      st.fit = r.data.fit ?? null;
    }
    render();
  };

  const current = (key) => {
    if (key in st.edits) return st.edits[key];
    return (st.data?.values ?? []).find((v) => v.key === key)?.value;
  };

  const fieldHtml = (f) => {
    const v = (st.data.values ?? []).find((x) => x.key === f.key);
    const id = `cust-${f.key}`;
    const val = current(f.key);
    const hint = (st.data.hints ?? []).filter((h) => h.key === f.key);
    const refused = st.refusal?.key === f.key ? st.refusal.error : "";
    const descr = [`${id}-g`, hint.length ? `${id}-h` : "", refused ? `${id}-e` : ""]
      .filter(Boolean)
      .join(" ");
    let control;
    if (f.readOnly)
      control = `<span class="cust-ro-val" id="${id}">${esc(valueText(f, val))}</span>`;
    else if (f.kind === "bool")
      control = `<input id="${id}" type="checkbox" data-field="${f.key}"${val ? " checked" : ""} aria-describedby="${descr}"${dis}>`;
    else if (f.kind === "choice")
      control = `<select id="${id}" data-field="${f.key}" aria-describedby="${descr}"${dis}>${(
        f.options ?? []
      )
        .map(
          (o) =>
            `<option value="${esc(o)}"${String(val) === o ? " selected" : ""}>${esc(CHOICE_WORD[o] ?? o)}</option>`,
        )
        .join("")}</select>`;
    else
      control = `<input id="${id}" type="number" inputmode="decimal" data-field="${f.key}" value="${esc(val)}"${f.min !== undefined ? ` min="${f.min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""}${f.step !== undefined ? ` step="${f.step}"` : ""} aria-describedby="${descr}"${dis}>`;
    const reset =
      v?.grade === "set" && !ro
        ? `<button class="btn sm" type="button" data-reset="${f.key}" aria-label="Reset ${esc(f.label)}">Reset</button>`
        : "";
    return `<div class="cust-field" data-key="${f.key}"><label for="${id}">${esc(f.label)}</label><div class="cust-ctl">${control}${reset}</div><p class="cust-grade" id="${id}-g"><span class="grade" data-grade="${esc(v?.grade ?? "default")}">${esc(gradeText(v))}</span> <span class="sec">${esc(v?.source ?? "")}</span>${f.element ? ` <span class="sec">· changing it needs verifying</span>` : ""}</p><p class="sec">${esc(f.help)}</p>${hint.length ? `<p class="why" id="${id}-h">${hint.map((h) => esc(h.text)).join(" ")}</p>` : ""}${refused ? `<p class="fit-no" role="alert" id="${id}-e">${esc(refused)}</p>` : ""}</div>`;
  };

  const basicsHtml = () => {
    const ctx = (st.data.fields ?? []).find((f) => f.key === "contextTokens");
    const val = Number(current("contextTokens"));
    const v = (st.data.values ?? []).find((x) => x.key === "contextTokens");
    const models = (opts.models ?? []).filter((m) => m.fits?.[st.role] !== "no");
    const modelSel = models.length
      ? `<label for="cust-model">Model</label><select id="cust-model" data-model-pick${dis}>${models
          .map(
            (m) =>
              `<option value="${esc(m.key)}"${m.key === st.model ? " selected" : ""}>${esc(m.name)}</option>`,
          )
          .join("")}</select>${
          st.model !== opts.assigned && !ro
            ? ` <button class="btn sm" type="button" data-assign-model>Use this model for the ${esc(roleName)}</button>`
            : ""
        }`
      : `<span>${esc(st.model)}</span>`;
    return `<div class="cust-field"><div class="row">${modelSel}</div></div>
<div class="cust-field" data-key="contextTokens"><label for="cust-contextTokens">Context <span class="tnum" data-ctx-out>${esc(valueText({ key: "contextTokens" }, val))}</span></label><input id="cust-contextTokens" type="range" data-field="contextTokens" min="${ctx?.min ?? 2048}" max="${Math.min(ctx?.max ?? 262144, 131072)}" step="1024" value="${esc(val)}" aria-describedby="cust-fit cust-contextTokens-g"${dis}><p class="cust-fit" id="cust-fit" aria-live="polite">${esc(fitText(st.fit))}</p><p class="cust-grade" id="cust-contextTokens-g"><span class="grade" data-grade="${esc(v?.grade ?? "default")}">${esc(gradeText(v))}</span> <span class="sec">${esc(v?.source ?? "")}</span></p>${v?.grade === "set" && !ro ? '<button class="btn sm" type="button" data-reset="contextTokens" aria-label="Reset Context">Reset</button>' : ""}${(
      st.data.hints ?? []
    )
      .filter((h) => h.key === "contextTokens")
      .map((h) => `<p class="why">${esc(h.text)}</p>`)
      .join(
        "",
      )}${st.refusal?.key === "contextTokens" ? `<p class="fit-no" role="alert">${esc(st.refusal.error)}</p>` : ""}</div>
<fieldset class="cust-presets"><legend>Preset</legend><div class="row">${PRESETS.map(
      (p) =>
        `<button class="btn sm" type="button" data-preset="${p.id}" aria-pressed="${st.data.preset === p.id}" aria-describedby="cust-preset-${p.id}"${dis}>${esc(p.label)}</button>`,
    ).join(
      "",
    )}</div>${PRESETS.map((p) => `<p class="sec" id="cust-preset-${p.id}">${esc(`${p.label}: ${p.help}`)}</p>`).join("")}</fieldset>`;
  };

  const render = () => {
    if (st.gone) return;
    if (!st.data) {
      host.innerHTML = `<section class="cfg-part cfg-cust" aria-label="Customize the ${esc(roleName)}"><p class="sec">Reading the settings…</p></section>`;
      return;
    }
    if (st.data.error) {
      host.innerHTML = `<section class="cfg-part cfg-cust" aria-label="Customize the ${esc(roleName)}"><p role="alert">${esc(st.data.error)}</p><button class="btn sm" type="button" data-close>Close</button></section>`;
      return;
    }
    const fields = (st.data.fields ?? []).filter(
      (f) => f.tab === st.tab && f.key !== "contextTokens",
    );
    const ver = st.data.verification;
    const tabs = TABS.map(
      (t) =>
        `<button class="tab" type="button" role="tab" id="cust-tab-${t.id}" data-cust-tab="${t.id}" aria-selected="${t.id === st.tab}" aria-controls="cust-panel" tabindex="${t.id === st.tab ? "0" : "-1"}">${esc(t.label)}</button>`,
    ).join("");
    const dirty = Object.keys(st.edits).length > 0;
    const focused = document.activeElement?.id;
    host.innerHTML = `<section class="cfg-part cfg-cust" aria-labelledby="cust-h"><div class="row cust-head"><h3 id="cust-h">Customize the ${esc(roleName)}</h3><button class="btn sm" type="button" data-close>Close</button></div>
${ro ? `<p class="readonly-note" id="cust-ro">${esc(ro)}</p>` : ""}
<p class="cust-ver" data-state="${esc(ver?.state ?? "")}">${esc(verificationText(ver))}${ver?.state === "needs_verifying" && !ro ? ' <button class="btn sm primary" type="button" data-verify>Verify now</button>' : ""}</p>
<div class="tabs ptabs cust-tabs" role="tablist" aria-label="Settings for the ${esc(roleName)}">${tabs}</div>
<div class="cust-panel" id="cust-panel" role="tabpanel" aria-labelledby="cust-tab-${st.tab}">${st.tab === "basics" ? basicsHtml() : ""}${fields.map(fieldHtml).join("")}</div>
${
  st.data.hints?.some((h) => h.key === "import")
    ? `<p class="why">${esc(
        st.data.hints
          .filter((h) => h.key === "import")
          .map((h) => h.text)
          .join(" "),
      )}</p>`
    : ""
}
<div class="row cust-foot"><button class="btn primary" type="button" data-save${dirty && !ro ? "" : " disabled"}${ro ? ' aria-describedby="cust-ro"' : ""}>Save</button><button class="btn" type="button" data-export>Export</button><label class="btn cust-import${ro ? " disabled" : ""}">Import<input type="file" accept="application/json,.json" data-import class="sr-only"${dis}></label><span class="sec" role="status" data-cust-note>${esc(st.note)}</span></div></section>`;
    if (focused) document.getElementById(focused)?.focus();
  };

  const save = async (body) => {
    st.busy = true;
    const r = await sendJSON("PUT", `/api/config/roles/${st.role}/settings`, {
      model: st.model,
      ...body,
    });
    st.busy = false;
    if (!r.ok) {
      st.refusal = r.data?.key ? { key: r.data.key, error: r.data.error } : null;
      st.note = r.data?.key ? "" : (r.data?.error ?? "Not saved.");
      render();
      if (r.data?.error) announce(r.data.error);
      return false;
    }
    st.refusal = null;
    st.edits = {};
    st.data = r.data;
    st.fit = r.data.fit ?? st.fit;
    st.note =
      r.data.verification?.state === "needs_verifying"
        ? "Saved. Verify it before the Agent uses it."
        : "Saved.";
    render();
    announce(st.note);
    opts.onChanged?.();
    return true;
  };

  const onClick = async (e) => {
    const t = e.target instanceof Element ? e.target.closest("button") : null;
    if (!t || t.disabled) return;
    const d = t.dataset;
    if (d.custTab) {
      st.tab = d.custTab;
      render();
      host.querySelector(`#cust-tab-${st.tab}`)?.focus();
    } else if (d.close !== undefined) opts.onClose?.();
    else if (d.save !== undefined) await save({ values: { ...st.edits } });
    else if (d.preset) await save({ preset: d.preset, values: {} });
    else if (d.reset) {
      const r = await sendJSON("POST", `/api/config/roles/${st.role}/settings/reset`, {
        model: st.model,
        keys: [d.reset],
      });
      if (r.ok) {
        st.data = r.data;
        delete st.edits[d.reset];
        st.note = "Reset.";
        render();
        announce("Reset.");
        opts.onChanged?.();
      }
    } else if (d.verify !== undefined) {
      st.note = "Verifying on this machine: a check of a few minutes…";
      render();
      const r = await sendJSON("POST", `/api/config/roles/${st.role}/qualify`, { model: st.model });
      st.note = r.ok
        ? r.data?.qualified
          ? "Verified."
          : `Not verified: ${r.data?.reason ?? "it did not pass"}`
        : (r.data?.error ?? "The check could not run.");
      await load();
      announce(st.note);
      opts.onChanged?.();
    } else if (d.assignModel !== undefined) {
      const r = await sendJSON("PUT", `/api/config/roles/${st.role}`, { model: st.model });
      st.note = r.ok ? "Assigned." : (r.data?.error ?? "Not assigned.");
      render();
      announce(st.note);
      if (r.ok) opts.onChanged?.();
    } else if (d.export !== undefined) {
      const r = await getJSON(
        `/api/config/roles/${st.role}/settings/export?model=${encodeURIComponent(st.model)}`,
      );
      if (!r.ok) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${st.model}-${st.role}-settings.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  const onInput = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.dataset.field) return;
    const f = (st.data?.fields ?? []).find((x) => x.key === t.dataset.field);
    if (!f) return;
    const value =
      f.kind === "bool"
        ? t.checked
        : f.kind === "choice"
          ? t.value
          : t.value === ""
            ? undefined
            : Number(t.value);
    if (value === undefined) delete st.edits[f.key];
    else st.edits[f.key] = value;
    const save = host.querySelector("[data-save]");
    if (save && !ro) save.disabled = Object.keys(st.edits).length === 0;
    if (f.key === "contextTokens") {
      const out = host.querySelector("[data-ctx-out]");
      if (out) out.textContent = valueText(f, value);
      // The fit as it moves, from the server's fit for this model and role: nothing loads.
      clearTimeout(st.timer);
      st.timer = setTimeout(async () => {
        await load(value);
      }, 150);
    }
  };

  const onChange = async (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement && t.hasAttribute("data-model-pick")) {
      st.model = t.value;
      st.edits = {};
      st.data = null;
      render();
      await load();
      return;
    }
    if (t instanceof HTMLInputElement && t.hasAttribute("data-import") && t.files?.[0]) {
      let file;
      try {
        file = JSON.parse(await t.files[0].text());
      } catch {
        st.note = "That file is not a settings file.";
        render();
        return;
      }
      const r = await sendJSON("POST", `/api/config/roles/${st.role}/settings/import`, {
        model: st.model,
        file,
      });
      if (!r.ok) {
        st.refusal = r.data?.key ? { key: r.data.key, error: r.data.error } : null;
        st.note = r.data?.error ?? "Not imported.";
      } else {
        st.data = r.data;
        st.edits = {};
        st.note = "Imported.";
        opts.onChanged?.();
      }
      render();
      announce(st.note);
      return;
    }
    onInput(e);
  };

  const onKey = (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement) || !t.dataset.custTab) return;
    const i = TABS.findIndex((x) => x.id === t.dataset.custTab);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % TABS.length
        : e.key === "ArrowLeft"
          ? (i - 1 + TABS.length) % TABS.length
          : -1;
    if (next < 0) return;
    e.preventDefault();
    st.tab = TABS[next].id;
    render();
    host.querySelector(`#cust-tab-${st.tab}`)?.focus();
  };

  host.addEventListener("click", onClick);
  host.addEventListener("input", onInput);
  host.addEventListener("change", onChange);
  host.addEventListener("keydown", onKey);
  render();
  void load();
  return {
    unmount() {
      st.gone = true;
      clearTimeout(st.timer);
      host.removeEventListener("click", onClick);
      host.removeEventListener("input", onInput);
      host.removeEventListener("change", onChange);
      host.removeEventListener("keydown", onKey);
      host.innerHTML = "";
    },
  };
}
