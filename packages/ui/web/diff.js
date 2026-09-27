// Diff viewer (FRONTEND_DESIGN §2.5.5): grouped files, gutters, inline failure
// annotations, unified or split. Every line of code is escaped.
import {
  annotationsByLine,
  errorCode,
  fileRole,
  groupCollapsed,
  parseUnifiedDiff,
  stripLocation,
} from "./diff_parse.js";
import { esc, icon, kbd } from "./dom.js";
import { gateLabel, plural } from "./lib/vocabulary.js";
import { SEEN_LABEL, acceptanceExtrasHtml } from "./review_desk.js";
import { structuralSummary } from "./structure.js";

const MAX_LINES = 400;
const ROLE = {
  implementation: { group: "Implementation", tag: "May edit" },
  acceptance: { group: "Acceptance tests", tag: "Protected" },
  outside: { group: "Outside scope", tag: "Not in scope" },
  other: { group: "Other", tag: "Generated" },
};
const ORDER = ["implementation", "outside", "acceptance", "other"];

function annHtml(fails) {
  return fails
    .map((f) => {
      const code = errorCode(f.errorExcerpt);
      const id = `ann-${f.location.file}:${f.location.line}`;
      return `<div class="ann" role="note" tabindex="0" id="${esc(id)}" data-ann>${icon("x", 14, "ic s14")}<span><b>${esc(gateLabel(f.rung))}${code ? ` · ${esc(code)}` : ""}</b> ${esc(stripLocation(f.errorExcerpt, f.location))}</span></div>`;
    })
    .join("");
}

function lineHtml(l) {
  const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : "";
  return `<div class="ln ${l.type}"><span class="o">${l.oldNo ?? ""}</span><span class="n">${l.newNo ?? ""}</span><span class="s">${sign}</span><code>${esc(l.text)}</code></div>`;
}

function unifiedHtml(file, anns, limit) {
  let out = "";
  let count = 0;
  for (const h of file.hunks) {
    if (count >= limit) break;
    out += `<div class="ln hunk"><span class="o"></span><span class="n"></span><span class="s"></span><code>${esc(h.header)}</code></div>`;
    for (const l of h.lines) {
      if (count >= limit) break;
      out += lineHtml(l);
      count++;
      const at = l.type === "del" ? undefined : l.newNo;
      if (at !== undefined) {
        const fails = anns.get(`${file.path}:${at}`);
        if (fails) out += annHtml(fails);
      }
    }
  }
  return out;
}

function sideHtml(l, side) {
  if (!l)
    return `<div class="ln blank${side === "r" ? " side-r" : ""}"><span class="n"></span><span class="s"></span><code></code></div>`;
  const no = side === "l" ? l.oldNo : l.newNo;
  const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : "";
  return `<div class="ln ${l.type}${side === "r" ? " side-r" : ""}"><span class="n">${no ?? ""}</span><span class="s">${sign}</span><code>${esc(l.text)}</code></div>`;
}

function splitHtml(file, anns, limit) {
  let out = "";
  let count = 0;
  for (const h of file.hunks) {
    out += `<div class="ln hunk" style="grid-column:1/-1"><span class="n"></span><span class="s"></span><code>${esc(h.header)}</code></div>`;
    const lines = h.lines.filter((l) => l.type !== "meta");
    let i = 0;
    while (i < lines.length && count < limit) {
      const l = lines[i];
      if (l.type === "ctx") {
        out += sideHtml(l, "l") + sideHtml(l, "r");
        const fails = anns.get(`${file.path}:${l.newNo}`);
        if (fails) out += `<div style="grid-column:1/-1">${annHtml(fails)}</div>`;
        i++;
        count++;
        continue;
      }
      const dels = [];
      const adds = [];
      while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) {
        out += sideHtml(dels[k], "l") + sideHtml(adds[k], "r");
        const fails = adds[k] && anns.get(`${file.path}:${adds[k].newNo}`);
        if (fails) out += `<div style="grid-column:1/-1">${annHtml(fails)}</div>`;
        count++;
      }
    }
  }
  return `<div class="split">${out}</div>`;
}

