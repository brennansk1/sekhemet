// Configuration › Benchmark (dashboard NEW-dashboard-6, DB-N6-9–13 and 16–18;
// measurement NEW-measurement-5): pick one model per role, see the quick
// screen's estimate before anything loads, run it, stop it, read each role's
// score with its range and secondary measures, compare paired, schedule an
// overnight comparison and read its morning report. Mounted by
// `configuration.js`. Nothing here assigns on its own: Assign and Qualify are
// a person's presses (DB-N6-13).
import { esc, getJSON, postJSON, sendJSON } from "./dom.js";

const ROLES = ["worker", "planner", "reviewer", "researcher"];
const ROLE_NAMES = {
  worker: "Coding model",
  planner: "Planning model",
  reviewer: "Review model",
  researcher: "Research model",
};

/** DB-N6-9, MS-N5-4a: the page's one sentence about what each tier can tell. */
export const QUICK_COPY =
  "The quick benchmark shows speed, fit and large differences; the overnight benchmark settles close calls";

const pct = (x) => `${Math.round(x * 100)}%`;
const two = (x) => (Math.round(x * 100) / 100).toFixed(2);

/** DB-N6-9: *Run quick* with its minutes from the roles not cached, each over its target named. */
export function estimateLabel(e) {
  if (!e) return "Run quick";
  if (!e.totalMinutes) return "Run quick — everything is cached";
  const over = (e.roles || []).filter((r) => r.overTarget).map((r) => ROLE_NAMES[r.role] || r.role);
  if (e.endToEnd?.overTarget) over.push("end-to-end check");
  const tail = over.length
    ? ` (${over.join(", ")} over ${over.length > 1 ? "their targets" : "its target"})`
    : "";
  return `Run quick — about ${Math.round(e.totalMinutes)} min${tail}${e.overTarget && !over.length ? " (over the 45-minute target)" : ""}`;
}

/** DB-N6-9, MS-N5-5: a role's picker offers only models that fit; the others say what they need. */
export function pickerOptions(models, role) {
  return (models || []).map((m) => {
    const fit = m.fits?.[role];
    if (fit === "no") {
      const why = m.fitReason?.[role] || "";
      const gb = /(\d+(?:\.\d+)?)\s*GB/.exec(why)?.[1];
      return {
        value: m.id,
        label: `${m.name} — ${gb ? `Needs ${gb} GB` : "Does not fit"}`,
        disabled: true,
      };
    }
    return { value: m.id, label: fit === "swaps" ? `${m.name} (swaps)` : m.name, disabled: false };
  });
}

/**
 * DB-N6-12, DB-N6-18: a rate with its exact interval; a graded quick score as
 * its mean over its items with their range, and the secondary measures.
 */
export function roleScoreText(s) {
  if (!s || s.state === "not_measured" || !s.score)
    return s?.state === "partial" ? "Partial — not scored" : "Not measured yet";
  const sc = s.score;
  if (sc.kind === "rate")
    return `${pct(sc.value)}${sc.low !== undefined ? ` (95% CI ${pct(sc.low)}–${pct(sc.high ?? 1)})` : ""}`;
  const parts = [
    `${two(sc.value)} over ${sc.n} items${sc.low !== undefined ? ` (${two(sc.low)}–${two(sc.high ?? 1)})` : ""}`,
  ];
  const sec = s.secondary || {};
  if (sec.secondsPerItem !== undefined) parts.push(`${Math.round(sec.secondsPerItem)} s per item`);
  if (sec.validToolCallRate !== undefined)
    parts.push(`${pct(sec.validToolCallRate)} valid tool calls`);
  if (sec.stepsToPass !== undefined) parts.push(`${Math.round(sec.stepsToPass)} steps`);
  if (s.capped !== undefined) parts.push(`${s.capped} capped`);
  return parts.join(" · ");
}

/** DB-N6-12: never ranked when the paired sign test does not reject. */
export function comparisonLabel(c) {
  const counts = `${c.better} better, ${c.worse} worse, ${c.ties} tied; p = ${c.p.toFixed(3)}`;
  if (c.indistinguishable) return `No clear difference (${counts})`;
  return `${c.better > c.worse ? c.a : c.b} ahead (${counts})`;
}

