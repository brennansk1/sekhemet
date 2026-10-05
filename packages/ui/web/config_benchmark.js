// Configuration › Benchmark (dashboard NEW-dashboard-6, DB-N6-9–22;
// measurement NEW-measurement-5, -7, -8): pick one model per role and its
// settings, see the quick screen's estimate before anything loads, run it,
// stop it, read each role's score with its range and secondary measures,
// compare paired, schedule an overnight comparison and read its morning
// report; Find best settings per role with its verdict in words and Apply;
// each combination's history with inline SVG charts and their tables; the
// capstone's and Web-Bench's recorded results with their protocol. Every
// disabled control says why (FINDINGS CFG-10), and a person without the
// Admin level sees every control read-only with the level note (DB-N6-15).
// Mounted by `configuration.js`. Nothing here assigns or applies on its own:
// Assign, Verify and Apply are a person's presses (DB-N6-13, MS-N7-7).
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
  if (!e.totalMinutes) return "Run quick · everything is cached";
  const over = (e.roles || []).filter((r) => r.overTarget).map((r) => ROLE_NAMES[r.role] || r.role);
  if (e.endToEnd?.overTarget) over.push("end-to-end check");
  const tail = over.length
    ? ` (${over.join(", ")} over ${over.length > 1 ? "their targets" : "its target"})`
    : "";
  return `Run quick · about ${Math.round(e.totalMinutes)} min${tail}${e.overTarget && !over.length ? " (over the 45-minute target)" : ""}`;
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
        label: `${m.name} · ${gb ? `Needs ${gb} GB` : "Does not fit"}`,
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
    return s?.state === "partial" ? "Partial · not scored" : "Not measured yet";
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
    return run.progress ? `Running · ${run.progress.done} of ${run.progress.total}` : "Running";
  if (run.state === "stopped")
    return `Stopped · results so far kept${run.partial ? " (partial)" : ""}`;
  if (run.state === "done") return "Done";
  if (run.state === "failed") return "Failed · results so far kept";
  const s = run.schedule;
  if (run.tier === "overnight" && s) {
    const n = run.combinations.length;
    return `Queued · Tonight ${s.window.start}–${s.window.end}: ${s.fitsTonight} of ${n} combination${n === 1 ? "" : "s"} ${s.fitsTonight === 1 ? "fits" : "fit"}`;
  }
  return "Queued";
}

/** DB-N6-13: assign only a row whose models are all qualified here; else offer to qualify. */
export function assignAction(qualifiedByRole) {
  return Object.values(qualifiedByRole).every(Boolean)
    ? "Assign this combination"
    : "Verify on this machine to assign";
}

/* ---------- settings in words (measurement rule 39) ---------- */

const SETTING_WORDS = {
  temperature: (v) => `temperature ${v}`,
  reasoningLevel: (v) => `reasoning ${v}`,
  reasoningCapTokens: (v) => `thinking cap ${Number(v).toLocaleString("en-US")}`,
  reasoningPolicy: (v) => `thinking policy ${v}`,
  method: (v) => `working method ${v}`,
  evidenceGate: (v) => `evidence check ${v}`,
  toolArm: (v) => `tool arm ${v}`,
  stepBudget: (v) => `step budget ${v}`,
};

/** A role's settings in words: `temperature 0.2, reasoning medium`; empty for none. */
export function settingsWords(values) {
  return Object.entries(values || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => (SETTING_WORDS[k] ? SETTING_WORDS[k](v) : `${k} ${v}`))
    .join(", ");
}

/** A combination's models and settings in words, role by role. */
export function combinationWords(c) {
  return ROLES.filter((r) => c?.[r])
    .map((r) => {
      const s = settingsWords(c.settings?.[r]);
      return `${ROLE_NAMES[r]} ${c[r]}${s ? ` (${s})` : ""}`;
    })
    .join(" · ");
}