function header({ path, role, added, removed, collapsed, extra = "", seen = false }) {
  const meta = ROLE[role];
  const lead =
    role === "acceptance"
      ? icon("lock", 14, "ic s14")
      : icon(collapsed ? "chevron-right" : "chevron-down", 14, "ic s14");
  return `<div class="g-h"><button class="tog" type="button" data-toggle="${esc(path)}" aria-expanded="${!collapsed}">${lead}<span class="grp">${esc(meta.group)}</span><span class="sec">·</span><span class="path">${esc(path)}</span></button><span class="role">${esc(meta.tag)}</span>${seen ? `<span class="seen">${icon("check", 12, "ic s12")}${esc(SEEN_LABEL)}</span>` : ""}<span class="num">${extra}${added === null ? "" : `<span class="add-n">+${added}</span><span class="${removed ? "del-n" : ""}">−${removed}</span>`}</span><button class="copy" type="button" data-copy="${esc(path)}" aria-label="Copy path ${esc(path)}" title="Copy path">${icon("copy", 14, "ic s14")}</button></div>`;
}

/** The new side of a file, rebuilt from its hunks. */
function newContent(file) {
  const out = [];
  for (const h of file.hunks) {
    for (const l of h.lines) if (l.newNo !== undefined) out[l.newNo - 1] = l.text;
  }
  return Array.from(out, (l) => l ?? "").join("\n");
}

/** A protected test, shown as excerpts around the lines failures point at. */
function excerptHtml(path, content, fails, lead = "Unchanged by the Worker") {
  const lines = String(content).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const targets = [...new Set(fails.map((f) => f.location.line))].sort((a, b) => a - b);
  const windows = [];
  for (const t of targets) {
    const from = Math.max(1, t - 3);
    const to = Math.min(lines.length, t + 2);
    const last = windows[windows.length - 1];
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else windows.push({ from, to });
  }
  const byLine = annotationsByLine(fails);
  let out = "";
  for (const w of windows) {
    out += `<div class="ln hunk"><span class="o"></span><span class="n"></span><span class="s"></span><code>${esc(lead)} · lines ${w.from}–${w.to} of ${lines.length}</code></div>`;
    for (let n = w.from; n <= w.to; n++) {
      out += `<div class="ln ctx"><span class="o"></span><span class="n">${n}</span><span class="s"></span><code>${esc(lines[n - 1] ?? "")}</code></div>`;
      const at = byLine.get(`${path}:${n}`);
      if (at) out += annHtml(at);
    }
  }
  return out;
}

/**
 * @param evidence the EvidenceBundle
 * @param opts.card CardRecord (scopeFiles, acceptanceTests)
 * @param opts.gatesConfig /api/gates payload
 * @param opts.acceptance [{ name, path, content }] staged test sources
 * @param opts.mode "unified" | "split"
 * @param opts.open Map<path, boolean> user toggles; opts.full Set<path> expanded past 400 lines
 * @param opts.order paths in risk order (DB-N5-1); opts.seen Set<path> already shown;
 *   opts.supersessions and opts.approvals: the Acceptance tests group's rows (DB-N5-7, -8)
 */
