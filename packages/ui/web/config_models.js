// Configuration › Models (dashboard §2.16 items 1 and 1a, NEW-dashboard-6,
// DB-NM14-1–9): the model folders and the scan, the models found and whether
// each fits, each role's model and the recommendation, explicit verified
// downloads, a model's details with every number graded, combinations,
// placement with a hash-verified copy, and the residency timeline. Nothing
// here downloads, loads or copies until a person presses the button.
import { $, announce, copyText, esc, getJSON, sendJSON } from "./dom.js";

const ROLE_NAME = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};
const GRADE_WORD = {
  measured: "Measured",
  estimated: "Estimated",
  design: "Design value",
  // Read from the file itself (its size, its header), not measured by a run.
  file: "From the file",
  // As the source publishes it (a download's size).
  published: "Published",
};
const SOURCE_WORD = {
  config: "configuration file",
  flag: "--models-dir",
  env: "SEKHEMET_MODELS_DIR",
};
const FIT_WORD = { yes: "Yes", swaps: "Yes, swaps with the other roles", no: "Needs more memory" };
const HASH_WORD = {
  pending: "Hashing…",
  verified: "Verified",
  hash_differs: "Hash differs",
  not_registry: "Not in Sekhemet's model list",
};

const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;
const mins = (ms) => `${Math.round(ms / 60_000)} min`;
const secs = (ms) => `${Math.round(ms / 1000)} s`;
const tokens = (n) => `${Math.round(n).toLocaleString("en")} tokens`;
const tps = (n) => `${n.toFixed(1)} tok/s`;

/**
 * A number with its grade in words beside it (DB-NM14-1). `g` is
 * `{ value, grade, low?, high? }`; `fmt` formats a value. Every number the
 * model section shows goes through here.
 */
export function graded(g, fmt = String) {
  if (!g || typeof g.value !== "number") return "";
  const spread =
    g.low !== undefined && g.high !== undefined ? ` (${fmt(g.low)} to ${fmt(g.high)})` : "";
  const word = GRADE_WORD[g.grade] ?? "Design value";
  return `<span class="gnum" data-num data-grade-of="${esc(g.grade)}">${esc(fmt(g.value))}${esc(spread)}<span class="grade" data-grade="${esc(g.grade)}">${word}</span></span>`;
}
const measured = (value, fmt) => graded({ value, grade: "measured" }, fmt);
const fromFile = (value, fmt) => graded({ value, grade: "file" }, fmt);

const ui = {
  root: null,
  models: null,
  roles: null,
  placement: null,
  combos: null,
  residency: null,
  open: null,
  detail: null,
  whatIf: { context: "", kvType: "" },
  dialog: null,
  progress: {},
  /** *Use the recommended models* (DB-N6-16): its last state from the server. */
  recommended: null,
  /** *Measure speed* (DB-NM14-3): the last `speed` frame. */
  speed: null,
  error: "",
  readOnly: "",
  onConfig: null,
};

function error(text) {
  ui.error = text;
  render();
  if (text) announce(text);
}

async function load(part) {
  const paths = {
    models: "/api/config/models",
    roles: "/api/config/roles",
    placement: "/api/config/placement",
    combos: "/api/config/combinations",
    residency: "/api/config/residency?hours=24",
  };
  const r = await getJSON(paths[part]).catch(() => ({ ok: false, status: 0, data: null }));
  ui[part] = r.ok
    ? r.data
    : { error: r.data?.error ?? `The server returned ${r.status || "no response"}.` };
  render();
}

async function loadDetail() {
  if (!ui.open) return;
  const q = new URLSearchParams({ role: "worker" });
  if (ui.whatIf.context) q.set("context", ui.whatIf.context);
  if (ui.whatIf.kvType) q.set("kvType", ui.whatIf.kvType);
  const r = await getJSON(`/api/config/models/${encodeURIComponent(ui.open)}?${q}`);
  ui.detail = r.ok ? r.data : { error: r.data?.error ?? "The model could not be read." };
  render();
}

function refreshAll() {
  for (const p of ["models", "roles", "placement", "combos", "residency"]) load(p);
}

async function act(method, path, body, done) {
  const r = await sendJSON(method, path, body);
  if (!r.ok) {
    error(r.data?.error ?? `The server returned ${r.status || "no response"}.`);
    return r;
  }
  ui.error = "";
  if (done) await done(r.data);
  return r;
}

/* ---------- Model folders ---------- */

function disabledAttr() {
  return ui.readOnly ? ' disabled aria-describedby="cfg-ro"' : "";
}

// C2a (NEW-dashboard-19, DEC-51; FINDINGS CFG-07): Models' parts are the
// approved mockup's cards — Model library, Available models, Suggested setup
// and Compare setups — each one card, with no box inside a card.