/** The words a Find best settings verdict is said in (DB-N6-21, MS-N7-4). */
export function tuneVerdictText(run) {
  if (!run) return "Not run yet.";
  if (run.state === "running")
    return `Running${run.rung ? ` · step ${run.rung} of the screen` : ""}${run.candidatesLeft ? ` · ${run.candidatesLeft} settings left` : ""}`;
  if (run.state === "failed") return `Failed: ${run.error || "the run did not finish"}.`;
  if (run.partial || run.verdict === "partial")
    return "Stopped before a verdict; what it measured is kept.";
  const c = run.comparison;
  const unit = run.role === "reviewer" ? "seeded defects" : "issues";
  const n = c ? c.better + c.worse + c.ties : 0;
  const words = run.survivor?.words || settingsWords(run.adopted);
  if (run.verdict === "best")
    return `Best combination: ${words} — higher on ${c?.better ?? 0} of ${n} ${unit} (p = ${(c?.p ?? 1).toFixed(3)}).`;
  if (run.verdict === "cheaper")
    return `No clear difference in quality, and ${words} was faster (not established).`;
  if (run.verdict === "worse")
    return `No clear difference: ${words} did well on the hardest items but worse on the whole screen, so the current settings stay.`;
  return "No clear difference: the screen could not tell the settings apart, so the current settings stay.";
}

/** Why *Run quick* cannot start, or "" (FINDINGS CFG-10). */
export function quickDisabledReason({ readOnly, pick, models, busy }) {
  if (readOnly) return readOnly;
  if (!pick.worker || !pick.planner)
    return "Choose a Coding model and a Planning model to run the quick benchmark.";
  if (busy) return `A ${busy.tier} run is going (${busy.runId}); one run at a time.`;
  for (const role of ROLES) {
    const m = (models || []).find((x) => x.id === pick[role]);
    if (m && m.fits?.[role] === "no")
      return `${m.name} does not fit this machine for the ${ROLE_NAMES[role]}.`;
  }
  return "";
}

/** Why *Schedule overnight* cannot be pressed, or "" (FINDINGS CFG-10). */
export function overnightDisabledReason({ readOnly, pick, picks }) {
  if (readOnly) return readOnly;
  if (picks.length) return "";
  if (pick.worker && pick.planner) return "";
  return "Choose a Coding model and a Planning model, or run quick benchmarks to compare first.";
}

/* ---------- charts: inline SVG, each with a table of the same numbers ---------- */

const W = 320;
const H = 140;
const PAD = 28;

/**
 * DB-N6-22: a combination's score per run, each with its item range as a
 * vertical bar, scored 0 to 1. An image with its own label; its numbers are
 * in the table beside it.
 */
export function historyChartSvg(runs, label) {
  const points = (runs || []).filter((r) => r.score);
  const n = points.length;
  const x = (i) => (n <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (n - 1));
  const y = (v) => H - PAD + (Math.max(0, Math.min(1, v)) * (2 * PAD - H)) / 1;
  const range = (r) => {
    const roles = (r.roles || []).filter((s) => s.score);
    const lows = roles.map((s) => s.score.low ?? s.score.value);
    const highs = roles.map((s) => s.score.high ?? s.score.value);
    return lows.length ? [Math.min(...lows), Math.max(...highs)] : [r.score.value, r.score.value];
  };
  const bars = points
    .map((r, i) => {
      const [lo, hi] = range(r);
      return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(lo)}" y2="${y(hi)}" stroke="currentColor" stroke-opacity="0.45" stroke-width="6" stroke-linecap="round"/>`;
    })
    .join("");
  const line = points.map((r, i) => `${i ? "L" : "M"}${x(i)},${y(r.score.value)}`).join(" ");
  const dots = points
    .map(
      (r, i) =>
        `<circle cx="${x(i)}" cy="${y(r.score.value)}" r="4" fill="var(--accent, currentColor)"/>`,
    )
    .join("");
  const axis = `<line x1="${PAD}" x2="${W - PAD}" y1="${H - PAD}" y2="${H - PAD}" stroke="currentColor" stroke-opacity="0.3"/><text x="4" y="${y(1) + 4}" font-size="10" fill="currentColor">1</text><text x="4" y="${y(0) + 4}" font-size="10" fill="currentColor">0</text>`;
  return `<svg class="bench-chart" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;color:var(--text-secondary)" role="img" aria-label="${esc(label)}">${axis}${bars}${n > 1 ? `<path d="${line}" fill="none" stroke="var(--accent, currentColor)" stroke-width="2"/>` : ""}${dots}</svg>`;
}