export function changesHtml(
  evidence,
  {
    card,
    gatesConfig,
    acceptance = [],
    mode = "unified",
    open = new Map(),
    full = new Set(),
    order = [],
    seen = new Set(),
    supersessions = [],
    approvals = [],
  } = {},
) {
  const files = parseUnifiedDiff(evidence.diff);
  // U16: the structural reading (intent groups, declarations changed).
  if (mode === "structural") {
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const head = files.length
      ? `${plural(files.length, "file")} · +${added} −${removed}`
      : "No changes recorded";
    return `<section aria-label="Changes" data-changes><h3 class="sh">Changes <span class="sec">${esc(head)}</span>${files.length ? modeHint(mode) : ""}</h3><div class="changes structural">${structuralHtml(files)}</div></section>`;
  }
  const ctx = {
    scopeFiles: card?.scopeFiles ?? [],
    acceptanceTests: card?.acceptanceTests ?? [],
    protectedGlobs: gatesConfig?.protected ?? [],
  };
  const anns = annotationsByLine(evidence.failures ?? []);
  const groups = [];
  const inDiff = new Set(files.map((f) => f.path));
  // DB-N5-1: Implementation files by risk (failures, then unmet or unclear
  // findings, then changed lines), never alphabetically; other groups keep the diff's order.
  const risk = (f) => {
    const i = order.indexOf(f.path);
    return fileRole(f.path, ctx) === "implementation" && i !== -1 ? i : 0;
  };
  const sorted = [...files].sort(
    (a, b) =>
      ORDER.indexOf(fileRole(a.path, ctx)) - ORDER.indexOf(fileRole(b.path, ctx)) ||
      risk(a) - risk(b),
  );
  for (const f of sorted) {
    const role = fileRole(f.path, ctx);
    const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    const fileFails = (evidence.failures ?? []).filter(
      (x) => x.location?.file === f.path && x.location.line,
    );
    // A protected test that failures point into opens on excerpts around them.
    const excerpt = role === "acceptance" && fileFails.length > 0 && !full.has(f.path);
    const collapsed = groupCollapsed(f.path, role, {
      failures: evidence.failures ?? [],
      open,
      full,
    });
    const limit = full.has(f.path) ? Number.POSITIVE_INFINITY : MAX_LINES;
    const body = f.binary
      ? '<div class="note-row">Binary file.</div>'
      : excerpt
        ? `<div class="diff" role="table" aria-label="Excerpt of ${esc(f.path)} around the failures">${excerptHtml(f.path, newContent(f), fileFails, "Staged by Sekhemet")}<button class="more-lines" type="button" data-full="${esc(f.path)}">Show all ${total} lines</button></div>`
        : `<div class="diff" role="table" aria-label="Diff of ${esc(f.path)}">${mode === "split" ? splitHtml(f, anns, limit) : unifiedHtml(f, anns, limit)}${total > limit ? `<button class="more-lines" type="button" data-full="${esc(f.path)}">Show ${total - MAX_LINES} more lines</button>` : ""}</div>`;
    const note =
      role === "outside"
        ? '<div class="note-row">The Worker edited a file this card may not touch.</div>'
        : "";
    groups.push(
      `<div class="group ${role}${collapsed ? " collapsed" : ""}" data-file="${esc(f.path)}">${header({ path: f.path, role, added: f.added, removed: f.removed, collapsed, seen: seen.has(f.path), extra: fileFails.length ? `<span class="sec">${plural(fileFails.length, "annotation")} ·</span>` : "" })}${note}${body}</div>`,
    );
  }

  // Staged acceptance tests the Worker did not touch: the oracle, shown where it failed.
  for (const src of acceptance) {
    if (inDiff.has(src.path)) continue;
    const fails = (evidence.failures ?? []).filter(
      (f) => f.location?.file === src.path && f.location.line,
    );
    const collapsed = !(open.get(src.path) ?? fails.length > 0);
    const extra = fails.length
      ? `<span class="sec">${plural(fails.length, "annotation")}</span>`
      : "";
    const lines = String(src.content ?? "")
      .split("\n")
      .filter((_, i, a) => i < a.length - 1 || a[i] !== "").length;
    const body = fails.length
      ? `<div class="diff" role="table" aria-label="Excerpt of ${esc(src.path)} around the failures">${excerptHtml(src.path, src.content, fails)}</div>`
      : `<div class="note-row">Unchanged by the Worker. ${plural(lines, "line")}.</div>`;
    groups.push(
      `<div class="group acceptance${collapsed ? " collapsed" : ""}" data-file="${esc(src.path)}">${header({ path: src.path, role: "acceptance", added: null, removed: null, collapsed, extra })}${body}</div>`,
    );
  }
  // DB-N5-7, DB-N5-8: superseded base tests beside their new versions, and approvals.
  const extras = acceptanceExtrasHtml({ supersessions, approvals });
  if (extras) groups.push(extras);
  if (ctx.acceptanceTests.length === 0) {
    const globs = ctx.protectedGlobs.length ? ctx.protectedGlobs : ["**/*.spec.ts"];
    groups.push(
      `<div class="group"><div class="g-h">${icon("lock", 14, "ic s14")}<span>Acceptance tests</span><span class="sec">· none for this card</span></div><div class="note-row">This card is gated by the project’s gates and existing tests only. The Worker cannot edit files that match ${globs.map((g) => `<span class="mono">${esc(g)}</span>`).join(", ")}.</div></div>`,
    );
  }

  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const head = files.length
    ? `${plural(files.length, "file")} · +${added} −${removed}`
    : "No changes recorded";
  return `<section aria-label="Changes" data-changes><h3 class="sh">Changes <span class="sec">${esc(head)}</span>${files.length ? modeHint(mode) : ""}</h3><div class="changes">${groups.join("")}</div></section>`;
}