function foldersHtml(m, extra = "") {
  const folders = m.folders ?? [];
  const rows = folders.length
    ? `<ul class="cfg-folders">${folders
        .map(
          (f) =>
            `<li class="row"><span class="mono">${esc(f.path)}</span><span class="sec">set in the ${esc(SOURCE_WORD[f.source] ?? f.source)}${f.includeSubfolders ? " · with subfolders" : ""}</span>${
              f.readable === false
                ? `<span class="fit-no">Can't be read: ${esc(f.error ?? "")}</span>`
                : f.modelCount !== undefined
                  ? `<span class="sec">${esc(f.modelCount === 1 ? "1 model" : `${f.modelCount} models`)}</span>`
                  : ""
            }${
              f.source === "config"
                ? `<button class="btn sm" type="button" data-remove-folder="${esc(f.path)}"${disabledAttr()}>Remove</button>`
                : ""
            }</li>`,
        )
        .join("")}</ul>`
    : '<p class="sec">No model folder yet. Add the folder where your models are.</p>';
  const suggested = (m.suggestedFolders ?? [])
    .map(
      (p) =>
        `<button class="btn sm" type="button" data-add-folder="${esc(p)}"${disabledAttr()}>Add ${esc(p)}</button>`,
    )
    .join("");
  return `<section class="cfg-card" aria-labelledby="cfg-h-folders"><h2 id="cfg-h-folders">Model library</h2><p class="sec">Nothing is downloaded, loaded or run until you press the button.</p>${rows}${
    suggested
      ? `<div class="row"><span class="sec">Found on this machine:</span>${suggested}</div>`
      : ""
  }<form class="row" data-folder-form><label class="sr-only" for="cfg-folder-path">Folder path</label><input id="cfg-folder-path" type="text" name="path" placeholder="/path/to/models" autocomplete="off"${disabledAttr()}><label class="inline"><input type="checkbox" name="sub"${disabledAttr()}>Include subfolders</label><button class="btn" type="submit"${disabledAttr()}>Add folder</button><button class="btn" type="button" data-scan${disabledAttr()}>Scan</button></form><p class="sec">The scan only reads a folder; only a download you confirm writes into one.</p>${extra}</section>`;
}

/* ---------- Models found ---------- */

function modelsHtml(m) {
  const list = m.models ?? [];
  const skipped = (m.skipped ?? []).filter((s) => s.reason !== "not_a_model");
  const table = list.length
    ? `<div class="tbl-wrap" tabindex="0"><table class="tbl"><thead><tr><th>Name</th><th>Size</th><th>Quantisation</th><th>Context</th><th>Family</th><th>Fits this machine (Coding model)</th><th>Published hash</th></tr></thead><tbody>${list
        .map((x) => {
          const fit = x.fits?.worker ?? "yes";
          return `<tr><td><button class="btn ghost sm" type="button" data-open-model="${esc(x.id)}" aria-expanded="${ui.open === x.id}">${esc(x.name)}</button>${x.noEngine ? `<div class="why">${esc(x.noEngine)}</div>` : ""}</td><td>${fromFile(x.sizeBytes, gb)}</td><td class="mono">${esc(x.quantisation)}</td><td>${x.contextLength ? fromFile(x.contextLength, tokens) : '<span class="sec">Not in the header</span>'}</td><td>${esc(x.family ?? "Unknown")}</td><td><span class="fit-${esc(fit)}">${esc(FIT_WORD[fit] ?? fit)}</span><div class="why">${esc(x.fitReason?.worker ?? "")}</div></td><td>${esc(HASH_WORD[x.hash] ?? x.hash)}</td></tr>${
            ui.open === x.id ? `<tr><td colspan="7">${detailHtml()}</td></tr>` : ""
          }`;
        })
        .join("")}</tbody></table></div>`
    : '<p class="sec">No models found yet.</p>';
  const skip = skipped.length
    ? `<details><summary>${esc(`${skipped.length} files skipped`)}</summary><ul>${skipped
        .map(
          (s) => `<li><span class="mono">${esc(s.path)}</span>: ${esc(s.detail ?? s.reason)}</li>`,
        )
        .join("")}</ul></details>`
    : "";
  return `<section class="cfg-card" aria-labelledby="cfg-h-found"><h2 id="cfg-h-found">Available models <span class="sec tnum">${list.length}</span></h2>${table}${skip}</section>`;
}

