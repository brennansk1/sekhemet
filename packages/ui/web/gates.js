// Gates strip (dashboard §2.5.3): one segment per gate in execution order,
// and past six gates one per check family, failing groups first, each naming
// its failed gates and holding the rest behind "+n passed" (DB-N1-1). On a
// phone the strip is a vertical list (review.css, DB-N1-2).
import { esc, icon } from "./dom.js";
import { gateStripModel } from "./lib/strip.js";
import {
  GATE_STATE_LABELS,
  formatDuration,
  invariantsNotEnforced,
  joinWords,
} from "./lib/vocabulary.js";

const ICON = {
  pass: "check",
  fail: "x",
  unavailable: "minus",
  skipped: "minus",
  not_run: "minus",
  running: "ring",
};

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} seconds`;
}

/** "3 of 3 passed · Lint not run" */
export function gatesHeadline(gates) {
  const ran = gates.filter(
    (g) => g.state === "pass" || g.state === "fail" || g.state === "unavailable",
  );
  const passed = gates.filter((g) => g.state === "pass").length;
  const notRun = gates.filter((g) => g.state === "not_run").map((g) => g.label);
  const skipped = gates.filter((g) => g.state === "skipped").map((g) => g.label);
  const down = gates.filter((g) => g.state === "unavailable").map((g) => g.label);
  const parts = [`${passed} of ${ran.length + skipped.length} passed`];
  if (down.length) parts.push(`${joinWords(down)} unavailable`);
  if (skipped.length) parts.push(`${joinWords(skipped)} skipped`);
  if (notRun.length) parts.push(`${joinWords(notRun)} not run`);
  return parts.join(" · ");
}

/**
 * @param gates GateSummary[] from the vocabulary
 * @param opts.failures typed failures, for the hover detail
 * @param opts.config /api/gates payload (commands, empty contract)
 * @param opts.sha the evidence's gatesConfigSha256
 */
export function gatesStripHtml(
  gates,
  { failures = [], config = null, emptyContract = false, sha = "" } = {},
) {
  const firstFail = gates.find((g) => g.state === "fail");
  const layers = Object.fromEntries((config?.gates ?? []).map((d) => [d.id, d.layer]));
  const model = gateStripModel(gates, layers);
  const segs = model.grouped
    ? model.segments.map((seg) => groupHtml(seg))
    : gates.map((g) => {
        const def = config?.gates?.find((d) => d.id === g.id);
        const mine = failures.filter(
          (f) => (f.gate ?? f.rung) === g.id || (!f.gate && f.rung === def?.rung),
        );
        const count =
          g.state === "fail" && g.failures ? `<span class="sec tnum">${g.failures}</span>` : "";
        const right = g.detail ?? (g.durationMs !== undefined ? formatDuration(g.durationMs) : "");
        const aria = [
          `${g.label}: ${GATE_STATE_LABELS[g.state].toLowerCase()}`,
          g.failures ? `${g.failures} ${g.failures === 1 ? "error" : "errors"}` : "",
          g.durationMs !== undefined ? seconds(g.durationMs) : (g.detail ?? ""),
        ]
          .filter(Boolean)
          .join(", ");
        let pop = `<b>${esc(g.label)} · ${esc(GATE_STATE_LABELS[g.state])}</b><span class="mono">${esc(g.id)}${def?.command ? ` · $ ${esc(def.command)}` : ""}</span>`;
        if (g.state === "fail" && mine.length) {
          const items = mine
            .slice(0, 3)
            .map((f) => {
              const loc = f.location
                ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ""}`
                : "";
              const msg = String(f.errorExcerpt ?? "").split("\n")[0];
              return `<li><span class="mono">${esc(loc)}</span> ${esc(msg.replace(loc, "").replace(/^:\d+\s*/, ""))}</li>`;
            })
            .join("");
          pop += `<ul>${items}</ul>${mine.length > 3 ? `<div class="mono" style="margin-top:4px">Show all (${mine.length})</div>` : ""}`;
        } else if (g.state === "skipped" && firstFail) {
          pop += `<div style="margin-top:4px">Skipped because ${esc(firstFail.label)} failed.</div>`;
        } else if (g.state === "unavailable") {
          const why = String(mine[0]?.actual ?? mine[0]?.errorExcerpt ?? "").split("\n")[0];
          pop += `<div style="margin-top:4px">Could not run, so it gave no verdict${why ? `: ${esc(why)}` : ""}.</div>`;
        } else if (g.state === "not_run") {
          pop +=
            '<div style="margin-top:4px">Declared in gates.toml but did not run in this attempt.</div>';
        } else if (g.derived) {
          pop += `<div style="margin-top:4px">${esc(g.detail ?? "")}${config ? ` (limit ${esc(config.maxFiles)} files, ${esc(config.maxDiffLines)} lines)` : ""}. Computed by Sekhemet from the diff.</div>`;
        }
        return `<button class="g-seg ${g.state}" type="button" role="listitem" data-gate="${esc(g.id)}" aria-label="${esc(aria)}">${icon(ICON[g.state] ?? "minus")}<span class="nm">${esc(g.label)}</span>${count}<span class="t tnum">${esc(right)}</span><span class="pop" role="tooltip">${pop}</span></button>`;
      });
  if (emptyContract) {
    segs.push(
      `<button class="g-seg warn" type="button" role="listitem" aria-label="Checks configuration empty">${icon("alert")}<span class="nm">Checks configuration empty</span><span class="pop" role="tooltip"><b>These results weren’t checked against a configuration.</b>gates.toml hashed to <span class="mono">${esc(String(sha).slice(0, 8))}…</span>, the hash of an empty file.</span></button>`,
    );
  }
  // GT-N1-1: the brief's invariants the architecture gate cannot check.
  const inv = invariantsNotEnforced(config?.invariants?.notEnforced);
  if (inv) {
    const lines = inv.lines.map((l) => `<li>${esc(l)}</li>`).join("");
    const forms = inv.forms.map((f) => `<span class="mono">${esc(f)}</span>`).join(" or ");
    segs.push(
      `<button class="g-seg warn" type="button" role="listitem" aria-label="${esc(inv.label)}">${icon("alert")}<span class="nm">${esc(inv.label)}</span><span class="pop" role="tooltip"><b>${esc(inv.heading)}</b><ul>${lines}</ul><div style="margin-top:4px">Restate each as ${forms}.</div></span></button>`,
    );
  }
  return `<div class="g-strip" role="list" aria-label="Checks">${segs.join("")}</div>`;
}