/* ---------- Structural mode (U16) ---------- */

/** `u` cycles unified, split and structural. */
export const DIFF_MODES = ["unified", "split", "structural"];
export function nextDiffMode(mode) {
  return DIFF_MODES[(DIFF_MODES.indexOf(mode) + 1) % DIFF_MODES.length];
}

function modeHint(mode) {
  const label = { unified: "Unified", split: "Split", structural: "Structural" }[mode] ?? "Unified";
  return `<span class="diff-mode" title="u switches unified, split and structural">${kbd("u")} ${label}</span>`;
}

const INTENTS = [
  ["source", "Source"],
  ["tests", "Tests"],
  ["config", "Configuration"],
  ["docs", "Documentation"],
];
const CHANGE = {
  added: { label: "added", cls: "pass", sign: "+" },
  removed: { label: "removed", cls: "fail", sign: "−" },
  changed: { label: "changed", cls: "running", sign: "~" },
};

function structuralHtml(files) {
  const rows = structuralSummary(files);
  if (rows.length === 0) return '<div class="note-row">No changes recorded.</div>';
  return INTENTS.map(([key, label]) => {
    const list = rows.filter((r) => r.intent === key);
    if (list.length === 0) return "";
    const items = list
      .map((r) => {
        const syms = r.symbols.length
          ? `<ul class="st-syms">${r.symbols
              .map(
                (s) =>
                  `<li class="st-sym ${CHANGE[s.change].cls}"><span class="st-sign" aria-hidden="true">${CHANGE[s.change].sign}</span><span class="mono">${esc(s.name)}</span><span class="sec">${CHANGE[s.change].label}</span></li>`,
              )
              .join("")}</ul>`
          : '<p class="sec st-none">No declarations changed: edits inside the file body.</p>';
        const ws = r.whitespaceOnly
          ? `<span class="sec"> · ${r.whitespaceOnly} whitespace-only hunk${r.whitespaceOnly === 1 ? "" : "s"} hidden</span>`
          : "";
        return `<li class="st-file"><div class="st-h">${icon("file", 14, "ic s14")}<span class="mono">${esc(r.path)}</span>${r.status !== "modified" ? `<span class="sec">${esc(r.status)}</span>` : ""}<span class="sec tnum">+${r.added} −${r.removed}</span>${ws}</div>${syms}</li>`;
      })
      .join("");
    return `<div class="st-group"><h4 class="sub">${label} <span class="sec">${list.length} file${list.length === 1 ? "" : "s"}</span></h4><ul class="st-files">${items}</ul></div>`;
  }).join("");
}
