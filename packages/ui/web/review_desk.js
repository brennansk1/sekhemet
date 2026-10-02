// Review for a team, and review that forces a look (dashboard §2.5.3–9,
// NEW-dashboard-5): the Reviewer's findings with their coverage and the `x`
// acknowledgement, what keeps Accept disabled (findings, files not shown, who
// may accept), and who built the card. The decisions and every word are the
// pure model's (`/app/lib/review_desk.js`); this module keeps the page state
// (acknowledgements, files shown) and writes the markup.
import { diffOnScreen, parseUnifiedDiff, shownFiles } from "./diff_parse.js";
import { $, $$, esc, icon, postJSON } from "./dom.js";
import { noteFor } from "./level_gate.js";
import {
  REVIEW_DESK_COPY as C,
  acceptBlockers,
  acceptPermissionText,
  builtByLabel,
  orderImplementationFiles,
  reviewCoverage,
  reviewerAbsence,
  reviewerFindings,
  supersessionRows,
  testApprovalRows,
  threadBlocker,
} from "./lib/review_desk.js";
import { reportOpened, reportedFiles } from "./opened.js";
import { store } from "./store.js";

/** cardId|evidenceId → the finding ids this page acknowledged. */
const acks = new Map();

function key(card, detail) {
  return `${card?.id ?? ""}|${detail?.evidence?.id ?? ""}`;
}

export function acknowledged(card, detail) {
  return acks.get(key(card, detail)) ?? new Set();
}

/** Acknowledge one unmet or unclear finding; true when it was not already. */
export function acknowledge(card, detail, id) {
  const k = key(card, detail);
  const set = acks.get(k) ?? new Set();
  if (set.has(id)) return false;
  set.add(id);
  acks.set(k, set);
  return true;
}

/** The files shown so far: recorded on the ledger, and reported by this page since. */
function shownSet(card, detail) {
  return new Set([
    ...(detail?.desk?.filesShown ?? []),
    ...reportedFiles(card?.id, detail?.evidence?.id),
  ]);
}

function findingsOf(card, detail) {
  return reviewerFindings(detail?.desk?.findings ?? [], acknowledged(card, detail));
}

/**
 * DB-N5-3, DB-N5-9: why Accept stays disabled beyond the gates, or "" when
 * nothing of this kind remains. Who may accept comes first: acknowledging
 * cannot change it.
 */
export function deskBlocker(card, detail) {
  const desk = detail?.desk;
  if (!desk) return "";
  const who = acceptPermissionText(desk.accept ?? { may: true });
  if (who) return who;
  // TEAM-25: a project that requires resolved threads waits on the open one, named.
  const thread = threadBlocker(desk);
  if (thread) return thread;
  return acceptBlockers({
    openFindings: findingsOf(card, detail).open,
    implementationFiles: desk.implementationFiles ?? [],
    shown: shownSet(card, detail),
  }).text;
}

/** The acknowledged finding ids Accept sends (review-git §2.4.3). */
export function acknowledgedIds(card, detail) {
  return [...acknowledged(card, detail)];
}

/** DB-N5-4: *Built by Jane (person)* for the outcome line; "" for the Worker. */
export function builtByOutcome(detail) {
  return builtByLabel(detail?.desk?.builtBy).outcome;
}

/** DB-N5-4: the Facts row's value. */
export function builtByFact(detail) {
  return builtByLabel(detail?.desk?.builtBy).fact;
}

function citeHtml(c) {
  const at = `${c.file}:${c.from}${c.to !== c.from ? `–${c.to}` : ""}`;
  return `<a class="mono" href="#" data-cite="${esc(c.file)}">${esc(at)}</a>`;
}

