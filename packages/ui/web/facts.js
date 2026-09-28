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
  const allPassed = evidence?.passed;
  const crit = criteria.length
    ? `<ul class="crit">${criteria.map((c) => `<li><span class="bul" aria-hidden="true"></span><span>${esc(c)}</span></li>`).join("")}</ul>${allPassed ? '<p class="crit-note">All checks passed. Criteria are checked by the acceptance tests.</p>' : ""}`
    : '<p class="sec" style="font-size:var(--text-sm)">No criteria recorded for this card.</p>';

  let run = "";
  if (evidence) {
    const t = evidence.tokens ?? { promptTokens: 0, completionTokens: 0 };
    run = `<section><h3 class="sh">Run</h3><dl class="kv"><dt>Steps</dt><dd>${esc(evidence.turnsUsed)} of ${esc(card?.stepBudget ?? "?")}</dd><dt>Time</dt><dd>${esc(formatDuration(evidence.durationMs))}</dd><dt>Tokens</dt><dd>${esc(formatTokens(t.promptTokens))} in · ${esc(formatTokens(t.completionTokens))} out</dd><dt>Why it stopped</dt><dd title="${esc(stopReasonLabel(evidence.stopReason).sentence)}">${esc(stopReasonLabel(evidence.stopReason).short)}</dd><dt>Isolation</dt><dd class="${isolationLabel(evidence.settings?.isolation).tone === "parked" ? "i-park" : ""}" title="${esc(isolationLabel(evidence.settings?.isolation).sentence)}">${esc(isolationLabel(evidence.settings?.isolation).short)}</dd><dt>Model</dt><dd class="mono" title="${esc(evidence.settings?.modelId)}">${esc(evidence.settings?.modelId ?? "—")}</dd><dt>Tool set</dt><dd class="mono">${esc(evidence.settings?.toolArm ?? "—")}</dd>${built}</dl></section>`;
  } else if (card) {
    run = `<section><h3 class="sh">Budget</h3><dl class="kv"><dt>Steps</dt><dd>${esc(card.stepsUsed)} of ${esc(card.stepBudget)}</dd>${built}</dl></section>`;
  }

  const scopeRows = (card?.scopeFiles ?? [])
    .map(
      (f) =>
        `<div class="prov">${icon("file", 14, "ic s14")}<span class="mono">${esc(f)}</span><span class="end">May edit</span></div>`,
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

  return `<section><h3 class="sh">Done when</h3>${crit}</section>${run}${scope}${prov}`;
}

export function factsRailHtml(card, evidence, { hidden = false, detail } = {}) {
  return `<aside class="facts" aria-label="Facts"${hidden ? " hidden" : ""}>${factsSections(card, evidence, detail)}</aside>`;
}

/** Below 1280px the rail folds into a disclosure under the outcome line. */
export function factsInlineHtml(card, evidence, detail) {
  return `<details class="facts-inline"><summary>Facts</summary><div class="facts-body">${factsSections(card, evidence, detail)}</div></details>`;
}