/** DB-N6-22: the latest run's role scores side by side, each 0 to 1. */
export function roleBarsSvg(roles, label) {
  const scored = (roles || []).filter((s) => s.score);
  const bw = scored.length ? Math.min(48, (W - 2 * PAD) / scored.length - 12) : 0;
  const bars = scored
    .map((s, i) => {
      const x = PAD + i * (bw + 12);
      const h = Math.max(1, s.score.value * (H - 2 * PAD));
      return `<rect x="${x}" y="${H - PAD - h}" width="${bw}" height="${h}" rx="3" fill="var(--accent, currentColor)"/><text x="${x}" y="${H - PAD + 14}" font-size="10" fill="currentColor">${esc((ROLE_NAMES[s.role] || s.role).replace(" model", ""))}</text>`;
    })
    .join("");
  return `<svg class="bench-chart" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;height:auto;color:var(--text-secondary)" role="img" aria-label="${esc(label)}"><line x1="${PAD}" x2="${W - PAD}" y1="${H - PAD}" y2="${H - PAD}" stroke="currentColor" stroke-opacity="0.3"/>${bars}</svg>`;
}

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");

function historyHtml(h) {
  const name = combinationWords(h.combination);
  const rows = h.runs
    .map((r) => {
      const v = r.versusPrevious;
      const vs = v
        ? `${v.outcome === "better" ? "Better" : v.outcome === "worse" ? "Worse" : "No clear difference"} (${v.better} better, ${v.worse} worse, ${v.ties} tied; p = ${v.p.toFixed(3)})`
        : "First run";
      const settings = ROLES.map((role) => settingsWords(r.settings?.[role]))
        .filter(Boolean)
        .join("; ");
      return `<tr><td>${esc(day(r.date))}</td><td>${esc(r.tier === "quick" ? "Quick" : "Overnight")}${r.partial ? " (partial)" : ""}</td><td>${esc(settings || "As set")}</td><td>${r.score ? esc(two(r.score.value)) : "—"}</td><td>${esc(vs)}</td></tr>`;
    })
    .join("");
  const latest = h.runs.at(-1);
  return `<article class="bench-history-row cfg-part" data-id="${esc(h.combinationId)}">
    <h5 style="margin:0;font-size:var(--text-sm)">${esc(name)}</h5>
    <div class="row" style="align-items:flex-start">
      <figure style="margin:0;flex:1 1 220px;min-width:0">${historyChartSvg(h.runs, `Score per run for ${name}`)}<figcaption class="sec">Score per run, with the range of its item scores</figcaption></figure>
      <figure style="margin:0;flex:1 1 220px;min-width:0">${roleBarsSvg(latest?.roles, `Role scores of the latest run for ${name}`)}<figcaption class="sec">Role scores, latest run</figcaption></figure>
    </div>
    <div class="tbl-wrap" tabindex="0" style="overflow-x:auto;max-width:100%"><table class="tbl bench-table" aria-label="${esc(`Runs of ${name}`)}"><thead><tr><th scope="col">Date</th><th scope="col">Tier</th><th scope="col">Settings</th><th scope="col">Score</th><th scope="col">Against the run before</th></tr></thead><tbody>${rows}</tbody></table></div>
  </article>`;
}