/**
 * One check family's segment (DB-N1-1): *Security 3/4*, the gates that did
 * not pass by name, *+3 passed*; the popover lists every gate in the group.
 */
function groupHtml(seg) {
  const names = seg.failing
    .map((g) => `${g.label}${g.state === "fail" && g.failures ? ` ✕ ${g.failures}` : ""}`)
    .join(", ");
  const aria = [
    `${seg.label}: ${seg.count.replace("/", " of ")} passed`,
    ...seg.failing.map((g) => `${g.label} ${GATE_STATE_LABELS[g.state].toLowerCase()}`),
  ].join(", ");
  const rows = seg.gates
    .map(
      (g) =>
        `<li>${icon(ICON[g.state] ?? "minus", 12)} ${esc(g.label)} · ${esc(GATE_STATE_LABELS[g.state])} <span class="mono">${esc(g.id)}</span>${g.firstError ? `<div class="mono">${esc(g.firstError)}</div>` : ""}</li>`,
    )
    .join("");
  const first = seg.failing[0] ?? seg.gates[0];
  return `<button class="g-seg grp ${seg.state}" type="button" role="listitem" data-gate="${esc(first?.id ?? "")}" data-family="${esc(seg.family ?? "")}" aria-label="${esc(aria)}">${icon(ICON[seg.state] ?? "minus")}<span class="nm">${esc(seg.label)}</span><span class="sec tnum">${esc(seg.count)}</span>${names ? `<span class="fl">${esc(names)}</span>` : ""}<span class="t tnum">${esc(seg.overflow)}</span><span class="pop" role="tooltip"><b>${esc(seg.label)} · ${esc(seg.count)} passed</b><ul>${rows}</ul></span></button>`;
}

/** Loading state: four neutral boxes of the real geometry. */
export function gatesSkeletonHtml() {
  return `<div class="g-strip" aria-hidden="true">${'<div class="g-seg"><span class="sk sk-line" style="width:60%"></span></div>'.repeat(4)}</div>`;
}