/** DB-N6-10: a run's state and progress; a stopped run keeps its results, marked partial. */
export function runStateText(run) {
  if (run.state === "running")
    return run.progress ? `Running — ${run.progress.done} of ${run.progress.total}` : "Running";
  if (run.state === "stopped")
    return `Stopped — results so far kept${run.partial ? " (partial)" : ""}`;
  if (run.state === "done") return "Done";
  if (run.state === "failed") return "Failed — results so far kept";
  const s = run.schedule;
  if (run.tier === "overnight" && s) {
    const n = run.combinations.length;
    return `Queued — Tonight ${s.window.start}–${s.window.end}: ${s.fitsTonight} of ${n} combination${n === 1 ? "" : "s"} ${s.fitsTonight === 1 ? "fits" : "fit"}`;
  }
  return "Queued";
}

/** DB-N6-13: assign only a row whose models are all qualified here; else offer to qualify. */
export function assignAction(qualifiedByRole) {
  return Object.values(qualifiedByRole).every(Boolean)
    ? "Assign this combination"
    : "Verify on this machine to assign";
}

/* ---------- the section ---------- */

const ui = {
  root: null,
  models: [],
  roles: [],
  data: { runs: [], results: [], roleScores: [] },
  pick: { worker: "", planner: "", reviewer: "", researcher: "" },
  estimate: null,
  confirming: false,
  overnight: null,
  message: "",
};

function combination() {
  const c = { worker: ui.pick.worker, planner: ui.pick.planner };
  if (ui.pick.reviewer) c.reviewer = ui.pick.reviewer;
  if (ui.pick.researcher) c.researcher = ui.pick.researcher;
  return c;
}

function pickerHtml(role) {
  const opts = pickerOptions(ui.models, role)
    .map(
      (o) =>
        `<option value="${esc(o.value)}"${o.disabled ? " disabled" : ""}${ui.pick[role] === o.value ? " selected" : ""}>${esc(o.label)}</option>`,
    )
    .join("");
  const none =
    role === "reviewer" || role === "researcher"
      ? `<option value="">(none)</option>`
      : `<option value="">Choose…</option>`;
  return `<label class="bench-pick">${esc(ROLE_NAMES[role])} <select data-role="${esc(role)}">${none}${opts}</select></label>`;
}

function qualifiedFor(c) {
  const out = {};
  for (const role of ROLES) {
    if (!c[role]) continue;
    const r = ui.roles.find((x) => x.role === role);
    out[role] = !!r && r.model === c[role] ? !!r.qualified : false;
  }
  return out;
}

function resultHtml(r) {
  const roles = (r.roles || [])
    .map(
      (s) =>
        `<li>${esc(ROLE_NAMES[s.role] || s.role)} ${esc(s.model)}: ${esc(roleScoreText(s))}</li>`,
    )
    .join("");
  const e2e = r.endToEnd
    ? `<p>End-to-end check: ${esc(`${r.endToEnd.passed}/${r.endToEnd.total}`)} cards passed (beside the scores)</p>`
    : "";
  const tied = r.indistinguishableFrom?.length
    ? `<p>No clear difference from ${esc(r.indistinguishableFrom.length)} other combination(s) on the ${esc(r.tier)} benchmark</p>`
    : "";
  const action = assignAction(qualifiedFor(r.combination));
  return `<article class="bench-result" data-id="${esc(r.combinationId)}">
    <h4>${esc(r.tier === "quick" ? "Quick" : "Overnight")} — ${esc(
      ROLES.filter((x) => r.combination[x])
        .map((x) => `${ROLE_NAMES[x]} ${r.combination[x]}`)
        .join(" · "),
    )}</h4>
    <ul>${roles}</ul>${e2e}${tied}
    <button class="btn" type="button" data-assign="${esc(r.combinationId)}">${esc(action)}</button>
  </article>`;
}

function render() {
  if (!ui.root) return;
  const ready = ui.pick.worker && ui.pick.planner;
  const runs = (ui.data.runs || [])
    .map(
      (r) =>
        `<li>${esc(r.tier)} ${esc(r.runId)}: ${esc(runStateText(r))}${r.state === "running" || r.state === "queued" ? ` <button class="btn" type="button" data-stop="${esc(r.runId)}">Stop</button>` : ""}</li>`,
    )
    .join("");
  ui.root.innerHTML = `<section class="config-benchmark" aria-labelledby="bench-h">
    <h3 id="bench-h">Benchmark</h3>
    <p class="bench-copy">${esc(QUICK_COPY)}.</p>
    <div class="bench-builder">${ROLES.map(pickerHtml).join("")}</div>
    <p>${
      ui.confirming
        ? `<button class="btn" type="button" data-confirm>Start — ${esc(estimateLabel(ui.estimate).replace(/^Run quick — /, ""))}</button> <button class="btn" type="button" data-cancel>Cancel</button>`
        : `<button class="btn" type="button" data-quick${ready ? "" : " disabled"}>${esc(estimateLabel(ui.estimate))}</button>`
    } <button class="btn" type="button" data-overnight>Schedule overnight comparison</button></p>
    ${ui.overnight ? `<p class="bench-overnight">${esc(ui.overnight)}</p>` : ""}
    ${ui.message ? `<p role="status">${esc(ui.message)}</p>` : ""}
    <h4>Runs</h4><ul class="bench-runs">${runs || "<li>No runs yet.</li>"}</ul>
    <h4>Results</h4>${(ui.data.results || []).map(resultHtml).join("") || "<p>Nothing benchmarked yet.</p>"}
  </section>`;
}