/** DB-N6-22, MS-N8-4: the capstone's and Web-Bench's recorded results with their protocol. */
export function externalHtml(x) {
  const ext = x || { capstone: [], webbench: [], protocol: {} };
  const scores = (s) =>
    Object.entries(s || {})
      .map(([k, v]) => `${k} ${v === null || v === undefined ? "—" : pct(v)}`)
      .join(" · ");
  const capstone = ext.capstone.length
    ? `<ul>${ext.capstone
        .map(
          (r) =>
            `<li>${esc(r.arm)} run ${esc(r.run)} · ${esc(scores(r.scores))}${r.valid ? "" : ` · <span class="why">Not counted: ${esc(r.why || "not a valid run")}</span>`}</li>`,
        )
        .join("")}</ul>`
    : "<p>No capstone result is recorded on this machine yet.</p>";
  const webbench = ext.webbench.length
    ? `<ul>${ext.webbench
        .map(
          (r) =>
            `<li>${esc(r.arm)} run ${esc(r.run)}${r.project ? ` · ${esc(r.project)} @ ${esc(r.commit || "")}` : ""} · ${esc(scores(r.scores))}</li>`,
        )
        .join("")}</ul>`
    : "<p>No Web-Bench result is recorded on this machine yet.</p>";
  return `<h5 style="margin:0;font-size:var(--text-sm)">Capstone</h5><p class="sec">${esc(ext.protocol?.capstone || "")}</p>${capstone}<h5 style="margin:8px 0 0;font-size:var(--text-sm)">Web-Bench</h5><p class="sec">${esc(ext.protocol?.webbench || "")}</p>${webbench}`;
}

/* ---------- the section, one state per mount ---------- */

const slug = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Mount the Benchmark section into `root` (called by `configuration.js`).
 * Returns `refresh` (for the page's `config` stream events,
 * `{ kind: "benchmark", run }`), `unmount`, and `ready`, which resolves after
 * the first render with data.
 */