/** §2.5.3 4a: the Reviewer's findings, each acknowledgeable, and its coverage line. */
export function reviewerHtml(card, detail) {
  const desk = detail?.desk;
  if (!desk) return "";
  const m = findingsOf(card, detail);
  if (m.rows.length === 0) {
    // RG-P8-10, models rule 23: why no AI review ran, in place of an empty list.
    const why = reviewerAbsence(desk.findings ?? []);
    return why
      ? `<section aria-label="AI review findings" class="mreview rfind" data-reviewer><h3 class="sh">${esc(C.heading)}</h3><p class="mr-why">${esc(why)}</p></section>`
      : "";
  }
  const row = (r) => {
    const tone = r.verdict === "unmet" ? "fail" : r.verdict === "unclear" ? "parked" : "pass";
    const ic =
      r.verdict === "unmet"
        ? icon("x", 14, "ic s14 i-fail")
        : r.verdict === "unclear"
          ? icon("alert", 14, "ic s14 i-park")
          : icon("check", 14, "ic s14 i-pass");
    const act = r.needsAck
      ? r.acknowledged
        ? `<span class="ack done">${icon("check", 12, "ic s12")}${esc(C.acknowledged)}</span>`
        : `<button class="btn ghost sm" type="button" data-ack="${esc(r.id)}">${esc(C.acknowledge)}</button>`
      : "";
    const cites = r.citations.length
      ? `<span class="cites">${r.citations.map(citeHtml).join(" ")}</span>`
      : "";
    return `<li class="rf ${tone}" data-finding="${esc(r.id)}" tabindex="-1"><span class="rf-ic">${ic}</span><div><b>${esc(C.verdict[r.verdict])}</b>${r.chip ? `<span class="chip rf-chip">${esc(r.chip)}</span>` : ""}<span>${esc(r.text)}</span>${cites}</div>${act}</li>`;
  };
  const open = m.rows
    .filter((r) => r.verdict !== "met")
    .map(row)
    .join("");
  const met = m.rows.filter((r) => r.verdict === "met");
  const metHtml = met.length
    ? `<details class="rf-met"><summary>${esc(C.metMore(met.length))}</summary><ul>${met.map(row).join("")}</ul></details>`
    : "";
  const files = parseUnifiedDiff(detail?.evidence?.diff ?? "").map((f) => ({
    path: f.path,
    addedLines: f.hunks.flatMap((h) =>
      h.lines.filter((l) => l.type === "add" && l.newNo !== undefined).map((l) => l.newNo),
    ),
  }));
  const readLists = desk.findings.filter((f) => Array.isArray(f.filesRead));
  const filesRead = readLists.length
    ? [...new Set(readLists.flatMap((f) => f.filesRead))]
    : undefined;
  const cov = reviewCoverage(files, desk.findings, filesRead);
  const lists = [
    cov.notRead.length
      ? `<h4 class="sub">${esc(C.notReadHeading)}</h4><ul class="plain">${cov.notRead.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}</ul>`
      : "",
    cov.uncited.length
      ? `<h4 class="sub">${esc(C.uncitedHeading)}</h4><ul class="plain">${cov.uncited.map((f) => `<li class="mono">${esc(f)}</li>`).join("")}</ul>`
      : "",
  ].join("");
  const coverage = lists
    ? `<details class="rf-cov"><summary>${esc(cov.line)}</summary>${lists}</details>`
    : `<p class="rf-cov">${esc(cov.line)}</p>`;
  return `<section aria-label="AI review findings" class="mreview rfind" data-reviewer><h3 class="sh">${esc(m.title)}</h3><p class="mr-why">${esc(C.why)} <span class="sec">${esc(C.acknowledgeKey)}.</span></p>${open ? `<ul>${open}</ul>` : ""}${metHtml}${coverage}</section>`;
}

/**
 * DB-N5-1 and the Acceptance tests group (DB-N5-7, DB-N5-8), as the diff
 * viewer's options: the Implementation order, the files seen, the
 * supersessions and the approval rows.
 */
export function diffOptions(card, detail) {
  const ev = detail?.evidence;
  const files = parseUnifiedDiff(ev?.diff ?? "");
  return {
    order: orderImplementationFiles(files, {
      failures: ev?.failures ?? [],
      findings: detail?.desk?.findings ?? [],
    }),
    seen: shownSet(card, detail),
    supersessions: supersessionRows(detail?.card?.supersedes ?? card?.supersedes, ev?.superseded),
    approvals: testApprovalRows(detail?.desk?.testApprovals ?? []),
  };
}

/** The Acceptance tests group's supersession and approval rows (DB-N5-7, DB-N5-8). */
export function acceptanceExtrasHtml({ supersessions = [], approvals = [] } = {}) {
  const sup = supersessions.length
    ? `<div class="group acceptance"><div class="g-h">${icon("lock", 14, "ic s14")}<span>${esc(C.supersededHeading)}</span></div><table class="sup"><thead><tr><th scope="col">${esc(C.supersededOld)}</th><th scope="col">${esc(C.supersededNew)}</th></tr></thead><tbody>${supersessions.map((s) => `<tr><td class="mono">${esc(s.old)}</td><td class="${s.new === C.supersededNotNeeded ? "sec" : "mono"}">${esc(s.new)}</td></tr>`).join("")}</tbody></table></div>`
    : "";
  const apv = approvals.length
    ? `<div class="group acceptance"><div class="g-h">${icon("lock", 14, "ic s14")}<span>${esc(C.approvalsHeading)}</span></div><ul class="plain apv">${approvals.map((a) => `<li class="apv-${a.state}"><span class="mono">${esc(a.path)}</span><span class="${a.state === "approved" ? "i-pass" : "i-park"}">${esc(a.label)}</span></li>`).join("")}</ul></div>`
    : "";
  return sup + apv;
}

