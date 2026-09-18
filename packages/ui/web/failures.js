// Failure blocks (FRONTEND_DESIGN §2.5.4): one block per distinct typed failure,
// same-message failures grouped, protected-test suggestions flagged.
import { errorCode, isAcceptanceTest, matchesAny, stripLocation } from "./diff_parse.js";
import { MOD, esc, icon } from "./dom.js";
import { gateLabel } from "./lib/vocabulary.js";

export function isProtectedPath(path, card, gatesConfig) {
  return (
    isAcceptanceTest(path, card?.acceptanceTests ?? []) ||
    matchesAny(path, gatesConfig?.protected ?? [])
  );
}

/** Group failures by gate, then by (code, file, message) so 3 × TS2353 is one block. */
export function groupFailures(failures = []) {
  const groups = new Map();
  for (const f of failures) {
    const loc = f.location?.file ?? "";
    const msg = stripLocation(f.errorExcerpt, f.location);
    const code = errorCode(f.errorExcerpt) ?? "";
    const gate = f.gate ?? f.rung;
    // Same code in the same file with the same shape of message is one problem.
    const shape = msg.replace(/'[^']*'/g, "'…'");
    const key = `${gate}|${code}|${loc}|${shape}`;
    if (!groups.has(key)) groups.set(key, { gate, rung: f.rung, code, file: loc, items: [] });
    groups.get(key).items.push(f);
  }
  return [...groups.values()];
}

/** "3 × TS2353 in tests/hasher.spec.ts" */
export function failuresHeadline(failures) {
  const groups = groupFailures(failures);
  if (groups.length === 1) {
    const g = groups[0];
    const what = g.code || gateLabel(g.rung);
    return `${g.items.length > 1 ? `${g.items.length} × ` : ""}${what}${g.file ? ` in ${g.file}` : ""}`;
  }
  return `${failures.length} across ${new Set(groups.map((g) => g.gate)).size} gates`;
}

function locText(f, short) {
  const l = f.location;
  if (!l) return "";
  const lc = `${l.line ?? ""}${l.column ? `:${l.column}` : ""}`;
  return short ? `:${lc}` : `${l.file}${lc ? `:${lc}` : ""}`;
}

/**
 * @param opts.card the card (scope and acceptance tests)
 * @param opts.gatesConfig /api/gates payload (protected globs)
 * @param opts.limit show only this many groups (peek drawer)
 */
export function failuresHtml(failures, { card, gatesConfig, limit } = {}) {
  const groups = groupFailures(failures);
  const shown = limit ? groups.slice(0, limit) : groups;
  const blocks = shown.map((g) => {
    const first = g.items[0];
    const links = g.items
      .map((f, i) => {
        if (!f.location) return "";
        const target = `ann-${f.location.file}:${f.location.line ?? 0}`;
        return `<a href="#" data-jump="${esc(target)}">${esc(locText(f, i > 0))}</a>`;
      })
      .join(" ");
    const prot = g.file && isProtectedPath(g.file, card, gatesConfig);
    const lock = prot ? `${icon("lock", 12, "ic s12")}protected` : "";
    const msg = stripLocation(first.errorExcerpt, first.location);
    let ea = "";
    if (first.expected || first.actual) {
      const actual =
        g.items.length > 1 && g.code
          ? `${g.code} at ${g.items.length} places in ${g.file}`
          : first.actual;
      ea = `<dl class="ea">${first.expected ? `<dt>Expected</dt><dd>${esc(first.expected)}</dd>` : ""}${actual ? `<dt>Actual</dt><dd>${esc(actual)}</dd>` : ""}</dl>`;
    }
    const suggested = first.suggestedFixFiles ?? [];
    const protSuggested = suggested.filter((p) => isProtectedPath(p, card, gatesConfig));
    let warn = "";
    if (protSuggested.length) {
      const scope = card?.scopeFiles?.length ? `: ${card.scopeFiles.join(", ")}` : "";
      warn = `<div class="warnline">${icon("alert", 14, "ic s14")}<span>The suggested file, ${esc(protSuggested.join(", "))}, is a protected test. The fix belongs in the implementation${esc(scope)}.</span></div>`;
    }
    const repro = first.minimalRepro
      ? `<span class="mono">$ ${esc(first.minimalRepro)}</span><button type="button" data-copy="${esc(first.minimalRepro)}" aria-label="Copy command" title="Copy (${MOD}C)">${icon("copy", 14, "ic s14")}</button>`
      : "";
    const action =
      first.suggestedAction && !protSuggested.length
        ? `<span>Suggested: ${esc(first.suggestedAction)}</span>`
        : "";
    return `<div class="fb" data-fgate="${esc(g.gate)}"><div class="loc">${icon("x", 14, "ic s14 i-fail")}${esc(gateLabel(g.rung))}${g.code ? ` · <span class="mono">${esc(g.code)}</span>` : ""}${links ? ` · ${links}` : ""}${lock}</div><pre>${esc(msg)}</pre>${ea}${warn}${repro || action ? `<div class="repro">${repro}${action}</div>` : ""}</div>`;
  });
  const more =
    limit && groups.length > limit
      ? `<div class="sec" style="font-size:var(--text-xs)">${groups.length - limit} more in the card view</div>`
      : "";
  return `<div class="fails">${blocks.join("")}${more}</div>`;
}