function detailHtml() {
  const d = ui.detail;
  if (!d) return '<div class="sk" style="height:120px"></div>';
  if (d.error) return `<p role="alert">${esc(d.error)}</p>`;
  const id = d.model?.identity ?? {};
  const mem = d.memory ?? {};
  const ms = (v) => `${Math.round(v)} ms`;
  const speeds = (d.speeds ?? [])
    .map(
      (s) =>
        `<div><dt>Decode on ${esc(s.engine)}</dt><dd>${s.note ? esc(s.note) : graded(s.decodeTokensPerSecond, tps)} <span class="sec">efficiency</span> ${graded(s.efficiency, (v) => v.toFixed(2))}</dd></div>${
          s.measuredDecodeTokensPerSecond
            ? `<div><dt>llama-bench on ${esc(s.engine)}</dt><dd>decode ${graded(s.measuredDecodeTokensPerSecond, tps)}${s.measuredPrefillTokensPerSecond ? `, prefill ${graded(s.measuredPrefillTokensPerSecond, tps)}` : ""}</dd></div>`
            : s.benchNotAccepted
              ? `<div><dt>llama-bench on ${esc(s.engine)}</dt><dd class="why">Not used: ${esc(s.benchNotAccepted)}</dd></div>`
              : ""
        }${
          s.ttft
            ? `<div><dt>First token</dt><dd>without the prefix cache ${graded(s.ttft.withoutCacheMs, ms)}, with it ${graded(s.ttft.withCacheMs, ms)}</dd></div>`
            : ""
        }`,
    )
    .join("");
  const speedState = ui.speed?.state === "running" ? ui.speed : null;
  const loads = (d.loads ?? [])
    .map(
      (l) =>
        `<div><dt>Load from ${esc(l.volume)} storage</dt><dd>cold ${graded(l.coldMs, secs)}, warm ${graded(l.warmMs, secs)}</dd></div>`,
    )
    .join("");
  const qual = Object.entries(d.qualification ?? {})
    .map(
      ([r, s]) =>
        `${esc(ROLE_NAME[r] ?? r)}: ${esc(s === "qualified" ? "verified on this machine" : s === "missing" ? "not verified on this machine yet" : s)}`,
    )
    .join("; ");
  const ctxOptions = [4096, 8192, 16384, 32768, 65536]
    .map(
      (c) =>
        `<option value="${c}"${Number(ui.whatIf.context || mem.contextTokens) === c ? " selected" : ""}>${c.toLocaleString("en")} tokens</option>`,
    )
    .join("");
  const kvOptions = ["q8_0", "f16", "q4_0"]
    .map(
      (k) =>
        `<option value="${k}"${(ui.whatIf.kvType || mem.kvType) === k ? " selected" : ""}>${k}</option>`,
    )
    .join("");
  return `<div class="cfg-detail" aria-label="Model details">
<h4>Identity</h4><dl><div><dt>Family</dt><dd>${esc(id.family ?? "Unknown")}</dd></div><div><dt>Parameters</dt><dd>${id.parametersTotal ? graded(id.parametersTotal, (v) => `${(v / 1e9).toFixed(1)} B`) : "Not in the header"}${id.parametersActive ? `, active ${graded(id.parametersActive, (v) => `${(v / 1e9).toFixed(1)} B`)}` : ""}</dd></div><div><dt>Quantisation</dt><dd class="mono">${esc(id.quantisation ?? "")}</dd></div><div><dt>Engine</dt><dd>${esc(id.engine ?? "")}</dd></div><div><dt>Size</dt><dd>${graded(id.sizeBytes, gb)}</dd></div><div><dt>Maximum context</dt><dd>${graded(id.contextLength, tokens)}</dd></div><div><dt>Licence</dt><dd>${esc(id.license ?? "Not stated")}</dd></div><div><dt>Source</dt><dd>${esc(id.source ?? "")}</dd></div><div><dt>SHA-256</dt><dd class="hash">${esc(id.sha256 ?? HASH_WORD[id.hash] ?? "")}</dd></div></dl>
<h4>Memory</h4><div class="row"><label class="inline">Context <select data-whatif="context">${ctxOptions}</select></label><label class="inline">KV type <select data-whatif="kvType">${kvOptions}</select></label><span class="sec">Changing these loads nothing.</span></div>
<dl><div><dt>Weights</dt><dd>${graded(mem.weightsBytes, gb)}</dd></div><div><dt>KV cache</dt><dd>${graded(mem.kvBytes, gb)}</dd></div><div><dt>Compute buffer</dt><dd>${graded(mem.computeBufferBytes, gb)}</dd></div><div><dt>Prompt cache</dt><dd>${graded(mem.promptCacheBytes, gb)}</dd></div><div><dt>Total</dt><dd>${graded(mem.totalBytes, gb)}</dd></div><div><dt>Free now (headroom)</dt><dd>${graded(d.headroom, gb)}</dd></div></dl>
<h4>Speed and loading</h4><dl>${speeds}${loads}</dl><div class="row"><button class="btn sm" type="button" data-measure-speed="${esc(ui.open ?? "")}"${speedState ? " disabled" : ""}${disabledAttr()}>Measure speed…</button>${speedState ? '<span class="sec" role="status">Measuring…</span>' : ""}</div>
<h4>Per role</h4><p>${qual}</p>
${(d.warnings ?? []).length ? `<h4>Warnings</h4><ul class="cfg-warn">${d.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
</div>`;
}

/* ---------- Roles ---------- */

function rolesHtml(r, models) {
  const roles = r.roles ?? [];
  const found = (models?.models ?? []).filter((m) => !m.noEngine);
  const anyRec = roles.some((x) => x.recommendation);
  // DB-N19-5: the recommendation rule's suggestion (models NEW-models-12), so the
  // card is not titled as Seshat's; *Apply suggestion* is *Use the recommended
  // models* with its one confirmation, and *Choose each role* the role pickers.
  return `<section class="cfg-card" aria-labelledby="cfg-h-roles"><h2 id="cfg-h-roles">Suggested setup</h2>${recommendedHtml()}<div class="cfg-roles">${roles
    .map((x) => {
      const name = ROLE_NAME[x.role] ?? x.role;
      const state =
        x.state === "resident"
          ? "Resident"
          : x.state === "swapped_out"
            ? "Swapped out"
            : "Not configured";
      const rec = x.recommendation;
      const dl = rec?.download;
      const options = found
        .filter((m) => m.fits?.[x.role] !== "no")
        .map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`)
        .join("");
      const selectId = `cfg-assign-${x.role}`;
      return `<div class="cfg-role" data-role="${esc(x.role)}"><div><b>${esc(name)}</b>${x.role === "planner" ? '<div class="why">Seshat, the project manager, runs on this model.</div>' : ""}</div><div><div>${x.model ? `<b>${esc(x.model)}</b>` : "No model"} · ${esc(state)}${x.model && !x.qualified ? " · not verified on this machine" : ""}</div>${
        x.unfilledReason ? `<div class="why">${esc(x.unfilledReason)}</div>` : ""
      }${x.screen === "not_measured" ? '<div class="why">Quick benchmark: Not measured yet.</div>' : ""}${
        rec ? `<p>Recommended: ${esc(rec.reason)}</p>` : ""
      }</div><div class="actions row">${
        options
          ? `<label class="sr-only" for="${selectId}">Model for the ${esc(name)}</label><select id="${selectId}" data-assign-select="${esc(x.role)}"${disabledAttr()}>${options}</select><button class="btn sm" type="button" data-assign="${esc(x.role)}"${disabledAttr()}>Assign</button>`
          : ""
      }${
        ui.progress[`qualify-${x.role}`]
          ? `<button class="btn sm" type="button" data-qualify="${esc(x.role)}"${disabledAttr()}>Verify on this machine to assign</button>`
          : ""
      }${
        x.model
          ? `<button class="btn sm" type="button" data-load="${esc(x.role)}"${disabledAttr()}>Load</button><button class="btn sm" type="button" data-unload="${esc(x.role)}"${disabledAttr()}>Unload</button>`
          : ""
      }${x.previous ? `<button class="btn sm" type="button" data-restore="${esc(x.role)}"${disabledAttr()}>Restore previous</button>` : ""}${
        dl
          ? dl.blockedBy
            ? `<button class="btn sm" type="button" disabled aria-describedby="cfg-dl-why-${esc(x.role)}">Download…</button><span class="why" id="cfg-dl-why-${esc(x.role)}">${esc(dl.blockedBy)}</span>`
            : `<button class="btn sm" type="button" data-download="${esc(rec.model)}" data-size="${esc(dl.sizeBytes)}" data-sha="${esc(dl.sha256)}" data-source="${esc(dl.source)}"${disabledAttr()}>Download…</button>`
          : ""
      }</div></div>`;
    })
    .join("")}</div><div class="row">${
    anyRec
      ? `<button class="btn primary" type="button" data-use-recommended${disabledAttr()}>Apply suggestion</button>`
      : ""
  }${
    found.length
      ? `<button class="btn" type="button" data-choose-roles${disabledAttr()}>Choose each role</button>`
      : ""
  }</div></section>`;
}

/** Where *Use the recommended models* stands, and at its end what was assigned and why not (DB-N6-16). */
function recommendedHtml() {
  const r = ui.recommended;
  if (!r) return "";
  if (r.state !== "done") {
    const what =
      {
        downloading: "Downloading and verifying",
        benchmarking: "Running the quick benchmark",
        assigning: "Assigning",
      }[r.state] ?? "Working";
    return `<p role="status">${esc(what)}…</p>`;
  }
  const done = (r.assigned ?? [])
    .map((a) => `<li>${esc(ROLE_NAME[a.role] ?? a.role)}: ${esc(a.model)} assigned</li>`)
    .join("");
  const not = (r.notAssigned ?? [])
    .map((a) => `<li>${esc(ROLE_NAME[a.role] ?? a.role)}: not assigned — ${esc(a.reason)}</li>`)
    .join("");
  const bench = r.benchmark
    ? `<p>Quick benchmark: ${esc(r.benchmark.state === "done" ? (r.benchmark.partial ? "done, partial" : "done; its scores are under Benchmark") : (r.benchmark.reason ?? r.benchmark.state))}</p>`
    : "";
  return `<div role="status">${bench}<ul>${done}${not}</ul></div>`;
}

/* ---------- Confirmations: download and copy ---------- */

/** The folder a download is offered into: the first one that is there and can be written now. */
function downloadFolder() {
  return (ui.models?.folders ?? []).find((f) => f.readable !== false && f.writable !== false);
}

function dialogHtml() {
  const d = ui.dialog;
  if (!d) return "";
  if (d.kind === "recommended") {
    const combo = Object.entries(d.combination ?? {})
      .map(([role, m]) => `<li>${esc(ROLE_NAME[role] ?? role)}: ${esc(m)}</li>`)
      .join("");
    const dls = (d.downloads ?? [])
      .map(
        (x) =>
          `<li><b>${esc(x.model)}</b><dl><div><dt>Source</dt><dd class="mono">${esc(x.url)}</dd></div><div><dt>Size</dt><dd>${x.sizeBytes ? graded({ value: x.sizeBytes, grade: "published" }, gb) : "Not published"}</dd></div><div><dt>Published SHA-256</dt><dd class="hash">${esc(x.sha256)}</dd></div></dl>${x.blockedBy ? `<p class="why">${esc(x.blockedBy)}</p>` : ""}</li>`,
      )
      .join("");
    return `<div class="cfg-dialog" role="dialog" aria-modal="false" aria-labelledby="cfg-dlg-h"><h4 id="cfg-dlg-h">Use the recommended models</h4><ul>${combo}</ul>${
      dls
        ? `<p>These downloads are made first, each verified by its hash, into <span class="mono">${esc(d.folder ?? "no folder that can be written now")}</span>:</p><ul>${dls}</ul>`
        : "<p>Nothing to download.</p>"
    }<p>Then the quick benchmark screens this combination, and each role whose model is verified on this machine is assigned.</p><div class="row"><button class="btn primary" type="button" data-confirm-recommended>Use them</button><button class="btn" type="button" data-cancel-dialog>Cancel</button></div></div>`;
  }
  if (d.kind === "speed") {
    return `<div class="cfg-dialog" role="dialog" aria-modal="false" aria-labelledby="cfg-dlg-h"><h4 id="cfg-dlg-h">Measure the speed of ${esc(d.name)}</h4><dl><div><dt>Model</dt><dd>${esc(d.name)}</dd></div><div><dt>Memory it loads</dt><dd>${graded({ value: d.memoryBytes, grade: "estimated" }, gb)}</dd></div></dl><p>${esc(d.error ?? "")}</p><p>llama-bench runs a warm-up and five runs, then the first token is timed with and without the prefix cache. Nothing leaves this machine.</p><div class="row"><button class="btn primary" type="button" data-confirm-speed>Measure</button><button class="btn" type="button" data-cancel-dialog>Cancel</button></div></div>`;
  }
  if (d.kind === "download") {
    const folder = downloadFolder();
    const rename = d.needsName
      ? `<p class="why">${esc(d.needsName)}</p><label for="cfg-dl-name">Save as</label><input id="cfg-dl-name" type="text" name="fileName" value="${esc(d.fileName ?? "")}" autocomplete="off">`
      : "";
    return `<div class="cfg-dialog" role="dialog" aria-modal="false" aria-labelledby="cfg-dlg-h"><h4 id="cfg-dlg-h">Download ${esc(d.model)}</h4><dl><div><dt>Source</dt><dd>${esc(d.source)}</dd></div><div><dt>Size</dt><dd>${d.size ? graded({ value: d.size, grade: "published" }, gb) : "Not published"}</dd></div><div><dt>Published SHA-256</dt><dd class="hash">${esc(d.sha)} <button class="btn sm" type="button" data-copy-sha="${esc(d.sha)}">Copy</button></dd></div><div><dt>Written to</dt><dd class="mono">${esc(folder?.path ?? "Add a model folder that can be written first")}</dd></div></dl>${rename}<p>A request for this file to its source host. Nothing about your project is sent.</p><div class="row"><button class="btn primary" type="button" data-confirm-download${folder ? "" : " disabled"}>Download</button><button class="btn" type="button" data-cancel-dialog>Cancel</button></div></div>`;
  }
  if (d.existing)
    return `<div class="cfg-dialog" role="dialog" aria-modal="false" aria-labelledby="cfg-dlg-h"><h4 id="cfg-dlg-h">Use the internal copy of ${esc(d.name)}</h4><dl><div><dt>Internal copy</dt><dd class="mono">${esc(d.existing)}</dd></div><div><dt>SHA-256</dt><dd class="hash">${esc(d.sha ?? "")}</dd></div></dl><p>Its hash matches the original, so nothing is copied; Sekhemet then loads it from internal storage, and the original is kept.</p><div class="row"><button class="btn primary" type="button" data-confirm-copy="${esc(d.model)}">Use it</button><button class="btn" type="button" data-cancel-dialog>Cancel</button></div></div>`;
  return `<div class="cfg-dialog" role="dialog" aria-modal="false" aria-labelledby="cfg-dlg-h"><h4 id="cfg-dlg-h">Copy ${esc(d.name)} to internal storage</h4><dl><div><dt>Size</dt><dd>${fromFile(d.size, gb)}</dd></div><div><dt>Destination</dt><dd class="mono">${esc(d.destination)}</dd></div><div><dt>Free after</dt><dd>${graded(d.freeAfter, gb)}</dd></div><div><dt>SHA-256</dt><dd class="hash">${esc(d.sha ?? "Computing…")}</dd></div></dl><p>The copy is checked against this hash before it is used; the original is kept.</p><div class="row"><button class="btn primary" type="button" data-confirm-copy="${esc(d.model)}">Copy</button><button class="btn" type="button" data-cancel-dialog>Cancel</button></div></div>`;
}

function progressHtml() {
  const lines = Object.values(ui.progress)
    .filter((p) => p && typeof p === "object" && p.kind)
    .map((p) => {
      const what = p.kind === "download" ? "Download" : "Copy";
      if (p.state === "failed")
        return `<p class="fit-no" role="alert">${esc(what)} failed: ${esc(p.error ?? "")}</p>`;
      if (p.state === "verifying") return `<p>${esc(what)}: Verifying…</p>`;
      if (p.state === "done")
        return `<p>${esc(p.kind === "download" ? "Verified. Ready to assign." : "Copied and verified. Sekhemet now uses the internal copy.")}</p>`;
      const rate = p.rate ? `, ${(p.rate / 1e6).toFixed(0)} MB/s` : "";
      // An unknown size is said so, never "of 0.0 GB".
      if (!p.total)
        return `<p>${esc(what)}: ${measured(p.bytes, gb)} so far, size not published${esc(rate)}</p>`;
      const pct = Math.round((p.bytes / p.total) * 100);
      const left = p.rate
        ? `, about ${Math.max(1, Math.round((p.total - p.bytes) / p.rate / 60))} min left`
        : "";
      return `<p>${esc(what)}: ${measured(p.bytes, gb)} of ${graded({ value: p.total, grade: p.kind === "download" ? "published" : "file" }, gb)} (${esc(`${pct}%`)}${esc(rate)}${esc(left)})</p>`;
    })
    .join("");
  return lines ? `<div class="cfg-progress" aria-live="polite">${lines}</div>` : "";
}

/* ---------- Combinations, placement, residency ---------- */

/** Compare setups (DB-N19-5): the benchmark's quick run and overnight schedule, then the combinations. */
function combosHtml(c, extra = "") {
  const all = c?.combinations ?? [];
  const kept = all.filter((x) => !x.excluded).slice(0, 8);
  const excluded = all.filter((x) => x.excluded).slice(0, 8);
  const row = (x) => {
    const e = x.estimate ?? {};
    const models = ["worker", "planner", "reviewer", "researcher"]
      .filter((r) => x.combination[r])
      .map((r) => `${esc(ROLE_NAME[r])}: ${esc(x.combination[r])}`)
      .join("<br>");
    return `<tr><td>${models}</td><td>${x.floorsMet ? "Met" : "Not met"}</td><td>${graded(e.timePerCardMs, mins)}</td><td>${graded(e.expectedSwaps, (v) => v.toFixed(1))}</td><td>${graded(x.peakBytes, gb)}</td><td>${graded(e.acceptedPerNight, (v) => String(v))}</td></tr>`;
  };
  return `<section class="cfg-card" aria-labelledby="cfg-h-combos"><h2 id="cfg-h-combos">Compare setups</h2><p class="sec">Run the quick benchmark now or schedule it overnight; the scores show under Benchmark.</p><div class="row"><a class="btn" href="#/configuration/benchmark">Run or schedule the benchmark</a></div><h3>Combinations</h3><p class="sec">Ordered by each role's quality floor, then the least time per issue including swaps, then the smaller footprint. No combined score.</p>${
    kept.length
      ? `<div class="tbl-wrap" tabindex="0"><table class="tbl"><thead><tr><th>Models</th><th>Quality floors</th><th>Time per issue</th><th>Swaps per issue</th><th>Peak memory</th><th>Issues per night</th></tr></thead><tbody>${kept.map(row).join("")}</tbody></table></div>`
      : '<p class="sec">No combination to compare yet.</p>'
  }${
    excluded.length
      ? `<details><summary>${esc(`${excluded.length} excluded`)}</summary><ul>${excluded
          .map((x) => `<li>${esc(x.excluded)}</li>`)
          .join("")}</ul></details>`
      : ""
  }${extra}</section>`;
}

function placementHtml(p) {
  const rows = p.rows ?? [];
  return `<div class="cfg-part" role="group" aria-labelledby="cfg-h-place"><h3 id="cfg-h-place">Placement</h3><p class="sec">At least 20 GB of internal space is kept free. Free now: ${graded(p.internalFreeBytes, gb)}.</p>${
    rows.length
      ? `<ul>${rows
          .map(
            (r) =>
              `<li><b>${esc(r.name)}</b> (${measured(r.sizeBytes, gb)}): saves ${graded(r.savedPerDayMs, mins)} of loading a day. ${esc(r.reason)}${
                r.suggested || r.internalCopy
                  ? ` <button class="btn sm" type="button" data-copy-model="${esc(r.model)}" data-name="${esc(r.name)}" data-size="${esc(r.sizeBytes)}"${r.internalCopy ? ` data-existing="${esc(r.internalCopy)}"` : ""}${disabledAttr()}>${r.internalCopy ? "Use the internal copy…" : "Copy to internal storage…"}</button>`
                  : ""
              }</li>`,
          )
          .join("")}</ul>`
      : '<p class="sec">Every model is on internal storage.</p>'
  }</div>`;
}

function residencyHtml(r) {
  const hours = r.thetaByHour ?? [];
  const bars = hours
    .map(
      (h, i) =>
        `<div class="hr" style="height:${Math.max(2, Math.min(100, h.value * 100))}%" role="img" aria-label="${esc(`Hour ${i + 1}: ${Math.round(h.value * 100)}% swapping, ${GRADE_WORD[h.grade] ?? ""}`)}"></div>`,
    )
    .join("");
  const segs = (r.segments ?? [])
    .slice(-12)
    .map(
      (s) => `<li>${esc(s.model)}: ${esc(s.from.slice(11, 16))} to ${esc(s.to.slice(11, 16))}</li>`,
    )
    .join("");
  const total = hours.reduce((n, h) => n + h.value, 0) / Math.max(1, hours.length);
  return `<div class="cfg-part" role="group" aria-labelledby="cfg-h-res"><h3 id="cfg-h-res">The last 24 hours</h3><p>Time spent swapping: ${graded({ value: total * 100, grade: "measured" }, (v) => `${v.toFixed(1)}%`)}</p><div class="cfg-timeline">${bars}</div>${segs ? `<ul>${segs}</ul>` : '<p class="sec">No loads recorded yet.</p>'}</div>`;
}

/* ---------- Render and events ---------- */

function render() {
  if (!ui.root) return;
  const parts = [];
  if (ui.readOnly) parts.push(`<p class="readonly-note" id="cfg-ro">${esc(ui.readOnly)}</p>`);
  if (ui.error) parts.push(`<p class="fit-no" role="alert">${esc(ui.error)}</p>`);
  parts.push(dialogHtml(), progressHtml());
  const m = ui.models;
  const left = [];
  const right = [];
  const placement = ui.placement && !ui.placement.error ? placementHtml(ui.placement) : "";
  if (!m) left.push('<div class="sk" style="height:160px"></div>');
  else if (m.error) left.push(`<p role="alert">Couldn't read the models: ${esc(m.error)}</p>`);
  else left.push(foldersHtml(m, placement), modelsHtml(m));
  if (ui.roles && !ui.roles.error) right.push(rolesHtml(ui.roles, m));
  const residency = ui.residency && !ui.residency.error ? residencyHtml(ui.residency) : "";
  right.push(combosHtml(ui.combos && !ui.combos.error ? ui.combos : null, residency));
  parts.push(
    `<div class="cfg-cards"><div class="cfg-col">${left.join("")}</div><div class="cfg-col">${right.join("")}</div></div>`,
  );
  const html = parts.join("");
  const host = $(".cfg-models", ui.root);
  if (host && host.dataset.html !== html) {
    const focusKey = document.activeElement?.getAttribute?.("id");
    host.innerHTML = html;
    host.dataset.html = html;
    if (focusKey) document.getElementById(focusKey)?.focus();
  }
}

async function onClick(e) {
  const t = e.target instanceof Element ? e.target.closest("button") : null;
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.addFolder)
    await act("POST", "/api/config/models/folders", { path: d.addFolder }, refreshAll);
  else if (d.removeFolder)
    await act("DELETE", "/api/config/models/folders", { path: d.removeFolder }, refreshAll);
  else if (d.scan !== undefined) await act("POST", "/api/config/models/scan", {}, refreshAll);
  else if (d.measureSpeed) {
    // The server names the model and the memory it loads; the person confirms both.
    const role = "worker";
    const r = await sendJSON(
      "POST",
      `/api/config/models/${encodeURIComponent(d.measureSpeed)}/speed`,
      {
        role,
      },
    );
    if (r.data?.needs !== "confirmation")
      return error(r.data?.error ?? `The server returned ${r.status || "no response"}.`);
    ui.dialog = { kind: "speed", id: d.measureSpeed, role, ...r.data };
    render();
  } else if (d.confirmSpeed !== undefined && ui.dialog?.kind === "speed") {
    const shown = ui.dialog;
    ui.dialog = null;
    await act(
      "POST",
      `/api/config/models/${encodeURIComponent(shown.id)}/speed`,
      { role: shown.role, confirm: true, model: shown.model, memoryBytes: shown.memoryBytes },
      (data) => {
        ui.speed = { model: data.model, state: "running" };
        render();
      },
    );
  } else if (d.openModel) {
    ui.open = ui.open === d.openModel ? null : d.openModel;
    ui.detail = null;
    ui.whatIf = { context: "", kvType: "" };
    render();
    loadDetail();
  } else if (d.assign || d.qualify) {
    const role = d.assign || d.qualify;
    const sel = ui.root.querySelector(`[data-assign-select="${role}"]`);
    const path = d.qualify ? `/api/config/roles/${role}/qualify` : `/api/config/roles/${role}`;
    const r = await sendJSON(d.qualify ? "POST" : "PUT", path, { model: sel?.value });
    if (!r.ok && r.data?.needs === "qualification") ui.progress[`qualify-${role}`] = true;
    if (!r.ok) error(r.data?.error ?? "Not assigned.");
    else {
      delete ui.progress[`qualify-${role}`];
      ui.error = "";
      announce(`${ROLE_NAME[role]} assigned.`);
    }
    load("roles");
  } else if (d.chooseRoles !== undefined) {
    // *Choose each role*: to the first role's picker, where each role is assigned.
    ui.root?.querySelector("[data-assign-select]")?.focus();
  } else if (d.useRecommended !== undefined) {
    const r = await getJSON("/api/config/recommended");
    if (!r.ok) return error(r.data?.error ?? "The recommendation could not be read.");
    ui.dialog = { kind: "recommended", ...r.data };
    render();
  } else if (d.confirmRecommended !== undefined && ui.dialog) {
    const shown = ui.dialog;
    ui.dialog = null;
    // The confirmation names back what the person saw: each download and the folder.
    await act(
      "POST",
      "/api/config/recommended",
      {
        confirm: true,
        ...(shown.folder ? { folder: shown.folder } : {}),
        downloads: (shown.downloads ?? []).map((x) => ({ model: x.model, sha256: x.sha256 })),
      },
      (data) => {
        ui.recommended = data.run;
        render();
      },
    );
  } else if (d.load) await act("POST", `/api/config/roles/${d.load}/load`, {}, () => load("roles"));
  else if (d.unload)
    await act("POST", `/api/config/roles/${d.unload}/unload`, {}, (data) => {
      if (data?.deferred) announce(data.deferred);
      return load("roles");
    });
  else if (d.restore)
    await act("POST", `/api/config/roles/${d.restore}/restore`, {}, () => load("roles"));
  else if (d.download) {
    ui.dialog = {
      kind: "download",
      model: d.download,
      size: Number(d.size),
      sha: d.sha,
      source: d.source,
    };
    render();
  } else if (d.copySha) {
    if (await copyText(d.copySha)) announce("Hash copied.");
  } else if (d.cancelDialog !== undefined) {
    ui.dialog = null;
    render();
  } else if (d.confirmDownload !== undefined && ui.dialog) {
    const shown = ui.dialog;
    const folder = downloadFolder();
    const named = ui.root?.querySelector("#cfg-dl-name")?.value?.trim();
    ui.dialog = null;
    // The folder the dialog showed goes with the request; the server refuses any other.
    const r = await sendJSON("POST", "/api/config/downloads", {
      model: shown.model,
      folder: folder?.path,
      ...(named ? { fileName: named } : {}),
    });
    if (!r.ok && r.data?.needs === "fileName") {
      // A file of that name is there already: ask for another name, never replace it.
      ui.dialog = {
        ...shown,
        needsName: r.data.error,
        fileName: named || `new-${r.data.fileName}`,
      };
      render();
      return;
    }
    if (!r.ok) return error(r.data?.error ?? `The server returned ${r.status || "no response"}.`);
    ui.error = "";
    ui.progress[r.data.downloadId] = {
      kind: "download",
      bytes: 0,
      total: r.data.sizeBytes,
      state: "running",
      at: Date.now(),
    };
    render();
  } else if (d.copyModel) {
    const size = Number(d.size);
    const free = ui.placement?.internalFreeBytes ?? { value: 0, grade: "estimated" };
    const found = (ui.models?.models ?? []).find(
      (m) => m.id === d.copyModel || m.registryId === d.copyModel,
    );
    ui.dialog = {
      kind: "copy",
      model: found?.id ?? d.copyModel,
      name: d.name,
      size,
      destination: ui.placement?.destination ?? "",
      freeAfter: { value: free.value - size, grade: free.grade },
      sha: found?.sha256,
      ...(d.existing ? { existing: d.existing } : {}),
    };
    render();
  } else if (d.confirmCopy) {
    ui.dialog = null;
    await act("POST", "/api/config/placement/copies", { model: d.confirmCopy }, (data) => {
      ui.progress[data.copyId] = {
        kind: "copy",
        bytes: 0,
        total: data.sizeBytes,
        state: "running",
        at: Date.now(),
      };
      render();
    });
  }
}

async function onSubmit(e) {
  const form = e.target instanceof HTMLFormElement ? e.target : null;
  if (!form?.hasAttribute("data-folder-form")) return;
  e.preventDefault();
  const path = form.elements.namedItem("path")?.value?.trim();
  if (!path) return error("Name the folder by its full path.");
  const sub = form.elements.namedItem("sub")?.checked === true;
  await act("POST", "/api/config/models/folders", { path, includeSubfolders: sub }, refreshAll);
}

function onChange(e) {
  const t = e.target;
  if (!(t instanceof HTMLSelectElement) || !t.dataset.whatif) return;
  ui.whatIf[t.dataset.whatif] = t.value;
  loadDetail();
}

/** `config` frames from `/api/stream`: scan, hash, download and copy progress. */
function onConfig(ev) {
  const f = ev.detail ?? {};
  if (f.kind === "download" || f.kind === "copy") {
    const id = f.downloadId ?? f.copyId;
    const prev = ui.progress[id] ?? { at: Date.now(), bytes: 0 };
    const dt = (Date.now() - prev.at) / 1000;
    const rate = dt > 0 && f.bytes > prev.bytes ? (f.bytes - prev.bytes) / dt : prev.rate;
    ui.progress[id] = { ...f, kind: f.kind, at: Date.now(), ...(rate ? { rate } : {}) };
    if (f.state === "done") refreshAll();
    render();
  } else if (f.kind === "recommended") {
    ui.recommended = f;
    if (f.state === "done") {
      announce("The recommended models are set up.");
      refreshAll();
    }
    render();
  } else if (f.kind === "speed") {
    ui.speed = f;
    if (f.state === "done") {
      announce(f.benchError ?? "Speed measured.");
      loadDetail();
    } else if (f.state === "failed") error(`Measuring speed failed: ${f.error ?? ""}`);
    render();
  } else if (f.kind === "hash" || (f.kind === "scan" && f.done)) {
    load("models");
  }
}

export function mount(container, { readOnly = "" } = {}) {
  const root = document.createElement("div");
  root.innerHTML = '<div class="cfg-models"></div>';
  container.append(root);
  ui.root = root;
  ui.readOnly = readOnly;
  ui.error = "";
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("change", onChange);
  ui.onConfig = onConfig;
  window.addEventListener("sekhemet:config", onConfig);
  render();
  refreshAll();
  return {
    unmount() {
      window.removeEventListener("sekhemet:config", onConfig);
      root.remove();
      ui.root = null;
    },
  };
}