/** The label for a file already shown: its *seen* mark (§2.5.3 6). */
export const SEEN_LABEL = C.seen;

/** cardId|evidenceId → the files whose expanded diff has been on screen (DB-N5-3). */
const onScreen = new Map();
/** The scroller → its IntersectionObserver, replaced on each render. */
const watchers = new WeakMap();
const THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * RG-S6-6, RG-N5-5, DB-N5-3: record the diffs a person has had on screen, so
 * Accept knows what was shown. An expanded diff counts once it has been in
 * view (`diffOnScreen`), never merely for being expanded below the fold.
 * Shared by Review and the issue page's Changes tab: pass the scroller the
 * diffs render into as `root`, and `onMore` to redraw what depends on it
 * (Accept's reason) when scrolling shows another file.
 */
export function recordShown(card, detail, pane, root, onMore) {
  const ev = detail?.evidence;
  if (!card || !ev || card.status !== "review") return;
  const s = store.state;
  if ((s.meta && s.meta.triage === false) || s.connection === "offline") return;
  // SEC-01: a level that may not review records nothing it was shown (the server
  // would refuse it, and the refusal would fill Audit with what nobody asked for).
  if (noteFor("review", card.projectId)) return;
  if (root) watchShown(card, detail, pane, root, onMore);
  const files = shownFiles(ev, {
    card: detail.card ?? card,
    gatesConfig: s.gates,
    mode: pane.mode,
    open: pane.open,
    full: pane.full,
    seen: onScreen.get(key(card, detail)) ?? new Set(),
  });
  reportOpened(card.id, ev.id, files, (path, body) => postJSON(path, body, { background: true }));
}

function markSeen(root, path) {
  const head = $(`.group[data-file="${CSS.escape(path)}"] .g-h`, root);
  if (!head || $(".seen", head)) return;
  $(".role", head)?.insertAdjacentHTML(
    "afterend",
    `<span class="seen">${icon("check", 12, "ic s12")}${esc(SEEN_LABEL)}</span>`,
  );
}

function watchShown(card, detail, pane, root, onMore) {
  watchers.get(root)?.disconnect();
  if (typeof IntersectionObserver !== "function") return;
  const k = key(card, detail);
  const seen = onScreen.get(k) ?? new Set();
  onScreen.set(k, seen);
  const io = new IntersectionObserver(
    (entries) => {
      let more = false;
      for (const e of entries) {
        const path = e.target.dataset.file;
        // A collapsed diff shows only its header: seeing it is not a look.
        if (!path || seen.has(path) || e.target.classList.contains("collapsed")) continue;
        const view = e.rootBounds ?? { height: window.innerHeight };
        const look = {
          isIntersecting: e.isIntersecting,
          ratio: e.intersectionRatio,
          height: e.intersectionRect.height,
        };
        if (diffOnScreen(look, view)) {
          seen.add(path);
          more = true;
        }
      }
      if (!more) return;
      const before = new Set(reportedFiles(card.id, detail.evidence.id));
      recordShown(card, detail, pane);
      for (const f of reportedFiles(card.id, detail.evidence.id)) {
        if (!before.has(f)) markSeen(root, f);
      }
      onMore?.();
    },
    { threshold: THRESHOLDS },
  );
  for (const g of $$(".group[data-file]", root)) io.observe(g);
  watchers.set(root, io);
}

/**
 * `x`: acknowledge the focused finding, or else the first open one; focus
 * moves to the next open finding. True when a finding was acknowledged.
 */
export function acknowledgeFocused(root, card, detail) {
  const focused = document.activeElement?.closest?.("[data-finding]");
  const open = findingsOf(card, detail).open;
  const id = focused && open.includes(focused.dataset.finding) ? focused.dataset.finding : open[0];
  if (!id) return false;
  return acknowledge(card, detail, id);
}

/** After a re-render: focus the next open finding, else the section heading. */
export function focusNextFinding(root, card, detail) {
  const next = findingsOf(card, detail).open[0];
  const target = next
    ? $(`[data-finding="${CSS.escape(next)}"] [data-ack]`, root)
    : $$("[data-reviewer] .rf", root)[0];
  target?.focus({ preventScroll: false });
}