async function refresh() {
  const [models, roles, bench] = await Promise.all([
    getJSON("/api/config/models"),
    getJSON("/api/config/roles"),
    getJSON("/api/config/benchmark"),
  ]);
  if (models.ok) ui.models = models.data?.models || [];
  if (roles.ok) ui.roles = roles.data?.roles || [];
  if (bench.ok) ui.data = bench.data;
  render();
}

async function estimate() {
  ui.estimate = null;
  if (ui.pick.worker && ui.pick.planner) {
    const q = new URLSearchParams({ tier: "quick", ...combination() });
    const r = await getJSON(`/api/config/benchmark/estimate?${q}`);
    if (r.ok) ui.estimate = r.data;
  }
  render();
}

/** The top combinations the quick tier could not separate, at most three (DB-N6-11). */
function defaultPicks() {
  const quick = (ui.data.results || []).filter((r) => r.tier === "quick" && r.score);
  quick.sort((a, b) => b.score.value - a.score.value);
  const top = quick[0];
  if (!top || !top.indistinguishableFrom?.length) return [];
  return [
    top,
    ...quick.slice(1).filter((r) => top.indistinguishableFrom.includes(r.combinationId)),
  ].slice(0, 3);
}

async function onClick(e) {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.hasAttribute("data-quick")) {
    ui.confirming = true;
    return render();
  }
  if (t.hasAttribute("data-cancel")) {
    ui.confirming = false;
    return render();
  }
  if (t.hasAttribute("data-confirm")) {
    ui.confirming = false;
    const r = await postJSON("/api/config/benchmark", {
      tier: "quick",
      combinations: [combination()],
    });
    ui.message = r.ok
      ? "Quick benchmark started."
      : r.data?.error || "The quick benchmark could not start.";
    return refresh();
  }
  if (t.hasAttribute("data-overnight")) {
    const picks = defaultPicks();
    const combos = picks.length
      ? picks.map((p) => p.combination)
      : ui.pick.worker && ui.pick.planner
        ? [combination()]
        : [];
    if (!combos.length) {
      ui.message = "Pick a combination first.";
      return render();
    }
    const r = await postJSON("/api/config/benchmark", { tier: "overnight", combinations: combos });
    ui.overnight = r.ok
      ? r.data?.line || "Queued for the overnight window."
      : r.data?.error || "Could not schedule it.";
    return refresh();
  }
  const stop = t.getAttribute("data-stop");
  if (stop) {
    await postJSON(`/api/config/benchmark/runs/${encodeURIComponent(stop)}/stop`, {});
    return refresh();
  }
  const assign = t.getAttribute("data-assign");
  if (assign) {
    const row = (ui.data.results || []).find((r) => r.combinationId === assign);
    if (!row) return;
    const qualified = qualifiedFor(row.combination);
    for (const role of Object.keys(qualified)) {
      const model = row.combination[role];
      const r = qualified[role]
        ? await sendJSON("PUT", `/api/config/roles/${role}`, { model })
        : await postJSON(`/api/config/roles/${role}/qualify`, { model });
      if (!r.ok) {
        ui.message =
          r.data?.error ||
          `Could not ${qualified[role] ? "assign" : "verify on this machine"} the ${ROLE_NAMES[role]}.`;
        break;
      }
    }
    return refresh();
  }
}

/**
 * Mount the Benchmark section into `root` (called by `configuration.js`).
 * Returns `refresh`, for the page's `config` stream events
 * (`{ kind: "benchmark", run }`).
 */
export function mountBenchmark(root) {
  ui.root = root;
  root.addEventListener("click", (e) => void onClick(e));
  root.addEventListener("change", (e) => {
    const role = e.target?.getAttribute?.("data-role");
    if (!role) return;
    ui.pick[role] = e.target.value;
    ui.confirming = false;
    void estimate();
  });
  void refresh();
  return { refresh };
}
