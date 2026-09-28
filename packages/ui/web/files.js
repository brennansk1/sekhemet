// The files relevant to a card (FRONTEND_DESIGN §2.4.3): its role, its change,
// and the gate failures that point at it. Shown at the top of the issue page's
// Changes tab (dashboard DB-N8-1).
import { fileRole, parseUnifiedDiff } from "./diff_parse.js";
import { esc, icon } from "./dom.js";

const ROLE_LABEL = {
  implementation: "May edit",
  acceptance: "Protected test",
  outside: "Outside scope",
  other: "Generated",
};

/** Rows for the table: changed files, then untouched scope files and tests. */
export function fileRows(card, detail) {
  const full = detail?.card ?? card;
  const ev = detail?.evidence;
  const ctx = {
    scopeFiles: full.scopeFiles ?? [],
    acceptanceTests: full.acceptanceTests ?? [],
    protectedGlobs: [],
  };
  const rows = new Map();
  for (const f of ev ? parseUnifiedDiff(ev.diff) : []) {
    rows.set(f.path, {
      path: f.path,
      role: fileRole(f.path, ctx),
      added: f.added,
      removed: f.removed,
      changed: true,
      failures: 0,
    });
  }
  for (const p of ctx.scopeFiles) {
    if (!rows.has(p))
      rows.set(p, {
        path: p,
        role: "implementation",
        added: 0,
        removed: 0,
        changed: false,
        failures: 0,
      });
  }
  for (const t of ctx.acceptanceTests) {
    const p = `tests/${t}`;
    if (!rows.has(p))
      rows.set(p, {
        path: p,
        role: "acceptance",
        added: 0,
        removed: 0,
        changed: false,
        failures: 0,
      });
  }
  for (const f of ev?.failures ?? []) {
    const p = f.location?.file;
    if (!p) continue;
    if (!rows.has(p))
      rows.set(p, {
        path: p,
        role: fileRole(p, ctx),
        added: 0,
        removed: 0,
        changed: false,
        failures: 0,
      });
    rows.get(p).failures++;
  }
  return [...rows.values()];
}

/**
 * The files table, at the top of the issue page's Changes tab: every file
 * relevant to the card with its role, its change and the gate failures that
 * point at it. A row (`data-file`) brings that file's diff into view.
 */
export function filesTableHtml(card, detail) {
  const rows = fileRows(card, detail);
  if (!rows.length) return "";
  const body = rows
    .map((r) => {
      const change = r.changed
        ? `<span class="add-n">+${r.added}</span> <span class="${r.removed ? "del-n" : "sec"}">−${r.removed}</span>`
        : '<span class="sec">unchanged</span>';
      const fails = r.failures
        ? `${icon("x", 12, "ic s12 i-fail")}${r.failures} ${r.failures === 1 ? "failure" : "failures"}`
        : '<span class="sec">—</span>';
      const lead =
        r.role === "acceptance"
          ? icon("lock", 14, "ic s14")
          : icon(r.changed ? "file-diff" : "file", 14, "ic s14");
      return `<tr tabindex="0" data-file="${esc(r.path)}"><td><span class="fpath">${lead}<span class="mono">${esc(r.path)}</span></span></td><td>${esc(ROLE_LABEL[r.role])}</td><td class="r mono">${change}</td><td class="r">${fails}</td></tr>`;
    })
    .join("");
  return `<details class="files-rel"><summary>Files <span class="sec">${rows.length} relevant to this card · select one to see its diff</span></summary><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Path</th><th>Role</th><th class="r">Change</th><th class="r">Check failures</th></tr></thead><tbody>${body}</tbody></table></div></details>`;
}