export function mountBenchmark(root, { readOnly = "" } = {}) {
  const ui = {
    models: [],
    roles: [],
    data: { runs: [], results: [], roleScores: [] },
    history: { combinations: [], external: null },
    tune: { roles: {}, runs: [] },
    estimates: {},
    pick: { worker: "", planner: "", reviewer: "", researcher: "" },
    settings: { worker: "", planner: "", reviewer: "", researcher: "" },
    estimate: null,
    confirming: false,
    tuneConfirm: "",
    message: "",
    overnight: "",
    timer: 0,
    gone: false,
  };
  const dis = (reason) => (reason ? " disabled" : "");
  const describedBy = (id, reason) => (reason ? ` aria-describedby="${id}"` : "");
  const roId = "bench-ro";

  const modelOf = (id) => ui.models.find((m) => m.id === id);
  /** The ids a run may name a found model by. */
  const idsOf = (id) => {
    const m = modelOf(id);
    return new Set([id, m?.registryId, m?.sha256, m && slug(m.name), m?.name].filter(Boolean));
  };
  const current = (role) => ui.roles.find((r) => r.role === role)?.model || "";
  /** The model a role's tune card is about: the one picked, else the role's current one. */
  const tuneModel = (role) => {
    const picked = ui.pick[role];
    if (picked) {
      const m = modelOf(picked);
      return m?.registryId || (m ? slug(m.name) : picked);
    }
    return current(role) || ui.tune.runs.find((r) => r.role === role)?.model || "";
  };
  /** The settings found for a role's picked model: a run's adopted values (rule 39). */
  const settingsChoices = (role) => {
    if (!ui.pick[role]) return [];
    const ids = idsOf(ui.pick[role]);
    const seen = new Set();
    const out = [];
    for (const r of ui.tune.runs) {
      if (r.role !== role || !ids.has(r.model) || !r.adopted) continue;
      const words = settingsWords(r.adopted);
      if (!words || seen.has(words)) continue;
      seen.add(words);
      out.push({ value: JSON.stringify(r.adopted), label: words });
    }
    return out;
  };

  function combination() {
    const c = { worker: ui.pick.worker, planner: ui.pick.planner };
    if (ui.pick.reviewer) c.reviewer = ui.pick.reviewer;
    if (ui.pick.researcher) c.researcher = ui.pick.researcher;
    const settings = {};
    for (const role of ROLES) {
      if (ui.pick[role] && ui.settings[role]) settings[role] = JSON.parse(ui.settings[role]);
    }
    if (Object.keys(settings).length) c.settings = settings;
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
    const choices = settingsChoices(role);
    const sOpts = [`<option value="">As set</option>`]
      .concat(
        choices.map(
          (c) =>
            `<option value="${esc(c.value)}"${ui.settings[role] === c.value ? " selected" : ""}>${esc(c.label)}</option>`,
        ),
      )
      .join("");
    const field = "display:flex;flex-direction:column;gap:4px;min-width:0";
    return `<div class="bench-role" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px 16px;align-items:end">
      <label style="${field}">${esc(ROLE_NAMES[role])} <select data-role="${esc(role)}" style="width:100%"${dis(readOnly)}${describedBy(roId, readOnly)}>${none}${opts}</select></label>
      <label style="${field}">Settings <select data-settings-role="${esc(role)}" style="width:100%"${dis(readOnly || (!ui.pick[role] ? "pick" : ""))}${describedBy(readOnly ? roId : `bench-set-why-${role}`, readOnly || !ui.pick[role])}>${sOpts}</select></label>
      ${!readOnly && !ui.pick[role] ? `<span class="why" id="bench-set-why-${esc(role)}" style="align-self:center">Choose the ${esc(ROLE_NAMES[role])} first to pick its settings.</span>` : "<span></span>"}
    </div>`;
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
      ? `<p>End-to-end check: ${esc(`${r.endToEnd.passed}/${r.endToEnd.total}`)} issues passed (beside the scores)</p>`
      : "";
    const tied = r.indistinguishableFrom?.length
      ? `<p>No clear difference from ${esc(r.indistinguishableFrom.length)} other ${r.indistinguishableFrom.length === 1 ? "combination" : "combinations"} on the ${esc(r.tier)} benchmark</p>`
      : "";
    const action = assignAction(qualifiedFor(r.combination));
    return `<article class="bench-result" data-id="${esc(r.combinationId)}">
      <h5 style="margin:8px 0 4px;font-size:var(--text-sm)">${esc(r.tier === "quick" ? "Quick" : "Overnight")} · ${esc(combinationWords(r.combination))}</h5>
      <ul>${roles}</ul>${e2e}${tied}
      <button class="btn" type="button" data-assign="${esc(r.combinationId)}"${dis(readOnly)}${describedBy(roId, readOnly)}>${esc(action)}</button>
    </article>`;
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

  function tuneCardHtml(role) {
    const state = ui.tune.roles?.[role];
    const name = ROLE_NAMES[role];
    if (state && !state.tunable)
      return `<article class="tune-role cfg-part" data-tune-role="${esc(role)}"><h5 style="margin:0;font-size:var(--text-sm)">${esc(name)}</h5><p class="why">${esc(state.reason || "Its screen is not built yet.")}</p></article>`;
    const runs = ui.tune.runs.filter((r) => r.role === role);
    const latest = runs[0];
    const model = tuneModel(role);
    const running = latest?.state === "running";
    const busy = ui.data.runs.find((r) => r.state === "running");
    const startReason =
      readOnly ||
      (running ? "A run is going: stop it or wait for it to end." : "") ||
      (!model ? `Choose the ${name} above first.` : "") ||
      (busy ? `A ${busy.tier} benchmark is going (${busy.runId}); one run at a time.` : "");
    const applyReason =
      readOnly ||
      (!latest
        ? "Nothing to apply until a run finds a better setting."
        : running
          ? "Apply when the run ends."
          : latest.partial || latest.verdict === "partial"
            ? "The run stopped before a verdict: nothing to apply."
            : !latest.adopted
              ? "No clear difference: nothing to apply."
              : latest.applied
                ? "Applied."
                : "");
    const settleBase = {
      worker: ui.pick.worker || current("worker"),
      planner: ui.pick.planner || current("planner"),
      reviewer: ui.pick.reviewer || current("reviewer"),
    };
    const settleReason =
      readOnly ||
      (!latest || running
        ? "Run Find best settings first: the overnight benchmark settles what it could not tell apart."
        : latest.verdict === "best" || latest.verdict === "cheaper"
          ? "The screen gave a result: apply it instead."
          : !latest.contender
            ? "Nothing close to settle: no other setting came near the current one."
            : !settleBase.worker || !settleBase.planner
              ? "Choose a Coding model and a Planning model above to compare overnight."
              : role === "reviewer" && !settleBase.reviewer
                ? "Choose the Review model above to compare overnight."
                : "");
    const est = ui.estimates[role];
    const confirm =
      ui.tuneConfirm === role && est && !est.refused
        ? `<div class="tune-confirm" role="group" aria-label="${esc(`Confirm Find best settings for the ${name}`)}"><p>${esc(`${est.candidates.length} settings to try on ${model}, the current ones included: ${est.candidates.map((c) => c.words).join("; ")}.`)}</p><p class="sec">${esc(`About ${est.minutes} min, one load included. First the machine's memory is checked, then the runner is taken; nothing loads before you press Start.`)}</p><p><button class="btn primary" type="button" data-tune-start="${esc(role)}">Start</button> <button class="btn" type="button" data-tune-cancel>Cancel</button></p></div>`
        : "";
    return `<article class="tune-role cfg-part" data-tune-role="${esc(role)}">
      <h5 style="margin:0;font-size:var(--text-sm)">${esc(name)}${model ? ` · ${esc(model)}` : ""}</h5>
      <p class="tune-verdict" role="status">${esc(tuneVerdictText(latest))}</p>
      <div class="row">
        ${
          running
            ? `<button class="btn" type="button" data-tune-stop="${esc(latest.runId)}"${dis(readOnly)}${describedBy(roId, readOnly)}>Stop</button>`
            : `<button class="btn" type="button" data-tune-open="${esc(role)}"${dis(startReason)}${describedBy(readOnly ? roId : `tune-start-why-${role}`, startReason)}>Find best settings…</button>`
        }
        <button class="btn" type="button" data-tune-apply="${esc(latest?.runId || "")}"${dis(applyReason)}${describedBy(readOnly ? roId : `tune-apply-why-${role}`, applyReason)}>Apply</button>
        <button class="btn" type="button" data-tune-settle="${esc(role)}"${dis(settleReason)}${describedBy(readOnly ? roId : `tune-settle-why-${role}`, settleReason)}>Settle overnight</button>
      </div>
      ${!readOnly && startReason && !running ? `<p class="why" id="tune-start-why-${esc(role)}">${esc(startReason)}</p>` : ""}
      ${!readOnly && applyReason ? `<p class="why" id="tune-apply-why-${esc(role)}">${esc(applyReason)}</p>` : ""}
      ${!readOnly && settleReason ? `<p class="why" id="tune-settle-why-${esc(role)}">${esc(settleReason)}</p>` : ""}
      ${confirm}
    </article>`;
  }

  function render() {
    if (ui.gone) return;
    const busy = (ui.data.runs || []).find((r) => r.state === "running");
    const quickReason = quickDisabledReason({ readOnly, pick: ui.pick, models: ui.models, busy });
    const overnightReason = overnightDisabledReason({
      readOnly,
      pick: ui.pick,
      picks: defaultPicks(),
    });
    const runs = (ui.data.runs || [])
      .map(
        (r) =>
          `<li>${esc(r.tier)} ${esc(r.runId)}: ${esc(runStateText(r))}${r.state === "running" || r.state === "queued" ? ` <button class="btn" type="button" data-stop="${esc(r.runId)}"${dis(readOnly)}${describedBy(roId, readOnly)}>Stop</button>` : ""}</li>`,
      )
      .join("");
    const history = (ui.history.combinations || []).map(historyHtml).join("");
    root.innerHTML = `<section class="config-benchmark" aria-labelledby="bench-h" style="display:flex;flex-direction:column;gap:16px;min-width:0">
      <h3 id="bench-h">Benchmark</h3>
      ${readOnly ? `<p class="readonly-note" id="${roId}">${esc(readOnly)}</p>` : ""}
      <p class="bench-copy">${esc(QUICK_COPY)}.</p>
      <div class="cfg-card"><h4>Compare setups</h4>
        <div class="bench-builder" style="display:grid;gap:12px">${ROLES.map(pickerHtml).join("")}</div>
        <div class="row">${
          ui.confirming
            ? `<button class="btn primary" type="button" data-confirm>Start · ${esc(estimateLabel(ui.estimate).replace(/^Run quick · /, ""))}</button> <button class="btn" type="button" data-cancel>Cancel</button>`
            : `<button class="btn" type="button" data-quick${dis(quickReason)}${describedBy(readOnly ? roId : "bench-quick-why", quickReason)}>${esc(estimateLabel(ui.estimate))}</button>`
        } <button class="btn" type="button" data-overnight${dis(overnightReason)}${describedBy(readOnly ? roId : "bench-overnight-why", overnightReason)}>Schedule overnight comparison</button></div>
        ${!readOnly && quickReason ? `<p class="why" id="bench-quick-why">${esc(quickReason)}</p>` : ""}
        ${!readOnly && overnightReason ? `<p class="why" id="bench-overnight-why">${esc(overnightReason)}</p>` : ""}
        ${ui.overnight ? `<p class="bench-overnight">${esc(ui.overnight)}</p>` : ""}
        ${ui.message ? `<p role="status">${esc(ui.message)}</p>` : ""}
      </div>
      <div class="cfg-card bench-tune"><h4>Find best settings</h4>
        <p class="sec">Tries settings for one model on the issues it found hardest, keeps the better half each round, then compares the best with the current settings on the whole screen. On six issues only a setting better on all six counts as better; the overnight benchmark settles close calls. Nothing changes until you press Apply.</p>
        ${ROLES.map(tuneCardHtml).join("")}
      </div>
      <div class="cfg-card"><h4>Runs</h4><ul class="bench-runs">${runs || "<li>No runs yet.</li>"}</ul></div>
      <div class="cfg-card"><h4>Results</h4>${(ui.data.results || []).map(resultHtml).join("") || "<p>Nothing benchmarked yet.</p>"}</div>
      <div class="cfg-card bench-history"><h4>History</h4>${history || "<p>No run is recorded yet.</p>"}</div>
      <div class="cfg-card bench-external"><h4>Other benchmarks</h4>${externalHtml(ui.history.external)}</div>
    </section>`;
  }

  async function loadEstimates() {
    for (const role of ["worker", "reviewer"]) {
      const model = tuneModel(role);
      if (!model || !ui.tune.roles?.[role]?.tunable) {
        ui.estimates[role] = null;
        continue;
      }
      const r = await getJSON(`/api/config/benchmark/tune?${new URLSearchParams({ role, model })}`);
      ui.estimates[role] = r.ok ? r.data?.estimate || null : null;
    }
  }

  function schedulePoll() {
    clearTimeout(ui.timer);
    const going =
      ui.tune.runs.some((r) => r.state === "running") ||
      (ui.data.runs || []).some((r) => r.state === "running");
    if (going && !ui.gone) ui.timer = setTimeout(() => void refresh(), 2000);
  }

  async function refresh() {
    const [models, roles, bench, history, tune] = await Promise.all([
      getJSON("/api/config/models"),
      getJSON("/api/config/roles"),
      getJSON("/api/config/benchmark"),
      getJSON("/api/config/benchmark/history"),
      getJSON("/api/config/benchmark/tune"),
    ]);
    if (models.ok) ui.models = models.data?.models || [];
    if (roles.ok) ui.roles = roles.data?.roles || [];
    if (bench.ok) ui.data = bench.data;
    if (history.ok) ui.history = history.data;
    if (tune.ok) ui.tune = tune.data;
    await loadEstimates();
    render();
    schedulePoll();
  }

  async function estimate() {
    ui.estimate = null;
    if (ui.pick.worker && ui.pick.planner) {
      const c = combination();
      const { settings, ...models } = c;
      const q = new URLSearchParams({
        tier: "quick",
        ...models,
        ...(settings ? { settings: JSON.stringify(settings) } : {}),
      });
      const r = await getJSON(`/api/config/benchmark/estimate?${q}`);
      if (r.ok) ui.estimate = r.data;
    }
    render();
  }

  async function onClick(e) {
    const t = e.target.closest("button");
    if (!t || t.disabled || readOnly) return;
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
      const r = await postJSON("/api/config/benchmark", {
        tier: "overnight",
        combinations: combos,
      });
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
    const open = t.getAttribute("data-tune-open");
    if (open) {
      ui.tuneConfirm = open;
      if (!ui.estimates[open]) await loadEstimates();
      const est = ui.estimates[open];
      if (est?.refused) ui.message = est.refused;
      return render();
    }
    if (t.hasAttribute("data-tune-cancel")) {
      ui.tuneConfirm = "";
      return render();
    }
    const start = t.getAttribute("data-tune-start");
    if (start) {
      ui.tuneConfirm = "";
      const r = await postJSON("/api/config/benchmark/tune", {
        role: start,
        model: tuneModel(start),
        confirm: true,
      });
      ui.message = r.ok
        ? `Find best settings started for the ${ROLE_NAMES[start]}.`
        : r.data?.error || "Find best settings could not start.";
      return refresh();
    }
    const tstop = t.getAttribute("data-tune-stop");
    if (tstop) {
      await postJSON(`/api/config/benchmark/tune/${encodeURIComponent(tstop)}/stop`, {});
      return refresh();
    }
    const apply = t.getAttribute("data-tune-apply");
    if (apply) {
      const r = await postJSON(`/api/config/benchmark/tune/${encodeURIComponent(apply)}/apply`, {});
      ui.message = r.ok
        ? `Applied ${settingsWords(r.data?.applied)}.${r.data?.needsVerifying ? " The role needs verifying on this machine before it runs again: Models › Verify now." : ""}`
        : r.data?.error || "Could not apply it.";
      return refresh();
    }
    const settle = t.getAttribute("data-tune-settle");
    if (settle) {
      const run = ui.tune.runs.find((r) => r.role === settle);
      const base = {
        worker: ui.pick.worker || current("worker"),
        planner: ui.pick.planner || current("planner"),
      };
      const reviewer = ui.pick.reviewer || current("reviewer");
      if (reviewer) base.reviewer = reviewer;
      const r = await postJSON("/api/config/benchmark", {
        tier: "overnight",
        combinations: [base, { ...base, settings: { [settle]: run?.contender?.values || {} } }],
      });
      ui.overnight = r.ok
        ? r.data?.line || "Queued for the overnight window."
        : r.data?.error || "Could not schedule it.";
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

  const click = (e) => void onClick(e);
  const change = (e) => {
    if (readOnly) return;
    const role = e.target?.getAttribute?.("data-role");
    const sRole = e.target?.getAttribute?.("data-settings-role");
    if (role) {
      ui.pick[role] = e.target.value;
      ui.settings[role] = "";
    } else if (sRole) ui.settings[sRole] = e.target.value;
    else return;
    ui.confirming = false;
    void loadEstimates().then(estimate);
  };
  root.addEventListener("click", click);
  root.addEventListener("change", change);
  const ready = refresh();
  return {
    refresh,
    ready,
    unmount() {
      ui.gone = true;
      clearTimeout(ui.timer);
      root.removeEventListener("click", click);
      root.removeEventListener("change", change);
    },
  };
}
