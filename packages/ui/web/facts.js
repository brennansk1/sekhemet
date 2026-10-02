// Facts rail (FRONTEND_DESIGN §2.4.1): Done when, Run, Scope, Provenance.
import { esc, icon } from "./dom.js";
import { REVIEW_DESK_COPY } from "./lib/review_desk.js";
import {
  EMPTY_SHA256,
  formatDuration,
  formatTokens,
  isolationLabel,
  stopReasonLabel,
} from "./lib/vocabulary.js";
import { builtByFact } from "./review_desk.js";

function copyBtn(value, label) {
  return `<button type="button" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">${icon("copy", 14, "ic s14")}</button>`;
}

/**
 * The facts sections as HTML, shared by the rail and the 1024px disclosure.
 * `detail` (the loaded card detail) adds who built it (DB-N5-4).
 */
export function factsSections(card, evidence, detail) {
  const built = detail?.desk
    ? `<dt>${esc(REVIEW_DESK_COPY.builtByLabel)}</dt><dd>${esc(builtByFact(detail))}</dd>`
    : "";
  const criteria = card?.acceptanceCriteria ?? [];
  // REV-01: say how the criteria were checked only as it is — by acceptance
  // tests when the issue has them, else by no test (the AI review reads them).
  const tests = (card?.acceptanceTests ?? []).length > 0;
  const note = !evidence?.passed
    ? ""
    : tests
      ? "All checks passed. The criteria are checked by the acceptance tests."
      : detail?.desk?.findings?.length
        ? "No acceptance test checks these criteria; the AI review read them against the diff."
        : "No acceptance test checks these criteria.";
  const crit = criteria.length
    ? `<ul class="crit">${criteria.map((c) => `<li><span class="bul" aria-hidden="true"></span><span>${esc(c)}</span></li>`).join("")}</ul>${note ? `<p class="crit-note">${esc(note)}</p>` : ""}`
    : '<p class="sec" style="font-size:var(--text-sm)">No criteria recorded for this issue.</p>';

  let run = "";
  if (evidence) {
    const t = evidence.tokens ?? { promptTokens: 0, completionTokens: 0 };
    const iso = isolationLabel(evidence.settings?.isolation);
    const stop = stopReasonLabel(evidence.stopReason);
    // A run without confinement is a warning, so it stays in view; the rest of
    // the run's settings are under Run details (FINDINGS_C1 R-37).
    const isoRow = `<dt>Isolation</dt><dd class="${iso.tone === "parked" ? "i-park" : ""}" title="${esc(iso.sentence)}">${esc(iso.short)}</dd>`;
    run = `<section><h3 class="sh">Run</h3><dl class="kv"><dt>Steps</dt><dd>${esc(evidence.turnsUsed)} of ${esc(card?.stepBudget ?? "?")}</dd><dt>Time</dt><dd>${esc(formatDuration(evidence.durationMs))}</dd><dt>Tokens</dt><dd>${esc(formatTokens(t.promptTokens))} in · ${esc(formatTokens(t.completionTokens))} out</dd>${iso.tone === "parked" ? isoRow : ""}${built}</dl><details class="run-details"><summary>Run details</summary><dl class="kv"><dt>Why it stopped</dt><dd>${esc(stop.sentence)}</dd>${iso.tone === "parked" ? "" : isoRow}<dt>Model</dt><dd class="mono" title="${esc(evidence.settings?.modelId)}">${esc(evidence.settings?.modelId ?? "—")}</dd><dt>Tool format</dt><dd class="mono">${esc(evidence.settings?.toolArm ?? "—")}</dd></dl></details></section>`;
  } else if (card) {
    run = `<section><h3 class="sh">Budget</h3><dl class="kv"><dt>Steps</dt><dd>${esc(card.stepsUsed)} of ${esc(card.stepBudget)}</dd>${built}</dl></section>`;
  }

  const scopeRows = (card?.scopeFiles ?? [])
    .map(
      (f) =>
        `<div class="prov">${icon("file", 14, "ic s14")}<span class="mono">${esc(f)}</span><span class="end">In scope</span></div>`,
    )
    .join("");
  const testRows = (card?.acceptanceTests ?? [])
    .map(
      (f) =>
        `<div class="prov">${icon("lock", 14, "ic s14")}<span class="mono">tests/${esc(f)}</span><span class="end">Protected</span></div>`,
    )
    .join("");
  const scope = `<section><h3 class="sh">Scope</h3>${scopeRows}${testRows || ""}</section>`;

  let prov = "";
  if (evidence) {
    const sha = evidence.checkpointShas?.at?.(-1);
    const gc = evidence.gatesConfigSha256 ?? "";
    const empty = gc === EMPTY_SHA256;
    prov = `<section><h3 class="sh">Provenance</h3><div class="prov">Evidence <span class="mono">${esc(evidence.id)}</span><span class="end">${copyBtn(evidence.id, "evidence id")}</span></div>${sha ? `<div class="prov">Checkpoint <span class="mono" title="${esc(sha)}">${esc(sha.slice(0, 7))}</span><span class="end">${copyBtn(sha, "checkpoint")}</span></div>` : ""}<div class="prov${empty ? " warn" : ""}" ${empty ? 'title="gates.toml hashed to the empty string. These results were not verified against a checks configuration."' : ""}>Checks configuration <span class="mono" title="${esc(gc)}">${esc(gc.slice(0, 8))}…</span><span class="end">${empty ? `${icon("alert", 14, "ic s14 i-park")}<span class="sr-only">Empty checks configuration</span>` : ""}${copyBtn(gc, "checks configuration hash")}</span></div></section>`;
  }

  return `<section><h3 class="sh">Acceptance criteria</h3>${crit}</section>${run}${scope}${prov}`;
}

export function factsRailHtml(card, evidence, { hidden = false, detail } = {}) {
  return `<aside class="facts" aria-label="Facts"${hidden ? " hidden" : ""}>${factsSections(card, evidence, detail)}</aside>`;
}

/** Below 1280px the rail folds into a disclosure under the outcome line. */
export function factsInlineHtml(card, evidence, detail) {
  return `<details class="facts-inline"><summary>Facts</summary><div class="facts-body">${factsSections(card, evidence, detail)}</div></details>`;
}
